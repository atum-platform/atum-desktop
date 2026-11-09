import type { MatrixRefreshCause } from '../../shared/matrix'

/**
 * What ended, revoked or failed to keep one of this Mac's sign-ins, for main.log
 * ( "Why the Mac mini was signed out"). Every
 * field is a closed code: never a token, a user or device id, or a server's own words.
 */

/** Which sign-in an event is about: the person's chats, or their Atum account. */
export type MatrixAccountClient = 'matrix' | 'domain'

/**
 * The sign-in server refused this Mac's grant itself: the only proof that a session is over.
 * Only `invalid_grant` says that (MAS 1.24 token.rs:243-252). `invalid_client` means the server
 * did not recognise this app (token.rs:202-205): a deploy or configuration problem on its side,
 * a passing refusal that is asked again later.
 */
export type MatrixSessionEndCause = 'refresh_rejected:invalid_grant'

/** Why this Mac revoked a grant it held. Each is a deliberate change, never a failed save. */
export type MatrixGrantRevocationReason =
  /** An authorization finished after its sign-in was cancelled, or failed its checks. */
  | 'sign_in_cancelled'
  /** A sign-in brought another person's account than the one saved here. */
  | 'account_mismatch'
  /** The account was signed out or replaced while a rotation was in flight. */
  | 'account_changed'
  /** The Atum account sign-in was replaced while it rotated. */
  | 'domain_replaced'
  /** The person signed out. */
  | 'user_sign_out'
  /** A new sign-in of the same person replaced one the server ended or refused: the old grant
   * is revoked behind it, best effort (MAS 1.24 answers 200 and does nothing when its tokens are
   * already dead, revoke.rs:191-193, 215-217). */
  | 'session_replaced'

/**
 * The OAuth error code of a refusal that ends nothing, for the log: RFC 6749's own closed set
 * (section 5.2) and `other`, never the server's own words.
 */
export type MatrixOAuthRefusal =
  | 'invalid_request'
  | 'invalid_client'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'access_denied'
  | 'server_error'
  | 'temporarily_unavailable'
  | 'other'

const OAUTH_REFUSALS: ReadonlySet<string> = new Set<MatrixOAuthRefusal>([
  'invalid_request',
  'invalid_client',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'access_denied',
  'server_error',
  'temporarily_unavailable'
])

/** A refresh that did not reach an answer, or got one that ends nothing. */
export type MatrixRefreshFailure = Exclude<MatrixRefreshCause, 'session_ended' | 'signed_out' | 'stale'>

export type MatrixAccountEvent =
  | { event: 'credential_save_failed'; client: MatrixAccountClient; code: string }
  | { event: 'credential_saved'; client: MatrixAccountClient }
  | { event: 'session_ended'; client: MatrixAccountClient; cause: MatrixSessionEndCause }
  | { event: 'grant_revoked'; client: MatrixAccountClient; reason: MatrixGrantRevocationReason }
  | { event: 'refresh_unavailable'; client: MatrixAccountClient; cause: MatrixRefreshFailure; oauth?: MatrixOAuthRefusal }
  /** A queued revocation the sign-in server kept refusing (or never answered) is given up, so
   * it can't hold up every later sign-in, Connect or sign-out (account.ts drainRevocationsOnce). */
  | {
      event: 'revocation_dropped'
      client: MatrixAccountClient
      cause: MatrixRefreshFailure
      oauth?: MatrixOAuthRefusal
      attempts: number
    }
  /** A save found the disk full and was made in the room kept for it (disk-reserve.ts). */
  | { event: 'disk_reserve_used' }
  /** The platform refused a freshly rotated Atum account token too: unavailable, not ended. */
  | { event: 'domain_refused' }
  | { event: 'user_sign_out'; result: 'completed' | 'pending'; code?: string }

/** The refusal's OAuth code when the server sent one (openid-client's `error`), else undefined. */
export function matrixOAuthRefusal(error: unknown): MatrixOAuthRefusal | undefined {
  const code = error && typeof error === 'object' && 'error' in error ? (error as { error?: unknown }).error : undefined

  return typeof code === 'string' ? (OAUTH_REFUSALS.has(code) ? (code as MatrixOAuthRefusal) : 'other') : undefined
}

/** One main.log line: `[Matrix] account <event> key=value …`. */
export function matrixAccountLogLine(value: MatrixAccountEvent): string {
  const { event, ...fields } = value

  return `[Matrix] account ${event}${Object.entries(fields)
    .filter(([, field]) => field !== undefined)
    .map(([key, field]) => ` ${key}=${String(field)}`)
    .join('')}`
}

/** A closed code for an error that ends up in a log line: our own codes, else `unexpected`. */
export function matrixClosedCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ''

  return /^(?:matrix|auth_storage)_[a-z_]{1,64}$/.test(message) ? message : 'unexpected'
}

/**
 * Why a token refresh got no answer that settles anything (openid-client's own errors, by
 * shape: its classes are not needed to read them). The sign-in server's discovery failing,
 * the network or a timeout, a 5xx, another OAuth refusal (`invalid_client` included), this
 * Mac's vault, or unknown. invalid_grant is not a failure: it ends the session, and the caller
 * reads it first.
 */
export function matrixRefreshFailureCause(error: unknown): MatrixRefreshFailure {
  if (error instanceof Error && error.message === 'matrix_identity_unavailable') {
    return 'discovery'
  }

  if (error instanceof Error && ['matrix_vault_unavailable', 'matrix_vault_invalid'].includes(error.message)) {
    return 'vault'
  }

  // fetch's own network failure ("fetch failed"), before any answer.
  if (error instanceof TypeError) {
    return 'transport'
  }

  const value = error as { name?: unknown; code?: unknown; status?: unknown; error?: unknown; cause?: unknown } | null

  if (!value || typeof value !== 'object') {
    return 'unexpected'
  }

  if (
    value.code === 'OAUTH_TIMEOUT' ||
    value.code === 'OAUTH_ABORT' ||
    value.name === 'TimeoutError' ||
    value.name === 'AbortError'
  ) {
    return 'transport'
  }

  const status =
    typeof value.status === 'number'
      ? value.status
      : typeof Response !== 'undefined' && value.cause instanceof Response
        ? value.cause.status
        : undefined

  if (status !== undefined && status >= 500) {
    return '5xx'
  }

  return typeof value.error === 'string' ? 'refused' : 'unexpected'
}
