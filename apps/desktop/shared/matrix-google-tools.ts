/**
 * Google for the default assistant (launch items G2-08 and the Google fence, G2-19).
 *
 * One consent connects Gmail, Calendar and Drive; the person may untick any of them. The
 * default assistant then reads and, after the owner confirms the exact message or event,
 * writes through a main-owned broker (electron/matrix/google-tools.ts). Google data may
 * reach a model only through the protected route below, never another agent, a group room,
 * logs or telemetry .
 */

/**
 * The gateway alias that is the protected model route: the model named in Google's review,
 * served with zero data retention and no training (Google's Limited Use policy). The gateway
 * must never map it to any other route. Until the gateway lists it in `/v1/models`, the
 * assistant gets no Google tools and nothing from Google reaches a model.
 */
export const MATRIX_GOOGLE_PROTECTED_MODEL = 'google-protected'

/** The Matrix key on agent-authored events derived from Google data (spec/awareness/v1 §3.7). */
export const MATRIX_GOOGLE_PROVENANCE_KEY = 'io.atum.provenance'
export const MATRIX_GOOGLE_PROVENANCE = { v: 1, google: true } as const

/** What the person allowed in the one consent, summed over their connected accounts. */
export interface MatrixGoogleServices {
  gmail: boolean
  /** Sending needs its own permission; reading Gmail without it still works. */
  send: boolean
  calendar: boolean
  drive: boolean
}

/**
 * Whether the default assistant can use Google: the seam the first-run connector card,
 * post-skip chip and Settings read from the snapshot.
 * - `unavailable`: don't offer Google. `reason` says why, for Settings: Atum's protected
 *   model isn't served yet (`route`), the assistant uses a model the person brought
 *   (`own_model`), or this build has no Google client (`not_configured`).
 * - `connect`: offer the one Connect Google button; tools work as soon as it's done.
 * - `ready`: the assistant can use what `services` says.
 * - `paused`: the assistant holds Google data and the protected model isn't reachable,
 *   so it waits rather than send that data anywhere else.
 */
export type MatrixGoogleAssistantState = 'unavailable' | 'connect' | 'ready' | 'paused'

export interface MatrixGoogleAssistantAccess {
  state: MatrixGoogleAssistantState
  reason?: 'route' | 'own_model' | 'not_configured'
  services?: MatrixGoogleServices
}

/** The first-run card / post-skip chip (and Settings' Connect button) turns on only
 * here: the assistant could use Google the moment the person connects it. */
export function matrixGoogleConnectOffered(access: MatrixGoogleAssistantAccess | undefined): boolean {
  return access?.state === 'connect'
}

/** The assistant can use Google now: something is shared and the protected route is served.
 * `services` says what (an unticked service stays off; nothing asks for it again). */
export function matrixGoogleToolsUsable(access: MatrixGoogleAssistantAccess | undefined): boolean {
  const services = access?.state === 'ready' ? access.services : undefined

  return Boolean(services && (services.gmail || services.calendar || services.drive))
}

/** The broker's actions, the same names the assistant's `atum_google` tool uses. */
export const MATRIX_GOOGLE_TOOL_ACTIONS = [
  'status',
  'agenda',
  'waiting',
  'search_mail',
  'read_thread',
  'search_drive',
  'read_file',
  'send_email',
  'create_event',
  'update_event',
  // Mailbox control : single-message reads
  // with full headers and attachments, label/archive/read/star/trash changes, and Gmail drafts.
  'read_message',
  'download_attachment',
  'list_labels',
  'list_drafts',
  'mailbox',
  'create_label',
  'create_draft',
  'update_draft'
] as const

export type MatrixGoogleToolAction = (typeof MATRIX_GOOGLE_TOOL_ACTIONS)[number]

export function isMatrixGoogleToolAction(value: unknown): value is MatrixGoogleToolAction {
  return typeof value === 'string' && (MATRIX_GOOGLE_TOOL_ACTIONS as readonly string[]).includes(value)
}

/** Actions that change something in the person's Google account: each waits for the owner. */
export const MATRIX_GOOGLE_WRITE_ACTIONS: ReadonlySet<MatrixGoogleToolAction> = new Set([
  'send_email',
  'create_event',
  'update_event'
])

