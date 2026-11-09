import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $managedModelAccess,
  $managedModelUsage,
  MANAGED_MODEL_USAGE_LIMIT,
  managedModelAccessAliasForView,
  refreshManagedModelAccess,
  refreshManagedModelUsage,
  resetManagedModelAccess,
  retainManagedModelAccessPolling
} from './atum-managed-model'

beforeEach(() => {
  resetManagedModelAccess()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('managed model access store', () => {
  it('keeps account recovery bound to the currently projected alias', () => {
    expect(managedModelAccessAliasForView({ state: 'idle' })).toBe('binh-minh')
    expect(
      managedModelAccessAliasForView({
        state: 'resolved',
        accessAlias: 'nguyet-thuc',
        access: { state: 'unavailable' }
      })
    ).toBe('nguyet-thuc')
  })

  it('coalesces concurrent reads', async () => {
    const access = vi.fn(async () => ({ state: 'insufficient_funds' as const, access_alias: 'binh-minh' }) as never)
    vi.stubGlobal('window', { hermesDesktop: { managedModel: { access } } })

    await Promise.all([refreshManagedModelAccess(), refreshManagedModelAccess()])

    expect(access).toHaveBeenCalledOnce()
    expect(access).toHaveBeenCalledWith('binh-minh')
    expect($managedModelAccess.get()).toMatchObject({ state: 'resolved', accessAlias: 'binh-minh', access: { state: 'insufficient_funds' } })
  })

  it('does not restore a stale response after reset', async () => {
    let resolve!: (value: never) => void

    const pending = new Promise<never>(done => {
      resolve = done
    })

    vi.stubGlobal('window', { hermesDesktop: { managedModel: { access: () => pending } } })

    const refresh = refreshManagedModelAccess()
    resetManagedModelAccess()
    resolve({ state: 'insufficient_funds' } as never)
    await refresh

    expect($managedModelAccess.get()).toEqual({ state: 'idle' })
  })

  it('maps a rejected bridge call to unavailable', async () => {
    vi.stubGlobal('window', {
      hermesDesktop: {
        managedModel: {
          access: async () => {
            throw new Error('offline')
          }
        }
      }
    })

    await refreshManagedModelAccess()
    expect($managedModelAccess.get()).toMatchObject({ state: 'resolved', accessAlias: 'binh-minh', access: { state: 'unavailable' } })
  })

  it('keeps the resolved snapshot visible during background revalidation', async () => {
    const responses: Array<() => void> = []

    const access = vi.fn(
      () => new Promise<never>(resolve => responses.push(() => resolve({ state: 'ready' } as never)))
    )

    vi.stubGlobal('window', { hermesDesktop: { managedModel: { access } } })

    const first = refreshManagedModelAccess()
    responses.shift()?.()
    await first
    expect($managedModelAccess.get()).toMatchObject({ state: 'resolved', accessAlias: 'binh-minh', access: { state: 'ready' } })

    const second = refreshManagedModelAccess()
    expect($managedModelAccess.get()).toMatchObject({ state: 'resolved', accessAlias: 'binh-minh', access: { state: 'ready' } })
    responses.shift()?.()
    await second
  })

  it('retains stale display after failed reads and recovers without treating it as fresh', async () => {
    const access = vi.fn()
      .mockResolvedValueOnce({ state: 'ready', billing_currency: 'protons', access_alias: 'binh-minh' })
      .mockResolvedValueOnce({ state: 'unavailable' })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ state: 'insufficient_funds', billing_currency: 'protons', access_alias: 'binh-minh' })

    vi.stubGlobal('window', { hermesDesktop: { managedModel: { access } } })
    await refreshManagedModelAccess()
    const first = $managedModelAccess.get()
    await refreshManagedModelAccess()
    expect($managedModelAccess.get()).toMatchObject({ access: { state: 'ready' }, freshness: { consecutiveFailures: 1 } })
    await refreshManagedModelAccess()
    expect($managedModelAccess.get()).toMatchObject({ access: { state: 'ready' }, freshness: { consecutiveFailures: 2 } })
    const stale = $managedModelAccess.get()
    expect(stale.state === 'resolved' && stale.freshness?.checkedAt).toBe(first.state === 'resolved' && first.freshness?.checkedAt)
    await refreshManagedModelAccess()
    expect($managedModelAccess.get()).toMatchObject({ access: { state: 'insufficient_funds' }, freshness: { consecutiveFailures: 0 } })
  })

  it('never retains ready over an explicit authentication or eligibility failure', async () => {
    const access = vi.fn().mockResolvedValueOnce({ state: 'ready' }).mockResolvedValueOnce({ state: 'authentication_expired' }).mockResolvedValueOnce({ state: 'denied' })
    vi.stubGlobal('window', { hermesDesktop: { managedModel: { access } } })
    await refreshManagedModelAccess()
    await refreshManagedModelAccess()
    expect($managedModelAccess.get()).toMatchObject({ access: { state: 'authentication_expired' }, freshness: { consecutiveFailures: 0 } })
    await refreshManagedModelAccess()
    expect($managedModelAccess.get()).toMatchObject({ access: { state: 'denied' }, freshness: { consecutiveFailures: 0 } })
  })

  it('shares one poller across mounted managed views until the final release', async () => {
    vi.useFakeTimers()
    const access = vi.fn(async () => ({ state: 'ready' as const }) as never)
    vi.stubGlobal('window', Object.assign(window, { hermesDesktop: { managedModel: { access } } }))

    const releaseFirst = retainManagedModelAccessPolling()
    const releaseSecond = retainManagedModelAccessPolling()
    await vi.advanceTimersByTimeAsync(0)
    expect(access).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(access).toHaveBeenCalledTimes(2)

    releaseFirst()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(access).toHaveBeenCalledTimes(3)

    releaseSecond()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(access).toHaveBeenCalledTimes(3)
    expect($managedModelAccess.get()).toEqual({ state: 'idle' })
  })

  it('rejects an older alias response after the active composer alias changes', async () => {
    const resolvers = new Map<string, (value: never) => void>()

    const access = vi.fn(
      (alias: string) => new Promise<never>(resolve => resolvers.set(alias, resolve))
    )

    vi.stubGlobal('window', { hermesDesktop: { managedModel: { access } } })

    const oldRequest = refreshManagedModelAccess('binh-minh')
    const activeRequest = refreshManagedModelAccess('nguyet-thuc')
    resolvers.get('nguyet-thuc')?.({ state: 'insufficient_funds', access_alias: 'nguyet-thuc' } as never)
    await activeRequest
    resolvers.get('binh-minh')?.({ state: 'ready', access_alias: 'binh-minh' } as never)
    await oldRequest

    expect($managedModelAccess.get()).toMatchObject({
      state: 'resolved',
      accessAlias: 'nguyet-thuc',
      access: { state: 'insufficient_funds', access_alias: 'nguyet-thuc' }
    })
  })
})

