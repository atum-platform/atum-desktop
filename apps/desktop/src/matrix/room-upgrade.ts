import { EventType, type MatrixClient, type Room } from 'matrix-js-sdk'

import type { MatrixRoomPredecessor, MatrixRoomSuccessor } from '../../shared/matrix-room-upgrade'

/**
 * Room-upgrade continuity over the SDK's own state (spec "Room upgrades": `m.room.tombstone` on the
 * old room, `m.room.create.predecessor` on the new one). A transition counts as confirmed only when
 * both ends name each other. Nothing here joins, redirects or selects by itself: `joinRoomSuccessor`
 * is the one explicit action, and it runs only on the person's command.
 *
 * `client.getVisibleRooms()` is not used for the roster: it hides a replaced room whenever any
 * replacement is known, including a mere invitation or a room the person has left, which would
 * strand the old room before the person could see why it moved.
 */

const UNCONFIRMED = 'matrix_room_upgrade_unconfirmed'
const UNAVAILABLE = 'matrix_room_upgrade_unavailable'

/** The replacement a room's tombstone names, as a bounded Matrix room id. */
export function tombstoneReplacement(room: Room): string | undefined {
  const event = room.currentState.getStateEvents(EventType.RoomTombstone, '')
  const value: unknown = event && !Array.isArray(event) ? event.getContent()?.replacement_room : undefined

  return typeof value === 'string' && value.startsWith('!') && value.length <= 1024 ? value : undefined
}

type Backlink = 'verified' | 'mismatch' | 'unreadable'

/** Whether `successor`'s create event names `oldRoomId`. Unreadable until its state has arrived. */
function backlink(successor: Room, oldRoomId: string): Backlink {
  if (!successor.currentState.getStateEvents(EventType.RoomCreate, '')) {
    return 'unreadable'
  }

  return successor.findPredecessor()?.roomId === oldRoomId ? 'verified' : 'mismatch'
}

/** The old room's view of its replacement; undefined for a room that was not replaced. */
export function roomSuccessor(client: MatrixClient, room: Room): MatrixRoomSuccessor | undefined {
  const roomId = tombstoneReplacement(room)

  if (!roomId || roomId === room.roomId || room.getMyMembership() !== 'join') {
    return undefined
  }

  const successor = client.getRoom(roomId)
  const membership = successor?.getMyMembership()
  const link = successor ? backlink(successor, room.roomId) : 'unreadable'

  if (membership === 'join') {
    return { roomId, state: link === 'verified' ? 'open' : 'unconfirmed' }
  }

  if (link === 'mismatch') {
    return { roomId, state: 'unconfirmed' }
  }

  return { roomId, state: 'join', backlink: link === 'verified' ? 'verified' : 'pending' }
}

/** The new room's view of the room it replaced: joined, and that room's tombstone names this one. */
export function roomPredecessor(client: MatrixClient, room: Room): MatrixRoomPredecessor | undefined {
  if (room.getMyMembership() !== 'join') {
    return undefined
  }

  const roomId = room.findPredecessor()?.roomId
  const earlier = roomId ? client.getRoom(roomId) : null

  return roomId &&
    roomId !== room.roomId &&
    earlier?.getMyMembership() === 'join' &&
    tombstoneReplacement(earlier) === room.roomId
    ? { roomId }
    : undefined
}

/** Rooms the roster hides: replaced by a joined room that confirms it. The person's open room stays. */
export function replacedRoomIds(client: MatrixClient): Set<string> {
  const replaced = new Set<string>()

  for (const room of client.getRooms()) {
    const earlier = roomPredecessor(client, room)

    if (earlier) {
      replaced.add(earlier.roomId)
    }
  }

  return replaced
}

function serverOf(id: string | null | undefined): string | undefined {
  const at = id?.indexOf(':') ?? -1

  return id && at > 0 ? id.slice(at + 1) : undefined
}

/** Where to ask for the replacement: the tombstone's author's server, then the id's own. */
function viaServers(room: Room, replacementId: string): string[] {
  const tombstone = room.currentState.getStateEvents(EventType.RoomTombstone, '')
  const sender = tombstone && !Array.isArray(tombstone) ? tombstone.getSender() : undefined

  return [...new Set([serverOf(sender), serverOf(replacementId)].filter((value): value is string => !!value))]
}

const WAIT_MS = 10_000

/**
 * The person's explicit "go to the new room". Joins the replacement (an invitation or a room not
 * known until joined), then checks its create event points back at the old room once readable. A
 * replacement that does not confirm is left again, so a tombstone can never make the person a
 * member of a room that is not this one's successor.
 */
export async function joinRoomSuccessor(
  client: MatrixClient,
  oldRoomId: string,
  active: () => boolean,
  waitMs = WAIT_MS
): Promise<string> {
  const room = client.getRoom(oldRoomId)
  const link = room ? roomSuccessor(client, room) : undefined

  if (!room || !link) {
    throw new Error(UNAVAILABLE)
  }

  if (link.state === 'open') {
    return link.roomId
  }

  if (link.state === 'unconfirmed') {
    throw new Error(UNCONFIRMED)
  }

  await client.joinRoom(link.roomId, { viaServers: viaServers(room, link.roomId) })

  const deadline = Date.now() + waitMs
  let result: Backlink = 'unreadable'

  for (;;) {
    const joined = client.getRoom(link.roomId)
    result = joined ? backlink(joined, oldRoomId) : 'unreadable'

    if (result !== 'unreadable' || Date.now() >= deadline || !active()) {
      break
    }

    await new Promise(resolve => setTimeout(resolve, 50))
  }

  if (result === 'mismatch') {
    await client.leave(link.roomId).catch(() => {
      // The join was ours and is undone on a best effort. The projection keeps the room unconfirmed.
    })
  }

  if (result !== 'verified') {
    throw new Error(UNCONFIRMED)
  }

  return link.roomId
}
