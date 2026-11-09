import {
  type AdvisorTarget,
  type AdvisoryAdvisor,
  type AdvisoryRound,
  GROUP_ADDRESSING_CONTRACT,
  GROUP_CONVERSATIONS_CONTRACT,
  GROUP_SHARED_AGENTS_CONTRACT,
  type GroupAddressingCapabilities,
  type GroupAssistant,
  type GroupAssistantAvailability,
  type GroupCapabilities,
  type GroupDetail,
  type GroupEventKind,
  type GroupMembershipEvent,
  type GroupRoom,
  type GroupSpecialist,
  type GroupSpecialistAvailability,
  type GroupSpecialistOption,
  PRIVATE_ADVISORY_CONTRACT,
  type PrivateAdvisoryCapabilities
} from '../../shared/atum-group-conversations'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const EVENT_KINDS = new Set<GroupEventKind>([
  'created',
  'member_added',
  'member_removed',
  'member_left',
  'owner_transferred',
  'renamed',
  'retired',
  'account_deleted'
])

function invalid(field: string): never {
  throw new Error(`invalid_response:group.${field}`)
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(field)
  }

  return value as Record<string, unknown>
}

function text(value: unknown, field: string, max = 256): string {
  if (typeof value !== 'string' || !value || [...value].length > max) {
    return invalid(field)
  }

  return value
}

function uuid(value: unknown, field: string): string {
  const result = text(value, field, 36)

  if (!UUID.test(result)) {
    return invalid(field)
  }

  return result
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    return invalid(field)
  }

  return Number(value)
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field, 64)

  if (!Number.isFinite(Date.parse(result))) {
    return invalid(field)
  }

  return result
}

function specialist(value: unknown, field: string): string {
  const result = text(value, field, 64)

  if (!/^[a-z][a-z0-9-]{0,63}$/.test(result)) {
    return invalid(field)
  }

  return result
}

function specialistAvailability(value: unknown, field: string): GroupSpecialistAvailability {
  if (value !== 'available' && value !== 'specialist_not_linked' && value !== 'specialist_room_unsupported') {
    return invalid(field)
  }

  return value
}

function assistantAvailability(value: unknown, field: string): GroupAssistantAvailability {
  if (
    value !== 'available' &&
    value !== 'assistant_not_owned' &&
    value !== 'assistant_offline' &&
    value !== 'assistant_not_approved' &&
    value !== 'assistant_requires_update'
  ) {
    return invalid(field)
  }

  return value
}

function optionalText(value: unknown, field: string, max = 256): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  return text(value, field, max)
}

function parseAssistant(value: unknown, field: string): GroupAssistant {
  const row = object(value, field)
  const avatarUrl = optionalText(row.avatar_url, `${field}.avatar_url`, 2_048)
  const avatar = optionalText(row.avatar, `${field}.avatar`, 512)
  const ownerDisplayName = optionalText(row.owner_display_name, `${field}.owner_display_name`)

  return {
    assistantId: uuid(row.assistant_id, `${field}.assistant_id`),
    displayName: text(row.display_name, `${field}.display_name`),
    ...(avatarUrl === undefined ? {} : { avatarUrl }),
    ...(avatar === undefined ? {} : { avatar }),
    ownerUserId: uuid(row.owner_user_id, `${field}.owner_user_id`),
    ...(ownerDisplayName === undefined ? {} : { ownerDisplayName }),
    membershipEpoch: integer(row.membership_epoch, `${field}.membership_epoch`),
    availability: assistantAvailability(row.availability, `${field}.availability`)
  }
}

function parseAssistants(value: unknown, field: string): GroupAssistant[] {
  if (!Array.isArray(value) || value.length > 64) {
    return invalid(field)
  }

  const assistants = value.map((entry, index) => parseAssistant(entry, `${field}.${index}`))

  if (new Set(assistants.map(entry => entry.assistantId)).size !== assistants.length) {
    return invalid(field)
  }

  return assistants
}

