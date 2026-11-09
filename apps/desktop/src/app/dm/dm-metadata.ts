import { type AtumArtifactRef, parseAtumArtifactRefs } from '@/lib/atum-artifacts'

import { parseParticipantSnapshot, type ParticipantDisplay } from '../../../shared/atum-participants'

/**
 * Hosted-DM message metadata → what the bubble is allowed to say.
 *
 * The wire layer (`electron/atum-messaging/wire.ts`) already projects the
 * server's `metadata` down to the G3 allowlist of content-free keys. This module
 * is the renderer's reader for that projection: it validates the enums it
 * renders and ignores everything it does not recognise, so an old plane (no
 * metadata), a `null` metadata (the common post-G3 case), a future plane with an
 * unknown outcome label, and a malformed payload all degrade to "render nothing
 * extra" rather than to a broken bubble.
 *
 * Nothing here ever renders a free-text value from the server.
 */

/** A provider's memory outcome. Content-free by contract — an outcome, not a memory. */
export type ProviderMemoryOutcome = 'granted_empty' | 'not_authorized' | 'revoked' | 'supplied'

/** In-flight state of a specialist turn on the hosted side. */
export type SpecialistDispatchState = 'dispatched' | 'failed' | 'pending' | 'running' | 'succeeded'
export type MentionDispatchState = 'completed' | 'dead_lettered' | 'pending' | 'processing'

export interface ProviderMemoryReceipt {
  outcome: ProviderMemoryOutcome
  /** Whether memory actually fed the answer. Content-free boolean from 0043's
   *  triple; `null` when the plane omits it. */
  used: boolean | null
  /** `v` from the server triple — the projection version, currently 1. */
  v: null | number
}

export interface SpecialistDispatch {
  errorCode: null | string
  specialist: null | string
  state: SpecialistDispatchState
}

export interface MentionDispatch {
  errorCode: null | string
  /** True only when the provider echoed the exact client-authored mention identity. */
  provenanceVerified: boolean
  state: MentionDispatchState
}

export interface TargetDispatch {
  avatarUrl?: string
  avatar: string
  displayName: string
  errorCode: null | string
  state: MentionDispatchState
  targetId: string
  targetType: 'assistant' | 'specialist'
}

export interface AssistantIdentitySnapshot {
  avatarUrl?: string
  avatar: string
  displayName: string
  id: string
}

export interface DmMessageMetadata {
  providerMemory: ProviderMemoryReceipt | null
  resourceRefs: AtumArtifactRef[]
  specialistDispatch: SpecialistDispatch | null
  mentionDispatch: MentionDispatch | null
  targetDispatches: TargetDispatch[]
  assistantIdentity: AssistantIdentitySnapshot | null
  /** A server-recorded, flat participant display snapshot. */
  participant: ParticipantDisplay | null
}

const MEMORY_OUTCOMES: readonly string[] = ['granted_empty', 'not_authorized', 'revoked', 'supplied']
const DISPATCH_STATES: readonly string[] = ['dispatched', 'failed', 'pending', 'running', 'succeeded']
const MENTION_DISPATCH_STATES: readonly string[] = ['completed', 'dead_lettered', 'pending', 'processing']

/** Dispatch states that mean "the specialist has not answered yet". */
const DISPATCH_IN_FLIGHT: readonly SpecialistDispatchState[] = ['dispatched', 'pending', 'running']

function group(metadata: unknown, key: string): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null
  }

  const value = (metadata as Record<string, unknown>)[key]

  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function readEnum<T extends string>(
  source: Record<string, unknown>,
  keys: readonly string[],
  allowed: readonly string[]
): T | null {
  for (const key of keys) {
    const value = source[key]

    if (typeof value === 'string' && allowed.includes(value)) {
      return value as T
    }
  }

  return null
}

