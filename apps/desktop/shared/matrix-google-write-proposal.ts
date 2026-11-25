/**
 * Google write confirmation cards (docs/google-write-confirmation.md), built to Shell's native
 * proposal card and owner endpoint contract.
 *
 * When the assistant wants to send an email or add or change a calendar event, Shell keeps the
 * exact draft as a pending proposal. The desktop reads the owner's pending proposals from
 * `GET /api/connections/google/proposals` (never from the conversation: nothing about a proposal is
 * posted into the room) and shows each as a native card in its agent's chat. The owner's Approve
 * or Decline is sent back with the digest of the draft the card rendered.
 *
 * The card authorises exactly what it shows: parsing is strict (exact keys, no extra field is
 * carried), every field the owner needs is rendered, and the digest is recomputed here from the
 * parsed draft with the platform's own canonical JSON. A draft whose digest is not the proposal's
 * is never offered for approval.
 */
import { canonicalJson } from '../../../packages/device-protocol/canonical'

/** The bridge contract every owner proposal request names (`X-Atum-Host-Bridge-Contract`). */
export const MATRIX_GOOGLE_HOST_BRIDGE_CONTRACT = 'atum.s2.host-bridge/1.0.0'
export const MATRIX_GOOGLE_HOST_BRIDGE_HEADER = 'X-Atum-Host-Bridge-Contract'
/** The owner endpoints' path on the domain (`/{proposalId}/delivered|approve|decline` below it). */
export const MATRIX_GOOGLE_PROPOSALS_PATH = '/api/connections/google/proposals'

export interface MatrixGoogleWriteAttachment {
  filename: string
  mimeType: string
  /** Bytes. */
  size: number
  /** Hex SHA-256 of the file, once Shell knows it. */
  sha256?: string
}

/** The original a forward quotes, as Shell resolved it. */
export interface MatrixGoogleWriteForwarded {
  messageId: string
  from: string
  date: string
  subject: string
  quotePreview: string
  quoteLength: number
  truncated?: true
}

/** An email draft exactly as Shell resolved it (it carries no `action`). */
export interface MatrixGoogleWriteEmail {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  /** Plain text, shown exactly (line breaks kept, never rendered as markdown). */
  body: string
  /** The forwarded original appended under the body; empty when there is none. */
  quote: string
  references: string[]
  threadId?: string
  inReplyTo?: string
  forwarded?: MatrixGoogleWriteForwarded
  attachments: MatrixGoogleWriteAttachment[]
}

/** A calendar draft: the exact requested event fields. */
export interface MatrixGoogleWriteEvent {
  action: 'create_event' | 'update_event'
  sourceId: string
  /** Present exactly for `update_event`. */
  eventId?: string
  title: string
  /** RFC 3339 instants with an explicit offset. */
  start: string
  end: string
  location?: string
  description?: string
}

export type MatrixGoogleWriteDraft = MatrixGoogleWriteEmail | MatrixGoogleWriteEvent

export type MatrixGoogleWriteKind = 'send_email' | 'create_event' | 'update_event'

export interface MatrixGoogleWriteProposal {
  proposalId: string
  /** Server-bound agent id; one pending proposal per agent and room. */
  agent: string
  /** The Matrix room the card belongs in. */
  room: string
  /** 64 lowercase hex: SHA-256 of the draft's canonical JSON. */
  digest: string
  draft: MatrixGoogleWriteDraft
}

export type MatrixGoogleWriteAction = 'delivered' | 'approve' | 'decline'

/** What the renderer asks main to send: the card it shows and the digest it rendered. */
export interface MatrixGoogleWriteActionInput {
  proposalId: string
  digest: string
  action: MatrixGoogleWriteAction
}

/** Shell's refusal (400/401/403/409) or its unavailability (503, or no usable answer at all). */
export type MatrixGoogleWriteFailure = { state: 'refused' } | { state: 'unavailable' }

export type MatrixGoogleWriteListAnswer =
  | {
      state: 'ok'
      proposals: MatrixGoogleWriteProposal[]
      /** The owner's Work proposals (at most one). Absent from an older main. */
      work?: MatrixGoogleWorkProposal[]
      /** The Matrix user the list was read for; Work cards show only while it is the account on screen. */
      owner?: string
    }
  | MatrixGoogleWriteFailure

/** What Shell records for each action. Approve confirms; it never sends anything itself. */
export const MATRIX_GOOGLE_WRITE_STATUS = { delivered: 'delivered', approve: 'confirmed', decline: 'declined' } as const

