import {
  type AccountConnectionsView,
  type AccountPlan,
  localAccountConnections,
  type LocalPlanCapability,
  parseAccountConnections
} from '../../../shared/account-connections'

import { deviceServiceCall } from './platform'

export interface AccountConnectionsReadDeps {
  /** `https://<host>/api/matrix/v1/device-services`, read on every call (it follows the signed-in account). */
  endpoint(): string | undefined
  bearer(): Promise<string>
  thisDevice(): string | undefined
  /** This Mac's own plan facts from T3's native status (C3's projection). Empty when Work is not running. */
  localCapabilities(): Promise<Partial<Record<AccountPlan, LocalPlanCapability>>>
  fetch?: typeof fetch
  now?(): number
}

/**
 * The account's connections: `account_connections_read` on the existing device-services endpoint, parsed against the contract. A
 * registry that cannot be read (the route is not deployed yet, the network is down, the reply does not parse) is answered from this
 * Mac's own plan facts, so Connect and this Mac's state still work; nothing about other Macs or the cloud is invented. No body is
 * logged and no credential crosses: the read carries only model names and device names.
 */
export async function readAccountConnections(deps: AccountConnectionsReadDeps): Promise<AccountConnectionsView> {
  const thisDevice = deps.thisDevice()
  const endpoint = deps.endpoint()

  if (endpoint) {
    try {
      const call = deviceServiceCall({ endpoint, bearer: deps.bearer, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
      const registry = parseAccountConnections(await call('account_connections_read', {}))

      if (registry) {
        return { source: 'account', ...(thisDevice ? { thisDevice } : {}), connections: registry.connections }
      }
    } catch {
      // Fall through to this Mac's own facts.
    }
  }

  const capabilities = await deps.localCapabilities().catch(() => ({}))

  return localAccountConnections({ capabilities, ...(thisDevice ? { thisDevice } : {}), deviceName: 'Mac', now: (deps.now ?? Date.now)() })
}
