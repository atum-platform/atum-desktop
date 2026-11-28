import {
  type AccountConnectionsView,
  type AccountPlan,
  localAccountConnections,
  type LocalPlanCapability,
  parseAccountConnections
} from '../../../shared/account-connections'

import { deviceServiceCall } from './platform'

type LocalPlanCapabilities = Partial<Record<AccountPlan, LocalPlanCapability>>

export interface AccountConnectionsReadDeps {
  /** `https://<host>/api/matrix/v1/device-services`, read on every call (it follows the signed-in account). */
  endpoint(): string | undefined
  bearer(): Promise<string>
  thisDevice(): string | undefined
  /** This Mac's own plan facts from T3's native status (C3's projection). Empty when Work is not running. */
  localCapabilities(): Promise<LocalPlanCapabilities>
  fetch?: typeof fetch
  now?(): number
}

/**
 * The account's connections: `account_connections_read` on the existing device-services endpoint, parsed against the contract. A
 * registry supplies other Macs and cloud connections. This Mac's native observation supersedes its own
 * registry row as soon as Work has definitive status. A failed registry read still returns local facts.
 */
export async function readAccountConnections(deps: AccountConnectionsReadDeps): Promise<AccountConnectionsView> {
  const thisDevice = deps.thisDevice()
  const endpoint = deps.endpoint()
  const readLocal = () => deps.localCapabilities().catch<LocalPlanCapabilities>(() => ({}))

  if (endpoint) {
    try {
      const call = deviceServiceCall({ endpoint, bearer: deps.bearer, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
      const registry = parseAccountConnections(await call('account_connections_read', {}))

      if (registry) {
        const capabilities = await readLocal()
        const local = localAccountConnections({ capabilities, thisDevice, deviceName: 'Mac', now: (deps.now ?? Date.now)() })
        const connections = registry.connections.map(row => {
          if (row.kind !== 'plan' || !capabilities[row.id]) {return row}

          const current = local.connections.find(entry => entry.id === row.id)

          if (current?.kind !== 'plan') {return row}
          const previous = row.devices.find(device => device.deviceServiceId === thisDevice)
          const otherMacs = row.devices.filter(device => device.deviceServiceId !== thisDevice)
          const devices = [...current.devices.map(device => ({ ...device, displayName: previous?.displayName ?? device.displayName })), ...otherMacs]
          const models = new Map((otherMacs.length ? row.models : []).map(model => [model.id, model]))

          for (const model of current.models) {models.set(model.id, model)}

          return {
            ...row,
            status: current.status === 'connected' || otherMacs.length ? 'connected' as const : 'not_connected' as const,
            devices,
            models: [...models.values()]
          }
        })

        return { ...local, source: 'account', connections }
      }
    } catch {
      // Fall through to this Mac's own facts.
    }
  }

  const capabilities = await readLocal()

  return localAccountConnections({ capabilities, ...(thisDevice ? { thisDevice } : {}), deviceName: 'Mac', now: (deps.now ?? Date.now)() })
}