function parseSpecialistOption(value: unknown, field: string): GroupSpecialistOption {
  const row = object(value, field)

  if (typeof row.room_supported !== 'boolean') {
    return invalid(`${field}.room_supported`)
  }

  return {
    specialist: specialist(row.specialist, `${field}.specialist`),
    displayName: text(row.display_name, `${field}.display_name`),
    avatar: typeof row.avatar === 'string' ? row.avatar : invalid(`${field}.avatar`),
    roomSupported: row.room_supported
  }
}

function parseAddressingCapabilities(value: unknown): GroupAddressingCapabilities | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  const row = object(value, 'addressing_capabilities')

  if (row.contract !== GROUP_ADDRESSING_CONTRACT) {
    return undefined
  }

  if (
    typeof row.enabled !== 'boolean' ||
    row.mention_cardinality !== 8 ||
    row.quote_limit !== 4_000 ||
    row.specialist_member_limit !== 4
  ) {
    return invalid('addressing_capabilities')
  }

  const catalog =
    row.specialist_catalog === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(row.specialist_catalog) || row.specialist_catalog.length > 64) {
            return invalid('addressing_capabilities.specialist_catalog')
          }

          const parsed = row.specialist_catalog.map((entry, index) =>
            parseSpecialistOption(entry, `addressing_capabilities.specialist_catalog.${index}`)
          )

          if (new Set(parsed.map(entry => entry.specialist)).size !== parsed.length) {
            return invalid('addressing_capabilities.specialist_catalog')
          }

          return parsed
        })()

  return {
    enabled: row.enabled,
    mentionCardinality: row.mention_cardinality,
    quoteLimit: row.quote_limit,
    specialistMemberLimit: row.specialist_member_limit,
    ...(catalog === undefined ? {} : { specialistCatalog: catalog })
  }
}

function parseAdvisorTarget(value: unknown, field: string): AdvisorTarget {
  const row = object(value, field)

  if (row.type !== 'specialist' && row.type !== 'assistant') {
    return invalid(field)
  }

  return {
    type: row.type,
    id: row.type === 'assistant' ? uuid(row.id, `${field}.id`) : specialist(row.id, `${field}.id`)
  }
}

function parseAdvisors(value: unknown, field: string): AdvisoryAdvisor[] {
  if (!Array.isArray(value) || value.length > 64) {
    return invalid(field)
  }

  const advisors = value.map((value, index) => {
    const row = object(value, `${field}.${index}`)

    return {
      target: parseAdvisorTarget(row.target, `${field}.${index}.target`),
      displayName: text(row.display_name, `${field}.${index}.display_name`),
      avatar: typeof row.avatar === 'string' ? row.avatar : invalid(`${field}.${index}.avatar`),
      availability: text(row.availability, `${field}.${index}.availability`, 80)
    }
  })

  if (new Set(advisors.map(row => `${row.target.type}:${row.target.id}`)).size !== advisors.length) {
    return invalid(field)
  }

  return advisors
}

function parseAdvisoryCapabilities(value: unknown): PrivateAdvisoryCapabilities | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  const row = object(value, 'private_advisory')

  if (row.contract !== PRIVATE_ADVISORY_CONTRACT) {
    return undefined
  }

  if (typeof row.enabled !== 'boolean' || row.advisor_limit !== 8) {
    return invalid('private_advisory')
  }

  return {
    enabled: row.enabled,
    advisorLimit: row.advisor_limit,
    advisorCatalog: parseAdvisors(row.advisor_catalog, 'advisor_catalog')
  }
}

function parseSharedAgentsCapabilities(value: unknown): GroupCapabilities['sharedAgents'] | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  const row = object(value, 'shared_group_agents')

  if (row.contract !== GROUP_SHARED_AGENTS_CONTRACT) {
    return undefined
  }

  if (typeof row.enabled !== 'boolean' || row.assistant_member_limit !== 4 || row.own_assistant_only !== true) {
    return invalid('shared_group_agents')
  }

  return {
    enabled: row.enabled,
    assistantMemberLimit: row.assistant_member_limit,
    ownAssistantOnly: true,
    assistantCatalog: parseAssistants(row.assistant_catalog, 'shared_group_agents.assistant_catalog')
  }
}

