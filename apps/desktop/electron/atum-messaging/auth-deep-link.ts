/**
 * auth-deep-link.ts
 *
 * The `atum://auth-callback/<state>` transport for the desktop's native
 * "Sign in with Google". Electron-free on purpose (no `import 'electron'`) so
 * the whole trust boundary unit-tests in the `electron` vitest project —
 * `main.ts` owns only the two OS seams (`open-url`, `second-instance` argv)
 * and hands the raw URL string straight to `AtumAuthCallbackBroker.deliver`.
 *
 * Why a custom scheme instead of the RFC 8252 loopback listener this file
 * replaced: GoTrue validates `redirect_to` against the project's
 * `uri_allow_list`, and the Atum project allows `atum://auth-callback` and
 * `atum://auth-callback/**` — not an ephemeral `http://127.0.0.1:<port>`.
 * A loopback redirect is rejected by the authorization server before the user
 * ever sees a consent screen, so the loopback flow could not have worked in
 * production regardless of how correct its local plumbing was.
 *
 * Why the state rides in the PATH and not the query: the allow-list glob
 * `atum://auth-callback/**` matches a path suffix. A query-string state
 * (`atum://auth-callback?state=…`) matches neither allow-list entry and is
 * rejected upstream. `/{state}` is also exactly the shape the previous
 * loopback callback used, so the correlation model is unchanged — only the
 * transport moved.
 *
 * THREAT MODEL. A custom-scheme callback is not a private channel: anything
 * running as the user (a web page, another app, a shell one-liner) can open
 * `atum://…` with arbitrary contents at any time. Everything here treats the
 * URL as hostile input:
 *
 *   - The verifier NEVER leaves the main process and is never part of the URL.
 *     A stolen authorization code is useless without it.
 *   - A callback is accepted only while a request this process started is
 *     pending, its state matches under a constant-time comparison, and the
 *     request has not expired. Delivery consumes the request, so a replay of
 *     the same URL is rejected.
 *   - A callback that does NOT match is dropped without touching the pending
 *     request. A hostile deep link must not be able to cancel the user's
 *     real in-flight sign-in — that would be a trivial denial of service.
 *   - Nothing here logs a code, a state, a verifier, or the URL. Callers get
 *     back a fixed enum reason, which is safe to write to the app log.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

/** Scheme registered with the OS (see `registerDeepLinkProtocol` in main.ts). */
export const ATUM_AUTH_SCHEME = 'atum'

/** Host segment of the callback URL. Must match the Supabase `uri_allow_list`. */
export const ATUM_AUTH_CALLBACK_HOST = 'auth-callback'

/** Default lifetime of a pending authorization request. */
export const ATUM_AUTH_CALLBACK_TTL_MS = 5 * 60 * 1000

/**
 * How long a consumed state is remembered so a replay reports `state_replayed`
 * rather than the vaguer `no_pending_request`. Purely diagnostic — a replay is
 * rejected either way, because the request is already consumed.
 */
export const ATUM_AUTH_REPLAY_MEMORY_MS = 10 * 60 * 1000

/** Longest URL we will even attempt to parse. */
const MAX_CALLBACK_URL_BYTES = 8 * 1024

/** base64url alphabet, 16–128 chars. `randomSecret(24)` produces 32. */
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

/** Authorization codes are `unreserved` per RFC 3986 in every GoTrue build. */
const CODE_PATTERN = /^[A-Za-z0-9._~-]{1,4096}$/

/** Upstream error identifiers are short snake_case tokens (`access_denied`). */
const ERROR_PATTERN = /^[a-z0-9_-]{1,64}$/

export type AtumAuthCallbackRejection =
  | 'callback_code_invalid'
  | 'callback_duplicate_parameter'
  | 'callback_host_unexpected'
  | 'callback_malformed'
  | 'callback_missing_result'
  | 'callback_not_atum_scheme'
  | 'callback_state_invalid'
  | 'callback_too_large'

export type AtumAuthCallback =
  | { ok: false; reason: AtumAuthCallbackRejection }
  | { ok: true; state: string; code: string; error: null }
  | { ok: true; state: string; code: null; error: string }

/** True for any `atum://` URL — used to route argv/open-url away from `hermes://`. */
export function isAtumAuthScheme(value: unknown): boolean {
  return typeof value === 'string' && value.slice(0, ATUM_AUTH_SCHEME.length + 3).toLowerCase() === `${ATUM_AUTH_SCHEME}://`
}

/** The `redirect_to` handed to GoTrue for a request correlated by `state`. */
/**
 * Path of the platform's desktop OAuth bridge page. The state rides in the
 * path so the Supabase allow-list entry can be the same shape as the deep
 * link's: `https://<hosted>/auth/desktop/**`.
 */
export const ATUM_AUTH_BRIDGE_PATH = '/auth/desktop'

