import { createClient, EventType, MatrixEvent, Room } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'

import {
  agentTaskBinding,
  agentTaskBindingWire,
  agentTaskCoordinatorWire,
  MATRIX_AGENT_TASK_COORDINATOR_TYPE,
  MATRIX_AGENT_TASK_KEY,
  MATRIX_AGENT_TASK_ROOM_TYPE,
  MATRIX_AGENT_TASK_START_TYPE
} from '../../shared/agent-task'

import { reconcileAgentTaskCoordinators, reconcileAgentTaskRooms } from './agent-tasks'

const owner = '@owner:test'
const originUser = '@origin:test'
const targetUser = '@target:test'
const mainUser = '@main:test'
const originPrincipal = '00000000-0000-4000-8000-bd7662a5eeb4'
const targetPrincipal = '00000000-0000-4000-8000-b454f82c5857'
const mainPrincipal = '00000000-0000-4000-8000-f6222a1106ee'
const nextMainUser = '@next-main:test'
const nextMainPrincipal = '00000000-0000-4000-8000-fbfe405ca65f'
const taskId = '00000000-0000-4000-8000-f1d11edf5c5c'
const roomId = '!task:test'

function invitationFixture(input: {
  invitedUser: string
  creator?: { principal: string; userId: string }
  invitationSender?: string
  coordinator?: { principal: string; userId: string; sender?: string }
  invalidFullState?: boolean
}) {
  const binding = agentTaskBinding({
    v: 1,
    task_id: taskId,
    owner,
    origin_principal: input.creator?.principal ?? originPrincipal,
    origin_user: input.creator?.userId ?? originUser,
    target_principal: targetPrincipal,
    target_user: targetUser,
    main_principal: mainPrincipal,
    main_user: mainUser,
    created_at: Date.now() - 1_000,
    expires_at: Date.now() + 60_000
  })!
  let membership = 'invite'
  const member = (userId: string, value: string, sender = userId) => ({
    type: EventType.RoomMember,
    state_key: userId,
    sender,
    content: { membership: value }
  })
  const ownInvite = member(input.invitedUser, 'invite', input.invitationSender ?? binding.originUser)
  Object.assign(ownInvite, { event_id: '$invite:test', room_id: roomId })
  const creation = {
    type: EventType.RoomCreate,
    state_key: '',
    event_id: '$create:test',
    room_id: roomId,
    sender: binding.originUser,
    content: { type: MATRIX_AGENT_TASK_ROOM_TYPE, [MATRIX_AGENT_TASK_KEY]: agentTaskBindingWire(binding) }
  }
  const coordinator = input.coordinator && {
    type: MATRIX_AGENT_TASK_COORDINATOR_TYPE,
    state_key: binding.taskId,
    event_id: '$coordinator:test',
    room_id: roomId,
    sender: input.coordinator.sender ?? owner,
    content: agentTaskCoordinatorWire({
      v: 1,
      taskId: binding.taskId,
      principal: input.coordinator.principal,
      user: input.coordinator.userId
    })
  }
  const participants = [...new Set([owner, binding.originUser, targetUser, input.coordinator?.userId ?? mainUser])]
  const full = [
    creation,
    { type: EventType.RoomHistoryVisibility, state_key: '', sender: binding.originUser,
      content: { history_visibility: input.invalidFullState ? 'joined' : 'invited' } },
    { type: EventType.RoomPowerLevels, state_key: '', sender: binding.originUser,
      content: {
        users: { [owner]: 100, [binding.originUser]: 50 }, users_default: 0,
        events: { [MATRIX_AGENT_TASK_START_TYPE]: 50, [MATRIX_AGENT_TASK_COORDINATOR_TYPE]: 100 },
        events_default: 0, state_default: 100, invite: 50, kick: 100, ban: 100, redact: 100,
        notifications: { room: 100 }
      } },
    ...(coordinator ? [coordinator] : []),
    ...participants.map(userId =>
      userId === input.invitedUser ? ownInvite : member(userId, 'join'))
  ]
  const client = createClient({ baseUrl: 'https://matrix.test', userId: input.invitedUser })
  const room = new Room(roomId, client, input.invitedUser)
  // Synapse stripped invite state includes the create event and this account's membership,
  // but not custom task coordinator state. Full state remains unavailable until join.
  room.currentState.setStateEvents([new MatrixEvent(creation), new MatrixEvent(ownInvite)])
  room.updateMyMembership(membership)
  client.store.storeRoom(room)
  const roomState = vi.spyOn(client, 'roomState').mockImplementation(async () => {
    if (membership === 'invite') {throw Object.assign(new Error('M_FORBIDDEN'), { httpStatus: 403 })}
    return full as never
  })
  const joinRoom = vi.spyOn(client, 'joinRoom').mockImplementation(async () => {
    membership = 'join'
    ownInvite.content.membership = 'join'
    room.currentState.setStateEvents([new MatrixEvent(ownInvite)])
    room.updateMyMembership(membership)
    return roomId as never
  })

  return {
    binding,
    client,
    joinRoom,
    roomState
  }
}

