import { DAILY_TURNS_MAX, DAILY_TURNS_MIN, MATRIX_MEETING_DEFAULT } from './limits'
import type { AgentPolicy, EffectiveModeFacts, Parsed, ParticipationMode, RoomPolicy, RoomUsage } from './types'

const modes = new Set<unknown>(['off', 'addressed', 'joins'])
const userId = /^@[!-~]+:[!-~]+$/u

const authorityFields = new Set([
  'ownerUserId',
  'payer',
  'verified',
  'toolsets',
  'shared_room',
  'reply_only',
  'pet_surface',
  'access_token',
  'private_key'
])

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function containsAuthority(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsAuthority)
  }

  return (
    record(value) && Object.entries(value).some(([key, child]) => authorityFields.has(key) || containsAuthority(child))
  )
}

export function parseRoomPolicy(value: unknown): Parsed<RoomPolicy> {
  if (value == null) {
    return { ok: true, value: { v: 1, agents: {} } }
  }

  if (!record(value) || value.v !== 1 || !record(value.agents) || containsAuthority(value)) {
    return { ok: false, code: 'invalid_policy' }
  }

  if (
    value.dailyTurns !== undefined &&
    (!Number.isSafeInteger(value.dailyTurns) ||
      Number(value.dailyTurns) < DAILY_TURNS_MIN ||
      Number(value.dailyTurns) > DAILY_TURNS_MAX)
  ) {
    return { ok: false, code: 'invalid_policy' }
  }

  if (value.routingDisclosure !== undefined && value.routingDisclosure !== 1) {
    return { ok: false, code: 'invalid_policy' }
  }

  for (const [id, entry] of Object.entries(value.agents)) {
    if (!userId.test(id) || id.length > 1024 || !record(entry) || !modes.has(entry.mode)) {
      return { ok: false, code: 'invalid_policy' }
    }
  }

  return { ok: true, value: value as unknown as RoomPolicy }
}

/** Validates a real UTC calendar date, beyond the contract's portable pattern. */
export function isUtcDay(day: unknown): day is string {
  if (typeof day !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(day)) {
    return false
  }

  const stamp = Date.parse(`${day}T00:00:00.000Z`)

  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === day
}

export function parseRoomUsage(value: unknown): Parsed<RoomUsage> {
  if (
    !record(value) ||
    value.v !== 1 ||
    !isUtcDay(value.day) ||
    !Number.isSafeInteger(value.turns) ||
    Number(value.turns) < 0 ||
    (value.pausedNoticed !== undefined && typeof value.pausedNoticed !== 'boolean') ||
    containsAuthority(value)
  ) {
    return { ok: false, code: 'invalid_usage' }
  }

  return { ok: true, value: value as unknown as RoomUsage }
}

export function effectiveMode({
  roomMode,
  stored,
  meetingDefault = MATRIX_MEETING_DEFAULT
}: EffectiveModeFacts): ParticipationMode {
  const mode = stored ?? (roomMode === 'meeting' ? meetingDefault : 'addressed')

  return roomMode === 'shared' && mode === 'joins' ? 'addressed' : mode
}

/** Preserve future account-data keys and unrelated assistants; never mutate the read cache. */
export function withAgentMode(policy: RoomPolicy, agentUserId: string, mode: ParticipationMode): Parsed<RoomPolicy> {
  const entry: AgentPolicy = { ...policy.agents[agentUserId], mode }

  return parseRoomPolicy({ ...policy, agents: { ...policy.agents, [agentUserId]: entry } })
}

export function withGroupRoutingDisclosure(policy: RoomPolicy): Parsed<RoomPolicy> {
  return parseRoomPolicy({ ...policy, routingDisclosure: 1 })
}