function readLabel(source: Record<string, unknown>, key: string): null | string {
  const value = source[key]

  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readVersion(source: Record<string, unknown>): null | number {
  const value = source.v

  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseLegacyAndyMemory(metadata: unknown): ProviderMemoryReceipt | null {
  const row = group(metadata, 'andy_memory')

  if (!row) {
    return null
  }

  const outcome = readEnum<ProviderMemoryOutcome>(row, ['outcome'], MEMORY_OUTCOMES)

  return outcome ? { outcome, used: typeof row.used === 'boolean' ? row.used : null, v: readVersion(row) } : null
}

/** The 0116 provider receipt is deliberately strict: it has no memory content,
 * and a future shape remains unrendered until this client understands it. */
export function parseProviderMemory(metadata: unknown): ProviderMemoryReceipt | null {
  const row = group(metadata, 'provider_memory')

  if (!row || row.v !== 1 || typeof row.used !== 'boolean') {
    return null
  }

  const outcome = readEnum<ProviderMemoryOutcome>(row, ['outcome'], MEMORY_OUTCOMES)

  return outcome ? { outcome, used: row.used, v: 1 } : null
}

type MemorySender = { id: string; type: string } | null | undefined

function hasMetadataGroup(metadata: unknown, key: string): boolean {
  return Boolean(
    metadata &&
      typeof metadata === 'object' &&
      !Array.isArray(metadata) &&
      Object.prototype.hasOwnProperty.call(metadata, key)
  )
}

function isProviderSender(sender: MemorySender): sender is { id: string; type: string } {
  return Boolean(sender && typeof sender.id === 'string' && ['agent', 'app', 'specialist'].includes(sender.type))
}

/**
 * A receipt only belongs on a provider-authored message. `provider_memory` is
 * generic; `andy_memory` stays as the narrow compatibility fallback for old
 * Andy messages. A malformed generic receipt deliberately does not fall back
 * to a second key, because its presence claims the authoritative schema.
 */
export function parseProviderMemoryForSender(metadata: unknown, sender: MemorySender): ProviderMemoryReceipt | null {
  if (!isProviderSender(sender)) {
    return null
  }

  if (hasMetadataGroup(metadata, 'provider_memory')) {
    return parseProviderMemory(metadata)
  }

  return sender.id === 'andy' ? parseLegacyAndyMemory(metadata) : null
}

export function parseSpecialistDispatch(metadata: unknown): SpecialistDispatch | null {
  const row = group(metadata, 'specialist_dispatch')

  if (!row) {
    return null
  }

  const state = readEnum<SpecialistDispatchState>(row, ['state'], DISPATCH_STATES)

  return state ? { errorCode: readLabel(row, 'error_code'), specialist: readLabel(row, 'specialist'), state } : null
}

export function parseMentionDispatch(metadata: unknown): MentionDispatch | null {
  const row = group(metadata, 'mention_dispatch')

  if (!row) {
    return null
  }

  const state = readEnum<MentionDispatchState>(row, ['state'], MENTION_DISPATCH_STATES)

  return state
    ? {
        errorCode: readLabel(row, 'error_code'),
        provenanceVerified: row.agent === 'binh-minh' && row.revision === 0,
        state
      }
    : null
}

export function parseTargetDispatches(metadata: unknown): TargetDispatch[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {return []}
  const rows = (metadata as Record<string, unknown>).target_dispatches

  if (!Array.isArray(rows) || rows.length > 8) {return []}

  return rows.flatMap(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {return []}
    const row = raw as Record<string, unknown>
    const state = readEnum<MentionDispatchState>(row, ['state'], MENTION_DISPATCH_STATES)
    const targetType = row.target_type
    const targetId = readLabel(row, 'target_id')
    const displayName = readLabel(row, 'display_name')

    return state && (targetType === 'assistant' || targetType === 'specialist') && targetId && displayName
      ? [{ targetType, targetId, displayName, ...photoProjection(row), avatar: readLabel(row, 'avatar') ?? '', errorCode: readLabel(row, 'error_code'), state }]
      : []
  })
}

function photoProjection(row: Record<string, unknown>): { avatarUrl?: string } {
  const value = row.avatar_url

  if (typeof value !== 'string' || value.length > 2048) {return {}}

  try {
    const url = new URL(value)

    return url.protocol === 'https:' && !url.username && !url.password ? { avatarUrl: value } : {}
  } catch { return {} }
}

export function parseAssistantIdentity(metadata: unknown): AssistantIdentitySnapshot | null {
  const row = group(metadata, 'assistant_identity')
  const id = row ? readLabel(row, 'id') : null
  const displayName = row ? readLabel(row, 'display_name') : null

  return id && displayName ? { id, displayName, ...photoProjection(row!), avatar: readLabel(row!, 'avatar') ?? '' } : null
}

/**
 * The complete `participant` group is authoritative for historical
 * attribution. It intentionally never borrows a name, owner, or photo from a
 * legacy identity group when any part of this group is malformed.
 */
export function parseParticipantIdentity(metadata: unknown): ParticipantDisplay | null {
  return parseParticipantSnapshot(group(metadata, 'participant'))
}

/** Never throws. Returns null when there is nothing renderable. */
export function parseDmMetadata(metadata: unknown, sender?: MemorySender): DmMessageMetadata | null {
  const providerMemory = parseProviderMemoryForSender(metadata, sender)
  const specialistDispatch = parseSpecialistDispatch(metadata)
  const mentionDispatch = parseMentionDispatch(metadata)
  const targetDispatches = parseTargetDispatches(metadata)
  const assistantIdentity = parseAssistantIdentity(metadata)
  const participant = parseParticipantIdentity(metadata)

  const resourceRefs =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? parseAtumArtifactRefs((metadata as Record<string, unknown>).resource_refs)
      : []

  return providerMemory || specialistDispatch || mentionDispatch || targetDispatches.length > 0 || assistantIdentity || participant || resourceRefs.length > 0
    ? { providerMemory, mentionDispatch, targetDispatches, assistantIdentity, participant, resourceRefs, specialistDispatch }
    : null
}

export function isSpecialistPending(dispatch: SpecialistDispatch | null): boolean {
  return Boolean(dispatch && DISPATCH_IN_FLIGHT.includes(dispatch.state))
}
