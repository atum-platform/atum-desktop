import type { AdvisorTarget, GroupOperationInput, GroupReportReason } from '../../shared/atum-group-conversations'

import { MessagingTransportError } from './transport-error'
import type { AssistantRegistration, MessagingClientBoundary } from './types'
import { ADDRESSED_MENTIONS_CONTRACT, ATUM_AVATAR_CONTENT_TYPES } from './types'

interface IpcMainLike {
  handle(channel: string, listener: (_event: unknown, ...args: any[]) => unknown): void
  removeHandler?(channel: string): void
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 256) {
    throw new Error(`${name} must be a non-empty identifier`)
  }

  return value
}

const OPAQUE_RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

function opaqueResourceId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !OPAQUE_RESOURCE_ID.test(value)) {
    throw new Error(`${name} must be an opaque resource identifier`)
  }

  return value
}

function specialistId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error('specialist must be a lowercase app identifier')
  }

  return value
}

function handle(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{2,31}$/.test(value)) {
    throw new Error('handle is invalid')
  }

  return value
}

/** Display name: 1–80 visible characters, trimmed here so the plane and the
 *  roster agree on the bytes. Not a handle — diacritics and spaces are fine. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    throw new Error(`${name} must be a UUID v4`)
  }

  return value
}

function identityId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    throw new Error('identityId must be a UUID v4')
  }

  return value
}

/** The registration the renderer sends: validated to the same bounds the plane enforces. */
function assistantRegistration(value: unknown): AssistantRegistration {
  const input = record(value, 'assistant')
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : ''
  const avatar = typeof input.avatar === 'string' ? input.avatar.trim() : ''

  const printable = (text: string) =>
    !Array.from(text).some(character => {
      const code = character.codePointAt(0) ?? 0

      return code < 0x20 || code === 0x7f
    })

  if (!displayName || displayName.length > 40 || !printable(displayName)) {
    throw new Error('displayName must be 1 to 40 printable characters')
  }

  if (avatar.length > 16 || /[/\\:]/.test(avatar) || avatar.startsWith('.') || !printable(avatar)) {
    throw new Error('avatar must be a short symbol')
  }

  if (typeof input.isDefault !== 'boolean') {
    throw new Error('isDefault must be a boolean')
  }

  if (!Number.isSafeInteger(input.lifecycleRevision) || Number(input.lifecycleRevision) < 1) {
    throw new Error('lifecycleRevision must be a positive integer')
  }

  return {
    identityId: identityId(input.identityId),
    displayName,
    avatar,
    isDefault: input.isDefault,
    lifecycleRevision: Number(input.lifecycleRevision)
  }
}

function profileUpdate(value: unknown): { displayName: string } {
  const input = record(value, 'profile')
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : ''

  const hasControlCharacter = Array.from(displayName).some(character => {
    const code = character.codePointAt(0) ?? 0

    return code < 0x20 || code === 0x7f
  })

  if (!displayName || displayName.length > 80 || hasControlCharacter) {
    throw new Error('displayName must be 1 to 80 printable characters')
  }

  return { displayName }
}

function avatarUpload(value: unknown): { contentType: string } {
  const input = record(value, 'avatar')

  if (
    typeof input.contentType !== 'string' ||
    !(ATUM_AVATAR_CONTENT_TYPES as readonly string[]).includes(input.contentType)
  ) {
    throw new Error('avatar contentType must be image/jpeg, image/png, or image/webp')
  }

  return { contentType: input.contentType }
}

function assistantAvatarId(value: unknown, label: 'assistantId' | 'uploadId'): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error(`${label} must be a UUID`)
  }

  return value
}

function searchQuery(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 64) {
    throw new Error('search query is invalid')
  }

  return value.trim()
}

function socialAction(value: unknown): 'request' | 'accept' | 'decline' | 'block' | 'unblock' {
  if (!['request', 'accept', 'decline', 'block', 'unblock'].includes(String(value))) {
    throw new Error('social action is invalid')
  }

  return value as 'request' | 'accept' | 'decline' | 'block' | 'unblock'
}

