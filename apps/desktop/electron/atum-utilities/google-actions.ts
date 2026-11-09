import { buildMimeMessage, messageUpload, resolveCompose } from '../../shared/gmail-compose'
import { type GmailApi, GmailMailError } from '../../shared/gmail-mail'
import { type MatrixGoogleComposeFields, parseMatrixGoogleToolRequest } from '../../shared/matrix-google-tool-request'

import { UtilityFailure } from './google'

const GOOGLE_CALENDAR = 'https://www.googleapis.com/calendar/v3'
const GOOGLE_GMAIL_UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me'
const MAX_RESPONSE_BYTES = 16 * 1024
const MAX_EVENT_DURATION_MS = 31 * 24 * 60 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EVENT_ID = /^[a-z0-9_-]{1,1024}$/i
const THREAD_ID = /^[a-zA-Z0-9_-]{1,200}$/
const MESSAGE_ID = /^<[^<>\s]{3,900}>$/
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
const OFFSET_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/

export interface GoogleEmailAction extends MatrixGoogleComposeFields {
  action: 'send-email'
  operationId: string
  sourceId: string
  /** Empty only for a `reply`, whose recipients come from the message it answers. */
  to: string[]
  /** Empty only for a `reply` or `forward`, which derive it. */
  subject: string
  body: string
  /** A hand-written reply stays in its Gmail conversation: the thread and the message it answers. */
  threadId?: string
  inReplyTo?: string
}

interface GoogleCalendarFields {
  title: string
  start: string
  end: string
  location?: string
  description?: string
}

export interface GoogleCalendarCreateAction extends GoogleCalendarFields {
  action: 'create-event'
  operationId: string
  sourceId: string
}

export interface GoogleCalendarUpdateAction extends GoogleCalendarFields {
  action: 'update-event'
  operationId: string
  sourceId: string
  id: string
}

export type GoogleUtilityWrite = GoogleEmailAction | GoogleCalendarCreateAction | GoogleCalendarUpdateAction

export interface GoogleEventSnapshot {
  id: string
  title: string
  start: string
  end: string
  location?: string
  description?: string
  allDay: false
  revision: string
}

export interface GoogleWriteReceipt {
  action: GoogleUtilityWrite['action']
  id: string
  revision?: string
}

function invalid(): never { throw new UtilityFailure('invalid_input') }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)

    if (code >= 0xD800 && code <= 0xDBFF) {
      if (++index >= value.length || value.charCodeAt(index) < 0xDC00 || value.charCodeAt(index) > 0xDFFF) { return true }
    } else if (code >= 0xDC00 && code <= 0xDFFF) { return true }
  }

  return false
}

function validText(value: unknown, maximum: number, singleLine = false): value is string {
  if (typeof value !== 'string' || value.length > maximum || hasUnpairedSurrogate(value)) { return false }

  // Body/description may contain ordinary text whitespace.  Header-like values
  // are stricter so they cannot become a new MIME or HTTP header line.
  return !Array.from(value).some(character => {
    const code = character.charCodeAt(0)

    return code === 127 || (code < 32 && (singleLine || ![9, 10, 13].includes(code)))
  })
}

function requiredText(value: unknown, maximum: number, singleLine = false): string {
  if (!validText(value, maximum, singleLine) || value.length === 0) { invalid() }

  return value
}

/** Parses an RFC 3339 instant without accepting JavaScript's permissive date forms. */
function normalizedInstant(value: unknown): string {
  if (typeof value !== 'string') { invalid() }
  const matched = OFFSET_DATE_TIME.exec(value)

  if (!matched) { invalid() }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, millisecondsText = '', offset] = matched
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const milliseconds = Number(millisecondsText.padEnd(3, '0'))

  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59 || milliseconds > 999) { invalid() }

  // Validate the calendar date before applying the UTC offset; Date.parse()
  // otherwise silently turns dates such as February 31 into March.
  if (Date.UTC(year, month - 1, day, hour, minute, second, milliseconds) !== Date.UTC(year, month - 1, day, hour, minute, second, milliseconds)
    || new Date(Date.UTC(year, month - 1, day)).getUTCFullYear() !== year
    || new Date(Date.UTC(year, month - 1, day)).getUTCMonth() !== month - 1
    || new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) { invalid() }

  if (offset !== 'Z') {
    const [offsetHour, offsetMinute] = offset.slice(1).split(':').map(Number)

    if (offsetHour > 23 || offsetMinute > 59) { invalid() }
  }

  const result = new Date(value)

  if (!Number.isFinite(result.getTime())) { invalid() }

  return result.toISOString()
}

