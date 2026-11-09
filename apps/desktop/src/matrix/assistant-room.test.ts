import { createClient, EventType, MatrixEvent, Room } from 'matrix-js-sdk'
import type { IStateEventWithRoomId, MatrixClient } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'

import { MATRIX_APP_GROUP_BINDING, MATRIX_APP_GROUP_TYPE } from '../../shared/matrix-app-room'
import { isAssistantRoom, MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import {
  adoptAssistantRoomInvitation,
  findAssistantRoom,
  inviteAgentToGroup,
  readAppRoom,
  readAssistantRoom,
  readGroupRoom,
  readRetiredAgentRoom,
  requireHumanInvitation
} from './assistant-room'
import { createConversation } from './conversations'

const ROOM_ID = '!assistant:test'
const OWNER = '@owner:test'
const AGENT = '@agent:test'
const OTHER = '@other:test'

it('uses standard encrypted two-party rooms for apps, never the private Hermes room', async () => {
  const events = validState()
  await expect(
    readAppRoom(client(OWNER, events), { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT })
  ).rejects.toThrow()
  events[0].content = {}
  await expect(
    readAppRoom(client(OWNER, events), { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT })
  ).resolves.toBeUndefined()
  events.push(member(OTHER, 'leave'))
  await expect(
    readAppRoom(client(OWNER, events), { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT })
  ).rejects.toThrow()
})

let sequence = 0

function state(type: string, stateKey: string, content: Record<string, unknown>): IStateEventWithRoomId {
  sequence += 1

  return {
    type,
    state_key: stateKey,
    room_id: ROOM_ID,
    content,
    event_id: `$state-${sequence}`,
    sender: OWNER,
    origin_server_ts: sequence
  }
}

function member(userId: string, membership: string) {
  return state(EventType.RoomMember, userId, { membership })
}

function validState(agentMembership = 'join'): IStateEventWithRoomId[] {
  return [
    state(EventType.RoomCreate, '', { type: MATRIX_ASSISTANT_ROOM_TYPE }),
    state(EventType.RoomEncryption, '', { algorithm: 'm.megolm.v1.aes-sha2' }),
    state(EventType.RoomHistoryVisibility, '', { history_visibility: 'joined' }),
    member(OWNER, 'join'),
    member(AGENT, agentMembership)
  ]
}

/** An agent's room as 0.20 makes it: no encryption, history from each member's invitation. */
function plainState(agentMembership = 'join', history = 'invited'): IStateEventWithRoomId[] {
  return [
    state(EventType.RoomCreate, '', { type: MATRIX_ASSISTANT_ROOM_TYPE }),
    state(EventType.RoomHistoryVisibility, '', { history_visibility: history }),
    member(OWNER, 'join'),
    member(AGENT, agentMembership)
  ]
}

function client(userId = OWNER, events = validState()): MatrixClient {
  const value = createClient({ baseUrl: 'https://matrix.test', userId })
  vi.spyOn(value.http, 'authedRequest').mockResolvedValue(events)

  return value
}

describe('assistant invitation acceptance is not turn authority', () => {
  function invited(events = plainState('invite')) {
    const value = client(AGENT)
    const room = new Room(ROOM_ID, value, AGENT)
    room.updateMyMembership('invite')
    // Synapse's stripped invite state need not contain history visibility.
    room.currentState.setStateEvents(events.filter(event => event.type !== EventType.RoomHistoryVisibility).map(event => new MatrixEvent(event)))
    vi.spyOn(value, 'getRoom').mockReturnValue(room)
    const fullState = vi.spyOn(value, 'roomState').mockRejectedValue(Object.assign(new Error('not joined'), { errcode: 'M_FORBIDDEN' }))

    return { value, room, fullState }
  }

  it.each([{ events: plainState('invite') }, { events: validState('invite') }])('accepts only the owner-signed assistant invitation without full-state access', async ({ events }) => {
    const { value, fullState } = invited(events)
    await expect(readAssistantRoom(value, { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT, allowInvite: true })).resolves.toBeUndefined()
    expect(fullState).not.toHaveBeenCalled()
    await expect(readAssistantRoom(value, { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT, allowInvite: true, forTurn: true })).rejects.toThrow('not joined')
    expect(fullState).toHaveBeenCalledOnce()
  })

  it.each(['inviter', 'creator', 'type', 'owner-left', 'third-member', 'missing-invite', 'stopped'])('rejects %s before acceptance', async mode => {
    const events = plainState('invite')

    if (mode === 'inviter') {
      events.find(event => event.state_key === AGENT)!.sender = OTHER
    }

    if (mode === 'creator') {
      events[0].sender = OTHER
    }

    if (mode === 'type') {
      events[0].content.type = 'io.atum.group'
    }

    if (mode === 'owner-left') {
      events.find(event => event.state_key === OWNER)!.content.membership = 'leave'
    }

    if (mode === 'third-member') {
      events.push(member(OTHER, 'leave'))
    }
    const { value, fullState } = invited(mode === 'missing-invite' ? events.filter(event => event.state_key !== AGENT) : events)
    await expect(readAssistantRoom(value, { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT, allowInvite: true }, () => mode !== 'stopped')).rejects.toThrow('matrix_private_assistant_room_required')
    expect(fullState).not.toHaveBeenCalled()
  })

  it('requires full server state as soon as the room is joined', async () => {
    const { value, room, fullState } = invited()
    room.updateMyMembership('join')
    await expect(readAssistantRoom(value, { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT, allowInvite: true })).rejects.toThrow('not joined')
    expect(fullState).toHaveBeenCalledOnce()
  })

  function strippedAgentInvite(
    value: MatrixClient,
    roomId: string,
    options: { typed?: boolean; third?: boolean } = {}
  ) {
    const event = (type: string, stateKey: string, content: Record<string, unknown>, sender: string) =>
      new MatrixEvent({ type, state_key: stateKey, content, sender, room_id: roomId } as never)
    const room = new Room(roomId, value, OWNER)
    room.currentState.setStateEvents([
      event(EventType.RoomCreate, '', options.typed === false ? {} : { type: MATRIX_ASSISTANT_ROOM_TYPE }, AGENT),
      event(EventType.RoomMember, AGENT, { membership: 'join' }, AGENT),
      event(EventType.RoomMember, OWNER, { membership: 'invite', is_direct: true }, AGENT),
      ...(options.third ? [event(EventType.RoomMember, OTHER, { membership: 'join' }, OTHER)] : [])
    ])
    room.updateMyMembership('invite')
    value.store.storeRoom(room)

    return room
  }

  const joinedAgentState = () => {
    const events = plainState()
    events[0]!.sender = AGENT
    events.find(event => event.state_key === OWNER)!.sender = OWNER
    events.find(event => event.state_key === AGENT)!.sender = AGENT
    events.push(state(EventType.RoomPowerLevels, '', { users: { [OWNER]: 100, [AGENT]: 100 } }))

    return events
  }

  it('uses realistic stripped invite state, retries joining, then validates full joined state', async () => {
    const value = client(OWNER, joinedAgentState())
    strippedAgentInvite(value, '!agent:test')
    const join = vi.spyOn(value, 'joinRoom')
      .mockRejectedValueOnce(new Error('propagating'))
      .mockRejectedValueOnce(new Error('propagating'))
      .mockResolvedValue(value.getRoom('!agent:test')!)

    await expect(
      adoptAssistantRoomInvitation(value, { ownerId: OWNER, agentId: AGENT, createdBy: 'agent' })
    ).resolves.toBe('!agent:test')
    expect(join).toHaveBeenCalledTimes(3)
  })

  it('falls through an unjoinable stripped invite to the next deterministic candidate', async () => {
    const value = client(OWNER, joinedAgentState())
    strippedAgentInvite(value, '!zzz-agent:test')
    strippedAgentInvite(value, '!mmm-agent:test')
    const calls: string[] = []
    vi.spyOn(value, 'joinRoom').mockImplementation(async roomId => {
      calls.push(roomId)

      if (roomId === '!mmm-agent:test') {
        throw new Error('stale')
      }

      return value.getRoom(roomId)!
    })

    await expect(
      adoptAssistantRoomInvitation(value, { ownerId: OWNER, agentId: AGENT, createdBy: 'agent' })
    ).resolves.toBe('!zzz-agent:test')
    expect(calls).toEqual(['!mmm-agent:test', '!mmm-agent:test', '!mmm-agent:test', '!zzz-agent:test'])
  })

  it('does not join untyped or crowded owner pre-join candidates', async () => {
    const value = client(OWNER, joinedAgentState())
    strippedAgentInvite(value, '!untyped:test', { typed: false })
    strippedAgentInvite(value, '!crowded:test', { third: true })
    const join = vi.spyOn(value, 'joinRoom')

    await expect(
      adoptAssistantRoomInvitation(value, { ownerId: OWNER, agentId: AGENT, createdBy: 'agent' })
    ).resolves.toBeNull()
    expect(join).not.toHaveBeenCalled()
  })
})

describe('fresh shared app group gate', () => {
  const group = () => {
    const events = validState()
    events[0].content = { type: MATRIX_APP_GROUP_TYPE, [MATRIX_APP_GROUP_BINDING]: { app: AGENT } }
    events.push(member(OTHER, 'join'), member('@former:test', 'leave'))

    return events
  }

  it.each([OWNER, AGENT])('accepts owner-created binding for %s with ordinary extra/former members', async own => {
    await expect(
      readAppRoom(client(own, group()), { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT })
    ).resolves.toBeUndefined()
    await expect(
      readAssistantRoom(client(own, group()), { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT })
    ).rejects.toThrow()
  })
  it.each([
    'creator',
    'binding',
    'missing',
    'version',
    'untyped',
    'history',
    'encryption',
    'owner-left',
    'app-left',
    'foreign'
  ])('rejects invalid %s before joining or publishing', async mode => {
    const events = group()

    if (mode === 'creator') {
      events[0].sender = OTHER
    }

    if (mode === 'binding') {
      events[0].content[MATRIX_APP_GROUP_BINDING] = { app: OTHER }
    }

    if (mode === 'missing') {
      delete events[0].content[MATRIX_APP_GROUP_BINDING]
    }

    if (mode === 'version') {
      events[0].content.type = 'io.atum.app_group.v2'
    }

    if (mode === 'untyped') {
      events[0].content = {}
    }

    if (mode === 'history') {
      events[2].content.history_visibility = 'shared'
    }

    if (mode === 'encryption') {
      events[1].content.algorithm = 'unknown'
    }

    if (mode === 'owner-left') {
      events[3].content.membership = 'leave'
    }

    if (mode === 'app-left') {
      events[4].content.membership = 'leave'
    }

    await expect(
      readAppRoom(client(mode === 'foreign' ? OTHER : OWNER, events), {
        roomId: ROOM_ID,
        ownerId: OWNER,
        agentId: AGENT,
        allowInvite: true
      })
    ).rejects.toThrow()
  })
  it('allows only the enrollment invitation check; later sends require joined app membership', async () => {
    const events = group()
    events[4].content.membership = 'invite'
    const value = client(OWNER, events)
    const input = { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT }
    await expect(readAppRoom(value, input)).rejects.toThrow()
    await expect(readAppRoom(value, { ...input, allowInvite: true })).resolves.toBeUndefined()
    await expect(readAppRoom(value, { ...input, allowInvite: true }, () => false)).rejects.toThrow()
  })
})

describe('readAssistantRoom', () => {
  it('accepts only the exact current encrypted owner/enrolled-agent pair with joined history', async () => {
    const value = client()

    await expect(readAssistantRoom(value, { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT })).resolves.toBeUndefined()
  })

  it('allows the enrolled-agent invitation only for the explicit connection check', async () => {
    const invited = client(OWNER, validState('invite'))

    await expect(
      readAssistantRoom(invited, { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT, allowInvite: true })
    ).resolves.toBeUndefined()
    await expect(readAssistantRoom(invited, { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT })).rejects.toThrow(
      'matrix_private_assistant_room_required'
    )
  })

  it.each([
    ['a foreign caller', OTHER, validState()],
    ['an untyped room', OWNER, validState().filter(event => event.type !== EventType.RoomCreate)],
    [
      'an unrelated room type',
      OWNER,
      [
        state(EventType.RoomCreate, '', { type: 'm.space' }),
        ...validState().filter(event => event.type !== EventType.RoomCreate)
      ]
    ],
    ['a collapsed owner and agent identity', OWNER, validState(), OWNER],
    [
      'an encryption other than Megolm',
      OWNER,
      validState().map(event =>
        event.type === EventType.RoomEncryption ? { ...event, content: { algorithm: 'unknown' } } : event
      )
    ],
    ['a plain room showing its history to anyone who joins later', OWNER, plainState('join', 'shared')],
    ['a plain room of no type', OWNER, [state(EventType.RoomCreate, '', {}), ...plainState().slice(1)]],
    ['a plain room with a third member', OWNER, [...plainState(), member(OTHER, 'join')]],
    [
      'history visible before joining',
      OWNER,
      [
        state(EventType.RoomCreate, '', { type: MATRIX_ASSISTANT_ROOM_TYPE }),
        state(EventType.RoomEncryption, '', { algorithm: 'm.megolm.v1.aes-sha2' }),
        state(EventType.RoomHistoryVisibility, '', { history_visibility: 'shared' }),
        member(OWNER, 'join'),
        member(AGENT, 'join')
      ]
    ],
    ['an active human third member', OWNER, [...validState(), member(OTHER, 'join')]],
    ['a former human third member', OWNER, [...validState(), member(OTHER, 'leave')]],
    ['a banned former human third member', OWNER, [...validState(), member(OTHER, 'ban')]],
    [
      'an invited human in place of the enrolled agent',
      OWNER,
      [
        state(EventType.RoomCreate, '', { type: MATRIX_ASSISTANT_ROOM_TYPE }),
        state(EventType.RoomEncryption, '', { algorithm: 'm.megolm.v1.aes-sha2' }),
        state(EventType.RoomHistoryVisibility, '', { history_visibility: 'joined' }),
        member(OWNER, 'join'),
        member(OTHER, 'invite')
      ]
    ],
    [
      'an owner who no longer has joined membership',
      OWNER,
      [
        state(EventType.RoomCreate, '', { type: MATRIX_ASSISTANT_ROOM_TYPE }),
        state(EventType.RoomEncryption, '', { algorithm: 'm.megolm.v1.aes-sha2' }),
        state(EventType.RoomHistoryVisibility, '', { history_visibility: 'joined' }),
        member(OWNER, 'leave'),
        member(AGENT, 'join')
      ]
    ]
  ])('rejects %s', async (_name, userId, events, agentId = AGENT) => {
    await expect(
      readAssistantRoom(client(userId, events), { roomId: ROOM_ID, ownerId: OWNER, agentId })
    ).rejects.toThrow('matrix_private_assistant_room_required')
  })

  it('rejects a room that becomes stopped while its full server state is in flight', async () => {
    let active = true
    let resolve!: (events: IStateEventWithRoomId[]) => void

    const pending = new Promise<IStateEventWithRoomId[]>(done => {
      resolve = done
    })

    const value = createClient({ baseUrl: 'https://matrix.test', userId: OWNER })
    vi.spyOn(value.http, 'authedRequest').mockReturnValue(pending)

    const check = readAssistantRoom(value, { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT }, () => active)

    active = false
    resolve(validState())

    await expect(check).rejects.toThrow('matrix_private_assistant_room_required')
  })
})

describe('an agent’s room without end-to-end encryption (0.20)', () => {
  const input = { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT }

  it.each(['invited', 'joined'])('admits the owner and the agent with history from %s', async history => {
    await expect(readAssistantRoom(client(OWNER, plainState('join', history)), input)).resolves.toBeUndefined()
    // The agent's own SDK reads it the same way.
    await expect(readAssistantRoom(client(AGENT, plainState('join', history)), input)).resolves.toBeUndefined()
  })

  it('admits the agent while still invited only for the connection check, as for an encrypted room', async () => {
    await expect(
      readAssistantRoom(client(OWNER, plainState('invite')), { ...input, allowInvite: true })
    ).resolves.toBeUndefined()
    await expect(readAssistantRoom(client(OWNER, plainState('invite')), input)).rejects.toThrow(
      'matrix_private_assistant_room_required'
    )
  })

  it('admits a plain app pair and app group as 0.20 makes them, never with history open to all', async () => {
    const appPair = (history: string) => [state(EventType.RoomCreate, '', {}), ...plainState('join', history).slice(1)]
    await expect(readAppRoom(client(OWNER, appPair('invited')), input)).resolves.toBeUndefined()
    await expect(readAppRoom(client(OWNER, appPair('joined')), input)).resolves.toBeUndefined()
    await expect(readAppRoom(client(OWNER, appPair('world_readable')), input)).rejects.toThrow(
      'matrix_private_assistant_room_required'
    )

    const appGroup = (history: string, app = AGENT) => [
      state(EventType.RoomCreate, '', { type: MATRIX_APP_GROUP_TYPE, [MATRIX_APP_GROUP_BINDING]: { app } }),
      ...plainState('join', history).slice(1)
    ]

    await expect(readAppRoom(client(OWNER, appGroup('shared')), input)).resolves.toBeUndefined()
    await expect(readAppRoom(client(OWNER, appGroup('world_readable')), input)).rejects.toThrow(
      'matrix_private_assistant_room_required'
    )
    await expect(readAppRoom(client(OWNER, appGroup('shared', '@other:test')), input)).rejects.toThrow(
      'matrix_private_assistant_room_required'
    )

    // A plain room of another type is not an app's room.
    const typed = [state(EventType.RoomCreate, '', { type: 'io.example.other' }), ...plainState().slice(1)]
    await expect(readAppRoom(client(OWNER, typed), input)).rejects.toThrow('matrix_private_assistant_room_required')
  })

  it('keeps an encrypted app pair on Megolm with history from joining (no downgrade)', async () => {
    const encryptedPair = (history: string) => [
      state(EventType.RoomCreate, '', {}),
      state(EventType.RoomEncryption, '', { algorithm: 'm.megolm.v1.aes-sha2' }),
      ...plainState('join', history).slice(1)
    ]

    await expect(readAppRoom(client(OWNER, encryptedPair('joined')), input)).resolves.toBeUndefined()
    await expect(readAppRoom(client(OWNER, encryptedPair('invited')), input)).rejects.toThrow(
      'matrix_private_assistant_room_required'
    )
  })
})

/** The state a room has once `createConversation` made it and both members joined. */
async function madeRoom(
  input: Parameters<typeof createConversation>[1],
  assistant = false,
  appGroup?: string
): Promise<IStateEventWithRoomId[]> {
  const owner = createClient({ baseUrl: 'https://matrix.test', userId: OWNER })
  const create = vi.spyOn(owner, 'createRoom').mockResolvedValue({ room_id: ROOM_ID })
  await createConversation(owner, input, assistant, appGroup)
  const request = create.mock.calls[0][0]

  return [
    state(EventType.RoomCreate, '', { ...request.creation_content }),
    ...(request.initial_state ?? []).map(each => state(each.type, each.state_key ?? '', each.content)),
    member(OWNER, 'join'),
    ...(request.invite ?? []).map(id => member(id, 'join'))
  ]
}

describe('rooms as createConversation makes them pass their own admission', () => {
  const input = { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT }

  it('an agent’s room passes the agent check', async () => {
    const events = await madeRoom({ name: '', invite: [AGENT], direct: true }, true)
    await expect(readAssistantRoom(client(OWNER, events), input)).resolves.toBeUndefined()
  })

  it('a pair with an app that has no bot, and its app group, pass the app check', async () => {
    const pair = await madeRoom({ name: '', invite: [AGENT], direct: true, appPair: true })
    await expect(readAppRoom(client(OWNER, pair), input)).resolves.toBeUndefined()

    const group = await madeRoom({ name: 'Team', invite: [AGENT] }, false, AGENT)
    await expect(readAppRoom(client(OWNER, group), input)).resolves.toBeUndefined()
  })

  it('a group made with only the owner’s assistant takes a person, who sees its history', async () => {
    const events = await madeRoom({ name: 'Plans', invite: [AGENT], direct: false })
    await expect(
      requireHumanInvitation(client(OWNER, events), { roomId: ROOM_ID, userId: OTHER, agentId: AGENT }, () => true)
    ).resolves.toBeUndefined()
    expect(events.find(each => each.type === EventType.RoomHistoryVisibility)?.content.history_visibility).toBe(
      'shared'
    )
  })
})

describe('requireHumanInvitation', () => {
  it.each([undefined, '@replacement:test'])(
    'keeps typed room invitations closed after revocation/replacement (%s)',
    async agentId => {
      await expect(
        requireHumanInvitation(client(), { roomId: ROOM_ID, userId: OTHER, agentId }, () => true)
      ).rejects.toThrow('matrix_private_assistant_room_required')
      // A normal human room still follows Matrix invitation permissions.
      await expect(
        requireHumanInvitation(
          client(OWNER, [member(OWNER, 'join')]),
          { roomId: ROOM_ID, userId: OTHER, agentId },
          () => true
        )
      ).resolves.toBeUndefined()
    }
  )
  it('rejects a stale invitation state read after its SDK is stopped', async () => {
    await expect(
      requireHumanInvitation(client(OWNER, []), { roomId: ROOM_ID, userId: OTHER }, () => false)
    ).rejects.toThrow('matrix_private_assistant_room_required')
  })
  it('rejects an assistant-room member from human invitation even after the agent left or was banned', async () => {
    for (const membership of ['join', 'leave', 'ban']) {
      await expect(
        requireHumanInvitation(
          client(OWNER, [member(AGENT, membership)]),
          {
            roomId: ROOM_ID,
            userId: OTHER,
            agentId: AGENT
          },
          () => true
        )
      ).rejects.toThrow('matrix_private_assistant_room_required')
    }
  })

  it('rejects a direct invitation to the enrolled agent before reading room state', async () => {
    const value = client()
    const read = vi.spyOn(value, 'roomState')

    await expect(
      requireHumanInvitation(value, { roomId: ROOM_ID, userId: AGENT, agentId: AGENT }, () => true)
    ).rejects.toThrow('matrix_private_assistant_room_required')
    expect(read).not.toHaveBeenCalled()
  })
})

describe('isAssistantRoom', () => {
  it('is display-only but conservatively recognizes the owner/enrolled-agent pair', () => {
    expect(
      isAssistantRoom(
        {
          id: ROOM_ID,
          name: 'Anything',
          membership: 'join',
          encrypted: true,
          roomType: MATRIX_ASSISTANT_ROOM_TYPE,
          participants: [
            { userId: OWNER, membership: 'join' },
            { userId: AGENT, membership: 'invite' }
          ]
        },
        OWNER,
        AGENT
      )
    ).toBe(true)
    expect(
      isAssistantRoom(
        {
          id: ROOM_ID,
          name: 'Assistant',
          membership: 'join',
          encrypted: true,
          roomType: MATRIX_ASSISTANT_ROOM_TYPE,
          participants: [
            { userId: OWNER, membership: 'join' },
            { userId: AGENT, membership: 'join' },
            { userId: OTHER, membership: 'leave' }
          ]
        },
        OWNER,
        AGENT
      )
    ).toBe(false)
  })
})

describe("finding the owner's private room with an agent (creating an agent)", () => {
  // `!a` is a synced group, `!b` a synced assistant room with another agent, `!c` not synced
  // yet: the room made just before a quit, with this agent invited.
  function server(roomsOnServer: Record<string, IStateEventWithRoomId[]>, synced: Record<string, string | undefined>) {
    const value = createClient({ baseUrl: 'https://matrix.test', userId: OWNER })
    const syncedRooms = new Map<string, Room>()

    for (const [roomId, type] of Object.entries(synced)) {
      const room = new Room(roomId, value, OWNER)
      room.currentState.setStateEvents([
        new MatrixEvent({ type: EventType.RoomCreate, state_key: '', room_id: roomId, sender: OWNER, content: { type } })
      ])
      syncedRooms.set(roomId, room)
    }

    vi.spyOn(value, 'getJoinedRooms').mockResolvedValue({ joined_rooms: Object.keys(roomsOnServer) })
    vi.spyOn(value, 'getRoom').mockImplementation(roomId => (roomId ? (syncedRooms.get(roomId) ?? null) : null))
    const roomState = vi.spyOn(value, 'roomState').mockImplementation(async roomId => roomsOnServer[roomId]!)

    return { value, roomState, syncedRooms }
  }

  const other = () => {
    const events = validState()
    events[4] = member(OTHER, 'join')

    return events
  }

  it('finds a room the last sync has not brought yet, and reads only candidates from the server', async () => {
    const { value, roomState } = server(
      { '!a': [], '!b': other(), '!c': validState('invite') },
      { '!a': undefined, '!b': MATRIX_ASSISTANT_ROOM_TYPE }
    )

    await expect(findAssistantRoom(value, { ownerId: OWNER, agentId: AGENT })).resolves.toBe('!c')
    // The synced group was never read; the other agent's room and the new one were.
    expect(roomState.mock.calls.map(call => call[0])).toEqual(['!b', '!c'])
  })

  it('reads every candidate room at once, never one after another, and still picks in room order', async () => {
    const { value, roomState } = server(
      { '!b': other(), '!c': validState('invite'), '!d': validState() },
      { '!b': MATRIX_ASSISTANT_ROOM_TYPE }
    )

    const waiting: Array<() => void> = []
    let started = 0

    roomState.mockImplementation(
      roomId =>
        new Promise(resolve => {
          started += 1
          waiting.push(() => resolve({ '!b': other(), '!c': validState('invite'), '!d': validState() }[roomId]!))
        })
    )

    const found = findAssistantRoom(value, { ownerId: OWNER, agentId: AGENT })
    await vi.waitFor(() => expect(started).toBe(3))
    // All three reads are in flight together; answering them in reverse changes nothing.
    waiting.reverse().forEach(answer => answer())
    await expect(found).resolves.toBe('!c')
  })

  it('finds nothing when no private room with the agent exists', async () => {
    const { value } = server({ '!b': other() }, { '!b': MATRIX_ASSISTANT_ROOM_TYPE })
    await expect(findAssistantRoom(value, { ownerId: OWNER, agentId: AGENT })).resolves.toBeNull()
  })

  it('finds the agent’s room made without encryption, synced or not, so opening it never makes a second', async () => {
    const fresh = server({ '!plain': plainState('invite') }, {})
    await expect(findAssistantRoom(fresh.value, { ownerId: OWNER, agentId: AGENT })).resolves.toBe('!plain')

    const synced = server({ '!plain': plainState() }, { '!plain': MATRIX_ASSISTANT_ROOM_TYPE })
    await expect(findAssistantRoom(synced.value, { ownerId: OWNER, agentId: AGENT })).resolves.toBe('!plain')
  })

  it('prefers the used live room over a lexicographically earlier duplicate after controller restart', async () => {
    const { value, syncedRooms } = server(
      { '!aaa-empty': plainState(), '!zzz-used': plainState() },
      { '!aaa-empty': MATRIX_ASSISTANT_ROOM_TYPE, '!zzz-used': MATRIX_ASSISTANT_ROOM_TYPE }
    )
    await syncedRooms.get('!zzz-used')!.addLiveEvents([
      new MatrixEvent({
        event_id: '$message', room_id: '!zzz-used', type: EventType.RoomMessage,
        sender: OWNER, origin_server_ts: 10, content: { msgtype: 'm.text', body: 'hello' }
      })
    ], { addToState: false })

    await expect(findAssistantRoom(value, { ownerId: OWNER, agentId: AGENT })).resolves.toBe('!zzz-used')
  })

  it('stops when the host stops', async () => {
    const { value } = server({ '!c': validState() }, {})
    await expect(findAssistantRoom(value, { ownerId: OWNER, agentId: AGENT }, () => false)).rejects.toThrow('matrix_sdk_stopped')
  })
})

describe("a retired agent's chat, read from the server before it is left and forgotten", () => {
  const input = { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT }

  it.each(['join', 'invite', 'leave'])("is the owner's assistant room with the agent (agent %s)", async membership => {
    await expect(readRetiredAgentRoom(client(OWNER, validState(membership)), input)).resolves.toBeUndefined()
  })

  it('is never a room anyone else was ever in, or might be', async () => {
    for (const events of [
      [...validState(), member(OTHER, 'join')],
      [...validState(), member(OTHER, 'leave')],
      [...validState(), member(OTHER, 'invite')],
      [...validState(), state(EventType.RoomThirdPartyInvite, 'token', { display_name: 'a friend' })]
    ]) {
      await expect(readRetiredAgentRoom(client(OWNER, events), input)).rejects.toThrow('retired_agent_room_required')
    }
  })

  it('is never a room the owner has left, nor one the agent was never in', async () => {
    const left = validState()
    left[3] = member(OWNER, 'leave')
    await expect(readRetiredAgentRoom(client(OWNER, left), input)).rejects.toThrow('retired_agent_room_required')
    await expect(readRetiredAgentRoom(client(OWNER, validState().slice(0, 4)), input)).rejects.toThrow(
      'retired_agent_room_required'
    )
  })

  it("is an untyped room only when the owner's direct chats list it with the agent", async () => {
    const untyped = () => {
      const events = validState()
      events[0].content = {}

      return events
    }

    const plain = client(OWNER, untyped())
    await expect(readRetiredAgentRoom(plain, input)).rejects.toThrow('retired_agent_room_required')

    const direct = client(OWNER, untyped())
    vi.spyOn(direct, 'getAccountData').mockReturnValue({
      getContent: () => ({ [AGENT]: [ROOM_ID] })
    } as never)
    await expect(readRetiredAgentRoom(direct, input)).resolves.toBeUndefined()

    // Another kind of room (an app's group) never counts, direct or not.
    const typed = untyped()
    typed[0].content = { type: MATRIX_APP_GROUP_TYPE }
    const group = client(OWNER, typed)
    vi.spyOn(group, 'getAccountData').mockReturnValue({ getContent: () => ({ [AGENT]: [ROOM_ID] }) } as never)
    await expect(readRetiredAgentRoom(group, input)).rejects.toThrow('retired_agent_room_required')
  })

  it('is read only as the owner', async () => {
    await expect(readRetiredAgentRoom(client(AGENT), input)).rejects.toThrow('retired_agent_room_required')
    await expect(readRetiredAgentRoom(client(), { ...input, agentId: OWNER })).rejects.toThrow(
      'retired_agent_room_required'
    )
  })

  it('stops, without ruling the room out, when the host stops or loses sync', async () => {
    await expect(readRetiredAgentRoom(client(OWNER, validState()), input, () => false)).rejects.toThrow(
      'matrix_sdk_stopped'
    )

    // Sync drops while the room state is read: a failure that may pass, never "kept".
    let live = true
    const value = client(OWNER, validState())
    const read = value.roomState.bind(value)
    vi.spyOn(value, 'roomState').mockImplementation(async id => {
      const events = await read(id)
      live = false

      return events
    })
    await expect(readRetiredAgentRoom(value, input, () => live)).rejects.toThrow('matrix_sdk_stopped')
  })
})

describe('groups with the owner’s own assistants (owner-only, 2026-10-06)', () => {
  /** An ordinary encrypted group from before 0.20: no room type, Megolm, history from joining. */
  const group = (agentMembership = 'join') => {
    const events = validState(agentMembership)
    events[0].content = {}
    events.push(member(OTHER, 'join'))

    return events
  }

  /** A group as 0.20 makes it: no room type, no encryption, members see the group's history
   * (`null`: no history setting at all). */
  const plainGroup = (history: string | null = 'shared', agentMembership = 'join') => {
    const events = group(agentMembership).filter(event => event.type !== EventType.RoomEncryption)

    return history === null
      ? events.filter(event => event.type !== EventType.RoomHistoryVisibility)
      : events.map(event =>
          event.type === EventType.RoomHistoryVisibility
            ? { ...event, content: { history_visibility: history } }
            : event
        )
  }

  it.each(['shared', 'invited', 'joined'])(
    'reads a group without encryption whose history members see from %s, as it reads an encrypted one',
    async history => {
      await expect(
        readGroupRoom(client(OWNER, plainGroup(history)), { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT })
      ).resolves.toEqual({
        members: [
          expect.objectContaining({ userId: OWNER, membership: 'join' }),
          expect.objectContaining({ userId: AGENT, membership: 'join' }),
          expect.objectContaining({ userId: OTHER, membership: 'join' })
        ]
      })
    }
  )

  it('is never a group without encryption that shows its history to anyone, nor one of only two made direct', async () => {
    for (const events of [plainGroup('world_readable'), plainGroup(null)]) {
      await expect(
        readGroupRoom(client(OWNER, events), { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT })
      ).rejects.toThrow('matrix_group_room_required')
    }

    const direct = plainGroup()
    direct.pop()
    direct[3] = { ...direct[3], content: { membership: 'join', is_direct: true } }
    await expect(
      readGroupRoom(client(OWNER, direct), { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT })
    ).rejects.toThrow('matrix_group_room_required')
  })

  it('projects fresh authenticated membership events, rather than content-supplied epochs', async () => {
    const events = group().map((event, index) => ({ ...event, event_id: `$membership-${index}`,
      content: { ...event.content, membershipEventId: '$forged' } }))

    const read = await readGroupRoom(client(OWNER, events), { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT })
    expect(read.members.map(member => member.membershipEventId)).toEqual(
      events.filter(event => event.type === EventType.RoomMember).map(event => event.event_id)
    )
    expect(read.members.some(member => member.membershipEventId === '$forged')).toBe(false)
  })

  it('reads an ordinary group with the owner and the agent in it, and who is there now', async () => {
    await expect(
      readGroupRoom(client(OWNER, group()), { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT })
    ).resolves.toEqual({
      members: [
        expect.objectContaining({ userId: OWNER, membership: 'join' }),
        expect.objectContaining({ userId: AGENT, membership: 'join' }),
        expect.objectContaining({ userId: OTHER, membership: 'join' })
      ]
    })
    // Only while being added may the agent still be invited.
    await expect(
      readGroupRoom(client(OWNER, group('invite')), { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT })
    ).rejects.toThrow('matrix_group_room_required')
    await expect(
      readGroupRoom(client(OWNER, group('invite')), { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT, allowInvite: true })
    ).resolves.toBeTruthy()
  })

  it.each([
    ['its private room', (events: IStateEventWithRoomId[]) => (events[0].content = { type: MATRIX_ASSISTANT_ROOM_TYPE })],
    ['an app group', (events: IStateEventWithRoomId[]) => (events[0].content = { type: MATRIX_APP_GROUP_TYPE })],
    ['a company room', (events: IStateEventWithRoomId[]) => (events[0].content = { type: 'io.atum.company_project.v1' })],
    [
      'a room encrypted other than with Megolm',
      (events: IStateEventWithRoomId[]) => (events[1].content = { algorithm: 'unknown' })
    ],
    [
      'an encrypted room showing newcomers its history',
      (events: IStateEventWithRoomId[]) => (events[2].content = { history_visibility: 'shared' })
    ],
    ['a room the owner left', (events: IStateEventWithRoomId[]) => (events[3] = member(OWNER, 'leave'))],
    ['a room the agent left', (events: IStateEventWithRoomId[]) => (events[4] = member(AGENT, 'leave'))]
  ])('is never %s', async (_case, change) => {
    const events = group()
    change(events)
    await expect(
      readGroupRoom(client(OWNER, events), { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT })
    ).rejects.toThrow('matrix_group_room_required')
  })

  it('is never an older private chat: made direct, with only the owner and the agent in it', async () => {
    // Marked on a member's event.
    const marked = group()
    marked.pop()
    marked[4] = { ...marked[4], content: { membership: 'join', is_direct: true } }
    await expect(
      readGroupRoom(client(OWNER, marked), { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT })
    ).rejects.toThrow('matrix_group_room_required')

    // Listed in the owner's own direct chats.
    const listed = group()
    listed.pop()
    const owner = client(OWNER, listed)
    vi.spyOn(owner, 'getAccountData').mockReturnValue(
      new MatrixEvent({ type: EventType.Direct, content: { [AGENT]: [ROOM_ID] } })
    )
    await expect(readGroupRoom(owner, { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT })).rejects.toThrow(
      'matrix_group_room_required'
    )

    // A group of just the owner and one assistant made as a group is a private meeting.
    const meeting = group()
    meeting.pop()
    await expect(
      readGroupRoom(client(OWNER, meeting), { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT })
    ).resolves.toEqual({ members: [expect.objectContaining({ userId: OWNER, membership: 'join' }), expect.objectContaining({ userId: AGENT, membership: 'join' })] })
  })

  it('is read only by the owner’s own SDK', async () => {
    await expect(
      readGroupRoom(client(AGENT, group()), { roomId: ROOM_ID, ownerId: OWNER, agentId: AGENT })
    ).rejects.toThrow('matrix_group_room_required')
  })

  /** The owner's SDK with the group stored as a joined room, for the invite permission. */
  function owned(events: IStateEventWithRoomId[]) {
    const value = client(OWNER, events)
    const room = new Room(ROOM_ID, value, OWNER)
    room.updateMyMembership('join')
    value.store.storeRoom(room)
    const invite = vi.spyOn(value, 'invite').mockResolvedValue({})

    return { value, invite }
  }

  const agents = ['@a1:test', '@a2:test', '@a3:test', '@a4:test', AGENT, '@a6:test']

  it('lets the owner add one of their own assistants, up to five in a group', async () => {
    const roomy = owned(group())
    await inviteAgentToGroup(roomy.value, { roomId: ROOM_ID, userId: '@a6:test', agentIds: agents }, () => true)
    expect(roomy.invite).toHaveBeenCalledExactlyOnceWith(ROOM_ID, '@a6:test')

    const full = group()
    full.push(...['@a1:test', '@a2:test', '@a3:test', '@a4:test'].map(id => member(id, 'join')))
    const crowded = owned(full)
    await expect(
      inviteAgentToGroup(crowded.value, { roomId: ROOM_ID, userId: '@a6:test', agentIds: agents }, () => true)
    ).rejects.toThrow('matrix_group_agents_full')
    expect(crowded.invite).not.toHaveBeenCalled()
  })

  it('leaves an assistant already invited as it is, so main only asks it to join', async () => {
    const pending = owned(group('invite'))
    await inviteAgentToGroup(pending.value, { roomId: ROOM_ID, userId: AGENT, agentIds: agents }, () => true)
    expect(pending.invite).not.toHaveBeenCalled()
  })

  it('never adds someone else’s assistant this way, or an assistant to a room that isn’t a group', async () => {
    const other = owned(group())
    await expect(
      inviteAgentToGroup(other.value, { roomId: ROOM_ID, userId: '@theirs:test', agentIds: agents }, () => true)
    ).rejects.toThrow('matrix_group_room_required')

    const events = group()
    events[0].content = { type: MATRIX_ASSISTANT_ROOM_TYPE }
    const privateRoom = owned(events)
    await expect(
      inviteAgentToGroup(privateRoom.value, { roomId: ROOM_ID, userId: '@a6:test', agentIds: agents }, () => true)
    ).rejects.toThrow('matrix_group_room_required')
    expect(other.invite).not.toHaveBeenCalled()
    expect(privateRoom.invite).not.toHaveBeenCalled()
  })

  it('takes new people into a group with the owner’s assistant, never into an older transcript', async () => {
    await expect(
      requireHumanInvitation(client(OWNER, group()), { roomId: ROOM_ID, userId: '@new:test', agentId: AGENT }, () => true)
    ).resolves.toBeUndefined()

    // A room with the assistant that shows newcomers its history is an old private transcript.
    const shown = group()
    shown[2].content = { history_visibility: 'shared' }
    await expect(
      requireHumanInvitation(client(OWNER, shown), { roomId: ROOM_ID, userId: '@new:test', agentId: AGENT }, () => true)
    ).rejects.toThrow('matrix_private_assistant_room_required')

    // Any of the owner's assistants, not only the default one, is never invited as a person.
    const owner = client(OWNER, group())
    const read = vi.spyOn(owner, 'roomState')
    await expect(
      requireHumanInvitation(owner, { roomId: ROOM_ID, userId: '@a6:test', agentIds: agents }, () => true)
    ).rejects.toThrow('matrix_private_assistant_room_required')
    expect(read).not.toHaveBeenCalled()
  })

  it('lets the owner add an assistant to a group without encryption, and then add people to it', async () => {
    const plain = owned(plainGroup())
    await inviteAgentToGroup(plain.value, { roomId: ROOM_ID, userId: '@a6:test', agentIds: agents }, () => true)
    expect(plain.invite).toHaveBeenCalledExactlyOnceWith(ROOM_ID, '@a6:test')

    // Its members see the group's history, as the owner chose for groups (2026-10-10).
    await expect(
      requireHumanInvitation(
        client(OWNER, plainGroup()),
        { roomId: ROOM_ID, userId: '@new:test', agentId: AGENT },
        () => true
      )
    ).resolves.toBeUndefined()
  })

  it('never opens a room with the assistant to everyone, nor an agent’s own room, when it has no encryption', async () => {
    await expect(
      requireHumanInvitation(
        client(OWNER, plainGroup('world_readable')),
        { roomId: ROOM_ID, userId: '@new:test', agentId: AGENT },
        () => true
      )
    ).rejects.toThrow('matrix_private_assistant_room_required')
    await expect(
      requireHumanInvitation(
        client(OWNER, plainState()),
        { roomId: ROOM_ID, userId: '@new:test', agentId: AGENT },
        () => true
      )
    ).rejects.toThrow('matrix_private_assistant_room_required')

    const privateRoom = owned(plainState())
    await expect(
      inviteAgentToGroup(privateRoom.value, { roomId: ROOM_ID, userId: '@a6:test', agentIds: agents }, () => true)
    ).rejects.toThrow('matrix_group_room_required')
    expect(privateRoom.invite).not.toHaveBeenCalled()
  })
})
