import { createClient, EventType, MatrixEvent, Room } from 'matrix-js-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { requireMatrixSessionChoice } from '../../electron/matrix/model-session'
import { MATRIX_APP_GROUP_BINDING, MATRIX_APP_GROUP_TYPE } from '../../shared/matrix-app-room'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'
import {
  MATRIX_COMPANY_CHANNEL_BINDING,
  MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
  MATRIX_COMPANY_CHANNEL_TYPE
} from '../../shared/matrix-company-channel-room'
import {
  isCompanyPrivateCosRoom,
  MATRIX_COMPANY_PRIVATE_COS_PROTECTED_STATE,
  MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT
} from '../../shared/matrix-company-private-cos'

import { APP_BOT_DM_MARKER } from './app-bot-dm'
import {
  canMentionMatrixRoom,
  changeConversationMembership,
  conversationMembers,
  conversationRoom,
  createConversation,
  joinedConversation,
  rememberDirectConversation
} from './conversations'

const alice = '@alice:test'
const bob = '@bob:test'

/** A room Alice is in with Bob invited; encrypted unless asked for a 0.20 room without encryption. */
function fixture(options: { encrypted?: boolean; type?: string } = {}) {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: alice })
  const room = new Room('!r:test', client, alice)

  const state = (type: string, content: object, stateKey = '') =>
    new MatrixEvent({ type, state_key: stateKey, sender: alice, room_id: room.roomId, content })

  room.currentState.setStateEvents([
    state(EventType.RoomCreate, {
      creator: alice,
      room_version: '10',
      ...(options.type ? { type: options.type } : {})
    }),
    ...(options.encrypted === false ? [] : [state(EventType.RoomEncryption, { algorithm: 'm.megolm.v1.aes-sha2' })]),
    state(EventType.RoomPowerLevels, { users: { [alice]: 100, [bob]: 0 }, kick: 50, invite: 0 }),
    state(EventType.RoomMember, { membership: 'join', displayname: 'Alice' }, alice),
    state(EventType.RoomMember, { membership: 'invite', displayname: 'Bob' }, bob)
  ])
  room.updateMyMembership('join')
  client.store.storeRoom(room)

  return { client, room, state }
}

/** The initial state a createRoom call asked for, by event type. */
function createdState(create: { mock: { calls: unknown[][] } }, call: number) {
  const request = create.mock.calls[call]![0] as {
    initial_state: Array<{ type: string; content: Record<string, unknown> }>
  }

  return new Map(request.initial_state.map(event => [event.type, event.content]))
}

afterEach(() => vi.restoreAllMocks())

