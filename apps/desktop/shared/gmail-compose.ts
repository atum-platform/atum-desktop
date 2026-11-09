/**
 * Outgoing Gmail, shared by Desktop's utilities and the cloud controller's executor (agent email
 * compose, 2026-11-09): CC and BCC, reply and reply-all, forward, attachments, and drafts with all of
 * those. One module builds the MIME message for a send and for a draft, so the Mac and the cloud
 * cannot drift apart.
 *
 * It follows the names and semantics of upstream Hermes' google-workspace `google_api.py` (send with
 * cc, reply threading through In-Reply-To / References / threadId) and Gmail's own REST calls
 * (users.messages.get / send, users.drafts.*). Nothing here holds a token: the caller passes a
 * `GmailApi` that already carries the Authorization header.
 *
 * The flow is two steps so a confirmation can show exactly what will leave:
 *   1. {@link resolveCompose} turns a request into a {@link ResolvedMessage}: the final recipients,
 *      subject, thread headers, quoted original and attachment list. With `bytes: false` it downloads
 *      nothing (a forward only learns the original files' names and sizes), which is what the owner's
 *      confirmation needs; {@link composeSummary} is the text-free description of it.
 *   2. {@link buildMimeMessage} writes the RFC 5322 / MIME message and {@link messageUpload} wraps it for
 *      Gmail's media-upload endpoints (a message can be up to 25 MB; the ordinary JSON `raw` field is
 *      limited to about 5 MB).
 */
import { createHash, randomBytes } from 'node:crypto'

import {
  ADDRESS,
  addressOf,
  attachmentsOf,
  downloadAttachmentBytes,
  encodedSubject,
  extractMessageText,
  foldBase64,
  type GmailApi,
  GmailMailError,
  type GmailUpload,
  headerMap,
  MESSAGE_ID,
  messageHeaders
} from './gmail-mail'
import type { MatrixGoogleOutgoingAttachment, MatrixGoogleToolRequest } from './matrix-google-tool-request'
import {
  MATRIX_GOOGLE_COMPOSE_MAX_BYTES,
  MATRIX_GOOGLE_MAX_OUTGOING_ATTACHMENTS,
  MATRIX_GOOGLE_MAX_RECIPIENTS,
  MATRIX_GOOGLE_MAX_RECIPIENTS_PER_LIST
} from './matrix-google-tools'

type JsonRecord = Record<string, unknown>

/** A send or a draft, as the closed request grammar carries it. */
export type ComposeRequest = Extract<MatrixGoogleToolRequest, { action: 'send_email' | 'create_draft' | 'update_draft' }>

export interface ComposeContext {
  /** The owner's own addresses (the mailbox account): excluded from a reply-all. Called only when needed. */
  owner?: () => Promise<readonly string[]>
}

export interface ResolvedAttachment {
  filename: string
  mimeType: string
  size: number
  origin: 'upload' | 'forward'
  /** Hex SHA-256 of the bytes, once they are known (always for an upload, after download for a forward). */
  sha256?: string
  bytes?: Buffer
  /** Where a forwarded file is fetched from. */
  messageId?: string
  attachmentId?: string
}

export interface ResolvedMessage {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  /** The agent's own text. */
  body: string
  /** The forwarded original (headers block + text), appended to `body` on build. */
  quote?: string
  quoteTruncated?: true
  forwardedFrom?: { messageId: string; from: string; date: string; subject: string }
  threadId?: string
  inReplyTo?: string
  references?: string[]
  attachments: ResolvedAttachment[]
}

export interface ResolveOptions {
  /** Whether a forward's original files are downloaded now (to send or save) or only listed (to confirm). */
  bytes: boolean
  /** A send needs at least one recipient; a draft may have none yet. */
  send: boolean
}

/** One forwarded original is quoted up to this many characters, and says so when it is cut. */
const MAX_QUOTE_CHARS = 100_000
const QUOTE_PREVIEW_CHARS = 1_500
const MAX_REFERENCES = 10
const MESSAGE_IDS = /<[^<>\s]{3,900}>/g
/** Chosen for the encoded size of what is left over once the files are in: bodies, quote, headers. */
const SIZE_OVERHEAD = 128 * 1024

