import {
  ClientEvent,
  Direction,
  EventType,
  type IStateEventWithRoomId,
  type MatrixClient,
  MatrixEvent,
  MsgType,
  Preset,
  type Room,
  RoomEvent
} from 'matrix-js-sdk'

import {
  AGENT_TASK_TEXT_MAX_BYTES,
  agentTaskBinding,
  type AgentTaskBinding,
  agentTaskBindingWire,
  agentTaskCoordinatedBinding,
  agentTaskCoordinator,
  agentTaskCoordinatorWire,
  type AgentTaskEvent,
  agentTaskEventId,
  agentTaskMessage,
  agentTaskMessageSender,
  agentTaskMessageWire,
  type AgentTaskOwnedAgent,
  type AgentTaskRoom,
  agentTaskRoomId,
  agentTaskStartPointer,
  agentTaskState,
  type AgentTaskWatch,
  MATRIX_AGENT_TASK_COORDINATOR_TYPE,
  MATRIX_AGENT_TASK_KEY,
  MATRIX_AGENT_TASK_ROOM_TYPE,
  MATRIX_AGENT_TASK_START_TYPE
} from '../../shared/agent-task'
import type { MatrixInvocationHint, MatrixInvocationScan } from '../../shared/matrix'
import { createMatrixSyncHealth } from '../../shared/matrix-sync-health'

const PAGE_SIZE = 50
const PAGE_LIMIT = 4

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function coordinatedBinding(
  binding: AgentTaskBinding,
  event: { sender?: string; content?: unknown } | undefined
): AgentTaskBinding | undefined {
  if (!event) {return binding}
  const coordinator = agentTaskCoordinator(event.content)

  return event.sender === binding.owner && coordinator
    ? agentTaskCoordinatedBinding(binding, coordinator)
    : undefined
}

function validTaskPower(content: unknown, binding: AgentTaskBinding): boolean {
  if (!object(content) || !object(content.users) || !object(content.events) || !object(content.notifications)) {return false}
  const users = content.users
  const events = content.events

  return users[binding.owner] === 100 && users[binding.originUser] === 50 &&
    Object.entries(users).every(([user, level]) =>
      (user === binding.owner && level === 100) || (user === binding.originUser && level === 50) || level === 0) &&
    content.users_default === 0 && content.events_default === 0 && content.state_default === 100 &&
    events[MATRIX_AGENT_TASK_START_TYPE] === 50 && events[MATRIX_AGENT_TASK_COORDINATOR_TYPE] === 100 &&
    content.invite === 50 && content.kick === 100 && content.ban === 100 && content.redact === 100 &&
    content.notifications.room === 100
}

export function agentTaskRoomBinding(room: Room): AgentTaskBinding | undefined {
  const creation = room.currentState.getStateEvents(EventType.RoomCreate, '')

  if (room.getType() !== MATRIX_AGENT_TASK_ROOM_TYPE || !creation) {return undefined}

  const created = agentTaskBinding(creation.getContent()[MATRIX_AGENT_TASK_KEY])

  if (!created || creation.getSender() !== created.originUser) {return undefined}

  const pointer = room.currentState.getStateEvents(MATRIX_AGENT_TASK_COORDINATOR_TYPE, created.taskId)
  const binding = coordinatedBinding(created, pointer
    ? { sender: pointer.getSender(), content: pointer.getContent() }
    : undefined)

  return binding
}

function expectedMembers(binding: AgentTaskBinding): Set<string> {
  return new Set([binding.owner, binding.originUser, binding.targetUser, binding.mainUser])
}

function memberState(state: IStateEventWithRoomId[], userId: string) {
  return state.find(event => event.type === EventType.RoomMember && event.state_key === userId)
}

type AgentTaskRoomInput = {
  roomId: string
  ownerId: string
  agentPrincipal: string
  agentUserId: string
  allowInvite?: boolean
  ownedAgents?: readonly AgentTaskOwnedAgent[]
}