function parseAdvisoryRound(value: unknown): AdvisoryRound | null {
  if (value === null || value === undefined) {
    return null
  }

  const row = object(value, 'latest_round')

  if (
    !['running', 'completed', 'stopped', 'failed'].includes(String(row.status)) ||
    !Array.isArray(row.slots) ||
    row.slots.length > 8
  ) {
    return invalid('latest_round')
  }

  const slots = row.slots.map((value, index): AdvisoryRound['slots'][number] => {
    const slot = object(value, `round.slots.${index}`)

    if (!['queued', 'running', 'completed', 'cancelled', 'failed'].includes(String(slot.status))) {
      return invalid('round.slot.status')
    }

    return {
      slot: integer(slot.slot, 'round.slot'),
      target: parseAdvisorTarget(slot.target, 'round.target'),
      status: slot.status as AdvisoryRound['slots'][number]['status']
    }
  })

  if (new Set(slots.map(slot => slot.slot)).size !== slots.length) {
    return invalid('round.slots')
  }

  return { id: uuid(row.id, 'round.id'), status: row.status as AdvisoryRound['status'], slots }
}

export function parseGroupCapabilities(
  value: unknown,
  addressing?: unknown,
  advisory?: unknown,
  sharedAgents?: unknown
): GroupCapabilities {
  if (value === undefined || value === null) {
    return { available: false, creationEnabled: false, humanMemberLimit: 32 }
  }

  const row = object(value, 'capabilities')

  if (row.contract !== GROUP_CONVERSATIONS_CONTRACT) {
    return { available: false, creationEnabled: false, humanMemberLimit: 32 }
  }

  if (typeof row.creation_enabled !== 'boolean' || row.human_member_limit !== 32) {
    return invalid('capabilities')
  }

  const parsedAddressing = parseAddressingCapabilities(addressing)
  const parsedAdvisory = parseAdvisoryCapabilities(advisory)
  const parsedSharedAgents = parseSharedAgentsCapabilities(sharedAgents)

  return {
    available: true,
    creationEnabled: row.creation_enabled,
    ...(row.create_defaults === true ? { createDefaults: true } : {}),
    humanMemberLimit: row.human_member_limit,
    ...(parsedAddressing === undefined ? {} : { addressing: parsedAddressing }),
    ...(parsedAdvisory === undefined ? {} : { advisory: parsedAdvisory }),
    ...(parsedSharedAgents === undefined ? {} : { sharedAgents: parsedSharedAgents })
  }
}

export function parseGroupRoom(value: unknown, expectedConversationId: string): GroupRoom {
  const row = object(value, 'room')
  const conversationId = uuid(row.conversation_id, 'conversation_id')

  if (conversationId !== expectedConversationId) {
    return invalid('conversation_scope')
  }

  const title = text(row.title, 'title', 80)

  if (title !== title.trim()) {
    return invalid('title')
  }

  const retiredAt = row.retired_at === null ? null : timestamp(row.retired_at, 'retired_at')

  if (!Array.isArray(row.members) || row.members.length < 1 || row.members.length > 32) {
    return invalid('members')
  }

  const members = row.members.map((value, index) => {
    const member = object(value, `members.${index}`)

    if (member.role !== 'owner' && member.role !== 'member') {
      return invalid(`members.${index}.role`)
    }

    return {
      userId: uuid(member.user_id, `members.${index}.user_id`),
      displayName: text(member.display_name, `members.${index}.display_name`),
      handle: member.handle === '' ? '' : text(member.handle, `members.${index}.handle`, 80),
      role: member.role as 'owner' | 'member',
      membershipEpoch: integer(member.membership_epoch, `members.${index}.membership_epoch`)
    }
  })

  if (new Set(members.map(member => member.userId)).size !== members.length) {
    return invalid('duplicate_members')
  }

  if (!retiredAt && members.filter(member => member.role === 'owner').length !== 1) {
    return invalid('owner')
  }

  if (
    row.context_mode !== undefined &&
    row.context_mode !== 'ordinary' &&
    row.context_mode !== 'private_advisory' &&
    row.context_mode !== 'shared_group'
  ) {
    return invalid('context_mode')
  }

  const advisory = row.context_mode === 'private_advisory'
  const sharedGroup = row.context_mode === 'shared_group'

  if (advisory && (members.length !== 1 || members[0]?.role !== 'owner')) {
    return invalid('advisory_owner')
  }

  const specialists =
    row.specialists === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(row.specialists) || row.specialists.length > 4) {
            return invalid('specialists')
          }

          const parsed = row.specialists.map((value, index): GroupSpecialist => {
            const member = object(value, `specialists.${index}`)

            return {
              specialist: specialist(member.specialist, `specialists.${index}.specialist`),
              displayName: text(member.display_name, `specialists.${index}.display_name`),
              avatar: typeof member.avatar === 'string' ? member.avatar : invalid(`specialists.${index}.avatar`),
              membershipEpoch: integer(member.membership_epoch, `specialists.${index}.membership_epoch`),
              availability: specialistAvailability(member.availability, `specialists.${index}.availability`)
            }
          })

          if (new Set(parsed.map(member => member.specialist)).size !== parsed.length) {
            return invalid('duplicate_specialists')
          }

          return parsed
        })()

  const assistants = row.assistants === undefined ? undefined : parseAssistants(row.assistants, 'assistants')

  return {
    conversationId,
    title,
    retiredAt,
    members,
    revision: integer(row.revision, 'revision'),
    membershipEpoch: integer(row.membership_epoch, 'membership_epoch'),
    updatedAt: timestamp(row.updated_at, 'updated_at'),
    ...(specialists === undefined ? {} : { specialists }),
    ...(sharedGroup && assistants !== undefined ? { assistants } : {}),
    ...(advisory
      ? {
          contextMode: 'private_advisory' as const,
          audienceRevision: integer(row.audience_revision, 'audience_revision'),
          advisors: parseAdvisors(row.advisors, 'advisors'),
          latestRound: parseAdvisoryRound(row.latest_round)
        }
      : sharedGroup
        ? { contextMode: 'shared_group' as const }
        : {})
  }
}

