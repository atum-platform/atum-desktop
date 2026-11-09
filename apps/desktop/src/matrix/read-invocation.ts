import { EventType, type MatrixClient, MatrixEvent, MsgType } from 'matrix-js-sdk'

import { canonicalJson } from '../../../../packages/device-protocol/canonical'
import { agentTaskMessage, MATRIX_AGENT_TASK_KEY } from '../../shared/agent-task'
import {
  MATRIX_PLAIN_SENDER_DEVICE,
  matrixAttachmentMsgtype,
  type MatrixInvocationMessage,
  type MatrixOriginAssertion,
  matrixRoomTextTooLong
} from '../../shared/matrix'
import { MATRIX_GOOGLE_PROVENANCE_KEY } from '../../shared/matrix-google-tools'
import { MATRIX_TASK_FILES_KEY, parseMatrixTaskFilesPromise } from '../../shared/matrix-task-files'
import { MATRIX_TURN_KEY, matrixTurnId } from '../../shared/matrix-turn'
import { matrixTurnIntake } from '../../shared/matrix-turn-intake'

import { MATRIX_FORWARDED_KEY } from './forward-content'
import { GROUP_CHAIN_KEY, parseGroupChain } from './group-chain-publish'
import { decryptMatrixInvocation } from './invocation-decryption-retry'
import { downloadMatrixAttachment } from './media'
import { knownPlainRoom } from './plain-room'
import { matrixReplyRoot } from './reply-relation'
import { trustedMatrixSender } from './sender-trust'

/** The content key the owner device's signed origin assertion travels under (C0 §3.2). */
const ORIGIN_KEY = 'io.atum.origin'

/**
 * Request digest v2 (atum.cloud-answering/1): unpadded base64url SHA-256 of the canonical
 * content as sent (decrypted, or as it arrived in a room without encryption) without its
 * `io.atum.origin` key, computed before anything is dropped, so
 * the controller can match it to the origin assertion's `dg` and to DA's `requestHash` (the same
 * bytes in hex). Content that canonical JSON cannot carry (a non-integer number) has no digest.
 */
async function contentDigestV2(content: Record<string, unknown>): Promise<string | undefined> {
  const { [ORIGIN_KEY]: _origin, ...rest } = content
  let canonical: string

  try {
    canonical = canonicalJson(rest)
  } catch {
    return undefined
  }

  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)))

  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** The raw assertion object, passed on for the controller to verify (it grants nothing here). */
function originAssertion(value: unknown): MatrixOriginAssertion | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) && JSON.stringify(value).length <= 4096
    ? (value as MatrixOriginAssertion)
    : undefined
}

/** Who sent an encrypted event: the device whose keys sent it, and whether it is trusted. */
async function encryptedSender(client: MatrixClient, event: MatrixEvent, sender: string) {
  const crypto = client.getCrypto()!
  const devices = await crypto.getUserDeviceInfo([sender], true)

  const device = [...(devices.get(sender)?.values() ?? [])].find(
    device =>
      device.getIdentityKey() === event.getSenderKey() && device.getFingerprint() === event.getClaimedEd25519Key()
  )

  const trust = device ? await crypto.getDeviceVerificationStatus(sender, device.deviceId) : null

  return {
    senderDevice: device?.deviceId,
    senderVerified: trustedMatrixSender(trust, await crypto.getEncryptionInfoForEvent(event)),
    senderFingerprint: device?.getFingerprint() ?? undefined
  }
}

/** A message in a room without encryption names no device: the homeserver authenticated its
 * sender, which the owner accepted as the identity there (D1, 2026-10-09). */
const PLAIN_SENDER = { senderDevice: MATRIX_PLAIN_SENDER_DEVICE, senderVerified: true, senderFingerprint: undefined }

/**
 * Re-fetch from this principal's SDK; renderer hints carry no authority.
 *
 * In a room without end-to-end encryption (every room since 0.20; by this client's synced state
 * and its crypto store both, plain-room.ts), a message is read as sent: `wireType`
 * `m.room.message`, `roomPlain`, sender verified, device `MATRIX_PLAIN_SENDER_DEVICE`. A room with
 * encryption keeps today's path: an encrypted event only, decrypted and checked against the
 * sending device's trust; a plaintext event in it is refused (no downgrade). Which room may use
 * the message stays with the caller's admission (an assistant room, or a group with the agent),
 * and whose message starts a turn too: an agent answers only its owner.
 */