/**
 * The server may hide full state until an invited agent joins. In that narrow
 * interval, admit only the creator's immutable binding and this account's own
 * invitation from the synced room state. The creator has to be an exact entry
 * in the owner's authoritative roster; no room-supplied owner claim is enough.
 */
function invitedTaskBinding(
  room: Room,
  input: Pick<AgentTaskRoomInput, 'ownerId' | 'ownedAgents'>,
  invitedUserId: string
): AgentTaskBinding | undefined {
  const creation = room.currentState.getStateEvents(EventType.RoomCreate, '')
  const created = creation && agentTaskBinding(creation.getContent()[MATRIX_AGENT_TASK_KEY])
  const invitation = room.currentState.getStateEvents(EventType.RoomMember, invitedUserId)
  const trustedOrigin = created && input.ownedAgents?.some(agent =>
    agent.principal === created.originPrincipal && agent.userId === created.originUser)

  if (
    room.getType() !== MATRIX_AGENT_TASK_ROOM_TYPE ||
    room.getMyMembership() !== 'invite' ||
    !creation ||
    creation.getContent().type !== MATRIX_AGENT_TASK_ROOM_TYPE ||
    !created ||
    created.owner !== input.ownerId ||
    creation.getSender() !== created.originUser ||
    !trustedOrigin ||
    invitation?.getContent().membership !== 'invite'
  ) {
    return undefined
  }

  return created
}

function invitedAgentTaskBinding(room: Room, input: AgentTaskRoomInput): AgentTaskBinding | undefined {
  const binding = invitedTaskBinding(room, input, input.agentUserId)
  const invitation = room.currentState.getStateEvents(EventType.RoomMember, input.agentUserId)
  const participant = (value: AgentTaskBinding) =>
    expectedMembers(value).has(input.agentUserId) && (
      (value.originUser === input.agentUserId && value.originPrincipal === input.agentPrincipal) ||
      (value.targetUser === input.agentUserId && value.targetPrincipal === input.agentPrincipal) ||
      (value.mainUser === input.agentUserId && value.mainPrincipal === input.agentPrincipal)
    )
  const ownRosterEntry = input.ownedAgents?.some(agent =>
    agent.principal === input.agentPrincipal && agent.userId === input.agentUserId)

  if (binding && invitation?.getSender() === binding.originUser && participant(binding)) {return binding}
  // Stripped invite state carries create and this membership, not custom coordinator state.
  // An owner replacement invite may therefore join only an exact, already-rostered agent;
  // the mandatory post-join full read proves the owner-signed coordinator before intake.
  if (binding && invitation?.getSender() === binding.owner && ownRosterEntry) {return binding}

  return undefined
}

