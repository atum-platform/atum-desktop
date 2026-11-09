import { createClient, Direction, EventType, Preset } from 'matrix-js-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AWARENESS_CONTROL_EVENT,
  AWARENESS_CONTROL_REFERENCE,
  AWARENESS_CONTROL_ROOM_TYPE,
  type AwarenessControl,
  type AwarenessControlReference
} from '../../shared/matrix-awareness-controls'

import { changeAwarenessRoom, prepareAwarenessControls, readAwarenessRooms, sendAwarenessControl } from './awareness-controls'

const owner = '@owner:test'
const roomId = '!controls:test'
const otherRoomId = '!controls-other:test'
const reference: AwarenessControlReference = { v: 1, roomId }
const otherReference: AwarenessControlReference = { v: 1, roomId: otherRoomId }

function control(): Extract<AwarenessControl, {action:'include'}> {
  return {
    v: 1,
    id: '00000000-0000-4000-8000-cf4c4732fd3b',
    action: 'include',
    source: { kind: 'assistant_chat', id: '!human:test' },
    included: false
  }
}

function controlState(
  member = owner
): Array<{ type: string; state_key: string; sender: string; content: Record<string, unknown> }> {
  return [
    {
      type: EventType.RoomCreate,
      state_key: '',
      sender: owner,
      content: { creator: owner, room_version: '10', type: AWARENESS_CONTROL_ROOM_TYPE }
    },
    {
      type: EventType.RoomEncryption,
      state_key: '',
      sender: owner,
      content: { algorithm: 'm.megolm.v1.aes-sha2' }
    },
    {
      type: EventType.RoomHistoryVisibility,
      state_key: '',
      sender: owner,
      content: { history_visibility: 'joined' }
    },
    { type: EventType.RoomMember, state_key: member, sender: member, content: { membership: 'join' } }
  ]
}

/** A controls room made the 0.20 way: no encryption state. */
function plainControlState(member = owner) {
  return controlState(member).filter(event => event.type !== EventType.RoomEncryption)
}

function fixture(references: unknown[], states = new Map<string, unknown>([[roomId, controlState()]])) {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: owner })
  const get = vi.spyOn(client, 'getAccountDataFromServer').mockImplementation(async () => references.shift() as never)
  const roomState = vi.spyOn(client, 'roomState').mockImplementation(async id => states.get(id) as never)
  const create = vi.spyOn(client, 'createRoom').mockResolvedValue({ room_id: roomId })
  const set = vi.spyOn(client, 'setAccountData').mockResolvedValue({})
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$control' })

  return { client, get, roomState, create, set, send }
}

function anchoredControlState() {
  return controlState().map((event, index) => index === 0 ? { ...event, event_id: '$create' } : event)
}

function joinedRoomState() {
  return [
    { type: EventType.RoomEncryption, state_key: '', sender: owner, content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: EventType.RoomHistoryVisibility, state_key: '', sender: owner, content: { history_visibility: 'joined' } },
    { type: EventType.RoomMember, state_key: owner, sender: owner, content: { membership: 'join' } }
  ]
}

function joinedRoom(id: string, type?: string, name = id) {
  const state = new Map<string, { getContent: () => Record<string, unknown> }>([
    [EventType.RoomEncryption, { getContent: () => ({ algorithm: 'm.megolm.v1.aes-sha2' }) }],
    [EventType.RoomHistoryVisibility, { getContent: () => ({ history_visibility: 'joined' }) }]
  ])

  if (type) {
    state.set(EventType.RoomCreate, { getContent: () => ({ type }) })
  }

  return {
    roomId: id,
    name,
    getMyMembership: () => 'join',
    currentState: { getStateEvents: (eventType: string) => state.get(eventType) }
  }
}

