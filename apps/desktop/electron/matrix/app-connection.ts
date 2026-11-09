import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'

import type { MatrixAppConnection, MatrixAppConnectionState } from '../../shared/matrix-apps'

import { type AppLinkAuthorize, appLinkLogLine, type AppLinkOutcome, type AppLinkStep } from './app-link-log'

const RETURN_CODE = /^[A-Za-z0-9_-]{43}$/u
const INITIATION_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu
const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/u
// Shown in the browser tab the sign-in ends on. Vietnamese first, then English. A flow the
// setup card started finishes by itself; one started elsewhere still waits for its tap.
const RETURN_PAGE = 'Atum: đã nhận. Atum đang hoàn tất kết nối — quay lại Atum để xem.\nAtum: received. Atum is finishing the connection — return to Atum to see it.'
const RETURN_PAGE_TAP = 'Atum: đã nhận. Quay lại Atum để hoàn tất kết nối.\nAtum: received. Return to Atum to finish connecting.'

type AppConnectionAction = 'connection' | 'connect' | 'confirm' | 'disconnect'

export interface AppConnectionDependencies {
  request: (slug: string, action: AppConnectionAction, body?: unknown) => Promise<unknown>
  /** Legacy/test fallback. Production opens the app-bound sheet below. */
  openExternal: (url: string) => Promise<void> | void
  /** Open the approved authorization page without exposing its URL to the renderer. */
  openAuthorize?: (request: {
    slug: string
    url: string
    onClosed: (reason: 'closed' | 'failed') => void
  }) => Promise<{ close(): void }>
  /** True only while the account/generation which created this helper owns it. */
  active: () => boolean
  /** Publish a new sanitized snapshot to the owner. */
  changed: () => void
  /** Fixed, main-configured Matrix domain resource; never renderer input. */
  resource: string
  /** Test/configuration seam. The production contract is a bounded three-minute wait. */
  timeoutMs?: number
  /** One closed-code main.log line per step (app-link-log.ts). */
  log?: (line: string) => void
  /** The browser came back to Atum: bring the window forward so the last step is in view. */
  returned?: () => void
  /**
   * The app is still one this account may connect (in its catalog, available). Checked by the
   * auto-confirm gate, as the workspace checks it before a tapped confirm.
   */
  confirmable?: (slug: string) => boolean
  /**
   * The person's consent to the disclosure this Atum shows still stands, read fresh from the
   * platform (bot status) after the return is burned and before anything is sent. Without it
   * no flow confirms by itself.
   */
  consented?: (slug: string) => Promise<{ disclosureVersion: number } | null>
  /** Atum confirmed a link by itself (auto-confirm): run what a tapped confirm runs after it. */
  confirmed?: (slug: string) => void
  /** Clock seam for the arrival window; defaults to Date.now. */
  now?: () => number
}

export interface AppConnectionBeginOptions {
  /**
   * Confirm the link as soon as the gated browser return arrives, with no further tap. Only the
   * setup card asks for this: it offers Connect only after the person agreed to the disclosure
   * it showed. Any other caller keeps the explicit confirm step.
   */
  autoConfirm?: boolean
}

export interface AppConnection {
  snapshot(): Readonly<Record<string, MatrixAppConnectionState>>
  read(slug: string): Promise<void>
  begin(slug: string, options?: AppConnectionBeginOptions): Promise<void>
  confirm(slug: string): Promise<void>
  cancel(slug: string): void
  disconnect(slug: string): Promise<void>
  dispose(): void
}

interface Attempt {
  readonly slug: string
  readonly path: string
  readonly sequence: number
  /** Started by the setup card: the gated return confirms without a tap. */
  readonly autoConfirm: boolean
  readonly startedAt: number
  server?: Server
  timer?: ReturnType<typeof setTimeout>
  cancelled: boolean
  consumed: boolean
  initiationId?: string
  returnCode?: string
  consentDisclosureVersion?: number
  authorize?: { close(): void }
}

interface Slot {
  state: MatrixAppConnectionState
  attempt?: Attempt
  /** Sequence of the latest begin for this app: only that attempt may still confirm. */
  begun?: number
}

