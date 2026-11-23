import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkSidecar } from './process'

const { children, spawn } = vi.hoisted(() => ({ children: [] as any[], spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn }))
vi.mock('node:fs/promises', async original => ({
  ...await original<typeof FsPromises>(),
  readFile: vi.fn(async () => JSON.stringify({ pid: 42, origin: 'http://127.0.0.1:1234' }))
}))
let root: string
let sidecar: WorkSidecar

afterEach(async () => {
  await sidecar?.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  children.length = 0

  if (root) {await rm(root, { recursive: true, force: true })}
})

async function lab() {
  root = await mkdtemp(join(tmpdir(), 'work-recovery-'))
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
  spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stdin: new Writable({ write(_chunk, _encoding, done) { done() } })
    })

    child.stdin.on('finish', () => child.emit('close', 0))
    children.push(child)
    setTimeout(() => child.stdout.write(JSON.stringify({ kind: 'spawned', pid: 42 }) + '\n' +
      JSON.stringify({ kind: 'pairing', url: 'http://127.0.0.1:1234/pair#token=fixture' }) + '\n'), 10)

    return child
  })
  let current = true
  const prepare = vi.fn(async () => {})
  sidecar = new WorkSidecar({
    resources: '/fixture', account: { key: 'fixture', generation: 1, root },
    current: () => current, gatewayEnvironment: () => ({}), revokeCredentials: vi.fn(), prepare
  })

  return { prepare, changeAccount: () => { current = false } }
}

async function start() {
  const pending = sidecar.start({ continuation: false })
  await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
  await vi.advanceTimersByTimeAsync(20)

  return pending
}

describe('Work sidecar recovery', () => {
  it('restarts an unexpected exit and returns the replacement to Retry', async () => {
    await lab()
    const first = await start()
    children[0].emit('close', 1)
    expect(await first.unexpectedExit).toBe(true)
    await vi.advanceTimersByTimeAsync(999)
    expect(spawn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    const retry = sidecar.start({ continuation: false })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(20)
    const replacement = await retry
    expect(replacement.id).not.toBe(first.id)
    expect(sidecar.current()).toBe(replacement)
  })
  it('caps backoff after failed recovery and cancels on stop', async () => {
    const { prepare } = await lab()
    await start()
    prepare.mockRejectedValue(new Error('busy'))
    children[0].emit('close', 1)
    await vi.advanceTimersByTimeAsync(0)

    for (const wait of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const before = prepare.mock.calls.length
      await vi.advanceTimersByTimeAsync(wait - 1)
      expect(prepare).toHaveBeenCalledTimes(before)
      await vi.advanceTimersByTimeAsync(1)
      expect(prepare).toHaveBeenCalledTimes(before + 1)
    }

    await sidecar.stop()
    const before = prepare.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(prepare).toHaveBeenCalledTimes(before)
  })
  it.each([false, true])('does not restart after a legitimate stop (account changed: %s)', async changed => {
    const { changeAccount } = await lab()
    const first = await start()

    if (changed) {changeAccount()}
    await sidecar.stop()
    expect(await first.unexpectedExit).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})
