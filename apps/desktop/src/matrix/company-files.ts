import { EventType, type MatrixClient, MatrixEvent, MsgType, type Room } from 'matrix-js-sdk'

import { companyRoomTargetBinding } from '../../shared/matrix-company-channel-room'
import {
  matrixCompanyFileContent,
  type MatrixCompanyFileContext,
  type MatrixCompanyFileRef,
  matrixCompanyFileRef
} from '../../shared/matrix-company-files'

import { requireFlatThreadTarget } from './threads'
import { sendWithTransaction } from './turn'

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const EVENT_ID = /^\$[!-~]{1,511}$/u

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unavailable(): never {
  throw new Error('matrix_company_file_unavailable')
}

function companyRoomContext(room: Room, threadRootId?: string, replyTo?: string): MatrixCompanyFileContext {
  if (room.getMyMembership() !== 'join') {
    return unavailable()
  }

  // `m.room.create` is immutable. Its current state copy is the local SDK's
  // view of that server event; no display projection or account data is trust.
  const creation = room.currentState.getStateEvents(EventType.RoomCreate, '')
  const binding = creation && companyRoomTargetBinding(creation.getContent(), creation.getSender())

  if (!binding || creation.getRoomId() !== room.roomId) {
    return unavailable()
  }

  if (threadRootId === undefined) {
    if (replyTo !== undefined) {
      return unavailable()
    }

    return {
      companyId: binding.companyId,
      target: binding.target.kind === 'channel'
        ? { kind: 'channel', channelId: binding.target.channelId }
        : { kind: 'conversation', conversationId: binding.target.conversationId },
      roomId: room.roomId
    }
  }

  requireFlatThreadTarget(room, threadRootId, replyTo)

  return {
    companyId: binding.companyId,
    target: binding.target.kind === 'channel'
      ? { kind: 'channel', channelId: binding.target.channelId }
      : { kind: 'conversation', conversationId: binding.target.conversationId },
    roomId: room.roomId,
    threadRootId,
    replyTo: replyTo ?? threadRootId
  }
}

/** Read the current joined channel binding and validate an optional flat-thread target. */
export function companyFileContext(room: Room, threadRootId?: string, replyTo?: string): MatrixCompanyFileContext {
  return companyRoomContext(room, threadRootId, replyTo)
}

/**
 * Send the frozen Matrix reference only. There is deliberately no Matrix media
 * upload or encrypted `file` descriptor on this path: the provider owns bytes.
 */
export async function sendCompanyFile(
  client: MatrixClient,
  room: Room,
  input: {
    requestId: string
    file: MatrixCompanyFileRef
    matrixTransactionId: string
    threadRootId?: string
    replyTo?: string
  }
): Promise<string> {
  if (!UUID.test(input.requestId) || input.matrixTransactionId !== `atum-cf-${input.requestId}`) {
    return unavailable()
  }

  const context = companyRoomContext(room, input.threadRootId, input.replyTo)
  const file = matrixCompanyFileRef(input.file, context)

  if (!file) {
    return unavailable()
  }

  const content: Record<string, unknown> = {
    msgtype: MsgType.File,
    body: file.name,
    info: { mimetype: file.content_type, size: file.size },
    'io.atum.company_file': file
  }

  if (context.threadRootId) {
    content['m.relates_to'] = {
      rel_type: 'm.thread',
      event_id: context.threadRootId,
      is_falling_back: true,
      'm.in_reply_to': { event_id: context.replyTo }
    }
  }

  return sendWithTransaction(client, room.roomId, input.matrixTransactionId, () =>
    client.sendEvent(room.roomId, EventType.RoomMessage, content as never, input.matrixTransactionId)
  )
}

/** Re-read an exact server event and accept only the frozen protected reference shape. */
export async function companyFileReference(
  client: MatrixClient,
  room: Room,
  eventId: string
): Promise<MatrixCompanyFileRef> {
  if (!EVENT_ID.test(eventId)) {
    return unavailable()
  }

  const context = companyRoomContext(room)
  const raw = await client.fetchRoomEvent(room.roomId, eventId).catch(() => unavailable())
  const event = new MatrixEvent(raw)

  if (
    event.getId() !== eventId ||
    event.getRoomId() !== room.roomId ||
    event.getType() !== EventType.RoomMessage ||
    event.getWireType() === EventType.RoomMessageEncrypted ||
    event.isRedacted() ||
    event.localRedactionEvent() ||
    event.isDecryptionFailure()
  ) {
    return unavailable()
  }

  const file = matrixCompanyFileContent(event.getContent(), context)

  if (!file) {
    return unavailable()
  }

  // `matrixCompanyFileContent` has already admitted only the frozen relation
  // shape. Re-apply the room's server-event graph guard before this reference
  // crosses the SDK boundary, so a remotely supplied nested thread is inert.
  const relation = event.getContent()['m.relates_to']

  if (relation !== undefined) {
    const related = record(relation) ? relation : undefined
    const reply = related && record(related['m.in_reply_to']) ? related['m.in_reply_to'].event_id : undefined

    if (typeof related?.event_id !== 'string' || typeof reply !== 'string') {
      return unavailable()
    }

    requireFlatThreadTarget(room, related.event_id, reply)
  }

  return file
}