export type MatrixGoogleWriteActionAnswer =
  | { state: 'ok'; status: (typeof MATRIX_GOOGLE_WRITE_STATUS)[MatrixGoogleWriteAction] }
  | MatrixGoogleWriteFailure

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const ROOM = /^![^\s,]{1,1023}$/u
const ADDRESS = /^[^\s@,<>]{1,200}@[^\s@,<>]{1,200}$/u
// RFC 3339 with an explicit offset: the instant Shell will write.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u
// In unicode mode a paired surrogate is one code point, so this matches only a lone one.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u

const TEXT_MAX = 200_000
const LINE_MAX = 2_000
const LIST_MAX = 100
/** More proposals than an owner could have open at once. */
const PROPOSALS_MAX = 200

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Exactly `required`, plus any of `optional`, and nothing else. */
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return (
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key))
  )
}

/** Lone surrogates cannot be digested canonically, so they are not a draft. */
function text(value: unknown, max = TEXT_MAX): value is string {
  return typeof value === 'string' && value.length <= max && !LONE_SURROGATE.test(value)
}

function line(value: unknown, max = LINE_MAX): value is string {
  return text(value, max) && !/[\r\n\0]/u.test(value)
}

function filled(value: unknown): value is string {
  return line(value) && value.trim() !== ''
}

function addresses(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= LIST_MAX && value.every(item => line(item, 254) && ADDRESS.test(item))
}

function size(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function attachment(value: unknown): value is MatrixGoogleWriteAttachment {
  return (
    record(value) &&
    keys(value, ['filename', 'mimeType', 'size'], ['sha256']) &&
    filled(value.filename) &&
    line(value.mimeType) &&
    size(value.size) &&
    (value.sha256 === undefined || (typeof value.sha256 === 'string' && DIGEST.test(value.sha256)))
  )
}

function forwarded(value: unknown): value is MatrixGoogleWriteForwarded {
  return (
    record(value) &&
    keys(value, ['messageId', 'from', 'date', 'subject', 'quotePreview', 'quoteLength'], ['truncated']) &&
    line(value.messageId) &&
    line(value.from) &&
    line(value.date) &&
    line(value.subject) &&
    text(value.quotePreview) &&
    size(value.quoteLength) &&
    (value.truncated === undefined || value.truncated === true)
  )
}

function email(
  value: Record<string, unknown>,
  extra: { required?: readonly string[]; optional?: readonly string[] } = {}
): value is Record<string, unknown> & MatrixGoogleWriteEmail {
  if (
    !keys(
      value,
      ['to', 'subject', 'body', 'quote', 'references', 'attachments', ...(extra.required ?? [])],
      ['cc', 'bcc', 'threadId', 'inReplyTo', 'forwarded', ...(extra.optional ?? [])]
    )
  ) {
    return false
  }

  const recipients = [value.to, value.cc ?? [], value.bcc ?? []]

  return (
    recipients.every(addresses) &&
    recipients.some(list => (list as string[]).length > 0) &&
    filled(value.subject) &&
    text(value.body) &&
    text(value.quote) &&
    Array.isArray(value.references) &&
    value.references.length <= LIST_MAX &&
    value.references.every(item => line(item)) &&
    Array.isArray(value.attachments) &&
    value.attachments.length <= LIST_MAX &&
    value.attachments.every(attachment) &&
    (value.threadId === undefined || filled(value.threadId)) &&
    (value.inReplyTo === undefined || filled(value.inReplyTo)) &&
    (value.forwarded === undefined || forwarded(value.forwarded))
  )
}

function instant(value: unknown): value is string {
  return typeof value === 'string' && DATE_TIME.test(value) && Number.isFinite(Date.parse(value))
}

function calendar(value: Record<string, unknown>): value is Record<string, unknown> & MatrixGoogleWriteEvent {
  const update = value.action === 'update_event'

  return (
    (value.action === 'create_event' || update) &&
    keys(
      value,
      ['action', 'sourceId', 'title', 'start', 'end', ...(update ? ['eventId'] : [])],
      ['location', 'description']
    ) &&
    filled(value.sourceId) &&
    (!update || filled(value.eventId)) &&
    filled(value.title) &&
    instant(value.start) &&
    instant(value.end) &&
    (value.location === undefined || line(value.location)) &&
    (value.description === undefined || text(value.description))
  )
}

/** The draft exactly as given, or undefined for anything the card could not show faithfully. */
export function parseMatrixGoogleWriteDraft(value: unknown): MatrixGoogleWriteDraft | undefined {
  if (!record(value)) {
    return undefined
  }

  // A calendar draft names its action; an email draft is Shell's resolved message and names none.
  if (Object.hasOwn(value, 'action')) {
    return calendar(value) ? value : undefined
  }

  return email(value) ? value : undefined
}

export function matrixGoogleWriteKind(draft: MatrixGoogleWriteDraft): MatrixGoogleWriteKind {
  return 'action' in draft ? draft.action : 'send_email'
}

/** One entry of the pending list, or undefined for anything else (it then shows nothing). */
export function parseMatrixGoogleWriteProposal(value: unknown): MatrixGoogleWriteProposal | undefined {
  if (!record(value) || !keys(value, ['proposalId', 'operationId', 'agent', 'room', 'draft', 'digest', 'status'])) {
    return undefined
  }

  const draft = parseMatrixGoogleWriteDraft(value.draft)

  return typeof value.proposalId === 'string' &&
    UUID.test(value.proposalId) &&
    value.operationId === value.proposalId &&
    typeof value.agent === 'string' &&
    UUID.test(value.agent) &&
    typeof value.room === 'string' &&
    ROOM.test(value.room) &&
    typeof value.digest === 'string' &&
    DIGEST.test(value.digest) &&
    value.status === 'awaiting_owner' &&
    draft
    ? { proposalId: value.proposalId, agent: value.agent, room: value.room, digest: value.digest, draft }
    : undefined
}

/**
 * The pending list's body. A malformed entry is dropped on its own; only one proposal per agent
 * and room is kept (Shell retains one, so a second is a race and the first stands).
 */
export function parseMatrixGoogleWriteProposalList(value: unknown): MatrixGoogleWriteProposal[] | undefined {
  if (!record(value) || !keys(value, ['proposals']) || !Array.isArray(value.proposals) || value.proposals.length > PROPOSALS_MAX) {
    return undefined
  }

  const seen = new Set<string>()

  return value.proposals.flatMap(entry => {
    const proposal = parseMatrixGoogleWriteProposal(entry)
    const slot = proposal && matrixGoogleWriteSlot(proposal)

    if (!proposal || !slot || seen.has(slot)) {
      return []
    }

    seen.add(slot)

    return [proposal]
  })
}

/** The one-pending-proposal slot a proposal holds. */
export function matrixGoogleWriteSlot(proposal: Pick<MatrixGoogleWriteProposal, 'agent' | 'room'>): string {
  return `${proposal.agent}\n${proposal.room}`
}

/** Lowercase hex SHA-256 of the UTF-8 canonical JSON (the platform's `canonicalJson`). */
export async function matrixGoogleWriteDigest(value: MatrixGoogleWriteDraft | MatrixGoogleWorkDraft): Promise<string> {
  const bytes = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)))
  )

  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** The action request's own shape, as main re-reads it from the window. */