function boundedLimit(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined
  }

  const parsed = Number(value)

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error('limit must be an integer from 1 to 500')
  }

  return parsed
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }

  return value as Record<string, unknown>
}

function exactKeys(input: Record<string, unknown>, name: string, expected: readonly string[]): void {
  const actual = Object.keys(input)

  if (actual.length !== expected.length || actual.some(key => !expected.includes(key))) {
    throw new Error(`${name} contains unsupported fields`)
  }
}

function optionalExactKeys(
  input: Record<string, unknown>,
  name: string,
  required: readonly string[],
  optional: string
): void {
  const actual = Object.keys(input)
  const accepted = new Set([...required, optional])

  if (
    actual.length < required.length ||
    actual.length > required.length + 1 ||
    required.some(key => !Object.prototype.hasOwnProperty.call(input, key)) ||
    actual.some(key => !accepted.has(key))
  ) {
    throw new Error(`${name} contains unsupported fields`)
  }
}

function allowedKeys(
  input: Record<string, unknown>,
  name: string,
  required: readonly string[],
  optional: readonly string[]
): void {
  const accepted = new Set([...required, ...optional])

  if (
    required.some(key => !Object.prototype.hasOwnProperty.call(input, key)) ||
    Object.keys(input).some(key => !accepted.has(key))
  ) {
    throw new Error(`${name} contains unsupported fields`)
  }
}

function groupTitle(value: unknown, allowEmpty = false): string {
  if (allowEmpty && value == null) {
    return ''
  }

  if (typeof value !== 'string') {
    throw new Error('group title must be 1 to 80 characters')
  }

  const title = value.trim()

  if ((!allowEmpty && Array.from(title).length < 1) || Array.from(title).length > 80) {
    throw new Error('group title must be 1 to 80 characters')
  }

  return title
}

function groupMemberIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 31) {
    throw new Error('group memberUserIds must contain 1 to 31 UUIDs')
  }

  const memberUserIds = value.map((memberId, index) => uuid(memberId, `memberUserIds.${index}`))

  if (new Set(memberUserIds).size !== memberUserIds.length) {
    throw new Error('group memberUserIds must be unique')
  }

  return memberUserIds
}

function advisorTarget(value: unknown): AdvisorTarget {
  const target = record(value, 'advisor target')
  exactKeys(target, 'advisor target', ['type', 'id'])

  if (target.type !== 'specialist' && target.type !== 'assistant') {
    throw new Error('advisor target type is invalid')
  }

  return {
    type: target.type,
    id: target.type === 'assistant' ? uuid(target.id, 'advisor.id') : specialistId(target.id)
  }
}

function groupSpecialistIds(value: unknown, name = 'group specialistIds'): string[] {
  if (!Array.isArray(value) || value.length > 4) {
    throw new Error(`${name} must contain at most 4 specialists`)
  }

  const specialists = value.map((entry, index) => specialistId(entry))

  if (new Set(specialists).size !== specialists.length) {
    throw new Error(`${name} must be unique`)
  }

  return specialists
}

function groupAssistantIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 4) {
    throw new Error('group assistantIds must contain at most 4 assistant IDs')
  }

  const assistantIds = value.map((entry, index) => uuid(entry, `assistantIds.${index}`))

  if (new Set(assistantIds).size !== assistantIds.length) {
    throw new Error('group assistantIds must be unique')
  }

  return assistantIds
}

function groupReportReason(value: unknown): GroupReportReason {
  if (value !== 'harassment' && value !== 'spam' && value !== 'unsafe' && value !== 'other') {
    throw new Error('group report reason is invalid')
  }

  return value
}

function groupReportNote(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string' || Array.from(value).length > 2_000) {
    throw new Error('group report note must be at most 2000 characters')
  }

  const note = value.trim()

  return note || undefined
}

/**
 * The renderer can ask for an operation, never describe its authority. Rebuild
 * the discriminated union from a closed key set so actor, room revision, and
 * server-only fields cannot be smuggled through a future transport change.
 */
