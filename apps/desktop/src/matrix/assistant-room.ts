import { EventType, type IStateEventWithRoomId, type MatrixClient, type Room } from 'matrix-js-sdk'

import {
  decideConversationTurn,
  EarlierConversationError,
  resolveConversationRoom
} from '../../shared/agent-conversation'
import { AGENT_ONE_CONVERSATION } from '../../shared/agent-conversation/enabled'
import type { ConversationResolution, ConversationRoom } from '../../shared/agent-conversation/types'
import type { MatrixGroupRoomRead } from '../../shared/matrix'
import { appGroupBinding, MATRIX_APP_GROUP_TYPE } from '../../shared/matrix-app-room'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'
import { MATRIX_GROUP_AGENT_LIMIT } from '../../shared/matrix-group-room'

import { conversationMarkerFromState, conversationReadFailure } from './conversation-marker'

interface AssistantRoomInput {
  roomId: string
  ownerId: string
  agentId: string
  allowInvite?: boolean
  /** Controller lifecycle recovery only: the agent created the typed room and
   * its owner is still on the exact power-100 invitation. */
  allowOwnerInviteByAgent?: boolean
  forTurn?: boolean
}

interface AssistantRoomSelection {
  resolution: ConversationResolution
  legacy?: string
}

interface AssistantRoomInvitationInput {
  ownerId: string
  agentId: string
  createdBy: 'owner' | 'agent'
  /** Zero performs one synced-state check. A positive bound lets the other creator's sync
   * arrive before this client falls back to making its own room. */
  waitMs?: number
}

const ASSISTANT_INVITE_JOIN_BACKOFF_MS = [0, 100, 250] as const

/** Joining succeeded but the authoritative post-join state could not be validated. Creating a
 * fallback in this state could expose or duplicate a room whose membership is now uncertain. */
export class AssistantRoomAdoptionUncertainError extends Error {
  constructor(cause: unknown) {
    super('matrix_assistant_room_adoption_uncertain', { cause })
  }
}

// Scoped to the SDK client and authenticated pair; discarded with that client.
const selections = new WeakMap<MatrixClient, Map<string, AssistantRoomSelection>>()

/**
 * Read full current server state, not possibly lazy/partial room membership.
 * This first desktop assistant slice is exclusively owner + enrolled agent.
 * A former human room is not eligible either: adding a bot must not expose its
 * old transcript. Matrix keeps left/banned membership state, so reject it too.
 */
export async function readAssistantRoom(
  client: MatrixClient,
  input: AssistantRoomInput,
  active: () => boolean = () => true
): Promise<void> {
  const invitation = client.getRoom(input.roomId)
  const ownId = client.getUserId()

  const invitedBy =
    ownId === input.agentId
      ? input.ownerId
      : input.allowOwnerInviteByAgent === true && ownId === input.ownerId
        ? input.agentId
        : null

  if (input.allowInvite && !input.forTurn && invitedBy && invitation?.getMyMembership() === 'invite') {
    // Invited users cannot read /state on Synapse. The signed stripped state
    // authorizes accepting this exact pair's invitation only, never intake or a turn.
    // After joining, the unchanged full-state gate below must validate privacy,
    // every past/current member and conversation selection before model work.
    if (!active() || !assistantRoomInvitation(invitation, input, invitedBy)) {
      throw new Error('matrix_private_assistant_room_required')
    }

    return
  }

  const state = await readParticipantRoom(client, input, MATRIX_ASSISTANT_ROOM_TYPE, active)

  if (!input.forTurn || !AGENT_ONE_CONVERSATION) {
    return
  }

  const { resolution } = await readAssistantSelection(client, input, active, { roomId: input.roomId, state })
  const decision = decideConversationTurn({ roomId: input.roomId, privateAssistant: true, forTurn: true, resolution })

  if (decision.admit === false) {
    throw new EarlierConversationError(input.roomId, decision.main)
  }
}

/**
 * Adopt the other authorized creator's pending assistant room. Signed stripped state is checked
 * before joining, then full server state is checked after. A failure after join is surfaced;
 * callers must not create a fallback room after an uncertain adoption.
 */