/** Full server-state admission for a hidden task room. */
export async function readAgentTaskRoom(
  client: MatrixClient,
  input: AgentTaskRoomInput,
  active: () => boolean = () => true
): Promise<AgentTaskBinding> {
  if (!active() || !agentTaskRoomId(input.roomId) || client.getUserId() !== input.agentUserId) {
    throw new Error('matrix_agent_task_room_required')
  }

  const invited = input.allowInvite ? client.getRoom?.(input.roomId) : undefined
  if (invited?.getMyMembership() === 'invite') {
    const binding = invitedAgentTaskBinding(invited, input)
    if (!binding || !active()) {throw new Error('matrix_agent_task_room_required')}

    return binding
  }

  const state = await client.roomState(input.roomId)
  const creation = state.find(event => event.type === EventType.RoomCreate && event.state_key === '')
  const created = agentTaskBinding(creation?.content?.[MATRIX_AGENT_TASK_KEY])
  const coordinatorEvents = created
    ? state.filter(event => event.type === MATRIX_AGENT_TASK_COORDINATOR_TYPE && event.state_key === created.taskId)
    : []
  const binding = created && coordinatorEvents.length <= 1
    ? coordinatedBinding(created, coordinatorEvents[0])
    : undefined
  const history = state.find(event => event.type === EventType.RoomHistoryVisibility && event.state_key === '')
  const power = state.find(event => event.type === EventType.RoomPowerLevels && event.state_key === '')
  const members = state.filter(event => event.type === EventType.RoomMember)

  if (
    !active() ||
    !creation ||
    creation.content.type !== MATRIX_AGENT_TASK_ROOM_TYPE ||
    !created ||
    creation.sender !== created.originUser ||
    !binding ||
    binding.owner !== input.ownerId ||
    !power ||
    !validTaskPower(power.content, created) ||
    state.some(event => event.type === EventType.RoomEncryption) ||
    history?.content?.history_visibility !== 'invited' ||
    !expectedMembers(binding).has(input.agentUserId) ||
    !(
      (binding.originUser === input.agentUserId && binding.originPrincipal === input.agentPrincipal) ||
      (binding.targetUser === input.agentUserId && binding.targetPrincipal === input.agentPrincipal) ||
      (binding.mainUser === input.agentUserId && binding.mainPrincipal === input.agentPrincipal)
    ) ||
    members.some(event =>
      ['invite', 'join'].includes(String(event.content?.membership)) &&
      !expectedMembers(binding).has(event.state_key ?? '')) ||
    [...expectedMembers(binding)].some(userId => !memberState(state, userId)) ||
    [...expectedMembers(binding)].some(userId =>
      !['invite', 'join'].includes(String(memberState(state, userId)?.content?.membership))) ||
    !['join', ...(input.allowInvite ? ['invite'] : [])].includes(String(memberState(state, input.agentUserId)?.content?.membership))
  ) {
    throw new Error('matrix_agent_task_room_required')
  }

  return binding
}

function taskEvent(raw: unknown, binding: AgentTaskBinding): AgentTaskEvent | undefined {
  const event = new MatrixEvent(raw as never)
  const content = event.getContent()
  const marker = agentTaskMessage(content[MATRIX_AGENT_TASK_KEY])
  const eventId = event.getId()
  const sender = event.getSender()

  if (
    event.getType() !== EventType.RoomMessage ||
    event.isRedacted() ||
    event.isRelation('m.replace') ||
    content.msgtype !== MsgType.Text ||
    typeof content.body !== 'string' ||
    !content.body.trim() ||
    new TextEncoder().encode(content.body).byteLength > AGENT_TASK_TEXT_MAX_BYTES ||
    !marker ||
    marker.taskId !== binding.taskId ||
    (marker.kind === 'start' && marker.at !== binding.createdAt) ||
    !agentTaskEventId(eventId) ||
    typeof sender !== 'string'
  ) {
    return undefined
  }

  const serverAt = event.getTs()
  const value = {
    ...marker,
    eventId,
    sender,
    body: content.body,
    ...(Number.isSafeInteger(serverAt) && serverAt >= 0 ? { serverAt } : {})
  }

  return agentTaskMessageSender(binding, value) ? value : undefined
}

async function events(client: MatrixClient, roomId: string, binding: AgentTaskBinding): Promise<AgentTaskEvent[]> {
  const values: AgentTaskEvent[] = []
  const eventIds = new Set<string>()
  const tokens = new Set<string>()
  let from: string | null = null

  // A bounded backward scan alone can lose the start after enough status/control traffic.
  // New rooms pin that exact event in authenticated room state; old rooms retain the scan fallback.
  const state = await client.roomState(roomId)
  const pointerEvent = state.find(event => event.type === MATRIX_AGENT_TASK_START_TYPE && event.state_key === binding.taskId)
  if (pointerEvent) {
    const pointer = agentTaskStartPointer(pointerEvent.content)
    if (!pointer || pointer.taskId !== binding.taskId || pointerEvent.sender !== binding.originUser) {
      throw new Error('matrix_agent_task_invalid')
    }
    const start = taskEvent(await client.fetchRoomEvent(roomId, pointer.eventId), binding)
    if (!start || start.kind !== 'start' || start.eventId !== pointer.eventId) {
      throw new Error('matrix_agent_task_invalid')
    }
    values.push(start)
    eventIds.add(start.eventId)
  }

  for (let page = 0; page < PAGE_LIMIT; page++) {
    const result = await client.createMessagesRequest(roomId, from, PAGE_SIZE, Direction.Backward)

    if (!Array.isArray(result.chunk) || result.chunk.length > PAGE_SIZE) {
      throw new Error('matrix_agent_task_invalid')
    }

    for (const raw of result.chunk) {
      const value = taskEvent(raw, binding)
      if (value && !eventIds.has(value.eventId)) {
        values.push(value)
        eventIds.add(value.eventId)
      }
    }

    if (!result.end || result.chunk.length < PAGE_SIZE) {break}
    if (tokens.has(result.end)) {throw new Error('matrix_agent_task_invalid')}
    tokens.add(result.end)
    from = result.end
  }

  return values
}

