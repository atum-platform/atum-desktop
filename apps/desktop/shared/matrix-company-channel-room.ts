import type { MatrixRoom } from './matrix'
import { isCompanyPrivateCosClaim } from './matrix-company-private-cos-claim'

/** Immutable metadata for new plain Team Space channel and conversation rooms. */
export const MATRIX_COMPANY_CHANNEL_TYPE = 'io.atum.company_channel.v1'
export const MATRIX_COMPANY_CHANNEL_BINDING = 'io.atum.company_channel'
export const MATRIX_COMPANY_CONVERSATION_TYPE = 'io.atum.company_conversation.v1'
export const MATRIX_COMPANY_CONVERSATION_BINDING = 'io.atum.company_conversation'
export const MATRIX_COMPANY_CHANNEL_ROOM_VERSION = '11'

export type MatrixCompanyRoomTargetKey =
  | { kind: 'channel'; channelId: string }
  | { kind: 'conversation'; conversationId: string; conversationKind: 'dm' | 'group_dm'; participantSetDigest: string }

export interface MatrixCompanyRoomTargetBinding {
  companyId: string
  target: MatrixCompanyRoomTargetKey
  managerUserId: string
}

export interface MatrixCompanyRoomTargetInput extends MatrixCompanyRoomTargetBinding {
  roomId: string
  memberUserIds: string[]
  bannedUserIds: string[]
  posting: 'open' | 'archived_read_only' | 'participant_read_only'
  displayName: string
  topic: string
  /** company-channel-rooms/1.4 exact human moderators allowed to satisfy Matrix room mentions. */
  roomMentionUserIds?: string[]
  /** company-channel-rooms/1.3 channel identity; omitted on older plans and on conversation writes. */
  avatarUri?: string | null
}

export interface MatrixCompanyChannelRoomBinding {
  companyId: string
  channelId: string
  managerUserId: string
}

/** Human members + readers a pass may invite, and exclusions + possible grants it must ban. */
export const MATRIX_COMPANY_CHANNEL_MAX_MEMBERS = 200
export const MATRIX_COMPANY_CHANNEL_MAX_BANS = 400
export const MATRIX_COMPANY_CHANNEL_TOPIC_MAX = 250

export interface MatrixCompanyChannelRoomTarget extends MatrixCompanyChannelRoomBinding {
  roomId: string
  memberUserIds: string[]
  bannedUserIds: string[]
  posting: 'open' | 'archived_read_only'
  /** company-channel-rooms/1.1 metadata, applied and read back through manager power. Absent on v1 plans. */
  displayName?: string
  topic?: string
  /** company-channel-rooms/1.3 only. `null` witnesses that no company avatar is set. */
  avatarUri?: string | null
  /** company-channel-rooms/1.4 exact human moderators allowed to satisfy Matrix room mentions. */
  roomMentionUserIds?: string[]
}

export interface MatrixCompanyChannelRoomWitness {
  roomId: string
  roomDigest: string
  policyWitness: string
}

/**
 * What room discovery did and could not do, named only by the first 8 bytes (16 hex digits) of the SHA-256 of a room id.
 * Diagnostics for the controller's journal; it grants nothing.
 */
export interface MatrixCompanyChannelDiscoveryReport {
  /** Rooms the manager did not create, left after they stayed unreadable. Each room is reported once. */
  left: string[]
  /** Rooms still joined and unreadable past the window that the manager must not leave. Repeated until fixed. */
  unreadable: string[]
}

export type MatrixCompanyChannelRoomCommand =
  | ({ kind: 'createCompanyChannelRoom'; name: string } & MatrixCompanyChannelRoomBinding)
  | ({ kind: 'findCompanyChannelRoom' } & MatrixCompanyChannelRoomBinding)
  | ({ kind: 'reconcileCompanyChannelRoom' } & MatrixCompanyChannelRoomTarget)
  | ({ kind: 'readCompanyChannelRoom' } & MatrixCompanyChannelRoomTarget)
  | ({ kind: 'createCompanyRoomTarget'; name: string } & MatrixCompanyRoomTargetBinding)
  | ({ kind: 'findCompanyRoomTarget' } & MatrixCompanyRoomTargetBinding)
  | ({ kind: 'reconcileCompanyRoomTarget' } & MatrixCompanyRoomTargetInput)
  | ({ kind: 'readCompanyRoomTarget' } & MatrixCompanyRoomTargetInput)
  | { kind: 'reportCompanyChannelDiscovery' }

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const USER = /^@[!-9;-~]{1,255}:[!-~]{1,255}$/
const DIGEST = /^[a-f0-9]{64}$/

export function validCompanyRoomTargetKey(value: MatrixCompanyRoomTargetKey): boolean {
  return value?.kind === 'channel'
    ? UUID.test(value.channelId) && Object.keys(value).sort().join(',') === 'channelId,kind'
    : value?.kind === 'conversation' && UUID.test(value.conversationId) &&
      ['dm', 'group_dm'].includes(value.conversationKind) && DIGEST.test(value.participantSetDigest) &&
      Object.keys(value).sort().join(',') === 'conversationId,conversationKind,kind,participantSetDigest'
}

