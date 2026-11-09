import { createClient, EventType, MatrixEvent, Room } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'

import {
  MATRIX_NOTES_SELF_ACCOUNT_DATA,
  MATRIX_NOTES_SELF_COMPANY_KEY,
  MATRIX_NOTES_SELF_ROOM_TYPE,
  MATRIX_NOTES_SELF_TAG,
  matrixNotesSelfCompanyId,
  matrixNotesSelfRoom
} from '../../shared/matrix-notes-self'

import { inspectMatrixNotesSelfRooms, matrixNotesSelf } from './notes-self'

const OWNER = '@owner:test'

interface MockRoomOptions {
  companyId?: string
  creator?: string
  createdAt?: number
  id: string
  members?: Array<{ userId: string; membership: string }>
  messages?: number
  name?: string
  timelineComplete?: boolean
  type?: string
}

function mockRoom({
  companyId,
  creator = OWNER,
  createdAt = 1,
  id,
  members = [{ userId: OWNER, membership: 'join' }],
  messages = 0,
  timelineComplete = true,
  type = MATRIX_NOTES_SELF_ROOM_TYPE
}: MockRoomOptions) {
  const state = new Map<string, unknown>()
  const create = {
    getContent: () => ({ type, ...(companyId ? { [MATRIX_NOTES_SELF_COMPANY_KEY]: companyId } : {}) }),
    getSender: () => creator,
    getTs: () => createdAt,
    getType: () => EventType.RoomCreate,
    isRedacted: () => false
  }
  const timeline = [
    ...(timelineComplete ? [create] : []),
    ...Array.from({ length: messages }, (_, index) => ({
      getType: () => EventType.RoomMessage,
      isRedacted: () => false,
      index
    }))
  ]

  return {
    roomId: id,
    tags: {} as Record<string, unknown>,
    getMyMembership: () => 'join',
    getMembers: () => members,
    getPendingEvents: () => [],
    getLiveTimeline: () => ({ getEvents: () => timeline }),
    currentState: {
      getStateEvents: (eventType: string, key: string) => {
        if (key !== '') {
          return null
        }

        return eventType === EventType.RoomCreate ? create : state.get(eventType) ?? null
      }
    },
    setState: (eventType: string, content: Record<string, unknown>) => state.set(eventType, {
      getContent: () => content
    })
  }
}

function fixture(initialRooms: ReturnType<typeof mockRoom>[] = [], initialAccount?: unknown, ownerId = OWNER) {
  const rooms = [...initialRooms]
  let account = initialAccount
  const setAccountDataRaw = vi.fn(async (_type: string, value: unknown) => {
    account = value
  })
  const setRoomTag = vi.fn(async (roomId: string, tag: string, value: unknown) => {
    const room = rooms.find(candidate => candidate.roomId === roomId)

    if (room) {
      room.tags[tag] = value
    }

    return {}
  })
  const sendStateEvent = vi.fn(async (roomId: string, type: string, content: Record<string, unknown>) => {
    rooms.find(room => room.roomId === roomId)?.setState(type, content)

    return { event_id: '$state' }
  })
  const createRoom = vi.fn(async (_options?: { creation_content?: Record<string, unknown> }) => {
    const room = mockRoom({ id: '!created:test', createdAt: 100, creator: ownerId,
      members: [{ userId: ownerId, membership: 'join' }] })
    rooms.push(room)

    return { room_id: room.roomId }
  })
  const client = {
    getUserId: () => ownerId,
    getRooms: () => rooms,
    getRoom: (roomId: string) => rooms.find(room => room.roomId === roomId) ?? null,
    getAccountData: (type: string) => type === MATRIX_NOTES_SELF_ACCOUNT_DATA && account !== undefined
      ? { getContent: () => account }
      : undefined,
    setAccountDataRaw,
    setRoomTag,
    sendStateEvent,
    createRoom
  }
  const changed = vi.fn()
  const notes = matrixNotesSelf(client as never, ownerId, () => true, changed, 50)

  return {
    account: () => account,
    changed,
    client,
    createRoom,
    notes,
    rooms,
    sendStateEvent,
    setAccountDataRaw,
    setRoomTag
  }
}