export async function adoptAssistantRoomInvitation(
  client: MatrixClient,
  input: AssistantRoomInvitationInput,
  active: () => boolean = () => true
): Promise<string | null> {
  const creator = input.createdBy === 'owner' ? input.ownerId : input.agentId
  const invitee = input.createdBy === 'owner' ? input.agentId : input.ownerId

  if (client.getUserId() !== invitee || input.ownerId === input.agentId) {
    throw new Error('matrix_private_assistant_room_required')
  }

  const deadline = Date.now() + Math.max(0, input.waitMs ?? 0)
  const attemptedRooms = new Set<string>()

  while (active()) {
    const rooms = client
      .getRooms()
      .filter(candidate => !attemptedRooms.has(candidate.roomId) && assistantRoomInvitation(candidate, input, creator))
      .sort((left, right) => {
        const leftAt = left.currentState.getStateEvents(EventType.RoomCreate, '')?.getTs() ?? 0
        const rightAt = right.currentState.getStateEvents(EventType.RoomCreate, '')?.getTs() ?? 0

        return leftAt - rightAt || left.roomId.localeCompare(right.roomId)
      })

    for (const room of rooms) {
      await readAssistantRoom(
        client,
        {
          roomId: room.roomId,
          ownerId: input.ownerId,
          agentId: input.agentId,
          allowInvite: true,
          ...(input.createdBy === 'agent' ? { allowOwnerInviteByAgent: true } : {})
        },
        active
      )

      if (!active()) {
        throw new Error('matrix_sdk_stopped')
      }

      if (!(await joinAssistantRoom(client, room.roomId, active))) {
        attemptedRooms.add(room.roomId)
        continue
      }

      try {
        const state = await readParticipantRoom(
          client,
          {
            roomId: room.roomId,
            ownerId: input.ownerId,
            agentId: input.agentId,
            allowInvite: false
          },
          MATRIX_ASSISTANT_ROOM_TYPE,
          active
        )

        if (input.createdBy === 'agent' && !agentCreatedAssistantState(state, input)) {
          throw new Error('matrix_private_assistant_room_required')
        }
      } catch (error) {
        throw new AssistantRoomAdoptionUncertainError(error)
      }

      return room.roomId
    }

    if (Date.now() >= deadline) {
      return null
    }

    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
  }

  throw new Error('matrix_sdk_stopped')
}

/** A sync-visible invitation may race propagation across the homeserver. Retry briefly, then let
 * the next validated candidate (or ordinary owner creation) proceed. */
async function joinAssistantRoom(
  client: MatrixClient,
  roomId: string,
  active: () => boolean
): Promise<boolean> {
  for (const delay of ASSISTANT_INVITE_JOIN_BACKOFF_MS) {
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay))
    }

    if (!active()) {
      throw new Error('matrix_sdk_stopped')
    }

    try {
      await client.joinRoom(roomId)

      return true
    } catch {
      if (!active()) {
        throw new Error('matrix_sdk_stopped')
      }
    }
  }

  return false
}

/** The signed stripped state for either direction of the authorized first-room handshake. */
function assistantRoomInvitation(
  room: Room,
  input: Pick<AssistantRoomInvitationInput, 'ownerId' | 'agentId'>,
  creator: string
): boolean {
  const invitee = creator === input.ownerId ? input.agentId : input.ownerId
  const creation = room.currentState.getStateEvents(EventType.RoomCreate, '')
  const members = room.currentState.getStateEvents(EventType.RoomMember)
  const creatorMember = members.find(event => event.getStateKey() === creator)
  const invitation = members.find(event => event.getStateKey() === invitee)

  return (
    room.getMyMembership() === 'invite' &&
    input.ownerId !== input.agentId &&
    [input.ownerId, input.agentId].includes(creator) &&
    creation?.getContent().type === MATRIX_ASSISTANT_ROOM_TYPE &&
    creation.getSender() === creator &&
    members.length === 2 &&
    creatorMember?.getContent().membership === 'join' &&
    invitation?.getContent().membership === 'invite' &&
    invitation.getSender() === creator
  )
}