describe('Matrix-owned conversations', () => {
  it('projects the exact round-5 private CoS state marker and not the assistant type alone', () => {
    const { client, room, state } = fixture({ encrypted: false, type: MATRIX_ASSISTANT_ROOM_TYPE })
    const marker = {
      v: 1,
      classification: 'company_private_cos',
      companyId: '00000000-0000-4000-8000-87c6455cae48',
      membershipIncarnation: '00000000-0000-4000-8000-f6c6b8bb709f',
      executorId: '00000000-0000-4000-8000-8a4e23bab81e'
    }
    const manager = '@manager:test'
    const powerLevels = {
      users: { [manager]: 100, [alice]: 0, [bob]: 0 },
      users_default: 0,
      events_default: 0,
      state_default: 100,
      invite: 100,
      kick: 100,
      ban: 100,
      redact: 100,
      events: Object.fromEntries(MATRIX_COMPANY_PRIVATE_COS_PROTECTED_STATE.map(type => [type, 100]))
    }

    expect(isCompanyPrivateCosRoom(conversationRoom(client, room))).toBe(false)
    room.currentState.setStateEvents([
      state(EventType.RoomCreate, {
        creator: manager,
        room_version: '11',
        type: MATRIX_ASSISTANT_ROOM_TYPE
      }),
      state(MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT, marker),
      state(EventType.RoomHistoryVisibility, { history_visibility: 'joined' }),
      state(EventType.RoomJoinRules, { join_rule: 'invite' }),
      state(EventType.RoomPowerLevels, powerLevels),
      state(EventType.RoomMember, { membership: 'join', displayname: 'Bob' }, bob)
    ])

    expect(conversationRoom(client, room)).toMatchObject({
      roomType: MATRIX_ASSISTANT_ROOM_TYPE,
      roomVersion: '11',
      encrypted: false,
      historyVisibility: 'joined',
      joinRule: 'invite',
      companyPrivateCos: marker,
      powerLevels
    })
  })

  it('quarantines a private-CoS state claim under every state key without trusting it as a binding', () => {
    const { client, room, state } = fixture({ encrypted: false, type: MATRIX_ASSISTANT_ROOM_TYPE })

    room.currentState.setStateEvents([
      state(MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT, {
        v: 1,
        classification: 'company_private_cos',
        companyId: '00000000-0000-4000-8000-87c6455cae48',
        membershipIncarnation: '00000000-0000-4000-8000-f6c6b8bb709f',
        executorId: '00000000-0000-4000-8000-8a4e23bab81e'
      }, 'attacker-controlled-key')
    ])

    expect(conversationRoom(client, room)).toMatchObject({
      roomType: MATRIX_ASSISTANT_ROOM_TYPE,
      companyPrivateCosClaim: true
    })
    expect(conversationRoom(client, room).companyPrivateCos).toBeUndefined()
  })

  it('projects the standard room-mention power threshold without granting it from membership alone', () => {
    const { room, state } = fixture()

    room.currentState.setStateEvents([
      state(EventType.RoomPowerLevels, {
        users: { [alice]: 50, [bob]: 0 },
        notifications: { room: 50 }
      })
    ])
    expect(canMentionMatrixRoom(room, alice)).toBe(true)
    expect(canMentionMatrixRoom(room, bob)).toBe(false)
    room.updateMyMembership('leave')
    expect(canMentionMatrixRoom(room, alice)).toBe(false)
  })

  it('projects the declared Team Space room manager but omits it from people and participant surfaces', () => {
    const { client, room, state } = fixture({ encrypted: false })
    const manager = '@atum-team-space:test'
    const companyId = '00000000-0000-4000-8000-8c031eadb7f3'
    const channelId = '00000000-0000-4000-8000-01670d853f95'

    room.currentState.setStateEvents([
      new MatrixEvent({
        type: EventType.RoomCreate,
        state_key: '',
        room_id: room.roomId,
        sender: manager,
        content: {
          type: MATRIX_COMPANY_CHANNEL_TYPE,
          room_version: MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
          [MATRIX_COMPANY_CHANNEL_BINDING]: { companyId, channelId }
        }
      }),
      state(EventType.RoomMember, { membership: 'join', displayname: 'Atum Team Space' }, manager)
    ])

    expect(conversationRoom(client, room)).toMatchObject({
      companyChannel: { companyId, channelId, managerUserId: manager },
      participants: expect.not.arrayContaining([expect.objectContaining({ userId: manager })])
    })
    expect(conversationMembers(room, alice).map(member => member.userId)).not.toContain(manager)
  })

  it('creates a fresh immutable app-bound group without changing human membership authority', async () => {
    const { client, room, state } = fixture()
    const create = vi.spyOn(client, 'createRoom').mockResolvedValue({ room_id: '!new:test' })
    await createConversation(client, { name: 'Team', invite: [bob] }, false, bob)
    const creation = { type: MATRIX_APP_GROUP_TYPE, [MATRIX_APP_GROUP_BINDING]: { app: bob } }
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ is_direct: false, invite: [bob], creation_content: creation })
    )
    room.currentState.setStateEvents([state(EventType.RoomCreate, creation)])
    expect(conversationRoom(client, room)).toMatchObject({ appGroup: { owner: alice, app: bob }, canInvite: true })
    await expect(createConversation(client, { name: 'Bad', invite: [bob], direct: true }, false, bob)).rejects.toThrow()
    await expect(createConversation(client, { name: 'Bad', invite: [bob, '@eve:test'] }, false, bob)).rejects.toThrow()
    expect(create).toHaveBeenCalledTimes(1)
  })
  it('projects standard favourites with bounded ordering, not unrelated tags or malformed metadata', () => {
    const { client, room } = fixture()

    for (const order of [0, 0.7, 1, undefined, NaN, -1, 2, '0.1']) {
      room.addTags(
        new MatrixEvent({ type: EventType.Tag, content: { tags: { 'm.favourite': { order }, 'u.work': {} } } })
      )
      const snapshot = conversationRoom(client, room)
      expect(snapshot.favourite).toBe(true)
      expect(snapshot.favouriteOrder).toBe(
        typeof order === 'number' && Number.isFinite(order) && order >= 0 && order <= 1 ? order : undefined
      )
    }

    room.addTags(new MatrixEvent({ type: EventType.Tag, content: { tags: { 'u.work': {} } } }))
    expect(conversationRoom(client, room).favourite).toBe(false)
  })
  it.each(['leave', 'invite', 'ban'])('does not offer or execute moderation in an %s context', async context => {
    const { client, room } = fixture()
    room.updateMyMembership(context)

    const ban = vi.spyOn(client, 'ban')
    const unban = vi.spyOn(client, 'unban')
    expect(conversationMembers(room, alice).every(member => !member.canBan && !member.canUnban)).toBe(true)

    for (const kind of ['ban', 'unban'] as const) {
      await expect(changeConversationMembership(client, { kind, roomId: room.roomId, userId: bob })).rejects.toThrow()
    }

    expect(ban).not.toHaveBeenCalled()
    expect(unban).not.toHaveBeenCalled()
  })
  it.each([true, false])(
    'moderates a room by its power levels, with end-to-end encryption or without (encrypted: %s)',
    async encrypted => {
      const { client, room } = fixture({ encrypted })
      const kick = vi.spyOn(client, 'kick').mockResolvedValue({})
      const ban = vi.spyOn(client, 'ban').mockResolvedValue({})

      expect(conversationMembers(room, alice).find(member => member.userId === bob)).toMatchObject({
        canRemove: true,
        canBan: true
      })
      await changeConversationMembership(client, { kind: 'removeMember', roomId: room.roomId, userId: bob })
      await changeConversationMembership(client, { kind: 'ban', roomId: room.roomId, userId: bob })
      expect(kick).toHaveBeenCalledWith(room.roomId, bob)
      expect(ban).toHaveBeenCalledWith(room.roomId, bob)
      // Still never yourself.
      await expect(
        changeConversationMembership(client, { kind: 'removeMember', roomId: room.roomId, userId: alice })
      ).rejects.toThrow('matrix_remove_denied')
    }
  )
  it('creates DMs and groups without end-to-end encryption, showing members the history (0.20)', async () => {
    const { client } = fixture()
    const create = vi.spyOn(client, 'createRoom').mockResolvedValue({ room_id: '!new:test' })
    await createConversation(client, { name: 'Bob', invite: [bob], direct: true })
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        is_direct: true,
        invite: [bob],
        preset: 'private_chat',
        initial_state: [
          { type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'shared' } },
          { type: EventType.RoomGuestAccess, state_key: '', content: { guest_access: 'forbidden' } }
        ]
      })
    )
    expect(create.mock.calls[0][0]).not.toHaveProperty('name')
    expect(create.mock.calls[0][0]).not.toHaveProperty('creation_content')
    await createConversation(client, { name: 'Group', invite: [bob, bob] })
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ is_direct: false, invite: [bob] }))
    expect(createdState(create, 1).has(EventType.RoomEncryption)).toBe(false)
    expect(createdState(create, 1).get(EventType.RoomHistoryVisibility)).toEqual({ history_visibility: 'shared' })
  })
  it('refuses guests in every chat it makes: the private_chat preset would let them join', async () => {
    const { client } = fixture()
    const create = vi.spyOn(client, 'createRoom').mockResolvedValue({ room_id: '!new:test' })
    await createConversation(client, { name: 'Bob', invite: [bob], direct: true })
    await createConversation(client, { name: 'Group', invite: [bob] })
    await createConversation(client, { name: '', invite: [bob], direct: true }, true)

    for (const call of [0, 1, 2]) {
      expect(createdState(create, call).get(EventType.RoomGuestAccess)).toEqual({ guest_access: 'forbidden' })
    }
  })
  it("makes an agent's and a bot's chat without encryption, its history open from each invitation", async () => {
    const { client } = fixture()
    const create = vi.spyOn(client, 'createRoom').mockResolvedValue({ room_id: '!new:test' })
    const marker = { v: 1, app_id: '00000000-0000-4000-8000-e79acd97ac88', bot_user_id: bob }

    await createConversation(client, { name: '', invite: [bob], direct: true }, true)
    await createConversation(client, {
      name: '',
      invite: [bob],
      direct: true,
      initialState: [{ type: APP_BOT_DM_MARKER, state_key: '', content: marker }]
    })

    for (const call of [0, 1]) {
      expect(createdState(create, call).has(EventType.RoomEncryption)).toBe(false)
      // The owner's first message reaches an agent that has not joined yet.
      expect(createdState(create, call).get(EventType.RoomHistoryVisibility)).toEqual({ history_visibility: 'invited' })
    }

    // The bot chat keeps its own marker.
    expect(createdState(create, 1).get(APP_BOT_DM_MARKER)).toEqual(marker)
  })
  it('makes a pair and a group with an app that has no bot plain, like every other new chat', async () => {
    const { client } = fixture()
    const create = vi.spyOn(client, 'createRoom').mockResolvedValue({ room_id: '!new:test' })
    await createConversation(client, { name: '', invite: [bob], direct: true, appPair: true })
    await createConversation(client, { name: 'Team', invite: [bob] }, false, bob)

    expect(createdState(create, 0).has(EventType.RoomEncryption)).toBe(false)
    expect(createdState(create, 0).get(EventType.RoomHistoryVisibility)).toEqual({ history_visibility: 'invited' })
    expect(createdState(create, 1).has(EventType.RoomEncryption)).toBe(false)
    expect(createdState(create, 1).get(EventType.RoomHistoryVisibility)).toEqual({ history_visibility: 'shared' })
  })
  it('makes a group of only the owner’s assistants like any group: plain, history shared', async () => {
    const { client } = fixture()
    const create = vi.spyOn(client, 'createRoom').mockResolvedValue({ room_id: '!new:test' })
    await createConversation(client, { name: 'Plans', invite: [bob], direct: false })
    expect(createdState(create, 0).has(EventType.RoomEncryption)).toBe(false)
    expect(createdState(create, 0).get(EventType.RoomHistoryVisibility)).toEqual({ history_visibility: 'shared' })
  })
  it.each([
    ['an app pair that is not a DM', { name: 'X', invite: [bob], appPair: true }, false],
    ['an app pair for an agent', { name: '', invite: [bob], direct: true, appPair: true }, true]
  ])('refuses %s', async (_name, input, assistant) => {
    const { client } = fixture()
    const create = vi.spyOn(client, 'createRoom')
    await expect(createConversation(client, input, assistant)).rejects.toThrow('matrix_invite_invalid')
    expect(create).not.toHaveBeenCalled()
  })
  it('projects whether a room is an agent chat without encryption, and keeps its encryption state true', () => {
    const plainAgent = fixture({ encrypted: false, type: MATRIX_ASSISTANT_ROOM_TYPE })
    expect(conversationRoom(plainAgent.client, plainAgent.room)).toMatchObject({ encrypted: false, plainAgent: true })

    const encryptedAgent = fixture({ type: MATRIX_ASSISTANT_ROOM_TYPE })
    expect(conversationRoom(encryptedAgent.client, encryptedAgent.room)).toMatchObject({
      encrypted: true,
      plainAgent: false
    })

    const people = fixture({ encrypted: false })
    expect(conversationRoom(people.client, people.room)).toMatchObject({ encrypted: false, plainAgent: false })
  })
  it('acts in any room this account is in, with encryption or without, and in none it is not in', () => {
    const plain = fixture({ encrypted: false })
    expect(joinedConversation(plain.client, plain.room.roomId)).toBe(plain.room)

    const encrypted = fixture()
    expect(joinedConversation(encrypted.client, encrypted.room.roomId)).toBe(encrypted.room)

    plain.room.updateMyMembership('leave')
    expect(() => joinedConversation(plain.client, plain.room.roomId)).toThrow('matrix_encrypted_room_required')
    expect(() => joinedConversation(plain.client, '!unknown:test')).toThrow('matrix_encrypted_room_required')
  })
  it('uses standard immutable room type only for private assistant creation and projects it from SDK state', async () => {
    const { client, room, state } = fixture()
    const create = vi.spyOn(client, 'createRoom').mockResolvedValue({ room_id: '!new:test' })
    await createConversation(client, { name: '', invite: [bob], direct: true }, true)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        creation_content: { type: MATRIX_ASSISTANT_ROOM_TYPE },
        is_direct: true,
        invite: [bob]
      })
    )
    expect(conversationRoom(client, room).roomType).toBeUndefined()
    room.currentState.setStateEvents([state(EventType.RoomCreate, { type: MATRIX_ASSISTANT_ROOM_TYPE })])
    expect(conversationRoom(client, room)).toMatchObject({ roomType: MATRIX_ASSISTANT_ROOM_TYPE, canInvite: false })
    await expect(createConversation(client, { name: 'Group', invite: [bob] }, true)).rejects.toThrow(
      'matrix_invite_invalid'
    )
    expect(create).toHaveBeenCalledTimes(1)
  })
  it('rejects invalid recipients but personal ignore does not forbid sending invitations', async () => {
    const { client } = fixture()
    const create = vi.spyOn(client, 'createRoom')

    for (const invite of [[], [alice], [bob, '@carol:test']]) {
      await expect(createConversation(client, { name: 'DM', invite, direct: true })).rejects.toThrow()
    }

    expect(create).not.toHaveBeenCalled()
    vi.spyOn(client, 'isUserIgnored').mockReturnValue(true)
    create.mockResolvedValue({ room_id: '!new:test' })
    await createConversation(client, { name: 'DM', invite: [bob], direct: true })
    const invite = vi.spyOn(client, 'invite').mockResolvedValue({})
    await changeConversationMembership(client, { kind: 'invite', roomId: '!r:test', userId: bob })
    expect(invite).toHaveBeenCalledWith('!r:test', bob)
  })
  it('uses standard DM account data and preserves unrelated mappings', async () => {
    const { client, room } = fixture()
    vi.spyOn(client, 'getAccountDataFromServer').mockResolvedValue({
      [bob]: ['!old:test'],
      '@carol:test': ['!other:test']
    })
    const write = vi.spyOn(client, 'setAccountData').mockResolvedValue({})
    await rememberDirectConversation(client, bob, room.roomId)
    expect(write).toHaveBeenCalledWith(EventType.Direct, {
      [bob]: ['!old:test', room.roomId],
      '@carol:test': ['!other:test']
    })
    client.store.storeAccountDataEvents([
      new MatrixEvent({ type: EventType.Direct, content: { [bob]: [room.roomId] } })
    ])
    expect(conversationRoom(client, room).direct).toBe(true)
  })
  it("draws an official bot's chat as one-to-one from its own marker, before the account's m.direct hint has come", () => {
    const { client, room, state } = fixture({ encrypted: false })
    const marker = { v: 1, app_id: '00000000-0000-4000-8000-e79acd97ac88', bot_user_id: bob }

    // A chat just made: nothing lists it in m.direct yet, and nothing marks it as the bot's.
    expect(conversationRoom(client, room).direct).toBe(false)

    room.currentState.setStateEvents([state(APP_BOT_DM_MARKER, marker)])
    expect(conversationRoom(client, room).direct).toBe(true)

    // Its peer's face is the bot's from then on, as for any one-to-one chat.
    room.currentState.setStateEvents([
      state(EventType.RoomMember, { membership: 'invite', displayname: 'Bob', avatar_url: 'mxc://matrix.test/bob' }, bob)
    ])
    expect(conversationRoom(client, room).peerAvatarMxc).toBe('mxc://matrix.test/bob')
  })

  it("does not take someone else's marker, a third member, or a chat the person has left for an official bot's chat", () => {
    const marker = { v: 1, app_id: '00000000-0000-4000-8000-e79acd97ac88', bot_user_id: bob }

    // Set by the bot, not by this account: it proves nothing.
    const foreign = fixture({ encrypted: false })
    foreign.room.currentState.setStateEvents([
      new MatrixEvent({ type: APP_BOT_DM_MARKER, state_key: '', sender: bob, room_id: foreign.room.roomId, content: marker })
    ])
    expect(conversationRoom(foreign.client, foreign.room).direct).toBe(false)

    // A third person is in the room: a group to the bot, whatever its marker says.
    const crowded = fixture({ encrypted: false })
    crowded.room.currentState.setStateEvents([
      crowded.state(APP_BOT_DM_MARKER, marker),
      crowded.state(EventType.RoomMember, { membership: 'join', displayname: 'Carol' }, '@carol:test')
    ])
    expect(conversationRoom(crowded.client, crowded.room).direct).toBe(false)

    // The person is no longer in it.
    const left = fixture({ encrypted: false })
    left.room.currentState.setStateEvents([left.state(APP_BOT_DM_MARKER, marker)])
    left.room.updateMyMembership('leave')
    expect(conversationRoom(left.client, left.room).direct).toBe(false)
  })

  it("projects the other member's native avatar for an ordinary one-to-one roster row", () => {
    const { client, room, state } = fixture()
    room.currentState.setStateEvents([
      state(EventType.RoomMember, { membership: 'invite', displayname: 'Bob', avatar_url: 'mxc://matrix.test/bob' }, bob)
    ])
    client.store.storeAccountDataEvents([
      new MatrixEvent({ type: EventType.Direct, content: { [bob]: [room.roomId] } })
    ])

    expect(conversationRoom(client, room).peerAvatarMxc).toBe('mxc://matrix.test/bob')
  })

  it("keeps an assistant's private room out of the ordinary peer avatar path", () => {
    const { client, room } = fixture({ type: MATRIX_ASSISTANT_ROOM_TYPE })
    client.store.storeAccountDataEvents([
      new MatrixEvent({ type: EventType.Direct, content: { [bob]: [room.roomId] } })
    ])

    expect(conversationRoom(client, room)).toMatchObject({ direct: true })
    expect(conversationRoom(client, room).peerAvatarMxc).toBeUndefined()
  })

  it("projects the owner's model for the room from its private account data, and nothing unknown", () => {
    const { client, room } = fixture()
    expect(conversationRoom(client, room).model).toBeUndefined()

    const choose = (content: object) => {
      const event = new MatrixEvent({ type: 'io.atum.model', content })
      room.addAccountData([event])
    }

    choose({ model: 'nhat-thuc' })
    expect(conversationRoom(client, room).model).toBe('nhat-thuc')
    choose({ model: 'thai-cuc' })
    expect(conversationRoom(client, room).model).toBeUndefined()
  })
  it("projects the owner's own name for a chat from its private account data, one bounded line or nothing", () => {
    const { client, room } = fixture()
    expect(conversationRoom(client, room).title).toBeUndefined()

    const name = (content: object) => room.addAccountData([new MatrixEvent({ type: 'io.atum.title', content })])

    name({ title: '  Trip\nplans ' })
    expect(conversationRoom(client, room).title).toBe('Trip plans')
    name({})
    expect(conversationRoom(client, room).title).toBeUndefined()
    name({ title: 'x'.repeat(81) })
    expect(conversationRoom(client, room).title).toBeUndefined()
    name({ title: 42 })
    expect(conversationRoom(client, room).title).toBeUndefined()
  })
  it("projects the owner's synced look choice and defaults an unknown future record", () => {
    const { client, room } = fixture()
    const choose = (content: object) =>
      room.addAccountData([new MatrixEvent({ type: 'io.atum.chat.look', content })])

    expect(conversationRoom(client, room).look).toEqual({ v: 1, background: { kind: 'default' } })
    choose({ v: 1, background: { kind: 'pack', pack_id: '00000000-0000-4000-8000-177920da9661' } })
    expect(conversationRoom(client, room).look).toEqual({
      v: 1,
      background: { kind: 'pack', pack_id: '00000000-0000-4000-8000-177920da9661' }
    })
    choose({ v: 9, background: { kind: 'future' } })
    expect(conversationRoom(client, room).look).toEqual({ v: 1, background: { kind: 'default' } })
  })
  it("titles an assistant history by the owner's first message only once its whole history is loaded", () => {
    const { client, room, state } = fixture()
    room.currentState.setStateEvents([
      state(EventType.RoomCreate, { creator: alice, type: MATRIX_ASSISTANT_ROOM_TYPE })
    ])

    const message = (id: string, sender: string, content: object, roomId = room.roomId) =>
      new MatrixEvent({ type: EventType.RoomMessage, event_id: id, sender, room_id: roomId, content })

    const create = new MatrixEvent({
      type: EventType.RoomCreate,
      state_key: '',
      event_id: '$create',
      sender: alice,
      room_id: '!whole:test',
      origin_server_ts: 1_000,
      content: { creator: alice, type: MATRIX_ASSISTANT_ROOM_TYPE }
    })

    // The start of the history is not loaded: no first line, so the title can never shift.
    room.addLiveEvents([message('$a', alice, { msgtype: 'm.text', body: 'A later question' })], { addToState: false })
    expect(conversationRoom(client, room).firstLine).toBeUndefined()

    const whole = new Room('!whole:test', client, alice)
    whole.currentState.setStateEvents([create])
    whole.addLiveEvents(
      [
        create,
        message('$file', alice, { msgtype: 'm.file', body: 'notes.pdf' }, whole.roomId),
        message('$agent', bob, { msgtype: 'm.text', body: 'Hello!' }, whole.roomId),
        message(
          '$first',
          alice,
          { msgtype: 'm.text', body: `  Plan   a trip ${'to the mountains and back again '.repeat(4)}` },
          whole.roomId
        )
      ],
      { addToState: false }
    )
    const projected = conversationRoom(client, whole)
    expect(projected.firstLine?.startsWith('Plan a trip to the mountains')).toBe(true)
    expect(projected.firstLine?.endsWith('…')).toBe(true)
    expect([...projected.firstLine!].length).toBeLessThanOrEqual(61)
    expect(projected.createdAt).toBe(1_000)
  })
  it('projects muting from the push rules once they have synced, and nothing before', () => {
    const { client, room } = fixture()
    expect(conversationRoom(client, room).muted).toBe(false)

    client.pushRules = {
      global: {
        room: [{ rule_id: room.roomId, default: false, enabled: true, actions: ['dont_notify' as never] }]
      }
    } as never
    expect(conversationRoom(client, room).muted).toBe(true)
    client.pushRules = {
      global: { room: [{ rule_id: room.roomId, default: false, enabled: true, actions: ['notify' as never] }] }
    } as never
    expect(conversationRoom(client, room).muted).toBe(false)
  })
  it('projects actual SDK membership and power levels, never a second roster', async () => {
    const { client, room, state } = fixture()
    expect(conversationMembers(room, alice)).toEqual([
      {
        userId: alice,
        rawName: 'Alice',
        name: 'Alice',
        membership: 'join',
        avatarMxc: null,
        canRemove: false,
        canBan: false,
        canUnban: false
      },
      {
        userId: bob,
        rawName: 'Bob',
        name: 'Bob',
        membership: 'invite',
        avatarMxc: null,
        canRemove: true,
        canBan: true,
        canUnban: false
      }
    ])
    const kick = vi.spyOn(client, 'kick').mockResolvedValue({})
    await changeConversationMembership(client, { kind: 'removeMember', roomId: room.roomId, userId: bob })
    expect(kick).toHaveBeenCalledWith(room.roomId, bob)
    // A successful HTTP write is not fabricated into SDK membership.
    expect(room.getMember(bob)?.membership).toBe('invite')
    room.currentState.setStateEvents([state(EventType.RoomMember, { membership: 'leave' }, bob)])
    expect(conversationMembers(room, alice).map(m => m.userId)).toEqual([alice])
    await expect(
      changeConversationMembership(client, { kind: 'removeMember', roomId: room.roomId, userId: bob })
    ).rejects.toThrow()
  })
  it('keeps the raw profile name when the SDK disambiguates duplicate display names', () => {
    const { room, state } = fixture()
    room.currentState.setStateEvents([
      state(EventType.RoomMember, { membership: 'join', displayname: 'Moon' }, bob),
      state(EventType.RoomMember, { membership: 'join', displayname: 'Moon' }, '@app-moon:test')
    ])

    const members = conversationMembers(room, alice).filter(member => member.rawName === 'Moon')

    expect(members.map(member => member.userId)).toEqual([bob, '@app-moon:test'])
    expect(members.every(member => member.name !== member.rawName)).toBe(true)
  })
  it('refuses removal of self, equal/higher-power members and actions after leaving', async () => {
    const { client, room, state } = fixture()
    const kick = vi.spyOn(client, 'kick')
    await expect(
      changeConversationMembership(client, { kind: 'removeMember', roomId: room.roomId, userId: alice })
    ).rejects.toThrow()
    room.currentState.setStateEvents([
      state(EventType.RoomPowerLevels, { users: { [alice]: 50, [bob]: 100 }, kick: 50 })
    ])
    expect(conversationMembers(room, alice).every(m => !m.canRemove)).toBe(true)
    await expect(
      changeConversationMembership(client, { kind: 'removeMember', roomId: room.roomId, userId: bob })
    ).rejects.toThrow()
    room.updateMyMembership('leave')
    expect(() => joinedConversation(client, room.roomId)).toThrow()
    expect(conversationRoom(client, room).canInvite).toBe(false)
    expect(kick).not.toHaveBeenCalled()
  })
  it('propagates server denial without changing membership or permission hints', async () => {
    const { client, room } = fixture()
    const invite = vi.spyOn(client, 'invite').mockRejectedValue(new Error('M_FORBIDDEN'))
    await expect(
      changeConversationMembership(client, { kind: 'invite', roomId: room.roomId, userId: '@carol:test' })
    ).rejects.toThrow('M_FORBIDDEN')
    expect(invite).toHaveBeenCalledWith(room.roomId, '@carol:test')
    expect(room.getMember('@carol:test')).toBeNull()
  })
  it('obeys invitation power levels without claiming a global block', async () => {
    const { client, room, state } = fixture()
    const invite = vi.spyOn(client, 'invite')
    room.currentState.setStateEvents([state(EventType.RoomPowerLevels, { users: { [alice]: 0 }, invite: 50 })])
    expect(conversationRoom(client, room).canInvite).toBe(false)
    await expect(
      changeConversationMembership(client, { kind: 'invite', roomId: room.roomId, userId: '@carol:test' })
    ).rejects.toThrow()
    expect(invite).not.toHaveBeenCalled()
  })
  it('uses room ban/unban with no optimistic membership, no self/equal-power moderation and both unban powers', async () => {
    const { client, room, state } = fixture()
    const ban = vi.spyOn(client, 'ban').mockResolvedValue({})
    const unban = vi.spyOn(client, 'unban').mockResolvedValue({})
    const invite = vi.spyOn(client, 'invite')
    await changeConversationMembership(client, { kind: 'ban', roomId: room.roomId, userId: bob })
    expect(ban).toHaveBeenCalledWith(room.roomId, bob)
    expect(room.getMember(bob)?.membership).toBe('invite')
    await expect(
      changeConversationMembership(client, { kind: 'unban', roomId: room.roomId, userId: bob })
    ).rejects.toThrow()
    room.currentState.setStateEvents([state(EventType.RoomMember, { membership: 'ban' }, bob)])
    expect(conversationMembers(room, alice).find(m => m.userId === bob)).toMatchObject({
      canRemove: false,
      canBan: false,
      canUnban: true
    })
    await changeConversationMembership(client, { kind: 'unban', roomId: room.roomId, userId: bob })
    expect(unban).toHaveBeenCalledWith(room.roomId, bob)
    expect(invite).not.toHaveBeenCalled()
    expect(room.getMember(bob)?.membership).toBe('ban')
    room.currentState.setStateEvents([
      state(EventType.RoomPowerLevels, { users: { [alice]: 50, [bob]: 0 }, ban: 50, kick: 75 })
    ])
    await expect(
      changeConversationMembership(client, { kind: 'unban', roomId: room.roomId, userId: bob })
    ).rejects.toThrow()

    for (const userId of [alice, '@absent:test']) {
      await expect(changeConversationMembership(client, { kind: 'ban', roomId: room.roomId, userId })).rejects.toThrow()
    }

    room.currentState.setStateEvents([
      state(EventType.RoomMember, { membership: 'join' }, bob),
      state(EventType.RoomPowerLevels, { users: { [alice]: 50, [bob]: 50 }, ban: 50 })
    ])
    await expect(
      changeConversationMembership(client, { kind: 'ban', roomId: room.roomId, userId: bob })
    ).rejects.toThrow()
    expect(ban).toHaveBeenCalledTimes(1)
  })
})

