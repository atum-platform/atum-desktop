import { parseAtumAssistantDefinitionSnapshot } from '../../shared/atum-agent-portability'
import type { GroupCapabilities } from '../../shared/atum-group-conversations'

import { parseGroupCapabilities, parseGroupRoom } from './group-wire'
import type {
  AssistantRegistrationResult,
  CanonicalMessage,
  MessagingConversation,
  MessagingRealtimeAdvertisement,
  MessagingUser,
  RegisteredAssistant,
  ResolvedArtifact
} from './types'

export interface DesktopErrorBody {
  error: {
    code: string
    message_key: string
    retryable: boolean
    request_id: string
    retry_after_ms?: number
    details?: Record<string, unknown>
  }
}

export interface DesktopSessionBody {
  groupCapabilities?: GroupCapabilities
  user: MessagingUser
  syncCursor: string | null
  serverTime: string
  realtime: MessagingRealtimeAdvertisement
}

export interface CreateConversationBody {
  conversationId: string
  replayed: boolean
  specialist: string
}

export interface SyncChange {
  changeId: string
  entity: 'conversation' | 'participant' | 'message' | 'reaction' | 'read_state' | 'attachment' | 'membership_event'
  operation: 'upsert' | 'delete'
  entityId: string
  conversationId: string | null
  value: Record<string, unknown> | null
  occurredAt: string
}

export interface SyncPage {
  changes: SyncChange[]
  nextCursor: string
  hasMore: boolean
  serverTime: string
}

const MAX_OPAQUE_SYNC_TOKEN_LENGTH = 8_192