export function parseMatrixGoogleWriteActionInput(value: unknown): MatrixGoogleWriteActionInput | undefined {
  return record(value) &&
    keys(value, ['proposalId', 'digest', 'action']) &&
    typeof value.proposalId === 'string' &&
    UUID.test(value.proposalId) &&
    typeof value.digest === 'string' &&
    DIGEST.test(value.digest) &&
    (value.action === 'delivered' || value.action === 'approve' || value.action === 'decline')
    ? { proposalId: value.proposalId, digest: value.digest, action: value.action }
    : undefined
}

/*
 * Work proposals (docs/google-write-confirmation.md, "Work"). The owner's own Work on this Mac can ask
 * for the same Google changes an assistant can, plus Gmail's mailbox, label and draft changes. Shell
 * lists them in the same owner list with `source: "work"` and no agent or room: they belong to the
 * account, never to an agent chat, and wait behind the same card and the same owner endpoint.
 */

/** What `mailbox` does to one conversation or one email. Each is reversible; none sends. */
export const MATRIX_GOOGLE_MAILBOX_OPERATIONS = [
  'archive',
  'unarchive',
  'mark_read',
  'mark_unread',
  'star',
  'unstar',
  'trash',
  'untrash',
  'add_labels',
  'remove_labels'
] as const

export type MatrixGoogleMailboxOperation = (typeof MATRIX_GOOGLE_MAILBOX_OPERATIONS)[number]

/** A Gmail draft to save or update: the resolved message plus where it goes. */
export interface MatrixGoogleWriteGmailDraft extends MatrixGoogleWriteEmail {
  action: 'create_draft' | 'update_draft'
  sourceId: string
  /** Present exactly for `update_draft`. */
  draftId?: string
}

/** A change to one conversation (`threadId`) or one email (`messageId`); exactly one is named. */
export interface MatrixGoogleWriteMailbox {
  action: 'mailbox'
  sourceId: string
  operation: MatrixGoogleMailboxOperation
  threadId?: string
  messageId?: string
  /** Label names, for add_labels / remove_labels only. */
  labels?: string[]
}

export interface MatrixGoogleWriteLabel {
  action: 'create_label'
  sourceId: string
  name: string
}

/** Every draft a Work proposal can carry: the seven Google changes. */
export type MatrixGoogleWorkDraft =
  | MatrixGoogleWriteDraft
  | MatrixGoogleWriteGmailDraft
  | MatrixGoogleWriteMailbox
  | MatrixGoogleWriteLabel