/** Join only a fully validated task invitation, then return every task this agent participates in. */
export async function reconcileAgentTaskRooms(
  client: MatrixClient,
  input: Omit<AgentTaskRoomInput, 'roomId' | 'allowInvite'> & { taskId?: string },
  active: () => boolean = () => true
): Promise<Array<{ roomId: string; binding: AgentTaskBinding }>> {
  const result: Array<{ roomId: string; binding: AgentTaskBinding }> = []

  for (const room of client.getRooms()) {
    if (room.getType() !== MATRIX_AGENT_TASK_ROOM_TYPE || !['invite', 'join'].includes(room.getMyMembership())) {continue}
    // Local create state selects candidates only. Exact retry/read lookups must not fetch every
    // historical task; matching rooms still pass full server-state admission below.
    if (input.taskId !== undefined && agentTaskRoomBinding(room)?.taskId !== input.taskId) {continue}

    try {
      let binding = await readAgentTaskRoom(client, { roomId: room.roomId, ...input, allowInvite: true }, active)

      if (room.getMyMembership() === 'invite') {
        await client.joinRoom(room.roomId)
        binding = await readAgentTaskRoom(client, { roomId: room.roomId, ...input }, active)
      }

      result.push({ roomId: room.roomId, binding })
    } catch {
      // An unrelated typed room or invitation grants nothing and remains untouched.
    }
  }

  return result.sort((a, b) => a.binding.createdAt - b.binding.createdAt || a.roomId.localeCompare(b.roomId))
}

export async function listAgentTaskRooms(
  client: MatrixClient,
  input: Omit<AgentTaskRoomInput, 'roomId' | 'allowInvite'> & { taskId?: string },
  active: () => boolean = () => true
): Promise<AgentTaskRoom[]> {
  const rooms = await reconcileAgentTaskRooms(client, input, active)
  const result: AgentTaskRoom[] = []

  for (const room of rooms) {
    const history = (await events(client, room.roomId, room.binding)).filter(event =>
      agentTaskMessageSender(room.binding, event)
    )
    const state = agentTaskState(history, room.binding.expiresAt)

    result.push({ roomId: room.roomId, binding: room.binding, ...state })
  }

  return result
}

/** Return one exact durable task, or a bounded newest-first list for management UI/tools. */
export async function queryAgentTaskRooms(
  client: MatrixClient,
  input: {
    ownerId: string
    agentPrincipal: string
    agentUserId: string
    ownedAgents?: readonly AgentTaskOwnedAgent[]
    taskId?: string
    limit?: number
  },
  active: () => boolean = () => true
): Promise<AgentTaskRoom[]> {
  const rooms = await listAgentTaskRooms(client, input, active)

  if (input.taskId !== undefined) {
    // Preserve the exact server-validated identity, not just the local candidate hint.
    return rooms.filter(room => room.binding.taskId === input.taskId).slice(0, 1)
  }

  const limit = Number.isSafeInteger(input.limit) ? Math.max(1, Math.min(Number(input.limit), 100)) : 100

  return rooms
    .sort((left, right) => right.updatedAt - left.updatedAt || right.binding.createdAt - left.binding.createdAt)
    .slice(0, limit)
}

