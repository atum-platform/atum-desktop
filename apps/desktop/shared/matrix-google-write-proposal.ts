/**
 * Google write confirmation (`atum.google-write-confirmation/1`, docs/google-write-confirmation.md).
 *
 * A Google write (send an email, add or change a calendar event, change a Drive file) is authorised
 * only by the owner's explicit Approve on a native card that renders Shell's canonical draft. The
 * room's agent posts the proposal as its own timeline event type, never as a chat message, so a
 * client that does not know the type shows nothing and nothing can be approved there. Later, the
 * agent posts one outcome event per terminal transition so every device shows the same end.
 *
 * The card authorises exactly what it shows: parsing is strict (exact keys, no extra field is
 * carried), every field of the parsed draft is rendered, and Approve sends the digest of that
 * parsed draft. A draft whose digest differs from the one the proposal names is never offered.
 */
import { canonicalJson } from '../../../packages/device-protocol/canonical'

export const MATRIX_GOOGLE_WRITE_PROPOSAL_TYPE = 'io.atum.google.write_proposal'
export const MATRIX_GOOGLE_WRITE_OUTCOME_TYPE = 'io.atum.google.write_outcome'
export const MATRIX_GOOGLE_WRITE_PROFILE = 'atum.google-write-confirmation/1'

export interface MatrixGoogleWriteAttachment {
  /** The file's name as it will be attached. */
  name: string
}

export interface MatrixGoogleWriteEmail {
  kind: 'send_email'
  /** The connected Google account that sends. */
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  /** Plain text, shown exactly (line breaks kept, never rendered as markdown). */
  body: string
  attachments: MatrixGoogleWriteAttachment[]
  /** Sent as a reply inside an existing Gmail conversation. */
  inReplyTo: boolean
}

/** Google Calendar's own time shape: an instant with its zone, or an all-day date. */
export type MatrixGoogleWriteWhen = { dateTime: string; timeZone: string } | { date: string }

export interface MatrixGoogleWriteEventFields {
  title: string
  start: MatrixGoogleWriteWhen
  end: MatrixGoogleWriteWhen
  location: string
  notes: string
  /** Guests' addresses. Empty for an event of the owner's own. */
  attendees: string[]
}

export interface MatrixGoogleWriteCreateEvent {
  kind: 'create_event'
  calendar: string
  event: MatrixGoogleWriteEventFields
}

export interface MatrixGoogleWriteUpdateEvent {
  kind: 'update_event'
  calendar: string
  current: MatrixGoogleWriteEventFields
  next: MatrixGoogleWriteEventFields
}

export interface MatrixGoogleWriteDriveChange {
  kind: 'drive_change'
  action: 'create' | 'update'
  /** The file's name in Drive. */
  name: string
  /** Where it lives, as Shell names it for the owner (a folder path). */
  folder: string
  /** Shell's exact text of what will be written. */
  content: string
}

export type MatrixGoogleWriteDraft =
  | MatrixGoogleWriteEmail
  | MatrixGoogleWriteCreateEvent
  | MatrixGoogleWriteUpdateEvent
  | MatrixGoogleWriteDriveChange

export interface MatrixGoogleWriteProposal {
  proposalId: string
  /** `sha256:` and 64 lowercase hex: SHA-256 of the draft's canonical JSON. */
  digest: string
  /** Milliseconds since the epoch; Shell refuses the proposal after it. */
  expiresAt: number
  draft: MatrixGoogleWriteDraft
}

/** A terminal state the agent reports for a proposal (the outcome event). */
export type MatrixGoogleWriteOutcomeState = 'done' | 'approved' | 'declined' | 'superseded' | 'expired' | 'failed'

export interface MatrixGoogleWriteOutcome {
  proposalId: string
  state: MatrixGoogleWriteOutcomeState
}

export type MatrixGoogleWriteDecision = 'approve' | 'decline'

/** What the card sends: the proposal it shows and the digest of what it rendered. */
export interface MatrixGoogleWriteDecisionInput {
  proposalId: string
  digest: string
  decision: MatrixGoogleWriteDecision
}

/**
 * Shell's answer, closed. Only `done` and `approved` follow an approval; anything Shell did not
 * positively answer is `retry` (the same request may be sent again: it carries the same
 * idempotency key, so Shell returns its saved answer and never writes twice).
 */
export type MatrixGoogleWriteAnswer =
  | 'done'
  | 'approved'
  | 'declined'
  | 'superseded'
  | 'expired'
  | 'changed'
  | 'answered'
  | 'failed'
  | 'retry'

/** The card as the transcript knows it before the owner acts on this device. */
export type MatrixGoogleWriteStanding = 'open' | 'superseded' | MatrixGoogleWriteOutcomeState

const PROPOSAL_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const ADDRESS = /^[^\s@,<>]{1,200}@[^\s@,<>]{1,200}$/u
const DATE = /^\d{4}-\d{2}-\d{2}$/u
// RFC 3339 with an explicit offset; Shell sends the instant it will write.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u
const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/u
const EVENT_ID = /^\$[^\s]{1,254}$/u
// In unicode mode a paired surrogate is one code point, so this matches only a lone one.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u
const OUTCOMES = new Set<string>(['done', 'approved', 'declined', 'superseded', 'expired', 'failed'])