const REPLY_HEADERS = ['From', 'To', 'Cc', 'Reply-To', 'Subject', 'Date', 'Message-ID', 'References', 'Delivered-To']

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function text(value: unknown, max = 2_000): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function invalid(): never {
  throw new GmailMailError('invalid_input')
}

// --- the owner's own addresses -----------------------------------------------------------------

/**
 * Remembers each account's own addresses for a while, so a run of replies asks Gmail once. One cache
 * per connection holder (the Mac's utilities, the cloud executor); keyed by the account address.
 */
export class OwnerAddressCache {
  private readonly entries = new Map<string, { addresses: string[]; expires: number }>()

  constructor(private readonly ttlMs = 10 * 60_000, private readonly now: () => number = Date.now, private readonly max = 32) {}

  async get(key: string, load: () => Promise<string[]>): Promise<string[]> {
    const found = this.entries.get(key)

    if (found && found.expires > this.now()) {
      return found.addresses
    }

    const addresses = await load()

    if (this.entries.size >= this.max) {
      this.entries.delete(this.entries.keys().next().value!)
    }

    this.entries.set(key, { addresses, expires: this.now() + this.ttlMs })

    return addresses
  }
}

/**
 * Every address the account sends as: its primary address plus its verified send-as aliases (Gmail's
 * `users.settings.sendAs.list`, which the `gmail.readonly` grant already allows). When Gmail refuses
 * it, only the primary address is known and a reply falls back on the original's `Delivered-To`
 * header; a failure is not remembered, so the next reply tries again. The aliases are what lets a
 * reply-all leave the owner's own alias out and a reply to a message the owner wrote from an alias go
 * to its recipients.
 */
export async function ownerAddresses(api: GmailApi, primary: string, cache?: OwnerAddressCache): Promise<string[]> {
  const load = async () => {
    const aliases: string[] = []
    const listed = await api.json('settings/sendAs')

    for (const row of Array.isArray(listed.sendAs) ? listed.sendAs : []) {
      const identity = record(row)
      const address = text(identity.sendAsEmail, 254)
      const status = text(identity.verificationStatus, 40)

      // The primary address and verified aliases only; a pending alias is not yet the owner's to send as.
      if (address && ADDRESS.test(address) && (!status || status === 'accepted')) {
        aliases.push(address)
      }
    }

    return dedupe([primary, ...aliases])
  }

  try {
    return cache ? await cache.get(primary.toLowerCase(), load) : await load()
  } catch {
    return [primary]
  }
}

// --- addresses ---------------------------------------------------------------------------------

/** Every bare address in a header value such as `"Lan, N" <fixture-25427bca0e@example.invalid>, fixture-a92d052b5c@example.invalid`; groups and junk are skipped. */
export function addressesOf(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quoted = false
  let current = ''

  for (let index = 0; index < value.length; index++) {
    const character = value[index]!

    if (character === '\\' && quoted) {
      current += character + (value[index + 1] ?? '')
      index += 1
      continue
    }

    if (character === '"') {
      quoted = !quoted
    } else if (!quoted && character === '<') {
      depth += 1
    } else if (!quoted && character === '>') {
      depth = Math.max(0, depth - 1)
    }

    if (!quoted && depth === 0 && (character === ',' || character === ';')) {
      parts.push(current)
      current = ''
      continue
    }

    current += character
  }

  parts.push(current)

  return parts.map(part => addressOf(part)).filter(address => address.length <= 254 && ADDRESS.test(address))
}

/** First occurrence wins, compared without regard to case; `exclude` are dropped. */
function dedupe(addresses: readonly string[], exclude: ReadonlySet<string> = new Set()): string[] {
  const seen = new Set(exclude)
  const kept: string[] = []

  for (const address of addresses) {
    const key = address.toLowerCase()

    if (!seen.has(key)) {
      seen.add(key)
      kept.push(address)
    }
  }

  return kept
}

function validAddresses(list: readonly string[] | undefined): string[] {
  const addresses = list ?? []

  if (addresses.length > MATRIX_GOOGLE_MAX_RECIPIENTS_PER_LIST ||
      !addresses.every(address => address.length <= 254 && ADDRESS.test(address))) {
    invalid()
  }

  return [...addresses]
}

