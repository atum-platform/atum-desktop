import {
  isMatrixGoogleToolAction,
  MATRIX_GOOGLE_COMPOSE_REQUEST_MAX_BYTES,
  MATRIX_GOOGLE_MAX_OUTGOING_ATTACHMENTS,
  MATRIX_GOOGLE_MAX_RECIPIENTS_PER_LIST,
  type MatrixGoogleToolAction
} from './matrix-google-tools'

export type MatrixGoogleAgendaWhen =
  | 'today'
  | 'tomorrow'
  | 'today_and_tomorrow'
  | 'next_7d'
  | 'past_30d'
  | 'past_365d'

/** How `search_drive` orders results: last modified (default) or last viewed by the owner. */
export type MatrixGoogleDriveSort = 'modified' | 'viewed'

/** What `mailbox` does to a thread or message; each is reversible and none sends or deletes for good. */
export const MATRIX_GOOGLE_MAILBOX_OPERATIONS = [
  'archive', 'unarchive', 'mark_read', 'mark_unread', 'star', 'unstar',
  'trash', 'untrash', 'add_labels', 'remove_labels'
] as const

export type MatrixGoogleMailboxOperation = (typeof MATRIX_GOOGLE_MAILBOX_OPERATIONS)[number]

/** One file on outgoing mail: the workspace file's name, its type, and its bytes as standard base64. */
export interface MatrixGoogleOutgoingAttachment {
  filename: string
  mimeType?: string
  data: string
}

/**
 * What an outgoing message (send_email, create_draft, update_draft) can carry beyond a plain To list.
 * `reply` and `forward` name a message in the same mailbox; the recipients, the Re:/Fwd: subject, the
 * thread headers and (forward) the quoted original and its files are then worked out from that message.
 */
export interface MatrixGoogleComposeFields {
  cc?: string[]
  bcc?: string[]
  reply?: { messageId: string; all?: boolean }
  forward?: { messageId: string; attachments?: boolean }
  attachments?: MatrixGoogleOutgoingAttachment[]
}

/** The one closed request grammar shared by Desktop's loopback and the cloud controller broker. */
export type MatrixGoogleToolRequest =
  | { action: 'status' }
  | { action: 'agenda'; when: MatrixGoogleAgendaWhen }
  | { action: 'waiting' }
  | { action: 'search_mail'; query: string; sourceId?: string; pageToken?: string }
  | { action: 'read_thread'; sourceId: string; threadId: string }
  | { action: 'search_drive'; query?: string; sort?: MatrixGoogleDriveSort; modifiedAfter?: string }
  | { action: 'read_file'; sourceId: string; fileId: string }
  | ({
      action: 'send_email'
      sourceId: string
      /** Empty only when `reply` names who it answers. */
      to: string[]
      /** Empty only with `reply` or `forward`, which derive it (Re:/Fwd: of the original). */
      subject: string
      body: string
      threadId?: string
      inReplyTo?: string
      operationId?: string
    } & MatrixGoogleComposeFields)
  | { action: 'read_message'; sourceId: string; messageId: string; offset?: number }
  | { action: 'download_attachment'; sourceId: string; messageId: string; attachmentId: string }
  | { action: 'list_labels'; sourceId: string }
  | { action: 'list_drafts'; sourceId: string; pageToken?: string }
  | {
      action: 'mailbox'
      sourceId: string
      operation: MatrixGoogleMailboxOperation
      /** Exactly one of the two names what to change. */
      threadId?: string
      messageId?: string
      /** Label names or ids, for add_labels / remove_labels only. */
      labels?: string[]
    }
  | { action: 'create_label'; sourceId: string; name: string }
  | ({
      action: 'create_draft' | 'update_draft'
      sourceId: string
      draftId?: string
      to: string[]
      subject: string
      body: string
      threadId?: string
      inReplyTo?: string
    } & MatrixGoogleComposeFields)
  | {
      action: 'create_event' | 'update_event'
      sourceId: string
      eventId?: string
      title: string
      start: string
      end: string
      location?: string
      description?: string
      operationId?: string
    }