/** A Matrix event is at most 64 KiB; nothing longer can arrive in one. */
const TEXT_MAX = 60_000
const LINE_MAX = 1_000
const LIST_MAX = 100

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)

  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

/** Lone surrogates cannot be digested canonically, so they are not a draft. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length > max || LONE_SURROGATE.test(value)) {
    return undefined
  }

  // The digest is over NFC text; the card shows that same text.
  return value.normalize('NFC')
}

function line(value: unknown): string | undefined {
  const shown = text(value, LINE_MAX)

  return shown !== undefined && !/[\r\n]/u.test(shown) ? shown : undefined
}

function addresses(value: unknown, min = 0): string[] | undefined {
  if (!Array.isArray(value) || value.length < min || value.length > LIST_MAX) {
    return undefined
  }

  const out: string[] = []

  for (const item of value) {
    const address = text(item, 401)

    if (address === undefined || !ADDRESS.test(address)) {
      return undefined
    }

    out.push(address)
  }

  return out
}

function validDate(value: string): boolean {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`)

  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10)
}

function when(value: unknown): MatrixGoogleWriteWhen | undefined {
  if (!record(value)) {
    return undefined
  }

  if (exactKeys(value, ['date'])) {
    return typeof value.date === 'string' && DATE.test(value.date) && validDate(value.date)
      ? { date: value.date }
      : undefined
  }

  if (
    exactKeys(value, ['dateTime', 'timeZone']) &&
    typeof value.dateTime === 'string' &&
    DATE_TIME.test(value.dateTime) &&
    validDate(value.dateTime) &&
    !Number.isNaN(Date.parse(value.dateTime)) &&
    typeof value.timeZone === 'string' &&
    TIME_ZONE.test(value.timeZone)
  ) {
    return { dateTime: value.dateTime, timeZone: value.timeZone }
  }

  return undefined
}

function eventFields(value: unknown): MatrixGoogleWriteEventFields | undefined {
  if (!record(value) || !exactKeys(value, ['title', 'start', 'end', 'location', 'notes', 'attendees'])) {
    return undefined
  }

  const title = line(value.title)
  const start = when(value.start)
  const end = when(value.end)
  const location = line(value.location)
  const notes = text(value.notes, TEXT_MAX)
  const attendees = addresses(value.attendees)

  if (
    !title?.trim() ||
    !start ||
    !end ||
    'date' in start !== 'date' in end ||
    location === undefined ||
    notes === undefined ||
    !attendees
  ) {
    return undefined
  }

  return { title, start, end, location, notes, attendees }
}

function attachments(value: unknown): MatrixGoogleWriteAttachment[] | undefined {
  if (!Array.isArray(value) || value.length > LIST_MAX) {
    return undefined
  }

  const out: MatrixGoogleWriteAttachment[] = []

  for (const item of value) {
    const name = record(item) && exactKeys(item, ['name']) ? line(item.name) : undefined

    if (!name?.trim()) {
      return undefined
    }

    out.push({ name })
  }

  return out
}

function draft(value: unknown): MatrixGoogleWriteDraft | undefined {
  if (!record(value)) {
    return undefined
  }

  if (value.kind === 'send_email') {
    if (!exactKeys(value, ['kind', 'from', 'to', 'cc', 'bcc', 'subject', 'body', 'attachments', 'inReplyTo'])) {
      return undefined
    }

    const from = addresses([value.from])?.[0]
    const to = addresses(value.to, 1)
    const cc = addresses(value.cc)
    const bcc = addresses(value.bcc)
    const subject = line(value.subject)
    const body = text(value.body, TEXT_MAX)
    const files = attachments(value.attachments)

    return from && to && cc && bcc && subject !== undefined && body !== undefined && files &&
      typeof value.inReplyTo === 'boolean'
      ? { kind: 'send_email', from, to, cc, bcc, subject, body, attachments: files, inReplyTo: value.inReplyTo }
      : undefined
  }

  if (value.kind === 'create_event') {
    if (!exactKeys(value, ['kind', 'calendar', 'event'])) {
      return undefined
    }

    const calendar = line(value.calendar)
    const event = eventFields(value.event)

    return calendar?.trim() && event ? { kind: 'create_event', calendar, event } : undefined
  }

  if (value.kind === 'update_event') {
    if (!exactKeys(value, ['kind', 'calendar', 'current', 'next'])) {
      return undefined
    }

    const calendar = line(value.calendar)
    const current = eventFields(value.current)
    const next = eventFields(value.next)

    return calendar?.trim() && current && next ? { kind: 'update_event', calendar, current, next } : undefined
  }

  if (value.kind === 'drive_change') {
    if (!exactKeys(value, ['kind', 'action', 'name', 'folder', 'content'])) {
      return undefined
    }

    const name = line(value.name)
    const folder = line(value.folder)
    const content = text(value.content, TEXT_MAX)

    return (value.action === 'create' || value.action === 'update') && name?.trim() && folder !== undefined &&
      content !== undefined
      ? { kind: 'drive_change', action: value.action, name, folder, content }
      : undefined
  }

  return undefined
}

/** The proposal in an `io.atum.google.write_proposal` event's content, or undefined for anything else. */
export function parseMatrixGoogleWriteProposal(content: unknown): MatrixGoogleWriteProposal | undefined {
  if (!record(content) || !exactKeys(content, ['version', 'proposalId', 'digest', 'expiresAt', 'draft'])) {
    return undefined
  }

  const parsed = draft(content.draft)

  if (
    content.version !== 1 ||
    typeof content.proposalId !== 'string' ||
    !PROPOSAL_ID.test(content.proposalId) ||
    typeof content.digest !== 'string' ||
    !DIGEST.test(content.digest) ||
    !Number.isSafeInteger(content.expiresAt) ||
    Number(content.expiresAt) <= 0 ||
    !parsed
  ) {
    return undefined
  }

  return { proposalId: content.proposalId, digest: content.digest, expiresAt: Number(content.expiresAt), draft: parsed }
}

