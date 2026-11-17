import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ChatGptRelayHandler } from './chatgpt-relay'
import { ChatGptRelaySocket, relaySocketPath } from './chatgpt-relay-socket'

describe.runIf(process.platform === 'darwin')('packaged macOS relay helper', () => {
const home = path.join(tmpdir(), `atum-relay-${randomUUID().slice(0, 8)}`)
const binary = path.join(home, 'helper')
const owner = '00000000-0000-4000-8000-aaaaaaaaaaa1'
const agent = '00000000-0000-4000-8000-bbbbbbbbbbb2'
const binding = { ownerPrincipal: owner, agentPrincipal: agent, connectionEpoch: 3 }
beforeAll(() => {
  mkdirSync(home, { mode: 0o700 })

  // Only the test build substitutes a temp home. The shipped helper uses getpwuid, never an env path.
  const source = readFileSync(new URL('../../../native/chatgpt-relay.swift', import.meta.url), 'utf8')
    .replaceAll('String(cString: home)', JSON.stringify(home))

  const file = path.join(home, 'helper.swift')
  writeFileSync(file, source)
  execFileSync('/usr/bin/xcrun', ['swiftc', file, '-o', binary])
}, 30_000)
afterAll(() => rmSync(home, { recursive: true, force: true }))

function run(input: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [owner, agent, '3'], { env: { SSH_ORIGINAL_COMMAND: 'touch /NEVER' } })
    const chunks: Buffer[] = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.on('error', reject)
    child.on('exit', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())) } catch (error) { reject(error) } })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

it.each(['ownerPrincipal', 'agentPrincipal', 'connectionEpoch'])('helper rejects conflicting %s', async key => {
  expect(await run(JSON.stringify({ [key]: key === 'connectionEpoch' ? 4 : 'conflict' })))
    .toMatchObject({ code: 'invalid_request', retryable: false })
})
it('helper rejects oversized input before connecting', async () => {
  expect(await run(' '.repeat(800_001))).toMatchObject({ code: 'request_too_large' })
})
it('disabled socket is absent and the helper reports retryable unavailable', async () => {
  expect(await run('{}')).toMatchObject({ code: 'unavailable', retryable: true })
})
it('real temp socket calls the existing handler with the injected binding, then disappears on disable', async () => {
  const now = Date.now()
  const requestJson = JSON.stringify({ model: 'test-model', messages: [], stream: false })

  const handler = new ChatGptRelayHandler({
    authority: () => ({ ...binding, deviceServiceId: owner, agentPrincipals: [agent], enabled: true, models: ['test-model'] }),
    call: async () => ({ status: 200, response: { answer: 'fixture' }, diagnostic: { stage: 'response_encode', code: 'ok', exit: 0 } })
  })

  const socket = new ChatGptRelaySocket(relaySocketPath(home), handler, () => [binding])
  await socket.setEnabled(true)

  try {
    expect((await stat(path.dirname(relaySocketPath(home)))).mode & 0o777).toBe(0o700)
    expect((await stat(relaySocketPath(home))).mode & 0o777).toBe(0o600)
    expect(await run(JSON.stringify({ capabilityId: agent, invocationId: agent, deviceServiceId: owner,
      connectionId: owner, issuedAt: now, expiresAt: now + 60_000, relayRevision: 1, model: 'test-model', effort: 'low',
      maxResponseBytes: 800_000, requestBytes: Buffer.byteLength(requestJson), requestJson })))
      .toMatchObject({ state: 'completed', responseJson: '{"answer":"fixture"}' })
  } finally { await socket.setEnabled(false) }

  await expect(stat(relaySocketPath(home))).rejects.toThrow()
  expect(await run('{}')).toMatchObject({ code: 'unavailable', retryable: true })
})
it('response loss and oversized responses after submission cannot be retried', async () => {
  await mkdir(path.dirname(relaySocketPath(home)), { recursive: true, mode: 0o700 })

  for (const response of ['', ' '.repeat(800_001)]) {
    const server = createServer({ allowHalfOpen: true }, client => {
      client.on('data', () => {})
      client.on('end', () => client.end(response))
    })

    await new Promise<void>(resolve => server.listen(relaySocketPath(home), resolve))
    const { chmod } = await import('node:fs/promises')
    await chmod(relaySocketPath(home), 0o600)

    try { expect(await run('{}')).toMatchObject({ retryable: false }) }
    finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  }
})

it('disable closes active sockets and cancels provider work without retrying it', async () => {
  let started!: () => void
  const running = new Promise<void>(resolve => { started = resolve })
  let aborted = false

  const handler = new ChatGptRelayHandler({
    authority: () => ({ ...binding, deviceServiceId: owner, agentPrincipals: [agent], enabled: true, models: ['test-model'] }),
    call: async (_input, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('stopped')) }, { once: true })
      started()
    })
  })

  const socket = new ChatGptRelaySocket(relaySocketPath(home), handler, () => [binding])
  await socket.setEnabled(true)
  const now = Date.now()
  const requestJson = JSON.stringify({ model: 'test-model', messages: [] })

  const answer = run(JSON.stringify({ capabilityId: agent, invocationId: owner, model: 'test-model',
    effort: 'low', relayRevision: 1, deviceServiceId: owner, connectionId: agent,
    issuedAt: now, expiresAt: now + 60_000, maxResponseBytes: 800_000,
    requestBytes: Buffer.byteLength(requestJson), requestJson }))

  await running
  await socket.setEnabled(false)
  expect(aborted).toBe(true)
  expect(await answer).toMatchObject({ code: 'stopped', retryable: false })
})

})