export function groupOperationInput(value: unknown): GroupOperationInput {
  const input = record(value, 'group operation')
  const action = input.action

  if (action === 'create') {
    if (input.reuseExisting !== undefined && input.reuseExisting !== true) {
      throw new Error('invalid group creation behavior')
    }

    const defaults = input.reuseExisting === true ? { reuseExisting: true as const } : {}

    if (input.contextMode === 'private_advisory') {
      allowedKeys(
        input,
        'advisory create',
        ['action', 'title', 'memberUserIds', 'contextMode', 'advisors', 'clientOperationId'],
        ['reuseExisting']
      )

      if (
        !Array.isArray(input.memberUserIds) ||
        input.memberUserIds.length !== 0 ||
        !Array.isArray(input.advisors) ||
        input.advisors.length < 1 ||
        input.advisors.length > 8
      ) {
        throw new Error('advisory creation requires 1 to 8 advisors and no human invitees')
      }

      const advisors = input.advisors.map(advisorTarget)

      if (new Set(advisors.map(target => `${target.type}:${target.id}`)).size !== advisors.length) {
        throw new Error('advisors must be unique')
      }

      return {
        action,
        contextMode: 'private_advisory',
        ...defaults,
        title: groupTitle(input.title, input.reuseExisting === true),
        memberUserIds: [],
        advisors,
        clientOperationId: uuid(input.clientOperationId, 'clientOperationId')
      }
    }

    if (input.contextMode === 'shared_group') {
      const required = ['action', 'title', 'memberUserIds', 'contextMode', 'clientOperationId']
      allowedKeys(input, 'shared group create', required, ['specialistIds', 'assistantIds', 'reuseExisting'])

      return {
        action,
        contextMode: 'shared_group',
        ...defaults,
        title: groupTitle(input.title, input.reuseExisting === true),
        memberUserIds: groupMemberIds(input.memberUserIds),
        clientOperationId: uuid(input.clientOperationId, 'clientOperationId'),
        ...(input.specialistIds === undefined ? {} : { specialistIds: groupSpecialistIds(input.specialistIds) }),
        ...(input.assistantIds === undefined ? {} : { assistantIds: groupAssistantIds(input.assistantIds) })
      }
    }

    allowedKeys(
      input,
      'group create',
      ['action', 'title', 'memberUserIds', 'clientOperationId'],
      ['specialistIds', 'reuseExisting']
    )

    return {
      action,
      ...defaults,
      title: groupTitle(input.title, input.reuseExisting === true),
      memberUserIds: groupMemberIds(input.memberUserIds),
      clientOperationId: uuid(input.clientOperationId, 'clientOperationId'),
      ...(input.specialistIds === undefined ? {} : { specialistIds: groupSpecialistIds(input.specialistIds) })
    }
  }

  if (action === 'stop_advisory' || action === 'continue_advisory') {
    exactKeys(input, action, ['action', 'conversationId', 'roundId', 'audienceRevision', 'clientOperationId'])

    if (!Number.isSafeInteger(input.audienceRevision) || Number(input.audienceRevision) < 1) {
      throw new Error('audienceRevision must be a positive integer')
    }

    return {
      action,
      conversationId: uuid(input.conversationId, 'conversationId'),
      roundId: uuid(input.roundId, 'roundId'),
      audienceRevision: Number(input.audienceRevision),
      clientOperationId: uuid(input.clientOperationId, 'clientOperationId')
    }
  }

  if (action === 'add_advisor' || action === 'remove_advisor') {
    exactKeys(input, action, ['action', 'conversationId', 'target', 'audienceRevision', 'clientOperationId'])

    if (!Number.isSafeInteger(input.audienceRevision) || Number(input.audienceRevision) < 1) {
      throw new Error('audienceRevision must be a positive integer')
    }

    return {
      action,
      conversationId: uuid(input.conversationId, 'conversationId'),
      target: advisorTarget(input.target),
      audienceRevision: Number(input.audienceRevision),
      clientOperationId: uuid(input.clientOperationId, 'clientOperationId')
    }
  }

  if (action === 'add_member' || action === 'remove_member' || action === 'transfer_owner') {
    exactKeys(input, `group ${action}`, ['action', 'conversationId', 'targetUserId', 'clientOperationId'])

    return {
      action,
      conversationId: uuid(input.conversationId, 'conversationId'),
      targetUserId: uuid(input.targetUserId, 'targetUserId'),
      clientOperationId: uuid(input.clientOperationId, 'clientOperationId')
    }
  }

  if (action === 'leave' || action === 'retire') {
    exactKeys(input, `group ${action}`, ['action', 'conversationId', 'clientOperationId'])

    return {
      action,
      conversationId: uuid(input.conversationId, 'conversationId'),
      clientOperationId: uuid(input.clientOperationId, 'clientOperationId')
    }
  }

  if (action === 'add_specialist' || action === 'remove_specialist') {
    exactKeys(input, `group ${action}`, ['action', 'conversationId', 'specialist', 'clientOperationId'])

    return {
      action,
      conversationId: uuid(input.conversationId, 'conversationId'),
      specialist: specialistId(input.specialist),
      clientOperationId: uuid(input.clientOperationId, 'clientOperationId')
    }
  }

  if (action === 'add_assistant' || action === 'remove_assistant') {
    exactKeys(input, `group ${action}`, ['action', 'conversationId', 'assistantId', 'clientOperationId'])

    return {
      action,
      conversationId: uuid(input.conversationId, 'conversationId'),
      assistantId: uuid(input.assistantId, 'assistantId'),
      clientOperationId: uuid(input.clientOperationId, 'clientOperationId')
    }
  }

  if (action === 'rename') {
    exactKeys(input, 'group rename', ['action', 'conversationId', 'title', 'clientOperationId'])

    return {
      action,
      conversationId: uuid(input.conversationId, 'conversationId'),
      title: groupTitle(input.title),
      clientOperationId: uuid(input.clientOperationId, 'clientOperationId')
    }
  }

  if (action === 'report') {
    const required = ['action', 'conversationId', 'reason', 'clientOperationId']

    const targetKeys = ['memberUserId', 'memberSpecialist', 'memberAssistant', 'messageId'].filter(key =>
      Object.prototype.hasOwnProperty.call(input, key)
    )

    const [targetKey] = targetKeys

    if (targetKey === undefined || targetKeys.length !== 1) {
      throw new Error('group report requires exactly one memberUserId, memberSpecialist, memberAssistant or messageId')
    }

    optionalExactKeys(input, 'group report', [...required, targetKey], 'note')

    const shared = {
      action: 'report' as const,
      conversationId: uuid(input.conversationId, 'conversationId'),
      reason: groupReportReason(input.reason),
      clientOperationId: uuid(input.clientOperationId, 'clientOperationId')
    }

    const note = groupReportNote(input.note)

    if (targetKey === 'memberUserId') {
      return {
        ...shared,
        memberUserId: uuid(input.memberUserId, 'memberUserId'),
        ...(note === undefined ? {} : { note })
      }
    }

    if (targetKey === 'memberSpecialist') {
      return {
        ...shared,
        memberSpecialist: specialistId(input.memberSpecialist),
        ...(note === undefined ? {} : { note })
      }
    }

    if (targetKey === 'memberAssistant') {
      return {
        ...shared,
        memberAssistant: uuid(input.memberAssistant, 'memberAssistant'),
        ...(note === undefined ? {} : { note })
      }
    }

    return { ...shared, messageId: uuid(input.messageId, 'messageId'), ...(note === undefined ? {} : { note }) }
  }

  throw new Error('group operation action is invalid')
}

