import { MATRIX_PROFILE_PHOTO_MAX_BYTES, matrixProfilePhotoType, type MatrixProfilePhotoType } from './matrix-profile'

export type AgentProfileOperation = 'list' | 'read' | 'update' | 'avatar'

export interface AgentProfileAvatar {
  type: MatrixProfilePhotoType
  bytes: Uint8Array
}

export type AgentProfileRequest =
  | { operation: 'list' }
  | { operation: 'read'; target?: string }
  | {
      operation: 'update'
      target?: string
      expectedDefinitionRevision: number
      expectedIdentityRevision: number
      displayName?: string
      soul?: string
    }
  | { operation: 'avatar'; target?: string; avatar: AgentProfileAvatar | null }

export interface AgentProfileRosterEntry {
  principal: string
  displayName: string
  isMain: boolean
  definitionRevision: number
  identityRevision: number
  avatarUrl: string | null
}

export interface AgentProfileDetail extends AgentProfileRosterEntry {
  soul: string
}

export interface AgentProfileEnvelope {
  executorId?: string
  originPrincipal: string
  originIsMain: boolean
  agents?: AgentProfileRosterEntry[]
  profile?: AgentProfileDetail
}

export type AgentProfileError =
  | 'conflict'
  | 'denied'
  | 'duplicate'
  | 'invalid'
  | 'locked'
  | 'missing'
  | 'offline'
  | 'reserved'
  | 'unavailable'

export type AgentProfileResult = AgentProfileEnvelope | { error: AgentProfileError }

const PRINCIPAL = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const MAX_NAME_INPUT = 4_096
const MAX_SOUL_BYTES = 65_536

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exact(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function revision(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum
}

function target(value: unknown): string | undefined {
  return value === undefined ? undefined : typeof value === 'string' && PRINCIPAL.test(value) ? value : ''
}

/**
 * Validate the model-facing request at the native/controller boundary. Transport scope
 * (`request_id`, `turn_id`) is accepted but never returned as authority-bearing input.
 */
export function agentProfileRequest(value: unknown): AgentProfileRequest | undefined {
  if (!record(value) || typeof value.operation !== 'string') {
    return undefined
  }

  const selected = target(value.target)

  if (selected === '') {
    return undefined
  }

  if (value.operation === 'list') {
    return exact(value, ['operation', 'request_id', 'turn_id']) ? { operation: 'list' } : undefined
  }

  if (value.operation === 'read') {
    return exact(value, ['operation', 'target', 'request_id', 'turn_id'])
      ? { operation: 'read', ...(selected ? { target: selected } : {}) }
      : undefined
  }

  if (value.operation === 'update') {
    if (
      !exact(value, [
        'operation',
        'target',
        'expectedDefinitionRevision',
        'expectedIdentityRevision',
        'displayName',
        'soul',
        'request_id',
        'turn_id'
      ]) ||
      !revision(value.expectedDefinitionRevision, 0) ||
      !revision(value.expectedIdentityRevision, 1) ||
      (value.displayName === undefined && value.soul === undefined) ||
      (value.displayName !== undefined &&
        (typeof value.displayName !== 'string' || value.displayName.length > MAX_NAME_INPUT)) ||
      (value.soul !== undefined &&
        (typeof value.soul !== 'string' || new TextEncoder().encode(value.soul).byteLength > MAX_SOUL_BYTES))
    ) {
      return undefined
    }

    return {
      operation: 'update',
      ...(selected ? { target: selected } : {}),
      expectedDefinitionRevision: value.expectedDefinitionRevision,
      expectedIdentityRevision: value.expectedIdentityRevision,
      ...(value.displayName === undefined ? {} : { displayName: value.displayName }),
      ...(value.soul === undefined ? {} : { soul: value.soul })
    } as AgentProfileRequest
  }

  if (value.operation !== 'avatar' || !exact(value, ['operation', 'target', 'avatar', 'request_id', 'turn_id'])) {
    return undefined
  }

  if (value.avatar === null) {
    return { operation: 'avatar', ...(selected ? { target: selected } : {}), avatar: null }
  }

  if (
    !record(value.avatar) ||
    !exact(value.avatar, ['type', 'base64']) ||
    !['image/jpeg', 'image/png', 'image/webp'].includes(String(value.avatar.type)) ||
    typeof value.avatar.base64 !== 'string' ||
    value.avatar.base64.length > Math.ceil(MATRIX_PROFILE_PHOTO_MAX_BYTES / 3) * 4 ||
    !BASE64.test(value.avatar.base64)
  ) {
    return undefined
  }

  let decoded: string
  try {
    decoded = atob(value.avatar.base64)
  } catch {
    return undefined
  }
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0))
  const type = value.avatar.type as MatrixProfilePhotoType

  if (bytes.byteLength < 1 || bytes.byteLength > MATRIX_PROFILE_PHOTO_MAX_BYTES || matrixProfilePhotoType(bytes) !== type) {
    return undefined
  }

  return { operation: 'avatar', ...(selected ? { target: selected } : {}), avatar: { type, bytes } }
}

