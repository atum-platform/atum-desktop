import { EventType, MatrixEvent, MsgType } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'

import {
  agentTaskBinding,
  type AgentTaskBinding,
  agentTaskBindingWire,
  agentTaskCoordinatorWire,
  agentTaskMessageWire,
  MATRIX_AGENT_TASK_COORDINATOR_TYPE,
  MATRIX_AGENT_TASK_KEY,
  MATRIX_AGENT_TASK_ROOM_TYPE,
  MATRIX_AGENT_TASK_START_TYPE
} from '../../shared/agent-task'

import {
  queryAgentTaskRooms,
  readAgentTaskRoom,
  reconcileAgentTaskCoordinators,
  reconcileAgentTaskRooms,
  scanAgentTasks
} from './agent-tasks'

const owner = '@owner:test'
const originUser = '@origin:test'
const targetUser = '@target:test'
const mainUser = '@main:test'
const originPrincipal = '00000000-0000-4000-8000-bd7662a5eeb4'
const targetPrincipal = '00000000-0000-4000-8000-b454f82c5857'
const mainPrincipal = '00000000-0000-4000-8000-f6222a1106ee'
const nextMainPrincipal = '00000000-0000-4000-8000-fbfe405ca65f'
const nextMainUser = '@next-main:test'
const taskId = '00000000-0000-4000-8000-f1d11edf5c5c'
const roomId = '!task:test'

function fixture(kinds: Array<'start' | 'running' | 'completed' | 'stop' | 'steer'>, expiresInMs = 60_000) {
  const now = Date.now()
  const binding = agentTaskBinding({
    v: 1,
    task_id: taskId,
    owner,
    origin_principal: originPrincipal,
    origin_user: originUser,
    target_principal: targetPrincipal,
    target_user: targetUser,
    main_principal: mainPrincipal,
    main_user: mainUser,
    created_at: now - 1_000,
    expires_at: now + expiresInMs
  }) as AgentTaskBinding
  const state = [
    { type: EventType.RoomCreate, state_key: '', sender: originUser,
      content: { type: MATRIX_AGENT_TASK_ROOM_TYPE, [MATRIX_AGENT_TASK_KEY]: agentTaskBindingWire(binding) } },
    { type: EventType.RoomHistoryVisibility, state_key: '', sender: originUser,
      content: { history_visibility: 'invited' } },
    { type: EventType.RoomPowerLevels, state_key: '', sender: originUser,
      content: {
        users: { [owner]: 100, [originUser]: 50 }, users_default: 0,
        events: { [MATRIX_AGENT_TASK_START_TYPE]: 50, [MATRIX_AGENT_TASK_COORDINATOR_TYPE]: 100 },
        events_default: 0, state_default: 100, invite: 50, kick: 100, ban: 100, redact: 100,
        notifications: { room: 100 }
      } },
    ...[owner, originUser, targetUser, mainUser].map(userId => ({
      type: EventType.RoomMember, state_key: userId, sender: userId, content: { membership: 'join' }
    }))
  ]
  const chunk: unknown[] = kinds.map((kind, index) => ({
    type: EventType.RoomMessage,
    room_id: roomId,
    event_id: `$${kind}:test`,
    sender: kind === 'start' || kind === 'steer' ? originUser : kind === 'stop' ? mainUser : targetUser,
    origin_server_ts: now + index,
    content: {
      msgtype: MsgType.Text,
      body: kind,
      [MATRIX_AGENT_TASK_KEY]: agentTaskMessageWire(taskId, kind, kind === 'start' ? binding.createdAt : now + index)
    }
  }))
  const room = { roomId, getType: () => MATRIX_AGENT_TASK_ROOM_TYPE, getMyMembership: () => 'join',
    currentState: { getStateEvents: (type: string, key: string) => {
      const event = state.find(event => event.type === type && event.state_key === key)
      return event ? new MatrixEvent(event) : null
    } } }
  const client = {
    getUserId: () => targetUser,
    getRooms: () => [room],
    roomState: vi.fn(async (_roomId: string) => state),
    createMessagesRequest: vi.fn(async () => ({ chunk, end: undefined })),
    fetchRoomEvent: vi.fn(async (_room: string, eventId: string) => chunk.find(event =>
      (event as { event_id?: string }).event_id === eventId))
  }

  return { client, now, state }
}

