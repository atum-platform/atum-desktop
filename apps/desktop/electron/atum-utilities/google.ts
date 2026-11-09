import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

import type { UtilityError, UtilityKind, UtilityMailError } from '../../shared/atum-utilities'
import {
  attachmentsOf,
  type GmailApi,
  GmailMailError,
  listDrafts,
  listLabels,
  omittedMessages,
  readMessage
} from '../../shared/gmail-mail'
import { MATRIX_GOOGLE_MAIL_MANAGE_SCOPE } from '../../shared/matrix-google-tools'
import { atumOAuthCompletionHtml } from '../atum-oauth-completion-page'
import type { MainLocale } from '../main-i18n'

import { readDrive } from './google-drive'

export class UtilityFailure extends Error {
  constructor(readonly code: UtilityError | UtilityMailError) { super(code) }
}

/** Safe, finite file-level failures; never expose the provider's error message. */
export class GoogleContentUnavailable extends Error {
  constructor(readonly reason: 'export_too_large' | 'download_restricted') { super(reason) }
}

export interface GoogleClient {
  clientId: string
  clientSecret?: string
}

export interface GoogleCredential extends GoogleClient {
  refreshToken: string
  label: string
  scopes?: string[]
}

/** `google` is the one consent for Gmail, Calendar and Drive; the other two are the
 * earlier separate consents, kept so saved grants and older callers keep working. */
export type GoogleService = 'email-calendar' | 'drive' | 'google'

/** Exactly the scopes saved on the consent screen of project atum-platform. Asking for any
 * other scope would show people an extra warning, so nothing else is ever requested. */
export const GOOGLE_SCOPES = {
  openid: 'openid',
  email: 'https://www.googleapis.com/auth/userinfo.email',
  gmailRead: 'https://www.googleapis.com/auth/gmail.readonly',
  gmailSend: 'https://www.googleapis.com/auth/gmail.send',
  /**
   * Labels, archive, read/star, trash and drafts (agent email control). Defined here so the whole
   * consent change is ONE line: add `GOOGLE_SCOPES.gmailModify` to MAIL_CALENDAR_SCOPES below. It is
   * deliberately NOT requested yet: Gmail's modify scope is restricted and needs Google's
   * verification (owner activation decision). Grants without it answer mailbox actions `scope_missing`.
   */
  gmailModify: MATRIX_GOOGLE_MAIL_MANAGE_SCOPE,
  calendarList: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  calendarEvents: 'https://www.googleapis.com/auth/calendar.events',
  drive: 'https://www.googleapis.com/auth/drive.readonly'
} as const

// Event read/write is covered by calendar.events; the picker only needs list metadata.
export const MAIL_CALENDAR_SCOPES: readonly string[] = [
  GOOGLE_SCOPES.gmailRead,
  GOOGLE_SCOPES.gmailSend,
  GOOGLE_SCOPES.calendarList,
  GOOGLE_SCOPES.calendarEvents
]

/** Identity first (never untickable), so the account is known even if Gmail is unticked. */
export const ONE_CONSENT_SCOPES: readonly string[] = [
  GOOGLE_SCOPES.openid,
  GOOGLE_SCOPES.email,
  ...MAIL_CALENDAR_SCOPES,
  GOOGLE_SCOPES.drive
]

/** What a grant lets Atum do. Gmail reading is what makes a Gmail source; sending needs
 * its own permission; Calendar needs event access (the list scope only names calendars). */
export interface GoogleGrantedServices {
  gmail: boolean
  send: boolean
  calendar: boolean
  calendarList: boolean
  drive: boolean
}

export function grantedServices(scopes: readonly string[]): GoogleGrantedServices {
  const has = (scope: string) => scopes.includes(scope)

  return {
    gmail: has(GOOGLE_SCOPES.gmailRead),
    send: has(GOOGLE_SCOPES.gmailRead) && has(GOOGLE_SCOPES.gmailSend),
    calendar: has(GOOGLE_SCOPES.calendarEvents),
    calendarList: has(GOOGLE_SCOPES.calendarEvents) && has(GOOGLE_SCOPES.calendarList),
    drive: has(GOOGLE_SCOPES.drive)
  }
}