/**
 * Where GoTrue sends the BROWSER after Google.
 *
 * This is deliberately not the `atum://` deep link any more. A custom scheme
 * as `redirect_to` completes sign-in but leaves the browser tab on a page it
 * cannot render — the person is left staring at a "working" screen with no
 * sign that anything succeeded. The bridge page performs the `atum://` handoff
 * itself and then says the tab is done.
 *
 * `hostedBaseUrl` arrives already normalised by `normalizeHttpUrl` (https, or
 * http only for loopback, no credentials, no query or hash). It is re-checked
 * here so this function is safe on its own terms.
 */
export function atumAuthBridgeRedirectUrl(hostedBaseUrl: string, state: string): string {
  if (!STATE_PATTERN.test(state)) {
    throw new Error('callback_state_invalid')
  }

  const base = new URL(hostedBaseUrl)
  const loopback = base.hostname === '127.0.0.1' || base.hostname === 'localhost' || base.hostname === '::1'

  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) {
    throw new Error('callback_base_insecure')
  }

  if (base.username || base.password || base.search || base.hash) {
    throw new Error('callback_base_invalid')
  }

  return `${base.origin}${base.pathname.replace(/\/+$/u, '')}${ATUM_AUTH_BRIDGE_PATH}/${state}`
}

/**
 * The deep link the bridge page hands back to this app. No longer used as a
 * `redirect_to` — kept because it is the exact shape `parseAtumAuthCallback`
 * accepts, and the bridge is specified against it.
 */
export function atumAuthRedirectUrl(state: string): string {
  if (!STATE_PATTERN.test(state)) {
    throw new Error('callback_state_invalid')
  }

  return `${ATUM_AUTH_SCHEME}://${ATUM_AUTH_CALLBACK_HOST}/${state}`
}

/**
 * Parse a deep link into a callback result. Total function: every hostile,
 * malformed, oversized, or simply unrelated input returns a rejection reason
 * instead of throwing, and no branch echoes the input back to the caller.
 */
export function parseAtumAuthCallback(value: unknown): AtumAuthCallback {
  if (typeof value !== 'string' || !value) {
    return { ok: false, reason: 'callback_malformed' }
  }

  if (Buffer.byteLength(value, 'utf8') > MAX_CALLBACK_URL_BYTES) {
    return { ok: false, reason: 'callback_too_large' }
  }

  // A control character (NUL, CR, LF) is a request-splitting / log-injection
  // attempt, not a URL. WHATWG strips some of these silently; we do not.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    return { ok: false, reason: 'callback_malformed' }
  }

  let url: URL

  try {
    url = new URL(value)
  } catch {
    return { ok: false, reason: 'callback_malformed' }
  }

  if (url.protocol !== `${ATUM_AUTH_SCHEME}:`) {
    return { ok: false, reason: 'callback_not_atum_scheme' }
  }

  // Userinfo in a custom-scheme URL is pure smuggling surface
  // (`atum://auth-callback@evil.example/…` parses with host `evil.example`).
  if (url.username || url.password || url.port) {
    return { ok: false, reason: 'callback_host_unexpected' }
  }

  if (url.hostname !== ATUM_AUTH_CALLBACK_HOST) {
    return { ok: false, reason: 'callback_host_unexpected' }
  }

  const segments = url.pathname.split('/').filter(segment => segment.length > 0)

  if (segments.length !== 1) {
    return { ok: false, reason: 'callback_state_invalid' }
  }

  let state: string

  try {
    state = decodeURIComponent(segments[0]!)
  } catch {
    return { ok: false, reason: 'callback_state_invalid' }
  }

  if (!STATE_PATTERN.test(state)) {
    return { ok: false, reason: 'callback_state_invalid' }
  }

  // Repeated parameters let an attacker pick which one a downstream parser
  // reads. There is never a legitimate duplicate here.
  for (const key of ['code', 'error', 'error_code']) {
    if (url.searchParams.getAll(key).length > 1) {
      return { ok: false, reason: 'callback_duplicate_parameter' }
    }
  }

  const rawError = url.searchParams.get('error') ?? url.searchParams.get('error_code')

  if (rawError !== null) {
    // `error_description` is attacker-influenced free text and is discarded on
    // purpose: the UI shows our own copy, keyed off a normalized token.
    const error = rawError.trim().toLowerCase()

    return { ok: true, state, code: null, error: ERROR_PATTERN.test(error) ? error : 'authorization_denied' }
  }

  const code = url.searchParams.get('code')

  if (code === null) {
    return { ok: false, reason: 'callback_missing_result' }
  }

  if (!CODE_PATTERN.test(code)) {
    return { ok: false, reason: 'callback_code_invalid' }
  }

  return { ok: true, state, code, error: null }
}

/** Constant-time equality over the digests, so unequal lengths stay comparable. */
function statesMatch(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a, 'utf8').digest(), createHash('sha256').update(b, 'utf8').digest())
}

export type AtumAuthDeliveryOutcome =
  | AtumAuthCallbackRejection
  | 'accepted'
  | 'authorization_error'
  | 'no_pending_request'
  | 'request_expired'
  | 'state_mismatch'
  | 'state_replayed'