/** The controller-created direction additionally proves the owner retained room administration. */
function agentCreatedAssistantState(
  state: Awaited<ReturnType<MatrixClient['roomState']>>,
  input: Pick<AssistantRoomInvitationInput, 'ownerId' | 'agentId'>
): boolean {
  const creation = state.find(event => event.type === EventType.RoomCreate && event.state_key === '')
  const power = state.find(event => event.type === EventType.RoomPowerLevels && event.state_key === '')

  return (
    creation?.sender === input.agentId &&
    power?.content.users?.[input.ownerId] === 100 &&
    power.content.users?.[input.agentId] === 100
  )
}

/** The actual command reader shares the private-room gate with admission. */
export async function readConversationMarker(
  client: MatrixClient,
  input: AssistantRoomInput,
  active: () => boolean = () => true
) {
  const state = await readParticipantRoom(client, input, MATRIX_ASSISTANT_ROOM_TYPE, active)

  return conversationMarkerFromState(state, input)
}

/**
 * The owner's private room with the agent, from the server's list of the owner's joined rooms
 * rather than the last sync: a room made just before a quit is found even before it syncs, so
 * creating an agent never makes a second room. A synced room's type is known and immutable;
 * only candidates (the assistant type, or not synced yet) are read from the server.
 */
export async function findAssistantRoom(
  client: MatrixClient,
  input: { ownerId: string; agentId: string; allowOwnerInviteByAgent?: boolean },
  active: () => boolean = () => true
): Promise<string | null> {
  const selection = await readAssistantSelection(client, input, active)

  return selection.resolution.main ?? selection.legacy ?? null
}

async function readAssistantSelection(
  client: MatrixClient,
  input: { ownerId: string; agentId: string; allowOwnerInviteByAgent?: boolean },
  active: () => boolean,
  alreadyRead?: { roomId: string; state: Awaited<ReturnType<MatrixClient['roomState']>> }
): Promise<AssistantRoomSelection> {
  if (!active()) {
    throw new Error('matrix_sdk_stopped')
  }

  const key = JSON.stringify([input.ownerId, input.agentId])
  const cache = selections.get(client) ?? new Map<string, AssistantRoomSelection>()
  selections.set(client, cache)
  const previous = cache.get(key)
  let joined: string[]

  try {
    joined = (await client.getJoinedRooms()).joined_rooms
  } catch {
    if (!active()) {
      throw new Error('matrix_sdk_stopped')
    }

    return { resolution: resolveConversationRoom([{ roomId: '', read: 'transient' }], previous?.resolution), legacy: previous?.legacy }
  }

  const rooms: ConversationRoom[] = []
  const eligible: Array<{ roomId: string; state: Awaited<ReturnType<MatrixClient['roomState']>> }> = []
  const ids = new Set(joined)

  if (alreadyRead) {
    ids.add(alreadyRead.roomId)
  }

  // A synced room's type is known and immutable: only candidates are read from the server,
  // all at once (one round trip rather than one per room, so a send never waits on a queue of
  // reads). They are then weighed in room order, as before.
  const candidates = [...ids].sort().filter(roomId => {
    const room = client.getRoom(roomId)

    return (
      alreadyRead?.roomId === roomId ||
      !room?.currentState.getStateEvents(EventType.RoomCreate, '') ||
      room.getType() === MATRIX_ASSISTANT_ROOM_TYPE
    )
  })

  const read = async (roomId: string) => {
    try {
      const state =
        alreadyRead?.roomId === roomId
          ? alreadyRead.state
          : await readParticipantRoom(
              client,
              {
                roomId,
                ownerId: input.ownerId,
                agentId: input.agentId,
                allowInvite: true,
                ...(input.allowOwnerInviteByAgent ? { allowOwnerInviteByAgent: true } : {})
              },
              MATRIX_ASSISTANT_ROOM_TYPE,
              active
            )

      return { roomId, ok: true, state } as const
    } catch (error) {
      return { roomId, ok: false, error } as const
    }
  }

  if (!AGENT_ONE_CONVERSATION) {
    // The point-release rollback retains legacy first-valid discovery, one room at a time.
    for (const roomId of candidates) {
      if (!active()) {
        throw new Error('matrix_sdk_stopped')
      }

      if ((await read(roomId)).ok) {
        return { resolution: resolveConversationRoom([]), legacy: roomId }
      }
    }
  }

  const reads = AGENT_ONE_CONVERSATION ? await Promise.all(candidates.map(read)) : []

  for (const result of reads) {
    if (!active()) {
      throw new Error('matrix_sdk_stopped')
    }

    const { roomId } = result

    if (result.ok) {
      eligible.push({ roomId, state: result.state })
      rooms.push({ roomId, read: 'readable', marker: conversationMarkerFromState(result.state, { roomId, ownerId: input.ownerId }) })

      continue
    }

    const { error } = result

    if (error instanceof Error && error.message === 'matrix_private_assistant_room_required') {
      continue // A group, former-member room, or another agent's room never contributes a marker.
    }

    rooms.push({ roomId, read: conversationReadFailure(error) })
  }

  if (!active()) {
    throw new Error('matrix_sdk_stopped')
  }

  const resolution = resolveConversationRoom(rooms, previous?.resolution)
  const transient = rooms.some(room => room.read === 'transient')
  const selection = {
    resolution,
    legacy: transient ? previous?.legacy : preferredLegacyAssistantRoom(client, eligible, input.ownerId)
  }

  if (!transient) {
    cache.set(key, selection)
  }

  return selection
}