/** Saved credentials from before scopes were recorded hold their consent's full set. */
export function credentialScopes(credential: Pick<GoogleCredential, 'scopes'>, service: 'email-calendar' | 'drive'): readonly string[] {
  return credential.scopes ?? (service === 'drive' ? [GOOGLE_SCOPES.drive] : MAIL_CALENDAR_SCOPES)
}

/** The account's address from the ID token Google's token endpoint returned over TLS (no
 * signature check is needed for a token received directly from that endpoint), else from
 * the OpenID userinfo endpoint. Only a verified address names an account. */
async function grantIdentity(fetchImpl: typeof fetch, token: { id_token?: unknown; access_token: string }, signal: AbortSignal): Promise<string | undefined> {
  if (typeof token.id_token === 'string') {
    try {
      const payload = JSON.parse(Buffer.from(token.id_token.split('.')[1] ?? '', 'base64url').toString('utf8'))

      if (typeof payload?.email === 'string' && payload.email.includes('@') && payload.email_verified !== false) {
        return payload.email
      }
    } catch { /* fall through to userinfo */ }
  }

  const profile = await googleJson(fetchImpl, 'https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${token.access_token}` }, signal })

  return typeof profile?.email === 'string' && profile.email.includes('@') && profile.email_verified !== false ? profile.email : undefined
}

async function boundedJson(response: Response, limit = 4 * 1024 * 1024): Promise<any> {
  const reader = response.body?.getReader()

  if (!reader) { throw new UtilityFailure('network') }
  const chunks: Uint8Array[] = []
  let size = 0

  try {
    for (;;) {
      const { value, done } = await reader.read()

      if (done) { break }
      size += value.byteLength

      if (size > limit) { throw new UtilityFailure('network') }
      chunks.push(value)
    }

    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => {}) }
}

export async function googleResponse(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<Response> {
  let response: Response

  try {
    response = await fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000), redirect: 'error' })
  } catch {
    throw new UtilityFailure(init.signal?.aborted ? 'cancelled' : 'network')
  }

  // Never include provider response bodies in errors: they can contain account
  // data or credentials. Authorization failures are distinct from outages.
  if (response.status === 401) {
    await response.body?.cancel().catch(() => {})

    throw new UtilityFailure('reconnect')
  }

  if (!response.ok) {
    let error: any

    try { error = (await boundedJson(response)).error } catch { /* sanitized below */ }

    if (error === 'invalid_grant') { throw new UtilityFailure('reconnect') }
    const reasons = Array.isArray(error?.errors) ? error.errors.map((item: any) => item.reason) : []

    // Google also uses 403 for quotas; reconnecting cannot repair those limits.
    if (response.status === 403 && reasons.some((reason: string) => ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'].includes(reason))) { throw new UtilityFailure('network') }

    if (reasons.includes('exportSizeLimitExceeded')) { throw new GoogleContentUnavailable('export_too_large') }

    if (reasons.some((reason: string) => ['fileNotDownloadable', 'fileNotExportable', 'download_restricted_for_revision'].includes(reason))) { throw new GoogleContentUnavailable('download_restricted') }
    throw new UtilityFailure(response.status === 403 ? 'denied' : 'network')
  }

  return response
}

/**
 * The Gmail transport the shared mailbox adapters (shared/gmail-mail.ts) run on: the token lives in this
 * closure only. It keeps the closed error codes of the cloud executor (not_found, conflict, invalid_input),
 * and a 403 that is a quota stays a retryable network error rather than a reconnect.
 */
export function desktopGmailApi(fetchImpl: typeof fetch, token: string, signal?: AbortSignal): GmailApi {
  /** One Gmail call; the closed error codes are the same for the JSON endpoints and the media uploads. */
  const call = async (url: string, init: RequestInit, timeoutMs: number, limit?: number): Promise<Record<string, unknown>> => {
    let response: Response

    try {
      response = await fetchImpl(url, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        redirect: 'error'
      })
    } catch {
      throw new UtilityFailure(signal?.aborted ? 'cancelled' : 'network')
    }

    if (!response.ok) {
      let error: any

      try { error = (await boundedJson(response)).error } catch { /* sanitized below */ }
      await response.body?.cancel().catch(() => {})
      const reasons = Array.isArray(error?.errors) ? error.errors.map((item: any) => item.reason) : []

      if (response.status === 401) { throw new UtilityFailure('reconnect') }

      if (response.status === 403) {
        throw new UtilityFailure(reasons.some((reason: string) => ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'].includes(reason)) ? 'network' : 'denied')
      }

      if (response.status === 400) { throw new UtilityFailure('invalid_input') }

      if (response.status === 404) { throw new UtilityFailure('not_found') }

      if (response.status === 409 || response.status === 412) { throw new UtilityFailure('conflict') }
      throw new UtilityFailure('network')
    }

    try {
      const value = await boundedJson(response, limit)

      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch (error) {
      throw error instanceof UtilityFailure ? error : new UtilityFailure('network')
    }
  }

  return {
    json: (path, init, limit) => call(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      method: init?.method ?? 'GET',
      ...(init?.body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) } : {})
    }, 20_000, limit),
    // A message of up to 25 MB leaves in one request: allow the time it takes on an ordinary connection.
    upload: (request, limit) => call(`https://gmail.googleapis.com/upload/gmail/v1/users/me/${request.path}?uploadType=${request.uploadType}`, {
      method: request.method, headers: { 'content-type': request.contentType }, body: request.body as unknown as BodyInit
    }, 120_000, limit)
  }
}

