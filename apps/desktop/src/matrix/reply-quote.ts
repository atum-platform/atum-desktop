import { EventType, type MatrixClient, MatrixEvent } from 'matrix-js-sdk'

import { type MatrixReplyQuoteRead, matrixRoomTextTooLong } from '../../shared/matrix'
import { matrixReplyWords } from '../../shared/matrix-turn-intake'

import { plainRoomAnswer } from './plain-room'
import { matrixReplyRoot } from './reply-relation'
import { trustedMatrixSender } from './sender-trust'

const NONE: MatrixReplyQuoteRead = { state: 'none' }
const PENDING: MatrixReplyQuoteRead = { state: 'pending' }

/** A missing or forbidden event will not appear by asking again; anything else might. */
function gone(error: unknown) {
  const code = (error as { errcode?: unknown } | null)?.errcode

  return code === 'M_NOT_FOUND' || code === 'M_FORBIDDEN'
}

/**
 * The words a reply quotes, for the assistant to read as context (the agent-room contract,
 * shared/matrix-turn-intake.ts). Read from the server by the owner's SDK (this Mac answering)
 * or by the agent's own (the cloud brain, which holds no owner keys), in the reply's own room
 * only, as first sent (never an edit's replacement): the same event gives the same words on
 * every attempt. Only the owner's or the room's agent's message on a verified device is
 * quoted, the same rule the conversation's continuity reads by; a message that is itself a
 * reply gives its own words, and the message it answers is never fetched. Classification
 * only: main bounds and formats the quote, and refuses a reply it cannot quote.
 *
 * A group turn (`anyMember`) may quote anyone in the room, verified or not, and says which
 * (`sender`, `verified`): main passes such words to the assistant as quoted data, never as
 * the owner's instructions (electron/matrix/group-turns.ts).
 *
 * In a room without end-to-end encryption (every chat since 0.20) a message is read as sent,
 * with no device check: the homeserver authenticated its sender (owner decision D1), so it
 * counts as verified, and the sender rule above still applies. A room with encryption keeps the
 * path above, and a plaintext message in it is never quoted (no downgrade).
 */
export async function readMatrixReplyQuote(
  client: MatrixClient,
  target: { roomId: string; eventId: string; ownerId: string; agentId: string; anyMember?: true }
): Promise<MatrixReplyQuoteRead> {
  const room = client.getRoom(target.roomId)

  const reader = client.getUserId()

  if (
    (reader !== target.ownerId && reader !== target.agentId) ||
    target.ownerId === target.agentId ||
    !target.eventId.startsWith('$') ||
    room?.getMyMembership() !== 'join'
  ) {
    return NONE
  }

  // Plain only when the crypto store agrees too (plain-room.ts). No answer in time is "not yet"
  // (main asks again), never "no quote", which would post a held-reply notice for a plain reply.
  const plain = await plainRoomAnswer(client, room)

  if (plain === undefined) {
    return PENDING
  }

  let raw: Awaited<ReturnType<MatrixClient['fetchRoomEvent']>>

  try {
    raw = await client.fetchRoomEvent(target.roomId, target.eventId)
  } catch (error) {
    return gone(error) ? NONE : PENDING
  }

  const event = new MatrixEvent(raw)
  const sender = event.getSender()

  if (
    raw?.type !== (plain ? EventType.RoomMessage : EventType.RoomMessageEncrypted) ||
    event.getRoomId() !== target.roomId ||
    event.getId() !== target.eventId ||
    !sender ||
    // In a group the owner may quote anyone there; main marks such words as theirs, never the
    // owner's instructions (group-turns.ts). Anywhere else, only the owner's or the agent's.
    (!target.anyMember && sender !== target.ownerId && sender !== target.agentId) ||
    event.isRedacted()
  ) {
    return NONE
  }

  const verified = plain ? true : await encryptedSenderVerified(client, event, sender)
  const after = client.getRoom(target.roomId)
  // Encryption turned on while the event was read: plaintext no longer counts there.
  const stillPlain = plain ? Boolean(after) && (await plainRoomAnswer(client, after!)) : false

  if (verified === 'pending' || stillPlain === undefined) {
    return PENDING
  }

  if (
    verified === 'none' ||
    event.isRedacted() ||
    event.getType() !== EventType.RoomMessage ||
    (plain && !stillPlain)
  ) {
    return NONE
  }

  // A group's quote is someone's words whatever their device: unverified, it is marked so.
  if (!verified && !target.anyMember) {
    return NONE
  }

  const content = event.getContent()
  const relation = content['m.relates_to']
  const wire = event.getWireContent()['m.relates_to']
  const relationType = (value: unknown) => (value as { rel_type?: unknown } | undefined)?.rel_type

  // An edit or a reaction is something done to a message, never the message a reply quotes.
  if (
    [relationType(relation), relationType(wire)].some(type => type === 'm.replace' || type === 'm.annotation') ||
    typeof content.body !== 'string' ||
    // Any message this app sends: a long answer (or one part of a split one) can be replied to.
    matrixRoomTextTooLong(content.body)
  ) {
    return NONE
  }

  const text = matrixReplyRoot(content) ? matrixReplyWords(content.body) : content.body

  return text.trim()
    ? { state: 'message', eventId: target.eventId, sender, text, ...(target.anyMember ? { verified } : {}) }
    : NONE
}

/** Whether an encrypted message's sending device is trusted: `pending` while it cannot be
 * decrypted yet, `none` when it is gone or this client has no crypto. */
async function encryptedSenderVerified(
  client: MatrixClient,
  event: MatrixEvent,
  sender: string
): Promise<boolean | 'pending' | 'none'> {
  try {
    await client.decryptEventIfNeeded(event)
  } catch {
    return 'pending'
  }

  if (event.isDecryptionFailure()) {
    return 'pending'
  }

  const crypto = client.getCrypto()

  if (event.isRedacted() || event.getType() !== EventType.RoomMessage || !crypto) {
    return 'none'
  }

  const devices = await crypto.getUserDeviceInfo([sender], true)

  const device = [...(devices.get(sender)?.values() ?? [])].find(
    item => item.getIdentityKey() === event.getSenderKey() && item.getFingerprint() === event.getClaimedEd25519Key()
  )

  const trust = device ? await crypto.getDeviceVerificationStatus(sender, device.deviceId) : null

  return trustedMatrixSender(trust, await crypto.getEncryptionInfoForEvent(event))
}