export async function createAgentTaskRoom(
  client: MatrixClient,
  input: { binding: AgentTaskBinding; prompt: string },
  active: () => boolean = () => true
): Promise<AgentTaskRoom> {
  const binding = agentTaskBinding(agentTaskBindingWire(input.binding))

  if (
    !active() ||
    !binding ||
    client.getUserId() !== binding.originUser ||
    typeof input.prompt !== 'string' ||
    !input.prompt.trim() ||
    new TextEncoder().encode(input.prompt).byteLength > AGENT_TASK_TEXT_MAX_BYTES
  ) {
    throw new Error('matrix_agent_task_invalid')
  }

  const invite = [...expectedMembers(binding)].filter(userId => userId !== binding.originUser)
  const created = await client.createRoom({
    name: 'Atum agent task',
    invite,
    preset: Preset.PrivateChat,
    creation_content: {
      type: MATRIX_AGENT_TASK_ROOM_TYPE,
      [MATRIX_AGENT_TASK_KEY]: agentTaskBindingWire(binding)
    },
    power_level_content_override: {
      users: { [binding.owner]: 100, [binding.originUser]: 50 },
      users_default: 0,
      events: {
        [MATRIX_AGENT_TASK_START_TYPE]: 50,
        [MATRIX_AGENT_TASK_COORDINATOR_TYPE]: 100
      },
      events_default: 0,
      state_default: 100,
      invite: 50,
      kick: 100,
      ban: 100,
      redact: 100,
      notifications: { room: 100 }
    },
    initial_state: [
      {
        type: EventType.RoomHistoryVisibility,
        state_key: '',
        content: { history_visibility: 'invited' }
      },
      { type: EventType.RoomJoinRules, state_key: '', content: { join_rule: 'invite' } },
      { type: EventType.RoomGuestAccess, state_key: '', content: { guest_access: 'forbidden' } }
    ]
  })

  if (!active() || !agentTaskRoomId(created.room_id)) {throw new Error('matrix_agent_task_invalid')}

  const transactionId = `atum-task-start-${binding.taskId}`
  const sent = await client.sendEvent(created.room_id, EventType.RoomMessage, {
    msgtype: MsgType.Text,
    body: input.prompt,
    [MATRIX_AGENT_TASK_KEY]: agentTaskMessageWire(binding.taskId, 'start', binding.createdAt)
  } as never, transactionId)
  const eventId = typeof sent === 'object' && sent !== null && 'event_id' in sent ? sent.event_id : sent

  if (!agentTaskEventId(eventId)) {throw new Error('matrix_agent_task_invalid')}
  const sendTaskState = client.sendStateEvent.bind(client) as unknown as (
    roomId: string,
    type: string,
    content: Record<string, unknown>,
    stateKey: string
  ) => Promise<unknown>
  const pointer = await sendTaskState(created.room_id, MATRIX_AGENT_TASK_START_TYPE, {
    v: 1,
    task_id: binding.taskId,
    event_id: eventId
  }, binding.taskId)
  const pointerEventId = typeof pointer === 'object' && pointer !== null && 'event_id' in pointer
    ? pointer.event_id
    : pointer
  if (!agentTaskEventId(pointerEventId)) {throw new Error('matrix_agent_task_invalid')}

  return {
    roomId: created.room_id,
    binding,
    startEventId: eventId,
    state: 'pending',
    updatedAt: binding.createdAt
  }
}