/**
 * Main-process owner for the short native app-link return flow. The authority
 * sees the random loopback URI; the renderer sees only its coarse state.
 */
export function createAppConnection(deps: AppConnectionDependencies): AppConnection {
  const slots = new Map<string, Slot>()
  let disposed = false
  let sequence = 0
  const resourceOrigin = configuredOrigin(deps.resource)
  const timeoutMs = deps.timeoutMs ?? 180_000

  const now = () => {
    try {
      return deps.now?.() ?? Date.now()
    } catch {
      return Number.POSITIVE_INFINITY
    }
  }

  // Closed codes only: never a code, initiation id, ticket, attempt token, URL or host.
  const report = (
    slug: string,
    step: AppLinkStep,
    outcome: AppLinkOutcome,
    authorize?: AppLinkAuthorize,
    mode?: 'auto'
  ) => {
    try {
      deps.log?.(appLinkLogLine({ app: slug, step, outcome, ...(authorize ? { authorize } : {}), ...(mode ? { mode } : {}) }))
    } catch {
      // Logging never changes the flow.
    }
  }

  const owns = () => {
    try {
      return !disposed && deps.active()
    } catch {
      return false
    }
  }

  const notify = () => {
    if (!owns()) {
      return
    }

    try {
      deps.changed()
    } catch {
      // The caller can recover on its next authoritative snapshot; publishing
      // must never turn a network callback into an unhandled rejection.
    }
  }

  const slotFor = (slug: string) => {
    let slot = slots.get(slug)

    if (!slot) {
      slot = { state: { phase: 'idle' } }
      slots.set(slug, slot)
    }

    return slot
  }

  const publish = (slot: Slot, state: MatrixAppConnectionState) => {
    slot.state = state
    notify()
  }

  const current = (slot: Slot, attempt: Attempt) => owns() && slot.attempt === attempt && !attempt.cancelled

  // A read or disconnect holds the slot like an attempt, but never accepts a return.
  const operationFor = (slug: string): Attempt => ({
    slug,
    path: '',
    sequence: ++sequence,
    autoConfirm: false,
    startedAt: now(),
    cancelled: false,
    consumed: false
  })

  const clearTimer = (attempt: Attempt) => {
    if (attempt.timer) {
      clearTimeout(attempt.timer)
      attempt.timer = undefined
    }
  }

  const closeAuthorize = (attempt: Attempt) => {
    const authorize = attempt.authorize
    attempt.authorize = undefined

    try {
      authorize?.close()
    } catch {
      // A window which already closed is the same settled presentation state.
    }
  }

  const stop = (slot: Slot, attempt: Attempt, next?: MatrixAppConnectionState, announce = true) => {
    if (attempt.cancelled) {
      return
    }

    attempt.cancelled = true
    clearTimer(attempt)
    closeAuthorize(attempt)

    attempt.server?.close()
    attempt.server?.closeIdleConnections()

    if (slot.attempt === attempt) {
      slot.attempt = undefined
    }

    if (next) {
      slot.state = next

      if (announce) {
        notify()
      }
    }
  }

  const fail = (slot: Slot, attempt: Attempt | undefined, error: MatrixAppConnectionState['error'] = 'unavailable') => {
    const connection = slot.state.connection

    if (attempt) {
      stop(slot, attempt, { phase: 'failed', ...(connection ? { connection } : {}), error })
    } else {
      publish(slot, { phase: 'failed', ...(connection ? { connection } : {}), error })
    }
  }

  const readConnection = async (slug: string): Promise<MatrixAppConnection> => {
    const response = await deps.request(slug, 'connection')
    const connection = connectionFrom(response)

    if (!connection) {
      throw new Error('matrix_app_connection_invalid')
    }

    return connection
  }

  /**
   * The one gate a browser return passes before anything is sent (2026-10-10 security
   * consult, §10). Auto-confirm is only the transport of two consents the person already
   * gave: Connect in the setup card, after agreeing to the disclosure it showed, and the
   * app's own page that names the account. It holds only while every condition holds:
   *
   *  a. this account/generation still owns the helper (checked again at send),
   *  b. the attempt is the latest open one for this app,
   *  c. it was not cancelled, timed out, disposed or superseded,
   *  d. the return is the exact loopback URL: the platform's grammar, this attempt's host,
   *     port and path, GET, exactly the two parameters,
   *  e. a well-formed code, this attempt's initiation id, and no earlier return consumed,
   *  f. it arrived inside the attempt's bounded wait (never the platform's longer binding),
   *  g. for a confirm without a tap: the setup card started it, its flow is still waiting
   *     on this return, the app is still one this account may connect, and (read fresh by
   *     confirmAuto once the return is burned, since it needs the platform) consent to the
   *     disclosure this Atum shows still stands.
   *
   * Returns the code to keep for confirm, and whether to send it now; null sends nothing.
   * The caller burns the return (consumed) before any async work.
   */
  const gateReturn = (
    slot: Slot,
    attempt: Attempt,
    request: IncomingMessage,
    callback: URL,
    expectedHost: string
  ): { code: string; auto: boolean } | null => {
    const codes = callback.searchParams.getAll('code')
    const ids = callback.searchParams.getAll('initiation_id')

    const returned =
      // a, b, c
      current(slot, attempt) &&
      slot.begun === attempt.sequence &&
      // d
      request.method === 'GET' &&
      expectedHost !== '' &&
      request.headers.host === expectedHost &&
      callback.host === expectedHost &&
      callback.pathname === attempt.path &&
      isLinkReturnUrl(`http://${expectedHost}${request.url ?? ''}`) &&
      callback.searchParams.size === 2 &&
      codes.length === 1 &&
      ids.length === 1 &&
      // e
      RETURN_CODE.test(codes[0]) &&
      attempt.initiationId !== undefined &&
      ids[0] === attempt.initiationId &&
      !attempt.consumed &&
      // f
      now() - attempt.startedAt <= timeoutMs

    if (!returned) {
      return null
    }

    if (!attempt.autoConfirm) {
      return { code: codes[0], auto: false }
    }

    // g
    if ((slot.state.phase !== 'opening' && slot.state.phase !== 'waiting') || !deps.consented) {
      return null
    }

    try {
      return deps.confirmable?.(attempt.slug) === false ? null : { code: codes[0], auto: true }
    } catch {
      return null
    }
  }

  /**
   * The confirm request itself, sent once with the ownership re-checks before and after every
   * await. Explicit-tap callers retain the claims/2 three-field body. A contained setup flow
   * carries the two already-visible consent assertions required by claims/2.1.
   */
  const send = async (slot: Slot, attempt: Attempt, mode?: 'auto') => {
    const code = attempt.returnCode

    if (!current(slot, attempt) || !attempt.initiationId || !code) {
      if (!owns()) {
        stop(slot, attempt, undefined, false)
      }

      report(attempt.slug, 'confirm', 'not_ready', undefined, mode)

      return
    }

    // A return code is sent at most once; a failed confirm needs a fresh Connect.
    attempt.returnCode = undefined
    // The bounded wait is over once the confirm is on the wire: its own outcome decides
    // between linked and failed, never a timer firing while the platform links.
    clearTimer(attempt)

    if (slot.state.phase !== 'confirming') {
      publish(slot, { phase: 'confirming', ...(slot.state.connection ? { connection: slot.state.connection } : {}) })
    }

    try {
      await deps.request(attempt.slug, 'confirm', {
        initiation_id: attempt.initiationId,
        return_code: code,
        confirmation: true,
        ...(mode === 'auto'
          ? {
              consent_provenance: {
                chat: {
                  state: 'accepted',
                  disclosure_version: attempt.consentDisclosureVersion
                },
                exact_pair: { state: 'accepted', source: 'provider_page' }
              }
            }
          : {})
      })

      if (!current(slot, attempt)) {
        stop(slot, attempt, undefined, false)
        await settleStopped(slot, attempt, mode)

        return
      }

      const connection = await readConnection(attempt.slug)

      if (!current(slot, attempt)) {
        stop(slot, attempt, undefined, false)
        await settleStopped(slot, attempt, mode)

        return
      }

      stop(slot, attempt, { phase: 'idle', connection })
      report(attempt.slug, 'confirm', 'confirmed', undefined, mode)

      if (mode === 'auto') {
        try {
          deps.confirmed?.(attempt.slug)
        } catch {
          // The next read settles the workspace; the link itself is made.
        }
      }
    } catch {
      if (current(slot, attempt)) {
        report(attempt.slug, 'confirm', 'confirm_failed', undefined, mode)
        fail(slot, attempt)
      } else {
        await settleStopped(slot, attempt, mode)
      }
    }
  }

  /**
   * A confirm on the wire cannot be called back. When something stopped its attempt in the
   * meantime (a cancel on the Apps page, the app changing, consent withdrawn in Settings), the
   * platform may have linked anyway: read what it decided and show that, instead of leaving
   * the state from before the confirm on screen with Connect offered again. A link made this
   * way by an auto-confirm settles the workspace like any other.
   */
  const settleStopped = async (slot: Slot, attempt: Attempt, mode?: 'auto') => {
    // A lost owner publishes nothing; a newer flow, read or disconnect reads for itself.
    if (!owns() || slot.attempt) {
      return
    }

    await read(attempt.slug)

    if (
      mode === 'auto' &&
      owns() &&
      !slot.attempt &&
      slot.state.phase === 'idle' &&
      slot.state.connection?.state === 'linked'
    ) {
      try {
        deps.confirmed?.(attempt.slug)
      } catch {
        // The next read settles the workspace; the link itself is made.
      }
    }
  }

  /**
   * The auto-confirm path once the return passed the gate and was burned: (g)'s platform
   * read, then the same send a tap makes. A refusal sends nothing and fails the attempt; the
   * code is gone, so linking again needs a fresh Connect.
   */
  const confirmAuto = async (slot: Slot, attempt: Attempt) => {
    let consent: { disclosureVersion: number } | null = null

    try {
      consent = (await deps.consented?.(attempt.slug)) ?? null
    } catch {
      consent = null
    }

    if (!consent || !Number.isSafeInteger(consent.disclosureVersion) || consent.disclosureVersion < 1) {
      attempt.returnCode = undefined

      if (current(slot, attempt)) {
        report(attempt.slug, 'confirm', 'consent_required', undefined, 'auto')
        fail(slot, attempt)
      } else if (!owns()) {
        stop(slot, attempt, undefined, false)
      }

      return
    }

    attempt.consentDisclosureVersion = consent.disclosureVersion
    await send(slot, attempt, 'auto')
  }

  const listen = async (slot: Slot, attempt: Attempt): Promise<string> => {
    const server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Content-Type', 'text/plain; charset=utf-8')
      response.setHeader('Referrer-Policy', 'no-referrer')

      const address = server.address()
      const expectedHost = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : ''
      let callback: URL

      try {
        callback = new URL(request.url ?? '/', `http://${expectedHost}`)
      } catch {
        response.writeHead(400).end('Invalid callback')

        return
      }

      if (
        request.method !== 'GET' ||
        request.headers.host !== expectedHost ||
        callback.host !== expectedHost ||
        callback.pathname !== attempt.path
      ) {
        response.writeHead(404).end('Not found')

        return
      }

      const gate = gateReturn(slot, attempt, request, callback, expectedHost)

      if (!gate) {
        if (!owns()) {
          stop(slot, attempt, undefined, false)
        }

        report(attempt.slug, 'return', 'rejected')
        response.writeHead(400).end('Invalid callback')

        return
      }

      // Single use, before any async work: burn the return and stop accepting callbacks.
      attempt.consumed = true
      attempt.returnCode = gate.code
      attempt.server?.close()
      attempt.server?.closeIdleConnections()
      // A validated return owns the sheet's successful close. Its closed event sees consumed=true
      // and therefore cannot turn the same return into a cancellation.
      closeAuthorize(attempt)
      publish(slot, {
        phase: gate.auto ? 'confirming' : 'confirm',
        ...(slot.state.connection ? { connection: slot.state.connection } : {})
      })
      report(attempt.slug, 'return', 'received')
      response.end(gate.auto ? RETURN_PAGE : RETURN_PAGE_TAP)

      try {
        deps.returned?.()
      } catch {
        // Focusing the window is a courtesy; the next step is already published.
      }

      if (gate.auto) {
        void confirmAuto(slot, attempt)
      }
    })

    attempt.server = server
    server.on('error', () => {
      if (current(slot, attempt)) {
        fail(slot, attempt)
      }
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening)
        reject(error)
      }

      const onListening = () => {
        server.off('error', onError)
        resolve()
      }

      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '127.0.0.1')
    })

    const address = server.address()

    if (!address || typeof address === 'string' || address.port < 1024 || address.port > 65535) {
      throw new Error('matrix_app_callback_unavailable')
    }

    return `http://127.0.0.1:${address.port}${attempt.path}`
  }

  const begin = async (slug: string, options?: AppConnectionBeginOptions) => {
    if (!validSlug(slug)) {
      return
    }

    const slot = slotFor(slug)

    if (!owns() || !resourceOrigin) {
      if (slot.attempt) {
        stop(slot, slot.attempt, undefined, false)
      }

      // Said, not silent: the person pressed Connect and must see that it did not start.
      publish(slot, { phase: 'failed', ...(slot.state.connection ? { connection: slot.state.connection } : {}), error: 'unavailable' })
      report(slug, 'begin', 'unavailable')

      return
    }

    if (slot.attempt) {
      stop(slot, slot.attempt)
    }

    publish(slot, { phase: 'opening', ...(slot.state.connection ? { connection: slot.state.connection } : {}) })

    const attempt: Attempt = {
      slug,
      path: `/atum/app-link/${randomBytes(32).toString('base64url')}`,
      sequence: ++sequence,
      autoConfirm: options?.autoConfirm === true,
      startedAt: now(),
      cancelled: false,
      consumed: false
    }

    slot.attempt = attempt
    slot.begun = attempt.sequence
    attempt.timer = setTimeout(() => {
      if (current(slot, attempt)) {
        report(slug, 'begin', 'timed_out')
        fail(slot, attempt, 'timed_out')
      } else if (!owns()) {
        stop(slot, attempt, undefined, false)
      }
    }, timeoutMs)

    // The step that failed, for the log line: every branch of begin says which one it was.
    let failure: AppLinkOutcome = 'connection_failed'
    let authorize: AppLinkAuthorize | undefined

    const superseded = () => {
      stop(slot, attempt, undefined, false)
      report(slug, 'begin', 'superseded')
    }

    try {
      const connection = await readConnection(slug)

      if (!current(slot, attempt)) {
        superseded()

        return
      }

      publish(slot, { phase: 'opening', connection })
      failure = 'callback_failed'
      const redirectUri = await listen(slot, attempt)

      if (!current(slot, attempt)) {
        superseded()

        return
      }

      failure = 'connect_failed'
      const connected = await deps.request(slug, 'connect', { redirect_uri: redirectUri })

      if (!current(slot, attempt)) {
        superseded()

        return
      }

      failure = 'authorize_invalid'
      const start = connectStart(connected, resourceOrigin)

      if (!start) {
        throw new Error('matrix_app_connect_invalid')
      }

      authorize = new URL(start.authorizeUrl).origin === resourceOrigin ? 'same_origin' : 'other_origin'
      attempt.initiationId = start.initiationId
      failure = 'browser_failed'
      if (deps.openAuthorize) {
        const surface = await deps.openAuthorize({
          slug,
          url: start.authorizeUrl,
          onClosed: reason => {
            if (!current(slot, attempt) || attempt.consumed) {
              return
            }

            if (reason === 'failed') {
              report(slug, 'begin', 'browser_failed', authorize)
              fail(slot, attempt)

              return
            }

            stop(slot, attempt, {
              phase: 'idle',
              ...(slot.state.connection ? { connection: slot.state.connection } : {})
            })
            report(slug, 'cancel', 'cancelled')
          }
        })

        if (!current(slot, attempt)) {
          surface.close()
          superseded()

          return
        }

        attempt.authorize = surface
      } else {
        await deps.openExternal(start.authorizeUrl)
      }

      // The browser can come back (and an auto-confirm finish) before opening resolves.
      if (attempt.consumed) {
        if (owns()) {
          report(slug, 'begin', 'opened', authorize)
        } else {
          stop(slot, attempt, undefined, false)
        }

        return
      }

      if (!current(slot, attempt)) {
        superseded()

        return
      }

      report(slug, 'begin', 'opened', authorize)
      publish(slot, { phase: 'waiting', ...(slot.state.connection ? { connection: slot.state.connection } : {}) })
    } catch {
      if (current(slot, attempt)) {
        report(slug, 'begin', failure, authorize)
        fail(slot, attempt)
      }
    }
  }

  const read = async (slug: string) => {
    if (!validSlug(slug)) {
      return
    }

    const slot = slotFor(slug)

    if (!owns()) {
      if (slot.attempt) {
        stop(slot, slot.attempt, undefined, false)
      }

      return
    }

    // A read must never disrupt a live one-time connection flow. Its final
    // projection is already authoritative after confirm/disconnect.
    if (slot.attempt) {
      return
    }

    const operation = operationFor(slug)
    slot.attempt = operation

    try {
      const connection = await readConnection(slug)

      if (!current(slot, operation)) {
        stop(slot, operation, undefined, false)

        return
      }

      stop(slot, operation, { phase: 'idle', connection })
    } catch {
      if (current(slot, operation)) {
        fail(slot, operation)
      }
    }
  }

  const confirm = async (slug: string) => {
    if (!validSlug(slug)) {
      return
    }

    const slot = slots.get(slug)
    const attempt = slot?.attempt

    if (!owns()) {
      if (slot && attempt) {
        stop(slot, attempt, undefined, false)
      }

      return
    }

    // A tap confirms only a flow waiting for one; auto-confirm already sent its own.
    if (
      !slot ||
      !attempt ||
      !current(slot, attempt) ||
      slot.state.phase !== 'confirm' ||
      !attempt.initiationId ||
      !attempt.returnCode
    ) {
      report(slug, 'confirm', 'not_ready')

      return
    }

    await send(slot, attempt)
  }

  const cancel = (slug: string) => {
    const slot = slots.get(slug)

    if (!slot?.attempt) {
      return
    }

    stop(slot, slot.attempt, { phase: 'idle', ...(slot.state.connection ? { connection: slot.state.connection } : {}) })
    report(slug, 'cancel', 'cancelled')
  }

  const disconnect = async (slug: string) => {
    if (!validSlug(slug)) {
      return
    }

    const slot = slotFor(slug)

    if (!owns()) {
      if (slot.attempt) {
        stop(slot, slot.attempt, undefined, false)
      }

      return
    }

    if (slot.attempt) {
      stop(slot, slot.attempt)
    }

    publish(slot, { phase: 'opening', ...(slot.state.connection ? { connection: slot.state.connection } : {}) })
    const operation = operationFor(slug)
    slot.attempt = operation

    try {
      await deps.request(slug, 'disconnect')

      if (!current(slot, operation)) {
        stop(slot, operation, undefined, false)

        return
      }

      const connection = await readConnection(slug)

      if (!current(slot, operation)) {
        stop(slot, operation, undefined, false)

        return
      }

      stop(slot, operation, { phase: 'idle', connection })
    } catch {
      if (current(slot, operation)) {
        fail(slot, operation)
      }
    }
  }

  return {
    snapshot: () => Object.fromEntries([...slots].map(([slug, slot]) => [slug, cloneState(slot.state)])),
    read,
    begin,
    confirm,
    cancel,
    disconnect,
    dispose: () => {
      if (disposed) {
        return
      }

      disposed = true

      for (const slot of slots.values()) {
        if (slot.attempt) {
          stop(slot, slot.attempt, undefined, false)
        }
      }
    }
  }
}

