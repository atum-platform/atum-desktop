/**
 * Gmail mailbox control, shared by Desktop's utilities and the cloud controller's executor
 * (agent email control, 2026-11-08). One set of thin adapters over Gmail's own REST calls
 * (users.messages.get / modify / trash / untrash, users.threads.modify / trash / untrash,
 * users.labels.list / create, users.drafts.*, users.messages.attachments.get), with the names and
 * semantics of upstream Hermes' google-workspace `google_api.py` (get, labels, modify).
 *
 * The module never holds a token: the caller passes a `GmailApi` that already carries the
 * Authorization header, bounds responses, and maps HTTP status to Atum's closed error codes. This
 * module throws {@link GmailMailError} for its own refusals (scope, bad input, size); anything the
 * transport throws passes through unchanged.
 */
import type { MatrixGoogleToolRequest } from './matrix-google-tool-request'
import { MATRIX_GOOGLE_ATTACHMENT_MAX_BYTES } from './matrix-google-tools'

export class GmailMailError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export interface GmailRequestInit {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
}

/**
 * One Gmail media upload (agent email compose, round 2). Gmail allows about 5 MB on its ordinary JSON
 * endpoints but 35 MiB on the upload endpoints, and the product accepts messages up to 25 MB, so every
 * send and draft write goes through `/upload/gmail/v1/users/me/<path>?uploadType=<uploadType>` with the RFC 822
 * bytes themselves: `media` when only the message is sent, `multipart` (JSON metadata part + `message/rfc822`
 * part) when a thread or draft id must be kept.
 */
export interface GmailUpload {
  method: 'POST' | 'PUT'
  /** Under `users/me/`: `messages/send`, `drafts` or `drafts/<id>`. */
  path: string
  uploadType: 'media' | 'multipart'
  contentType: string
  body: Buffer
}

export interface GmailApi {
  /** One call under `users/me/`, answered as a JSON object. `limit` caps the response bytes. */
  json(path: string, init?: GmailRequestInit, limit?: number): Promise<Record<string, unknown>>
  /** One media upload under `/upload/gmail/v1/users/me/`, answered as a JSON object. */
  upload(request: GmailUpload, limit?: number): Promise<Record<string, unknown>>
}

type JsonRecord = Record<string, unknown>
type Request<A extends MatrixGoogleToolRequest['action']> = Extract<MatrixGoogleToolRequest, { action: A }>

/** One page of a message body an agent gets per call; `read_message` continues with `offset`. */
export const MESSAGE_PAGE_CHARS = 20_000
/** read_message shows at most this many headers and this much of one value, and says so when it cuts. */
const MAX_HEADERS_SHOWN = 300
const MAX_HEADER_VALUE = 2_000
const MAX_DRAFTS = 25
export const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
export const MESSAGE_ID = /^<[^<>\s]{3,900}>$/

/** Labels whose meaning is a place or a state of its own: never set or cleared by name. */
const PROTECTED_LABELS: ReadonlySet<string> = new Set(['TRASH', 'SPAM', 'DRAFT', 'SENT', 'CHAT'])
const SYSTEM_LABELS: ReadonlySet<string> = new Set([
  'INBOX', 'UNREAD', 'STARRED', 'IMPORTANT',
  'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'
])