function parseCalendarFields(input: Record<string, unknown>): GoogleCalendarFields {
  const start = normalizedInstant(input.start)
  const end = normalizedInstant(input.end)

  if (new Date(end).getTime() <= new Date(start).getTime() || new Date(end).getTime() - new Date(start).getTime() > MAX_EVENT_DURATION_MS) { invalid() }

  const fields: GoogleCalendarFields = {
    title: requiredText(input.title, 500), start, end
  }

  if (input.location !== undefined) {
    if (!validText(input.location, 1000)) { invalid() }
    fields.location = input.location
  }

  if (input.description !== undefined) {
    if (!validText(input.description, 20_000)) { invalid() }
    fields.description = input.description
  }

  return fields
}

/**
 * The broker receives only this closed, attachment-free action grammar.  An
 * unexpected field is an error so later provider features cannot be silently
 * ignored by a caller that thought it had asked for them.
 */
export function parseUtilityWrite(input: unknown): GoogleUtilityWrite {
  if (!isRecord(input) || typeof input.action !== 'string') { invalid() }
  const operationId = requiredText(input.operationId, 36, true)
  const sourceId = requiredText(input.sourceId, 500, true)

  if (!UUID.test(operationId)) { invalid() }

  if (input.action === 'send-email') {
    // The shape (cc/bcc, reply, forward, attachments, limits, unknown fields) is the broker's one closed grammar.
    const { action: _action, operationId: _operationId, ...rest } = input
    const parsed = parseMatrixGoogleToolRequest({ ...rest, action: 'send_email' })

    if (!parsed || parsed.action !== 'send_email') { invalid() }
    const derived = Boolean(parsed.reply || parsed.forward)

    if (![...parsed.to, ...(parsed.cc ?? []), ...(parsed.bcc ?? [])].every(email => email.length <= 254 && EMAIL.test(email))) { invalid() }

    // A hand-written reply names both its thread and the message it answers, or neither.
    if (!derived && (parsed.threadId === undefined) !== (parsed.inReplyTo === undefined)) { invalid() }

    if (parsed.threadId !== undefined && (!THREAD_ID.test(parsed.threadId)
      || typeof parsed.inReplyTo !== 'string' || !MESSAGE_ID.test(parsed.inReplyTo) || !validText(parsed.inReplyTo, 1000, true))) { invalid() }

    return {
      action: 'send-email', operationId: operationId.toLowerCase(), sourceId,
      to: [...parsed.to], subject: derived && parsed.subject === '' ? '' : requiredText(parsed.subject, 500, true),
      body: validText(parsed.body, 20_000) ? parsed.body : invalid(),
      ...(parsed.cc ? { cc: [...parsed.cc] } : {}),
      ...(parsed.bcc ? { bcc: [...parsed.bcc] } : {}),
      ...(parsed.reply ? { reply: parsed.reply } : {}),
      ...(parsed.forward ? { forward: parsed.forward } : {}),
      ...(parsed.attachments ? { attachments: parsed.attachments } : {}),
      ...(parsed.threadId !== undefined && parsed.inReplyTo !== undefined ? { threadId: parsed.threadId, inReplyTo: parsed.inReplyTo } : {})
    }
  }

  if (input.action === 'create-event') {
    if (!hasOnly(input, ['action', 'operationId', 'sourceId', 'title', 'start', 'end', 'location', 'description'])) { invalid() }

    return { action: 'create-event', operationId: operationId.toLowerCase(), sourceId, ...parseCalendarFields(input) }
  }

  if (input.action === 'update-event') {
    // Source event identifiers are provider-owned. Apple uses identifiers that
    // are not valid Google IDs, so this shared grammar only requires a bounded
    // single-line string; Google validates its own path segment at dispatch.
    if (!hasOnly(input, ['action', 'operationId', 'sourceId', 'id', 'title', 'start', 'end', 'location', 'description']) || !validText(input.id, 1024, true) || input.id.length === 0) { invalid() }

    return { action: 'update-event', operationId: operationId.toLowerCase(), sourceId, id: input.id, ...parseCalendarFields(input) }
  }

  invalid()
}

/** What the owner approved, ready to leave: the message built by the shared composer. */
export interface GoogleEmailMessage { mime: Buffer; threadId?: string }