/** Every argument each action accepts; anything else is refused, never ignored. */
const ALLOWED: Record<MatrixGoogleToolAction, readonly string[]> = {
  status: [],
  agenda: ['when'],
  waiting: [],
  search_mail: ['query', 'sourceId', 'pageToken'],
  read_thread: ['sourceId', 'threadId'],
  search_drive: ['query', 'sort', 'modifiedAfter'],
  read_file: ['sourceId', 'fileId'],
  send_email: ['sourceId', 'to', 'cc', 'bcc', 'subject', 'body', 'threadId', 'inReplyTo', 'reply', 'forward', 'attachments', 'operationId'],
  create_event: ['sourceId', 'title', 'start', 'end', 'location', 'description', 'operationId'],
  update_event: ['sourceId', 'eventId', 'title', 'start', 'end', 'location', 'description', 'operationId'],
  read_message: ['sourceId', 'messageId', 'offset'],
  download_attachment: ['sourceId', 'messageId', 'attachmentId'],
  list_labels: ['sourceId'],
  list_drafts: ['sourceId', 'pageToken'],
  mailbox: ['sourceId', 'operation', 'threadId', 'messageId', 'labels'],
  create_label: ['sourceId', 'name'],
  create_draft: ['sourceId', 'to', 'cc', 'bcc', 'subject', 'body', 'threadId', 'inReplyTo', 'reply', 'forward', 'attachments'],
  update_draft: ['sourceId', 'draftId', 'to', 'cc', 'bcc', 'subject', 'body', 'threadId', 'inReplyTo', 'reply', 'forward', 'attachments']
}

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const optionalText = (value: unknown, max: number) => value === undefined || (typeof value === 'string' && value.length <= max)

const AGENDA_WHEN: ReadonlySet<string> = new Set([
  'today', 'tomorrow', 'today_and_tomorrow', 'next_7d', 'past_30d', 'past_365d'
])

/** A day (`2026-10-27`) or an RFC 3339 instant; the executors normalize it before querying Drive. */
const MODIFIED_AFTER = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/
/** An opaque provider cursor. URLSearchParams performs encoding; only length/control bytes are ours to constrain. */
function pageToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 512 &&
    [...value].every(character => {
      const code = character.codePointAt(0)!
      return code >= 0x20 && code !== 0x7f
    })
}

/** A real calendar day: Date.parse would otherwise normalize 2026-02-31 into March. */
function realCalendarDay(value: string): boolean {
  const match = CALENDAR_DATE.exec(value)
  if (!match) {
    return false
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function driveModifiedAfter(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && MODIFIED_AFTER.test(value) &&
    realCalendarDay(value) && Number.isFinite(Date.parse(value))
}

const MAILBOX_OPERATIONS: ReadonlySet<string> = new Set(MATRIX_GOOGLE_MAILBOX_OPERATIONS)
/** Gmail ids are short; attachment ids are long opaque strings. */
const GMAIL_ID = /^[A-Za-z0-9_-]{1,200}$/
const ATTACHMENT_ID = /^[A-Za-z0-9_-]{1,1500}$/
const DRAFT_ID = /^[A-Za-z0-9_-]{1,200}$/
const MAX_MESSAGE_OFFSET = 50_000_000
const MAX_LABELS = 10

function gmailId(value: unknown): value is string {
  return typeof value === 'string' && GMAIL_ID.test(value)
}

/** A file name is one plain name: no control characters, no path separators. */
function plainFilename(value: string): boolean {
  return ![...value].some(character => {
    const code = character.charCodeAt(0)

    return code < 0x20 || code === 0x7f || character === '/' || character === '\\'
  })
}
const MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

function addressList(value: unknown, max = MATRIX_GOOGLE_MAX_RECIPIENTS_PER_LIST): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(address => text(address, 254))
}

function outgoingAttachments(value: unknown): value is MatrixGoogleOutgoingAttachment[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MATRIX_GOOGLE_MAX_OUTGOING_ATTACHMENTS) {
    return false
  }

  let encoded = 0

  return value.every(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some(key => !['filename', 'mimeType', 'data'].includes(key))) {
      return false
    }

    const file = item as Record<string, unknown>
    encoded += typeof file.data === 'string' ? file.data.length : Infinity

    return text(file.filename, 255) && plainFilename(file.filename) &&
      (file.mimeType === undefined || (typeof file.mimeType === 'string' && MIME_TYPE.test(file.mimeType))) &&
      typeof file.data === 'string' && file.data.length % 4 === 0 && BASE64.test(file.data) &&
      encoded <= MATRIX_GOOGLE_COMPOSE_REQUEST_MAX_BYTES
  })
}

type ComposeRow = Pick<Extract<MatrixGoogleToolRequest, { action: 'send_email' }>,
  'to' | 'subject' | 'body' | 'threadId' | 'inReplyTo' | keyof MatrixGoogleComposeFields>

/**
 * The shared shape of an outgoing message. A `reply` or `forward` derives the recipients' base, the
 * subject and (reply) the thread from the message it names, so those fields are then absent; every
 * other message names its own To and Subject. Deeper checks (address syntax, sizes, headers) stay with
 * the adapter in gmail-compose.ts.
 */