export async function googleJson(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<any> {
  const response = await googleResponse(fetchImpl, url, init)

  try { return await boundedJson(response) } catch { throw new UtilityFailure('network') }
}

/** Google revokes the project grant, including Gmail, Calendar and Drive scopes. */
export async function revokeGoogle(fetchImpl: typeof fetch, token: string): Promise<void> {
  try {
    const response = await fetchImpl('https://oauth2.googleapis.com/revoke', {
      method: 'POST', body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(20_000), redirect: 'error'
    })

    if (response.ok) { await response.body?.cancel();

 return }

    if (response.status === 400 && (await boundedJson(response)).error === 'invalid_token') { return }
    await response.body?.cancel().catch(() => {})
  } catch { /* Only stable errors cross the credential boundary. */ }

  throw new UtilityFailure('network')
}

function tokenBody(client: GoogleClient, values: Record<string, string>): URLSearchParams {
  return new URLSearchParams({ client_id: client.clientId, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}), ...values })
}

export async function refreshGoogle(fetchImpl: typeof fetch, credential: GoogleCredential, signal?: AbortSignal): Promise<string> {
  const token = await googleJson(fetchImpl, 'https://oauth2.googleapis.com/token', {
    method: 'POST', signal, body: tokenBody(credential, { grant_type: 'refresh_token', refresh_token: credential.refreshToken })
  })

  if (typeof token.access_token !== 'string' || !token.access_token) { throw new UtilityFailure('reconnect') }

  return token.access_token
}