describe('agent task scanning', () => {
  it('looks up an exact task without fetching unrelated historical room state or messages', async () => {
    const value = fixture(['start'])
    const matching = value.client.getRooms()[0]!
    const unrelated = Array.from({ length: 100 }, (_, index) => ({
      ...matching,
      roomId: `!old-${index}:test`,
      currentState: { getStateEvents: (type: string) => type === EventType.RoomCreate
        ? new MatrixEvent({ ...value.state[0]!, content: {
          ...value.state[0]!.content,
          [MATRIX_AGENT_TASK_KEY]: {
            ...matching.currentState.getStateEvents(EventType.RoomCreate, '')!.getContent()[MATRIX_AGENT_TASK_KEY],
            task_id: '00000000-0000-4000-8000-303617b97302'
          }
        } }) : null }
    }))
    vi.spyOn(value.client, 'getRooms').mockReturnValue([...unrelated, matching] as never)
    value.client.roomState.mockImplementation(async id => {
      if (id !== roomId) {throw new Error('unrelated room should not be fetched')}
      return value.state
    })
    const input = { ownerId: owner, agentPrincipal: targetPrincipal, agentUserId: targetUser, taskId }

    await expect(queryAgentTaskRooms(value.client as never, input)).resolves.toMatchObject([{ roomId }])
    expect(value.client.roomState.mock.calls.every(([id]) => id === roomId)).toBe(true)
    expect(value.client.createMessagesRequest).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    await expect(queryAgentTaskRooms(value.client as never, {
      ...input, taskId: '00000000-0000-4000-8000-00f765af1c54'
    })).resolves.toEqual([])
    expect(value.client.roomState).not.toHaveBeenCalled()
    expect(value.client.createMessagesRequest).not.toHaveBeenCalled()
  })

  it('offers start and control events only while the task is live', async () => {
    const live = fixture(['start', 'running', 'stop'])
    const watch = { id: 'agent-task', ownerId: owner, agentPrincipal: targetPrincipal,
      agentUserId: targetUser, since: live.now - 2_000 }

    await expect(scanAgentTasks(live.client as never, watch)).resolves.toEqual({
      hints: [
        { watchId: 'agent-task', roomId, eventId: '$stop:test' },
        { watchId: 'agent-task', roomId, eventId: '$start:test' }
      ],
      complete: true,
      undecryptable: false
    })

    const terminal = fixture(['start', 'completed', 'stop'])
    await expect(scanAgentTasks(terminal.client as never, { ...watch, since: terminal.now - 2_000 })).resolves.toEqual({
      hints: [], complete: true, undecryptable: false
    })
  })

  it('recovers only the immutable start for an expired task, never an explicit terminal result', async () => {
    const expired = fixture(['start', 'running', 'steer'], -1)
    const watch = { id: 'agent-task', ownerId: owner, agentPrincipal: targetPrincipal,
      agentUserId: targetUser, since: expired.now - 2_000 }

    await expect(scanAgentTasks(expired.client as never, watch)).resolves.toEqual({
      hints: [{ watchId: 'agent-task', roomId, eventId: '$start:test' }],
      complete: true,
      undecryptable: false
    })

    const completed = fixture(['start', 'completed'], -1)
    await expect(scanAgentTasks(completed.client as never, { ...watch, since: completed.now - 2_000 })).resolves.toEqual({
      hints: [], complete: true, undecryptable: false
    })
  })

  it('recovers stop before start while preserving steer chronology', async () => {
    const recovered = fixture(['start', 'steer', 'steer', 'stop'])
    const watch = { id: 'agent-task', ownerId: owner, agentPrincipal: targetPrincipal,
      agentUserId: targetUser, since: recovered.now - 2_000 }

    recovered.client.createMessagesRequest.mockResolvedValue({
      chunk: [
        {
          type: EventType.RoomMessage, room_id: roomId, event_id: '$start:test', sender: originUser,
          origin_server_ts: recovered.now,
          content: { msgtype: MsgType.Text, body: 'start',
            [MATRIX_AGENT_TASK_KEY]: agentTaskMessageWire(taskId, 'start', recovered.now - 1_000) }
        },
        ...['one', 'two'].map((name, index) => ({
          type: EventType.RoomMessage, room_id: roomId, event_id: `$steer-${name}:test`, sender: originUser,
          origin_server_ts: recovered.now + index + 1,
          content: { msgtype: MsgType.Text, body: name,
            [MATRIX_AGENT_TASK_KEY]: agentTaskMessageWire(taskId, 'steer', recovered.now + index + 1) }
        })),
        {
          type: EventType.RoomMessage, room_id: roomId, event_id: '$stop:test', sender: mainUser,
          origin_server_ts: recovered.now + 3,
          content: { msgtype: MsgType.Text, body: 'stop',
            [MATRIX_AGENT_TASK_KEY]: agentTaskMessageWire(taskId, 'stop', recovered.now + 3) }
        }
      ],
      end: undefined
    })

    await expect(scanAgentTasks(recovered.client as never, watch)).resolves.toEqual({
      hints: [
        { watchId: 'agent-task', roomId, eventId: '$stop:test' },
        { watchId: 'agent-task', roomId, eventId: '$start:test' },
        { watchId: 'agent-task', roomId, eventId: '$steer-one:test' },
        { watchId: 'agent-task', roomId, eventId: '$steer-two:test' }
      ],
      complete: true,
      undecryptable: false
    })
  })

  it('recovers the exact start from room state after it falls outside the bounded timeline scan', async () => {
    const recovered = fixture(['running'])
    const start = {
      type: EventType.RoomMessage,
      room_id: roomId,
      event_id: '$start:test',
      sender: originUser,
      origin_server_ts: recovered.now,
      content: {
        msgtype: MsgType.Text,
        body: 'start',
        [MATRIX_AGENT_TASK_KEY]: agentTaskMessageWire(taskId, 'start', recovered.now - 1_000)
      }
    }
    recovered.state.push({
      type: MATRIX_AGENT_TASK_START_TYPE,
      state_key: taskId,
      sender: originUser,
      content: { v: 1, task_id: taskId, event_id: '$start:test' }
    } as never)
    recovered.client.fetchRoomEvent.mockResolvedValue(start)

    await expect(scanAgentTasks(recovered.client as never, {
      id: 'agent-task', ownerId: owner, agentPrincipal: targetPrincipal,
      agentUserId: targetUser, since: recovered.now - 2_000
    })).resolves.toEqual({
      hints: [{ watchId: 'agent-task', roomId, eventId: '$start:test' }],
      complete: true,
      undecryptable: false
    })
  })

  it('refuses a room after any bound participant is removed', async () => {
    const removed = fixture(['start'])
    const main = removed.state.find(event => event.type === EventType.RoomMember && event.state_key === mainUser)!
    ;(main.content as { membership: string }).membership = 'leave'

    await expect(readAgentTaskRoom(removed.client as never, {
      roomId,
      ownerId: owner,
      agentPrincipal: targetPrincipal,
      agentUserId: targetUser
    })).rejects.toThrow('matrix_agent_task_room_required')
  })

  it('does not offer a start whose marker does not match the immutable creation time', async () => {
    const value = fixture(['start'])
    const chunk = (await value.client.createMessagesRequest()) as { chunk: Array<Record<string, unknown>> }
    const content = chunk.chunk[0]!.content as Record<string, unknown>
    content[MATRIX_AGENT_TASK_KEY] = agentTaskMessageWire(taskId, 'start', value.now)
    value.client.createMessagesRequest.mockResolvedValue({ chunk: chunk.chunk, end: undefined })

    await expect(scanAgentTasks(value.client as never, {
      id: 'agent-task', ownerId: owner, agentPrincipal: targetPrincipal,
      agentUserId: targetUser, since: value.now - 2_000
    })).resolves.toEqual({ hints: [], complete: true, undecryptable: false })
  })

  it('uses only an owner-signed coordinator pointer for the current Main', async () => {
    const value = fixture(['start', 'stop'])
    value.state.push({
      type: MATRIX_AGENT_TASK_COORDINATOR_TYPE,
      state_key: taskId,
      sender: owner,
      content: agentTaskCoordinatorWire({
        v: 1,
        taskId,
        principal: nextMainPrincipal,
        user: nextMainUser
      })
    } as never)
    const previousMain = value.state.find(event => event.type === EventType.RoomMember && event.state_key === mainUser)!
    previousMain.content = { membership: 'leave' }
    value.state.push({
      type: EventType.RoomMember,
      state_key: nextMainUser,
      sender: owner,
      content: { membership: 'invite' }
    } as never)

    await expect(readAgentTaskRoom(value.client as never, {
      roomId,
      ownerId: owner,
      agentPrincipal: targetPrincipal,
      agentUserId: targetUser
    })).resolves.toMatchObject({ mainPrincipal: nextMainPrincipal, mainUser: nextMainUser })

    ;(value.state.find(event => String(event.type) === MATRIX_AGENT_TASK_COORDINATOR_TYPE) as { sender: string }).sender = originUser
    await expect(readAgentTaskRoom(value.client as never, {
      roomId,
      ownerId: owner,
      agentPrincipal: targetPrincipal,
      agentUserId: targetUser
    })).rejects.toThrow('matrix_agent_task_room_required')
  })

  it('lets the owner reconcile a live room to the authoritative current Main', async () => {
    const value = fixture(['start'])
    value.state.push({
      type: EventType.RoomMember,
      state_key: '@unexpected:test',
      sender: originUser,
      content: { membership: 'invite' }
    } as never)
    const room = { roomId, getType: () => MATRIX_AGENT_TASK_ROOM_TYPE, getMyMembership: () => 'join' }
    const invite = vi.fn(async () => undefined)
    const kick = vi.fn(async () => undefined)
    const sendStateEvent = vi.fn(async () => ({ event_id: '$coordinator:test' }))
    const client = {
      ...value.client,
      getUserId: () => owner,
      getRooms: () => [room],
      invite,
      kick,
      sendStateEvent
    }

    await expect(reconcileAgentTaskCoordinators(client as never, {
      ownerId: owner,
      currentMainPrincipal: nextMainPrincipal,
      currentMainUser: nextMainUser
    })).resolves.toBe(1)

    expect(sendStateEvent).toHaveBeenCalledWith(
      roomId,
      MATRIX_AGENT_TASK_COORDINATOR_TYPE,
      agentTaskCoordinatorWire({ v: 1, taskId, principal: nextMainPrincipal, user: nextMainUser }),
      taskId
    )
    expect(invite).toHaveBeenCalledWith(roomId, nextMainUser)
    expect(kick.mock.calls).toEqual([
      [roomId, mainUser],
      [roomId, '@unexpected:test']
    ])
  })

  it('lets a reassigned Main join the owner-signed replacement invitation', async () => {
    const value = fixture(['start'])
    value.state.push({
      type: MATRIX_AGENT_TASK_COORDINATOR_TYPE,
      state_key: taskId,
      sender: owner,
      content: agentTaskCoordinatorWire({
        v: 1,
        taskId,
        principal: nextMainPrincipal,
        user: nextMainUser
      })
    } as never)
    const previousMain = value.state.find(event => event.type === EventType.RoomMember && event.state_key === mainUser)!
    previousMain.content = { membership: 'leave' }
    const nextMember = {
      type: EventType.RoomMember,
      state_key: nextMainUser,
      sender: owner,
      content: { membership: 'invite' }
    }
    value.state.push(nextMember as never)

    let membership = 'invite'
    const room = {
      roomId,
      getType: () => MATRIX_AGENT_TASK_ROOM_TYPE,
      getMyMembership: () => membership,
      currentState: {
        getStateEvents: (type: string, stateKey: string) =>
          type === EventType.RoomMember && stateKey === nextMainUser
            ? { getSender: () => owner }
            : null
      }
    }
    const joinRoom = vi.fn(async () => {
      membership = 'join'
      nextMember.content.membership = 'join'
    })
    const client = {
      ...value.client,
      getUserId: () => nextMainUser,
      getRooms: () => [room],
      joinRoom
    }

    await expect(reconcileAgentTaskRooms(client as never, {
      ownerId: owner,
      agentPrincipal: nextMainPrincipal,
      agentUserId: nextMainUser
    })).resolves.toEqual([{ roomId, binding: expect.objectContaining({
      mainPrincipal: nextMainPrincipal,
      mainUser: nextMainUser
    }) }])
    expect(joinRoom).toHaveBeenCalledWith(roomId)
  })
})