function controlsHistory(
  f: ReturnType<typeof fixture>,
  controls: AwarenessControl[],
  states = new Map<string, unknown>([[roomId, anchoredControlState()]])
) {
  const values = new Map(controls.map((value, index) => [`$control-${index}`, value]))
  const anchor = { ...anchoredControlState()[0], room_id: roomId }

  const chunk = [
    ...[...values.keys()].reverse().map(event_id => ({
      event_id,
      room_id: roomId,
      sender: owner,
      type: EventType.RoomMessageEncrypted,
      content: {}
    })),
    anchor
  ]

  const pages = vi.spyOn(f.client, 'createMessagesRequest').mockResolvedValue({ chunk, end: '$before-anchor' } as never)

  const decrypt = vi.spyOn(f.client, 'decryptEventIfNeeded').mockImplementation(async event => {
    const value = values.get(event.getId()!)

    if (value) {
      vi.spyOn(event, 'getType').mockReturnValue(AWARENESS_CONTROL_EVENT)
      vi.spyOn(event, 'getContent').mockReturnValue(value)
    }
  })

  f.get.mockResolvedValue(reference)

  f.roomState.mockImplementation(async id => states.get(id) as never)

  return { decrypt, pages }
}

function exposeJoinedRoom(f: ReturnType<typeof fixture>, room: ReturnType<typeof joinedRoom>) {
  vi.spyOn(f.client, 'getRooms').mockReturnValue([room as never])
  vi.spyOn(f.client, 'getRoom').mockImplementation(id => id === room.roomId ? room as never : null)
}

afterEach(() => vi.restoreAllMocks())