function parseCompose(row: Record<string, unknown>, action: 'send_email' | 'create_draft' | 'update_draft'): ComposeRow | null {
  const reply = row.reply
  const forward = row.forward
  const derived = reply !== undefined || forward !== undefined
  const to = row.to === undefined ? [] : row.to
  const subject = row.subject === undefined ? '' : row.subject

  if ((reply !== undefined && forward !== undefined) || !addressList(to) || !addressList(row.cc ?? []) ||
      !addressList(row.bcc ?? []) || typeof subject !== 'string' || subject.length > 500 ||
      typeof row.body !== 'string' || row.body.length > 20_000 ||
      !optionalText(row.threadId, 200) || !optionalText(row.inReplyTo, 1000)) {
    return null
  }

  if (derived) {
    // Derived from the original: never a hand-written thread or reply header; a reply's To comes from the
    // message it answers (add people with cc or bcc), while a forward names its own To.
    if (row.threadId || row.inReplyTo || (reply !== undefined && to.length) ||
        (forward !== undefined && action === 'send_email' && !to.length)) {
      return null
    }
  } else if (!subject || (action === 'send_email' ? !to.length : Boolean(row.threadId) !== Boolean(row.inReplyTo))) {
    return null
  }

  const one = (value: unknown, flag: string): { messageId: string; flag?: boolean } | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }

    const part = value as Record<string, unknown>

    if (Object.keys(part).some(key => key !== 'messageId' && key !== flag) || !gmailId(part.messageId) ||
        (part[flag] !== undefined && typeof part[flag] !== 'boolean')) {
      return null
    }

    return { messageId: part.messageId, ...(part[flag] === undefined ? {} : { flag: part[flag] as boolean }) }
  }

  const replyPart = reply === undefined ? undefined : one(reply, 'all')
  const forwardPart = forward === undefined ? undefined : one(forward, 'attachments')

  if (replyPart === null || forwardPart === null || (row.attachments !== undefined && !outgoingAttachments(row.attachments))) {
    return null
  }

  return {
    to,
    subject,
    body: row.body,
    ...(Array.isArray(row.cc) && row.cc.length ? { cc: row.cc as string[] } : {}),
    ...(Array.isArray(row.bcc) && row.bcc.length ? { bcc: row.bcc as string[] } : {}),
    ...(row.threadId ? { threadId: row.threadId as string } : {}),
    ...(row.inReplyTo ? { inReplyTo: row.inReplyTo as string } : {}),
    ...(replyPart ? { reply: { messageId: replyPart.messageId, ...(replyPart.flag === undefined ? {} : { all: replyPart.flag }) } } : {}),
    ...(forwardPart ? { forward: { messageId: forwardPart.messageId, ...(forwardPart.flag === undefined ? {} : { attachments: forwardPart.flag }) } } : {}),
    ...(row.attachments ? { attachments: row.attachments as MatrixGoogleOutgoingAttachment[] } : {})
  }
}