/** A fresh PKCE verifier/state/listener for every attempt; no fixed ports or pasted codes. */
export async function authorizeGoogle(
  client: GoogleClient,
  openExternal: (url: string) => Promise<unknown>,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  timeoutMs = 180_000,
  existingLabels: string[] = [],
  service: GoogleService = 'email-calendar',
  locale: MainLocale = 'en'
): Promise<{ credential: GoogleCredential; accessToken: string }> {
  if (signal.aborted) { throw new UtilityFailure('cancelled') }
  const verifier = randomBytes(48).toString('base64url')
  const state = randomBytes(32).toString('base64url')
  let finish: (code: string) => void
  let fail: (error: Error) => void
  const callback = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject })
  // A browser launch failure may win before we start awaiting the callback.
  void callback.catch(() => {})

  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const received = Buffer.from(url.searchParams.get('state') ?? '')

    if (request.method !== 'GET' || url.pathname !== '/callback' || received.length !== state.length || !timingSafeEqual(received, Buffer.from(state))) {
      response.writeHead(400).end(atumOAuthCompletionHtml('invalid-response', locale))

      return
    }

    const code = url.searchParams.get('code')
    const denied = url.searchParams.has('error')

    if (!code || denied) {
      response.end(atumOAuthCompletionHtml('connection-denied', locale), () => fail(new UtilityFailure('denied')))

      return
    }

    response.end(atumOAuthCompletionHtml('connection-approved', locale))
    finish(code)
  })

  const onAbort = () => fail(new UtilityFailure('cancelled'))
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => fail(new UtilityFailure('timeout')), timeoutMs)
  let pendingToken: string | undefined
  let pendingLabel: string | undefined

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })

    if (signal.aborted) { throw new UtilityFailure('cancelled') }
    const address = server.address()

    if (!address || typeof address === 'string') { throw new UtilityFailure('unavailable') }
    const redirectUri = `http://127.0.0.1:${address.port}/callback`
    const scopes = service === 'google' ? ONE_CONSENT_SCOPES : service === 'drive' ? [GOOGLE_SCOPES.drive] : MAIL_CALENDAR_SCOPES
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.search = new URLSearchParams({
      client_id: client.clientId, redirect_uri: redirectUri, response_type: 'code',
      scope: scopes.join(' '), access_type: 'offline', prompt: 'consent select_account',
      // Adding a service later shows only what is missing; the new token covers it all.
      ...(service === 'google' ? { include_granted_scopes: 'true' } : {}),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', state
    }).toString()
    await openExternal(url.toString())
    const code = await callback

    const token = await googleJson(fetchImpl, 'https://oauth2.googleapis.com/token', {
      method: 'POST', signal,
      body: tokenBody(client, { code, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier })
    })

    pendingToken = typeof token.refresh_token === 'string' ? token.refresh_token : token.access_token
    const returned = String(token.scope ?? '').split(' ').filter(Boolean)

    // The one consent keeps what the person allowed (Google lets them untick each
    // permission) and needs at least one service; the separate consents stay all-or-nothing.
    const granted = service === 'google' ? ONE_CONSENT_SCOPES.filter(scope => returned.includes(scope)) : scopes

    if (service === 'google') {
      const allowed = grantedServices(granted)

      if (!allowed.gmail && !allowed.calendar && !allowed.drive) { throw new UtilityFailure('denied') }
    } else if (!scopes.every(scope => returned.includes(scope))) { throw new UtilityFailure('denied') }

    if (typeof token.refresh_token !== 'string' || typeof token.access_token !== 'string') { throw new UtilityFailure('reconnect') }

    let accountAddress: string | undefined

    if (service === 'google') {
      accountAddress = await grantIdentity(fetchImpl, token, signal)
      pendingLabel = accountAddress?.toLowerCase()

      if (!accountAddress) { throw new UtilityFailure('denied') }
      // Exercise each allowed service's real API; a token alone is never connected.
      await verifyGrant(fetchImpl, token.access_token, grantedServices(granted), signal)
    } else {
      const profile = service === 'drive'
        ? (await googleJson(fetchImpl, 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: { authorization: `Bearer ${token.access_token}` }, signal })).user
        : await googleRead(fetchImpl, token.access_token, 'email', {}, undefined, signal)

      pendingLabel = typeof profile?.emailAddress === 'string' ? profile.emailAddress.toLowerCase() : undefined

      // Exercise Calendar's real API too; a token file alone is never connected.
      if (service === 'email-calendar') { await googleRead(fetchImpl, token.access_token, 'calendar', {}, undefined, signal) }

      accountAddress = typeof profile?.emailAddress === 'string' && profile.emailAddress.includes('@') ? profile.emailAddress : undefined
    }

    if (!accountAddress) { throw new UtilityFailure('denied') }

    if (signal.aborted) { throw new UtilityFailure('cancelled') }
    pendingToken = undefined

    return { credential: { ...client, refreshToken: token.refresh_token, label: accountAddress, scopes: [...granted] }, accessToken: token.access_token }
  } catch (error) {
    // A partial grant or failed verification is never retained as a connection.
    // Revocation is grant-wide. An unsuccessful re-consent must not revoke an
    // existing account. If identity could not be read, keep the old grant safe.
    if (pendingToken && (existingLabels.length === 0 || (pendingLabel && !existingLabels.includes(pendingLabel)))) {
      await revokeGoogle(fetchImpl, pendingToken).catch(() => {})
    }

    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    server.closeAllConnections()
    server.close()
  }
}