function opaqueSyncToken(value: unknown, label: string): string {
  const parsed = string(value, label)

  if (parsed.length > MAX_OPAQUE_SYNC_TOKEN_LENGTH) {
    throw new Error(`invalid_response:${label}`)
  }

  return parsed
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid_response:${label}`)
  }

  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`invalid_response:${label}`)
  }

  return value
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : string(value, label)
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`invalid_response:${label}`)
  }

  return value
}

export function parseCreateConversation(value: unknown): CreateConversationBody {
  const body = object(value, 'create_conversation')
  const conversation = object(body.conversation, 'create_conversation.conversation')
  const conversationId = string(conversation.id, 'create_conversation.conversation.id')

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(conversationId)) {
    throw new Error('invalid_response:create_conversation.conversation.id')
  }

  if (typeof body.replayed !== 'boolean') {
    throw new Error('invalid_response:create_conversation.replayed')
  }

  return {
    conversationId,
    replayed: body.replayed,
    specialist: string(conversation.specialist, 'create_conversation.conversation.specialist')
  }
}

/**
 * Message metadata is an allowlist, not a passthrough.
 *
 * Mirrors the server contract landed with G3: `desktop_message_json` always
 * carries a `metadata` key whose value is either JSON null (the common case) or
 * an object holding only these sub-objects, each key-allowlisted server-side —
 *
 *   specialist_dispatch: { state, specialist, error_code? }
 *   specialist_identity: { specialist, display_name, avatar }
 *   quoted_message:      { message_id, source_version }
 *   andy_memory:         { v, outcome, used }   // old Andy content-free triple
 *   provider_memory:     { v, outcome, used }   // 0116 generic content-free triple
 *   agent_session:       { session_id, request_id, state }
 *
 * — flowing identically through send, list, search, and sync. The server strips
 * job ids, attempts, and transport detail, and refuses non-object values under
 * those keys.
 *
 * This projection is still closed rather than trusting: only these groups
 * survive, only these members inside them, only string / number / boolean
 * within a bounded length. A group that projects to nothing is dropped; a block
 * that projects to nothing becomes `null`. That keeps a content-free contract
 * content-free even if the plane ever sends more than it promised.
 */
const METADATA_KEY_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  agent_session: ['request_id', 'session_id', 'state'],
  andy_memory: ['outcome', 'used', 'v'],
  provider_memory: ['outcome', 'used', 'v'],
  specialist_dispatch: ['error_code', 'specialist', 'state'],
  specialist_identity: ['avatar', 'display_name', 'revision', 'specialist'],
  quoted_message: ['message_id', 'source_version'],
  mention_dispatch: ['agent', 'error_code', 'job_id', 'reply_id', 'revision', 'state'],
  assistant_identity: ['avatar', 'avatar_url', 'display_name', 'id', 'owner_user_id', 'revision'],
  participant: ['kind', 'id', 'display_name', 'avatar_url', 'owner_user_id', 'owner_display_name']
}

const MAX_METADATA_VALUE_LENGTH = 256
export const ASSISTANT_AVATAR_URL_MAX_LENGTH = 2048

/** A hosted projection may name only a bounded HTTPS public object. */
export function parseOptionalAssistantAvatarUrl(value: unknown, path: string): string | null {
  if (value === undefined || value === null) {
    return null
  }

  if (typeof value !== 'string' || value.length > ASSISTANT_AVATAR_URL_MAX_LENGTH) {
    throw new Error(`invalid_response:${path}`)
  }

  try {
    if (new URL(value).protocol === 'https:') {
      return value
    }
  } catch {
    // Fall through to the shared malformed-response shape.
  }

  throw new Error(`invalid_response:${path}`)
}

function projectAssistantAvatarUrl(value: unknown): string | null {
  try {
    return parseOptionalAssistantAvatarUrl(value, 'metadata.avatar_url')
  } catch {
    return null
  }
}

function metadataScalar(value: unknown): string | number | boolean | null {
  if (typeof value === 'string') {
    return value.length <= MAX_METADATA_VALUE_LENGTH ? value : null
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  return typeof value === 'boolean' ? value : null
}

/** Projects a raw `metadata` field down to the allowlist. Never throws — a
 *  malformed block is indistinguishable from an absent one to every caller. */
export function parseMessageMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const projected: Record<string, unknown> = {}

  for (const [group, allowedKeys] of Object.entries(METADATA_KEY_ALLOWLIST)) {
    const raw = (value as Record<string, unknown>)[group]

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue
    }

    const members: Record<string, unknown> = {}

    for (const key of allowedKeys) {
      const scalar =
        key === 'avatar_url'
          ? projectAssistantAvatarUrl((raw as Record<string, unknown>)[key])
          : metadataScalar((raw as Record<string, unknown>)[key])

      if (scalar !== null) {
        members[key] = scalar
      }
    }

    if (Object.keys(members).length > 0) {
      projected[group] = members
    }
  }

  const dispatches = (value as Record<string, unknown>).target_dispatches

  if (Array.isArray(dispatches) && dispatches.length <= 8) {
    const rows = dispatches.flatMap(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return []
      }

      const row = raw as Record<string, unknown>
      const targetType = row.target_type
      const state = row.state

      if (
        (targetType !== 'assistant' && targetType !== 'specialist') ||
        !['pending', 'processing', 'completed', 'dead_lettered'].includes(String(state))
      ) {
        return []
      }

      const result: Record<string, unknown> = { target_type: targetType, state }

      for (const key of [
        'target_id',
        'display_name',
        'avatar',
        'avatar_url',
        'revision',
        'job_id',
        'error_code',
        'reply_id'
      ]) {
        const scalar = key === 'avatar_url' ? projectAssistantAvatarUrl(row[key]) : metadataScalar(row[key])

        if (scalar !== null) {
          result[key] = scalar
        }
      }

      return Object.keys(result).length > 2 ? [result] : []
    })

    if (rows.length > 0) {
      projected.target_dispatches = rows
    }
  }

  const resourceRefs = parseResourceRefs((value as Record<string, unknown>).resource_refs)

  if (resourceRefs) {
    projected.resource_refs = resourceRefs
  }

  return Object.keys(projected).length > 0 ? projected : null
}

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const RESOURCE_REF_KEYS = new Set(['kind', 'resource_id', 'type', 'title', 'status', 'presentation'])

function parseResourceRefs(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value) || value.length > 16) {
    return null
  }

  const result: Record<string, unknown>[] = []
  const seen = new Set<string>()

  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null
    }

    const row = entry as Record<string, unknown>
    const keys = Object.keys(row)

    if (keys.length < 5 || keys.length > 6 || keys.some(key => !RESOURCE_REF_KEYS.has(key))) {
      return null
    }

    if (
      row.kind !== 'artifact' ||
      typeof row.resource_id !== 'string' ||
      !RESOURCE_ID_PATTERN.test(row.resource_id) ||
      seen.has(row.resource_id) ||
      typeof row.type !== 'string' ||
      row.type.length < 1 ||
      row.type.length > 100 ||
      typeof row.title !== 'string' ||
      row.title.length < 1 ||
      row.title.length > 500 ||
      (row.status !== 'generating' && row.status !== 'ready') ||
      (row.presentation !== undefined &&
        (!row.presentation ||
          typeof row.presentation !== 'object' ||
          Array.isArray(row.presentation) ||
          Object.keys(row.presentation).length !== 1 ||
          (row.presentation as Record<string, unknown>).intent !== 'open'))
    ) {
      return null
    }

    seen.add(row.resource_id)
    result.push({
      kind: 'artifact',
      resource_id: row.resource_id,
      type: row.type,
      title: row.title,
      status: row.status,
      ...(row.presentation === undefined ? {} : { presentation: { intent: 'open' } })
    })
  }

  return result
}

function httpUrl(value: unknown, label: string): string {
  const parsed = string(value, label)
  let url: URL

  try {
    url = new URL(parsed)
  } catch {
    throw new Error(`invalid_response:${label}`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`invalid_response:${label}`)
  }

  return url.toString()
}

export function parseArtifactResponse(value: unknown): ResolvedArtifact {
  const root = object(value, 'artifact_response')
  const artifact = object(root.artifact, 'artifact')
  const artifactId = string(artifact.artifact_id, 'artifact.artifact_id')
  const status = artifact.status

  if (status !== 'generating' && status !== 'ready') {
    throw new Error('invalid_response:artifact.status')
  }

  let embed: ResolvedArtifact['embed']

  if (artifact.embed !== undefined) {
    const row = object(artifact.embed, 'artifact.embed')
    const kind = row.kind === 'chart' || row.kind === 'reading' ? 'interactive_view' : row.kind

    if (!['interactive_view', 'document', 'image', 'file'].includes(String(kind))) {
      throw new Error('invalid_response:artifact.embed.kind')
    }

    embed = {
      url: httpUrl(row.url, 'artifact.embed.url'),
      kind: kind as ResolvedArtifact['embed']['kind'],
      expiresAt: string(row.expires_at, 'artifact.embed.expires_at')
    }
  }

  return {
    artifactId,
    type: string(artifact.type, 'artifact.type'),
    title: string(artifact.title, 'artifact.title'),
    url: httpUrl(artifact.url, 'artifact.url'),
    status,
    ...(embed ? { embed } : {})
  }
}

export function parseDesktopError(value: unknown): DesktopErrorBody | null {
  try {
    const root = object(value, 'error_envelope')
    const error = object(root.error, 'error')

    if (
      typeof error.code !== 'string' ||
      typeof error.message_key !== 'string' ||
      typeof error.retryable !== 'boolean' ||
      typeof error.request_id !== 'string'
    ) {
      return null
    }

    if (
      error.retry_after_ms !== undefined &&
      (typeof error.retry_after_ms !== 'number' || !Number.isFinite(error.retry_after_ms))
    ) {
      return null
    }

    return { error: error as DesktopErrorBody['error'] }
  } catch {
    return null
  }
}

/**
 * The hosted user block (`atum.desktop-identity/1`). The three profile fields
 * are additive: a plane that omits them yields `null`, never a guess, so the
 * renderer can tell "not customized" from "the plane did not say".
 */
export function parseDesktopUser(value: unknown, label = 'session.user'): MessagingUser {
  const user = object(value, label)

  const optionalString = (field: string): string | null =>
    user[field] === undefined || user[field] === null ? null : string(user[field], `${label}.${field}`)

  if (
    user.handle_customized !== undefined &&
    user.handle_customized !== null &&
    typeof user.handle_customized !== 'boolean'
  ) {
    throw new Error(`invalid_response:${label}.handle_customized`)
  }

  return {
    id: string(user.id, `${label}.id`),
    displayName: optionalString('display_name'),
    handle: optionalString('handle'),
    avatarUrl: optionalString('avatar_url'),
    handleCustomized: typeof user.handle_customized === 'boolean' ? user.handle_customized : null,
    nextHandleChangeAt: optionalString('next_handle_change_at')
  }
}

/** `{ user }` — the body of every identity mutation. */
export function parseRegisteredAssistant(value: unknown, path: string): RegisteredAssistant {
  const row = object(value, path)
  const status = row.status === 'retired' ? 'retired' : row.status === 'active' ? 'active' : null

  if (!status) {
    throw new Error(`invalid_response:${path}.status`)
  }

  return {
    id: string(row.id, `${path}.id`),
    identityId:
      row.identity_id === null || row.identity_id === undefined ? null : string(row.identity_id, `${path}.identity_id`),
    displayName: string(row.display_name, `${path}.display_name`),
    ...(row.avatar_url === undefined
      ? {}
      : { avatarUrl: parseOptionalAssistantAvatarUrl(row.avatar_url, `${path}.avatar_url`) }),
    avatar: typeof row.avatar === 'string' ? row.avatar : '',
    isDefault: row.is_default === true,
    lifecycleRevision: typeof row.lifecycle_revision === 'number' ? row.lifecycle_revision : 0,
    identityRevision:
      typeof row.identity_revision === 'number' &&
      Number.isSafeInteger(row.identity_revision) &&
      row.identity_revision >= 1
        ? row.identity_revision
        : 1,
    definitionRevision:
      typeof row.definition_revision === 'number' &&
      Number.isSafeInteger(row.definition_revision) &&
      row.definition_revision >= 0
        ? row.definition_revision
        : 0,
    status
  }
}

/** The definition endpoint is private and owner-scoped; retain only its allowlisted snapshot. */
export { parseAtumAssistantDefinitionSnapshot }

export function parseAssistantRegistrationResult(value: unknown): AssistantRegistrationResult {
  const root = object(value, 'assistant_registration')
  const outcome = root.outcome

  if (outcome !== 'registered' && outcome !== 'stale' && outcome !== 'adopt') {
    throw new Error('invalid_response:assistant_registration.outcome')
  }

  const assistant = parseRegisteredAssistant(root.assistant, 'assistant_registration.assistant')

  // An adopt result tells this device to replace its default profile identity.
  // A missing identity is therefore not an old-plane compatibility shape: it
  // is malformed authority that must never be mistaken for an adoption.
  if (outcome === 'adopt' && !assistant.identityId) {
    throw new Error('invalid_response:assistant_registration.assistant.identity_id')
  }

  return { outcome, assistant }
}

export function parseAssistantRetirement(value: unknown): { outcome: string; lifecycleRevision: number } {
  const body = object(value, 'assistant_retirement')

  return {
    outcome: string(body.outcome, 'assistant_retirement.outcome'),
    lifecycleRevision: typeof body.lifecycle_revision === 'number' ? body.lifecycle_revision : 0
  }
}

export function parseAssistantList(value: unknown): RegisteredAssistant[] {
  const root = object(value, 'assistants')
  const rows = Array.isArray(root.assistants) ? root.assistants : null

  if (!rows) {
    throw new Error('invalid_response:assistants.assistants')
  }

  return rows.map((row, index) => parseRegisteredAssistant(row, `assistants.assistants[${index}]`))
}

export function parseIdentityUserResponse(value: unknown): MessagingUser {
  return parseDesktopUser(object(value, 'identity').user, 'identity.user')
}

export function parseDesktopSession(value: unknown): DesktopSessionBody {
  const root = object(value, 'session')
  const realtime = object(root.realtime, 'session.realtime')

  if (realtime.transport !== 'supabase_private_broadcast') {
    throw new Error('invalid_response:session.realtime.transport')
  }

  return {
    ...(root.group_conversations === undefined
      ? {}
      : {
          groupCapabilities: parseGroupCapabilities(
            root.group_conversations,
            root.group_addressing,
            root.private_advisory,
            root.shared_group_agents
          )
        }),
    user: parseDesktopUser(root.user),
    syncCursor: root.sync_cursor === null ? null : string(root.sync_cursor, 'session.sync_cursor'),
    serverTime: string(root.server_time, 'session.server_time'),
    realtime: {
      transport: realtime.transport,
      topic: string(realtime.topic, 'session.realtime.topic'),
      event: string(realtime.event, 'session.realtime.event')
    }
  }
}

export function parseConversation(value: unknown): Omit<MessagingConversation, 'unreadCount'> {
  const row = object(value, 'conversation')

  const kind =
    row.kind === undefined
      ? typeof row.specialist === 'string' && row.specialist
        ? 'specialist'
        : 'direct'
      : row.kind === 'direct' || row.kind === 'specialist' || row.kind === 'group'
        ? row.kind
        : 'unsupported'

  const id = string(row.id, 'conversation.id')
  const group = kind === 'group' ? parseGroupRoom(row.group, id) : undefined

  const participants = array(kind === 'unsupported' ? [] : row.participants, 'conversation.participants').map(
    (participant, index) => {
      const projected = object(participant, `conversation.participants.${index}`)

      return string(projected.id, `conversation.participants.${index}.id`)
    }
  )

  const updatedAt = string(row.updated_at, 'conversation.updated_at')

  return {
    id,
    title: group?.title ?? (typeof row.specialist === 'string' ? row.specialist : null),
    kind,
    ...(group ? { group } : {}),
    participantIds: participants,
    updatedAt,
    lastMessageAt: updatedAt,
    payload: kind === 'unsupported' ? { kind: row.kind } : row
  }
}

export function parseCanonicalMessage(value: unknown): CanonicalMessage {
  const row = object(value, 'message')
  const sender = object(row.sender, 'message.sender')

  const version = Number(row.version)

  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error('invalid_response:message.version')
  }

  return {
    id: string(row.id, 'message.id'),
    conversationId: string(row.conversation_id, 'message.conversation_id'),
    sender: { type: string(sender.type, 'message.sender.type'), id: string(sender.id, 'message.sender.id') },
    content: typeof row.content === 'string' ? row.content : '',
    kind: string(row.kind, 'message.kind'),
    attachments: array(row.attachments, 'message.attachments'),
    // Post-G3 the key is always present and is either JSON null or the object
    // above. The old plane omits it entirely during the transition. Both, and
    // anything malformed, land on `null` — a message is never rejected over its
    // metadata.
    metadata: parseMessageMetadata({
      ...(row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {}),
      ...(row.assistant_identity === undefined ? {} : { assistant_identity: row.assistant_identity })
    }),
    replyToMessageId: nullableString(row.reply_to_message_id, 'message.reply_to_message_id'),
    forwardedFrom: row.forwarded_from ?? null,
    reactions: array(row.reactions, 'message.reactions'),
    version,
    createdAt: string(row.created_at, 'message.created_at'),
    editedAt: nullableString(row.edited_at, 'message.edited_at'),
    recalledAt: nullableString(row.recalled_at, 'message.recalled_at'),
    delivery: string(row.delivery, 'message.delivery')
  }
}

export function parseSyncPage(value: unknown): SyncPage {
  const root = object(value, 'sync')
  const nextCursor = opaqueSyncToken(root.next_cursor, 'sync.next_cursor')

  const changes = array(root.changes, 'sync.changes').map((value, index): SyncChange => {
    const row = object(value, `sync.changes.${index}`)
    const entity = string(row.entity, `sync.changes.${index}.entity`) as SyncChange['entity']
    const operation = string(row.operation, `sync.changes.${index}.operation`) as SyncChange['operation']

    if (
      !['conversation', 'participant', 'message', 'reaction', 'read_state', 'attachment', 'membership_event'].includes(
        entity
      )
    ) {
      throw new Error(`invalid_response:sync.changes.${index}.entity`)
    }

    if (operation !== 'upsert' && operation !== 'delete') {
      throw new Error(`invalid_response:sync.changes.${index}.operation`)
    }

    return {
      changeId: opaqueSyncToken(row.change_id, `sync.changes.${index}.change_id`),
      entity,
      operation,
      entityId: string(row.entity_id, `sync.changes.${index}.entity_id`),
      conversationId:
        row.conversation_id === null ? null : string(row.conversation_id, `sync.changes.${index}.conversation_id`),
      value: row.value === null ? null : object(row.value, `sync.changes.${index}.value`),
      occurredAt: string(row.occurred_at, `sync.changes.${index}.occurred_at`)
    }
  })

  if (typeof root.has_more !== 'boolean') {
    throw new Error('invalid_response:sync.has_more')
  }

  return { changes, nextCursor, hasMore: root.has_more, serverTime: string(root.server_time, 'sync.server_time') }
}

export function parseConversationPage(value: unknown): {
  conversations: ReturnType<typeof parseConversation>[]
  nextCursor?: string | null
  hasMore?: boolean
} {
  const root = object(value, 'conversations')

  const conversations = array(root.conversations, 'conversations.rows').map(parseConversation)

  if (root.has_more === undefined) {
    return { conversations }
  }

  if (typeof root.has_more !== 'boolean') {
    throw new Error('invalid_response:conversations.has_more')
  }

  const nextCursor = root.next_cursor == null ? null : opaqueSyncToken(root.next_cursor, 'conversations.next_cursor')

  if (root.has_more && !nextCursor) {
    throw new Error('invalid_response:conversations.next_cursor')
  }

  return { conversations, nextCursor, hasMore: root.has_more }
}

export function parseMessagePage(value: unknown): {
  messages: CanonicalMessage[]
  nextCursor: string | null
  hasMore: boolean
} {
  const root = object(value, 'messages')

  if (typeof root.has_more !== 'boolean') {
    throw new Error('invalid_response:messages.has_more')
  }

  return {
    messages: array(root.messages, 'messages.rows').map(parseCanonicalMessage),
    nextCursor: root.next_cursor === null ? null : opaqueSyncToken(root.next_cursor, 'messages.next_cursor'),
    hasMore: root.has_more
  }
}

export function parseSendResponse(value: unknown): { message: CanonicalMessage } {
  const root = object(value, 'send')

  return { message: parseCanonicalMessage(root.message) }
}