describe('owner awareness controls', () => {
  it('uses a current authenticated owner reference only after complete immutable room-state validation', async () => {
    const f = fixture([reference, reference])

    await expect(prepareAwarenessControls(f.client, () => true)).resolves.toEqual(reference)
    expect(f.get).toHaveBeenCalledTimes(2)
    expect(f.get).toHaveBeenNthCalledWith(1, AWARENESS_CONTROL_REFERENCE)
    expect(f.roomState).toHaveBeenCalledExactlyOnceWith(roomId)
    expect(f.create).not.toHaveBeenCalled()
    expect(f.set).not.toHaveBeenCalled()
  })

  it('accepts a modern room-create event without a legacy creator field when its signed sender is the owner', async () => {
    const state = controlState()
    state[0] = {
      ...state[0],
      content: { room_version: '11', type: AWARENESS_CONTROL_ROOM_TYPE }
    }
    const f = fixture([reference, reference], new Map([[roomId, state]]))

    await expect(prepareAwarenessControls(f.client, () => true)).resolves.toEqual(reference)
    expect(f.create).not.toHaveBeenCalled()
  })

  it('creates one owner-only room without encryption and persists its reference only after server state validation', async () => {
    // 0.20: a reader without keys must read the owner's choices.
    const f = fixture([null, null, reference, reference], new Map([[roomId, plainControlState()]]))

    await expect(prepareAwarenessControls(f.client, () => true)).resolves.toEqual(reference)
    expect(f.create).toHaveBeenCalledExactlyOnceWith({
      preset: Preset.PrivateChat,
      creation_content: { type: AWARENESS_CONTROL_ROOM_TYPE },
      initial_state: [
        { type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'joined' } }
      ]
    })
    expect(f.set).toHaveBeenCalledExactlyOnceWith(AWARENESS_CONTROL_REFERENCE, reference)
    expect(f.roomState).toHaveBeenCalledTimes(2)
  })

  it.each([
    [
      'wrong room type',
      [{ ...controlState()[0], content: { creator: owner, type: 'io.atum.other' } }, ...controlState().slice(1)]
    ],
    [
      'foreign member',
      [
        ...controlState(),
        {
          type: EventType.RoomMember,
          state_key: '@intruder:test',
          sender: '@intruder:test',
          content: { membership: 'leave' }
        }
      ]
    ],
    [
      'plaintext room',
      [
        controlState()[0],
        { ...controlState()[1], content: { algorithm: 'm.olm.v1.curve25519-aes-sha2' } },
        ...controlState().slice(2)
      ]
    ],
    [
      'shared history',
      [
        controlState()[0],
        controlState()[1],
        { ...controlState()[2], content: { history_visibility: 'shared' } },
        controlState()[3]
      ]
    ]
  ])('refuses %s state without creating or sending', async (_name, state) => {
    const f = fixture([reference], new Map([[roomId, state]]))

    await expect(prepareAwarenessControls(f.client, () => true)).rejects.toThrow('matrix_awareness_controls_invalid')
    expect(f.create).not.toHaveBeenCalled()
    expect(f.set).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })

  it('refuses a reference replacement after state validation before any encrypted send', async () => {
    const f = fixture(
      [reference, otherReference],
      new Map([
        [roomId, controlState()],
        [otherRoomId, controlState()]
      ])
    )

    await expect(sendAwarenessControl(f.client, control(), () => true)).rejects.toThrow(
      'matrix_awareness_controls_stale'
    )
    expect(f.send).not.toHaveBeenCalled()
  })

  it('uses a concurrently written valid reference instead of replacing it after its own room creation', async () => {
    const f = fixture(
      [null, otherReference, otherReference],
      new Map([
        [roomId, controlState()],
        [otherRoomId, controlState()]
      ])
    )

    await expect(prepareAwarenessControls(f.client, () => true)).resolves.toEqual(otherReference)
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.set).not.toHaveBeenCalled()
    expect(f.roomState).toHaveBeenCalledWith(roomId)
    expect(f.roomState).toHaveBeenCalledWith(otherRoomId)
  })

  it('closes creation for this SDK client after an unknown create outcome and never retries blindly', async () => {
    const f = fixture([null])
    f.create.mockRejectedValueOnce(new Error('network lost after request'))

    await expect(prepareAwarenessControls(f.client, () => true)).rejects.toThrow('network lost after request')
    await expect(prepareAwarenessControls(f.client, () => true)).rejects.toThrow('matrix_awareness_controls_uncertain')
    expect(f.create).toHaveBeenCalledTimes(1)
  })

  it('does not publish a newly created room when native authority becomes stale before custody validation', async () => {
    const f = fixture([null])
    let live = true
    f.create.mockImplementationOnce(async () => {
      live = false

      return { room_id: roomId }
    })

    await expect(prepareAwarenessControls(f.client, () => live)).rejects.toThrow('matrix_awareness_controls_stale')
    expect(f.set).not.toHaveBeenCalled()
  })

  it('serializes same-client preparation so concurrent calls do not create another controls room', async () => {
    let release!: () => void

    const waiting = new Promise<void>(resolve => {
      release = resolve
    })

    const f = fixture([null, null, reference, reference])
    f.create.mockImplementationOnce(async () => {
      await waiting

      return { room_id: roomId }
    })

    const first = prepareAwarenessControls(f.client, () => true)
    const second = prepareAwarenessControls(f.client, () => true)
    release()
    await expect(Promise.all([first, second])).resolves.toEqual([reference, reference])
    expect(f.create).toHaveBeenCalledTimes(1)
  })

  it('sends one exact bounded control under its stable transaction after current custody validation', async () => {
    const f = fixture([reference, reference])
    const value = control()

    await expect(sendAwarenessControl(f.client, value, () => true)).resolves.toBeUndefined()
    expect(f.send).toHaveBeenCalledExactlyOnceWith(
      roomId,
      AWARENESS_CONTROL_EVENT,
      value,
      'atum-aw-control-00000000-0000-4000-8000-cf4c4732fd3b'
    )
  })

  it('does not retry an unknown encrypted send', async () => {
    const f = fixture([reference, reference])
    f.send.mockRejectedValueOnce(new Error('network lost after send'))

    await expect(sendAwarenessControl(f.client, control(), () => true)).rejects.toThrow('network lost after send')
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('refuses malformed control input before reading, creating, or sending', async () => {
    const f = fixture([])
    await expect(sendAwarenessControl(f.client, { ...control(), id: 'not-a-uuid' }, () => true)).rejects.toThrow(
      'matrix_awareness_controls_invalid'
    )
    expect(f.get).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })

  it('reads the complete encrypted owner history back to the room creation anchor', async () => {
    const sourceRoomId = '!assistant:test'

    const value: AwarenessControl = {
      ...control(),
      source: { kind: 'assistant_chat', id: sourceRoomId },
      included: false
    }

    const f = fixture([])

    const states = new Map<string, unknown>([
      [roomId, anchoredControlState()],
      [sourceRoomId, joinedRoomState()]
    ])

    const { decrypt, pages } = controlsHistory(f, [value], states)
    exposeJoinedRoom(f, joinedRoom(sourceRoomId, 'io.atum.assistant', 'Assistant'))

    await expect(readAwarenessRooms(f.client, () => true)).resolves.toEqual([
      { roomId: sourceRoomId, name: 'Assistant', included: false, forgotten: false }
    ])
    expect(pages).toHaveBeenCalledExactlyOnceWith(roomId, null, 50, Direction.Backward)
    expect(decrypt).toHaveBeenCalledTimes(1)
  })

  it('fails closed when immutable history has no creation anchor or the anchor is corrupt', async () => {
    const missing = fixture([])
    missing.get.mockResolvedValue(reference)
    missing.roomState.mockResolvedValue(anchoredControlState() as never)
    vi.spyOn(missing.client, 'createMessagesRequest').mockResolvedValue({ chunk: [], end: undefined } as never)

    await expect(readAwarenessRooms(missing.client, () => true)).rejects.toThrow('matrix_awareness_controls_unavailable')

    const corrupt = fixture([])
    corrupt.get.mockResolvedValue(reference)
    corrupt.roomState.mockResolvedValue(controlState() as never)

    await expect(readAwarenessRooms(corrupt.client, () => true)).rejects.toThrow('matrix_awareness_controls_invalid')
  })

  it('reports no controls and refuses a room change for an account that never enrolled an owner reader', async () => {
    const humanRoomId = '!human:test'
    const f = fixture([null, null])
    f.roomState.mockImplementation(async id => (id === humanRoomId ? joinedRoomState() : undefined) as never)
    exposeJoinedRoom(f, joinedRoom(humanRoomId, undefined, 'People'))

    // Without the controls room (created only by the owner-reader trust path) there is
    // no companion to honour a choice, so Settings is told there is nothing to show.
    await expect(readAwarenessRooms(f.client, () => true)).resolves.toBeNull()
    await expect(changeAwarenessRoom(f.client, humanRoomId, 'exclude', () => true)).rejects.toThrow(
      'matrix_awareness_controls_unavailable'
    )
    expect(f.create).not.toHaveBeenCalled()
    expect(f.set).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })

  it('sends both human classifications through the native Matrix event boundary for one room exclusion', async () => {
    const humanRoomId = '!human:test'
    const f = fixture([])

    const states = new Map<string, unknown>([
      [roomId, anchoredControlState()],
      [humanRoomId, joinedRoomState()]
    ])

    controlsHistory(f, [], states)
    exposeJoinedRoom(f, joinedRoom(humanRoomId, undefined, 'People'))

    await expect(changeAwarenessRoom(f.client, humanRoomId, 'exclude', () => true)).resolves.toEqual([
      { roomId: humanRoomId, name: 'People', included: true, forgotten: false }
    ])
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.send).toHaveBeenNthCalledWith(
      1,
      roomId,
      AWARENESS_CONTROL_EVENT,
      expect.objectContaining({ action: 'include', source: { kind: 'human_dm', id: humanRoomId }, included: false }),
      expect.stringMatching(/^atum-aw-control-/)
    )
    expect(f.send).toHaveBeenNthCalledWith(
      2,
      roomId,
      AWARENESS_CONTROL_EVENT,
      expect.objectContaining({ action: 'include', source: { kind: 'human_group', id: humanRoomId }, included: false }),
      expect.stringMatching(/^atum-aw-control-/)
    )
    expect(f.create).not.toHaveBeenCalled()
    expect(f.set).not.toHaveBeenCalled()
  })

  it('retains a source withdrawal after a later inclusion so forgotten history cannot resurrect', async () => {
    const humanRoomId = '!human:test'

    const history: AwarenessControl[] = [
      {
        ...control(),
        id: '00000000-0000-4000-8000-8966ec11e5cd',
        source: { kind: 'human_dm', id: humanRoomId },
        included: false
      },
      {
        v: 1,
        id: '00000000-0000-4000-8000-a353d68a36a3',
        action: 'withdraw',
        scope: { kind: 'source', source: { kind: 'human_dm', id: humanRoomId } },
        reason: 'forget'
      },
      {
        ...control(),
        id: '00000000-0000-4000-8000-851a2490fb52',
        source: { kind: 'human_dm', id: humanRoomId },
        included: true
      }
    ]

    const f = fixture([])

    const states = new Map<string, unknown>([
      [roomId, anchoredControlState()],
      [humanRoomId, joinedRoomState()]
    ])

    controlsHistory(f, history, states)
    exposeJoinedRoom(f, joinedRoom(humanRoomId, undefined, 'People'))

    await expect(readAwarenessRooms(f.client, () => true)).resolves.toEqual([
      { roomId: humanRoomId, name: 'People', included: true, forgotten: true }
    ])
  })

  it('stops a room change when native authority becomes stale before the second human control', async () => {
    const humanRoomId = '!human:test'
    const f = fixture([])

    let live = true

    const states = new Map<string, unknown>([
      [roomId, anchoredControlState()],
      [humanRoomId, joinedRoomState()]
    ])

    controlsHistory(f, [], states)
    exposeJoinedRoom(f, joinedRoom(humanRoomId, undefined, 'People'))
    f.send.mockImplementationOnce(async () => {
      live = false

      return { event_id: '$control' }
    })

    await expect(changeAwarenessRoom(f.client, humanRoomId, 'exclude', () => live)).rejects.toThrow(
      'matrix_awareness_controls_stale'
    )
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('keeps using an older encrypted controls room and accepts a plain one, refusing other encryption', async () => {
    const encrypted = fixture([reference, reference])
    await expect(prepareAwarenessControls(encrypted.client, () => true)).resolves.toEqual(reference)

    const plain = fixture([reference, reference], new Map([[roomId, plainControlState()]]))
    await expect(prepareAwarenessControls(plain.client, () => true)).resolves.toEqual(reference)

    const foreign = plainControlState()
    foreign.splice(1, 0, {
      type: EventType.RoomEncryption,
      state_key: '',
      sender: '@intruder:test',
      content: { algorithm: 'm.megolm.v1.aes-sha2' }
    })
    const intruded = fixture([reference], new Map([[roomId, foreign]]))
    await expect(prepareAwarenessControls(intruded.client, () => true)).rejects.toThrow(
      'matrix_awareness_controls_invalid'
    )

    // The owner-only membership rule is unchanged without encryption.
    const shared = fixture(
      [reference],
      new Map([
        [
          roomId,
          [
            ...plainControlState(),
            {
              type: EventType.RoomMember,
              state_key: '@intruder:test',
              sender: '@intruder:test',
              content: { membership: 'leave' }
            }
          ]
        ]
      ])
    )

    await expect(prepareAwarenessControls(shared.client, () => true)).rejects.toThrow(
      'matrix_awareness_controls_invalid'
    )
  })

  it('reads plain owner controls from a plain controls room back to its creation anchor', async () => {
    const sourceRoomId = '!assistant:test'

    const value: AwarenessControl = {
      ...control(),
      source: { kind: 'assistant_chat', id: sourceRoomId },
      included: false
    }

    const f = fixture([])
    f.get.mockResolvedValue(reference)

    const anchored = plainControlState().map((event, index) =>
      index === 0 ? { ...event, event_id: '$create' } : event
    )

    f.roomState.mockImplementation(async id => (id === roomId ? anchored : plainRoomState('invited')) as never)
    vi.spyOn(f.client, 'createMessagesRequest').mockResolvedValue({
      chunk: [
        { event_id: '$plain-control', room_id: roomId, sender: owner, type: AWARENESS_CONTROL_EVENT, content: value },
        { ...anchored[0], room_id: roomId }
      ],
      end: '$before'
    } as never)
    const decrypt = vi.spyOn(f.client, 'decryptEventIfNeeded')
    exposeJoinedRoom(f, plainRoom(sourceRoomId, 'invited', 'io.atum.assistant', 'Assistant'))

    await expect(readAwarenessRooms(f.client, () => true)).resolves.toEqual([
      { roomId: sourceRoomId, name: 'Assistant', included: false, forgotten: false }
    ])
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('refuses a plaintext control in an encrypted controls room (no downgrade) and anyone else\u2019s in a plain one', async () => {
    const value = control()
    const anchor = { ...anchoredControlState()[0], room_id: roomId }

    const encrypted = fixture([])
    encrypted.get.mockResolvedValue(reference)
    encrypted.roomState.mockResolvedValue(anchoredControlState() as never)
    vi.spyOn(encrypted.client, 'createMessagesRequest').mockResolvedValue({
      chunk: [
        { event_id: '$plain', room_id: roomId, sender: owner, type: AWARENESS_CONTROL_EVENT, content: value },
        anchor
      ],
      end: '$before'
    } as never)
    await expect(readAwarenessRooms(encrypted.client, () => true)).rejects.toThrow('matrix_awareness_controls_invalid')

    const plain = fixture([])
    plain.get.mockResolvedValue(reference)

    const anchored = plainControlState().map((event, index) =>
      index === 0 ? { ...event, event_id: '$create' } : event
    )

    plain.roomState.mockResolvedValue(anchored as never)
    vi.spyOn(plain.client, 'createMessagesRequest').mockResolvedValue({
      chunk: [
        {
          event_id: '$forged',
          room_id: roomId,
          sender: '@intruder:test',
          type: AWARENESS_CONTROL_EVENT,
          content: value
        },
        { ...anchored[0], room_id: roomId }
      ],
      end: '$before'
    } as never)
    await expect(readAwarenessRooms(plain.client, () => true)).rejects.toThrow('matrix_awareness_controls_invalid')
  })

  it.each(['invited', 'shared', 'joined'])('lists and switches a plain chat with %s history', async history => {
    const roomIdPlain = '!plain:test'
    const f = fixture([])

    const states = new Map<string, unknown>([
      [roomId, anchoredControlState()],
      [roomIdPlain, plainRoomState(history)]
    ])

    controlsHistory(f, [], states)
    exposeJoinedRoom(f, plainRoom(roomIdPlain, history, 'io.atum.assistant', 'Moon'))

    await expect(readAwarenessRooms(f.client, () => true)).resolves.toEqual([
      { roomId: roomIdPlain, name: 'Moon', included: true, forgotten: false }
    ])
    await changeAwarenessRoom(f.client, roomIdPlain, 'exclude', () => true)
    expect(f.send).toHaveBeenCalledExactlyOnceWith(
      roomId,
      AWARENESS_CONTROL_EVENT,
      expect.objectContaining({
        action: 'include',
        source: { kind: 'assistant_chat', id: roomIdPlain },
        included: false
      }),
      expect.stringMatching(/^atum-aw-control-/)
    )
  })

  it('still leaves out an encrypted chat whose history is shared', async () => {
    const humanRoomId = '!human:test'
    const f = fixture([])

    const sharedState = joinedRoomState().map(event =>
      event.type === EventType.RoomHistoryVisibility ? { ...event, content: { history_visibility: 'shared' } } : event
    )

    controlsHistory(
      f,
      [],
      new Map<string, unknown>([
        [roomId, anchoredControlState()],
        [humanRoomId, sharedState]
      ])
    )
    const room = joinedRoom(humanRoomId, undefined, 'People')
    room.currentState.getStateEvents = (eventType: string) =>
      eventType === EventType.RoomEncryption
        ? { getContent: () => ({ algorithm: 'm.megolm.v1.aes-sha2' }) }
        : eventType === EventType.RoomHistoryVisibility
          ? { getContent: () => ({ history_visibility: 'shared' }) }
          : undefined
    exposeJoinedRoom(f, room)

    await expect(readAwarenessRooms(f.client, () => true)).resolves.toEqual([])
    await expect(changeAwarenessRoom(f.client, humanRoomId, 'exclude', () => true)).rejects.toThrow(
      'matrix_awareness_controls_invalid'
    )
  })
})

/** A 0.20 chat as the server holds it: no encryption state. */
function plainRoomState(history: string) {
  return [
    { type: EventType.RoomHistoryVisibility, state_key: '', sender: owner, content: { history_visibility: history } },
    { type: EventType.RoomMember, state_key: owner, sender: owner, content: { membership: 'join' } }
  ]
}

/** A 0.20 chat as this client has synced it: no encryption state. */
function plainRoom(id: string, history: string, type: string | undefined, name: string) {
  const room = joinedRoom(id, type, name)

  const state = new Map<string, { getContent: () => Record<string, unknown> }>([
    [EventType.RoomHistoryVisibility, { getContent: () => ({ history_visibility: history }) }],
    ...(type ? [[EventType.RoomCreate, { getContent: () => ({ type }) }] as const] : [])
  ])

  room.currentState.getStateEvents = (eventType: string) => state.get(eventType)

  return room
}