function configuredOrigin(resource: string): string | null {
  try {
    const url = new URL(resource)

    return url.username || url.password || url.search || url.hash ? null : url.origin
  } catch {
    return null
  }
}

function validSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(slug)
}

/**
 * The authority's sign-in start page. The platform mints it from its people-facing link
 * host (ATUM_CLAIM_REDEMPTION_URL), which is not the API host this Mac calls
 * (api.atumplatform.com vs account.atumplatform.com or the original shell host). Requiring
 * the API origin refused every real start and left Connect silent (0.19.4). The URL arrives
 * over the authenticated API, so any https origin is accepted, as is the API's own origin
 * (what 0.19.4 accepted; a loopback http authority in local runs). Its exact shape is not
 * relaxed: the `/link/start` path and exactly the two one-time parameters.
 */
function connectStart(value: unknown, resourceOrigin: string): { authorizeUrl: string; initiationId: string } | null {
  if (
    !record(value) ||
    typeof value.authorize_url !== 'string' ||
    typeof value.initiation_id !== 'string' ||
    !INITIATION_ID.test(value.initiation_id)
  ) {
    return null
  }

  try {
    const url = new URL(value.authorize_url)
    const tokens = { ticket: url.searchParams.get('t') ?? '', attempt: url.searchParams.get('a') ?? '' }

    if (
      (url.protocol !== 'https:' && url.origin !== resourceOrigin) ||
      url.pathname !== '/link/start' ||
      url.hash ||
      url.username ||
      url.password ||
      url.searchParams.size !== 2 ||
      url.searchParams.getAll('t').length !== 1 ||
      url.searchParams.getAll('a').length !== 1 ||
      !LINK_TOKEN.test(tokens.ticket) ||
      !LINK_TOKEN.test(tokens.attempt) ||
      url.href !== `${url.origin}/link/start?t=${tokens.ticket}&a=${tokens.attempt}`
    ) {
      return null
    }

    return { authorizeUrl: url.href, initiationId: value.initiation_id }
  } catch {
    return null
  }
}