function ownerTaskState(
  state: IStateEventWithRoomId[],
  input: { ownerId: string; currentMainPrincipal: string; currentMainUser: string }
): { created: AgentTaskBinding; binding: AgentTaskBinding; liveMembers: Set<string> } | undefined {
  const creation = state.find(event => event.type === EventType.RoomCreate && event.state_key === '')
  const created = agentTaskBinding(creation?.content?.[MATRIX_AGENT_TASK_KEY])
  if (!created || creation?.content?.type !== MATRIX_AGENT_TASK_ROOM_TYPE || creation.sender !== created.originUser ||
      created.owner !== input.ownerId) {return undefined}

  const coordinatorEvents = state.filter(event =>
    event.type === MATRIX_AGENT_TASK_COORDINATOR_TYPE && event.state_key === created.taskId)
  if (coordinatorEvents.length > 1) {return undefined}
  const binding = coordinatedBinding(created, coordinatorEvents[0])
  const history = state.find(event => event.type === EventType.RoomHistoryVisibility && event.state_key === '')
  const power = state.find(event => event.type === EventType.RoomPowerLevels && event.state_key === '')
  const members = state.filter(event => event.type === EventType.RoomMember)
  const liveMembers = new Set(members
    .filter(event => ['invite', 'join'].includes(String(event.content?.membership)))
    .map(event => event.state_key ?? ''))
  if (!binding || !power || !validTaskPower(power.content, created) ||
      state.some(event => event.type === EventType.RoomEncryption) ||
      history?.content?.history_visibility !== 'invited' ||
      ![created.owner, created.originUser, created.targetUser].every(user => liveMembers.has(user))) {return undefined}

  return { created, binding, liveMembers }
}

/**
 * Move live task rooms to the current Main without granting that role through Matrix.
 * The authenticated platform roster chooses the destination; the human Matrix account is
 * the only room member with enough power to write the coordinator state.
 */
export async function reconcileAgentTaskCoordinators(
  client: MatrixClient,
  input: {
    ownerId: string
    currentMainPrincipal: string
    currentMainUser: string
    ownedAgents?: readonly AgentTaskOwnedAgent[]
  },
  active: () => boolean = () => true
): Promise<number> {
  const selected = agentTaskCoordinator({
    v: 1,
    task_id: '00000000-0000-4000-8000-000000000000',
    principal: input.currentMainPrincipal,
    user: input.currentMainUser
  })
  if (!active() || client.getUserId() !== input.ownerId || !/^@[^:\s]+:[^\s]+$/u.test(input.ownerId) || !selected) {
    throw new Error('matrix_agent_task_room_required')
  }

  let changed = 0

  for (const room of client.getRooms()) {
    if (!active()) {throw new Error('matrix_agent_task_room_required')}
    if (room.getType() !== MATRIX_AGENT_TASK_ROOM_TYPE || !['invite', 'join'].includes(room.getMyMembership())) {continue}

    try {
      if (room.getMyMembership() === 'invite') {
        const invited = invitedTaskBinding(room, input, input.ownerId)
        const invitation = room.currentState.getStateEvents(EventType.RoomMember, input.ownerId)
        if (!invited || invitation?.getSender() !== invited.originUser || invited.expiresAt <= Date.now()) {continue}
        await client.joinRoom(room.roomId)
      }

      let state = await client.roomState(room.roomId)
      let current = ownerTaskState(state, input)
      if (!current || current.created.expiresAt <= Date.now()) {continue}

      const ownerMembership = memberState(state, input.ownerId)
      if (ownerMembership?.content?.membership === 'invite') {
        // A joined room may race to a later invitation; do not mutate it until the next pass.
        continue
      }

      let touched = false
      if (current.binding.mainPrincipal !== input.currentMainPrincipal ||
          current.binding.mainUser !== input.currentMainUser) {
        const sendState = client.sendStateEvent.bind(client) as unknown as (
          roomId: string,
          type: string,
          content: Record<string, unknown>,
          stateKey: string
        ) => Promise<unknown>
        await sendState(room.roomId, MATRIX_AGENT_TASK_COORDINATOR_TYPE, agentTaskCoordinatorWire({
          v: 1,
          taskId: current.created.taskId,
          principal: input.currentMainPrincipal,
          user: input.currentMainUser
        }), current.created.taskId)
        touched = true
      }

      if (!current.liveMembers.has(input.currentMainUser)) {
        await client.invite(room.roomId, input.currentMainUser)
        touched = true
      }

      const retained = new Set([
        current.created.owner,
        current.created.originUser,
        current.created.targetUser,
        input.currentMainUser
      ])
      for (const user of current.liveMembers) {
        if (!retained.has(user)) {
          await client.kick(room.roomId, user)
          touched = true
        }
      }
      if (touched) {changed += 1}
    } catch {
      // An unrelated, malformed, concurrently changing, or inaccessible room grants nothing.
    }
  }

  return changed
}