function groupCursor(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return value === null ? null : undefined
  }

  if (typeof value !== 'string' || !value || value.length > 512) {
    throw new Error('group event cursor is invalid')
  }

  return value
}

function draftInput(value: unknown) {
  const input = record(value, 'draft')
  const attachmentIds = input.attachmentIds === undefined ? [] : input.attachmentIds

  if (typeof input.text !== 'string' || input.text.length > 20_000 || !Array.isArray(attachmentIds)) {
    throw new Error('draft is invalid')
  }

  return {
    text: input.text,
    replyToMessageId:
      input.replyToMessageId === null || input.replyToMessageId === undefined
        ? null
        : identifier(input.replyToMessageId, 'replyToMessageId'),
    attachmentIds: attachmentIds.map((id, index) => identifier(id, `attachmentIds.${index}`))
  }
}

function sendInput(value: unknown) {
  const input = record(value, 'send')

  if (typeof input.content !== 'string' || input.content.length > 20_000) {
    throw new Error('message content is invalid')
  }

  if (input.locale !== 'vi' && input.locale !== 'en') {
    throw new Error('message locale is invalid')
  }

  const attachments = input.attachmentIds === undefined ? [] : input.attachmentIds

  if (!Array.isArray(attachments) || attachments.length > 10) {
    throw new Error('message attachments are invalid')
  }

  if (!input.content.trim() && attachments.length === 0) {
    throw new Error('message content is invalid')
  }

  const attachmentIds = attachments.map((id, index) => identifier(id, `attachmentIds.${index}`))

  let mention: { agent: 'binh-minh'; revision: 0; startOffset: number; endOffset: number } | null = null

  let mentions: {
    contract: typeof ADDRESSED_MENTIONS_CONTRACT
    targets: Array<{
      target: { type: 'assistant' | 'specialist'; id: string }
      revision: number
      startOffset: number
      endOffset: number
    }>
  } | null = null

  let quotedMessage: { messageId: string; sourceVersion: number } | null = null

  if (
    input.mention !== null &&
    input.mention !== undefined &&
    input.mentions !== null &&
    input.mentions !== undefined
  ) {
    throw new Error('message cannot contain both mention and mentions')
  }

  if (
    attachmentIds.length > 0 &&
    ((input.mention !== null && input.mention !== undefined) ||
      (input.mentions !== null && input.mentions !== undefined))
  ) {
    throw new Error('message mentions cannot include attachments')
  }

  if (input.mention !== null && input.mention !== undefined) {
    const rawMention = record(input.mention, 'mention')

    if (
      rawMention.agent !== 'binh-minh' ||
      rawMention.revision !== 0 ||
      !Number.isInteger(rawMention.startOffset) ||
      !Number.isInteger(rawMention.endOffset) ||
      Number(rawMention.startOffset) < 0 ||
      Number(rawMention.endOffset) <= Number(rawMention.startOffset) ||
      // Code points, not UTF-16 units: the renderer converts before sending and
      // the hosted validator measures the same way. `slice` here would read a
      // shifted span the moment an astral character precedes the mention.
      [...input.content].slice(Number(rawMention.startOffset), Number(rawMention.endOffset)).join('') !== '@Atum'
    ) {
      throw new Error('message mention is invalid')
    }

    mention = {
      agent: 'binh-minh',
      endOffset: Number(rawMention.endOffset),
      revision: 0,
      startOffset: Number(rawMention.startOffset)
    }
  }

  if (input.mentions !== null && input.mentions !== undefined) {
    const rawMentions = record(input.mentions, 'mentions')

    if (
      rawMentions.contract !== ADDRESSED_MENTIONS_CONTRACT ||
      !Array.isArray(rawMentions.targets) ||
      rawMentions.targets.length < 1 ||
      rawMentions.targets.length > 8
    ) {
      throw new Error('message mentions are invalid')
    }

    let previousEnd = -1
    const content = input.content
    const contentLength = [...content].length

    const targets = rawMentions.targets.map((value, index) => {
      const row = record(value, `mentions.targets.${index}`)
      const target = record(row.target, `mentions.targets.${index}.target`)
      const startOffset = Number(row.startOffset)
      const endOffset = Number(row.endOffset)

      if (
        (target.type !== 'assistant' && target.type !== 'specialist') ||
        (target.type === 'assistant'
          ? !UUID_V4.test(String(target.id))
          : !/^[a-z][a-z0-9-]{0,63}$/.test(String(target.id))) ||
        !Number.isSafeInteger(row.revision) ||
        Number(row.revision) < 1 ||
        !Number.isInteger(startOffset) ||
        !Number.isInteger(endOffset) ||
        startOffset < 0 ||
        endOffset > contentLength ||
        endOffset <= startOffset ||
        startOffset < previousEnd ||
        ![...content].slice(startOffset, endOffset).join('').startsWith('@')
      ) {
        throw new Error('message mentions are invalid')
      }

      previousEnd = endOffset

      return {
        target: { type: target.type as 'assistant' | 'specialist', id: String(target.id) },
        revision: Number(row.revision),
        startOffset,
        endOffset
      }
    })

    mentions = { contract: ADDRESSED_MENTIONS_CONTRACT, targets }
  }

  if (input.quotedMessage !== null && input.quotedMessage !== undefined) {
    const quote = record(input.quotedMessage, 'quotedMessage')
    exactKeys(quote, 'quotedMessage', ['messageId', 'sourceVersion'])

    if (!Number.isSafeInteger(quote.sourceVersion) || Number(quote.sourceVersion) < 1) {
      throw new Error('quotedMessage is invalid')
    }

    quotedMessage = {
      messageId: uuid(quote.messageId, 'quotedMessage.messageId'),
      sourceVersion: Number(quote.sourceVersion)
    }
  }

  return {
    conversationId: identifier(input.conversationId, 'conversationId'),
    clientMessageId: identifier(input.clientMessageId, 'clientMessageId'),
    content: input.content,
    locale: input.locale,
    replyToMessageId:
      input.replyToMessageId === null || input.replyToMessageId === undefined
        ? null
        : identifier(input.replyToMessageId, 'replyToMessageId'),
    attachmentIds,
    ...(mention ? { mention } : {}),
    ...(mentions ? { mentions } : {}),
    ...(quotedMessage ? { quotedMessage } : {})
  }
}