/** Before conversation markers existed, prefer the room people actually used. A cached message
 * wins, then a room the owner joined, then the owner-created direction; room id is only the final
 * deterministic tie-breaker. This prevents a controller restart from reviving an empty duplicate. */
function preferredLegacyAssistantRoom(
  client: MatrixClient,
  candidates: ReadonlyArray<{ roomId: string; state: Awaited<ReturnType<MatrixClient['roomState']>> }>,
  ownerId: string
): string | undefined {
  const ranked = candidates.map(candidate => {
    const events = client.getRoom(candidate.roomId)?.getLiveTimeline().getEvents() ?? []
    const messages = events.filter(event =>
      [EventType.RoomMessage, EventType.RoomMessageEncrypted].includes(event.getType() as EventType)
    )
    const ownerJoined = candidate.state.some(
      event =>
        event.type === EventType.RoomMember &&
        event.state_key === ownerId &&
        event.content.membership === 'join'
    )
    const ownerCreated = candidate.state.some(
      event => event.type === EventType.RoomCreate && event.state_key === '' && event.sender === ownerId
    )

    return {
      roomId: candidate.roomId,
      messageAt: messages.reduce((at, event) => Math.max(at, event.getTs()), 0),
      ownerJoined,
      ownerCreated
    }
  })

  ranked.sort((left, right) =>
    Number(right.messageAt > 0) - Number(left.messageAt > 0) ||
    right.messageAt - left.messageAt ||
    Number(right.ownerJoined) - Number(left.ownerJoined) ||
    Number(right.ownerCreated) - Number(left.ownerCreated) ||
    left.roomId.localeCompare(right.roomId)
  )

  return ranked[0]?.roomId
}

/**
 * A retired agent's chat with the owner, read from the server's full room state before this
 * client leaves and forgets it: an assistant room, or a direct chat, whose every member, past
 * or present, is the owner or that agent. A room anyone else was ever in (a group, an app's
 * room, a company project) is never one, whatever the last sync showed. An untyped room counts
 * only when the owner's direct chats (`m.direct`) list it with that agent. The owner must still
 * have joined it.
 */