const DAY_MS = 86_400_000
const CALENDAR_WINDOW_MS = 31 * DAY_MS
/** 30 days leaves a full DST hour inside the provider's 31-day guard. */
const CALENDAR_CHUNK_MS = 30 * DAY_MS
/** One year plus the day-boundary and DST margin; longer ranges are refused. */
const CALENDAR_HISTORY_MS = 370 * DAY_MS

function calendarBounds(input: Record<string, unknown>): { start: Date; end: Date } {
  const start = input.start === undefined ? new Date() : new Date(String(input.start))
  const end = input.end === undefined ? new Date(start.getTime() + 7 * DAY_MS) : new Date(String(input.end))

  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start || end.getTime() - start.getTime() > CALENDAR_HISTORY_MS) {
    throw new UtilityFailure('invalid_input')
  }

  return { start, end }
}

/** One provider-sized window (at most 31 days). */
export function calendarRange(input: Record<string, unknown>): { timeMin: string; timeMax: string } {
  const { start, end } = calendarBounds(input)

  if (end.getTime() - start.getTime() > CALENDAR_WINDOW_MS) { throw new UtilityFailure('invalid_input') }

  return { timeMin: start.toISOString(), timeMax: end.toISOString() }
}

/** A validated span for providers without a window limit, such as the Mac's own calendar. */
export function calendarWindow(input: Record<string, unknown>): { timeMin: string; timeMax: string } {
  const { start, end } = calendarBounds(input)

  return { timeMin: start.toISOString(), timeMax: end.toISOString() }
}

/** History reads become consecutive provider-sized windows, never one oversized query. */
export function calendarWindows(input: Record<string, unknown>): Array<{ timeMin: string; timeMax: string }> {
  const { start, end } = calendarBounds(input)
  const windows: Array<{ timeMin: string; timeMax: string }> = []

  for (let from = start.getTime(); from < end.getTime();) {
    const to = Math.min(from + CALENDAR_CHUNK_MS, end.getTime())
    windows.push(calendarRange({ start: new Date(from).toISOString(), end: new Date(to).toISOString() }))
    from = to
  }

  return windows
}

function messageText(payload: any): string {
  if (!payload || typeof payload !== 'object') { return '' }

  const own = payload.mimeType === 'text/plain' && typeof payload.body?.data === 'string'
    ? Buffer.from(payload.body.data, 'base64url').toString('utf8') : ''

  return [own, ...(Array.isArray(payload.parts) ? payload.parts.map(messageText) : [])].join('\n').slice(0, 40_000)
}

function htmlParts(payload: any): string {
  if (!payload || typeof payload !== 'object') { return '' }

  const own = payload.mimeType === 'text/html' && typeof payload.body?.data === 'string'
    ? Buffer.from(payload.body.data, 'base64url').toString('utf8') : ''

  return [own, ...(Array.isArray(payload.parts) ? payload.parts.map(htmlParts) : [])].join('\n')
}

/** Plain text, else the HTML part reduced to its words (many people only send HTML). */
function bodyText(payload: any, limit: number): string {
  return bodyTextFull(payload).slice(0, limit)
}

/** The same text before any per-call limit, so a read can say when it cut something off. */
function bodyTextFull(payload: any): string {
  const plain = messageText(payload).trim()

  if (plain) { return plain }

  return htmlParts(payload)
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim()
}

function headerOf(message: any, name: string): string {
  const found = Array.isArray(message?.payload?.headers)
    ? message.payload.headers.find((header: any) => String(header?.name).toLowerCase() === name)
    : undefined

  return typeof found?.value === 'string' ? found.value : ''
}

/** `"Lan" <lan@example.com>` → its name and lowercase address; a bare address works too. */
export function parseMailbox(value: string): { name: string; address: string } {
  const angled = /<([^<>\s]+@[^<>\s]+)>/.exec(value)
  const address = (angled?.[1] ?? /[^\s<>,;"]+@[^\s<>,;"]+/.exec(value)?.[0] ?? '').toLowerCase()
  const name = angled ? value.slice(0, angled.index).trim().replace(/^"|"$/g, '').trim() : ''

  return { name, address }
}