export async function readMatrixInvocation(
  client: MatrixClient,
  target: { roomId: string; eventId: string; includeAttachment?: boolean }
): Promise<MatrixInvocationMessage> {
  const room = client.getRoom(target.roomId)

  if (room?.getMyMembership() !== 'join') {
    throw new Error('matrix_encrypted_room_required')
  }

  // Plain only when the crypto store agrees (plain-room.ts): a room whose encryption state has
  // not synced yet still takes only encrypted events. A store that does not answer in time fails
  // the read, to be retried, instead of refusing a plain message as if the room were encrypted.
  const plain = await knownPlainRoom(client, room, 'matrix_operation_failed')
  const raw = await client.fetchRoomEvent(target.roomId, target.eventId)
  let event = new MatrixEvent(raw)

  if (event.status !== null || raw.type !== (plain ? EventType.RoomMessage : EventType.RoomMessageEncrypted)) {
    throw new Error('matrix_invocation_untrusted')
  }

  if (!plain) {
    event = await decryptMatrixInvocation(client, event)
  }

  const roomAfter = client.getRoom(target.roomId)

  if (
    roomAfter?.getMyMembership() !== 'join' ||
    // Encryption was turned on while the event was read: plaintext no longer counts there.
    (await knownPlainRoom(client, roomAfter, 'matrix_operation_failed')) !== plain ||
    event.isDecryptionFailure() ||
    event.isRedacted() ||
    event.getRoomId() !== target.roomId ||
    event.getId() !== target.eventId
  ) {
    throw new Error('matrix_invocation_untrusted')
  }

  const sender = event.getSender()!

  const { senderDevice, senderVerified, senderFingerprint } = plain
    ? PLAIN_SENDER
    : await encryptedSender(client, event, sender)

  const content = event.getContent()
  // Legacy answers were m.thread relations; current answers are rich replies.
  const resultRoot = matrixReplyRoot(content)
  const addressing: unknown = content['m.mentions']
  const mentions: unknown = content['m.mentions']?.user_ids

  // Never infer addressing from a display name, HTML, or a room-wide mention.
  // Preserve malformed explicit addressing as a denial, never as ambient text.
  // This projection is not execution authorization.
  const mentionedUserIds =
    Array.isArray(mentions) &&
    mentions.length <= 100 &&
    mentions.every(
      id => typeof id === 'string' && id.length <= 1024 && id.trim() === id && /^@[^:\s]+:[^\s]+$/.test(id)
    )
      ? [...new Set(mentions as string[])]
      : undefined

  const invalidMentions =
    addressing !== undefined &&
    (addressing === null ||
      typeof addressing !== 'object' ||
      Array.isArray(addressing) ||
      (mentions !== undefined && !mentionedUserIds) ||
      (content['m.mentions']?.room !== undefined && typeof content['m.mentions']?.room !== 'boolean'))

  // A present-but-invalid task-file promise stays visible to main as a denial.
  // Never erase it and accidentally turn the message into an ordinary file-free request.
  const taskFilesPresent = Object.prototype.hasOwnProperty.call(content, MATRIX_TASK_FILES_KEY)
  const taskFiles = taskFilesPresent ? parseMatrixTaskFilesPromise(content[MATRIX_TASK_FILES_KEY]) : null
  const agentTask = agentTaskMessage(content[MATRIX_AGENT_TASK_KEY])

  // The media an m.file or m.image names: an encrypted descriptor (`file`), or, only in a room without
  // encryption, the plain mxc URL (`url`) that phones and Element X send there.
  const file =
    !matrixAttachmentMsgtype(content.msgtype)
      ? undefined
      : content.file
        ? content.file
        : plain && typeof content.url === 'string'
          ? { url: content.url }
          : undefined

  const name = content.filename ?? content.body

  if (
    event.getType() !== EventType.RoomMessage ||
    !(content.msgtype === MsgType.Text || file) ||
    typeof content.body !== 'string' ||
    !content.body.length ||
    matrixRoomTextTooLong(content.body) ||
    (file && (typeof name !== 'string' || !name.length || name.length > 255))
  ) {
    throw new Error('matrix_invocation_invalid')
  }

  // Bind the exact media descriptor without exporting its URL/keys.
  const fingerprint = file
    ? Array.from(
        new Uint8Array(
          await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(file)))
        ),
        byte => byte.toString(16).padStart(2, '0')
      ).join('')
    : undefined

  // The cloud brain's projection (S1 §3.2, §4 WS-2): the digest the origin assertion binds, the
  // sender device's fingerprint and the assertion itself.
  const contentDigest = await contentDigestV2(content)
  const origin = originAssertion(content[ORIGIN_KEY])

  // A pure reply (the agent-room contract): the message it answers, re-read by main (or the
  // cloud brain) for its words. Never for an edit, a reaction, a thread, a marked local turn,
  // or a reply relation only in the clear (still `related`, so main's watch refuses it).
  const intake = matrixTurnIntake({
    type: event.getType(),
    content,
    wireRelation: event.getWireContent()['m.relates_to'],
    redacted: event.isRedacted()
  })

  const replyTo = intake.turn ? intake.replyTo : undefined

  const result: MatrixInvocationMessage = {
    roomId: target.roomId,
    eventId: target.eventId,
    wireType: raw.type,
    sender,
    senderDevice,
    senderVerified,
    timestamp: event.localTimestamp,
    // An encrypted event may carry its relation only outside the ciphertext (older clients
    // moved it there): an edit or a reaction is related either way, never a fresh turn.
    related: content['m.relates_to'] !== undefined || event.getWireContent()['m.relates_to'] !== undefined,
    content: {
      msgtype: content.msgtype!,
      body: content.body,
      ...(parseGroupChain(content[GROUP_CHAIN_KEY]) ? { chain: parseGroupChain(content[GROUP_CHAIN_KEY]) } : {}),
      ...(mentionedUserIds ? { mentionedUserIds } : {}),
      ...(invalidMentions ? { invalidMentions: true as const } : {}),
      // Presence is enough to keep a protected source out of an unrelated model route. The
      // owner-side protected sender wrote the marker; malformed or forwarded marks fail closed too.
      ...(Object.prototype.hasOwnProperty.call(content, MATRIX_GOOGLE_PROVENANCE_KEY)
        ? { googleProtected: true as const }
        : {}),
      ...(content[MATRIX_FORWARDED_KEY] === true ? { forwarded: true as const } : {}),
      ...(taskFiles ? { taskFiles } : {}),
      ...(agentTask ? { agentTask } : {}),
      ...(taskFilesPresent && !taskFiles ? { invalidTaskFiles: true as const } : {}),
      ...(file ? { attachment: { name, fingerprint: fingerprint! } } : {}),
      ...(resultRoot &&
      typeof content['io.atum.result']?.invocation === 'string' &&
      typeof content['io.atum.result']?.transaction === 'string'
        ? {
            result: {
              rootEventId: resultRoot,
              invocationId: content['io.atum.result'].invocation,
              transactionId: content['io.atum.result'].transaction
            }
          }
        : {}),
      // The fence (invocation.ts) keys on this: a local-path turn from this human
      // device is never executed again by the server path.
      ...(matrixTurnId(content[MATRIX_TURN_KEY]) ? { turn: content[MATRIX_TURN_KEY] as string } : {}),
      ...(origin ? { origin } : {}),
      ...(replyTo ? { replyTo } : {})
    },
    ...(plain ? { roomPlain: true as const } : {}),
    ...(contentDigest ? { contentDigest } : {}),
    ...(senderFingerprint ? { senderFingerprint } : {}),
    ...(!intake.turn && intake.reason === 'thread' ? { thread: true as const } : {})
  }

  if (file && target.includeAttachment) {
    if (!senderVerified) {
      throw new Error('matrix_invocation_untrusted')
    }

    const downloaded = await downloadMatrixAttachment(client, content, { plain })
    // Download can outlive membership, device verification, event redaction or the room's
    // encryption state: the re-read below checks all of them again.
    const current = await readMatrixInvocation(client, { ...target, includeAttachment: false })

    if (!current.senderVerified || JSON.stringify(current.content) !== JSON.stringify(result.content)) {
      throw new Error('matrix_invocation_untrusted')
    }

    return { ...current, attachmentBytes: downloaded.bytes }
  }

  return result
}
