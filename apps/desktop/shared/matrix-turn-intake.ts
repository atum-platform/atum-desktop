import { matrixAttachmentMsgtype, MATRIX_TURN_QUOTE_MAX, matrixRoomTextTooLong } from './matrix'
import { MATRIX_TURN_KEY } from './matrix-turn'

/**
 * What may start an assistant's turn in its room (the agent-room contract,
 *  §2.1; the cloud brain keeps the same rules).
 *
 * Only a new top-level message from the owner starts a turn: a text, or a file. Everything
 * Matrix lets a person do *to* a message is append-only bookkeeping and never a turn, and is
 * never re-run: an edit (`m.replace`), a reaction (`m.annotation`), a redaction, a message
 * that was deleted, and anything inside a thread (assistant rooms have no threads). A reply
 * (`m.in_reply_to`) is a new message: its turn carries the quoted message as context
 * (`replyTo`). Both desktop paths carry it — a typed reply its quote, a reply from another
 * device the quote main reads again (electron/matrix/invocation.ts) — and a reply whose
 * quote cannot be carried (not readable, not checked) is refused instead of answering half
 * the question. A reply counts only when the ciphertext itself names the message it answers:
 * a reply relation found only in the clear, which the server could have added, is refused.
 *
 * Classification only: the caller still checks the sender, the room, device trust and
 * freshness, and main re-reads every candidate before anything runs.
 */
export type MatrixTurnIntake =
  | { turn: true; replyTo?: string }
  | { turn: false; reason: MatrixTurnIntakeRefusal }

export type MatrixTurnIntakeRefusal =
  | 'not_message'
  | 'reaction'
  | 'redaction'
  | 'redacted'
  | 'edit'
  | 'thread'
  | 'relation'
  | 'not_text'
  | 'marker'

export interface MatrixTurnIntakeEvent {
  /** The event's own type, decrypted (`m.room.message`, `m.reaction`, …). */
  type: string
  /** Its decrypted content as first sent: never an edit's replacement text. */
  content: Record<string, unknown>
  /** The clear-text relation an encrypted event carries outside its ciphertext, if any. */
  wireRelation?: unknown
  redacted: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** A plain rich reply: `{ "m.in_reply_to": { "event_id": "$…" } }` and nothing else. */
function pureReply(relation: Record<string, unknown>): string | undefined {
  const keys = Object.keys(relation)
  const reply = record(relation['m.in_reply_to'])
  const eventId = reply?.event_id

  return keys.length === 1 &&
    keys[0] === 'm.in_reply_to' &&
    typeof eventId === 'string' &&
    eventId.startsWith('$') &&
    eventId.length <= 1024
    ? eventId
    : undefined
}

export function matrixTurnIntake(event: MatrixTurnIntakeEvent): MatrixTurnIntake {
  if (event.type === 'm.reaction') {
    return { turn: false, reason: 'reaction' }
  }

  if (event.type === 'm.room.redaction') {
    return { turn: false, reason: 'redaction' }
  }

  if (event.type !== 'm.room.message') {
    return { turn: false, reason: 'not_message' }
  }

  if (event.redacted) {
    return { turn: false, reason: 'redacted' }
  }

  // The relation an encrypted event shows the server, else the one inside it. Either one
  // being something other than a plain reply refuses the event: a client cannot hide an
  // edit or a thread inside the ciphertext behind a harmless clear-text relation.
  const relations = [event.wireRelation, event.content['m.relates_to']].filter(value => value !== undefined)
  let replyTo: string | undefined

  for (const value of relations) {
    const relation = record(value)
    const type = relation?.rel_type

    if (type === 'm.replace') {
      return { turn: false, reason: 'edit' }
    }

    if (type === 'm.annotation') {
      return { turn: false, reason: 'reaction' }
    }

    if (type === 'm.thread') {
      return { turn: false, reason: 'thread' }
    }

    const reply = relation ? pureReply(relation) : undefined

    if (!reply || (replyTo !== undefined && reply !== replyTo)) {
      return { turn: false, reason: 'relation' }
    }

    replyTo = reply
  }

  // Current clients (Rust crypto) keep a reply's relation inside the ciphertext as well as in
  // the clear. Only in the clear, it is not the sender's: the server could have turned a plain
  // "yes, go ahead" into a reply to a message of its choosing.
  if (replyTo !== undefined && event.content['m.relates_to'] === undefined) {
    return { turn: false, reason: 'relation' }
  }

  const { body, msgtype } = event.content
  // A file or image names its media in `file` when encrypted, or in `url` when sent in a room without
  // encryption. The reader still takes `url` only from such a room (read-invocation.ts).
  const media = Boolean(event.content.file) || typeof event.content.url === 'string'

  if (
    !(msgtype === 'm.text' || (matrixAttachmentMsgtype(msgtype) && media)) ||
    typeof body !== 'string' ||
    !body.length ||
    matrixRoomTextTooLong(body)
  ) {
    return { turn: false, reason: 'not_text' }
  }

  // A local-path question already ran on the Mac that sent it (the fence, invocation.ts).
  if (event.content[MATRIX_TURN_KEY] !== undefined) {
    return { turn: false, reason: 'marker' }
  }

  return replyTo ? { turn: true, replyTo } : { turn: true }
}

/** A rich reply's own words: its body without the quoted fallback older clients put first —
 * the spec's shape only: a first line `> <@user:server> …` (`> * <@user:server> …` for an
 * emote), more `> ` lines, then a blank line. A blockquote anyone wrote themselves (a
 * person's `> rule` line, an assistant's Markdown quote) is their words and stays.
 * Presentation, not the message; the caller decides what an empty remainder means. */
export function matrixReplyWords(body: string): string {
  return body.replace(/^> (?:\* )?<@[^\s>]+>[^\n]*\n(?:>[^\n]*\n)*\n/, '')
}

/** A reply's quote as the assistant receives it: the message's words, trimmed and bounded the
 * way main measures them (UTF-16 length), never cut through a character. */
export function matrixTurnQuote(body: string): string {
  const words = body.trim()
  const cut = words.slice(0, MATRIX_TURN_QUOTE_MAX)

  return cut.length < words.length && /[\uD800-\uDBFF]$/u.test(cut) ? cut.slice(0, -1) : cut
}