/** A refusal of the shared composer (too large, bad address) as the utility's own typed failure. */
export function composeFailure(error: unknown): unknown {
  return error instanceof GmailMailError ? new UtilityFailure(error.code as UtilityFailure['code']) : error
}

/**
 * Builds the message the owner approved (downloading a forward's original files). Called before the
 * durable dispatch marker, so a message that is too large or malformed fails as a plain refusal.
 */
export async function prepareGoogleEmail(
  api: GmailApi,
  from: string,
  action: GoogleEmailAction,
  owner: readonly string[] | (() => Promise<readonly string[]>)
): Promise<GoogleEmailMessage> {
  try {
    const message = await resolveCompose(api, action, { owner: typeof owner === 'function' ? owner : async () => owner }, { bytes: true, send: true })

    return { mime: buildMimeMessage(message, from), ...(message.threadId ? { threadId: message.threadId } : {}) }
  } catch (error) {
    throw composeFailure(error)
  }
}

function operationSignal(signal?: AbortSignal, timeoutMs = 20_000): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) { throw new UtilityFailure('cancelled') }
}

async function smallJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader()

  if (!reader) { throw new UtilityFailure('outcome_unknown') }
  const chunks: Uint8Array[] = []
  let bytes = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()

      if (done) { break }
      bytes += value.byteLength

      if (bytes > MAX_RESPONSE_BYTES) { throw new UtilityFailure('outcome_unknown') }
      chunks.push(value)
    }

    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))

    if (!isRecord(parsed)) { throw new UtilityFailure('outcome_unknown') }

    return parsed
  } catch (error) {
    if (error instanceof UtilityFailure) { throw error }
    throw new UtilityFailure('outcome_unknown')
  } finally { await reader.cancel().catch(() => {}) }
}

function discard(response: Response): void { void response.body?.cancel().catch(() => {}) }

function readFailure(response: Response): never {
  discard(response)

  if (response.status === 401) { throw new UtilityFailure('reconnect') }

  if (response.status === 403) { throw new UtilityFailure('denied') }

  if (response.status === 404 || response.status === 409 || response.status === 412) { throw new UtilityFailure('conflict') }
  throw new UtilityFailure('network')
}

function writeFailure(response: Response): never {
  discard(response)

  if (response.status === 401) { throw new UtilityFailure('reconnect') }

  if (response.status === 403) { throw new UtilityFailure('denied') }

  if (response.status === 409 || response.status === 412 || response.status === 404) { throw new UtilityFailure('conflict') }

  if (response.status === 400) { throw new UtilityFailure('invalid_input') }
  // A failed POST/PATCH can have reached the provider.  Do not retry it and do
  // not claim it failed when the provider has not supplied a definite outcome.
  throw new UtilityFailure('outcome_unknown')
}

async function writeJson(fetchImpl: typeof fetch, url: string, init: RequestInit, signal?: AbortSignal, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  assertNotAborted(signal)
  let response: Response

  try {
    // The abort check immediately above is deliberately adjacent to dispatch.
    response = await fetchImpl(url, { ...init, signal: operationSignal(signal, timeoutMs), redirect: 'error' })
  } catch {
    throw new UtilityFailure('outcome_unknown')
  }

  if (!response.ok) { writeFailure(response) }

  return smallJson(response)
}

function calendarPayload(action: GoogleCalendarCreateAction | GoogleCalendarUpdateAction, includeId: boolean): Record<string, unknown> {
  return {
    ...(includeId ? { id: action.operationId.replaceAll('-', '') } : {}),
    summary: action.title,
    start: { dateTime: action.start }, end: { dateTime: action.end },
    ...(action.location === undefined ? {} : { location: action.location }),
    ...(action.description === undefined ? {} : { description: action.description })
  }
}

function snapshotText(value: unknown, maximum: number): string | undefined {
  return validText(value, maximum) ? value : undefined
}

function snapshotIdentifier(value: unknown, maximum: number): string | undefined {
  return validText(value, maximum, true) ? value : undefined
}