/** One line per typed refusal for the agent to act on; it tells the owner in its own words. */
export const GMAIL_MAIL_HINTS: Readonly<Record<string, string>> = {
  scope_missing:
    'This Google connection can read mail but not change it. Tell the owner once that changing mail (labels, archive, read marks, trash, drafts) needs Google reconnected with mailbox access; reading and sending still work. Carry on without it and do not ask again in this conversation.',
  label_not_found: 'No label has that name. Call list_labels to see them, or create_label first.',
  not_found: 'Gmail has no such message, draft or attachment. Use the ids from an earlier result.',
  too_large: 'That is too large to hand over here. Name the file to the owner so they can open it in Gmail.',
  owner_turn_required: 'Sending, mailbox changes, drafts and attachment downloads are made only while the owner is talking to you, not in a scheduled or background run. Report what you would do instead.',
  message_too_large: 'The message with its attachments is over Gmail\'s 25 MB limit. Attach fewer or smaller files (or leave the original files off a forward), or share a Drive link instead.',
  invalid_input: 'A value was not accepted. Check the addresses (plain name@example.com, at most 20 per list and 50 in all, at least one on a send), the subject (one line) and the ids from an earlier result.'
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function text(value: unknown, max = 2_000): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/** The scope gate for every mailbox change. A typed code, never a crash, and nothing else is blocked. */
function requireManage(canManage: boolean): void {
  if (!canManage) {
    throw new GmailMailError('scope_missing')
  }
}

// --- message anatomy ---------------------------------------------------------------------------

export interface MessageHeader {
  name: string
  value: string
}

/** Every header of a message, for lookups: no entry limit (From or Subject may sit past the 80th). */
export function messageHeaders(message: JsonRecord): MessageHeader[] {
  const payload = record(message.payload)
  const rows = Array.isArray(payload.headers) ? payload.headers : []

  return rows.flatMap(row => {
    const header = record(row)

    return typeof header.name === 'string' && typeof header.value === 'string'
      ? [{ name: header.name.slice(0, 200), value: header.value }] : []
  })
}

/**
 * The headers to show an agent: all of them up to a bound, each value up to a bound, and every cut said out
 * loud (`truncated` and `length` on the entry, `headersOmitted` and `headersTruncated` on the message).
 */
export function describeHeaders(message: JsonRecord): {
  headers: Array<MessageHeader & { truncated?: true; length?: number }>
  headersTruncated?: true
  headersOmitted?: number
} {
  const all = messageHeaders(message)
  let clipped = false

  const headers = all.slice(0, MAX_HEADERS_SHOWN).map(header => {
    if (header.value.length <= MAX_HEADER_VALUE) {
      return header
    }

    clipped = true

    return { name: header.name, value: header.value.slice(0, MAX_HEADER_VALUE), truncated: true as const, length: header.value.length }
  })

  const omitted = all.length - headers.length

  return {
    headers,
    ...(omitted > 0 ? { headersOmitted: omitted } : {}),
    ...(omitted > 0 || clipped ? { headersTruncated: true as const } : {})
  }
}

export function headerMap(headers: readonly MessageHeader[]): Record<string, string> {
  const map: Record<string, string> = {}

  for (const header of headers) {
    map[header.name.toLowerCase()] ??= header.value
  }

  return map
}

export interface AttachmentInfo {
  attachmentId: string
  filename: string
  mimeType: string
  size: number
  /** Embedded in the body (an image in a signature): rarely what a person means by "attachment". */
  inline?: true
}

/** Every file part of a message, by walking its MIME tree. Bounded; names are display text only. */
export function attachmentsOf(payload: unknown): AttachmentInfo[] {
  const found: AttachmentInfo[] = []

  const walk = (value: unknown, depth: number) => {
    const part = record(value)

    if (depth > 12 || found.length >= 100) {
      return
    }

    const body = record(part.body)
    const filename = text(part.filename, 255)
    const attachmentId = text(body.attachmentId, 1_500)

    if (filename && attachmentId) {
      const headers = headerMap(messageHeaders({ payload: part }))
      const disposition = (headers['content-disposition'] ?? '').toLowerCase()

      found.push({
        attachmentId,
        filename,
        mimeType: text(part.mimeType, 200) || 'application/octet-stream',
        size: Number.isFinite(Number(body.size)) ? Number(body.size) : 0,
        ...(disposition.startsWith('inline') ? { inline: true as const } : {})
      })
    }

    for (const child of Array.isArray(part.parts) ? part.parts : []) {
      walk(child, depth + 1)
    }
  }

  walk(payload, 0)

  return found
}

/** Plain text of a message; an HTML-only message is reduced to its words. Bounded by the caller. */
export function extractMessageText(message: JsonRecord): string {
  const payload = record(message.payload)

  const collect = (part: JsonRecord, wanted: 'text/plain' | 'text/html'): string[] => {
    const mimeType = text(part.mimeType, 100)
    const body = record(part.body)
    const own: string[] = []

    if ((mimeType === wanted || (wanted === 'text/plain' && !mimeType)) && typeof body.data === 'string') {
      try {
        own.push(Buffer.from(body.data, 'base64url').toString('utf8'))
      } catch {
        /* keep walking nested MIME parts */
      }
    }

    for (const child of Array.isArray(part.parts) ? part.parts : []) {
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        own.push(...collect(child as JsonRecord, wanted))
      }
    }

    return own
  }

  const plain = collect(payload, 'text/plain').join('\n').trim()

  if (plain) {
    return plain
  }

  const entity = (match: string, digits: string, radix: number) => {
    const point = Number.parseInt(digits, radix)

    return Number.isInteger(point) && point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : match
  }

  // Many transactional and vendor emails are HTML-only. Search returns Gmail's short snippet, but a
  // read must still return the actual body rather than trapping the agent at that preview.
  return collect(payload, 'text/html').join('\n')
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (match, digits: string) => entity(match, digits, 10))
    .replace(/&#x([0-9a-f]+);/gi, (match, digits: string) => entity(match, digits, 16))
    .replace(/[ \t]+/g, ' ').replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n\s*\n+/g, '\n\n').trim()
}