export async function sendAgentTaskEvent(
  client: MatrixClient,
  input: {
    roomId: string
    taskId: string
    action: 'accepted' | 'running' | 'completed' | 'failed' | 'stopped' | 'stop' | 'steer'
    body: string
    transactionId: string
  },
  active: () => boolean = () => true
): Promise<string> {
  const room = client.getRoom(input.roomId)
  const cached = room ? agentTaskRoomBinding(room) : undefined
  const self = client.getUserId()
  const principal = cached && self === cached.originUser
    ? cached.originPrincipal
    : cached && self === cached.targetUser
      ? cached.targetPrincipal
      : cached && self === cached.mainUser
        ? cached.mainPrincipal
        : undefined
  const binding = cached && self && principal
    ? await readAgentTaskRoom(client, {
        roomId: input.roomId,
        ownerId: cached.owner,
        agentPrincipal: principal,
        agentUserId: self
      }, active)
    : undefined

  if (
    !active() ||
    room?.getMyMembership() !== 'join' ||
    !binding ||
    binding.taskId !== input.taskId ||
    !input.body.trim() ||
    new TextEncoder().encode(input.body).byteLength > AGENT_TASK_TEXT_MAX_BYTES ||
    typeof input.transactionId !== 'string' ||
    !/^[A-Za-z0-9._~-]{1,240}$/u.test(input.transactionId) ||
    (['accepted', 'running', 'completed', 'failed', 'stopped'].includes(input.action)
      ? self !== binding.targetUser
      : self !== binding.originUser && self !== binding.mainUser)
  ) {
    throw new Error('matrix_agent_task_invalid')
  }

  const sent = await client.sendEvent(input.roomId, EventType.RoomMessage, {
    msgtype: MsgType.Text,
    body: input.body,
    [MATRIX_AGENT_TASK_KEY]: agentTaskMessageWire(input.taskId, input.action, Date.now())
  } as never, input.transactionId)
  const eventId = typeof sent === 'object' && sent !== null && 'event_id' in sent ? sent.event_id : sent

  if (!agentTaskEventId(eventId)) {throw new Error('matrix_agent_task_invalid')}

  return eventId
}

export async function scanAgentTasks(
  client: MatrixClient,
  watch: AgentTaskWatch,
  active: () => boolean = () => true
): Promise<MatrixInvocationScan> {
  const rooms = await listAgentTaskRooms(client, watch, active)
  const hints: MatrixInvocationHint[] = []

  for (const room of rooms) {
    if (room.binding.targetUser !== watch.agentUserId || room.binding.targetPrincipal !== watch.agentPrincipal) {continue}
    const history = await events(client, room.roomId, room.binding)
    const state = agentTaskState(history, room.binding.expiresAt).state
    if (['completed', 'failed', 'stopped'].includes(state)) {continue}

    const recoverable = history
      // Expiry closes new work at the invocation fence. Keep only its immutable start pointer so
      // a target that already saved a result can reconcile the terminal publication after restart.
      .filter(event => event.kind === 'start' || (state !== 'expired' && (event.kind === 'stop' || event.kind === 'steer')))
      .sort((a, b) => {
        // A recovered stop must close the task before its start is offered. Starts then arm the
        // target, and steer events retain their original order after it is armed.
        const priority = (kind: AgentTaskEvent['kind']) => kind === 'stop' ? 0 : kind === 'start' ? 1 : 2

        return priority(a.kind) - priority(b.kind) ||
          (a.serverAt ?? a.at) - (b.serverAt ?? b.at) || a.eventId.localeCompare(b.eventId)
      })

    for (const event of recoverable) {
      hints.push({ watchId: watch.id, roomId: room.roomId, eventId: event.eventId })
    }
  }

  return { hints, complete: true, undecryptable: false }
}