/** The assistant's request, shape-checked; deeper checks stay with the provider adapter. */
export function parseMatrixGoogleToolRequest(value: unknown): MatrixGoogleToolRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const row = value as Record<string, unknown>
  const action = row.action
  if (!isMatrixGoogleToolAction(action)) {
    return null
  }
  if (Object.keys(row).some(key => key !== 'action' && !ALLOWED[action].includes(key))) {
    return null
  }

  switch (action) {
    case 'status':
    case 'waiting':
      return { action }
    case 'agenda': {
      const when = row.when ?? 'today_and_tomorrow'
      return typeof when === 'string' && AGENDA_WHEN.has(when) ? { action, when: when as MatrixGoogleAgendaWhen } : null
    }
    case 'search_mail':
      // A page cursor belongs to one mailbox, so the next page always names that mailbox too.
      if (!text(row.query, 500) || !optionalText(row.sourceId, 500) ||
          (row.pageToken !== undefined && (!pageToken(row.pageToken) || !row.sourceId))) {
        return null
      }
      return {
        action, query: row.query,
        ...(row.sourceId ? { sourceId: row.sourceId as string } : {}),
        ...(row.pageToken ? { pageToken: row.pageToken as string } : {})
      }
    case 'read_thread':
      return text(row.sourceId, 500) && text(row.threadId, 200)
        ? { action, sourceId: row.sourceId, threadId: row.threadId } : null
    case 'search_drive':
      if (!optionalText(row.query, 500) ||
          (row.sort !== undefined && row.sort !== 'modified' && row.sort !== 'viewed') ||
          (row.modifiedAfter !== undefined && !driveModifiedAfter(row.modifiedAfter))) {
        return null
      }
      return {
        action,
        ...(row.query ? { query: row.query as string } : {}),
        ...(row.sort ? { sort: row.sort as MatrixGoogleDriveSort } : {}),
        ...(row.modifiedAfter ? { modifiedAfter: row.modifiedAfter as string } : {})
      }
    case 'read_file':
      return text(row.sourceId, 500) && text(row.fileId, 200)
        ? { action, sourceId: row.sourceId, fileId: row.fileId } : null
    case 'send_email': {
      const compose = text(row.sourceId, 500) && optionalText(row.operationId, 36) ? parseCompose(row, action) : null
      if (!compose) {
        return null
      }
      return {
        action, sourceId: row.sourceId as string, ...compose,
        ...(row.operationId ? { operationId: row.operationId as string } : {})
      }
    }
    case 'read_message':
      if (!text(row.sourceId, 500) || !gmailId(row.messageId) ||
          (row.offset !== undefined && (!Number.isSafeInteger(row.offset) || (row.offset as number) < 0 ||
            (row.offset as number) > MAX_MESSAGE_OFFSET))) {
        return null
      }
      return {
        action, sourceId: row.sourceId, messageId: row.messageId,
        ...(row.offset ? { offset: row.offset as number } : {})
      }
    case 'download_attachment':
      return text(row.sourceId, 500) && gmailId(row.messageId) &&
        typeof row.attachmentId === 'string' && ATTACHMENT_ID.test(row.attachmentId)
        ? { action, sourceId: row.sourceId, messageId: row.messageId, attachmentId: row.attachmentId } : null
    case 'list_labels':
      return text(row.sourceId, 500) ? { action, sourceId: row.sourceId } : null
    case 'list_drafts':
      if (!text(row.sourceId, 500) || (row.pageToken !== undefined && !pageToken(row.pageToken))) {
        return null
      }
      return { action, sourceId: row.sourceId, ...(row.pageToken ? { pageToken: row.pageToken as string } : {}) }
    case 'mailbox': {
      const labelled = row.operation === 'add_labels' || row.operation === 'remove_labels'
      // A change names one thread or one message, and only the label operations carry labels.
      if (!text(row.sourceId, 500) || typeof row.operation !== 'string' || !MAILBOX_OPERATIONS.has(row.operation) ||
          (row.threadId === undefined) === (row.messageId === undefined) ||
          (row.threadId !== undefined && !gmailId(row.threadId)) ||
          (row.messageId !== undefined && !gmailId(row.messageId)) ||
          (labelled
            ? !Array.isArray(row.labels) || row.labels.length < 1 || row.labels.length > MAX_LABELS ||
              !row.labels.every(label => text(label, 225))
            : row.labels !== undefined)) {
        return null
      }
      return {
        action, sourceId: row.sourceId, operation: row.operation as MatrixGoogleMailboxOperation,
        ...(row.threadId ? { threadId: row.threadId as string } : {}),
        ...(row.messageId ? { messageId: row.messageId as string } : {}),
        ...(labelled ? { labels: row.labels as string[] } : {})
      }
    }
    case 'create_label':
      return text(row.sourceId, 500) && text(row.name, 225) ? { action, sourceId: row.sourceId, name: row.name } : null
    case 'create_draft':
    case 'update_draft': {
      // A hand-written reply names both its thread and the message it answers, or neither (as send_email).
      const compose = text(row.sourceId, 500) ? parseCompose(row, action) : null
      if (!compose || (action === 'update_draft'
        ? typeof row.draftId !== 'string' || !DRAFT_ID.test(row.draftId) : row.draftId !== undefined)) {
        return null
      }
      return {
        action, sourceId: row.sourceId as string,
        ...(action === 'update_draft' ? { draftId: row.draftId as string } : {}),
        ...compose
      }
    }
    case 'create_event':
    case 'update_event':
      if (!text(row.sourceId, 500) || !text(row.title, 500) || !text(row.start, 64) || !text(row.end, 64) ||
          !optionalText(row.location, 1000) || !optionalText(row.description, 20_000) ||
          !optionalText(row.operationId, 36) ||
          (action === 'update_event' ? !text(row.eventId, 1024) : row.eventId !== undefined)) {
        return null
      }
      return {
        action, sourceId: row.sourceId,
        ...(action === 'update_event' ? { eventId: row.eventId as string } : {}),
        title: row.title, start: row.start, end: row.end,
        ...(row.location !== undefined ? { location: row.location as string } : {}),
        ...(row.description !== undefined ? { description: row.description as string } : {}),
        ...(row.operationId ? { operationId: row.operationId as string } : {})
      }
  }
}
