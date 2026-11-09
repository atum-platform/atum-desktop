import { EventType, type MatrixClient, MatrixEvent, type Room } from 'matrix-js-sdk'

/**
 * An event in its final form: what the Matrix client would have PUT into the room, ready for someone else to send.
 * For an encrypted room that is the `m.room.encrypted` content (the megolm ciphertext, its session and the device
 * that encrypted it); for a room without encryption it is the message itself.
 */
export interface MatrixPreparedEvent {
  eventType: 'm.room.message' | 'm.room.encrypted'
  content: Record<string, unknown>
}

/** The two members of the client that its own send path uses (`encryptAndSendEvent`), private in the typings. */
interface SendInternals {
  shouldEncryptEventForRoom?(event: MatrixEvent, room: Room): Promise<boolean>
  cryptoBackend?: { encryptEvent?(event: MatrixEvent, room: Room): Promise<void> }
}

/**
 * Prepare an event for a room exactly as `client.sendEvent` would, up to and not including the HTTP request: the
 * same decision whether the room needs encryption, the same crypto backend, the same room-key sharing to the
 * room's devices. The result is final: the same bytes are what must be sent, once, by whoever sends them.
 *
 * It relies on two members of the SDK's own send path. If a future SDK renames them this refuses
 * (`matrix_prepare_unsupported`) rather than guess, and `prepare-event.integration.test.ts` (a real Rust-crypto
 * client against a fake homeserver) fails with it. Nothing here ever sends.
 */
export async function prepareMatrixEvent(
  client: MatrixClient,
  room: Room,
  type: string,
  content: object
): Promise<MatrixPreparedEvent> {
  const internals = client as unknown as SendInternals

  if (typeof internals.shouldEncryptEventForRoom !== 'function') {
    throw new Error('matrix_prepare_unsupported')
  }

  const event = new MatrixEvent({ type, content, room_id: room.roomId, sender: client.getSafeUserId() })
  const encrypt = await internals.shouldEncryptEventForRoom(event, room)

  if (encrypt) {
    const backend = internals.cryptoBackend

    if (!backend || typeof backend.encryptEvent !== 'function') {
      throw new Error('matrix_prepare_unsupported')
    }

    await backend.encryptEvent(event, room)
  }

  const eventType = event.getWireType()

  // An encrypted room must have produced ciphertext, and a plain one the message it was given: nothing in between.
  if (encrypt ? eventType !== EventType.RoomMessageEncrypted : eventType !== EventType.RoomMessage) {
    throw new Error('matrix_prepare_unsupported')
  }

  const wire = JSON.parse(JSON.stringify(event.getWireContent())) as unknown

  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) {
    throw new Error('matrix_prepare_unsupported')
  }

  return { eventType: eventType as MatrixPreparedEvent['eventType'], content: wire as Record<string, unknown> }
}