/**
 * Reversible mailbox changes (archive, labels, read/unread, star, trash, drafts). They never wait
 * for the owner (owner rule 2026-11-08: prompts only for risky actions; nothing here sends,
 * deletes for good or reaches another person), and they need a Gmail grant that includes
 * {@link MATRIX_GOOGLE_MAIL_MANAGE_SCOPE}. Background runs may not make them.
 */
export const MATRIX_GOOGLE_MAILBOX_ACTIONS: ReadonlySet<MatrixGoogleToolAction> = new Set([
  'mailbox',
  'create_label',
  'create_draft',
  'update_draft'
])

/** Every action that changes the account in any way; background reads refuse all of them. */
export const MATRIX_GOOGLE_CHANGE_ACTIONS: ReadonlySet<MatrixGoogleToolAction> = new Set([
  ...MATRIX_GOOGLE_WRITE_ACTIONS,
  ...MATRIX_GOOGLE_MAILBOX_ACTIONS
])

/**
 * The one Gmail scope that covers labels, archive, read/star, trash and drafts. It is NOT in the
 * scopes new desktop grants ask for yet (Google's restricted-scope verification; owner activation
 * decision): adding it to `MAIL_CALENDAR_SCOPES` in electron/atum-utilities/google.ts is the whole
 * consent change. A grant without it answers these actions with the typed code `scope_missing`.
 */
export const MATRIX_GOOGLE_MAIL_MANAGE_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'

/** Whether a grant's scope list lets the mailbox be managed (labels, archive, read, trash, drafts). */
export function matrixGoogleCanManageMail(scopes: readonly string[] | undefined): boolean {
  return Boolean(scopes?.includes(MATRIX_GOOGLE_MAIL_MANAGE_SCOPE))
}

/**
 * Outgoing mail (agent email compose, 2026-11-09): Gmail's own limit is 25 MB for the whole encoded
 * message, so that is the ceiling for a send or a draft, attachments and quoted text included.
 * The request that carries attachments (base64 in the closed grammar) may be a little larger.
 */
export const MATRIX_GOOGLE_COMPOSE_MAX_BYTES = 25 * 1024 * 1024
export const MATRIX_GOOGLE_COMPOSE_REQUEST_MAX_BYTES = 27 * 1024 * 1024
export const MATRIX_GOOGLE_MAX_OUTGOING_ATTACHMENTS = 10
/** Recipients on one message across To, Cc and Bcc, and in each explicit list. */
export const MATRIX_GOOGLE_MAX_RECIPIENTS = 50
export const MATRIX_GOOGLE_MAX_RECIPIENTS_PER_LIST = 20

/** The route that serves one attachment as raw bytes: never inside tool JSON. */
export { MATRIX_GOOGLE_ATTACHMENT_PATH } from '../../../packages/model-client/src/google-path'
/** The largest attachment Atum hands to an agent (bytes). Larger ones are named, not fetched. */
export const MATRIX_GOOGLE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024

/**
 * The route a model request from an agent takes. An agent that may hold Google data
 * (`latched`) uses only the protected alias, and waits when it isn't served; every other
 * agent's request is untouched. Pure, so the proxy and its tests share one rule.
 */
export function matrixGoogleModelRoute(input: {
  latched: boolean
  protectedRoute: boolean
}): 'open' | 'protected' | 'refused' {
  if (!input.latched) {
    return 'open'
  }

  return input.protectedRoute ? 'protected' : 'refused'
}

/** Folds each account's granted services into the snapshot's one summary. */
export function matrixGoogleServicesOf(
  sources: ReadonlyArray<{ kind: 'email' | 'calendar' | 'drive'; state: string; writable?: boolean }>
): MatrixGoogleServices {
  const connected = sources.filter(source => source.state === 'connected')

  return {
    gmail: connected.some(source => source.kind === 'email'),
    send: connected.some(source => source.kind === 'email' && source.writable === true),
    calendar: connected.some(source => source.kind === 'calendar'),
    drive: connected.some(source => source.kind === 'drive')
  }
}