/** Live task hints only. Native/controller re-read the room, sender, role and event. */
export function watchAgentTasks(client: MatrixClient, offer: (hint: MatrixInvocationHint) => void) {
  let watch: AgentTaskWatch | null = null
  let generation = 0
  let catchup: Promise<void> | undefined
  const emitted = new Set<string>()
  // A reconnecting sync is not an outage (matrix-sync-health.ts): live events are still heard
  // (the first response after a blip arrives as CATCHUP); a history scan, which would only fail
  // against the dead long-poll, waits for the sync to be alive.
  const health = createMatrixSyncHealth()

  const scan = () => {
    const selected = watch
    const selectedGeneration = generation

    if (!selected || health.current() !== 'alive' || catchup) {return}

    catchup = scanAgentTasks(client, selected)
      .then(result => {
        if (watch !== selected || generation !== selectedGeneration) {return}

        for (const hint of result.hints) {
          if (emitted.has(hint.eventId)) {continue}
          emitted.add(hint.eventId)
          offer(hint)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        catchup = undefined
      })
  }

  const timeline = (event: MatrixEvent, _room: unknown, toStart: boolean | undefined, removed: boolean, data: { liveEvent?: boolean; fromCache?: boolean }) => {
    if (!watch || health.current() === 'offline' || toStart || removed || !data.liveEvent || data.fromCache || event.status !== null || event.isRedacted()) {return}
    const room = client.getRoom(event.getRoomId() ?? '')
    const binding = room ? agentTaskRoomBinding(room) : undefined
    const marker = agentTaskMessage(event.getOriginalContent()[MATRIX_AGENT_TASK_KEY])
    const eventId = event.getId()

    if (
      room?.getMyMembership() !== 'join' ||
      room.hasEncryptionStateEvent() ||
      !binding ||
      binding.owner !== watch.ownerId ||
      binding.targetPrincipal !== watch.agentPrincipal ||
      binding.targetUser !== watch.agentUserId ||
      binding.expiresAt <= Date.now() ||
      event.getWireType() !== EventType.RoomMessage ||
      !marker ||
      marker.taskId !== binding.taskId ||
      (marker.kind === 'start' && marker.at !== binding.createdAt) ||
      !['start', 'stop', 'steer'].includes(marker.kind) ||
      !agentTaskEventId(eventId) ||
      emitted.has(eventId) ||
      event.localTimestamp <= watch.since ||
      !agentTaskMessageSender(binding, { kind: marker.kind, sender: event.getSender() ?? '' })
    ) {
      return
    }

    emitted.add(eventId)
    offer({ watchId: watch.id, roomId: room.roomId, eventId })
  }

  const sync = (state: string, _previous?: unknown, data?: unknown) => {
    health.observe(state, data)
  }

  const membership = (room: Room, value: string) => {
    if (
      watch &&
      health.current() === 'alive' &&
      (value === 'invite' || value === 'join') &&
      room.getType() === MATRIX_AGENT_TASK_ROOM_TYPE
    ) {
      scan()
    }
  }

  client.on(ClientEvent.Sync, sync)
  client.on(RoomEvent.MyMembership, membership)
  client.on(RoomEvent.Timeline, timeline)

  return {
    set(value: AgentTaskWatch | null) {
      generation += 1
      watch = value
      if (!value) {emitted.clear()}
      sync(String(client.getSyncState() ?? ''))
    },
    stop() {
      watch = null
      generation += 1
      emitted.clear()
      health.dispose()
      client.off(ClientEvent.Sync, sync)
      client.off(RoomEvent.MyMembership, membership)
      client.off(RoomEvent.Timeline, timeline)
    }
  }
}
