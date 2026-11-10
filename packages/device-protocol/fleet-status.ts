import type { MacSourceStatus } from './messages'
import { DEVICE_FLEET_PACK } from './contract-packs'
import { typeViolations } from './schema'

/** Additive owner-list fields. Advisory only; never enrollment or execution authority. */
export interface FleetStatus {
  presence?: { connected: boolean; lastSeenAt: number }
  sourceProtocol?: 1
  sources?: MacSourceStatus
}
export function fleetStatus(value: unknown, now = Date.now()): FleetStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const row = value as Record<string, unknown>
  const p = row.presence as Record<string, unknown> | undefined
  const sources = row.sourceProtocol === 1 && !typeViolations(DEVICE_FLEET_PACK, 'sources', row.sources).length ? row.sources as MacSourceStatus : undefined
  const presence = p && !typeViolations(DEVICE_FLEET_PACK, 'presence', p).length && typeof p.connected === 'boolean' &&
    Number.isSafeInteger(p.lastSeenAt) && Number(p.lastSeenAt) >= 0 && Number(p.lastSeenAt) <= now ?
    { connected: p.connected, lastSeenAt: Number(p.lastSeenAt) } : undefined
  return { ...(presence ? { presence } : {}), ...(sources ? { sourceProtocol: 1 as const, sources } : {}) }
}

export interface FleetUpdate extends FleetStatus {
  operation: 'connect' | 'refresh' | 'close'
  deviceServiceId: string
  connectionId: string
  connectionStartedAt: number
  presence: { connected: boolean; lastSeenAt: number }
}