export const ATUM_MESSAGING_IPC_CHANNELS = [
  'atum:messaging:status',
  'atum:messaging:roster',
  'atum:messaging:messages',
  'atum:messaging:messages:older',
  'atum:messaging:transport-status',
  'atum:messaging:mention-targets',
  'atum:messaging:artifact',
  'atum:messaging:specialist:ensure',
  'atum:messaging:contact:ensure',
  'atum:identity:handle:availability',
  'atum:identity:handle:rename',
  'atum:identity:profile:update',
  'atum:identity:avatar:create',
  'atum:identity:avatar:complete',
  'atum:identity:avatar:clear',
  'atum:assistants:register',
  'atum:assistants:retire',
  'atum:assistants:list',
  'atum:assistants:avatar:create',
  'atum:assistants:avatar:complete',
  'atum:assistants:avatar:clear',
  'atum:social:lookup',
  'atum:social:mutate',
  'atum:social:relationships',
  'atum:social:sync',
  'atum:identity:apps',
  'atum:identity:apps:disconnect',
  'atum:messaging:draft:get',
  'atum:messaging:draft:save',
  'atum:messaging:send',
  'atum:messaging:retry',
  'atum:messaging:read',
  'atum:messaging:reaction',
  'atum:messaging:edit',
  'atum:messaging:recall',
  'atum:messaging:search',
  'atum:messaging:media:create',
  'atum:messaging:media:complete',
  'atum:messaging:media:download',
  'atum:messaging:typing',
  'atum:messaging:mentions:drain',
  'atum:messaging:sync',
  'atum:messaging:group:capabilities',
  'atum:messaging:group:detail',
  'atum:messaging:group:operate',
  'atum:messaging:group:operations'
] as const

