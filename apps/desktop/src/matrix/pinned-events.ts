import { EventType, type MatrixClient, type MatrixEvent, RelationType, type Room } from 'matrix-js-sdk'

import type { MatrixMessage, MatrixPinnedMessages } from '../../shared/matrix'

/** A bounded shared return path, not an unbounded room index. */
export const MATRIX_PINNED_EVENTS_MAX = 100

const EVENT_ID = /^\$[!-~]{1,511}$/u

function pinnedContent(room: Room): unknown {
  return room.currentState.getStateEvents(EventType.RoomPinnedEvents, '')?.getContent().pinned
}

/** Strict standard state content. Malformed or oversized state is not rewritten from the client. */
export function matrixPinnedEventIds(room: Room): string[] | null {
  const value = pinnedContent(room)

  if (value === undefined) {
    return []
  }

  if (
    !Array.isArray(value) ||
    value.length > MATRIX_PINNED_EVENTS_MAX ||
    value.some(eventId => typeof eventId !== 'string' || !EVENT_ID.test(eventId)) ||
    new Set(value).size !== value.length
  ) {
    return null
  }

  return value
}

/** Display projection from the room's current state and the SDK's bounded event cache. */
export function matrixPinnedMessages(
  room: Room,
  userId: string,
  project: (event: MatrixEvent) => MatrixMessage | null
): MatrixPinnedMessages {
  const ids = matrixPinnedEventIds(room) ?? []
  const entries: MatrixPinnedMessages['entries'] = []

  for (const eventId of ids) {
    const event = room.findEventById(eventId)
    const message = event ? project(event) : null

    // A standard redaction removes a pin from every visible surface even when another client has
    // not yet cleaned the stale id out of room state. Missing history stays as a bounded tombstone.
    if (event?.isRedacted() || message?.redacted) {
      continue
    }

    entries.push(message ? { eventId, message } : { eventId })
  }

  return {
    canChange:
      room.getMyMembership() === 'join' && room.currentState.maySendStateEvent(EventType.RoomPinnedEvents, userId),
    entries
  }
}

function pinnableMessage(room: Room, eventId: string): MatrixEvent {
  const event = room.findEventById(eventId)

  if (
    !event ||
    !EVENT_ID.test(eventId) ||
    event.getId() !== eventId ||
    event.getRoomId() !== room.roomId ||
    event.status !== null ||
    event.getType() !== EventType.RoomMessage ||
    event.isRelation(RelationType.Replace) ||
    event.isRedacted() ||
    event.localRedactionEvent() ||
    event.isDecryptionFailure()
  ) {
    throw new Error('matrix_message_changed')
  }

  return event
}

/** Pin or unpin one message through the standard room state event. The homeserver remains the
 * authority; this rechecks membership, the live state-event threshold and the target immediately
 * before the write. */
export async function changeMatrixMessagePin(
  client: MatrixClient,
  room: Room,
  eventId: string,
  pinned: boolean
): Promise<void> {
  const userId = client.getSafeUserId()

  if (room.getMyMembership() !== 'join' || !room.currentState.maySendStateEvent(EventType.RoomPinnedEvents, userId)) {
    throw new Error('matrix_pin_forbidden')
  }

  pinnableMessage(room, eventId)
  const current = matrixPinnedEventIds(room)

  if (!current) {
    throw new Error('matrix_pin_state_invalid')
  }

  const present = current.includes(eventId)

  if (present === pinned) {
    return
  }

  const next = pinned ? [...current, eventId] : current.filter(id => id !== eventId)

  if (next.length > MATRIX_PINNED_EVENTS_MAX) {
    throw new Error('matrix_pin_limit')
  }

  await client.sendStateEvent(room.roomId, EventType.RoomPinnedEvents, { pinned: next }, '')
}
