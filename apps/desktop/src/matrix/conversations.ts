import {
  EventType,
  type MatrixClient,
  MsgType,
  NotificationCountType,
  Preset,
  PushRuleActionName,
  RelationType,
  type Room
} from 'matrix-js-sdk'

import { APP_UUID } from '../../shared/app-shortcuts'
import {
  decodeLookRoomAccountData,
  LOOK_ROOM_ACCOUNT_DATA_TYPE,
  type LookRoomAccountData
} from '../../shared/look-pack'
import { MATRIX_CHAT_TITLE_MAX, MATRIX_GROUP_TOPIC_MAX, type MatrixMember, type MatrixRoom } from '../../shared/matrix'
import { appGroupBinding, MATRIX_APP_GROUP_BINDING, MATRIX_APP_GROUP_TYPE } from '../../shared/matrix-app-room'
import { MATRIX_ASSISTANT_ROOM_TYPE, plainAgentRoom } from '../../shared/matrix-assistant-room'
import { companyChannelRoomBinding, companyConversationRoomBinding } from '../../shared/matrix-company-channel-room'
import {
  MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT,
  matrixCompanyPrivateCosPowerLevels,
  matrixCompanyPrivateCosRoomBinding
} from '../../shared/matrix-company-private-cos-claim'
import { type MatrixModelChoice, readMatrixModelChoice } from '../../shared/matrix-model-choice'
import {
  MATRIX_MODEL_ACCOUNT_DATA,
  type MatrixEffort,
  type MatrixModelId,
  parseMatrixEffort,
  parseMatrixModel
} from '../../shared/matrix-models'
import { matrixProfileMxc } from '../../shared/matrix-profile'

import { APP_BOT_DM_MARKER, appBotDmMarker, appBotDmUsable } from './app-bot-dm'
import { privateCosPresentationBinding } from './company-presentation-binding'
import { matrixMarkedUnread } from './message-commands'
import { matrixReadableRoomName } from './person-name'
import { plainRoomAnswer } from './plain-room'
import { matrixRoomDialogue, matrixRoomPreview, matrixRoomUnread } from './room-preview'
import { teamSpaceAccountKey, teamSpaceKey } from './team-space/keys'
import { $companyPrivateCos } from './team-space/private-cos-store'
import { matrixRoomTimelineEvents } from './threads'

declare module 'matrix-js-sdk' {
  interface RoomAccountDataEvents {
    'io.atum.model': MatrixModelChoice | { model?: MatrixModelId; effort?: MatrixEffort }
    'io.atum.title': { title?: string }
    'io.atum.chat.look': LookRoomAccountData
  }
}

/** The owner's own name for a chat: per-user room account data, private to them and synced
 * to their devices. An empty object clears it (account data cannot be deleted). */
export const MATRIX_TITLE_ACCOUNT_DATA = 'io.atum.title'

/** A user-only marker on a retired official app DM. It is display guidance only. */
function legacyAppBotMoved(room: Room) {
  const value = room.getAccountData('io.atum.app_bot.legacy_moved')?.getContent<Record<string, unknown>>()

  if (
    !value ||
    value.v !== 1 ||
    typeof value.app_id !== 'string' ||
    !APP_UUID.test(value.app_id) ||
    typeof value.bot_user_id !== 'string' ||
    !/^@[^:\s]+:[^\s]+$/u.test(value.bot_user_id) ||
    typeof value.moved_at !== 'number' ||
    !Number.isSafeInteger(value.moved_at) ||
    value.moved_at < 0 ||
    Object.keys(value).length !== 4
  ) {
    return undefined
  }

  return { appId: value.app_id, botUserId: value.bot_user_id, movedAt: value.moved_at }
}

/** A stored name, as one bounded line; anything else is no name. */
export function matrixChatTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const title = value.replace(/\p{Cc}/gu, ' ').trim().replace(/\s+/gu, ' ')

  return title && [...title].length <= MATRIX_CHAT_TITLE_MAX ? title : undefined
}

