import { createClient, EventType, type MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { conversationRoom } from './conversations'
import { joinRoomSuccessor, replacedRoomIds, roomPredecessor, roomSuccessor, tombstoneReplacement } from './room-upgrade'

const alice = '@alice:test'
const admin = '@admin:other.test'
const OLD = '!old:test'
const NEW = '!new:other.test'

afterEach(() => vi.restoreAllMocks())

interface Shape {
  membership?: 'join' | 'invite' | 'leave'
  /** The room this one's create event names as its predecessor; undefined: none. */
  predecessor?: string
  /** No create event at all: an invitation whose stripped state did not carry it. */
  unreadable?: boolean
  /** The replacement this room's tombstone names. */
  replacement?: string
}

/** One ordinary SDK room, built from the same state events a sync would deliver. */
function room(client: MatrixClient, id: string, shape: Shape = {}) {
  const value = new Room(id, client, alice)

  const state = (type: string, content: object, stateKey = '', sender = admin) =>
    new MatrixEvent({ type, state_key: stateKey, sender, room_id: id, content })

  value.currentState.setStateEvents([
    ...(shape.unreadable
      ? []
      : [
          state(EventType.RoomCreate, {
            room_version: '11',
            ...(shape.predecessor ? { predecessor: { room_id: shape.predecessor } } : {})
          })
        ]),
    state(EventType.RoomMember, { membership: shape.membership ?? 'join' }, alice, alice),
    ...(shape.replacement
      ? [state(EventType.RoomTombstone, { body: 'Upgraded', replacement_room: shape.replacement })]
      : [])
  ])
  value.updateMyMembership(shape.membership ?? 'join')
  client.store.storeRoom(value)

  return value
}

const client = () => createClient({ baseUrl: 'https://matrix.test', userId: alice })

describe('what an upgraded room shows', () => {
  it('names a replacement that is not joined yet as something to join, never joined by itself', () => {
    const c = client()
    const old = room(c, OLD, { replacement: NEW })
    const join = vi.spyOn(c, 'joinRoom')

    // Unknown until joined: nothing is readable, so the link cannot be confirmed yet.
    expect(roomSuccessor(c, old)).toEqual({ roomId: NEW, state: 'join', backlink: 'pending' })
    expect(conversationRoom(c, old).successor).toEqual({ roomId: NEW, state: 'join', backlink: 'pending' })
    expect(join).not.toHaveBeenCalled()
  })

  it('confirms an invitation whose readable state points back, and refuses one that names another room', () => {
    const c = client()
    const old = room(c, OLD, { replacement: NEW })

    room(c, NEW, { membership: 'invite', predecessor: OLD })
    expect(roomSuccessor(c, old)).toEqual({ roomId: NEW, state: 'join', backlink: 'verified' })

    room(c, NEW, { membership: 'invite', predecessor: '!elsewhere:test' })
    expect(roomSuccessor(c, old)).toEqual({ roomId: NEW, state: 'unconfirmed' })

    // An invitation whose state is not readable is pending, not refused.
    room(c, NEW, { membership: 'invite', unreadable: true })
    expect(roomSuccessor(c, old)).toEqual({ roomId: NEW, state: 'join', backlink: 'pending' })
  })

  it('opens a joined, confirming replacement and treats a joined one that does not confirm as unconfirmed', () => {
    const c = client()
    const old = room(c, OLD, { replacement: NEW })

    room(c, NEW, { predecessor: OLD })
    expect(roomSuccessor(c, old)).toEqual({ roomId: NEW, state: 'open' })

    room(c, NEW, { predecessor: '!elsewhere:test' })
    expect(roomSuccessor(c, old)).toEqual({ roomId: NEW, state: 'unconfirmed' })
  })

  it('shows nothing on a room that was not replaced, on one the person left, or on a self-referencing tombstone', () => {
    const c = client()

    expect(roomSuccessor(c, room(c, '!plain:test'))).toBeUndefined()
    expect(roomSuccessor(c, room(c, '!left:test', { membership: 'leave', replacement: NEW }))).toBeUndefined()
    expect(roomSuccessor(c, room(c, '!loop:test', { replacement: '!loop:test' }))).toBeUndefined()
    // A tombstone that does not name a room id is no tombstone.
    expect(tombstoneReplacement(room(c, '!bad:test', { replacement: 'not-a-room' }))).toBeUndefined()
  })

  it('keeps earlier history reachable from the replacement, only when both ends agree and it is joined', () => {
    const c = client()
    const old = room(c, OLD, { replacement: NEW })
    const next = room(c, NEW, { predecessor: OLD })

    expect(roomPredecessor(c, next)).toEqual({ roomId: OLD })
    expect(conversationRoom(c, next).predecessor).toEqual({ roomId: OLD })

    // The old room's tombstone names another room: not this one's history.
    room(c, OLD, { replacement: '!somewhere:test' })
    expect(roomPredecessor(c, next)).toBeUndefined()

    // The old room was left: nothing to open.
    room(c, OLD, { replacement: NEW, membership: 'leave' })
    expect(roomPredecessor(c, next)).toBeUndefined()
    expect(old.roomId).toBe(OLD)
  })
})

describe('the roster', () => {
  it('drops the replaced room only once its confirming replacement is joined', () => {
    const c = client()

    room(c, OLD, { replacement: NEW })
    expect(replacedRoomIds(c).size).toBe(0)

    // An invitation (even a confirming one) must not take the old room from view.
    room(c, NEW, { membership: 'invite', predecessor: OLD })
    expect(replacedRoomIds(c).size).toBe(0)

    // Nor a replacement the person has left.
    room(c, NEW, { membership: 'leave', predecessor: OLD })
    expect(replacedRoomIds(c).size).toBe(0)

    // Nor one that does not point back.
    room(c, NEW, { predecessor: '!elsewhere:test' })
    expect(replacedRoomIds(c).size).toBe(0)

    room(c, NEW, { predecessor: OLD })
    expect([...replacedRoomIds(c)]).toEqual([OLD])
  })

  it('hides every earlier link of a chain of upgrades', () => {
    const c = client()

    room(c, '!one:test', { replacement: '!two:test' })
    room(c, '!two:test', { predecessor: '!one:test', replacement: '!three:test' })
    room(c, '!three:test', { predecessor: '!two:test' })

    expect([...replacedRoomIds(c)].sort()).toEqual(['!one:test', '!two:test'])
  })
})

describe('go to the new room', () => {
  const active = () => true

  /** `joinRoom` as the server would answer: the room appears with this state once joined. */
  function serverJoins(c: MatrixClient, shape: Shape) {
    return vi.spyOn(c, 'joinRoom').mockImplementation(async id => room(c, id, { membership: 'join', ...shape }))
  }

  it('joins a replacement that only becomes readable on joining, asks the tombstone author’s server, and verifies the backlink', async () => {
    const c = client()
    room(c, OLD, { replacement: NEW })
    const join = serverJoins(c, { predecessor: OLD })

    await expect(joinRoomSuccessor(c, OLD, active)).resolves.toBe(NEW)
    expect(join).toHaveBeenCalledExactlyOnceWith(NEW, { viaServers: ['other.test'] })
  })

  it('opens an already joined, confirming replacement without a second join', async () => {
    const c = client()
    room(c, OLD, { replacement: NEW })
    room(c, NEW, { predecessor: OLD })
    const join = vi.spyOn(c, 'joinRoom')

    await expect(joinRoomSuccessor(c, OLD, active)).resolves.toBe(NEW)
    expect(join).not.toHaveBeenCalled()
  })

  it('leaves again a room that did not point back, and reports it unconfirmed', async () => {
    const c = client()
    room(c, OLD, { replacement: NEW })
    serverJoins(c, { predecessor: '!elsewhere:test' })
    const leave = vi.spyOn(c, 'leave').mockResolvedValue({})

    await expect(joinRoomSuccessor(c, OLD, active)).rejects.toThrow('matrix_room_upgrade_unconfirmed')
    expect(leave).toHaveBeenCalledExactlyOnceWith(NEW)
  })

  it('does not join a replacement already known not to point back', async () => {
    const c = client()
    room(c, OLD, { replacement: NEW })
    room(c, NEW, { membership: 'invite', predecessor: '!elsewhere:test' })
    const join = vi.spyOn(c, 'joinRoom')

    await expect(joinRoomSuccessor(c, OLD, active)).rejects.toThrow('matrix_room_upgrade_unconfirmed')
    expect(join).not.toHaveBeenCalled()
  })

  it('reports an inaccessible replacement as a failure and touches nothing of the old room', async () => {
    const c = client()
    const old = room(c, OLD, { replacement: NEW })
    vi.spyOn(c, 'joinRoom').mockRejectedValue(Object.assign(new Error('forbidden'), { errcode: 'M_FORBIDDEN' }))
    const leave = vi.spyOn(c, 'leave')

    await expect(joinRoomSuccessor(c, OLD, active)).rejects.toThrow('forbidden')
    expect(leave).not.toHaveBeenCalled()
    expect(old.getMyMembership()).toBe('join')
    expect(roomSuccessor(c, old)).toEqual({ roomId: NEW, state: 'join', backlink: 'pending' })
  })

  it('does not decide while the replacement’s state is still unreadable, and does not leave it', async () => {
    const c = client()
    room(c, OLD, { replacement: NEW })
    serverJoins(c, { unreadable: true })
    const leave = vi.spyOn(c, 'leave')

    await expect(joinRoomSuccessor(c, OLD, active, 120)).rejects.toThrow('matrix_room_upgrade_unconfirmed')
    expect(leave).not.toHaveBeenCalled()
  })

  it('refuses a room that was not replaced', async () => {
    const c = client()
    room(c, '!plain:test')

    await expect(joinRoomSuccessor(c, '!plain:test', active)).rejects.toThrow('matrix_room_upgrade_unavailable')
  })
})