// --- replies and forwards ----------------------------------------------------------------------

export interface ReplyPlan {
  to: string[]
  cc: string[]
  subject: string
  threadId: string
  inReplyTo?: string
  references: string[]
}

function prefixed(subject: string, prefix: 'Re' | 'Fwd'): string {
  const re = prefix === 'Re' ? /^re:/i : /^(?:fwd?|fw):/i

  return re.test(subject.trim()) ? subject.trim() : `${prefix}: ${subject.trim()}`.trim()
}

/**
 * Who a reply goes to, worked out from the original's headers the way Gmail does:
 * - to the original's Reply-To, else its From;
 * - when the owner wrote the original, to the people it was sent to;
 * - reply-all adds the original's To and Cc, minus the owner (their account address and any address the
 *   original was delivered to) and minus the people already in To, each address once.
 */
export function replyPlan(
  message: JsonRecord,
  owner: readonly string[],
  all: boolean
): ReplyPlan {
  const map = headerMap(messageHeaders(message))
  const mine = new Set([...owner, ...addressesOf(map['delivered-to'] ?? '')].map(address => address.toLowerCase()))
  const from = addressesOf(map.from ?? '')
  const ownMessage = from.length > 0 && from.every(address => mine.has(address.toLowerCase()))
  const originalTo = addressesOf(map.to ?? '')
  const originalCc = addressesOf(map.cc ?? '')
  const replyTo = addressesOf(map['reply-to'] ?? '')

  let primary = ownMessage ? originalTo : replyTo.length ? replyTo : from

  // Never reply to oneself unless that is all there is (a note-to-self).
  const others = dedupe(primary, mine)
  primary = others.length ? others : dedupe(primary)

  const to = dedupe(primary)
  const taken = new Set([...to.map(address => address.toLowerCase())])
  const cc = all ? dedupe([...originalTo, ...originalCc], new Set([...mine, ...taken])) : []
  const messageId = text(map['message-id'], 1_000).trim()
  const chain = [...text(map.references, 20_000).matchAll(MESSAGE_IDS)].map(match => match[0])
  const inReplyTo = MESSAGE_ID.test(messageId) ? messageId : undefined

  const references = dedupe([...chain, ...(inReplyTo ? [inReplyTo] : [])])
  // Keep the root and the most recent ids, as clients do, so the header stays bounded.
  const kept = references.length > MAX_REFERENCES ? [references[0]!, ...references.slice(-(MAX_REFERENCES - 1))] : references

  return {
    to,
    cc,
    subject: prefixed(text(map.subject, 500), 'Re'),
    threadId: text(message.threadId, 200),
    ...(inReplyTo ? { inReplyTo } : {}),
    references: kept
  }
}

async function fetchOriginal(api: GmailApi, messageId: string, format: 'metadata' | 'full'): Promise<JsonRecord> {
  const query = new URLSearchParams({ format })

  if (format === 'metadata') {
    for (const name of REPLY_HEADERS) {
      query.append('metadataHeaders', name)
    }
  }

  return api.json(`messages/${encodeURIComponent(messageId)}?${query}`)
}

/** The forwarded message as a quoted block: Gmail's own "Forwarded message" header set, then the text. */
function forwardQuote(message: JsonRecord): { quote: string; truncated: boolean; from: string; date: string; subject: string } {
  const map = headerMap(messageHeaders(message))
  const original = extractMessageText(message)
  const truncated = original.length > MAX_QUOTE_CHARS
  const from = text(map.from, 500)
  const date = text(map.date, 128)
  const subject = text(map.subject, 500)
  const lines = [
    '---------- Forwarded message ---------',
    `From: ${from}`,
    `Date: ${date}`,
    `Subject: ${subject}`,
    `To: ${text(map.to, 2_000)}`,
    ...(map.cc ? [`Cc: ${text(map.cc, 2_000)}`] : []),
    '',
    truncated ? `${original.slice(0, MAX_QUOTE_CHARS)}\n\n[The original is longer: the rest was left out of this forward.]` : original
  ]

  return { quote: lines.join('\n'), truncated, from, date, subject }
}