/** The bare address in `"Lan" <lan@example.com>` or `lan@example.com`. */
export function addressOf(value: string): string {
  const angle = value.match(/<([^<>\s]+@[^<>\s]+)>/)

  if (angle) {
    return angle[1]!
  }

  return value.match(/[^\s,;<>]+@[^\s,;<>]+/)?.[0] ?? ''
}

/** Reads one message in full: every header, a page of text with how to continue, and its files. */
export async function readMessage(api: GmailApi, request: Request<'read_message'>): Promise<JsonRecord> {
  const message = await api.json(`messages/${encodeURIComponent(request.messageId)}?format=full`)
  const map = headerMap(messageHeaders(message))
  // Paged over the whole text: the last page is the real end, and textLength is the real length. The only
  // ceiling is the transport's response limit, which fails the read as `too_large` rather than cutting it.
  const full = extractMessageText(message)
  const offset = Math.min(request.offset ?? 0, full.length)
  const end = Math.min(offset + MESSAGE_PAGE_CHARS, full.length)
  const subject = text(map.subject, 500)
  const replyTo = addressOf(map['reply-to'] ?? '') || addressOf(map.from ?? '')
  const messageId = text(map['message-id'], 1_000)

  return {
    id: text(message.id, 200),
    threadId: text(message.threadId, 200),
    labelIds: (Array.isArray(message.labelIds) ? message.labelIds : []).filter(label => typeof label === 'string').slice(0, 60),
    ...describeHeaders(message),
    from: text(map.from, 500),
    to: text(map.to, 2_000),
    cc: text(map.cc, 2_000),
    subject,
    date: text(map.date, 128),
    messageId,
    text: full.slice(offset, end),
    textLength: full.length,
    // Never silent: when the page ends before the message does, say so and say how to continue.
    ...(end < full.length ? {
      truncated: true,
      nextOffset: end,
      continueWith: { action: 'read_message', sourceId: request.sourceId, messageId: request.messageId, offset: end }
    } : {}),
    ...(offset > 0 ? { offset } : {}),
    attachments: attachmentsOf(message.payload),
    snippet: text(message.snippet, 1_000),
    ...(replyTo ? {
      reply: {
        to: [replyTo],
        subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
        threadId: text(message.threadId, 200),
        ...(MESSAGE_ID.test(messageId) ? { inReplyTo: messageId } : {})
      }
    } : {})
  }
}

/**
 * The bytes of one attachment. The message is read first so the attachment id is proven to belong
 * to it, its name and type come from the message (never from the caller), and a file over the
 * limit is refused before it is downloaded.
 */
export async function fetchAttachment(
  api: GmailApi,
  request: Request<'download_attachment'>
): Promise<{ filename: string; mimeType: string; bytes: Buffer }> {
  const message = await api.json(`messages/${encodeURIComponent(request.messageId)}?format=full`)
  const file = attachmentsOf(message.payload).find(item => item.attachmentId === request.attachmentId)

  if (!file) {
    throw new GmailMailError('not_found')
  }

  if (file.size > MATRIX_GOOGLE_ATTACHMENT_MAX_BYTES) {
    throw new GmailMailError('too_large')
  }

  const bytes = await downloadAttachmentBytes(api, request.messageId, request.attachmentId, MATRIX_GOOGLE_ATTACHMENT_MAX_BYTES)

  return { filename: file.filename, mimeType: file.mimeType, bytes }
}