export async function readRetiredAgentRoom(
  client: MatrixClient,
  input: { roomId: string; ownerId: string; agentId: string },
  active: () => boolean = () => true
): Promise<void> {
  // A host that stopped or lost sync says nothing about the room: a failure that may pass.
  if (!active()) {
    throw new Error('matrix_sdk_stopped')
  }

  if (client.getUserId() !== input.ownerId || input.ownerId === input.agentId) {
    throw new Error('matrix_retired_agent_room_required')
  }

  const state = await client.roomState(input.roomId)

  if (!active()) {
    throw new Error('matrix_sdk_stopped')
  }

  const members = state.filter(e => e.type === EventType.RoomMember)
  const creation = state.find(e => e.type === EventType.RoomCreate && e.state_key === '')
  const type = creation?.content.type
  const pair = new Set([input.ownerId, input.agentId])

  if (
    !creation ||
    (type !== MATRIX_ASSISTANT_ROOM_TYPE && (type !== undefined || !directWith(client, input))) ||
    members.some(e => !pair.has(e.state_key)) ||
    // An invitation by email waiting for someone else is a person in it too.
    state.some(e => e.type === EventType.RoomThirdPartyInvite && Object.keys(e.content ?? {}).length > 0) ||
    !members.some(e => e.state_key === input.ownerId && e.content.membership === 'join') ||
    !members.some(e => e.state_key === input.agentId)
  ) {
    throw new Error('matrix_retired_agent_room_required')
  }
}

/** The owner's own list of direct chats (`m.direct`) names this room with the agent. */
function directWith(client: MatrixClient, input: { roomId: string; agentId: string }): boolean {
  const direct: unknown = client.getAccountData(EventType.Direct)?.getContent()?.[input.agentId]

  return Array.isArray(direct) && direct.includes(input.roomId)
}

const MEGOLM = 'm.megolm.v1.aes-sha2'

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
const PLAIN_GROUP_HISTORY = new Set<unknown>(['joined', 'invited', 'shared'])

/**
 * The encryption and history a participant room needs. With encryption, today's rule: Megolm,
 * and history only from joining. Without it (0.20): an agent's private room, or an app's pair
 * with its owner (`readAppRoom`, an untyped room), with history from the invitation (as they are
 * made, so the owner's first message reaches one that has not joined yet) or from joining; or an
 * app group, with any history a plain group may show (never `world_readable`).
 */
function participantRoomPrivacy(
  encryption: IStateEventWithRoomId | undefined,
  history: unknown,
  roomType: string | undefined,
  appGroup: boolean
): boolean {
  if (encryption) {
    return encryption.content.algorithm === MEGOLM && history === 'joined'
  }

  if (appGroup) {
    return PLAIN_GROUP_HISTORY.has(history)
  }

  return (roomType === MATRIX_ASSISTANT_ROOM_TYPE || roomType === undefined) && (history === 'invited' || history === 'joined')
}

/** Private pair or a fresh owner-created, app-bound group. Never widen a DM. */
export async function readAppRoom(
  client: MatrixClient,
  input: { roomId: string; ownerId: string; agentId: string; allowInvite?: boolean },
  active: () => boolean = () => true
): Promise<void> {
  await readParticipantRoom(client, input, undefined, active)
}

async function readParticipantRoom(
  client: MatrixClient,
  input: {
    roomId: string
    ownerId: string
    agentId: string
    allowInvite?: boolean
    allowOwnerInviteByAgent?: boolean
  },
  roomType: string | undefined,
  active: () => boolean
): Promise<Awaited<ReturnType<MatrixClient['roomState']>>> {
  const ownId = client.getUserId()

  if (!active() || ![input.ownerId, input.agentId].includes(ownId ?? '') || input.ownerId === input.agentId) {
    throw new Error('matrix_private_assistant_room_required')
  }

  const state = await client.roomState(input.roomId)
  const members = state.filter(e => e.type === EventType.RoomMember)
  const creation = state.find(e => e.type === EventType.RoomCreate && e.state_key === '')
  const encryption = state.find(e => e.type === EventType.RoomEncryption && e.state_key === '')
  const history = state.find(e => e.type === EventType.RoomHistoryVisibility && e.state_key === '')
  const power = state.find(e => e.type === EventType.RoomPowerLevels && e.state_key === '')
  const group = roomType === undefined && creation?.content.type === MATRIX_APP_GROUP_TYPE
  const binding = creation && appGroupBinding(creation.content, creation.sender)
  const ownerMember = members.find(e => e.state_key === input.ownerId)

  const lifecycleOwnerInvite = input.allowOwnerInviteByAgent === true && ownId === input.agentId &&
    creation?.sender === input.agentId && ownerMember?.content.membership === 'invite' &&
    ownerMember.sender === input.agentId && power?.content.users?.[input.ownerId] === 100 &&
    power.content.users?.[input.agentId] === 100

  if (
    !active() ||
    !creation ||
    (group ? binding?.owner !== input.ownerId || binding?.app !== input.agentId : creation.content.type !== roomType) ||
    !participantRoomPrivacy(encryption, history?.content.history_visibility, roomType, group) ||
    (!group && members.length !== 2) ||
    !(ownerMember?.content.membership === 'join' || lifecycleOwnerInvite) ||
    !members.some(
      e =>
        e.state_key === input.agentId &&
        (e.content.membership === 'join' || (input.allowInvite && e.content.membership === 'invite'))
    )
  ) {
    throw new Error('matrix_private_assistant_room_required')
  }

  return state
}