// --- resolving ---------------------------------------------------------------------------------

function uploadedAttachment(file: MatrixGoogleOutgoingAttachment): ResolvedAttachment {
  const bytes = Buffer.from(file.data, 'base64')

  return {
    filename: file.filename,
    mimeType: file.mimeType ?? 'application/octet-stream',
    size: bytes.length,
    origin: 'upload',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes
  }
}

/** Upper bound of the encoded message for these parts, before anything is downloaded or built. */
function estimatedSize(attachments: readonly ResolvedAttachment[], body: string, quote: string): number {
  const files = attachments.reduce((sum, file) => sum + Math.ceil(file.size * 4 / 3 * 78 / 76) + 400, 0)
  const words = Math.ceil(Buffer.byteLength(body + quote, 'utf8') * 4 / 3 * 78 / 76)

  return files + words + SIZE_OVERHEAD
}

/**
 * Works out the message to send or save: validated recipients, the reply's or forward's derived fields
 * and attachments. Throws {@link GmailMailError}: `invalid_input` (bad address, header, count),
 * `message_too_large` (past Gmail's 25 MB), and whatever the transport throws reading the original.
 */
export async function resolveCompose(
  api: GmailApi,
  request: Pick<ComposeRequest, 'to' | 'subject' | 'body' | 'threadId' | 'inReplyTo' | 'cc' | 'bcc' | 'reply' | 'forward' | 'attachments'>,
  context: ComposeContext,
  options: ResolveOptions
): Promise<ResolvedMessage> {
  if (/[\r\n\0]/.test(request.subject) || (request.inReplyTo !== undefined && !MESSAGE_ID.test(request.inReplyTo)) ||
      (request.attachments?.length ?? 0) > MATRIX_GOOGLE_MAX_OUTGOING_ATTACHMENTS || (request.reply && request.forward)) {
    invalid()
  }

  const explicitTo = validAddresses(request.to)
  const explicitCc = validAddresses(request.cc)
  const explicitBcc = validAddresses(request.bcc)
  const attachments: ResolvedAttachment[] = (request.attachments ?? []).map(uploadedAttachment)
  let to = explicitTo
  let cc = explicitCc
  let subject = request.subject
  let threadId = request.threadId
  let inReplyTo = request.inReplyTo
  let references: string[] | undefined
  let quote: string | undefined
  let quoteTruncated = false
  let forwardedFrom: ResolvedMessage['forwardedFrom']

  if (request.reply) {
    const original = await fetchOriginal(api, request.reply.messageId, 'metadata')
    const owner = await (context.owner?.() ?? Promise.resolve([]))
    const plan = replyPlan(original, owner, request.reply.all === true)

    to = plan.to
    cc = dedupe([...plan.cc, ...explicitCc], new Set(plan.to.map(address => address.toLowerCase())))
    subject ||= plan.subject
    threadId = plan.threadId || undefined
    inReplyTo = plan.inReplyTo
    references = plan.references.length ? plan.references : undefined
  } else if (request.forward) {
    const original = await fetchOriginal(api, request.forward.messageId, 'full')
    const forwarded = forwardQuote(original)
    const map = headerMap(messageHeaders(original))

    subject ||= prefixed(text(map.subject, 500), 'Fwd')
    quote = forwarded.quote
    quoteTruncated = forwarded.truncated
    forwardedFrom = { messageId: request.forward.messageId, from: forwarded.from, date: forwarded.date, subject: forwarded.subject }

    if (request.forward.attachments !== false) {
      // Files, not the signature's inline images.
      for (const file of attachmentsOf(original.payload).filter(item => !item.inline)) {
        attachments.push({
          filename: file.filename,
          mimeType: file.mimeType,
          size: file.size,
          origin: 'forward',
          messageId: request.forward.messageId,
          attachmentId: file.attachmentId
        })
      }
    }
  }

  if (attachments.length > MATRIX_GOOGLE_MAX_OUTGOING_ATTACHMENTS) {
    invalid()
  }

  // `to` wins over `cc`, which wins over `bcc`: nobody is listed twice on one message.
  const finalTo = dedupe(to)
  const finalCc = dedupe(cc, new Set(finalTo.map(address => address.toLowerCase())))
  const finalBcc = dedupe(explicitBcc, new Set([...finalTo, ...finalCc].map(address => address.toLowerCase())))
  const total = finalTo.length + finalCc.length + finalBcc.length

  if (total > MATRIX_GOOGLE_MAX_RECIPIENTS || (options.send && total < 1) || !subject || /[\r\n\0]/.test(subject)) {
    invalid()
  }

  if (estimatedSize(attachments, request.body, quote ?? '') > MATRIX_GOOGLE_COMPOSE_MAX_BYTES) {
    throw new GmailMailError('message_too_large')
  }

  if (options.bytes) {
    for (const file of attachments) {
      if (!file.bytes && file.messageId && file.attachmentId) {
        file.bytes = await downloadAttachmentBytes(api, file.messageId, file.attachmentId, MATRIX_GOOGLE_COMPOSE_MAX_BYTES)
        file.size = file.bytes.length
        file.sha256 = createHash('sha256').update(file.bytes).digest('hex')
      }
    }
  }

  return {
    to: finalTo,
    cc: finalCc,
    bcc: finalBcc,
    subject,
    body: request.body,
    ...(quote ? { quote } : {}),
    ...(quoteTruncated ? { quoteTruncated: true as const } : {}),
    ...(forwardedFrom ? { forwardedFrom } : {}),
    ...(threadId ? { threadId } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references ? { references } : inReplyTo ? { references: [inReplyTo] } : {}),
    attachments
  }
}