function mailboxes(value: string): string[] {
  return value.split(',').map(part => parseMailbox(part).address).filter(Boolean)
}

/** Senders that are machines, not people: they never wait on the owner's reply. */
const AUTOMATED_SENDER = /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer-daemon|postmaster|bounces?|alerts?|automated|news(letter)?s?)([+._-].*)?$/i

function fromAPerson(message: any): boolean {
  const from = parseMailbox(headerOf(message, 'from')).address
  const precedence = headerOf(message, 'precedence').toLowerCase()
  const autoSubmitted = headerOf(message, 'auto-submitted').toLowerCase()

  return Boolean(from) && !AUTOMATED_SENDER.test(from.split('@')[0] ?? '') &&
    !headerOf(message, 'list-unsubscribe') && !headerOf(message, 'list-id') &&
    !['bulk', 'list', 'junk'].includes(precedence) && (!autoSubmitted || autoSubmitted === 'no')
}

const WAITING_QUERY = 'in:inbox newer_than:7d -category:promotions -category:social -category:updates -category:forums'
const WAITING_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'List-Unsubscribe', 'List-Id', 'Precedence', 'Auto-Submitted']

/** Threads from real people, in the last 7 days, whose last message is to the owner and
 * still unanswered. Oldest first: whoever has waited longest. */
async function waitingThreads(fetchImpl: typeof fetch, headers: Record<string, string>, owner: string, signal?: AbortSignal): Promise<any> {
  if (!owner.includes('@')) { throw new UtilityFailure('invalid_input') }
  const list = await googleJson(fetchImpl, `https://gmail.googleapis.com/gmail/v1/users/me/threads?${new URLSearchParams({ maxResults: '25', q: WAITING_QUERY })}`, { headers, signal })
  const ids: string[] = (list.threads ?? []).map((thread: any) => thread?.id).filter((id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(id))
  const found: any[] = []
  let next = 0

  await Promise.all(Array.from({ length: Math.min(5, ids.length) }, async () => {
    while (next < ids.length) {
      const id = ids[next++]
      const query = new URLSearchParams({ format: 'metadata' })

      WAITING_HEADERS.forEach(name => query.append('metadataHeaders', name))
      const thread = await googleJson(fetchImpl, `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(id)}?${query}`, { headers, signal })
      const messages = Array.isArray(thread.messages) ? thread.messages : []
      const last = messages[messages.length - 1]

      if (!last || parseMailbox(headerOf(last, 'from')).address === owner || !fromAPerson(last)) { continue }

      if (![...mailboxes(headerOf(last, 'to')), ...mailboxes(headerOf(last, 'cc'))].includes(owner)) { continue }
      const sender = parseMailbox(headerOf(last, 'from'))
      const at = Number(last.internalDate)

      found.push({
        id, subject: headerOf(messages[0], 'subject') || headerOf(last, 'subject'), from: sender,
        waitingSince: Number.isFinite(at) ? new Date(at).toISOString() : headerOf(last, 'date'),
        snippet: String(last.snippet ?? '').slice(0, 300), messageCount: messages.length
      })
    }
  }))

  found.sort((left, right) => String(left.waitingSince).localeCompare(String(right.waitingSince)))

  return { threads: found.slice(0, 10), more: found.length > 10 || Boolean(list.nextPageToken) }
}

/** One conversation, with what a reply needs to stay in it. Text is bounded per thread. */
async function readThread(fetchImpl: typeof fetch, headers: Record<string, string>, id: unknown, owner: string, signal?: AbortSignal): Promise<any> {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) { throw new UtilityFailure('invalid_input') }
  const thread = await googleJson(fetchImpl, `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(id)}?format=full`, { headers, signal })
  const every = Array.isArray(thread.messages) ? thread.messages : []
  const all = every.slice(-20)
  let budget = 40_000
  let clipped = false

  // Newest first gets the text budget; older messages keep their headers and snippet.
  const messages = [...all].reverse().map((message: any) => {
    const full = bodyTextFull(message.payload)
    const text = budget > 0 ? full.slice(0, Math.min(budget, 12_000)) : ''
    const cut = full.length > text.length

    budget -= text.length

    if (cut) { clipped = true }

    return {
      id: message.id, from: parseMailbox(headerOf(message, 'from')), to: mailboxes(headerOf(message, 'to')),
      cc: mailboxes(headerOf(message, 'cc')), date: headerOf(message, 'date'),
      ...(text ? { text } : { snippet: String(message.snippet ?? '').slice(0, 300) }),
      // A cut body says so; read_message with this id gives the rest.
      ...(cut ? { truncated: true, textLength: full.length } : {}),
      attachments: attachmentsOf(message.payload)
    }
  }).reverse()

  const last = all[all.length - 1]
  const subject = headerOf(all[0], 'subject')
  const lastFrom = parseMailbox(headerOf(last, 'from')).address
  const replyTo = lastFrom && lastFrom !== owner ? [lastFrom] : mailboxes(headerOf(last, 'to')).filter(address => address !== owner).slice(0, 1)
  const messageId = headerOf(last, 'message-id')

  const older = omittedMessages(every, all.length)

  return {
    id: thread.id ?? id, subject, messages, more: (thread.messages?.length ?? 0) > all.length || budget <= 0 || clipped,
    // Never silent: omitted older messages and cut bodies are named, with the way to read them.
    ...(older.olderMessages || clipped ? {
      truncated: true, ...older,
      hint: 'This thread is longer than one answer: call read_message with a message id for the full text or an older message.'
    } : {}),
    reply: {
      threadId: thread.id ?? id,
      to: replyTo,
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      ...(/^<[^<>\s]+>$/.test(messageId) ? { inReplyTo: messageId } : {})
    }
  }
}