export function registerAtumMessagingIpc(ipc: IpcMainLike, client: MessagingClientBoundary): () => void {
  ipc.handle('atum:messaging:status', () => client.status())
  ipc.handle('atum:messaging:roster', (_event, limit) => client.roster(boundedLimit(limit)))
  ipc.handle('atum:messaging:messages', (_event, conversationId, limit) =>
    client.messages(identifier(conversationId, 'conversationId'), boundedLimit(limit))
  )
  ipc.handle('atum:messaging:messages:older', (_event, conversationId, limit) =>
    client.loadOlderMessages(identifier(conversationId, 'conversationId'), boundedLimit(limit))
  )
  ipc.handle('atum:messaging:transport-status', () => client.transportStatus())
  ipc.handle('atum:messaging:mention-targets', async (_event, conversationId) => {
    try {
      return await client.mentionTargets(identifier(conversationId, 'conversationId'))
    } catch (error) {
      // Only the explicit old-route shape retains the pre-S2 invitation. A
      // timeout, auth failure, or malformed server answer stays visible.
      if (error instanceof MessagingTransportError && error.status === 404) {
        return { contract: ADDRESSED_MENTIONS_CONTRACT, mentionCardinality: 1, targets: [], legacy: true }
      }

      throw error
    }
  })
  ipc.handle('atum:messaging:artifact', (_event, conversationId, resourceId) =>
    client.artifact(identifier(conversationId, 'conversationId'), opaqueResourceId(resourceId, 'resourceId'))
  )
  ipc.handle('atum:messaging:specialist:ensure', (_event, specialist) =>
    client.ensureSpecialistConversation(specialistId(specialist))
  )
  ipc.handle('atum:messaging:contact:ensure', (_event, userId) =>
    client.ensureContactConversation(identifier(userId, 'contactUserId'))
  )
  ipc.handle('atum:identity:handle:availability', (_event, value) => client.handleAvailability(handle(value)))
  ipc.handle('atum:identity:handle:rename', (_event, value) => client.renameHandle(handle(value)))
  ipc.handle('atum:identity:profile:update', (_event, value) => client.updateProfile(profileUpdate(value)))
  ipc.handle('atum:identity:avatar:create', (_event, value) => client.createAvatarUpload(avatarUpload(value)))
  ipc.handle('atum:identity:avatar:complete', (_event, id) => client.completeAvatarUpload(identifier(id, 'uploadId')))
  ipc.handle('atum:identity:avatar:clear', () => client.clearAvatar())
  ipc.handle('atum:assistants:register', (_event, value) => client.registerAssistant(assistantRegistration(value)))
  ipc.handle('atum:assistants:avatar:create', (_event, assistantId, value) =>
    client.createAssistantAvatarUpload(assistantAvatarId(assistantId, 'assistantId'), avatarUpload(value))
  )
  ipc.handle('atum:assistants:avatar:complete', (_event, assistantId, uploadId) =>
    client.completeAssistantAvatarUpload(
      assistantAvatarId(assistantId, 'assistantId'),
      assistantAvatarId(uploadId, 'uploadId')
    )
  )
  ipc.handle('atum:assistants:avatar:clear', (_event, assistantId) =>
    client.clearAssistantAvatar(assistantAvatarId(assistantId, 'assistantId'))
  )
  ipc.handle('atum:assistants:retire', (_event, value) => {
    const input = record(value, 'retirement')

    if (!Number.isSafeInteger(input.lifecycleRevision) || Number(input.lifecycleRevision) < 1) {
      throw new Error('lifecycleRevision must be a positive integer')
    }

    if (
      input.expectedIdentityRevision !== undefined &&
      (!Number.isSafeInteger(input.expectedIdentityRevision) || Number(input.expectedIdentityRevision) < 1)
    ) {
      throw new Error('expectedIdentityRevision must be a positive integer')
    }

    return client.retireAssistant({
      identityId: identityId(input.identityId),
      lifecycleRevision: Number(input.lifecycleRevision),
      ...(input.expectedIdentityRevision === undefined
        ? {}
        : { expectedIdentityRevision: Number(input.expectedIdentityRevision) })
    })
  })
  ipc.handle('atum:assistants:list', () => client.listAssistants())
  ipc.handle('atum:social:lookup', (_event, value) => client.socialLookup(searchQuery(value)))
  ipc.handle('atum:social:mutate', (_event, action, targetProfileId) =>
    client.socialMutate(socialAction(action), identifier(targetProfileId, 'targetProfileId'))
  )
  ipc.handle('atum:social:relationships', () => client.socialRelationships())
  ipc.handle('atum:social:sync', () => client.socialSync())
  ipc.handle('atum:identity:apps', () => client.linkedApps())
  ipc.handle('atum:identity:apps:disconnect', (_event, app) => client.disconnectApp(specialistId(app)))
  ipc.handle('atum:messaging:draft:get', (_event, conversationId) =>
    client.draft(identifier(conversationId, 'conversationId'))
  )
  ipc.handle('atum:messaging:draft:save', (_event, conversationId, draft) =>
    client.saveDraft(identifier(conversationId, 'conversationId'), draftInput(draft))
  )
  ipc.handle('atum:messaging:send', (_event, input) => client.send(sendInput(input)))
  ipc.handle('atum:messaging:retry', (_event, clientMessageId) =>
    client.retry(identifier(clientMessageId, 'clientMessageId'))
  )
  ipc.handle('atum:messaging:read', (_event, conversationId, throughMessageId) =>
    client.markRead(identifier(conversationId, 'conversationId'), identifier(throughMessageId, 'throughMessageId'))
  )
  ipc.handle('atum:messaging:reaction', (_event, messageId, emoji) =>
    client.toggleReaction(identifier(messageId, 'messageId'), identifier(emoji, 'emoji'))
  )
  ipc.handle('atum:messaging:edit', (_event, messageId, content) => {
    if (typeof content !== 'string' || !content.trim() || content.length > 20_000) {
      throw new Error('message content is invalid')
    }

    return client.editMessage(identifier(messageId, 'messageId'), content.trim())
  })
  ipc.handle('atum:messaging:recall', (_event, messageId) => client.recallMessage(identifier(messageId, 'messageId')))
  ipc.handle('atum:messaging:search', (_event, query, conversationId) =>
    client.searchMessages(searchQuery(query), conversationId ? identifier(conversationId, 'conversationId') : undefined)
  )
  ipc.handle('atum:messaging:media:create', (_event, value) => {
    const input = record(value, 'media')

    if (
      typeof input.fileName !== 'string' ||
      typeof input.mimeType !== 'string' ||
      !Number.isInteger(input.sizeBytes) ||
      Number(input.sizeBytes) < 1
    ) {
      throw new Error('media is invalid')
    }

    return client.createMediaUpload({
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: Number(input.sizeBytes)
    })
  })
  ipc.handle('atum:messaging:media:complete', (_event, id) =>
    client.completeMediaUpload(identifier(id, 'attachmentId'))
  )
  ipc.handle('atum:messaging:media:download', (_event, id) => client.downloadMedia(identifier(id, 'attachmentId')))
  ipc.handle('atum:messaging:typing', (_event, conversationId, typing) =>
    client.sendTyping(identifier(conversationId, 'conversationId'), typing === true)
  )
  ipc.handle('atum:messaging:mentions:drain', () => client.drainMentionJobs())
  ipc.handle('atum:messaging:sync', () => client.sync())
  ipc.handle('atum:messaging:group:capabilities', () => client.groupCapabilities())
  ipc.handle('atum:messaging:group:detail', (_event, conversationId, cursor) =>
    client.groupDetail(uuid(conversationId, 'conversationId'), groupCursor(cursor))
  )
  ipc.handle('atum:messaging:group:operate', (_event, input) => client.groupOperate(groupOperationInput(input)))
  ipc.handle('atum:messaging:group:operations', () => client.groupOperations())

  return () => {
    for (const channel of ATUM_MESSAGING_IPC_CHANNELS) {
      ipc.removeHandler?.(channel)
    }
  }
}
