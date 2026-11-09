import { EventType, type MatrixClient, MatrixEvent, MsgType, RelationType } from 'matrix-js-sdk'

import {
  MATRIX_INTERIM_BODY_MAX,
  MATRIX_INTERIM_KEY,
  MATRIX_INTERIM_TRANSACTION,
  matrixInterimMarker
} from '../../shared/matrix-interim-marker'
import type { MatrixNoticeEdit } from '../../shared/matrix-notice-edit'
import { MATRIX_PROGRESS_KEY, type MatrixProgressMarker, matrixProgressMarker } from '../../shared/matrix-progress-marker'

import { confirmedPlainRoom } from './plain-room'

/** A live turn never reuses a legacy denial notice's fixed transaction. */
export function matrixStatusNoticeTransaction(eventId: string): string {
  const escaped = eventId.slice(1).replace(/[^\w-]/g, unit => `.${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)

  return `atum-sn-${escaped}`
}

/** A revision is allocated once per change and retained across publication retries. */
export function matrixNoticeEditTransaction(replaces: string, revision: number): string {
  const escaped = replaces.slice(1).replace(/[^\w-]/g, unit => `.${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)

  return `atum-ne-${revision}-${escaped}`
}

/** A progress line's original gets its own deterministic transaction (never a status line's). */
const PROGRESS_TRANSACTION = /^atum-cp-[a-f0-9]{64}$/
const STATUS_TRANSACTION = /^atum-cn-[a-f0-9]{64}$/

/** The command's progress marker, checked against the contract (agent-turns/1.3 `progress_marker`):
 * only on a status line, revision 0 on the original and the edit's own revision on an edit. */
function progressOf(command: MatrixNoticeEdit): MatrixProgressMarker | undefined {
  if (command.progress === undefined) {
    return undefined
  }

  const marker = matrixProgressMarker({ [MATRIX_PROGRESS_KEY]: command.progress })

  if (!marker || command.statusLine !== true || marker.revision !== (command.revision ?? 0)) {
    throw new Error('matrix_command_invalid')
  }

  return marker
}

/** Legacy notices do no extra I/O. An edit can only replace our original status reply, sent the
 * way its room sends: encrypted in a room with end-to-end encryption, plain in one without, told
 * as every plaintext send tells it (`confirmedPlainRoom`: the crypto store too). */
export async function matrixNoticeEditPayload(client: MatrixClient, command: MatrixNoticeEdit) {
  if (command.statusLine !== undefined && command.statusLine !== true) {
    throw new Error('matrix_command_invalid')
  }

  const progress = progressOf(command)

  if (command.transactionId !== undefined && (command.statusLine !== true || command.replaces !== undefined ||
      command.revision !== undefined || typeof command.transactionId !== 'string' ||
      !(progress ? PROGRESS_TRANSACTION : STATUS_TRANSACTION).test(command.transactionId))) {
    throw new Error('matrix_command_invalid')
  }

  if (command.replaces === undefined && command.revision === undefined) {
    if (command.statusLine !== true) {
      return null
    }

    if (
      typeof command.eventId !== 'string' ||
      !command.eventId.startsWith('$') ||
      command.eventId.length > 255 ||
      typeof command.body !== 'string' ||
      !command.body.trim() ||
      command.body.length > 1000 ||
      // A progress line never shares the status line's per-message transaction.
      (progress && command.transactionId === undefined)
    ) {
      throw new Error('matrix_command_invalid')
    }

    return {
      transactionId: command.transactionId ?? matrixStatusNoticeTransaction(command.eventId),
      content: {
        msgtype: MsgType.Notice as const,
        body: command.body,
        'm.relates_to': { 'm.in_reply_to': { event_id: command.eventId } },
        ...(progress ? { [MATRIX_PROGRESS_KEY]: progress } : {})
      }
    }
  }

  if (
    typeof command.replaces !== 'string' ||
    !command.replaces.startsWith('$') ||
    command.replaces.length > 255 ||
    !Number.isSafeInteger(command.revision) ||
    command.revision! < 1 ||
    typeof command.body !== 'string' ||
    !command.body.trim() ||
    command.body.length > 1000
  ) {
    throw new Error('matrix_command_invalid')
  }

  const original = new MatrixEvent(await client.fetchRoomEvent(command.roomId, command.replaces))
  await client.decryptEventIfNeeded(original)
  const content = original.getOriginalContent()
  // A room this device does not hold counts as encrypted: the rule as before 0.20. So does one
  // whose encryption state has not synced while the crypto store knows it, or cannot say in time.
  const room = client.getRoom(command.roomId)
  const encryptedRoom = !room || !(await confirmedPlainRoom(client, room))

  if (
    original.isEncrypted() !== encryptedRoom ||
    original.isDecryptionFailure() ||
    original.isRedacted() ||
    original.getRoomId() !== command.roomId ||
    original.getId() !== command.replaces ||
    original.getSender() !== client.getUserId() ||
    original.getType() !== EventType.RoomMessage ||
    content.msgtype !== MsgType.Notice ||
    // A progress edit replaces a progress original; a status edit never one.
    (progress !== undefined) !== (matrixProgressMarker(content) !== undefined) ||
    content['m.relates_to']?.rel_type === 'm.replace' ||
    content['m.relates_to']?.['m.in_reply_to']?.event_id !== command.eventId ||
    'io.atum.result' in content
  ) {
    throw new Error('matrix_notice_replacement_invalid')
  }

  return {
    transactionId: matrixNoticeEditTransaction(command.replaces, command.revision!),
    content: {
      msgtype: MsgType.Notice as const,
      body: `* ${command.body}`,
      'm.relates_to': { rel_type: RelationType.Replace as const, event_id: command.replaces },
      'm.new_content': {
        msgtype: MsgType.Notice as const,
        body: command.body,
        'm.relates_to': { 'm.in_reply_to': { event_id: command.eventId } },
        ...(progress ? { [MATRIX_PROGRESS_KEY]: progress } : {})
      },
      ...(progress ? { [MATRIX_PROGRESS_KEY]: progress } : {})
    }
  }
}

/** The deterministic transaction of a redaction: one removal per progress root, however often retried. */
export function matrixRedactionTransaction(replaces: string): string {
  const escaped = replaces.slice(1).replace(/[^\w-]/g, unit => `.${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)

  return `atum-cr-${escaped}`
}

/**
 * An interim remark (agent-turns/1.4): an ordinary `m.text` of the agent in its private chat, marked
 * `io.atum.interim`, under the publisher's deterministic `atum-ci-` transaction. Not a notice, not a
 * reply and never an answer (no `io.atum.result`).
 */
export function matrixInterimPayload(command: MatrixNoticeEdit) {
  if (
    command.interim !== true ||
    command.statusLine !== undefined ||
    command.progress !== undefined ||
    command.replaces !== undefined ||
    command.revision !== undefined ||
    command.redact !== undefined ||
    typeof command.eventId !== 'string' ||
    !command.eventId.startsWith('$') ||
    command.eventId.length > 255 ||
    typeof command.body !== 'string' ||
    !command.body.trim() ||
    [...command.body].length > MATRIX_INTERIM_BODY_MAX ||
    typeof command.transactionId !== 'string' ||
    !MATRIX_INTERIM_TRANSACTION.test(command.transactionId)
  ) {
    throw new Error('matrix_command_invalid')
  }

  return {
    transactionId: command.transactionId,
    content: { msgtype: MsgType.Text as const, body: command.body, [MATRIX_INTERIM_KEY]: true as const }
  }
}

/**
 * The agent removes its own working line once the turn has ended (agent-turns/1.4 A7): only an
 * `m.notice` it sent in this room that still carries `io.atum.progress`, or its own interim remark,
 * never an answer, an outcome notice or anyone else's message. Resolves quietly when the event is already gone.
 */
export async function matrixRedactableProgressLine(client: MatrixClient, command: MatrixNoticeEdit): Promise<boolean> {
  if (
    command.redact !== true ||
    command.statusLine !== undefined ||
    command.progress !== undefined ||
    command.interim !== undefined ||
    command.revision !== undefined ||
    command.transactionId !== undefined ||
    typeof command.replaces !== 'string' ||
    !command.replaces.startsWith('$') ||
    command.replaces.length > 255
  ) {
    throw new Error('matrix_command_invalid')
  }

  const original = new MatrixEvent(await client.fetchRoomEvent(command.roomId, command.replaces))
  await client.decryptEventIfNeeded(original)

  if (original.isRedacted()) {
    return false
  }

  const content = original.getOriginalContent()

  if (
    original.isDecryptionFailure() ||
    original.getRoomId() !== command.roomId ||
    original.getId() !== command.replaces ||
    original.getSender() !== client.getUserId() ||
    original.getType() !== EventType.RoomMessage ||
    content['m.relates_to']?.rel_type === 'm.replace' ||
    'io.atum.result' in content ||
    // A working line (a reply notice to this question) or the agent's own interim remark.
    !(
      (content.msgtype === MsgType.Notice &&
        matrixProgressMarker(content) !== undefined &&
        content['m.relates_to']?.['m.in_reply_to']?.event_id === command.eventId) ||
      matrixInterimMarker(content)
    )
  ) {
    throw new Error('matrix_notice_replacement_invalid')
  }

  return true
}
