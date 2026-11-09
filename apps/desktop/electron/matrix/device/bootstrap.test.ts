import { describe, expect, it, vi } from 'vitest'

import {
  type DeviceBootstrapDeps,
  type DeviceConnectionPort,
  deviceLaunchFrom,
  DeviceServiceBootstrap,
  fenceDeviceBeforeOperationLock
} from './bootstrap'
import { MATRIX_DEVICE_IPC } from './bridge'
import type { DeviceRuntime } from './runtime'

type Handler = (event: unknown, input: unknown) => unknown

function harness(over: Partial<DeviceBootstrapDeps> = {}) {
  const order: string[] = []
  const handlers = new Map<string, Handler>()
  let fence: ((reason: never) => void) | null = null

  const runtime = {
    service: { tag: 'service', setPaused: vi.fn() },
    start: vi.fn(async () => void order.push('runtime.start')),
    stop: vi.fn(async () => void order.push('runtime.stop')),
    fence: vi.fn((reason: string) => void order.push(`fence:${reason}`)),
    hello: vi.fn(),
    request: vi.fn(async (request: unknown) => ({ answered: request }))
  } as unknown as DeviceRuntime & { start: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn> }

  let current: DeviceConnectionPort | null = null

  const deps: DeviceBootstrapDeps = {
    createRuntime: vi.fn(() => runtime),
    connection: () => current,
    registerFence: next => {
      fence = next as typeof fence
    },
    ipc: {
      handle: (channel: string, handler: Handler) => void handlers.set(channel, handler),
      removeHandler: (channel: string) => void handlers.delete(channel)
    } as unknown as DeviceBootstrapDeps['ipc'],
    requireCaller: vi.fn(),
    log: line => void order.push(line),
    ...over
  }

  function connect() {
    const connection = {
      attach: vi.fn(() => void order.push('connection.attach')),
      start: vi.fn(() => void order.push('connection.start'))
    }

    current = connection

    return connection
  }

  return { deps, runtime, order, handlers, connect, fence: () => fence }
}

