/**
 * The desktop's SDK window (G8-36): sdk-entry.ts serves the engine for the Electron bridge
 * that electron/matrix/sdk-preload.ts exposes as `window.matrixSdkHost`. These tests pin
 * what the desktop relies on, so extracting the seam changes nothing there. The engine is
 * faked; the bridge is shaped exactly like the preload's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixInvocationHint, MatrixSdkConfiguration, MatrixSnapshot } from '../../shared/matrix'

const engine = vi.hoisted(() => ({ start: vi.fn() }))

vi.mock('./sdk', () => ({ startMatrixSdk: engine.start }))

const configuration: MatrixSdkConfiguration = {
  baseUrl: 'https://matrix.test',
  userId: '@alice:test',
  deviceId: 'DEVICE',
  accessToken: 'fixture-token',
  storageKey: btoa('0'.repeat(32))
}

const startFailed: MatrixSnapshot = {
  state: 'error',
  identity: null,
  rooms: [],
  roomId: null,
  messages: [],
  error: 'matrix_sdk_start_failed'
}

function bridge() {
  let listener: ((id: string, command: unknown) => void) | undefined

  const host = {
    configuration: vi.fn(async () => configuration),
    refresh: vi.fn(async (_handle: string) => ({ ok: false as const, reauthenticate: true })),
    snapshot: vi.fn((_value: MatrixSnapshot) => {}),
    invocation: vi.fn((_value: MatrixInvocationHint) => {}),
    commands: vi.fn((next: (id: string, command: unknown) => void) => {
      listener = next
    }),
    result: vi.fn((_id: string, _ok: boolean, _value: unknown) => {})
  }

  return { host, send: (id: string, command: unknown) => listener!(id, command) }
}

async function serveDesktop(host: ReturnType<typeof bridge>['host']) {
  vi.resetModules()
  Object.defineProperty(window, 'matrixSdkHost', { value: host, configurable: true })
  await import('./sdk-entry')
}

function engineWith(command = vi.fn(async (value: { kind: string }) => ({ ran: value.kind }))) {
  const sdk = { command, stop: vi.fn(async () => {}) }
  engine.start.mockResolvedValue(sdk)

  return sdk
}

afterEach(() => {
  engine.start.mockReset()
  Reflect.deleteProperty(window, 'matrixSdkHost')
  Reflect.deleteProperty(window, 'atumDesktopServices')
})

describe("the desktop's SDK window (G8-36)", () => {
  it("starts the engine with the bridge's configuration, and routes its refresh, snapshots and hints to the bridge", async () => {
    engineWith()
    const { host } = bridge()
    await serveDesktop(host)

    await vi.waitFor(() => expect(engine.start).toHaveBeenCalledOnce())
    expect(host.configuration).toHaveBeenCalledOnce()
    const [config, refresh, publish, offer] = engine.start.mock.calls[0]!
    expect(config).toEqual(configuration)

    await expect(refresh('handle')).resolves.toEqual({ ok: false, reauthenticate: true })
    expect(host.refresh).toHaveBeenCalledWith('handle')

    const snapshot = { ...startFailed, state: 'ready', error: null } as MatrixSnapshot
    publish(snapshot)
    expect(host.snapshot).toHaveBeenCalledWith(snapshot)

    const hint = { watchId: 'watch', roomId: '!room:test', eventId: '$event' }
    offer(hint)
    expect(host.invocation).toHaveBeenCalledWith(hint)
  })

  it("answers each of the bridge's commands under its id, closed-code failures included, and stops", async () => {
    const sdk = engineWith()
    const { host, send } = bridge()
    await serveDesktop(host)
    expect(host.commands).toHaveBeenCalledOnce()

    send('first', { kind: 'devices', userId: '@alice:test' })
    await vi.waitFor(() => expect(host.result).toHaveBeenCalledWith('first', true, { ran: 'devices' }))

    sdk.command.mockRejectedValueOnce(new Error('private detail'))
    send('second', { kind: 'send', roomId: '!room:test', body: 'hi' })
    await vi.waitFor(() => expect(host.result).toHaveBeenCalledWith('second', false, 'matrix_operation_failed'))

    // The Founder chat's refusal crosses by its code, so the window can say why.
    sdk.command.mockRejectedValueOnce(new Error('matrix_founder_unready'))
    send('refused', { kind: 'send', roomId: '!founder:test', body: 'hi' })
    await vi.waitFor(() => expect(host.result).toHaveBeenCalledWith('refused', false, 'matrix_founder_unready'))

    send('third', { kind: 'stop' })
    await vi.waitFor(() => expect(host.result).toHaveBeenCalledWith('third', true, undefined))
    expect(sdk.stop).toHaveBeenCalledOnce()
    expect(JSON.stringify(host.result.mock.calls)).not.toContain('private detail')
  })

  it("routes the host's renewal notice to the engine, which takes the new token itself", async () => {
    const sdk = {
      command: vi.fn(async () => 'not this'),
      stop: vi.fn(async () => {}),
      renewed: vi.fn(async () => true)
    }

    engine.start.mockResolvedValue(sdk)
    const { host, send } = bridge()
    await serveDesktop(host)

    send('renewal', { kind: 'renewed' })
    await vi.waitFor(() => expect(host.result).toHaveBeenCalledWith('renewal', true, true))
    expect(sdk.renewed).toHaveBeenCalledOnce()
    expect(sdk.command).not.toHaveBeenCalled()
  })

  it('holds a command that arrives while the engine is starting, then answers it', async () => {
    let started!: (value: unknown) => void
    const sdk = { command: vi.fn(async () => 'answered'), stop: vi.fn(async () => {}) }
    engine.start.mockReturnValue(new Promise(resolve => (started = resolve)))
    const { host, send } = bridge()
    await serveDesktop(host)

    send('early', { kind: 'devices', userId: '@alice:test' })
    await Promise.resolve()
    expect(host.result).not.toHaveBeenCalled()

    started(sdk)
    await vi.waitFor(() => expect(host.result).toHaveBeenCalledWith('early', true, 'answered'))
  })

  it('reports a failed start as one closed-code snapshot, and fails every command after it', async () => {
    engine.start.mockRejectedValue(new Error('raw start detail'))
    const { host, send } = bridge()
    await serveDesktop(host)

    await vi.waitFor(() => expect(host.snapshot).toHaveBeenCalledOnce())
    expect(host.snapshot).toHaveBeenCalledWith(startFailed)

    send('after', { kind: 'devices', userId: '@alice:test' })
    await vi.waitFor(() => expect(host.result).toHaveBeenCalledWith('after', false, 'matrix_operation_failed'))
    expect(JSON.stringify([host.snapshot.mock.calls, host.result.mock.calls])).not.toContain('raw start detail')
  })

  it('reports a configuration the bridge cannot give the same way', async () => {
    engineWith()
    const { host } = bridge()
    host.configuration.mockRejectedValue(new Error('matrix_sdk_identity_changed'))
    await serveDesktop(host)

    await vi.waitFor(() => expect(host.snapshot).toHaveBeenCalledWith(startFailed))
    expect(engine.start).not.toHaveBeenCalled()
  })

  it("reports the window's own errors through the desktop's diagnostics", async () => {
    engineWith()
    const error = vi.fn()
    Object.defineProperty(window, 'atumDesktopServices', { value: { error }, configurable: true })
    await serveDesktop(bridge().host)

    window.dispatchEvent(new ErrorEvent('error', { error: new TypeError('boom') }))
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ operation: 'renderer', kind: 'TypeError' }))

    const rejection = Object.assign(new Event('unhandledrejection'), { reason: new RangeError('late') })
    window.dispatchEvent(rejection)
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ operation: 'renderer', kind: 'RangeError' }))
  })
})
