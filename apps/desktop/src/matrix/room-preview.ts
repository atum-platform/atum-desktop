import { EventType, type MatrixEvent, MsgType, RelationType, type Room } from 'matrix-js-sdk'

import { MATRIX_ROOM_PREVIEW_MAX, type MatrixRoomPreview } from '../../shared/matrix'
import { matrixProgressMarker } from '../../shared/matrix-progress-marker'

import { shownContent } from './message'
import { isOpaqueMatrixId, matrixPersonName } from './person-name'
import { matrixRoomTimelineEvents } from './threads'

/**
 * What a chat's row in the chat list says about it (launch night, Element's room list): the
 * latest message as one line, and whether messages from others wait unread. Both read only
 * the live timeline the SDK already holds; neither is ever an authority for anything.
 */

/** How far back a row looks for its latest message, or for what is still unread. */
const LOOK_BACK = 60

/** A sender's name in a preview, at most. */
const SENDER_MAX = 48

const MEDIA: Partial<Record<string, MatrixRoomPreview['kind']>> = {
  [MsgType.Image]: 'image',
  [MsgType.Video]: 'video',
  [MsgType.Audio]: 'audio'
}

function bounded(text: string, max: number): string {
  const chars = [...text]

  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`
}

/** A reply's quoted fallback (`> <@who> what they said`, then a blank line) is not its words. */
function withoutReplyFallback(body: string): string {
  const lines = body.split('\n')
  let start = 0

  while (start < lines.length && lines[start]!.startsWith('>')) {
    start++
  }

  return start > 0 && start < lines.length && !lines[start]!.trim() ? lines.slice(start + 1).join('\n') : body
}

/**
 * One line of a message as it reads, without its markdown: an assistant's answer previews as
 * its words, never as `**`, `#`, list bullets, link syntax or code fences.
 */
export function matrixPreviewLine(body: string, max = MATRIX_ROOM_PREVIEW_MAX): string {
  const lines = body
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    // A code fence's markers say nothing; a table's divider row neither.
    .filter(line => !/^\s*(?:```|~~~)/u.test(line) && !/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/u.test(line))
    .map(line =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/u, '')
        .replace(/^\s*(?:>\s?)+/u, '')
        .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?/u, '')
        .replace(/\|/gu, ' ')
    )

  const line = lines
    .join(' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/<(https?:\/\/[^>\s]+)>/gu, '$1')
    .replace(/<\/?[a-z][^>]*>/giu, ' ')
    .replace(/(\*\*|__|~~)(\S(?:.*?\S)?)\1/gu, '$2')
    .replace(/(^|[^\p{L}\p{N}*])\*(\S(?:[^*]*?\S)?)\*(?![\p{L}\p{N}*])/gu, '$1$2')
    .replace(/`+([^`]+)`+/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim()

  return bounded(line, max)
}

/** The name a room knows a person by, an early readable ID's handle part when they never
 * set one, else nothing (the row then shows the message alone): never an ID (ledger AC8). */
function senderName(room: Room, userId: string): string | undefined {
  const name = matrixPersonName(room.getMember(userId)?.name, userId)
  const known = name ?? (isOpaqueMatrixId(userId) ? undefined : /^@([^:]+):/u.exec(userId)?.[1])

  return known ? bounded(known, SENDER_MAX) : undefined
}

/** An event a person sees as a message: a room message, a sticker, or one not decrypted (yet,
 * or once deleted, when an encrypted event no longer says what it was). Decrypted, an event
 * is what it says it is: a reaction or a call event is never a message. */
function messageLike(event: MatrixEvent): boolean {
  const type = event.getType()

  return type === EventType.RoomMessage || type === EventType.Sticker || type === EventType.RoomMessageEncrypted
}

function previewOf(
  event: MatrixEvent,
  room: Room,
  ownUserId: string,
  ignored: ReadonlySet<string>
): MatrixRoomPreview | null {
  const sender = event.getSender()

  // An edit is not a message of its own (the message it changes shows its words), and a
  // reaction only decorates one.
  if (!sender || ignored.has(sender) || event.isRelation(RelationType.Replace) || !messageLike(event)) {
    return null
  }

  const own = sender === ownUserId
  const name = own ? undefined : senderName(room, sender)
  const base = { own, ...(name ? { sender: name } : {}), at: event.getTs() }

  if (event.isRedacted() || event.localRedactionEvent()) {
    return { ...base, kind: 'deleted' }
  }

  // Not decrypted (yet): Element says "Waiting for this message"; the row says the same.
  if (event.isDecryptionFailure() || event.getType() === EventType.RoomMessageEncrypted) {
    return { ...base, kind: 'unreadable' }
  }

  if (event.getType() === EventType.Sticker) {
    return { ...base, kind: 'sticker' }
  }

  const { content } = shownContent(event)

  // The agent's one progress line (agent-turns/1.3) is never a chat's preview: the row keeps the
  // last message until the answer arrives.
  if (!own && matrixProgressMarker(content)) {
    return null
  }

  const body = typeof content.body === 'string' ? content.body : ''
  // A photo's or a recording's body is a file name nobody chose: the row names what it is.
  const media = typeof content.msgtype === 'string' ? MEDIA[content.msgtype] : undefined

  if (media) {
    return { ...base, kind: media }
  }

  if (content.msgtype === MsgType.File) {
    const name = matrixPreviewLine(body)

    return { ...base, kind: 'file', ...(name ? { text: name } : {}) }
  }

  const relation = event.getOriginalContent()['m.relates_to'] as { 'm.in_reply_to'?: unknown } | undefined
  const text = matrixPreviewLine(relation?.['m.in_reply_to'] ? withoutReplyFallback(body) : body)

  // A message with no words (an empty body) says nothing worth a row's line.
  return text ? { ...base, kind: 'text', text } : null
}

/** The latest message a person would see in this chat, as its row previews it. */
export function matrixRoomPreview(
  room: Room,
  ownUserId: string,
  ignored: ReadonlySet<string> = new Set(),
  events: MatrixEvent[] = matrixRoomTimelineEvents(room)
): MatrixRoomPreview | undefined {
  for (let index = events.length - 1; index >= Math.max(0, events.length - LOOK_BACK); index--) {
    const preview = previewOf(events[index]!, room, ownUserId, ignored)

    if (preview) {
      return preview
    }
  }

  return undefined
}

/**
 * Whether anyone has spoken in this chat, from the history this device holds: `started` as soon as
 * any message of either side is there (an answer this device cannot read yet included, a deleted
 * one too, an edit or a reply to one nobody can see), `none` only when the loaded history begins at
 * the room's creation and holds no message, and nothing when the loaded part cannot say (the
 * rest of a long history is not here). The first run asks it once to tell a new account from
 * one that already talks to its assistant; "cannot say" is never read as "new".
 */
export function matrixRoomDialogue(
  room: Room,
  events: MatrixEvent[] = matrixRoomTimelineEvents(room)
): 'started' | 'none' | undefined {
  if (events.some(messageLike)) {
    return 'started'
  }

  return events[0]?.getType() === EventType.RoomCreate ? 'none' : undefined
}

/**
 * Messages from others wait unread, whether or not they notified (Element's "activity": a
 * muted chat still has some). The newest event this account has read — its receipt, public or
 * private, or something it sent after — settles it; anything newer from someone else that a
 * person would see as a message makes the chat unread.
 */
export function matrixRoomUnread(
  room: Room,
  ownUserId: string,
  ignored: ReadonlySet<string> = new Set(),
  events: MatrixEvent[] = matrixRoomTimelineEvents(room)
): boolean {
  for (let index = events.length - 1; index >= Math.max(0, events.length - LOOK_BACK); index--) {
    const event = events[index]!
    const id = event.getId()

    if (id && room.hasUserReadEvent(ownUserId, id)) {
      return false
    }

    const sender = event.getSender()

    if (
      sender &&
      sender !== ownUserId &&
      !ignored.has(sender) &&
      messageLike(event) &&
      !event.isRelation(RelationType.Replace) &&
      !event.isRedacted()
    ) {
      return true
    }
  }

  return false
}