/** A room's topic (standard `m.room.topic`) as one line, cut to the longest a group's topic may be. */
export function matrixGroupTopic(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const topic = value.replace(/\p{Cc}/gu, ' ').trim().replace(/\s+/gu, ' ')

  return topic ? [...topic].slice(0, MATRIX_GROUP_TOPIC_MAX).join('').trimEnd() : undefined
}

/** One line of a message, cut at a word near `max` characters. */
function oneLine(body: string, max = 60): string {
  const line = body.replace(/\s+/gu, ' ').trim()
  const chars = [...line]

  if (chars.length <= max) {
    return line
  }

  const cut = chars.slice(0, max).join('')
  const space = cut.lastIndexOf(' ')

  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/**
 * An assistant history's title: its owner's first message. Only once the whole history is
 * loaded (the live timeline starts at the room's creation), so the title never changes as
 * older messages load; a longer history is named by its date instead.
 */
function firstOwnLine(client: MatrixClient, room: Room): string | undefined {
  const events = room.getLiveTimeline().getEvents()

  if (events[0]?.getType() !== EventType.RoomCreate) {
    return undefined
  }

  const own = client.getUserId()

  for (const event of events) {
    // An edit is not a first message (the message it changes is), nor is a deleted one.
    if (
      event.getSender() !== own ||
      event.getType() !== EventType.RoomMessage ||
      event.isDecryptionFailure() ||
      event.isRelation(RelationType.Replace) ||
      event.isRedacted()
    ) {
      continue
    }

    const content = event.getContent()

    if (content.msgtype === MsgType.Text && typeof content.body === 'string' && content.body.trim()) {
      return oneLine(content.body)
    }
  }

  return undefined
}

/** The SDK's own room muting: a room-specific push rule that does not notify. Before the
 * first sync there are no rules yet (the SDK throws if asked): nothing is muted. */
function roomMuted(client: MatrixClient, roomId: string): boolean {
  if (!client.pushRules) {
    return false
  }

  const rule = client.getRoomPushRule('global', roomId)

  return Boolean(
    rule &&
    rule.enabled !== false &&
    (rule.actions.length === 0 || rule.actions.includes(PushRuleActionName.DontNotify))
  )
}

/** Matrix's room-mention push rule checks the sender's current power against
 * `m.room.power_levels.notifications.room`. This projection only decides whether the composer
 * offers `@channel`; the homeserver still decides whether recipients are highlighted. */
export function canMentionMatrixRoom(room: Room, userId: string): boolean {
  if (room.getMyMembership() !== 'join') {
    return false
  }

  const member = room.getMember(userId)
  const event = room.currentState.getStateEvents(EventType.RoomPowerLevels, '')

  if (!member || !event || Array.isArray(event)) {
    return false
  }

  const notifications = event.getContent().notifications
  const threshold =
    notifications && typeof notifications === 'object' && !Array.isArray(notifications)
      ? Reflect.get(notifications, 'room')
      : undefined

  return typeof threshold === 'number' && Number.isSafeInteger(threshold) && member.powerLevel >= threshold
}

/** UI hints derived from SDK state. The homeserver enforces every write. A room without
 * end-to-end encryption (every room since 0.20) is moderated like any other: by power levels. */
export function conversationMembers(room: Room, userId: string): MatrixMember[] {
  const own = room.getMember(userId)
  const creation = room.currentState.getStateEvents(EventType.RoomCreate, '')
  const managerUserId = creation && !Array.isArray(creation)
    ? companyChannelRoomBinding(creation.getContent(), creation.getSender())?.managerUserId ??
      companyConversationRoomBinding(creation.getContent(), creation.getSender())?.managerUserId
    : undefined

  const mayRemove =
    room.getMyMembership() === 'join' &&
    Boolean(own && room.currentState.hasSufficientPowerLevelFor('kick', own.powerLevel))

  const mayBan =
    room.getMyMembership() === 'join' &&
    Boolean(own && room.currentState.hasSufficientPowerLevelFor('ban', own.powerLevel))

  return room
    .getMembers()
    .filter(member => member.userId !== managerUserId && ['join', 'invite', 'ban'].includes(member.membership ?? ''))
    .map(member => ({
      userId: member.userId,
      rawName: member.rawDisplayName,
      name: member.name,
      membership: member.membership ?? '',
      avatarMxc: matrixProfileMxc(member.getMxcAvatarUrl()),
      canRemove: Boolean(
        mayRemove &&
        own &&
        member.membership !== 'ban' &&
        member.userId !== userId &&
        own.powerLevel > member.powerLevel
      ),
      canBan: Boolean(
        mayBan && own && member.membership !== 'ban' && member.userId !== userId && own.powerLevel > member.powerLevel
      ),
      canUnban: Boolean(
        mayBan &&
        mayRemove &&
        own &&
        member.membership === 'ban' &&
        member.userId !== userId &&
        own.powerLevel > member.powerLevel
      )
    }))
}

/** The other member's profile photo in an ordinary one-to-one chat, for the roster's face.
 * Assistant rooms and app groups carry their own identities, never a person's. */
function directPeerAvatarMxc(
  room: Room,
  ownerId: string | null,
  direct: boolean,
  appGroup: unknown
): string | null | undefined {
  if (!ownerId || !direct || room.getType() === MATRIX_ASSISTANT_ROOM_TYPE || appGroup) {
    return undefined
  }

  const members = room
    .getMembers()
    .filter(member => ['join', 'invite'].includes(member.membership ?? ''))

  if (members.length !== 2 || !members.some(member => member.userId === ownerId)) {
    return undefined
  }

  const peer = members.find(member => member.userId !== ownerId)

  return peer ? matrixProfileMxc(peer.getMxcAvatarUrl()) : undefined
}

export function conversationRoom(client: MatrixClient, room: Room): MatrixRoom {
  const rawChoice = room.getAccountData(MATRIX_MODEL_ACCOUNT_DATA)?.getContent()
  const choice = readMatrixModelChoice(rawChoice)
  const directAccountData = client.getAccountData(EventType.Direct)?.getContent<Record<string, unknown>>() ?? {}
  const favourite = room.tags['m.favourite']
  const order: unknown = favourite?.order
  const creation = room.currentState.getStateEvents(EventType.RoomCreate, '')
  const companyChannel = creation ? companyChannelRoomBinding(creation.getContent(), creation.getSender()) : undefined
  const companyConversation = creation ? companyConversationRoomBinding(creation.getContent(), creation.getSender()) : undefined
  const companyRoomManagerUserId = companyChannel?.managerUserId ?? companyConversation?.managerUserId
  // Classification trusts only the empty-key marker below, but quarantine must notice every
  // state key. A malicious/non-conforming marker may never fall back into Personal surfaces.
  const privateCosClaims = room.currentState.getStateEvents(MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT)
  const hasPrivateCosClaim = Array.isArray(privateCosClaims)
    ? privateCosClaims.length > 0
    : Boolean(privateCosClaims)
  const privateCosMarker = room.currentState.getStateEvents(MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT, '')
  const companyPrivateCos = privateCosMarker && !Array.isArray(privateCosMarker)
    ? matrixCompanyPrivateCosRoomBinding(
        room.getType(),
        privateCosMarker.getType(),
        privateCosMarker.getStateKey(),
        privateCosMarker.getContent()
      )
    : undefined
  const history = room.currentState.getStateEvents(EventType.RoomHistoryVisibility, '')
  const joinRule = room.currentState.getStateEvents(EventType.RoomJoinRules, '')
  const powerLevels = room.currentState.getStateEvents(EventType.RoomPowerLevels, '')
  const historyVisibility = history && !Array.isArray(history)
    ? history.getContent()?.history_visibility
    : undefined
  const joinedBy = joinRule && !Array.isArray(joinRule) ? joinRule.getContent()?.join_rule : undefined
  const privateCosPower = powerLevels && !Array.isArray(powerLevels)
    ? matrixCompanyPrivateCosPowerLevels(powerLevels.getContent())
    : undefined
  const roomVersion = creation?.getContent()?.room_version
  const roomAvatar = companyChannel
    ? room.currentState.getStateEvents(EventType.RoomAvatar, '')
    : undefined
  const roomAvatarMxc = roomAvatar && !Array.isArray(roomAvatar)
    ? matrixProfileMxc(roomAvatar.getContent()?.url)
    : undefined
  const appGroup = creation ? appGroupBinding(creation.getContent(), creation.getSender()) : undefined
  const own = client.getUserId()
  const topicEvent = room.currentState.getStateEvents(EventType.RoomTopic, '')
  const topic = topicEvent && !Array.isArray(topicEvent) ? matrixGroupTopic(topicEvent.getContent()?.topic) : undefined
  // Who may rename the room or set its topic is the room's own power levels (display hint; the SDK
  // re-reads them before it sends).
  const joined = room.getMyMembership() === 'join'
  const canName = Boolean(own && joined && room.currentState.maySendStateEvent(EventType.RoomName, own))
  const canTopic = Boolean(own && joined && room.currentState.maySendStateEvent(EventType.RoomTopic, own))
  // An official bot's chat is a one-to-one chat from the first frame it is drawn: the room's own marker
  // (this account's, with only the person and the bot in it) says so. The account's `m.direct` hint
  // follows a server round trip after the chat is already selected, and until it came the window drew
  // the person's brand-new app chat as an ordinary, untitled room: a new conversation that turned into
  // the app's a moment later.
  const botChat = own ? appBotDmMarker(room, own) : null
  const direct =
    Boolean(room.getDMInviter()) ||
    Object.values(directAccountData).some(ids => Array.isArray(ids) && ids.includes(room.roomId)) ||
    Boolean(own && botChat && appBotDmUsable(room, own, botChat.appId, botChat.botUserId))
  const ignored = new Set(client.getIgnoredUsers())
  // Preview, dialogue and unread are three views of one loaded room snapshot. Compute the
  // compatibility timeline once so thread enumeration is not repeated for every row field.
  const timelineEvents = matrixRoomTimelineEvents(room)
  // Whether anyone has spoken in an assistant's chat: the first run's one test of a new account.
  const dialogue = room.getType() === MATRIX_ASSISTANT_ROOM_TYPE ? matrixRoomDialogue(room, timelineEvents) : undefined

  const view: MatrixRoom = {
    id: room.roomId,
    // Never a member's ID standing in for a name (ledger AC8).
    name: matrixReadableRoomName(room.name),
    membership: room.getMyMembership(),
    canSend: room.maySendMessage(),
    encrypted: room.hasEncryptionStateEvent(),
    plainAgent: plainAgentRoom(room),
    roomType: room.getType(),
    ...(typeof roomVersion === 'string' ? { roomVersion } : {}),
    ...(typeof joinedBy === 'string' ? { joinRule: joinedBy } : {}),
    ...(typeof historyVisibility === 'string' ? { historyVisibility } : {}),
    ...(privateCosPower ? { powerLevels: privateCosPower } : {}),
    ...(companyChannel ? { companyChannel: { companyId: companyChannel.companyId,
      channelId: companyChannel.channelId, managerUserId: companyChannel.managerUserId }, roomAvatarMxc } : {}),
    ...(companyConversation ? { companyConversation: { companyId: companyConversation.companyId,
      conversationId: companyConversation.conversationId, managerUserId: companyConversation.managerUserId } } : {}),
    ...(companyPrivateCos ? { companyPrivateCos } : {}),
    ...(hasPrivateCosClaim && !companyPrivateCos
      ? { companyPrivateCosClaim: true as const }
      : {}),
    appGroup,
    legacyAppBotMoved: legacyAppBotMoved(room),
    // The server's counts, threads included (the SDK keeps a thread's apart once threads are on).
    unreadNotifications: room.getUnreadNotificationCount(NotificationCountType.Total),
    highlights: room.getUnreadNotificationCount(NotificationCountType.Highlight),
    ...(companyChannel && own && canMentionMatrixRoom(room, own) ? { canMentionRoom: true } : {}),
    unread: own ? matrixRoomUnread(room, own, ignored, timelineEvents) : false,
    favourite: Object.hasOwn(room.tags, 'm.favourite'),
    favouriteOrder: typeof order === 'number' && Number.isFinite(order) && order >= 0 && order <= 1 ? order : undefined,
    ...(Object.hasOwn(room.tags, 'm.lowpriority') ? { lowPriority: true } : {}),
    lastActiveAt: room.getLastActiveTimestamp(),
    direct,
    ...(direct ? { peerAvatarMxc: directPeerAvatarMxc(room, own, direct, appGroup) } : {}),
    canInvite:
      room.getType() !== MATRIX_ASSISTANT_ROOM_TYPE &&
      room.getMyMembership() === 'join' &&
      room.canInvite(client.getSafeUserId()),
    ...(topic ? { topic } : {}),
    ...(canName ? { canName: true as const } : {}),
    ...(canTopic ? { canTopic: true as const } : {}),
    participants: room.getMembers()
      .filter(member => member.userId !== companyRoomManagerUserId)
      .map(member => ({ userId: member.userId, membership: member.membership ?? '' })),
    modelChoice: choice,
    modelChoiceInvalid: rawChoice !== undefined && !choice ? true : undefined,
    model: choice?.source === 'atum' ? parseMatrixModel(choice.model) : undefined,
    effort: choice?.source === 'atum' ? parseMatrixEffort(choice.effort) : undefined,
    title: matrixChatTitle(room.getAccountData(MATRIX_TITLE_ACCOUNT_DATA)?.getContent()?.title),
    look: decodeLookRoomAccountData(room.getAccountData(LOOK_ROOM_ACCOUNT_DATA_TYPE)?.getContent()),
    firstLine: room.getType() === MATRIX_ASSISTANT_ROOM_TYPE ? firstOwnLine(client, room) : undefined,
    ...(dialogue ? { dialogue } : {}),
    createdAt: creation?.getTs(),
    muted: roomMuted(client, room.roomId),
    ...(matrixMarkedUnread(room) ? { markedUnread: true } : {})
  }

  // The chat list's row (Element's room list): the latest message, and when it was sent. A private
  // Chief of Staff room's company working line is skipped only for the agent the platform binds to it,
  // exactly as its transcript reads it; while that binding is unknown the line previews as a message.
  const companyAgent = companyPrivateCos && own
    ? privateCosPresentationBinding(
        $companyPrivateCos.get()[
          teamSpaceKey(teamSpaceAccountKey({ userId: own, deviceId: client.getDeviceId() ?? '' }), companyPrivateCos.companyId)
        ],
        view
      )?.agentUserId
    : undefined

  const preview = own ? matrixRoomPreview(room, own, ignored, timelineEvents, companyAgent) : undefined

  // A chat is as recent as its latest message, as Element orders it: a reaction, an edit or
  // someone joining does not move it up the list.
  return { ...view, ...(preview ? { preview, lastActiveAt: preview.at } : {}) }
}

/**
 * Whether this account may change a personal group's shared name or topic (`type`): a joined
 * group of people (not a one-to-one chat, an assistant's or app's room, a typed room or a Team
 * Space room) whose current power levels allow the state event. Read from the room's state now,
 * not from the window's projection.
 */
export function personalGroupStateAllowed(
  client: MatrixClient,
  room: Room,
  type: EventType.RoomName | EventType.RoomTopic
): boolean {
  const own = client.getUserId()
  const view = conversationRoom(client, room)

  return Boolean(
    own &&
      view.membership === 'join' &&
      !view.direct &&
      !view.roomType &&
      !view.plainAgent &&
      !view.appGroup &&
      !view.companyChannel &&
      !view.companyConversation &&
      !view.companyPrivateCos &&
      !view.companyPrivateCosClaim &&
      !appBotDmMarker(room, own) &&
      room.currentState.maySendStateEvent(type, own)
  )
}

/**
 * A room this account is in, for what is done in it: sending, files, edits, reactions, typing,
 * receipts, history. With end-to-end encryption or without: since 0.20 a room without it is an
 * ordinary chat (owner decisions D1 and D2). What may be read from a room is decided where its
 * events are read (read-invocation.ts), and a plaintext event in an encrypted room stays
 * refused there. The refusal keeps its code, which callers already treat as final.
 */
export function joinedConversation(client: MatrixClient, roomId: string): Room {
  const room = client.getRoom(roomId)

  if (!room || room.getMyMembership() !== 'join') {
    throw new Error('matrix_encrypted_room_required')
  }

  return room
}

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export async function agentPostRoom(
  client: Pick<MatrixClient, 'getCrypto'>,
  room: Room | null | undefined,
  group?: boolean
): Promise<boolean | undefined> {
  if (room?.getMyMembership() !== 'join') {
    return false
  }

  if (room.hasEncryptionStateEvent()) {
    return true
  }

  const plain = await plainRoomAnswer(client, room)

  if (plain === false || plainAgentRoom(room) || group === true) {
    return true
  }

  return plain === undefined ? undefined : false
}

/**
 * `agentPostRoom` as a guard. A room it refuses keeps the refusal code, which callers treat as
 * final (a routine's post is dropped). A room the crypto store has not answered for in time fails
 * like any passing failure instead, so the post is kept and tried again.
 */
export async function requireAgentPostRoom(
  client: Pick<MatrixClient, 'getCrypto'>,
  room: Room | null | undefined,
  group?: boolean
): Promise<Room> {
  const admitted = await agentPostRoom(client, room, group)

  if (admitted === undefined) {
    throw new Error('matrix_operation_failed')
  }

  if (!admitted || !room) {
    throw new Error('matrix_encrypted_room_required')
  }

  return room
}

/** What kind of room `createConversation` makes, told by what it is asked for. */
type ConversationKind = 'assistant' | 'app_bot' | 'direct' | 'group' | 'app_pair' | 'app_group'

/**
 * Whether a new room of each kind gets end-to-end encryption. Agent, bot, people and group chats
 * do not since 0.20 (owner decisions D1 and D2, 2026-10-09 and 2026-10-10); rooms made before keep
 * theirs. This is the one switch a later private chat or secure tier turns back on: a kind set to
 * true is made exactly as before 0.20 (Megolm, history from joining).
 *
 * An app without a bot (main's `createAppConversation`) is no exception: its pair and its app
 * group are plain too, and `readAppRoom` admits them the way it admits a plain agent chat. Pairs
 * and app groups made before 0.20 keep their encryption and today's rules.
 */
const ENCRYPTED: Record<ConversationKind, boolean> = {
  assistant: false,
  app_bot: false,
  direct: false,
  group: false,
  app_pair: false,
  app_group: false
}

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
const PLAIN_HISTORY: Record<ConversationKind, 'invited' | 'shared'> = {
  assistant: 'invited',
  app_bot: 'invited',
  direct: 'shared',
  group: 'shared',
  app_pair: 'invited',
  app_group: 'shared'
}

function roomEncrypted(kind: ConversationKind): boolean {
  return ENCRYPTED[kind]
}

function conversationKind(
  input: {
    direct?: boolean
    appPair?: boolean
    /** Trusted lifecycle bootstrap only: when the agent creates the room, its
     * owner must receive room-administration power in the create transaction. */
    ownerAdmin?: string
    initialState?: Array<{ type: string; state_key: string }>
  },
  assistant: boolean,
  appGroup: string | undefined
): ConversationKind {
  if (assistant) {
    return 'assistant'
  }

  if (appGroup !== undefined) {
    return 'app_group'
  }

  if (input.appPair) {
    return 'app_pair'
  }

  if (input.initialState?.some(state => state.type === APP_BOT_DM_MARKER && state.state_key === '')) {
    return 'app_bot'
  }

  if (input.direct) {
    return 'direct'
  }

  return 'group'
}

/** One ordinary Matrix room, no Atum room store or parallel membership list. */
export async function createConversation(
  client: MatrixClient,
  input: {
    name: string
    invite: string[]
    direct?: boolean
    /** Main's pair with an app that has no bot (`createAppConversation`); never from the renderer. */
    appPair?: boolean
    /** Trusted lifecycle bootstrap only: when the agent creates the room, its
     * owner must receive room-administration power in the create transaction. */
    ownerAdmin?: string
    initialState?: Array<{ type: string; state_key: string; content: Record<string, unknown> }>
  },
  assistant = false,
  appGroup?: string
) {
  const invite = [...new Set(input.invite)]

  if (
    invite.some(id => id === client.getUserId()) ||
    (input.direct && invite.length !== 1) ||
    (assistant && !input.direct) ||
    (appGroup !== undefined && (assistant || input.direct || invite.length !== 1 || invite[0] !== appGroup)) ||
    (input.appPair && (assistant || !input.direct || appGroup !== undefined || input.initialState !== undefined)) ||
    (input.ownerAdmin !== undefined && (!assistant || !input.direct || invite.length !== 1
      || invite[0] !== input.ownerAdmin))
  ) {
    throw new Error('matrix_invite_invalid')
  }

  const kind = conversationKind(input, assistant, appGroup)
  const encrypted = roomEncrypted(kind)

  return client.createRoom({
    // No explicit DM name: the SDK derives the other participant for each side.
    ...(input.direct ? {} : { name: input.name }),
    invite,
    is_direct: input.direct === true,
    preset: Preset.PrivateChat,
    ...(assistant ? { creation_content: { type: MATRIX_ASSISTANT_ROOM_TYPE } } : {}),
    ...(input.ownerAdmin
      ? { power_level_content_override: {
          users: { [client.getUserId()!]: 100, [input.ownerAdmin]: 100 }
        } }
      : {}),
    ...(appGroup
      ? { creation_content: { type: MATRIX_APP_GROUP_TYPE, [MATRIX_APP_GROUP_BINDING]: { app: appGroup } } }
      : {}),
    initial_state: [
      ...(encrypted
        ? [{ type: EventType.RoomEncryption, state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }]
        : []),
      {
        type: EventType.RoomHistoryVisibility,
        state_key: '',
        content: { history_visibility: encrypted ? 'joined' : PLAIN_HISTORY[kind] }
      },
      // The private_chat preset says guests can join (inert behind an invite-only rule, but wrong on a
      // private chat); the company rooms already refuse them the same way.
      { type: EventType.RoomGuestAccess, state_key: '', content: { guest_access: 'forbidden' } },
      ...(input.initialState ?? [])
    ]
  })
}

/** m.direct is a presentation hint, not a second roster or permission grant. */
export async function rememberDirectConversation(
  client: MatrixClient,
  userId: string,
  roomId: string,
  active: () => boolean = () => true
) {
  // Read SDK account data (server-backed before initial sync). setAccountData
  // waits for sync echo, so the next serialized update observes this write.
  // Matrix account data has no CAS; simultaneous cross-device edits remain
  // last-write-wins metadata, never membership or message loss.
  const current = (await client.getAccountDataFromServer(EventType.Direct)) ?? {}

  if (!active()) {
    return
  }

  const rooms = Array.isArray(current[userId]) ? current[userId] : []
  await client.setAccountData(EventType.Direct, {
    ...current,
    [userId]: [...new Set([...rooms, roomId])]
  })
}

export async function changeConversationMembership(
  client: MatrixClient,
  input: { kind: 'invite' | 'removeMember' | 'ban' | 'unban'; roomId: string; userId: string }
) {
  const room = joinedConversation(client, input.roomId)
  const ownId = client.getSafeUserId()

  if (input.kind === 'invite') {
    if (!room.canInvite(ownId) || input.userId === ownId) {
      throw new Error('matrix_invite_denied')
    }

    await client.invite(input.roomId, input.userId)
  } else {
    const member = conversationMembers(room, ownId).find(member => member.userId === input.userId)

    const allowed =
      input.kind === 'ban' ? member?.canBan : input.kind === 'unban' ? member?.canUnban : member?.canRemove

    if (!allowed) {
      throw new Error('matrix_remove_denied')
    }

    if (input.kind === 'ban') {
      await client.ban(input.roomId, input.userId)
    } else if (input.kind === 'unban') {
      await client.unban(input.roomId, input.userId)
    } else {
      await client.kick(input.roomId, input.userId)
    }
  }
}