export function validCompanyRoomTargetBinding(value: MatrixCompanyRoomTargetBinding): boolean {
  return UUID.test(value.companyId) && validCompanyRoomTargetKey(value.target) && USER.test(value.managerUserId)
}

export function companyRoomTargetBinding(
  content: Record<string, unknown>,
  sender?: string
): MatrixCompanyRoomTargetBinding | undefined {
  const conversation = content.type === MATRIX_COMPANY_CONVERSATION_TYPE
  const raw = content[conversation ? MATRIX_COMPANY_CONVERSATION_BINDING : MATRIX_COMPANY_CHANNEL_BINDING]

  if (content.room_version !== MATRIX_COMPANY_CHANNEL_ROOM_VERSION || !sender || !raw || typeof raw !== 'object' ||
      Array.isArray(raw) || ![MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE].includes(String(content.type))) {
    return undefined
  }
  const binding = raw as Record<string, unknown>
  const target: MatrixCompanyRoomTargetKey = conversation
    ? {
        kind: 'conversation', conversationId: String(binding.conversationId),
        conversationKind: binding.conversationKind as 'dm' | 'group_dm',
        participantSetDigest: String(binding.participantSetDigest)
      }
    : { kind: 'channel', channelId: String(binding.channelId) }
  const expected = conversation
    ? 'companyId,conversationId,conversationKind,participantSetDigest'
    : 'channelId,companyId'
  const result = { companyId: String(binding.companyId), target, managerUserId: sender }

  return Object.keys(binding).sort().join(',') === expected && validCompanyRoomTargetBinding(result) ? result : undefined
}

export function validCompanyChannelRoomBinding(value: MatrixCompanyChannelRoomBinding): boolean {
  return UUID.test(value.companyId) && UUID.test(value.channelId) && USER.test(value.managerUserId)
}

export function companyChannelRoomBinding(
  content: Record<string, unknown>,
  sender?: string
): MatrixCompanyChannelRoomBinding | undefined {
  const raw = content[MATRIX_COMPANY_CHANNEL_BINDING]

  if (content.type !== MATRIX_COMPANY_CHANNEL_TYPE || content.room_version !== MATRIX_COMPANY_CHANNEL_ROOM_VERSION ||
      !sender || !raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).sort().join(',') !== 'channelId,companyId') {
    return undefined
  }

  const result: MatrixCompanyChannelRoomBinding = {
    companyId: Reflect.get(raw, 'companyId'),
    channelId: Reflect.get(raw, 'channelId'),
    managerUserId: sender
  }

  return validCompanyChannelRoomBinding(result) ? result : undefined
}

export interface MatrixCompanyConversationRoomBinding {
  companyId: string
  conversationId: string
  conversationKind: 'dm' | 'group_dm'
  participantSetDigest: string
  managerUserId: string
}

/**
 * The binding of a company conversation room (company-workspace/1.5: a company DM or group DM) as the desktop reads
 * it: the same exact-shape check as `companyRoomTargetBinding`, narrowed to the conversation target. Whoever created a
 * room can write these keys into it, so this is a display hint; the platform's conversation directory is what confirms
 * a room, and a room that claims the type with a binding that does not read here is quarantined all the same.
 */
export function companyConversationRoomBinding(
  content: Record<string, unknown>,
  sender?: string
): MatrixCompanyConversationRoomBinding | undefined {
  const binding = companyRoomTargetBinding(content, sender)

  return binding?.target.kind === 'conversation'
    ? {
        companyId: binding.companyId,
        conversationId: binding.target.conversationId,
        conversationKind: binding.target.conversationKind,
        participantSetDigest: binding.target.participantSetDigest,
        managerUserId: binding.managerUserId
      }
    : undefined
}

/**
 * A room that is a company conversation, by its binding or merely by its type. A room that claims the type with a
 * binding this client cannot read is quarantined all the same: never a Personal chat.
 */
export function isCompanyConversationRoom(
  room: Pick<MatrixRoom, 'companyConversation' | 'roomType'> | null | undefined
): boolean {
  return Boolean(room?.companyConversation) || room?.roomType === MATRIX_COMPANY_CONVERSATION_TYPE
}

/** A room that belongs to Team Space and so to no Personal list. */
export function isTeamSpaceRoom(
  room: Partial<Pick<MatrixRoom,
    'companyChannel' | 'companyConversation' | 'companyPrivateCos' | 'companyPrivateCosBound' |
    'companyPrivateCosClaim' | 'membership' | 'roomType'
  >> | null | undefined
): boolean {
  return Boolean(room?.companyChannel) || isCompanyConversationRoom(room) || isCompanyPrivateCosClaim(room)
}