/** Exercises each allowed service once; a token alone is never a connection. */
export async function verifyGrant(fetchImpl: typeof fetch, token: string, services: GoogleGrantedServices, signal?: AbortSignal): Promise<void> {
  const headers = { authorization: `Bearer ${token}` }

  if (services.gmail) { await googleJson(fetchImpl, 'https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers, signal }) }

  if (services.calendarList) {
    await googleJson(fetchImpl, 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1', { headers, signal })
  } else if (services.calendar) {
    await googleRead(fetchImpl, token, 'calendar', {}, 'primary', signal)
  }

  if (services.drive) { await googleJson(fetchImpl, 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers, signal }) }
}

/** Without the calendar-list permission only the primary calendar is reachable. */
export function primaryCalendarOnly(label: string): GoogleCalendar[] {
  return [{ id: 'primary', label, primary: true, writable: true }]
}

/** Fixed provider endpoints and read-only operations; callers cannot supply a URL. */
function pageToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 512 &&
    [...value].every(character => {
      const code = character.codePointAt(0)!
      return code >= 0x20 && code !== 0x7f
    })
}

export async function googleRead(fetchImpl: typeof fetch, token: string, kind: UtilityKind, input: Record<string, unknown>, calendarId = 'primary', signal?: AbortSignal): Promise<any> {
  if (kind === 'drive') { return readDrive(fetchImpl, token, input, signal) }
  const headers = { authorization: `Bearer ${token}` }

  if (kind === 'calendar') {
    // Calendar history reads ask for more events; ordinary agenda reads stay small. The
    // budget spans the whole requested range, so a year never returns more than a month would.
    const limit = input.limit === 250 ? 250 : 50
    const events: any[] = []
    let more = false

    for (const window of calendarWindows(input)) {
      if (events.length >= limit) { more = true; break }

      const query = new URLSearchParams({ ...window, singleEvents: 'true', orderBy: 'startTime', maxResults: String(limit) })

      const result = await googleJson(fetchImpl, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${query}`, { headers, signal })

      events.push(...(result.items ?? []).map((event: any) => ({ id: event.id, title: event.summary, start: event.start, end: event.end, location: event.location, description: String(event.description ?? '').slice(0, 4000) })))

      if (result.nextPageToken) { more = true }
    }

    if (events.length > limit) { events.length = limit; more = true }

    return { events, more }
  }

  if (!input.action) { return googleJson(fetchImpl, 'https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers, signal }) }

  // Single-message, label and draft reads go through the shared Gmail adapters (shared/gmail-mail.ts).
  if (input.action === 'message' || input.action === 'labels' || input.action === 'drafts') {
    const sourceId = Array.isArray(input.sources) && typeof input.sources[0] === 'string' ? input.sources[0] : ''
    const api = desktopGmailApi(fetchImpl, token, signal)

    try {
      if (input.action === 'labels') { return await listLabels(api) }

      if (input.action === 'drafts') {
        if (input.pageToken !== undefined && !pageToken(input.pageToken)) { throw new UtilityFailure('invalid_input') }
        const { drafts, nextPageToken } = await listDrafts(api, { action: 'list_drafts', sourceId, ...(typeof input.pageToken === 'string' ? { pageToken: input.pageToken } : {}) })

        return { drafts, more: Boolean(nextPageToken), ...(nextPageToken ? { nextPageToken } : {}) }
      }

      if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(input.id) ||
        (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || (input.offset as number) < 0))) { throw new UtilityFailure('invalid_input') }

      return await readMessage(api, { action: 'read_message', sourceId, messageId: input.id, ...(input.offset ? { offset: input.offset as number } : {}) })
    } catch (error) {
      if (error instanceof GmailMailError) { throw new UtilityFailure(error.code as UtilityMailError) }
      throw error
    }
  }

  // The owner's own address (the source's account) decides who replied last.
  const owner = typeof input.owner === 'string' ? input.owner.toLowerCase() : ''

  if (input.action === 'thread') { return readThread(fetchImpl, headers, input.id, owner, signal) }

  if (input.action === 'waiting') { return waitingThreads(fetchImpl, headers, owner, signal) }

  if (input.action !== 'inbox' || (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 500)) ||
      (input.pageToken !== undefined && !pageToken(input.pageToken))) { throw new UtilityFailure('invalid_input') }
  const query = new URLSearchParams({ maxResults: '25', q: typeof input.query === 'string' ? input.query : 'in:inbox', ...(typeof input.pageToken === 'string' ? { pageToken: input.pageToken } : {}) })
  const result = await googleJson(fetchImpl, `https://gmail.googleapis.com/gmail/v1/users/me/messages?${query}`, { headers, signal })

  const messages = await Promise.all((result.messages ?? []).map(async (message: { id: string }) => {
    const data = await googleJson(fetchImpl, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}?format=metadata`, { headers, signal })

    return { id: data.id, threadId: data.threadId, snippet: data.snippet, headers: data.payload?.headers?.filter((header: any) => ['from', 'to', 'subject', 'date'].includes(String(header.name).toLowerCase())) }
  }))

  // The cursor is Gmail's own opaque page token; only a bounded one goes back to the caller.
  const nextPageToken = pageToken(result.nextPageToken) ? result.nextPageToken : undefined

  return { messages, more: Boolean(nextPageToken), ...(nextPageToken ? { nextPageToken } : {}) }
}

export interface GoogleCalendar {
  id: string
  label: string
  primary: boolean
  writable: boolean
}

/** Enumerate subscribed calendars, including shared calendars, with no extra scopes. */
export async function googleCalendars(fetchImpl: typeof fetch, token: string, signal?: AbortSignal): Promise<GoogleCalendar[]> {
  const calendars = new Map<string, GoogleCalendar>()
  const deadline = AbortSignal.timeout(90_000)
  const operationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  let pageToken = ''
  let pages = 0

  do {
    if (++pages > 20) { throw new UtilityFailure('network') }
    const query = new URLSearchParams({ maxResults: '250', ...(pageToken ? { pageToken } : {}) })
    const result = await googleJson(fetchImpl, `https://www.googleapis.com/calendar/v3/users/me/calendarList?${query}`, { headers: { authorization: `Bearer ${token}` }, signal: operationSignal })

    for (const item of result.items ?? []) {
      if (typeof item.id !== 'string' || item.deleted) { continue }
      calendars.set(item.id, { id: item.id, label: String(item.summaryOverride ?? item.summary ?? item.id), primary: item.primary === true, writable: item.accessRole === 'owner' || item.accessRole === 'writer' })
    }

    pageToken = typeof result.nextPageToken === 'string' ? result.nextPageToken : ''
  } while (pageToken)

  return [...calendars.values()]
}
