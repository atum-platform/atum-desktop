import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkDeliverableReply } from './deliverable-contract'
import { WorkSidecar } from './process'

// No login shell in tests: the PATH capture fails fast and falls back to the inherited PATH.
const { children, spawn, execFile } = vi.hoisted(() => ({
  children: [] as any[],
  spawn: vi.fn(),
  execFile: vi.fn((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) =>
    callback(new Error('no shell in tests'), ''))
}))
vi.mock('node:child_process', () => ({ spawn, execFile }))
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

async function lab(
  deliverableMessage?: ConstructorParameters<typeof WorkSidecar>[0]['deliverableMessage'],
  desktopUpdate?: ConstructorParameters<typeof WorkSidecar>[0]['desktopUpdate']
) {
  root = await mkdtemp(join(tmpdir(), 'work-recovery-'))
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
  const specs: Array<{ environment: Record<string, string>; gateway: Record<string, string> }> = []
  spawn.mockImplementation(() => {
    const controls = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stdin: new Writable({ write(chunk, _encoding, done) { specs.push(JSON.parse(String(chunk))); done() } }),
      stdio: [null, null, null, null, new PassThrough(), controls],
      connected: true,
      send: vi.fn()
    })

    child.stdin.on('finish', () => child.emit('close', 0))
    children.push(child)
    setTimeout(() => {
      child.stdout.write(JSON.stringify({ kind: 'spawned', pid: 42 }) + '\n' +
        JSON.stringify({ kind: 'pairing', url: 'http://127.0.0.1:1234/pair#token=fixture' }) + '\n')
      if (desktopUpdate) {
        controls.write(JSON.stringify({ version: 1, type: 'serverReady' }) + '\n')
      }
    }, 10)

    return child
  })
  let current = true
  const prepare = vi.fn(async () => {})
  sidecar = new WorkSidecar({
    resources: '/fixture', account: { key: 'fixture', generation: 1, root },
    current: () => current, gatewayEnvironment: () => ({}), revokeCredentials: vi.fn(), prepare, deliverableMessage, desktopUpdate
  })

  return { prepare, specs, changeAccount: () => { current = false } }
}

async function start() {
  const pending = sidecar.start({ continuation: false })
  await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
  await vi.advanceTimersByTimeAsync(20)

  return pending
}

describe('Work sidecar recovery', () => {
  it.each([false, true])('reuses the native IPC and discards stale acknowledgements (desktop mode: %s)', async desktop => {
    const reply: WorkDeliverableReply = { type: 'work-deliverable-pinned', artifactId: 'fixture', accepted: true }
    const deliverableMessage = vi.fn<NonNullable<ConstructorParameters<typeof WorkSidecar>[0]['deliverableMessage']>>()
      .mockResolvedValue(reply)
    const desktopUpdate = vi.fn()
    const { specs, changeAccount } = await lab(deliverableMessage, desktop ? desktopUpdate : undefined)
    await start()
    expect(spawn.mock.calls[0][2].stdio).toEqual(desktop
      ? ['pipe', 'pipe', 'ignore', 'ipc', 'pipe', 'pipe']
      : ['pipe', 'pipe', 'ignore', 'ipc'])
    expect(specs[0].environment).toMatchObject({
      ATUM_WORK_MEMO_PYTHON: '/fixture/runtime/python/bin/python3.14',
      ATUM_WORK_MEMO_SCRIPT: '/fixture/runtime/work-authoring/memo.py'
    })
    expect(specs[0].gateway).not.toHaveProperty('ATUM_WORK_MEMO_PYTHON')

    const report = { type: 'work-deliverable-pin' }

    children[0].emit('message', report)
    await vi.advanceTimersByTimeAsync(0)
    expect(deliverableMessage).toHaveBeenCalledExactlyOnceWith(report, expect.any(Function), expect.any(AbortSignal))
    expect(children[0].send).toHaveBeenCalledExactlyOnceWith(reply, expect.any(Function))

    if (desktop) {
      const request = { type: 'cancelDesktopUpdate', requestId: 'fixture' }
      children[0].stdio[5].write(JSON.stringify({ version: 1, ...request }) + '\n')
      expect(desktopUpdate).toHaveBeenCalledExactlyOnceWith(request, expect.objectContaining({
        current: expect.any(Function), report: expect.any(Function), signal: expect.any(AbortSignal)
      }))
    }

    let finish!: (value: WorkDeliverableReply) => void
    deliverableMessage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    children[0].emit('message', report)
    changeAccount()
    finish(reply)
    await vi.advanceTimersByTimeAsync(0)
    expect(children[0].send).toHaveBeenCalledTimes(1)
    children[0].emit('message', report)
    expect(deliverableMessage).toHaveBeenCalledTimes(2)
  })

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