/**
 * What the owner (and, in the cloud, the agent that must show the owner a draft) sees: the final
 * recipients, subject, text, the forwarded original's headers and a preview of its text, and the file
 * names with sizes. Never the bytes.
 */
export function composeSummary(message: ResolvedMessage): JsonRecord {
  return {
    to: message.to,
    ...(message.cc.length ? { cc: message.cc } : {}),
    ...(message.bcc.length ? { bcc: message.bcc } : {}),
    subject: message.subject,
    body: message.body,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
    ...(message.forwardedFrom ? {
      forwarded: {
        ...message.forwardedFrom,
        quotePreview: (message.quote ?? '').slice(0, QUOTE_PREVIEW_CHARS),
        quoteLength: (message.quote ?? '').length,
        ...(message.quoteTruncated || (message.quote ?? '').length > QUOTE_PREVIEW_CHARS ? { truncated: true } : {})
      }
    } : {}),
    attachments: message.attachments.map(file => ({
      filename: file.filename, mimeType: file.mimeType, size: file.size, ...(file.sha256 ? { sha256: file.sha256 } : {})
    }))
  }
}

/**
 * A request with its attachment bytes replaced by their name, type, size and SHA-256: the form that is
 * shown, compared and remembered, so a 20 MB file is never echoed and a changed file is still noticed.
 */
export function describeOutgoing<T extends { attachments?: MatrixGoogleOutgoingAttachment[] }>(request: T): Omit<T, 'attachments'> & {
  attachments?: Array<{ filename: string; mimeType: string; size: number; sha256: string }>
} {
  const { attachments, ...rest } = request

  return {
    ...rest,
    ...(attachments ? {
      attachments: attachments.map(file => {
        const attached = uploadedAttachment(file)

        return { filename: attached.filename, mimeType: attached.mimeType, size: attached.size, sha256: attached.sha256! }
      })
    } : {})
  }
}

// --- building ----------------------------------------------------------------------------------

/** RFC 2231 attribute characters: everything else is percent-encoded as UTF-8 bytes. */
const ATTRIBUTE_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/

