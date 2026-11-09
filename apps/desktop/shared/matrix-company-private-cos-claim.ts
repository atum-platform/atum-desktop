import type { MatrixRoom } from './matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from './matrix-assistant-room'

// Dependency-free on purpose: the cloud controller bundles matrix-company-channel-room.ts and
// src/matrix/message.ts, and its release may import only its own dependencies
// (packages/cloud-controller release-imports test). The zod schemas stay in matrix-company-private-cos.ts.
export const MATRIX_COMPANY_PRIVATE_COS_CLASSIFICATION = 'company_private_cos' as const
export const MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE = MATRIX_ASSISTANT_ROOM_TYPE
export const MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT = 'io.atum.company_private_cos' as const

export interface MatrixCompanyPrivateCosRoomBinding {
  v: 1
  classification: typeof MATRIX_COMPANY_PRIVATE_COS_CLASSIFICATION
  companyId: string
  membershipIncarnation: string
  executorId: string
  attemptId?: string
}

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const BINDING_KEYS = ['v', 'classification', 'companyId', 'membershipIncarnation', 'executorId'] as const

const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

/** Exact Matrix state marker frozen by private-cos/1.1 round 5 (1.3 adds `attemptId`). Strict: unknown keys refuse. */
export function matrixCompanyPrivateCosRoomBinding(
  roomType: unknown,
  eventType: unknown,
  stateKey: unknown,
  content: unknown
): MatrixCompanyPrivateCosRoomBinding | undefined {
  if (roomType !== MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE ||
    eventType !== MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT ||
    stateKey !== '' ||
    !content || typeof content !== 'object' || Array.isArray(content)) {
    return undefined
  }

  const value = content as Record<string, unknown>
  const keys = Object.keys(value)
  const hasAttempt = Object.hasOwn(value, 'attemptId')

  if (keys.length !== BINDING_KEYS.length + (hasAttempt ? 1 : 0) ||
    !BINDING_KEYS.every(key => Object.hasOwn(value, key)) ||
    value.v !== 1 ||
    value.classification !== MATRIX_COMPANY_PRIVATE_COS_CLASSIFICATION ||
    !isUuid(value.companyId) || !isUuid(value.membershipIncarnation) || !isUuid(value.executorId) ||
    (hasAttempt && !isUuid(value.attemptId))) {
    return undefined
  }

  return {
    v: 1,
    classification: MATRIX_COMPANY_PRIVATE_COS_CLASSIFICATION,
    companyId: value.companyId,
    membershipIncarnation: value.membershipIncarnation,
    executorId: value.executorId,
    ...(hasAttempt ? { attemptId: value.attemptId as string } : {})
  }
}

export function isCompanyPrivateCosRoom(
  room: Pick<MatrixRoom, 'companyPrivateCos'> | null | undefined
): boolean {
  return room?.companyPrivateCos?.classification === MATRIX_COMPANY_PRIVATE_COS_CLASSIFICATION
}

/** Exact/claimed marker rooms and the platform-bound room stay out of Personal surfaces. */
export function isCompanyPrivateCosClaim(
  room: Partial<Pick<MatrixRoom,
    'companyPrivateCos' | 'companyPrivateCosBound' | 'companyPrivateCosClaim' | 'membership' | 'roomType'
  >> | null | undefined
): boolean {
  return isCompanyPrivateCosRoom(room) ||
    room?.companyPrivateCosClaim === true ||
    room?.companyPrivateCosBound === true
}

export interface MatrixCompanyPrivateCosPowerLevels {
  users: Record<string, number>
  users_default: number
  events_default: number
  state_default: number
  invite: number
  kick: number
  ban: number
  redact: number
  events: Record<string, number>
  [key: string]: unknown
}

const POWER_KEYS = ['users_default', 'events_default', 'state_default', 'invite', 'kick', 'ban', 'redact'] as const

const isPower = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100

const powerRecord = (value: unknown): Record<string, number> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const entries = Object.entries(value as Record<string, unknown>)

  return entries.every(([, level]) => isPower(level)) ? Object.fromEntries(entries) as Record<string, number> : undefined
}

/** `m.room.power_levels` content with every private-CoS policy field present and in 0..100; other keys pass through. */
export function matrixCompanyPrivateCosPowerLevels(value: unknown): MatrixCompanyPrivateCosPowerLevels | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const content = value as Record<string, unknown>
  const users = powerRecord(content.users)
  const events = powerRecord(content.events)

  return users && events && POWER_KEYS.every(key => isPower(content[key]))
    ? { ...content, users, events } as MatrixCompanyPrivateCosPowerLevels
    : undefined
}