/**
 * Don't turn an assistant's transcript into a human group through this client: no person is
 * invited into an assistant's private room, and none of the owner's assistants is invited
 * this way at all (they join groups through `inviteAgent`, as their owner's own act). A
 * room that holds, or held, one of the owner's assistants takes new people only when it is
 * an ordinary group. An encrypted one must show newcomers nothing sent before they joined
 * (`history_visibility: joined`): one that shows more is an older private transcript. A group
 * without encryption (every group since 0.20) shows its members the group's history, as the
 * owner chose (2026-10-10).
 */
export async function requireHumanInvitation(
  client: MatrixClient,
  input: { roomId: string; userId: string; agentId?: string; agentIds?: readonly string[] },
  active: () => boolean
) {
  const agents = new Set([input.agentId, ...(input.agentIds ?? [])].filter((id): id is string => Boolean(id)))

  if (agents.has(input.userId)) {
    throw new Error('matrix_private_assistant_room_required')
  }

  const state = await client.roomState(input.roomId)
  const creation = state.find(e => e.type === EventType.RoomCreate && e.state_key === '')
  const encryption = state.find(e => e.type === EventType.RoomEncryption && e.state_key === '')
  const visibility = state.find(e => e.type === EventType.RoomHistoryVisibility && e.state_key === '')
  const history: unknown = visibility?.content.history_visibility
  const heldAgent = state.some(e => e.type === EventType.RoomMember && agents.has(e.state_key ?? ''))

  if (
    !active() ||
    creation?.content.type === MATRIX_ASSISTANT_ROOM_TYPE ||
    (heldAgent &&
      (!creation ||
        creation.content.type !== undefined ||
        !(encryption ? history === 'joined' : PLAIN_GROUP_HISTORY.has(history))))
  ) {
    throw new Error('matrix_private_assistant_room_required')
  }
}

/** The room state that makes an ordinary group (shared/matrix-group-room.ts): its create event
 * has no type (never a private, app or company room). An encrypted one is Megolm-encrypted and
 * newcomers see only what is sent after they join, as before 0.20. One without encryption (every
 * group since 0.20) shows its members the group's history, never anyone outside it. */
function groupState(state: Awaited<ReturnType<MatrixClient['roomState']>>) {
  const creation = state.find(e => e.type === EventType.RoomCreate && e.state_key === '')
  const encryption = state.find(e => e.type === EventType.RoomEncryption && e.state_key === '')
  const visibility = state.find(e => e.type === EventType.RoomHistoryVisibility && e.state_key === '')
  const history: unknown = visibility?.content.history_visibility

  const memberEvents = state.filter(e => e.type === EventType.RoomMember && typeof e.state_key === 'string')

  const members = memberEvents.map(e => ({
    userId: e.state_key as string,
    membership: String(e.content.membership ?? ''),
    membershipEventId: e.event_id
  }))

  return {
    direct: memberEvents.some(e => e.content.is_direct === true),
    group:
      Boolean(creation) &&
      creation!.content.type === undefined &&
      (encryption ? encryption.content.algorithm === MEGOLM && history === 'joined' : PLAIN_GROUP_HISTORY.has(history)),
    members
  }
}

