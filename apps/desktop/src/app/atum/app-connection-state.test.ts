import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppConnectionStatus, AppSurfaceResult } from '@/lib/atum-app-surfaces'

const scope = atom<string | null>('account-a')
const connectStatus = vi.fn<() => Promise<AppSurfaceResult<AppConnectionStatus>>>()
vi.mock('@/store/atum-messaging', () => ({ $atumAccountScopeId: scope }))
vi.mock('@/lib/atum-app-surfaces', () => ({ atumAppSurfaceClient: () => ({ connectStatus }) }))

const { $appConnections, appConnectionAllowsUse, clearAppConnection, clearAppConnectionState, refreshAppConnection } =
  await import('./app-connection-state')

beforeEach(() => {
  scope.set('account-a')
  clearAppConnectionState()
  connectStatus
    .mockReset()
    .mockResolvedValue({ status: 'never_linked', connectionRequired: true, available: true, readiness: 'not_linked' })
})

describe('app connection authority cache', () => {
  it('shares an in-flight status read across the composer and Connect card', async () => {
    const first = refreshAppConnection('account-a', 'moon')
    const second = refreshAppConnection('account-a', 'moon')
    expect(first).toBe(second)
    await first
    expect(connectStatus).toHaveBeenCalledOnce()
  })

  it('drops a status response after account switch instead of publishing it for either owner', async () => {
    let finish!: (value: AppSurfaceResult<AppConnectionStatus>) => void
    connectStatus.mockReturnValue(
      new Promise(resolve => {
        finish = resolve
      })
    )
    const pending = refreshAppConnection('account-a', 'moon')
    scope.set('account-b')
    finish({ status: 'linked', connectionRequired: true, available: true, readiness: 'ready' })
    expect(await pending).toEqual({ error: 'atum_account_changed' })
    expect($appConnections.get()).toEqual({})
  })

  it.each([
    undefined,
    { error: 'unavailable' },
    { status: 'never_linked', connectionRequired: true, available: true, readiness: 'not_linked' },
    { status: 'unlinked' },
    { status: 'linked', connectionRequired: true, available: true, readiness: 'pending' },
    { status: 'linked', connectionRequired: true, available: true, readiness: 'unavailable' },
    { status: 'linked', connectionRequired: true, available: false, readiness: 'ready' }
  ] as const)('never grants explicit use from absent, withdrawn or incomplete authority %#', result => {
    expect(appConnectionAllowsUse(result)).toBe(false)
  })

  it('allows only ready explicit connections and positively reported protected compatibility', () => {
    expect(
      appConnectionAllowsUse({ status: 'linked', connectionRequired: true, available: true, readiness: 'ready' })
    ).toBe(true)
    expect(
      appConnectionAllowsUse({
        status: 'never_linked',
        connectionRequired: false,
        available: true,
        readiness: 'not_linked'
      })
    ).toBe(true)
  })
})

it('per-app invalidation rejects an old read without disturbing another app', async () => {
  const andy = await refreshAppConnection('account-a', 'andy')
  let finish!: (value: AppSurfaceResult<AppConnectionStatus>) => void
  connectStatus.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const oldMoon = refreshAppConnection('account-a', 'moon')
  clearAppConnection('account-a', 'moon')
  connectStatus.mockResolvedValueOnce({ status: 'unlinked', available: true, connectionRequired: true, readiness: 'not_linked' })
  const currentMoon = await refreshAppConnection('account-a', 'moon')
  finish({ status: 'linked', available: true, connectionRequired: true, readiness: 'ready' })
  expect(await oldMoon).toHaveProperty('error')
  expect($appConnections.get()).toEqual({ 'account-a:andy': andy, 'account-a:moon': currentMoon })
  expect(appConnectionAllowsUse({ status: 'never_linked', connectionRequired: false, available: true, connectAvailable: false })).toBe(true)
})