function parseGroupEvent(value: unknown, conversationId: string): GroupMembershipEvent {
  const row = object(value, 'event')

  if (row.conversation_id !== conversationId) {
    return invalid('event.conversation_scope')
  }

  if (!EVENT_KINDS.has(row.kind as GroupEventKind)) {
    return invalid('event.kind')
  }

  const snapshot = object(row.identity_snapshot, 'event.identity_snapshot')

  return {
    id: uuid(row.id, 'event.id'),
    conversationId,
    actorUserId: row.actor_user_id === null ? null : uuid(row.actor_user_id, 'event.actor_user_id'),
    subjectUserId: row.subject_user_id === null ? null : uuid(row.subject_user_id, 'event.subject_user_id'),
    ...(row.specialist === undefined || row.specialist === null
      ? {}
      : { specialist: specialist(row.specialist, 'event.specialist') }),
    kind: row.kind as GroupEventKind,
    createdAt: timestamp(row.created_at, 'event.created_at'),
    identitySnapshot: {
      ...(snapshot.display_name == null ? {} : { displayName: text(snapshot.display_name, 'event.display_name') }),
      ...(snapshot.handle == null ? {} : { handle: text(snapshot.handle, 'event.handle', 80) })
    }
  }
}

export function parseGroupDetail(value: unknown, conversationId: string): GroupDetail {
  const row = object(value, 'detail')

  if (!Array.isArray(row.events) || row.events.length > 100 || typeof row.has_more !== 'boolean') {
    return invalid('detail')
  }

  const nextCursor = row.next_cursor === null ? null : text(row.next_cursor, 'detail.next_cursor', 8192)

  if (row.has_more && !nextCursor) {
    return invalid('detail.next_cursor')
  }

  const specialistCatalog =
    row.specialist_catalog === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(row.specialist_catalog) || row.specialist_catalog.length > 64) {
            return invalid('detail.specialist_catalog')
          }

          return row.specialist_catalog.map((entry, index) =>
            parseSpecialistOption(entry, `detail.specialist_catalog.${index}`)
          )
        })()

  return {
    room: parseGroupRoom(row.group, conversationId),
    events: row.events.map(event => parseGroupEvent(event, conversationId)),
    nextCursor,
    hasMore: row.has_more,
    ...(specialistCatalog === undefined ? {} : { specialistCatalog })
  }
}