it('joins actual SDK account-data projection to native refusal without defaulting foreign or malformed choices', () => {
  const { client, room } = fixture()
  const principal = '00000000-0000-4000-8000-bd7662a5eeb4'
  const other = '00000000-0000-4000-8000-b454f82c5857'
  const atum = { v: 2, source: 'atum', model: 'nhat-thuc', effort: 'high' }
  const own = { v: 2, source: 'connection', connectionId: 'personal-key', model: 'gpt-6-luna', effort: 'low' }

  for (const content of [own, { v: 99, model: 'nguyet-thuc' }, { ...atum, agents: { [principal]: own } }]) {
    room.addAccountData([new MatrixEvent({ type: 'io.atum.model', content })])
    expect(() => requireMatrixSessionChoice(conversationRoom(client, room), principal)).toThrow(
      'matrix_model_choice_unavailable'
    )
  }

  room.addAccountData([new MatrixEvent({ type: 'io.atum.model', content: { ...atum, agents: { [other]: own } } })])
  const projected = conversationRoom(client, room)
  expect(projected).toMatchObject({
    model: 'nhat-thuc',
    effort: 'high',
    modelChoice: { ...atum, agents: { [other]: own } }
  })
  expect(() => requireMatrixSessionChoice(projected, principal)).not.toThrow()
})
