import { BrowserFailure } from './record'
import type { BoundDevice } from './session'
import type { DomainGrant } from './domain-session'

export interface AccountState {
  matrix: 'empty' | 'active'
  domain: 'off' | 'empty' | 'active' | 'attention'
  domainError?: unknown
  authorization?: URL
}

/** Resume the Matrix grant, start its selected consumer, then bind the domain grant. */
export async function openAccount(device: BoundDevice, domain: DomainGrant | undefined,
  start: () => Promise<void>, callback?: URL): Promise<AccountState> {
  const state = await device.load()
  if (state === 'empty') {
    if (callback || await domain?.hasRecord()) throw new BrowserFailure('recovery_needed')
    return { matrix: 'empty', domain: domain ? 'empty' : 'off' }
  }
  const firstCallback = state === 'pending'
  if (firstCallback) {
    if (!callback || await domain?.hasRecord()) throw new BrowserFailure('recovery_needed')
    await device.callback(callback)
  }
  await start()
  if (!domain) {
    if (callback && !firstCallback) throw new BrowserFailure('signed_out')
    return { matrix: 'active', domain: 'off' }
  }
  try {
    const domainState = await domain.load()
    if (callback && !firstCallback) {
      if (domainState !== 'pending') throw new BrowserFailure('recovery_needed')
      await domain.callback(callback)
      return { matrix: 'active', domain: 'active' }
    }
    if (domainState === 'pending') throw new BrowserFailure('recovery_needed')
    if (firstCallback && domainState === 'empty') {
      return { matrix: 'active', domain: 'empty', authorization: await domain.beginLogin() }
    }
    return { matrix: 'active', domain: domainState }
  } catch (domainError) {
    // A domain failure never tears down or replaces the active Matrix device.
    return { matrix: 'active', domain: 'attention', domainError }
  }
}

export async function signOutAccount(device: BoundDevice, domain?: DomainGrant): Promise<boolean> {
  device.closeAdmission()
  domain?.closeAdmission()
  // Both grants close synchronously before either provider or rotation is awaited.
  const [matrix, account] = await Promise.allSettled([device.prepareSignOut(), domain?.prepareSignOut()])
  // No remote revocation starts until both local phase commits have settled.
  const revoked = await Promise.allSettled([
    ...(matrix.status === 'fulfilled' ? [device.revokeSignOut(matrix.value)] : []),
    ...(account.status === 'fulfilled' && account.value && domain ? [domain.revokeSignOut(account.value)] : [])
  ])
  return matrix.status === 'fulfilled' && account.status === 'fulfilled' && revoked.every(result => result.status === 'fulfilled')
}
