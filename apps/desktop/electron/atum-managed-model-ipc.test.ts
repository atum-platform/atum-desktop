import { describe, expect, it, vi } from 'vitest'

import {
  ATUM_MANAGED_MODEL_ACCESS_CHANNEL,
  ATUM_MANAGED_MODEL_USAGE_CHANNEL,
  registerAtumManagedModelIpc
} from './atum-managed-model-ipc'

describe('managed model access IPC', () => {
  it('registers one read-only status seam and removes it', async () => {
    const handlers = new Map<string, (event: unknown, alias?: unknown) => unknown>()

    const ipc = {
      handle: vi.fn((channel: string, listener: (event: unknown, alias?: unknown) => unknown) => handlers.set(channel, listener)),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel))
    }

    const accessState = vi.fn(async () => ({ state: 'warning' as const, access_alias: 'binh-minh' }) as never)

    const unregister = registerAtumManagedModelIpc(ipc, { accessState })

    expect(await handlers.get(ATUM_MANAGED_MODEL_ACCESS_CHANNEL)?.(null, 'binh-minh')).toEqual({
      state: 'warning',
      access_alias: 'binh-minh'
    })
    expect(accessState).toHaveBeenCalledWith('binh-minh')

    unregister()
    expect(ipc.removeHandler).toHaveBeenCalledWith(ATUM_MANAGED_MODEL_ACCESS_CHANNEL)
  })

  it('fails closed when the managed proxy did not start', async () => {
    const handlers = new Map<string, (event: unknown, alias?: unknown) => unknown>()
    registerAtumManagedModelIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, null)

    expect(await handlers.get(ATUM_MANAGED_MODEL_ACCESS_CHANNEL)?.(null, 'binh-minh')).toEqual({ state: 'unavailable' })
  })

  it('rejects unknown and mismatched aliases without exposing account authority', async () => {
    const handlers = new Map<string, (event: unknown, alias?: unknown) => unknown>()
    const accessState = vi.fn(async () => ({ state: 'denied', access_alias: 'binh-minh', billing_currency: 'protons' } as const))
    registerAtumManagedModelIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, { accessState })
    const handler = handlers.get(ATUM_MANAGED_MODEL_ACCESS_CHANNEL)!

    expect(await handler(null, 'future-model')).toEqual({ state: 'unavailable' })
    expect(accessState).not.toHaveBeenCalled()
    expect(await handler({ bearer: 'renderer-must-not-forward-this' }, 'nguyet-thuc')).toEqual({ state: 'unavailable' })
    expect(accessState).toHaveBeenCalledWith('nguyet-thuc')
  })

  it('serves the caller-owned usage history read-only with a bounded limit', async () => {
    const handlers = new Map<string, (event: unknown, argument?: unknown) => unknown>()
    const usageHistory = vi.fn(async () => ({ state: 'resolved' as const, turns: [] }))
    const accessState = vi.fn(async () => ({ state: 'unavailable' as const }))
    registerAtumManagedModelIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, { accessState, usageHistory })
    const handler = handlers.get(ATUM_MANAGED_MODEL_USAGE_CHANNEL)!

    expect(await handler(null, 500)).toEqual({ state: 'resolved', turns: [] })
    expect(usageHistory).toHaveBeenLastCalledWith(50)
    await handler(null, 'not-a-number')
    expect(usageHistory).toHaveBeenLastCalledWith(20)
    await handler(null, 5)
    expect(usageHistory).toHaveBeenLastCalledWith(5)
  })

  it('fails closed on usage when the proxy is absent or predates the history seam', async () => {
    const handlers = new Map<string, (event: unknown, argument?: unknown) => unknown>()
    registerAtumManagedModelIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, null)
    expect(await handlers.get(ATUM_MANAGED_MODEL_USAGE_CHANNEL)?.(null, 10)).toEqual({ state: 'unavailable' })

    const legacy = new Map<string, (event: unknown, argument?: unknown) => unknown>()
    registerAtumManagedModelIpc(
      { handle: (channel, listener) => legacy.set(channel, listener) },
      { accessState: vi.fn(async () => ({ state: 'unavailable' as const })) }
    )
    expect(await legacy.get(ATUM_MANAGED_MODEL_USAGE_CHANNEL)?.(null, 10)).toEqual({ state: 'unavailable' })
  })
})