/** The outcome in an `io.atum.google.write_outcome` event's content, or undefined for anything else. */
export function parseMatrixGoogleWriteOutcome(content: unknown): MatrixGoogleWriteOutcome | undefined {
  if (!record(content)) {
    return undefined
  }

  const keys = ['version', 'proposalId', 'state']
  const related = Object.hasOwn(content, 'm.relates_to')

  if (!exactKeys(content, related ? [...keys, 'm.relates_to'] : keys)) {
    return undefined
  }

  if (related) {
    const relation = content['m.relates_to']

    if (
      !record(relation) ||
      !exactKeys(relation, ['rel_type', 'event_id']) ||
      relation.rel_type !== 'm.reference' ||
      typeof relation.event_id !== 'string' ||
      !EVENT_ID.test(relation.event_id)
    ) {
      return undefined
    }
  }

  return content.version === 1 &&
    typeof content.proposalId === 'string' &&
    PROPOSAL_ID.test(content.proposalId) &&
    typeof content.state === 'string' &&
    OUTCOMES.has(content.state)
    ? { proposalId: content.proposalId, state: content.state as MatrixGoogleWriteOutcomeState }
    : undefined
}

/** `sha256:` + lowercase hex SHA-256 of the draft's canonical JSON (the platform's `canonicalJson`). */
export async function matrixGoogleWriteDigest(value: MatrixGoogleWriteDraft): Promise<string> {
  const bytes = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)))
  )

  return `sha256:${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
}

/** The decision request's own shape, as main re-reads it from the window. */
export function parseMatrixGoogleWriteDecisionInput(value: unknown): MatrixGoogleWriteDecisionInput | undefined {
  return record(value) &&
    exactKeys(value, ['proposalId', 'digest', 'decision']) &&
    typeof value.proposalId === 'string' &&
    PROPOSAL_ID.test(value.proposalId) &&
    typeof value.digest === 'string' &&
    DIGEST.test(value.digest) &&
    (value.decision === 'approve' || value.decision === 'decline')
    ? { proposalId: value.proposalId, digest: value.digest, decision: value.decision }
    : undefined
}

interface FoldLine {
  sender: string
  own: boolean
  googleWrite?: { proposal: MatrixGoogleWriteProposal; standing: MatrixGoogleWriteStanding }
  googleWriteOutcome?: MatrixGoogleWriteOutcome
}

/**
 * What a transcript shows of Google write proposals. Only a room agent's proposal is a card; each
 * agent has at most one open card, its latest, and every earlier one reads superseded. An outcome
 * is never a row: it settles the same agent's proposal it names. Anything else carrying either
 * shape shows nothing. Order is kept.
 */
export function matrixFoldGoogleWriteProposals<T extends FoldLine>(
  messages: readonly T[],
  agents: ReadonlySet<string>
): T[] {
  if (!messages.some(message => message.googleWrite || message.googleWriteOutcome)) {
    return [...messages]
  }

  const admitted = (message: T) => !message.own && agents.has(message.sender)
  const outcomes = new Map<string, MatrixGoogleWriteOutcomeState>()
  const latest = new Map<string, string>()

  for (const message of messages) {
    if (message.googleWriteOutcome && admitted(message)) {
      outcomes.set(`${message.sender}\n${message.googleWriteOutcome.proposalId}`, message.googleWriteOutcome.state)
    }

    if (message.googleWrite && admitted(message)) {
      latest.set(message.sender, message.googleWrite.proposal.proposalId)
    }
  }

  return messages.flatMap(message => {
    if (message.googleWriteOutcome) {
      return []
    }

    if (!message.googleWrite) {
      return [message]
    }

    if (!admitted(message)) {
      return []
    }

    const id = message.googleWrite.proposal.proposalId
    const settled = outcomes.get(`${message.sender}\n${id}`)
    const standing: MatrixGoogleWriteStanding = settled ?? (latest.get(message.sender) === id ? 'open' : 'superseded')

    return [{ ...message, googleWrite: { ...message.googleWrite, standing } }]
  })
}
