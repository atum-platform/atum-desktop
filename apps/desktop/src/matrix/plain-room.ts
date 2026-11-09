import { EventType, type MatrixClient } from 'matrix-js-sdk'

import { type MatrixRoomStateView, plainRoom } from '../../shared/matrix-assistant-room'

/** How long one decision waits for the crypto store before it counts the room as encrypted. */
export const PLAIN_ANSWER_MS = 5_000

/**
 * The crypto store's word on whether a room is plain: true when the room shows no encryption
 * state in this client's synced view (`plainRoom`) and the store has never recorded it as
 * encrypted; false when it is encrypted (its synced state shows it, or the store has it, a record
 * that never turns off); undefined when no answer could be had (no crypto, an error, or none
 * within `PLAIN_ANSWER_MS`). Undefined counts as encrypted for the one decision that asked and is
 * never remembered, so the next one asks again.
 */
export async function plainRoomAnswer(
  client: Pick<MatrixClient, 'getCrypto'>,
  room: Pick<MatrixRoomStateView, 'hasEncryptionStateEvent'> & { roomId: string },
  ms = PLAIN_ANSWER_MS
): Promise<boolean | undefined> {
  if (!plainRoom(room)) {
    return false
  }

  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    const crypto = client.getCrypto()

    if (!crypto) {
      return undefined
    }

    const encrypted = await Promise.race([
      crypto.isEncryptionEnabledInRoom(room.roomId),
      new Promise<undefined>(resolve => {
        timer = setTimeout(resolve, ms, undefined)
      })
    ])

    return typeof encrypted === 'boolean' ? !encrypted : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Whether a room is plain for reading and for sending: no encryption state in this client's
 * synced view (`plainRoom`), and the crypto store has never recorded the room as encrypted (that
 * record never turns off; it is what the SDK itself reads before it sends in plaintext).
 *
 * The synced view alone is not enough: after a restart, a lagging sync or a new join, an
 * encrypted room can show no `m.room.encryption` state yet while the crypto store already knows
 * it is encrypted, and a plaintext event injected there must never be read as a plain message
 * (no downgrade). Fails closed: a client without crypto, or a crypto answer that cannot be had
 * in time (`plainRoomAnswer`), counts as encrypted. Every read and send path that takes plaintext
 * or a plain media URL decides by this one rule. That suits a decision made once (what to show,
 * one read the caller may repeat); a decision that lasts (a cursor moved past a message, a journal
 * entry settled, a message refused for good) asks `plainRoomAnswer` instead and treats no answer
 * as "not known yet", so it is retried rather than taken as encrypted.
 */
export async function confirmedPlainRoom(
  client: Pick<MatrixClient, 'getCrypto'>,
  room: Pick<MatrixRoomStateView, 'hasEncryptionStateEvent'> & { roomId: string }
): Promise<boolean> {
  return (await plainRoomAnswer(client, room)) === true
}

/**
 * `plainRoomAnswer` for a read whose outcome lasts (a scan that lets a cursor move, a resumed
 * conversation, a turn's context): no answer in time throws `failure`, the caller's own "try again"
 * code, so a stalled store fails the read as a hung one would, and never makes a plain room's
 * messages look absent.
 */
export async function knownPlainRoom(
  client: Pick<MatrixClient, 'getCrypto'>,
  room: Pick<MatrixRoomStateView, 'hasEncryptionStateEvent'> & { roomId: string },
  failure: string
): Promise<boolean> {
  const plain = await plainRoomAnswer(client, room)

  if (plain === undefined) {
    throw new Error(failure)
  }

  return plain
}

/**
 * The wire type a joined room's messages must arrive as, handed to `then`: encrypted at once for
 * a room that shows encryption state; otherwise plaintext only once the crypto store agrees
 * (`plainRoomAnswer`), encrypted if it does not. Undefined when the store does not answer in
 * time: the live watches then pass the hint on rather than drop it, since every hint is read
 * again where it is used (read-invocation.ts, the bot's own read), and that read asks the store
 * again and never takes plaintext in an encrypted room. Null when this account is not in the room.
 * A room with encryption keeps its synchronous path; only a room that looks plain waits.
 */
export function withJoinedWireType(
  client: Pick<MatrixClient, 'getCrypto' | 'getRoom'>,
  roomId: string,
  then: (wireType: string | null | undefined) => void
): void {
  const room = client.getRoom(roomId)

  if (room?.getMyMembership() !== 'join') {
    then(null)
  } else if (room.hasEncryptionStateEvent()) {
    then(EventType.RoomMessageEncrypted)
  } else {
    void plainRoomAnswer(client, room).then(plain =>
      then(plain === undefined ? undefined : plain ? EventType.RoomMessage : EventType.RoomMessageEncrypted)
    )
  }
}