describe('managed model usage store', () => {
  it('coalesces concurrent usage reads onto one bounded page', async () => {
    const usage = vi.fn(async () => ({ state: 'resolved' as const, turns: [] }))
    vi.stubGlobal('window', { hermesDesktop: { managedModel: { access: vi.fn(), usage } } })

    await Promise.all([refreshManagedModelUsage(), refreshManagedModelUsage()])

    expect(usage).toHaveBeenCalledOnce()
    expect(usage).toHaveBeenCalledWith(MANAGED_MODEL_USAGE_LIMIT)
    expect($managedModelUsage.get()).toEqual({ state: 'resolved', usage: { state: 'resolved', turns: [] } })
  })

  it('fails closed when the preload predates the usage seam or rejects', async () => {
    vi.stubGlobal('window', { hermesDesktop: { managedModel: { access: vi.fn() } } })
    await refreshManagedModelUsage()
    expect($managedModelUsage.get()).toEqual({ state: 'resolved', usage: { state: 'unavailable' } })

    resetManagedModelAccess()
    vi.stubGlobal('window', { hermesDesktop: { managedModel: { access: vi.fn(), usage: () => Promise.reject(new Error('offline')) } } })
    await refreshManagedModelUsage()
    expect($managedModelUsage.get()).toEqual({ state: 'resolved', usage: { state: 'unavailable' } })
  })

  it('drops a stale usage response after sign-out reset', async () => {
    let resolve!: (value: never) => void

    const pending = new Promise<never>(done => {
      resolve = done
    })

    vi.stubGlobal('window', { hermesDesktop: { managedModel: { access: vi.fn(), usage: () => pending } } })

    const refresh = refreshManagedModelUsage()
    expect($managedModelUsage.get()).toEqual({ state: 'loading' })
    resetManagedModelAccess()
    resolve({ state: 'resolved', turns: [] } as never)
    await refresh

    expect($managedModelUsage.get()).toEqual({ state: 'idle' })
  })
})