describe('Matrix-native notes-to-self convergence', () => {
  it('opens and reuses a server-created room through the real SDK account-data writer', async () => {
    const client = createClient({ baseUrl: 'https://matrix.test', userId: OWNER, accessToken: 'test-only' })
    const room = new Room('!native:test', client, OWNER)
    room.currentState.setStateEvents([
      new MatrixEvent({ room_id: room.roomId, type: EventType.RoomCreate, state_key: '', sender: OWNER,
        content: { type: MATRIX_NOTES_SELF_ROOM_TYPE }, origin_server_ts: 1 }),
      new MatrixEvent({ room_id: room.roomId, type: EventType.RoomMember, state_key: OWNER, sender: OWNER,
        content: { membership: 'join' } }),
      new MatrixEvent({ room_id: room.roomId, type: EventType.RoomPowerLevels, state_key: '', sender: OWNER,
        content: { users: { [OWNER]: 100 }, historical: 100 } })
    ])
    room.updateMyMembership('join')
    expect(room.getMyMembership()).toBe('join')
    expect(room.currentState.getStateEvents(EventType.RoomCreate, '')?.getSender()).toBe(OWNER)
    expect(room.getMembers().map(member => [member.userId, member.membership])).toEqual([[OWNER, 'join']])
    const rooms: Room[] = []
    vi.spyOn(client, 'getRooms').mockImplementation(() => rooms)
    const create = vi.spyOn(client, 'createRoom').mockImplementation(async () => {
      rooms.push(room)
      return { room_id: room.roomId }
    })
    // Only HTTP is mocked: preserve the real SDK writer and its receiver requirements.
    const http = vi.spyOn(client.http, 'authedRequest').mockResolvedValue({})
    const notes = matrixNotesSelf(client, OWNER, () => true, vi.fn(), 50)

    await expect(notes.ensure()).resolves.toBe(room.roomId)
    await expect(notes.ensure()).resolves.toBe(room.roomId)
    expect(create).toHaveBeenCalledTimes(1)
    expect(http.mock.calls).toContainEqual([
      'PUT', `/user/${encodeURIComponent(OWNER)}/account_data/${MATRIX_NOTES_SELF_ACCOUNT_DATA}`,
      undefined, { version: 1, room_id: room.roomId }
    ])
  })

  it('replaces a quarantined room without sending to it and reuses the replacement', async () => {
    const bad = mockRoom({ id: '!unsafe:test', members: [
      { userId: OWNER, membership: 'join' }, { userId: '@other:test', membership: 'invite' }
    ] })
    const f = fixture([bad], { version: 1, room_id: bad.roomId })
    await expect(f.notes.ensure()).resolves.toBe('!created:test')
    await expect(f.notes.ensure()).resolves.toBe('!created:test')
    expect(() => f.notes.assertSend(bad.roomId)).toThrow('matrix_notes_self_quarantined')
    expect(f.account()).toEqual({ version: 1, room_id: '!created:test' })
    expect(f.createRoom).toHaveBeenCalledTimes(1)
    expect(f.sendStateEvent).not.toHaveBeenCalled()
  })

  it('creates and resolves one independent notes room for every company', async () => {
    const firstCompany = '00000000-0000-4000-8000-576f18824476'
    const secondCompany = '00000000-0000-4000-8000-4b2f94c54b02'
    const f = fixture()
    f.createRoom.mockImplementation(async (options: { creation_content?: Record<string, unknown> } = {}) => {
      const companyId = String(options.creation_content?.[MATRIX_NOTES_SELF_COMPANY_KEY])
      const room = mockRoom({ companyId, id: companyId === firstCompany ? '!first-company:test' : '!second-company:test' })
      f.rooms.push(room)

      return { room_id: room.roomId }
    })

    await expect(f.notes.ensure(firstCompany)).resolves.toBe('!first-company:test')
    await expect(f.notes.ensure(secondCompany)).resolves.toBe('!second-company:test')

    const snapshot = f.notes.snapshot()
    expect(snapshot.companies).toMatchObject({
      [firstCompany]: { state: 'ready', roomId: '!first-company:test' },
      [secondCompany]: { state: 'ready', roomId: '!second-company:test' }
    })
    expect(matrixNotesSelfRoom(snapshot, '!first-company:test')).toBe(true)
    expect(matrixNotesSelfCompanyId(snapshot, '!second-company:test')).toBe(secondCompany)
    expect(f.createRoom).toHaveBeenCalledTimes(2)
    expect(f.createRoom.mock.calls.map(([options]) => options?.creation_content)).toEqual([
      { type: MATRIX_NOTES_SELF_ROOM_TYPE, [MATRIX_NOTES_SELF_COMPANY_KEY]: firstCompany },
      { type: MATRIX_NOTES_SELF_ROOM_TYPE, [MATRIX_NOTES_SELF_COMPANY_KEY]: secondCompany }
    ])
  })

  it('survives the real SDK throwing from getPendingEvents under chronological ordering', async () => {
    // matrix-js-sdk Room.getPendingEvents() throws when the client uses chronological pending-event
    // ordering (Atum's setting). An escaping throw here stopped the person's sync at startup.
    const chronological = () => {
      throw new Error('Cannot call getPendingEvents with pendingEventOrdering == chronological')
    }
    const winner = Object.assign(mockRoom({ id: '!first:test', createdAt: 10, messages: 1 }), { getPendingEvents: chronological })
    const empty = Object.assign(mockRoom({ id: '!empty:test', createdAt: 20 }), { getPendingEvents: chronological })
    const f = fixture([empty, winner])

    await expect(f.notes.observedSync()).resolves.not.toThrow()
    expect(f.notes.snapshot()).toMatchObject({ state: 'ready', roomId: winner.roomId })
  })

  it('isolates unreadable rooms and retains a timeline failure as unknown while other rooms stay ready', async () => {
    const winner = mockRoom({ id: '!winner:test', createdAt: 10, messages: 1 })

    const unreadableTimeline = Object.assign(mockRoom({ id: '!timeline:test', createdAt: 20 }), {
      getLiveTimeline: () => {
        throw new Error('timeline unavailable')
      }
    })

    const unreadableState = mockRoom({ id: '!state:test', createdAt: 30 })

    const unreadableMembers = Object.assign(mockRoom({ id: '!members:test', createdAt: 40 }), {
      getMembers: () => {
        throw new Error('members unavailable')
      }
    })

    unreadableState.currentState.getStateEvents = () => {
      throw new Error('state unavailable')
    }

    const f = fixture([unreadableMembers, unreadableState, unreadableTimeline, winner])

    await expect(f.notes.observedSync()).resolves.not.toThrow()
    expect(f.notes.snapshot()).toEqual({
      state: 'ready',
      roomId: winner.roomId,
      duplicates: [{ roomId: unreadableTimeline.roomId, content: 'unknown' }],
      quarantinedRoomIds: [],
      retiredRoomIds: [],
      pointerWritable: true
    })
  })

  it('chooses the earliest room, tombstones only a proven-empty duplicate and retains notes', async () => {
    const winner = mockRoom({ id: '!first:test', createdAt: 10, messages: 1 })
    const empty = mockRoom({ id: '!empty:test', createdAt: 20 })
    const withNotes = mockRoom({ id: '!notes:test', createdAt: 30, messages: 2 })
    const f = fixture([withNotes, empty, winner])

    await f.notes.observedSync()

    expect(f.notes.snapshot()).toEqual({
      state: 'ready',
      roomId: winner.roomId,
      duplicates: [{ roomId: withNotes.roomId, content: 'notes' }],
      quarantinedRoomIds: [],
      retiredRoomIds: [empty.roomId],
      pointerWritable: true
    })
    expect(f.sendStateEvent).toHaveBeenCalledExactlyOnceWith(
      empty.roomId,
      EventType.RoomTombstone,
      { body: 'Personal notes moved to the earlier room.', replacement_room: winner.roomId },
      ''
    )
    expect(f.sendStateEvent).not.toHaveBeenCalledWith(withNotes.roomId, EventType.RoomTombstone, expect.anything(), '')
    expect(f.account()).toEqual({ version: 1, room_id: winner.roomId })
    expect(f.setRoomTag).toHaveBeenCalledWith(winner.roomId, MATRIX_NOTES_SELF_TAG, { order: 0 })
  })

  it('opens the winner with a stale pointer even if retiring an empty duplicate is forbidden', async () => {
    const winner = mockRoom({ id: '!winner:test', createdAt: 1, messages: 1 })
    const duplicate = mockRoom({ id: '!duplicate:test', createdAt: 2 })
    const f = fixture([duplicate, winner], { version: 1, room_id: '!missing:test' })
    f.sendStateEvent.mockRejectedValue(new Error('M_FORBIDDEN'))

    await expect(f.notes.ensure()).resolves.toBe(winner.roomId)
    await expect(f.notes.ensure()).resolves.toBe(winner.roomId)
    expect(f.account()).toEqual({ version: 1, room_id: winner.roomId })
    expect(f.createRoom).not.toHaveBeenCalled()
    expect(f.notes.snapshot().retiredRoomIds).toEqual([])
  })

  it('converges two devices racing the first open on the same earliest-created room', async () => {
    const rooms: ReturnType<typeof mockRoom>[] = []
    let account: unknown

    const device = (roomId: string, createdAt: number) => {
      const createRoom = vi.fn(async (options: { creation_content?: { type?: string } }) => {
        expect(options.creation_content?.type).toBe(MATRIX_NOTES_SELF_ROOM_TYPE)
        rooms.push(mockRoom({ id: roomId, createdAt }))

        return { room_id: roomId }
      })
      const sendStateEvent = vi.fn(async (
        duplicateRoomId: string,
        type: string,
        content: Record<string, unknown>
      ) => {
        rooms.find(room => room.roomId === duplicateRoomId)?.setState(type, content)

        return { event_id: '$tombstone' }
      })
      const client = {
        getUserId: () => OWNER,
        getRooms: () => rooms,
        getAccountData: (type: string) => type === MATRIX_NOTES_SELF_ACCOUNT_DATA && account !== undefined
          ? { getContent: () => account }
          : undefined,
        setAccountDataRaw: vi.fn(async (_type: string, value: unknown) => {account = value}),
        setRoomTag: vi.fn(async (taggedRoomId: string, tag: string, value: unknown) => {
          const room = rooms.find(candidate => candidate.roomId === taggedRoomId)

          if (room) {
            room.tags[tag] = value
          }

          return {}
        }),
        sendStateEvent,
        createRoom
      }

      return {
        createRoom,
        notes: matrixNotesSelf(client as never, OWNER, () => true, vi.fn(), 50),
        sendStateEvent
      }
    }

    // The first request receives the later server timestamp. Both clients have already passed
    // discovery before either create reply settles, which models two Macs opening You together.
    const first = device('!later:test', 20)
    const second = device('!earlier:test', 10)
    const opened = await Promise.all([first.notes.ensure(), second.notes.ensure()])

    await Promise.all([first.notes.observedSync(), second.notes.observedSync()])

    expect(opened).toEqual(['!earlier:test', '!earlier:test'])
    expect(first.createRoom).toHaveBeenCalledTimes(1)
    expect(second.createRoom).toHaveBeenCalledTimes(1)
    expect(account).toEqual({ version: 1, room_id: '!earlier:test' })
    expect(first.notes.snapshot()).toMatchObject({
      state: 'ready',
      roomId: '!earlier:test',
      retiredRoomIds: ['!later:test']
    })
    expect([...first.sendStateEvent.mock.calls, ...second.sendStateEvent.mock.calls]).toContainEqual([
      '!later:test',
      EventType.RoomTombstone,
      { body: 'Personal notes moved to the earlier room.', replacement_room: '!earlier:test' },
      ''
    ])
  })

  it('recovers a lost create reply by discovery on the next sync and never creates blindly again', async () => {
    const f = fixture()
    f.createRoom.mockRejectedValueOnce(new Error('reply lost'))

    await expect(f.notes.ensure()).rejects.toThrow('matrix_notes_self_uncertain')
    expect(f.notes.snapshot().state).toBe('uncertain')

    f.rooms.push(mockRoom({ id: '!lost-reply:test', createdAt: 50 }))
    await f.notes.observedSync()

    await expect(f.notes.ensure()).resolves.toBe('!lost-reply:test')
    expect(f.createRoom).toHaveBeenCalledTimes(1)
  })

  it('repairs a stale v1 pointer but treats unknown account data as read-only', async () => {
    const winner = mockRoom({ id: '!winner:test', createdAt: 10 })
    const stale = fixture([winner], { version: 1, room_id: '!missing:test' })

    await stale.notes.observedSync()
    expect(stale.setAccountDataRaw).toHaveBeenCalledWith(MATRIX_NOTES_SELF_ACCOUNT_DATA, {
      version: 1,
      room_id: winner.roomId
    })

    const unknown = fixture([winner], { version: 2, room_id: winner.roomId, future: true })
    await unknown.notes.observedSync()
    expect(unknown.notes.snapshot()).toMatchObject({ state: 'ready', roomId: winner.roomId, pointerWritable: false })
    expect(unknown.setAccountDataRaw).not.toHaveBeenCalled()
  })

  it('ignores spoofed tags, names and types without the exact owner-created marker', () => {
    const tagged = mockRoom({ id: '!tag:test', type: 'm.space', name: 'You' })
    tagged.tags[MATRIX_NOTES_SELF_TAG] = { order: 0 }
    const foreignType = mockRoom({ id: '!foreign:test', creator: '@other:test' })
    const exact = mockRoom({ id: '!exact:test', createdAt: 3 })

    const inspected = inspectMatrixNotesSelfRooms([tagged, foreignType, exact] as never, OWNER)

    expect(inspected.candidates.map(candidate => candidate.room.roomId)).toEqual([exact.roomId])
  })

  it('quarantines a typed room when another member joins and refuses Atum sends', async () => {
    const changed = mockRoom({
      id: '!shared:test',
      members: [
        { userId: OWNER, membership: 'join' },
        { userId: '@other:test', membership: 'join' }
      ]
    })
    const f = fixture([changed], { version: 1, room_id: changed.roomId })

    await f.notes.observedSync()

    expect(f.notes.snapshot()).toMatchObject({ state: 'quarantined', quarantinedRoomIds: [changed.roomId] })
    expect(() => f.notes.assertSend(changed.roomId)).toThrow('matrix_notes_self_quarantined')
    expect(f.createRoom).not.toHaveBeenCalled()
  })

  it('creates one invite-only, joined-history, guest-forbidden plain room with no alias or name', async () => {
    const f = fixture()

    await expect(f.notes.ensure()).resolves.toBe('!created:test')

    expect(f.createRoom).toHaveBeenCalledExactlyOnceWith({
      preset: 'private_chat',
      creation_content: { type: MATRIX_NOTES_SELF_ROOM_TYPE },
      initial_state: [
        { type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'joined' } },
        { type: EventType.RoomGuestAccess, state_key: '', content: { guest_access: 'forbidden' } }
      ]
    })
  })

  it('drops an uncertain account with its sdk instance instead of leaking it across account switch', async () => {
    const first = fixture([], undefined, OWNER)
    first.createRoom.mockRejectedValueOnce(new Error('reply lost'))
    await expect(first.notes.ensure()).rejects.toThrow('matrix_notes_self_uncertain')
    first.notes.stop()

    const second = fixture([], undefined, '@second:test')

    expect(second.notes.snapshot()).toMatchObject({ state: 'uncreated' })
    expect(second.notes.snapshot().roomId).toBeUndefined()
    await expect(second.notes.ensure()).resolves.toBe('!created:test')
    expect(second.createRoom).toHaveBeenCalledTimes(1)
  })
})