export type MatrixGoogleWorkKind = MatrixGoogleWriteKind | 'create_draft' | 'update_draft' | 'mailbox' | 'create_label'

export interface MatrixGoogleWorkProposal {
  proposalId: string
  /** 64 lowercase hex: SHA-256 of the draft's canonical JSON. */
  digest: string
  draft: MatrixGoogleWorkDraft
}

const GMAIL_ID = /^[A-Za-z0-9_-]{1,200}$/u
const MAILBOX = new Set<string>(MATRIX_GOOGLE_MAILBOX_OPERATIONS)
const LABELS_MAX = 10

function gmailDraft(value: Record<string, unknown>): value is Record<string, unknown> & MatrixGoogleWriteGmailDraft {
  const update = value.action === 'update_draft'

  return (
    (value.action === 'create_draft' || update) &&
    email(value, { required: ['action', 'sourceId', ...(update ? ['draftId'] : [])] }) &&
    filled(value.sourceId) &&
    (!update || (typeof value.draftId === 'string' && GMAIL_ID.test(value.draftId)))
  )
}

function mailbox(value: Record<string, unknown>): value is Record<string, unknown> & MatrixGoogleWriteMailbox {
  const labelled = value.operation === 'add_labels' || value.operation === 'remove_labels'

  return (
    keys(value, ['action', 'sourceId', 'operation', ...(labelled ? ['labels'] : [])], ['threadId', 'messageId']) &&
    filled(value.sourceId) &&
    typeof value.operation === 'string' &&
    MAILBOX.has(value.operation) &&
    // One conversation or one email, never both and never neither.
    (value.threadId === undefined) !== (value.messageId === undefined) &&
    (value.threadId === undefined || (typeof value.threadId === 'string' && GMAIL_ID.test(value.threadId))) &&
    (value.messageId === undefined || (typeof value.messageId === 'string' && GMAIL_ID.test(value.messageId))) &&
    (!labelled ||
      (Array.isArray(value.labels) &&
        value.labels.length >= 1 &&
        value.labels.length <= LABELS_MAX &&
        value.labels.every(label => filled(label) && (label as string).length <= 225)))
  )
}

function label(value: Record<string, unknown>): value is Record<string, unknown> & MatrixGoogleWriteLabel {
  return keys(value, ['action', 'sourceId', 'name']) && filled(value.sourceId) && filled(value.name) && (value.name as string).length <= 225
}

/** A Work draft exactly as given, or undefined for anything the card could not show faithfully. */
export function parseMatrixGoogleWorkDraft(value: unknown): MatrixGoogleWorkDraft | undefined {
  if (!record(value)) {
    return undefined
  }

  switch (value.action) {
    case 'create_draft':

    case 'update_draft':
      return gmailDraft(value) ? value : undefined

    case 'mailbox':
      return mailbox(value) ? value : undefined

    case 'create_label':
      return label(value) ? value : undefined

    default:
      return parseMatrixGoogleWriteDraft(value)
  }
}

export function matrixGoogleWorkKind(draft: MatrixGoogleWorkDraft): MatrixGoogleWorkKind {
  return 'action' in draft ? draft.action : 'send_email'
}

/** One Work entry of the owner list, or undefined for anything else (an agent's entry included). */
export function parseMatrixGoogleWorkProposal(value: unknown): MatrixGoogleWorkProposal | undefined {
  if (
    !record(value) ||
    !keys(value, ['proposalId', 'operationId', 'agent', 'room', 'draft', 'digest', 'status', 'source']) ||
    value.source !== 'work' ||
    value.agent !== null ||
    value.room !== null
  ) {
    return undefined
  }

  const draft = parseMatrixGoogleWorkDraft(value.draft)

  return typeof value.proposalId === 'string' &&
    UUID.test(value.proposalId) &&
    value.operationId === value.proposalId &&
    typeof value.digest === 'string' &&
    DIGEST.test(value.digest) &&
    value.status === 'awaiting_owner' &&
    draft
    ? { proposalId: value.proposalId, digest: value.digest, draft }
    : undefined
}

/**
 * The owner list's Work entries. Shell keeps one open Work proposal per owner (a new one supersedes
 * the last), so only the first well-formed one is kept; a second is a race and the first stands.
 */
export function parseMatrixGoogleWorkProposalList(value: unknown): MatrixGoogleWorkProposal[] | undefined {
  if (!record(value) || !keys(value, ['proposals']) || !Array.isArray(value.proposals) || value.proposals.length > PROPOSALS_MAX) {
    return undefined
  }

  for (const entry of value.proposals) {
    const proposal = parseMatrixGoogleWorkProposal(entry)

    if (proposal) {
      return [proposal]
    }
  }

  return []
}