function percentEncoded(character: string): string {
  return ATTRIBUTE_CHAR.test(character)
    ? character
    : [...Buffer.from(character, 'utf8')].map(byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('')
}

/**
 * A quoted-string for the ASCII fallback: accents are dropped (`Báo` -> `Bao`), anything else outside printable
 * ASCII becomes `_`, and `"` and `\\` are escaped.
 */
function quotedAscii(value: string): string {
  const plain = value.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')

  return `"${plain.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/g, match => `\\${match}`)}"`
}

/**
 * A MIME parameter (`filename`, `name`) as header parameters, one per entry. A plain ASCII value is just
 * `name="value"`. Anything else is RFC 2231: `name*=UTF-8''%C3%A1...` (or `name*0*=`, `name*1*=` continuations
 * when it is long), always next to an escaped ASCII `name="..."` fallback for readers that lack RFC 2231.
 * RFC 2047 encoded words are not allowed inside parameters (RFC 2047 section 5).
 */
export function mimeParameter(name: string, value: string): string[] {
  const fallback = `${name}=${quotedAscii(value)}`

  if (/^[\x20-\x7e]*$/.test(value)) {
    return [fallback]
  }

  const segments: string[] = ['']

  for (const character of value) {
    const piece = percentEncoded(character)

    if (segments[segments.length - 1]!.length + piece.length > 60 && segments[segments.length - 1] !== '') {
      segments.push('')
    }

    segments[segments.length - 1] += piece
  }

  const extended = segments.length === 1
    ? [`${name}*=UTF-8''${segments[0]}`]
    : segments.map((segment, index) => `${name}*${index}*=${index === 0 ? "UTF-8''" : ''}${segment}`)

  return [fallback, ...extended]
}

/** `Name: a, b, c`, folded at the commas so no line passes what relays accept. */
function addressHeader(name: string, addresses: readonly string[]): string {
  const lines: string[] = []
  let line = `${name}:`

  for (const address of addresses) {
    const next = `${line} ${address},`

    if (line.length > name.length + 1 && next.length > 900) {
      lines.push(line)
      line = ` ${address},`
    } else {
      line = next
    }
  }

  lines.push(line)

  return lines.join('\r\n').replace(/,$/, '')
}

/** Joins message ids onto folded lines so no header line grows past what relays accept. */
function foldIds(ids: readonly string[]): string {
  const lines: string[] = []
  let line = ''

  for (const id of ids) {
    if (line && line.length + 1 + id.length > 900) {
      lines.push(line)
      line = id
    } else {
      line = line ? `${line} ${id}` : id
    }
  }

  if (line) {
    lines.push(line)
  }

  return lines.join('\r\n ')
}

/**
 * The RFC 822 message. Plain text becomes one base64 part; with attachments it is `multipart/mixed` with a
 * text part and one base64 part per file. Throws `message_too_large` past Gmail's 25 MB and
 * `invalid_input` for a file whose bytes are not loaded.
 */
export function buildMimeMessage(message: ResolvedMessage, from?: string): Buffer {
  if (from !== undefined && (from.length > 254 || !ADDRESS.test(from))) {
    invalid()
  }

  const bodyText = message.quote ? `${message.body}${message.body ? '\n\n' : ''}${message.quote}` : message.body
  const textPart = foldBase64(Buffer.from(bodyText, 'utf8').toString('base64'))
  const references = message.references?.length ? message.references : message.inReplyTo ? [message.inReplyTo] : []

  const headers = [
    ...(from ? [`From: ${from}`] : []),
    ...(message.to.length ? [addressHeader('To', message.to)] : []),
    ...(message.cc.length ? [addressHeader('Cc', message.cc)] : []),
    ...(message.bcc.length ? [addressHeader('Bcc', message.bcc)] : []),
    `Subject: ${message.subject ? encodedSubject(message.subject) : ''}`,
    ...(message.inReplyTo ? [`In-Reply-To: ${message.inReplyTo}`] : []),
    ...(references.length ? [`References: ${foldIds(references)}`] : []),
    'MIME-Version: 1.0'
  ]

  let lines: string[]

  if (message.attachments.length === 0) {
    lines = [
      ...headers,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      textPart,
      ''
    ]
  } else {
    // Base64 never contains an underscore, so this boundary cannot occur in any encoded part.
    const boundary = `atum_${randomBytes(18).toString('hex')}`

    lines = [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      'This is a multi-part message in MIME format.',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      textPart
    ]

    for (const file of message.attachments) {
      if (!file.bytes) {
        invalid()
      }

      lines.push(
        `--${boundary}`,
        `Content-Type: ${[file.mimeType, ...mimeParameter('name', file.filename)].join(';\r\n ')}`,
        `Content-Disposition: ${['attachment', ...mimeParameter('filename', file.filename)].join(';\r\n ')}`,
        'Content-Transfer-Encoding: base64',
        '',
        foldBase64(file.bytes.toString('base64'))
      )
    }

    lines.push(`--${boundary}--`, '')
  }

  const mime = Buffer.from(lines.join('\r\n'), 'utf8')

  if (mime.length > MATRIX_GOOGLE_COMPOSE_MAX_BYTES) {
    throw new GmailMailError('message_too_large')
  }

  return mime
}

/** The same message as base64url, Gmail's `raw` form (kept for callers and tests that read a message back). */
export function buildRawMessage(message: ResolvedMessage, from?: string): string {
  return buildMimeMessage(message, from).toString('base64url')
}

export type UploadKind = 'send' | 'draft_create' | 'draft_update'

/**
 * The media-upload request for a message: Gmail's 35 MiB allowance is on `/upload/...`, not on the JSON
 * endpoint that carries `raw` (about 5 MB). `media` posts the RFC 822 bytes alone; when a thread (a reply) or a
 * draft id must be kept it is `multipart/related`: a JSON metadata part, then the `message/rfc822` part.
 */
export function messageUpload(kind: UploadKind, mime: Buffer, options: { threadId?: string; draftId?: string } = {}): GmailUpload {
  const path = kind === 'send' ? 'messages/send' : kind === 'draft_create' ? 'drafts' : `drafts/${encodeURIComponent(options.draftId ?? '')}`
  const method = kind === 'draft_update' ? 'PUT' : 'POST'
  const thread = options.threadId ? { threadId: options.threadId } : undefined
  const metadata = kind === 'send' ? thread : kind === 'draft_create' ? (thread ? { message: thread } : undefined) : { id: options.draftId, ...(thread ? { message: thread } : {}) }

  if (!metadata) {
    return { method, path, uploadType: 'media', contentType: 'message/rfc822', body: mime }
  }

  // A boundary that does not occur in the message (it is ASCII headers and base64, but check anyway).
  let boundary = ''

  do {
    boundary = `atum_upload_${randomBytes(18).toString('hex')}`
  } while (mime.includes(boundary))

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`, 'utf8'),
    mime,
    Buffer.from(`\r\n--${boundary}--`, 'utf8')
  ])

  return { method, path, uploadType: 'multipart', contentType: `multipart/related; boundary=${boundary}`, body }
}

// --- sending and drafts ------------------------------------------------------------------------

/** Sends one message through Gmail. The caller has already had the owner confirm exactly this. */
export async function sendMessage(
  api: GmailApi,
  request: Extract<ComposeRequest, { action: 'send_email' }>,
  context: ComposeContext,
  from?: string
): Promise<JsonRecord> {
  const message = await resolveCompose(api, request, context, { bytes: true, send: true })

  const sent = await api.upload(messageUpload('send', buildMimeMessage(message, from), { threadId: message.threadId }))

  return { done: true, messageId: text(sent.id, 200), threadId: text(sent.threadId, 200) }
}

/** Saves (never sends) a draft. `update_draft` replaces the draft's whole content. */
export async function writeDraft(
  api: GmailApi,
  request: Extract<ComposeRequest, { action: 'create_draft' | 'update_draft' }>,
  canManage: boolean,
  context: ComposeContext = {}
): Promise<JsonRecord> {
  if (!canManage) {
    throw new GmailMailError('scope_missing')
  }

  const update = request.action === 'update_draft'

  if (update && !request.draftId) {
    invalid()
  }

  const message = await resolveCompose(api, request, context, { bytes: true, send: false })

  const draft = await api.upload(messageUpload(update ? 'draft_update' : 'draft_create', buildMimeMessage(message), {
    threadId: message.threadId,
    draftId: request.draftId
  }))

  const saved = record(draft.message)

  return {
    done: true,
    action: request.action,
    draftId: text(draft.id, 200),
    messageId: text(saved.id, 200),
    threadId: text(saved.threadId, 200),
    sent: false,
    ...(message.attachments.length ? { attachments: message.attachments.map(file => file.filename) } : {})
  }
}