describe('agent task invitations', () => {
  it('joins only a roster-authenticated task invitation without reading forbidden full state first', async () => {
    const value = invitationFixture({ invitedUser: targetUser })

    await expect(reconcileAgentTaskRooms(value.client as never, {
      ownerId: owner,
      agentPrincipal: targetPrincipal,
      agentUserId: targetUser,
      ownedAgents: [{ principal: originPrincipal, userId: originUser }]
    })).resolves.toEqual([{ roomId, binding: value.binding }])

    expect(value.joinRoom).toHaveBeenCalledWith(roomId)
    expect(value.roomState).toHaveBeenCalledTimes(1)
  })

  it('leaves an attacker-created invitation untouched even when it claims the real owner', async () => {
    const attacker = { principal: '00000000-0000-4000-8000-fbfe405ca65f', userId: '@attacker:test' }
    const value = invitationFixture({ invitedUser: targetUser, creator: attacker })

    await expect(reconcileAgentTaskRooms(value.client as never, {
      ownerId: owner,
      agentPrincipal: targetPrincipal,
      agentUserId: targetUser,
      ownedAgents: [{ principal: originPrincipal, userId: originUser }]
    })).resolves.toEqual([])

    expect(value.joinRoom).not.toHaveBeenCalled()
    expect(value.roomState).not.toHaveBeenCalled()
  })

  it('does not join any task invitation until an authoritative roster is available', async () => {
    const value = invitationFixture({ invitedUser: targetUser })

    await expect(reconcileAgentTaskRooms(value.client as never, {
      ownerId: owner,
      agentPrincipal: targetPrincipal,
      agentUserId: targetUser
    })).resolves.toEqual([])

    expect(value.joinRoom).not.toHaveBeenCalled()
    expect(value.roomState).not.toHaveBeenCalled()
  })

  it('joins an owner replacement invitation only for the owner-signed reassigned Main', async () => {
    const value = invitationFixture({
      invitedUser: nextMainUser,
      invitationSender: owner,
      coordinator: { principal: nextMainPrincipal, userId: nextMainUser }
    })

    await expect(reconcileAgentTaskRooms(value.client as never, {
      ownerId: owner,
      agentPrincipal: nextMainPrincipal,
      agentUserId: nextMainUser,
      ownedAgents: [
        { principal: originPrincipal, userId: originUser },
        { principal: nextMainPrincipal, userId: nextMainUser }
      ]
    })).resolves.toEqual([{
      roomId,
      binding: expect.objectContaining({ mainPrincipal: nextMainPrincipal, mainUser: nextMainUser })
    }])

    expect(value.joinRoom).toHaveBeenCalledWith(roomId)
    expect(value.roomState).toHaveBeenCalledTimes(1)
  })

  it('rejects a forged full coordinator and an outsider inviter', async () => {
    const forgedCoordinator = invitationFixture({
      invitedUser: nextMainUser,
      invitationSender: owner,
      coordinator: { principal: nextMainPrincipal, userId: nextMainUser, sender: '@outsider:test' }
    })
    const outsiderInvite = invitationFixture({ invitedUser: targetUser, invitationSender: '@outsider:test' })

    await expect(reconcileAgentTaskRooms(forgedCoordinator.client as never, {
      ownerId: owner,
      agentPrincipal: nextMainPrincipal,
      agentUserId: nextMainUser,
      ownedAgents: [
        { principal: originPrincipal, userId: originUser },
        { principal: nextMainPrincipal, userId: nextMainUser }
      ]
    })).resolves.toEqual([])
    await expect(reconcileAgentTaskRooms(outsiderInvite.client as never, {
      ownerId: owner,
      agentPrincipal: targetPrincipal,
      agentUserId: targetUser,
      ownedAgents: [{ principal: originPrincipal, userId: originUser }]
    })).resolves.toEqual([])

    expect(forgedCoordinator.joinRoom).toHaveBeenCalledWith(roomId)
    expect(forgedCoordinator.roomState).toHaveBeenCalledTimes(1)
    expect(outsiderInvite.joinRoom).not.toHaveBeenCalled()
    expect(outsiderInvite.roomState).not.toHaveBeenCalled()
  })

  it('does not admit a room when the full state after joining fails validation', async () => {
    const value = invitationFixture({ invitedUser: targetUser, invalidFullState: true })

    await expect(reconcileAgentTaskRooms(value.client as never, {
      ownerId: owner,
      agentPrincipal: targetPrincipal,
      agentUserId: targetUser,
      ownedAgents: [{ principal: originPrincipal, userId: originUser }]
    })).resolves.toEqual([])

    expect(value.joinRoom).toHaveBeenCalledWith(roomId)
    expect(value.roomState).toHaveBeenCalledTimes(1)
  })

  it('lets the owner coordinator join only an origin invitation authenticated by the same roster', async () => {
    const value = invitationFixture({ invitedUser: owner })

    await expect(reconcileAgentTaskCoordinators(value.client as never, {
      ownerId: owner,
      currentMainPrincipal: mainPrincipal,
      currentMainUser: mainUser,
      ownedAgents: [{ principal: originPrincipal, userId: originUser }]
    })).resolves.toBe(0)

    expect(value.joinRoom).toHaveBeenCalledWith(roomId)
    expect(value.roomState).toHaveBeenCalledTimes(1)
  })

  it('leaves an owner invitation from anyone but the roster-authenticated origin untouched', async () => {
    const value = invitationFixture({ invitedUser: owner, invitationSender: '@outsider:test' })

    await expect(reconcileAgentTaskCoordinators(value.client as never, {
      ownerId: owner,
      currentMainPrincipal: mainPrincipal,
      currentMainUser: mainUser,
      ownedAgents: [{ principal: originPrincipal, userId: originUser }]
    })).resolves.toBe(0)

    expect(value.joinRoom).not.toHaveBeenCalled()
    expect(value.roomState).not.toHaveBeenCalled()
  })
})