/**
 * The loopback return grammar the platform binds at connect (atum-platform
 * apps/shell/src/lib/matrix-link-return.ts, isMatrixLinkReturnUrl): IPv4 loopback, a port in
 * 1024-65535, the random `/atum/app-link/<43>` path, exactly `code` and `initiation_id`, no
 * fragment or userinfo. Mirrored here so the Mac refuses what the platform would refuse.
 */
export function isLinkReturnUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const base = value.split('?')[0]
    const port = Number(url.port)

    if (
      !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}\/atum\/app-link\/[A-Za-z0-9_-]{43}$/u.test(base) ||
      port < 1024 ||
      port > 65535 ||
      `${url.origin}${url.pathname}` !== base ||
      url.hash ||
      url.username ||
      url.password
    ) {
      return false
    }

    return (
      [...url.searchParams.keys()].sort().join(',') === 'code,initiation_id' &&
      RETURN_CODE.test(url.searchParams.get('code') ?? '') &&
      INITIATION_ID.test(url.searchParams.get('initiation_id') ?? '')
    )
  } catch {
    return false
  }
}

function connectionFrom(value: unknown): MatrixAppConnection | null {
  if (!record(value) || !record(value.connection)) {
    return null
  }

  const connection = value.connection

  if (
    (connection.state !== 'never_linked' && connection.state !== 'linked' && connection.state !== 'unlinked') ||
    typeof connection.connectionRequired !== 'boolean' ||
    typeof connection.available !== 'boolean' ||
    (connection.readiness !== 'not_linked' &&
      connection.readiness !== 'pending' &&
      connection.readiness !== 'ready' &&
      connection.readiness !== 'unavailable') ||
    (connection.state === 'linked') === (connection.readiness === 'not_linked')
  ) {
    return null
  }

  if (
    connection.cleanup !== undefined &&
    connection.cleanup !== 'pending' &&
    connection.cleanup !== 'complete' &&
    connection.cleanup !== 'unconfirmed'
  ) {
    return null
  }

  const cleanup = connection.cleanup

  return {
    state: connection.state,
    connectionRequired: connection.connectionRequired,
    available: connection.available,
    readiness: connection.readiness,
    ...(cleanup === undefined ? {} : { cleanup: cleanup as NonNullable<MatrixAppConnection['cleanup']> })
  }
}

function cloneState(state: MatrixAppConnectionState): MatrixAppConnectionState {
  return { ...state, ...(state.connection ? { connection: { ...state.connection } } : {}) }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