describe('the device-service bootstrap', () => {
  it('reads a login launch only from wasOpenedAtLogin === true', () => {
    expect(deviceLaunchFrom({ wasOpenedAtLogin: true })).toBe('login_hidden')
    expect(deviceLaunchFrom({ wasOpenedAtLogin: 'true' })).toBe('interactive')
    expect(deviceLaunchFrom({})).toBe('interactive')
    expect(deviceLaunchFrom(null)).toBe('interactive')
  })

  it('lets an approval that starts elsewhere hold the device still, and ignores it before there is a runtime', () => {
    const { deps, runtime } = harness()
    const boot = new DeviceServiceBootstrap(deps)
    const setPaused = (runtime.service as unknown as { setPaused: ReturnType<typeof vi.fn> }).setPaused

    boot.setPaused(true)
    expect(setPaused).not.toHaveBeenCalled()

    boot.install()
    boot.setPaused(true)
    boot.setPaused(false)
    expect(setPaused.mock.calls).toEqual([[true], [false]])
  })

  it('starts the device service on a hidden login launch with no window, and attaches before dialling', async () => {
    const { deps, order, connect } = harness()
    const boot = new DeviceServiceBootstrap(deps)
    connect()

    // No window, no UI request, no Settings visit: only the account becoming ready.
    boot.install()
    await boot.accountReady('login_hidden')

    expect(order).toEqual(['runtime.start', '[Device] service started launch=login_hidden', 'connection.attach', 'connection.start'])
  })

  it('is idempotent while running, and attaches a connection that appears after enrollment', async () => {
    const { deps, runtime, order, connect } = harness()
    const boot = new DeviceServiceBootstrap(deps)
    boot.install()

    await boot.accountReady('interactive')
    expect(order).not.toContain('connection.attach')

    const connection = connect()
    await boot.accountReady('interactive')
    await boot.accountReady('interactive')

    expect(runtime.start).toHaveBeenCalledTimes(1)
    expect(connection.attach).toHaveBeenCalledTimes(1)
    expect(connection.attach).toHaveBeenCalledWith(runtime.service)
    expect(connection.start).toHaveBeenCalledTimes(1)
  })

  it('registers the fence at install, before any start, so the first sign-out or sleep fences', () => {
    const { deps, order, fence } = harness()
    new DeviceServiceBootstrap(deps).install()

    fence()!('sleep' as never)

    expect(order).toEqual(['fence:sleep'])
  })

  it('stops after sign-out and starts afresh on the next sign-in', async () => {
    const { deps, runtime, connect } = harness()
    const boot = new DeviceServiceBootstrap(deps)
    boot.install()
    const first = connect()
    await boot.accountReady('interactive')

    await boot.signedOut()
    expect(runtime.stop).toHaveBeenCalledTimes(1)

    await boot.accountReady('interactive')
    expect(runtime.start).toHaveBeenCalledTimes(2)
    // The same connection object is attached again for the new account session.
    expect(first.attach).toHaveBeenCalledTimes(2)
  })

  it('a failed start can be retried', async () => {
    const { deps, runtime } = harness()
    runtime.start.mockRejectedValueOnce(new Error('boom'))
    const boot = new DeviceServiceBootstrap(deps)
    boot.install()

    await expect(boot.accountReady('login_hidden')).rejects.toThrow('boom')
    await boot.accountReady('login_hidden')
    expect(runtime.start).toHaveBeenCalledTimes(2)
  })

  it('the Settings bridge checks the caller, parses the request and forwards only the parsed fields', async () => {
    const requireCaller = vi.fn()
    const { deps, runtime, handlers } = harness({ requireCaller })
    new DeviceServiceBootstrap(deps).install()
    const handler = handlers.get(MATRIX_DEVICE_IPC)!

    await expect(handler('event', { action: 'revokeGrant', id: 'g1', extra: 'dropped' })).resolves.toEqual({
      answered: { action: 'revokeGrant', id: 'g1' }
    })
    expect(requireCaller).toHaveBeenCalledWith('event')

    expect(() => handler('event', { action: 'enroll' })).toThrow('device_request_invalid')
    expect(() => handler('event', { action: 'addGrant', capability: 'ssh_agent' })).toThrow('device_request_invalid')
    expect(() => handler('event', { action: 'revokeGrant', id: 'x'.repeat(300) })).toThrow('device_request_invalid')
    expect(runtime.request).toHaveBeenCalledTimes(1)
  })

  it('a caller main does not trust reaches nothing', () => {
    const { deps, runtime, handlers } = harness({
      requireCaller: () => {
        throw new Error('matrix_caller_invalid')
      }
    })

    new DeviceServiceBootstrap(deps).install()

    expect(() => handlers.get(MATRIX_DEVICE_IPC)!('event', { action: 'stop' })).toThrow('matrix_caller_invalid')
    expect(runtime.request).not.toHaveBeenCalled()
  })

  it('dispose removes the bridge and the fence and stops the runtime', async () => {
    const { deps, runtime, handlers, fence } = harness()
    const boot = new DeviceServiceBootstrap(deps)
    boot.install()
    await boot.accountReady('interactive')

    await boot.dispose()

    expect(handlers.has(MATRIX_DEVICE_IPC)).toBe(false)
    expect(fence()).toBeNull()
    expect(runtime.stop).toHaveBeenCalledTimes(1)
  })
})

describe('the sign-out fence and the operation lock', () => {
  /**
   * A model of main's UI request handler order: the pre-lock fence is the first statement, then
   * `anyOperation()` refuses with `matrix_operation_pending`. Sign-out must fence even when refused.
   */
  function uiRequest(kind: string, busy: boolean, fence: (reason: string) => void): string {
    fenceDeviceBeforeOperationLock(kind, fence)

    if (busy) {
      return 'matrix_operation_pending'
    }

    return 'handled'
  }

  it('sign-out fences the device even while another operation holds the lock', () => {
    const fence = vi.fn()

    expect(uiRequest('signOut', true, fence)).toBe('matrix_operation_pending')
    // A local Stop: the request may still be refused, so the connection must stay usable (B3).
    expect(fence).toHaveBeenCalledWith('local_stop')
  })

  it('nothing else fences before the lock', () => {
    const fence = vi.fn()

    for (const kind of ['signIn', 'command', 'sendTurn', 'readDomain', undefined]) {
      uiRequest(kind as string, true, fence)
    }

    expect(fence).not.toHaveBeenCalled()
  })
})
