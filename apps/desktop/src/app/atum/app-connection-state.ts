import { atom } from 'nanostores'

import { type AppConnectionStatus, type AppSurfaceResult, atumAppSurfaceClient } from '@/lib/atum-app-surfaces'
import { $atumAccountScopeId } from '@/store/atum-messaging'

export type AppConnectionResult = AppSurfaceResult<AppConnectionStatus>
export const $appConnections = atom<Record<string, AppConnectionResult>>({})
const inFlight = new Map<string, Promise<AppConnectionResult>>()
let generation = 0

export function appConnectionKey(accountId: string, appId: string): string {
  return `${accountId}:${appId}`
}

export function clearAppConnectionState(): void {
  generation += 1
  inFlight.clear()
  $appConnections.set({})
}

/** Invalidate only the withdrawn app, including an older in-flight status read. */
export function clearAppConnection(accountId: string, appId: string): void {
  const key = appConnectionKey(accountId, appId)
  inFlight.delete(key)
  const next = { ...$appConnections.get() }
  delete next[key]
  $appConnections.set(next)
}

$atumAccountScopeId.listen(clearAppConnectionState)

/** One transient public projection per app/account; no provider identity or credentials. */
export function refreshAppConnection(accountId: string, appId: string): Promise<AppConnectionResult> {
  const key = appConnectionKey(accountId, appId)
  const existing = inFlight.get(key)

  if (existing) {
    return existing
  }
  const expectedGeneration = generation

  const request = atumAppSurfaceClient()
    .connectStatus(appId)
    .catch((): AppConnectionResult => ({ error: 'app_surface_failed' }))
    .then(result => {
      if (generation !== expectedGeneration || inFlight.get(key) !== request) {
        return { error: 'atum_account_changed' }
      }
      $appConnections.set({ ...$appConnections.get(), [key]: result })

      return result
    })
    .finally(() => {
      if (inFlight.get(key) === request) {
        inFlight.delete(key)
      }
    })

  inFlight.set(key, request)

  return request
}

/** Legacy servers do not advertise the new policy. A failed read never grants it. */
export function appConnectionAllowsUse(result: AppConnectionResult | undefined): boolean {
  if (!result) {
    return false
  }

  if ('error' in result) {
    return false
  }

  if (result.status === 'unlinked' || result.available === false) {
    return false
  }

  if (result.connectionRequired === true) {
    return result.available === true && result.status === 'linked' && result.readiness === 'ready'
  }

  return true
}