export interface AtumAuthDelivery {
  accepted: boolean
  /** Fixed enum — safe to log. Never contains the code, state, or URL. */
  outcome: AtumAuthDeliveryOutcome
}

export interface AtumAuthWaitInput {
  state: string
  signal: AbortSignal
  ttlMs?: number
}

/** The seam `SupabaseAtumAccountClient` depends on, so tests can substitute one. */
export interface AtumAuthCallbackWaiter {
  wait(input: AtumAuthWaitInput): Promise<string>
}

interface PendingRequest {
  state: string
  expiresAt: number
  settle: (error: Error | null, code?: string) => void
}

/**
 * Single-slot registry of the one authorization request this process is
 * waiting on, plus the OS-facing `deliver` entry point.
 *
 * Single-slot is deliberate: the controller already refuses a concurrent
 * attempt, and a second slot would mean a hostile deep link could be matched
 * against a state the user is no longer waiting for.
 */
export class AtumAuthCallbackBroker implements AtumAuthCallbackWaiter {
  private pending: PendingRequest | null = null
  private readonly consumed = new Map<string, number>()
  private readonly now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
  }

  wait(input: AtumAuthWaitInput): Promise<string> {
    if (!STATE_PATTERN.test(input.state)) {
      return Promise.reject(new Error('callback_state_invalid'))
    }

    // A new attempt supersedes the old one rather than queueing behind it: the
    // user pressing the button again means the earlier browser tab is stale.
    this.pending?.settle(new Error('authorization_superseded'))
    this.pending = null

    const ttlMs = input.ttlMs && input.ttlMs > 0 ? input.ttlMs : ATUM_AUTH_CALLBACK_TTL_MS

    return new Promise<string>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => request.settle(new Error('authorization_timeout')), ttlMs)
      // A pending request must never hold the process open on its own.
      timer.unref?.()

      const onAbort = () => request.settle(new Error('authorization_cancelled'))

      const request: PendingRequest = {
        state: input.state,
        expiresAt: this.now() + ttlMs,
        settle: (error, code) => {
          if (settled) {
            return
          }

          settled = true
          clearTimeout(timer)
          input.signal.removeEventListener('abort', onAbort)

          if (this.pending === request) {
            this.pending = null
          }

          if (error) {
            reject(error)
          } else {
            resolve(code!)
          }
        }
      }

      if (input.signal.aborted) {
        request.settle(new Error('authorization_cancelled'))

        return
      }

      input.signal.addEventListener('abort', onAbort, { once: true })
      this.pending = request
    })
  }

  /**
   * Feed one OS-delivered deep link in. Safe to call with anything at all —
   * including URLs that have nothing to do with auth — and safe to call when
   * no sign-in is running.
   */
  deliver(value: unknown): AtumAuthDelivery {
    this.pruneConsumed()

    const parsed = parseAtumAuthCallback(value)

    // `=== false`, not `!parsed.ok`: tsconfig.electron.json runs with
    // strictNullChecks off, where truthiness does not narrow a boolean
    // discriminant but an explicit literal comparison still does.
    if (parsed.ok === false) {
      return { accepted: false, outcome: parsed.reason }
    }

    const pending = this.pending

    if (!pending) {
      return {
        accepted: false,
        outcome: this.consumed.has(parsed.state) ? 'state_replayed' : 'no_pending_request'
      }
    }

    if (!statesMatch(pending.state, parsed.state)) {
      // Do NOT clear `pending`. An unsolicited deep link must not be able to
      // kill the sign-in the user actually started.
      return { accepted: false, outcome: 'state_mismatch' }
    }

    // Belt-and-braces with the TTL timer: a suspended/slept machine can fire a
    // callback whose timer has not run yet.
    if (this.now() > pending.expiresAt) {
      this.consumed.set(parsed.state, this.now() + ATUM_AUTH_REPLAY_MEMORY_MS)
      pending.settle(new Error('authorization_timeout'))

      return { accepted: false, outcome: 'request_expired' }
    }

    // Single use: the state is spent whether the upstream said yes or no.
    this.consumed.set(parsed.state, this.now() + ATUM_AUTH_REPLAY_MEMORY_MS)

    if (parsed.error) {
      pending.settle(new Error(`authorization_callback_error:${parsed.error}`))

      return { accepted: false, outcome: 'authorization_error' }
    }

    pending.settle(null, parsed.code)

    return { accepted: true, outcome: 'accepted' }
  }

  /** True while a browser round-trip this process started is outstanding. */
  hasPendingRequest(): boolean {
    return this.pending !== null
  }

  /** App shutdown / controller teardown. */
  stop(): void {
    this.pending?.settle(new Error('authorization_cancelled'))
    this.pending = null
    this.consumed.clear()
  }

  private pruneConsumed(): void {
    const now = this.now()

    for (const [state, expiresAt] of this.consumed) {
      if (expiresAt <= now) {
        this.consumed.delete(state)
      }
    }
  }
}