/** Fetches just enough state to make a personal timed-event update conditional. */
export async function inspectGoogleEvent(fetchImpl: typeof fetch, token: string, calendarId: string, id: string, signal?: AbortSignal): Promise<GoogleEventSnapshot> {
  if (!EVENT_ID.test(id) || !validText(calendarId, 500, true)) { invalid() }
  assertNotAborted(signal)
  let response: Response

  try {
    response = await fetchImpl(`${GOOGLE_CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}?fields=${encodeURIComponent('id,etag,status,summary,start,end,location,description,recurrence,recurringEventId,attendees')}`, {
      headers: { authorization: `Bearer ${token}` }, signal: operationSignal(signal), redirect: 'error'
    })
  } catch {
    throw new UtilityFailure(signal?.aborted ? 'cancelled' : 'network')
  }

  if (!response.ok) { readFailure(response) }
  const event = await smallJson(response)
  const revision = snapshotIdentifier(event.etag, 1024)
  const eventId = snapshotIdentifier(event.id, 1024)

  if (!revision || !eventId || event.status === 'cancelled' || (Array.isArray(event.recurrence) && event.recurrence.length > 0)
    || event.attendeesOmitted === true || (Array.isArray(event.attendees) && event.attendees.length > 0)
    || !isRecord(event.start) || !isRecord(event.end) || event.start.date !== undefined || event.end.date !== undefined) { throw new UtilityFailure('unsupported') }

  // A single recurring occurrence has recurringEventId but no recurrence rules
  // of its own. It remains safe when it satisfies the same timed/private fence.
  const start = normalizedInstant(event.start.dateTime)
  const end = normalizedInstant(event.end.dateTime)

  return {
    id: eventId, title: snapshotText(event.summary, 500) ?? '', start, end,
    ...(snapshotText(event.location, 1000) === undefined ? {} : { location: snapshotText(event.location, 1000) }),
    ...(snapshotText(event.description, 20_000) === undefined ? {} : { description: snapshotText(event.description, 20_000) }),
    allDay: false, revision
  }
}

/** Executes one already-approved provider mutation. It never polls or retries a write. */
export async function executeGoogleWrite(
  fetchImpl: typeof fetch,
  token: string,
  mailboxLabel: string,
  calendarId: string,
  action: GoogleUtilityWrite,
  beforeSnapshot?: GoogleEventSnapshot,
  signal?: AbortSignal,
  email?: GoogleEmailMessage
): Promise<GoogleWriteReceipt> {
  if (!validText(token, 20_000, true) || !validText(calendarId, 500, true)) { invalid() }

  if (action.action === 'send-email') {
    // Normally built (and, for a forward, its files downloaded) by prepareGoogleEmail before the dispatch marker.
    const message = email ?? await prepareGoogleEmail({ json: async () => invalid(), upload: async () => invalid() }, mailboxLabel, action, [])

    // Gmail's 35 MiB allowance is on the media-upload endpoint (the JSON `raw` field stops near 5 MB).
    const upload = messageUpload('send', message.mime, { threadId: message.threadId })

    const result = await writeJson(fetchImpl, `${GOOGLE_GMAIL_UPLOAD}/${upload.path}?uploadType=${upload.uploadType}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': upload.contentType },
      body: upload.body as unknown as BodyInit
    }, signal, message.mime.length > 1_000_000 ? 120_000 : 20_000)

    const id = snapshotIdentifier(result.id, 1024)

    if (!id) { throw new UtilityFailure('outcome_unknown') }

    return { action: action.action, id }
  }

  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  if (action.action === 'create-event') {
    const result = await writeJson(fetchImpl, `${GOOGLE_CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: 'POST', headers, body: JSON.stringify(calendarPayload(action, true))
    }, signal)

    const id = snapshotIdentifier(result.id, 1024)

    if (!id) { throw new UtilityFailure('outcome_unknown') }

    return { action: action.action, id, ...(snapshotText(result.etag, 1024) ? { revision: snapshotText(result.etag, 1024) } : {}) }
  }

  if (!EVENT_ID.test(action.id) || !beforeSnapshot || beforeSnapshot.id !== action.id || beforeSnapshot.allDay || !validText(beforeSnapshot.revision, 1024, true)) { throw new UtilityFailure('conflict') }

  const result = await writeJson(fetchImpl, `${GOOGLE_CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(action.id)}`, {
    method: 'PATCH', headers: { ...headers, 'if-match': beforeSnapshot.revision }, body: JSON.stringify(calendarPayload(action, false))
  }, signal)

  const id = snapshotIdentifier(result.id, 1024)

  if (!id) { throw new UtilityFailure('outcome_unknown') }

  return { action: action.action, id, ...(snapshotText(result.etag, 1024) ? { revision: snapshotText(result.etag, 1024) } : {}) }
}
