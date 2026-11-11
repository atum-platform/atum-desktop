import { EventStatus, EventType, type MatrixClient, type MatrixEvent, MsgType, RelationType, type Room } from 'matrix-js-sdk'

import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import { latestSettledEvent, readThrough } from './read-receipts'

/**
 * Matrix's own message features, as the SDK host sends them (launch night: replies, edits,
 * deletion, reactions, typing and marking a chat unread). Each one is the standard event any
 * Matrix app understands; nothing here invents a format. Every command names its target by
 * room and event, and the target is re-read from this room's own timeline before anything is
 * sent: an id from another room, a local echo or a message that changed meanwhile is refused.
 */

/** The standard unread mark (Matrix 1.12) and the name apps used before it. */
export const MATRIX_MARKED_UNREAD = 'm.marked_unread'
export const MATRIX_MARKED_UNREAD_UNSTABLE = 'com.famedly.marked_unread'

/** How long the server shows "typing" after one notification, unless it is renewed. */
export const MATRIX_TYPING_TIMEOUT_MS = 30_000

declare module 'matrix-js-sdk' {
  interface RoomAccountDataEvents {
    'm.marked_unread': { unread: boolean }
    'com.famedly.marked_unread': { unread: boolean }
  }
}

/** A message of this room, as the server has it: never a local echo, an edit or a deleted one. */
function serverMessage(room: Room, eventId: string): MatrixEvent {
  const event = room.findEventById(eventId)

  if (
    !event ||
    !eventId.startsWith('$') ||
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

function eventId(response: { event_id?: unknown } | undefined): string {
  if (typeof response?.event_id !== 'string' || !response.event_id.startsWith('$')) {
    throw new Error('matrix_send_failed')
  }

  return response.event_id
}

/** A text message that answers one of this room's messages (`m.in_reply_to`). */
export async function sendMatrixReply(
  client: MatrixClient,
  room: Room,
  body: string,
  replyTo: string,
  mentions?: readonly string[],
  roomMention = false
) {
  serverMessage(room, replyTo)

  return eventId(
    await client.sendEvent(room.roomId, EventType.RoomMessage, {
      msgtype: MsgType.Text,
      body,
      'm.relates_to': { 'm.in_reply_to': { event_id: replyTo } },
      ...matrixMentions(mentions, roomMention)
    })
  )
}

/** A text message as sent: its words and, when it names anyone, standard intentional mentions
 * (`m.mentions.user_ids`). A message that names nobody carries no mentions at all. */
export function matrixMentions(mentions: readonly string[] | undefined, room = false) {
  const ids = [...new Set(mentions ?? [])]

  return ids.length || room ? { 'm.mentions': { user_ids: ids, ...(room ? { room: true } : {}) } } : {}
}

/** A new top-level text message, with its mentions when it names anyone. */
export async function sendMatrixText(
  client: MatrixClient,
  room: Room,
  body: string,
  mentions?: readonly string[],
  roomMention = false
) {
  return eventId(
    await client.sendEvent(room.roomId, EventType.RoomMessage, {
      msgtype: MsgType.Text,
      body,
      ...matrixMentions(mentions, roomMention)
    })
  )
}

/**
 * Your own text message, changed for everyone (`m.replace`). The replacement carries only
 * what the message shows: its markers and its reply stay on the message as first sent.
 */
export async function editMatrixMessage(client: MatrixClient, room: Room, target: string, body: string, options: { savedStatus?: 'saved_to_drive' | 'saved_as_copy'; transactionId?: string } = {}) {
  if (options.savedStatus && !room.findEventById(target)) {
    await client.getEventTimeline(room.getUnfilteredTimelineSet(), target)
  }

  const candidate = room.findEventById(target)

  if (options.savedStatus && candidate) {
    await client.decryptEventIfNeeded(candidate)
  }

  const event = serverMessage(room, target)
  const text = body.trim()

  if (event.getSender() !== client.getSafeUserId() || event.getOriginalContent().msgtype !== MsgType.Text || !text) {
    throw new Error('matrix_message_changed')
  }

  const original = event.getOriginalContent()
  const result = original['io.atum.result']

  if (options.savedStatus && (!['saved_to_drive', 'saved_as_copy'].includes(options.savedStatus) || result?.status !== 'save_unconfirmed')) {
    throw new Error('matrix_message_changed')
  }

  // m.new_content replaces the visible content only; relations stay on the original event.
  const { 'm.relates_to': _relation, ...visible } = original
  const content = options.savedStatus
    ? { ...visible, msgtype: MsgType.Text as const, body: text, 'io.atum.result': { ...result, status: options.savedStatus } }
    : { msgtype: MsgType.Text as const, body: text }

  return eventId(
    await client.sendEvent(room.roomId, EventType.RoomMessage, {
      msgtype: MsgType.Text,
      // What an app without edits shows: the standard fallback.
      body: `* ${text}`,
      'm.new_content': content,
      'm.relates_to': { rel_type: RelationType.Replace, event_id: target }
    }, ...(options.transactionId ? [options.transactionId] as const : [] as const))
  )
}

/** Your own message, deleted for everyone (a standard redaction). */
export async function redactMatrixMessage(client: MatrixClient, room: Room, target: string) {
  const event = room.findEventById(target)

  if (
    !event ||
    !target.startsWith('$') ||
    event.getId() !== target ||
    event.getRoomId() !== room.roomId ||
    event.status !== null ||
    event.getSender() !== client.getSafeUserId() ||
    event.isRedacted() ||
    event.isRelation(RelationType.Replace) ||
    (event.getType() !== EventType.RoomMessage && !event.isDecryptionFailure())
  ) {
    throw new Error('matrix_message_changed')
  }

  await client.redactEvent(room.roomId, target)
}

/** This account's live reactions with one key on one message (normally one; never trusted to be). */
function ownReactions(client: MatrixClient, room: Room, target: string, key: string): MatrixEvent[] {
  const own = client.getSafeUserId()

  const mine = room.relations
    .getChildEventsForEvent(target, RelationType.Annotation, EventType.Reaction)
    ?.getAnnotationsBySender()?.[own]

  return [...(mine ?? [])].filter(
    reaction =>
      reaction.getRelation()?.key === key &&
      !reaction.isRedacted() &&
      !reaction.localRedactionEvent() &&
      reaction.status !== EventStatus.CANCELLED
  )
}

/**
 * Your reaction to a message (`m.annotation`): added once, or taken back. Taking it back
 * removes every reaction of yours with that key, so a double tap anywhere never leaves two.
 */
export async function reactToMatrixMessage(
  client: MatrixClient,
  room: Room,
  target: string,
  key: string,
  reacted: boolean
) {
  serverMessage(room, target)
  const existing = ownReactions(client, room, target, key)

  if (reacted) {
    if (existing.length === 0) {
      await client.sendEvent(room.roomId, EventType.Reaction, {
        'm.relates_to': { rel_type: RelationType.Annotation, event_id: target, key }
      })
    }

    return
  }

  for (const reaction of existing) {
    if (reaction.status === EventStatus.NOT_SENT || reaction.status === EventStatus.QUEUED) {
      client.cancelPendingEvent(reaction)
    } else if (reaction.status === null && reaction.getId()?.startsWith('$')) {
      await client.redactEvent(room.roomId, reaction.getId()!)
    }
  }
}

/** Who is typing in this chat now: never you, never someone you ignore. */
export function matrixTyping(room: Room, ownUserId: string, ignored: ReadonlySet<string>): string[] {
  return room
    .getMembers()
    .filter(member => member.typing && member.membership === 'join' && member.userId !== ownUserId && !ignored.has(member.userId))
    .map(member => member.userId)
}

/** Tell the chat you are typing, or stopped. Never in an assistant's room: nobody reads it there. */
export async function sendMatrixTyping(client: MatrixClient, room: Room, typing: boolean) {
  if (room.getType() === MATRIX_ASSISTANT_ROOM_TYPE || room.getMyMembership() !== 'join') {
    return
  }

  await client.sendTyping(room.roomId, typing, MATRIX_TYPING_TIMEOUT_MS)
}

/** The chat's unread mark: the standard name first, else the one apps used before it. */
export function matrixMarkedUnread(room: Room): boolean {
  const stable = room.getAccountData(MATRIX_MARKED_UNREAD)?.getContent()

  if (stable && typeof stable.unread === 'boolean') {
    return stable.unread
  }

  return room.getAccountData(MATRIX_MARKED_UNREAD_UNSTABLE)?.getContent()?.unread === true
}

/**
 * Mark a chat unread, or read. Read clears the mark under both names (an app reading only the
 * older one would keep it unread). `acknowledge` (Mark as read) also acknowledges the newest
 * message privately, so its unread count clears on every device without changing what other
 * people see; a chat opened on screen leaves that to the read receipts (read-receipts.ts).
 */
export async function markMatrixRoomUnread(
  client: MatrixClient,
  room: Room,
  unread: boolean,
  { acknowledge = true }: { acknowledge?: boolean } = {}
) {
  if (unread) {
    await client.setRoomAccountData(room.roomId, MATRIX_MARKED_UNREAD, { unread: true })

    return
  }

  if (room.getAccountData(MATRIX_MARKED_UNREAD)?.getContent()?.unread === true) {
    await client.setRoomAccountData(room.roomId, MATRIX_MARKED_UNREAD, { unread: false })
  }

  if (room.getAccountData(MATRIX_MARKED_UNREAD_UNSTABLE)?.getContent()?.unread === true) {
    await client.setRoomAccountData(room.roomId, MATRIX_MARKED_UNREAD_UNSTABLE, { unread: false })
  }

  const latest = acknowledge ? latestSettledEvent(room)?.getId() : undefined

  if (latest && !readThrough(room, client.getSafeUserId(), latest)) {
    await client.setRoomReadMarkersHttpRequest(room.roomId, latest, undefined, latest)
  }
}