function rosterEntry(value: unknown): AgentProfileRosterEntry | undefined {
  if (!record(value) || !exact(value, [
    'principal', 'displayName', 'isMain', 'definitionRevision', 'identityRevision', 'avatarUrl'
  ])) {
    return undefined
  }

  if (
    typeof value.principal !== 'string' ||
    !PRINCIPAL.test(value.principal) ||
    typeof value.displayName !== 'string' ||
    value.displayName.length > MAX_NAME_INPUT ||
    typeof value.isMain !== 'boolean' ||
    !revision(value.definitionRevision, 0) ||
    !revision(value.identityRevision, 1) ||
    !(value.avatarUrl === null || (typeof value.avatarUrl === 'string' && value.avatarUrl.length <= 2_048))
  ) {
    return undefined
  }

  return value as unknown as AgentProfileRosterEntry
}

/** Validate the closed platform/local result before it reaches the model. */
export function agentProfileEnvelope(
  value: unknown,
  expected?: { executorId?: string; originPrincipal?: string; targetPrincipal?: string }
): AgentProfileEnvelope | undefined {
  if (!record(value) || !exact(value, [
    'executorId', 'originPrincipal', 'originIsMain', 'agents', 'profile'
  ])) {
    return undefined
  }

  if (
    typeof value.originPrincipal !== 'string' ||
    !PRINCIPAL.test(value.originPrincipal) ||
    typeof value.originIsMain !== 'boolean' ||
    (value.executorId !== undefined && (typeof value.executorId !== 'string' || !PRINCIPAL.test(value.executorId))) ||
    (expected?.executorId !== undefined && value.executorId !== expected.executorId) ||
    (expected?.originPrincipal !== undefined && value.originPrincipal !== expected.originPrincipal)
  ) {
    return undefined
  }

  const result: AgentProfileEnvelope = {
    ...(value.executorId === undefined ? {} : { executorId: value.executorId as string }),
    originPrincipal: value.originPrincipal,
    originIsMain: value.originIsMain
  }

  if (value.agents !== undefined) {
    if (!Array.isArray(value.agents) || value.agents.length > 100) {
      return undefined
    }
    const agents = value.agents.map(rosterEntry)
    if (agents.some(agent => !agent)) {
      return undefined
    }
    result.agents = agents as AgentProfileRosterEntry[]
  }

  if (value.profile !== undefined) {
    if (!record(value.profile) || !exact(value.profile, [
      'principal', 'displayName', 'isMain', 'definitionRevision', 'identityRevision', 'avatarUrl', 'soul'
    ])) {
      return undefined
    }
    const base = rosterEntry(Object.fromEntries(Object.entries(value.profile).filter(([key]) => key !== 'soul')))
    if (!base || typeof value.profile.soul !== 'string' || new TextEncoder().encode(value.profile.soul).byteLength > MAX_SOUL_BYTES) {
      return undefined
    }
    result.profile = { ...base, soul: value.profile.soul }
    if (expected?.targetPrincipal !== undefined && result.profile.principal !== expected.targetPrincipal) {
      return undefined
    }
  }

  if ((result.agents === undefined) === (result.profile === undefined)) {
    return undefined
  }

  return result
}

/** Validate either a closed successful envelope or one of the native failure codes. */
export function agentProfileResult(
  value: unknown,
  expected?: { executorId?: string; originPrincipal?: string; targetPrincipal?: string }
): AgentProfileResult | undefined {
  if (record(value) && exact(value, ['error']) && [
    'conflict', 'denied', 'duplicate', 'invalid', 'locked', 'missing', 'offline', 'reserved', 'unavailable'
  ].includes(String(value.error))) {
    return { error: value.error as AgentProfileError }
  }

  return agentProfileEnvelope(value, expected)
}