/**
 * A group one of the owner's assistants answers in, read in full from the server by the
 * owner's SDK before every group turn (and the agent invitation): an ordinary group, with or
 * without encryption (groupState), with the owner in it and the agent in it (or, while being
 * added, invited).
 * Returns who is in it now, from which main decides the group's mode
 * (shared/matrix-group-room.ts). Never an assistant's private room: that keeps its own check.
 */
export async function readGroupRoom(
  client: MatrixClient,
  input: { roomId: string; ownerId: string; agentId: string; allowInvite?: boolean },
  active: () => boolean = () => true
): Promise<MatrixGroupRoomRead> {
  if (!active() || client.getUserId() !== input.ownerId || input.ownerId === input.agentId) {
    throw new Error('matrix_group_room_required')
  }

  const { direct, group, members } = groupState(await client.roomState(input.roomId))
  const membership = (userId: string) => members.find(member => member.userId === userId)?.membership
  const present = members.filter(member => ['join', 'invite'].includes(member.membership))

  if (
    !active() ||
    !group ||
    // A chat made as a direct one, from before private rooms had their type, with only the
    // owner and the agent in it, is the agent's private chat: never a group.
    (present.length <= 2 && (direct || listedDirect(client, input.roomId))) ||
    membership(input.ownerId) !== 'join' ||
    !(membership(input.agentId) === 'join' || (input.allowInvite && membership(input.agentId) === 'invite'))
  ) {
    throw new Error('matrix_group_room_required')
  }

  return { members: present }
}

/** The room is in this account's own list of direct chats (`m.direct`). */
function listedDirect(client: MatrixClient, roomId: string): boolean {
  const direct = client.getAccountData(EventType.Direct)?.getContent<Record<string, unknown>>() ?? {}

  return Object.values(direct).some(rooms => Array.isArray(rooms) && rooms.includes(roomId))
}

/**
 * A private chat, never a group, from this client's synced state: a room made as a direct chat
 * (this account's `m.direct`, or `is_direct` on its invitation or a member's event) with no
 * more than two people in it. An assistant's private chat from before private rooms had their
 * type looks like a group otherwise; its keys and its turns keep their private-room rules.
 */
export function isMatrixPrivateChat(client: MatrixClient, room: Room): boolean {
  if (room.getInvitedAndJoinedMemberCount() > 2) {
    return false
  }

  return (
    listedDirect(client, room.roomId) ||
    Boolean(room.getDMInviter()) ||
    room.getMembers().some(member => member.events.member?.getContent().is_direct === true)
  )
}

/**
 * The owner adds one of their own assistants to a group, from their own SDK (so only the
 * owner ever adds their assistant). The room must be an ordinary group the owner is in and may
 * invite to, holding fewer than MATRIX_GROUP_AGENT_LIMIT of the owner's assistants. An
 * assistant already invited is left invited: main then only asks it to join again.
 */
export async function inviteAgentToGroup(
  client: MatrixClient,
  input: { roomId: string; userId: string; agentIds: readonly string[] },
  active: () => boolean
): Promise<void> {
  const owner = client.getUserId()
  const room = client.getRoom(input.roomId)

  if (!owner || !input.agentIds.includes(input.userId) || input.userId === owner) {
    throw new Error('matrix_group_room_required')
  }

  const { group, members } = groupState(await client.roomState(input.roomId))
  const present = members.filter(member => ['join', 'invite'].includes(member.membership))
  const own = new Set(present.filter(member => input.agentIds.includes(member.userId)).map(member => member.userId))
  const current = present.find(member => member.userId === input.userId)?.membership

  if (
    !active() ||
    !group ||
    !present.some(member => member.userId === owner && member.membership === 'join') ||
    !room?.canInvite(owner)
  ) {
    throw new Error('matrix_group_room_required')
  }

  if (current === 'join' || current === 'invite') {
    return
  }

  if (own.size >= MATRIX_GROUP_AGENT_LIMIT) {
    throw new Error('matrix_group_agents_full')
  }

  await client.invite(input.roomId, input.userId)
}