/** The decoded bytes of one attachment, refused as `too_large` past `maxBytes` (before decoding when it can be). */
export async function downloadAttachmentBytes(
  api: GmailApi,
  messageId: string,
  attachmentId: string,
  maxBytes: number
): Promise<Buffer> {
  // base64url inflates by a third; the cap is on the decoded file, the response gets its margin.
  const limit = Math.ceil(maxBytes * 4 / 3) + 4_096

  const part = await api.json(
    `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    undefined,
    limit
  )

  if (typeof part.data !== 'string') {
    throw new GmailMailError('response_invalid')
  }

  const bytes = Buffer.from(part.data, 'base64url')

  if (bytes.length > maxBytes) {
    throw new GmailMailError('too_large')
  }

  return bytes
}

// --- labels ------------------------------------------------------------------------------------

export interface LabelInfo {
  labelId: string
  name: string
  type: 'system' | 'user'
}

export async function listLabels(api: GmailApi): Promise<{ labels: LabelInfo[] }> {
  const value = await api.json('labels')

  const labels = (Array.isArray(value.labels) ? value.labels : []).flatMap(row => {
    const label = record(row)
    const labelId = text(label.id, 200)

    return labelId ? [{ labelId, name: text(label.name, 225) || labelId, type: label.type === 'user' ? 'user' as const : 'system' as const }] : []
  })

  return { labels: labels.slice(0, 500) }
}

/** Names or ids → label ids. System labels resolve by id; user labels by exact name (any case) or id. */
async function resolveLabels(api: GmailApi, wanted: readonly string[]): Promise<string[]> {
  const ids: string[] = []
  let known: LabelInfo[] | undefined

  for (const name of wanted) {
    const upper = name.toUpperCase()

    if (PROTECTED_LABELS.has(upper)) {
      throw new GmailMailError('invalid_input')
    }

    if (SYSTEM_LABELS.has(upper)) {
      ids.push(upper)
      continue
    }

    known ??= (await listLabels(api)).labels
    const lower = name.toLowerCase()
    const match = known.find(label => label.labelId === name) ?? known.find(label => label.name.toLowerCase() === lower)

    if (!match) {
      throw new GmailMailError('label_not_found')
    }

    if (PROTECTED_LABELS.has(match.labelId)) {
      throw new GmailMailError('invalid_input')
    }

    ids.push(match.labelId)
  }

  return [...new Set(ids)]
}

export async function createLabel(api: GmailApi, request: Request<'create_label'>, canManage: boolean): Promise<JsonRecord> {
  requireManage(canManage)

  if (/[\r\n\0]/.test(request.name) || PROTECTED_LABELS.has(request.name.toUpperCase()) ||
      SYSTEM_LABELS.has(request.name.toUpperCase())) {
    throw new GmailMailError('invalid_input')
  }

  const label = await api.json('labels', {
    method: 'POST',
    body: { name: request.name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }
  })

  return { done: true, action: 'create_label', label: { labelId: text(label.id, 200), name: text(label.name, 225) || request.name } }
}

// --- mailbox changes ---------------------------------------------------------------------------

const LABEL_EFFECTS: Record<string, { add?: string[]; remove?: string[] }> = {
  archive: { remove: ['INBOX'] },
  unarchive: { add: ['INBOX'] },
  mark_read: { remove: ['UNREAD'] },
  mark_unread: { add: ['UNREAD'] },
  star: { add: ['STARRED'] },
  unstar: { remove: ['STARRED'] }
}

/** Archive, read/unread, star, labels and trash on one thread or one message. Reversible by design. */
export async function mailboxChange(api: GmailApi, request: Request<'mailbox'>, canManage: boolean): Promise<JsonRecord> {
  requireManage(canManage)
  const thread = request.threadId !== undefined
  const id = (request.threadId ?? request.messageId)!
  const base = `${thread ? 'threads' : 'messages'}/${encodeURIComponent(id)}`
  const target = thread ? 'thread' : 'message'
  const receipt = { done: true, action: 'mailbox', operation: request.operation, target, id }

  if (request.operation === 'trash' || request.operation === 'untrash') {
    await api.json(`${base}/${request.operation}`, { method: 'POST' })

    return receipt
  }

  let add: string[]
  let remove: string[]

  if (request.operation === 'add_labels' || request.operation === 'remove_labels') {
    const ids = await resolveLabels(api, request.labels ?? [])
    add = request.operation === 'add_labels' ? ids : []
    remove = request.operation === 'remove_labels' ? ids : []
  } else {
    add = LABEL_EFFECTS[request.operation]?.add ?? []
    remove = LABEL_EFFECTS[request.operation]?.remove ?? []
  }

  const result = await api.json(`${base}/modify`, {
    method: 'POST',
    body: { ...(add.length ? { addLabelIds: add } : {}), ...(remove.length ? { removeLabelIds: remove } : {}) }
  })

  const labelIds = thread ? undefined : (Array.isArray(result.labelIds) ? result.labelIds.filter(label => typeof label === 'string') : undefined)

  return { ...receipt, ...(labelIds ? { labelIds } : {}) }
}

// --- drafts ------------------------------------------------------------------------------------

export function foldBase64(value: string, width = 76): string {
  return value.match(new RegExp(`.{1,${width}}`, 'g'))?.join('\r\n') ?? ''
}

/** RFC 2047 encoded words are at most 75 characters: 10 of framing leave 63 of base64, which is 45 bytes. */
const ENCODED_WORD_BYTES = 45

/**
 * The subject as `=?UTF-8?B?...?=` words, split on character boundaries so every word decodes by itself
 * (a base64 split mid UTF-8 sequence would corrupt Vietnamese and emoji).
 */
export function encodedSubject(subject: string): string {
  const words: string[] = []
  let current: Buffer[] = []
  let bytes = 0

  for (const character of subject) {
    const encoded = Buffer.from(character, 'utf8')

    if (bytes + encoded.length > ENCODED_WORD_BYTES && current.length) {
      words.push(Buffer.concat(current).toString('base64'))
      current = []
      bytes = 0
    }

    current.push(encoded)
    bytes += encoded.length
  }

  words.push(Buffer.concat(current).toString('base64'))

  return words.map(word => `=?UTF-8?B?${word}?=`).join('\r\n ')
}

// Saving a draft (`writeDraft`) lives with the rest of outgoing mail in ./gmail-compose.

export interface DraftSummary {
  draftId: string
  messageId: string
  threadId: string
  to: string
  subject: string
  date: string
  snippet: string
}

export async function listDrafts(
  api: GmailApi,
  request: Request<'list_drafts'>
): Promise<{ drafts: DraftSummary[]; nextPageToken?: string }> {
  const query = new URLSearchParams({ maxResults: String(MAX_DRAFTS), ...(request.pageToken ? { pageToken: request.pageToken } : {}) })
  const listed = await api.json(`drafts?${query}`)
  const rows = (Array.isArray(listed.drafts) ? listed.drafts : []).slice(0, MAX_DRAFTS)
  const drafts: DraftSummary[] = []

  for (const row of rows) {
    const id = text(record(row).id, 200)

    if (!id) {
      continue
    }

    const params = new URLSearchParams({ format: 'metadata' })

    for (const name of ['To', 'Subject', 'Date']) {
      params.append('metadataHeaders', name)
    }

    const draft = await api.json(`drafts/${encodeURIComponent(id)}?${params}`)
    const message = record(draft.message)
    const map = headerMap(messageHeaders(message))

    drafts.push({
      draftId: id,
      messageId: text(message.id, 200),
      threadId: text(message.threadId, 200),
      to: text(map.to, 1_000),
      subject: text(map.subject, 500),
      date: text(map.date, 128),
      snippet: text(message.snippet, 300)
    })
  }

  const token = typeof listed.nextPageToken === 'string' && listed.nextPageToken.length <= 512 ? listed.nextPageToken : undefined

  return { drafts, ...(token ? { nextPageToken: token } : {}) }
}

// --- thread truncation -------------------------------------------------------------------------

/** What a thread read left out, so the agent is never told a partial thread is the whole thing. */
export function omittedMessages(all: readonly unknown[], kept: number): {
  olderMessages?: Array<{ id: string; date?: string; from?: string; snippet?: string }>
} {
  const older = all.slice(0, Math.max(0, all.length - kept))

  if (!older.length) {
    return {}
  }

  return {
    olderMessages: older.slice(-100).map(row => {
      const message = record(row)
      const map = headerMap(messageHeaders(message))

      return {
        id: text(message.id, 200),
        ...(map.date ? { date: text(map.date, 128) } : {}),
        ...(map.from ? { from: text(map.from, 200) } : {}),
        snippet: text(message.snippet, 160)
      }
    })
  }
}
