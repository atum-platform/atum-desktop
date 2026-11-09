import { randomBytes } from 'node:crypto'

import { type AuthChangeEvent, GoTrueClient, type Session, type SupportedStorage, type User } from '@supabase/auth-js'

import { canRetryAccountRestore } from '../../shared/account-recovery'
import type {
  AtumAccountState as AtumAccountAuthState,
  AtumAccountStatus as AtumAccountAuthStatus,
  AtumAccountIdentity,
  AtumCurrentAccountFacts
} from '../../src/lib/atum-account-facts'

import { accountKeyFor, type AccountRootAuthority, type AccountScopedPaths } from './account-roots'
import { atumAuthBridgeRedirectUrl, type AtumAuthCallbackWaiter } from './auth-deep-link'
import type { SafeStorageAuthStorage } from './credential-vault'
import type { AtumMessagingRuntime } from './runtime'
import type { MessagingAccountSession, MessagingUser } from './types'
import { parseDesktopSession } from './wire'

const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_AUTH_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_HOSTED_ACQUIRE_TIMEOUT_MS = 15_000
const DEFAULT_HOSTED_RESTORE_TIMEOUT_MS = 15_000
const PASSWORD_LOGIN_TIMEOUT_MS = 15_000
const MAX_AUTH_RESPONSE_BYTES = 64 * 1024
const ACTIVE_AUTH_STORAGE_KEY = 'atum-official-auth-v1'
const DEFAULT_ACCOUNT_SWITCH_TIMEOUT_MS = 15_000

export interface AtumAccountConfigInput {
  hostedBaseUrl?: string | null
  supabaseUrl?: string | null
  supabaseAnonKey?: string | null
  providers?: Partial<AtumAccountProviders> | null
}

export interface AtumAccountProviders {
  google: boolean
  password: boolean
}

export interface AtumAccountConfig {
  hostedBaseUrl: string
  supabaseUrl: string
  supabaseAnonKey: string
  providers: AtumAccountProviders
}

export type { AtumAccountAuthState, AtumAccountAuthStatus }
export interface AtumAccountProfile extends AtumAccountIdentity {}

export interface AtumAccountAuthClientOptions {
  fetchImpl?: typeof fetch
  callbacks: AtumAuthCallbackWaiter
  openExternal: (url: string) => Promise<void>
  storage?: SafeStorageAuthStorage
  storageForAccount?: (accountId: string) => SafeStorageAuthStorage
  timeoutMs?: number
  requestTimeoutMs?: number
  hostedAcquireTimeoutMs?: number
  hostedRestoreTimeoutMs?: number
  passwordTimeoutMs?: number
}

export type AtumAuthTerminalOperation = 'acquire' | 'restore' | 'sign_out'
export type AtumAuthTerminalOutcome = 'cancelled' | 'failure' | 'signed_out' | 'success'

export interface AtumAuthTerminalEvent {
  operation: AtumAuthTerminalOperation
  outcome: AtumAuthTerminalOutcome
  code: string
  provider?: keyof AtumAccountProviders
}

export const ATUM_AUTH_STABLE_FAILURE_CODES = [
  'account_already_active',
  'account_activation_failed',
  'account_capability_open_timeout',
  'account_capability_quiescence_failed',
  'account_capability_quiescence_timeout',
  'account_context_unavailable',
  'account_credentials_invalid',
  'account_local_failure',
  'account_workspace_unavailable',
  'account_logout_failed',
  'account_open_timeout',
  'account_quiescence_failed',
  'account_quiescence_timeout',
  'account_refresh_failed',
  'account_refresh_timeout',
  'account_restore_failed',
  'account_restore_rejected',
  'account_session_expired',
  'account_session_projection_failed',
  'account_sign_in_failed',
  'account_storage_failed',
  'account_storage_corrupt',
  'account_storage_decrypt_failed',
  'account_storage_disk_full',
  'account_storage_encrypt_failed',
  'account_storage_read_failed',
  'account_storage_unavailable',
  'account_storage_write_failed',
  'activation_account_mismatch',
  'atum_account_unconfigured',
  'auth_lifecycle_blocked',
  'auth_response_too_large',
  'authorization_browser_unavailable',
  'authorization_cancelled',
  'authorization_callback_denied',
  'authorization_callback_failed',
  'authorization_superseded',
  'authorization_timeout',
  'google_provider_unavailable',
  'hosted_account_mismatch',
  'hosted_session_timeout',
  'hosted_session_unavailable',
  'invalid_token_response',
  'password_provider_unavailable',
  'password_sign_in_timeout',
  'password_sign_in_unavailable',
  'refresh_account_mismatch',
  'token_exchange_timeout'
] as const

const STABLE_AUTH_FAILURE_CODES = new Set<string>(ATUM_AUTH_STABLE_FAILURE_CODES)

/**
 * Cold-restore outcomes that mean "the credential we stored is no longer good",
 * not "signing in is broken". They are reauthentication, so they take the
 * `expired` state and its own story rather than a sign-in failure banner.
 */
const RESTORE_LAPSE_CODES = new Set<string>(['account_restore_rejected', 'account_session_expired'])

/** Renderer/log boundary: preserve only audited enums and numeric HTTP families. */
export function stableAtumAuthFailureCode(error: unknown, fallback = 'account_local_failure'): string {
  const code = error instanceof Error ? error.message : typeof error === 'string' ? error : ''

  if (code.startsWith('authorization_callback_error:')) {
    const detail = code.slice('authorization_callback_error:'.length)

    return ['access_denied', 'authorization_denied', 'user_cancelled'].includes(detail)
      ? 'authorization_callback_denied'
      : 'authorization_callback_failed'
  }

  if (
    STABLE_AUTH_FAILURE_CODES.has(code) ||
    /^(?:account_activation|account_refresh|account_restore|account_storage|authorization|password_sign_in|token_exchange)_failed:\d{3}$/u.test(
      code
    ) ||
    /^hosted_session_rejected:\d{3}$/u.test(code) ||
    /^password_sign_in_rejected:\d{3}$/u.test(code)
  ) {
    return code
  }

  return fallback
}

function accountStorageFailureCode(code: string | null): string | null {
  if (!code) {
    return null
  }

  const suffix = code.startsWith('auth_storage_') ? code.slice('auth_storage_'.length) : 'unavailable'
  const normalized = `account_storage_${suffix}`

  return STABLE_AUTH_FAILURE_CODES.has(normalized) ? normalized : 'account_storage_unavailable'
}

interface LoginAttempt {
  signal: AbortSignal
}

export interface AtumPasswordSignInInput {
  identifier: string
  password: string
}

interface VerifiedAuthCandidate {
  session: MessagingAccountSession
}

type AuthSessionListener = (event: AuthChangeEvent, session: MessagingAccountSession | null) => void

function normalizeHttpUrl(value: string, label: string): string {
  const parsed = new URL(value)
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1'

  if ((parsed.protocol !== 'https:' && !loopback) || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Error(`${label}_must_use_https`)
  }

  if (parsed.username || parsed.password) {
    throw new Error(`${label}_must_not_contain_credentials`)
  }

  parsed.hash = ''
  parsed.search = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')

  return parsed.toString().replace(/\/$/, '')
}

export function resolveAtumAccountConfig(input: AtumAccountConfigInput): AtumAccountConfig | null {
  const hostedBaseUrl = input.hostedBaseUrl?.trim()
  const supabaseUrl = input.supabaseUrl?.trim()
  const supabaseAnonKey = input.supabaseAnonKey?.trim()

  if (!hostedBaseUrl && !supabaseUrl && !supabaseAnonKey) {
    return null
  }

  if (!hostedBaseUrl || !supabaseUrl || !supabaseAnonKey) {
    throw new Error('atum_account_config_incomplete')
  }

  if (/\s/.test(supabaseAnonKey) || supabaseAnonKey.length < 8 || supabaseAnonKey.length > 8192) {
    throw new Error('atum_account_config_invalid_anon_key')
  }

  return {
    hostedBaseUrl: normalizeHttpUrl(hostedBaseUrl, 'hosted_base_url'),
    supabaseUrl: normalizeHttpUrl(supabaseUrl, 'supabase_url'),
    supabaseAnonKey,
    providers: { google: input.providers?.google === true, password: input.providers?.password !== false }
  }
}

function userProjection(user: User): MessagingUser {
  const metadata = user.user_metadata ?? {}

  return {
    id: user.id,
    displayName:
      typeof metadata.full_name === 'string'
        ? metadata.full_name
        : typeof metadata.name === 'string'
          ? metadata.name
          : null,
    handle: typeof metadata.user_name === 'string' ? metadata.user_name : null,
    // Google supplies `picture`; other providers may supply `avatar_url`. This
    // is a local courtesy until the hosted plane projects its own avatar.
    avatarUrl:
      typeof metadata.avatar_url === 'string'
        ? metadata.avatar_url
        : typeof metadata.picture === 'string'
          ? metadata.picture
          : null,
    handleCustomized: null,
    nextHandleChangeAt: null
  }
}

function messagingSession(session: Session, baseUrl: string): MessagingAccountSession {
  if (!session.access_token || !session.refresh_token || !session.user?.id) {
    throw new Error('invalid_token_response')
  }

  return {
    baseUrl,
    user: userProjection(session.user),
    tokens: {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt: Number.isFinite(session.expires_at) ? Number(session.expires_at) : null
    }
  }
}

async function readJson(response: Response, maxBytes = 128 * 1024): Promise<unknown> {
  if (!response.body) {
    return null
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }

    size += value.byteLength

    if (size > maxBytes) {
      await reader.cancel()
      throw new Error('auth_response_too_large')
    }

    chunks.push(value)
  }

  const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')

  try {
    return bytes ? JSON.parse(bytes) : null
  } catch {
    throw new Error('invalid_json_response')
  }
}

function memoryStorage(): SupportedStorage {
  const values = new Map<string, string>()

  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: key => void values.delete(key)
  }
}

function stableAuthError(prefix: string, error: unknown): Error {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {}
  const status = Number(record.status)
  const code = typeof record.code === 'string' ? record.code : ''
  const name = typeof record.name === 'string' ? record.name : ''

  if (name === 'AuthInvalidTokenResponseError') {
    return new Error('invalid_token_response')
  }

  if (code === 'refresh_token_not_found' || code === 'refresh_token_already_used' || status === 401 || status === 403) {
    return new Error('account_session_expired')
  }

  return new Error(`${prefix}_failed${Number.isInteger(status) && status > 0 ? `:${status}` : ''}`)
}

class AuthFetchTracker {
  private lifecycle = new AbortController()
  private blocked = false
  private readonly pending = new Set<Promise<Response>>()
  private failureCode: string | null = null

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly timeoutMs: number,
    private readonly timeoutCode = 'account_auth_timeout'
  ) {}

  readonly fetch: typeof fetch = async (input, init) => {
    if (this.blocked) {
      throw new Error('auth_lifecycle_blocked')
    }

    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signals = [this.lifecycle.signal, timeout]

    if (init?.signal) {
      signals.push(init.signal)
    }

    const request = this.fetchImpl(input, { ...init, signal: AbortSignal.any(signals) })
    this.pending.add(request)

    try {
      return await request
    } catch (error) {
      if (timeout.aborted) {
        this.failureCode = this.timeoutCode
        this.blocked = true
        this.lifecycle.abort()
      }

      if (timeout.aborted || this.lifecycle.signal.aborted || init?.signal?.aborted) {
        return new Response(JSON.stringify({ code: 'request_aborted', msg: 'request aborted' }), {
          status: 499,
          headers: { 'content-type': 'application/json' }
        })
      }

      throw error
    } finally {
      this.pending.delete(request)
    }
  }

  async blockAndDrain(): Promise<void> {
    this.blocked = true
    this.lifecycle.abort()
    await Promise.allSettled([...this.pending])
  }

  reopen(): void {
    this.lifecycle = new AbortController()
    this.blocked = false
  }

  takeFailureCode(): string | null {
    const code = this.failureCode
    this.failureCode = null

    return code
  }
}

/** Official Supabase Auth client adapter; all instances and storage live in Electron main. */
export class SupabaseAtumAccountClient {
  private active: GoTrueClient
  private activeStorage: SupportedStorage
  private readonly tracker: AuthFetchTracker
  private readonly callbacks: AtumAuthCallbackWaiter
  private readonly timeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly hostedAcquireTimeoutMs: number
  private readonly hostedRestoreTimeoutMs: number
  private readonly passwordTimeoutMs: number
  private readonly listeners = new Set<AuthSessionListener>()
  private sessionGeneration = 0
  private suppressEvents = false
  private blocked = false
  private bootstrapErrorCode: string | null = null

  constructor(
    readonly config: AtumAccountConfig,
    private readonly options: AtumAccountAuthClientOptions
  ) {
    this.callbacks = options.callbacks
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_AUTH_REQUEST_TIMEOUT_MS
    this.hostedAcquireTimeoutMs = options.hostedAcquireTimeoutMs ?? DEFAULT_HOSTED_ACQUIRE_TIMEOUT_MS
    this.hostedRestoreTimeoutMs = options.hostedRestoreTimeoutMs ?? DEFAULT_HOSTED_RESTORE_TIMEOUT_MS
    this.passwordTimeoutMs = options.passwordTimeoutMs ?? PASSWORD_LOGIN_TIMEOUT_MS
    this.tracker = new AuthFetchTracker(options.fetchImpl ?? fetch, this.requestTimeoutMs, 'account_refresh_timeout')
    this.activeStorage = options.storage ?? memoryStorage()
    this.active = this.createOfficialClient(this.activeStorage, this.tracker.fetch, ACTIVE_AUTH_STORAGE_KEY)
    this.bindActiveEvents()
  }

  private bindActiveEvents(): void {
    this.active.onAuthStateChange((event, session) => {
      if (this.suppressEvents) {
        return
      }

      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        if (!session) {
          return this.emit('SIGNED_OUT', null)
        }

        this.sessionGeneration += 1
        this.emit(event, messagingSession(session, this.config.hostedBaseUrl))
      } else if (event === 'SIGNED_OUT') {
        this.sessionGeneration += 1
        this.emit(event, null)
      }
    })
  }

  currentFacts(session: MessagingAccountSession | null): AtumCurrentAccountFacts | null {
    return session
      ? {
          authority: 'supabase',
          accountId: session.user.id,
          sessionGeneration: this.sessionGeneration,
          expiresAt: session.tokens.expiresAt,
          // Hermes stores this account's durable consents under
          // `plugin_rule:atum:<accountKey>:<consent>`; the Account page lists
          // and revokes them through the gateway using this prefix.
          consentRulePrefix: `plugin_rule:atum:${accountKeyFor(session.user.id)}:`
        }
      : null
  }

  initialErrorCode(): string | null {
    return this.bootstrapErrorCode
  }

  subscribe(listener: AuthSessionListener): () => void {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  async restore(): Promise<MessagingAccountSession | null> {
    // GoTrue can emit SIGNED_IN/TOKEN_REFRESHED during initialization. As with
    // activate(), the controller must first verify and install this session;
    // publishing it as an update to a not-yet-installed account fails closed.
    const previouslySuppressed = this.suppressEvents
    this.suppressEvents = true

    try {
      const initialized = await this.active.initialize()

      if (this.storageFailureCode()) {
        this.bootstrapErrorCode = accountStorageFailureCode(this.storageFailureCode())

        return null
      }

      if (initialized.error) {
        this.bootstrapErrorCode = stableAuthError('account_restore', initialized.error).message

        return null
      }

      const current = await this.active.getSession()

      if (this.storageFailureCode()) {
        this.bootstrapErrorCode = accountStorageFailureCode(this.storageFailureCode())

        return null
      }

      if (current.error || !current.data.session) {
        this.bootstrapErrorCode = current.error ? stableAuthError('account_restore', current.error).message : null

        return null
      }

      try {
        const restored = await this.verifyHostedSession(
          messagingSession(current.data.session, this.config.hostedBaseUrl),
          undefined,
          'restore'
        )

        this.sessionGeneration += 1
        this.bootstrapErrorCode = null

        return restored
      } catch (error) {
        const code = stableAtumAuthFailureCode(error, 'account_restore_failed')
        const rejected = code === 'hosted_session_rejected:401' || code === 'hosted_session_rejected:403'
        this.bootstrapErrorCode = rejected ? 'account_restore_rejected' : code

        if (rejected) {
          await this.failClosed()
        }

        return null
      }
    } catch (error) {
      this.bootstrapErrorCode = this.storageFailureCode()
        ? accountStorageFailureCode(this.storageFailureCode())
        : stableAtumAuthFailureCode(error, 'account_restore_failed')

      return null
    } finally {
      this.suppressEvents = previouslySuppressed
    }
  }

  async signIn(attempt: LoginAttempt): Promise<VerifiedAuthCandidate> {
    this.assertAvailable()

    const candidateTracker = new AuthFetchTracker(
      this.options.fetchImpl ?? fetch,
      this.requestTimeoutMs,
      'token_exchange_timeout'
    )

    const candidate = this.createOfficialClient(
      memoryStorage(),
      candidateTracker.fetch,
      `atum-candidate-${randomSecret(18)}`
    )

    const callbackLifecycle = new AbortController()
    const callbackSignal = AbortSignal.any([attempt.signal, callbackLifecycle.signal])
    const abortCandidate = () => void candidateTracker.blockAndDrain()
    attempt.signal.addEventListener('abort', abortCandidate, { once: true })

    try {
      await candidate.initialize()
      const state = randomSecret(24)

      const oauth = await candidate.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: atumAuthBridgeRedirectUrl(this.config.hostedBaseUrl, state),
          skipBrowserRedirect: true,
          queryParams: { prompt: 'select_account' }
        }
      })

      if (attempt.signal.aborted) {
        throw new Error('authorization_cancelled')
      }

      if (oauth.error || !oauth.data.url || !oauth.data.flowId) {
        throw stableAuthError('authorization', oauth.error)
      }

      const waiting = this.callbacks.wait({ state, signal: callbackSignal, ttlMs: this.timeoutMs })
      // Browser launch is asynchronous. If the controller stops before it
      // returns, observe this rejection now while retaining `waiting` below so
      // its cancellation error still drives the normal sign-in cleanup.
      void waiting.catch(() => undefined)

      try {
        await this.options.openExternal(oauth.data.url)
      } catch (error) {
        callbackLifecycle.abort()
        await candidateTracker.blockAndDrain()
        await waiting.catch(() => undefined)
        throw error instanceof Error ? error : new Error('authorization_browser_unavailable')
      }

      const code = await waiting
      const exchanged = await candidate.exchangeCodeForSession(code, { flowId: oauth.data.flowId })

      if (attempt.signal.aborted) {
        throw new Error('authorization_cancelled')
      }

      if (exchanged.error || !exchanged.data.session) {
        throw new Error(
          candidateTracker.takeFailureCode() ?? stableAuthError('token_exchange', exchanged.error).message
        )
      }

      return { session: messagingSession(exchanged.data.session, this.config.hostedBaseUrl) }
    } finally {
      callbackLifecycle.abort()
      attempt.signal.removeEventListener('abort', abortCandidate)
      await candidateTracker.blockAndDrain()
      await candidate.dispose()
    }
  }

  async signInWithPassword(input: AtumPasswordSignInInput, signal?: AbortSignal): Promise<VerifiedAuthCandidate> {
    this.assertAvailable()

    const tracker = new AuthFetchTracker(
      this.options.fetchImpl ?? fetch,
      this.passwordTimeoutMs,
      'password_sign_in_timeout'
    )

    const candidate = this.createOfficialClient(memoryStorage(), tracker.fetch, `atum-candidate-${randomSecret(18)}`)
    const abortCandidate = () => void tracker.blockAndDrain()
    signal?.addEventListener('abort', abortCandidate, { once: true })

    try {
      await candidate.initialize()

      let result:
        | Awaited<ReturnType<GoTrueClient['signInWithPassword']>>
        | Awaited<ReturnType<GoTrueClient['setSession']>>

      if (input.identifier.includes('@')) {
        result = await candidate.signInWithPassword({ email: input.identifier, password: input.password })
      } else if (input.identifier.startsWith('+')) {
        result = await candidate.signInWithPassword({ phone: input.identifier, password: input.password })
      } else {
        const hosted = await this.hostedPasswordSession(input, signal)
        result = await candidate.setSession({
          access_token: hosted.tokens.accessToken,
          refresh_token: hosted.tokens.refreshToken ?? ''
        })
      }

      if (signal?.aborted) {
        throw new Error('authorization_cancelled')
      }

      if (result.error || !result.data.session) {
        throw new Error(tracker.takeFailureCode() ?? stableAuthError('password_sign_in', result.error).message)
      }

      return { session: messagingSession(result.data.session, this.config.hostedBaseUrl) }
    } finally {
      signal?.removeEventListener('abort', abortCandidate)
      await tracker.blockAndDrain()
      await candidate.dispose()
    }
  }

  async activate(candidate: VerifiedAuthCandidate): Promise<MessagingAccountSession> {
    this.assertAvailable()
    this.suppressEvents = true

    try {
      const accountStorage = this.options.storageForAccount?.(candidate.session.user.id)

      if (accountStorage) {
        await this.replaceActiveStorage(accountStorage)
      }

      let result: Awaited<ReturnType<GoTrueClient['setSession']>>

      try {
        result = await this.active.setSession({
          access_token: candidate.session.tokens.accessToken,
          refresh_token: candidate.session.tokens.refreshToken ?? ''
        })
      } catch (error) {
        const storageFailure = accountStorageFailureCode(this.storageFailureCode())

        if (storageFailure) {
          throw new Error(storageFailure)
        }

        throw error
      }

      const storageFailure = accountStorageFailureCode(this.storageFailureCode())

      if (storageFailure) {
        throw new Error(storageFailure)
      }

      if (result.error || !result.data.session) {
        throw stableAuthError('account_activation', result.error)
      }

      const active = messagingSession(result.data.session, this.config.hostedBaseUrl)

      if (active.user.id !== candidate.session.user.id) {
        throw new Error('activation_account_mismatch')
      }

      this.sessionGeneration += 1
      this.bootstrapErrorCode = null

      return { ...active, user: candidate.session.user }
    } finally {
      this.suppressEvents = false
    }
  }

  async refresh(expected: MessagingAccountSession, signal?: AbortSignal): Promise<MessagingAccountSession | null> {
    this.assertAvailable()
    const before = await this.active.getSession()

    if (before.error || !before.data.session || before.data.session.user.id !== expected.user.id) {
      throw new Error('refresh_account_mismatch')
    }

    if (signal?.aborted) {
      return null
    }

    const abort = () => void this.tracker.blockAndDrain()
    signal?.addEventListener('abort', abort, { once: true })
    const result = await this.active.refreshSession()
    signal?.removeEventListener('abort', abort)

    if (signal?.aborted) {
      await this.tracker.blockAndDrain()

      if (!this.blocked) {
        this.tracker.reopen()
      }

      return null
    }

    if (result.error || !result.data.session) {
      throw new Error(this.tracker.takeFailureCode() ?? stableAuthError('account_refresh', result.error).message)
    }

    const refreshed = messagingSession(result.data.session, this.config.hostedBaseUrl)

    if (refreshed.user.id !== expected.user.id) {
      throw new Error('refresh_account_mismatch')
    }

    return refreshed
  }

  async verifyHostedSession(
    session: MessagingAccountSession,
    signal?: AbortSignal,
    deadline: 'acquire' | 'restore' = 'acquire'
  ): Promise<MessagingAccountSession> {
    const attempts = deadline === 'restore' ? 2 : 1
    let response: Response | null = null

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const timeout = AbortSignal.timeout(
        deadline === 'restore' ? this.hostedRestoreTimeoutMs : this.hostedAcquireTimeoutMs
      )

      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout

      try {
        response = await (this.options.fetchImpl ?? fetch)(`${this.config.hostedBaseUrl}/api/desktop/v1/session`, {
          headers: { accept: 'application/json', authorization: `Bearer ${session.tokens.accessToken}` },
          cache: 'no-store',
          signal: requestSignal
        })

        break
      } catch {
        if (signal?.aborted) {
          throw new Error('authorization_cancelled')
        }

        if (attempt + 1 < attempts) {
          continue
        }

        throw new Error(timeout.aborted ? 'hosted_session_timeout' : 'hosted_session_unavailable')
      }
    }

    if (!response) {
      throw new Error('hosted_session_unavailable')
    }

    if (!response.ok) {
      throw new Error(`hosted_session_rejected:${response.status}`)
    }

    const body = await readJson(response, MAX_AUTH_RESPONSE_BYTES)
    const verified = parseDesktopSession(body)

    if (verified.user.id !== session.user.id) {
      throw new Error('hosted_account_mismatch')
    }

    return { ...session, user: verified.user }
  }

  async signOut(): Promise<string | null> {
    return this.removeOfficialSession('global')
  }

  async failClosed(): Promise<void> {
    await this.removeOfficialSession('local')
  }

  startAutoRefresh(): void {
    this.assertAvailable()
    this.active.startAutoRefresh()
  }

  private async removeOfficialSession(scope: 'global' | 'local'): Promise<string | null> {
    this.blocked = true
    this.active.stopAutoRefresh()
    await this.tracker.blockAndDrain()
    this.tracker.reopen()
    this.suppressEvents = true
    let errorCode: string | null = null

    try {
      const result = await this.active.signOut({ scope })

      if (result.error) {
        errorCode = 'account_logout_failed'
      }
    } catch {
      errorCode = 'account_logout_failed'
    } finally {
      await this.tracker.blockAndDrain()

      try {
        this.clearActiveStorage()
      } catch {
        errorCode ??= 'account_storage_failed'
      }

      this.sessionGeneration += 1
      this.suppressEvents = false
      this.tracker.reopen()
      this.blocked = false
      this.emit('SIGNED_OUT', null)
    }

    return errorCode
  }

  async dispose(): Promise<void> {
    this.blocked = true
    this.active.stopAutoRefresh()
    await this.tracker.blockAndDrain()
    await this.active.dispose()
    this.listeners.clear()
  }

  private createOfficialClient(storage: SupportedStorage, fetchImpl: typeof fetch, storageKey: string): GoTrueClient {
    return new GoTrueClient({
      url: `${this.config.supabaseUrl}/auth/v1`,
      headers: { apikey: this.config.supabaseAnonKey },
      storageKey,
      storage,
      fetch: fetchImpl,
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      skipAutoInitialize: true
    })
  }

  private async replaceActiveStorage(storage: SafeStorageAuthStorage): Promise<void> {
    this.active.stopAutoRefresh()
    await this.tracker.blockAndDrain()
    await this.active.dispose()
    this.activeStorage = storage
    this.active = this.createOfficialClient(storage, this.tracker.fetch, ACTIVE_AUTH_STORAGE_KEY)
    this.tracker.reopen()
    this.bindActiveEvents()
    const initialized = await this.active.initialize()

    if (initialized.error || storage.failureCode()) {
      throw new Error(storage.failureCode() ?? stableAuthError('account_storage', initialized.error).message)
    }
  }

  private storageFailureCode(): string | null {
    return this.activeStorage instanceof Object && 'failureCode' in this.activeStorage
      ? (this.activeStorage as SafeStorageAuthStorage).failureCode()
      : null
  }

  private clearActiveStorage(): void {
    if (this.activeStorage instanceof Object && 'clear' in this.activeStorage) {
      ;(this.activeStorage as SafeStorageAuthStorage).clear()

      return
    }

    void this.activeStorage.removeItem(ACTIVE_AUTH_STORAGE_KEY)
  }

  private async hostedPasswordSession(
    input: AtumPasswordSignInInput,
    signal?: AbortSignal
  ): Promise<MessagingAccountSession> {
    const timeout = AbortSignal.timeout(this.passwordTimeoutMs)
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response

    try {
      response = await (this.options.fetchImpl ?? fetch)(`${this.config.hostedBaseUrl}/api/desktop/v1/auth/password`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(input),
        cache: 'no-store',
        signal: requestSignal
      })
    } catch {
      if (signal?.aborted) {
        throw new Error('authorization_cancelled')
      }

      throw new Error(timeout.aborted ? 'password_sign_in_timeout' : 'password_sign_in_unavailable')
    }

    if (!response.ok) {
      throw new Error(`password_sign_in_rejected:${response.status}`)
    }

    const body = await readJson(response, MAX_AUTH_RESPONSE_BYTES)
    const root = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const record = root.session && typeof root.session === 'object' ? (root.session as Record<string, unknown>) : {}
    const projected = record.user && typeof record.user === 'object' ? (record.user as Record<string, unknown>) : {}
    const accessToken = typeof record.access_token === 'string' ? record.access_token : ''
    const refreshToken = typeof record.refresh_token === 'string' ? record.refresh_token : ''

    if (!accessToken || !refreshToken || typeof projected.id !== 'string' || !projected.id) {
      throw new Error('invalid_token_response')
    }

    return {
      baseUrl: this.config.hostedBaseUrl,
      user: {
        id: projected.id,
        displayName: typeof projected.display_name === 'string' ? projected.display_name : null,
        handle: typeof projected.handle === 'string' ? projected.handle : null,
        avatarUrl: null,
        handleCustomized: null,
        nextHandleChangeAt: null
      },
      tokens: { accessToken, refreshToken, expiresAt: null }
    }
  }

  private emit(event: AuthChangeEvent, session: MessagingAccountSession | null): void {
    for (const listener of this.listeners) {
      listener(event, session)
    }
  }

  private assertAvailable(): void {
    if (this.blocked) {
      throw new Error('auth_lifecycle_blocked')
    }
  }
}

export interface AtumAccountAuthControllerOptions {
  runtime: AtumMessagingRuntime
  client: SupabaseAtumAccountClient | null
  accountRoots?: AccountRootAuthority
  capabilities?: {
    activateAccount(input: {
      accountId: string
      generation: number
      paths: AccountScopedPaths
    }): Promise<unknown> | unknown
    revokeAccount(input: { accountId: string; accountGeneration: number }): Promise<unknown> | unknown
  }
  switchTimeoutMs?: number
  onTerminal?: (event: AtumAuthTerminalEvent) => void
}

export class AtumAccountAuthController {
  private activeAttempt: AbortController | null = null
  private refreshLifecycle = new AbortController()
  private transientState: AtumAccountAuthState | null = null
  private errorCode: string | null
  private unsubscribe: (() => void) | null = null
  private signingOut = false
  private accountGeneration: number
  private restoreFlight: Promise<AtumAccountAuthStatus> | null = null

  constructor(private readonly options: AtumAccountAuthControllerOptions) {
    this.errorCode = options.client?.initialErrorCode() ?? null

    try {
      this.accountGeneration = options.accountRoots?.committed()?.marker.generation ?? 0
    } catch {
      this.accountGeneration = 0
      this.errorCode = 'account_context_unavailable'

      try {
        options.accountRoots?.clearCommit()
      } catch {
        // The stable context error below remains the only renderer/log fact.
      }
    }

    this.unsubscribe =
      options.client?.subscribe((event, session) => {
        if (event === 'SIGNED_OUT' || !session) {
          if (!this.signingOut) {
            this.transientState = 'expired'
            this.errorCode = 'account_session_expired'
          }

          void this.options.runtime.clearSession()

          return
        }

        void this.options.runtime.updateSession(session).catch(async () => {
          await this.options.client?.failClosed()
          await this.options.runtime.clearSession()
          this.transientState = 'error'
          this.errorCode = 'account_session_projection_failed'
        })
      }) ?? null
  }

  status(): AtumAccountAuthStatus {
    const account = this.options.runtime.accountProfile()
    const session = this.options.runtime.currentSession()

    return {
      state:
        this.transientState ??
        (account ? 'signed_in' : this.options.client ? (this.errorCode ? 'error' : 'signed_out') : 'unconfigured'),
      configured: Boolean(this.options.client),
      account,
      current: this.options.client?.currentFacts(session) ?? null,
      errorCode: this.errorCode,
      providers: this.options.client?.config.providers ?? { google: false, password: false }
    }
  }

  async signIn(): Promise<AtumAccountAuthStatus> {
    return this.acquire(attempt => this.options.client!.signIn(attempt), 'google')
  }

  async signInWithPassword(input: AtumPasswordSignInInput): Promise<AtumAccountAuthStatus> {
    return this.acquire(attempt => this.options.client!.signInWithPassword(input, attempt.signal), 'password')
  }

  /** Retry only a transient startup verification failure, using the same restore flight. */
  retryRestore(): Promise<AtumAccountAuthStatus> {
    if (this.restoreFlight) {
      return this.restoreFlight
    }

    const status = this.status()

    if (this.activeAttempt || this.signingOut || status.account || status.state !== 'error' || !canRetryAccountRestore(status.errorCode)) {
      return Promise.resolve(status)
    }

    return this.restore()
  }

  /** Cold restore is intentionally callable after window creation; custody remains main-only. */
  async restore(): Promise<AtumAccountAuthStatus> {
    if (!this.restoreFlight) {
      this.restoreFlight = this.restoreOnce().finally(() => {
        this.restoreFlight = null
      })
    }

    return this.restoreFlight
  }

  private async restoreOnce(): Promise<AtumAccountAuthStatus> {
    if (!this.options.client) {
      this.terminal({ operation: 'restore', outcome: 'signed_out', code: 'none' })

      return this.status()
    }

    let restored: MessagingAccountSession | null

    try {
      restored = await this.options.client.restore()
    } catch {
      this.transientState = 'error'
      this.errorCode = 'account_restore_failed'
      this.terminal({ operation: 'restore', outcome: 'failure', code: this.errorCode })

      return this.status()
    }

    if (!restored) {
      const bootstrap = this.options.client.initialErrorCode()
      const code = stableAtumAuthFailureCode(bootstrap, 'account_restore_failed')

      if (bootstrap === 'account_restore_rejected') {
        try {
          this.options.accountRoots?.clearCommit()
        } catch {
          // Revoked credentials are already closed; retain the stable failure.
        }
      }

      // A cold restore that finds a lapsed credential learned exactly what a
      // failed `refresh()` learns, and that path already calls it 'expired'.
      // Reporting the same fact as 'error' put a red sign-in failure on a
      // window nobody had touched yet, and picked the wrong story on top of
      // it: both codes classify as 'provider', so a session that simply ran
      // out was announced as a sign-in outage ("try again in a few minutes").
      // 'expired' is the state that owns reauthentication, and it keeps this
      // account's local projection instead of reading as a logout.
      this.transientState = bootstrap ? (RESTORE_LAPSE_CODES.has(code) ? 'expired' : 'error') : null
      this.errorCode = bootstrap ? code : null
      this.terminal({
        operation: 'restore',
        outcome: this.errorCode ? 'failure' : 'signed_out',
        code: this.errorCode ?? 'none'
      })

      return this.status()
    }

    let capabilityActive = false

    try {
      const committed = this.options.accountRoots?.committed() ?? null

      if (this.options.accountRoots) {
        this.options.accountRoots.assertCommittedAccount(restored.user.id)

        if (!committed) {
          throw new Error('account_context_unavailable')
        }
      }

      await this.options.runtime.installSession(restored, { publish: false })

      if (committed) {
        await Promise.resolve(
          this.options.capabilities?.activateAccount({
            accountId: restored.user.id,
            generation: committed.marker.generation,
            paths: committed.paths
          })
        )
        capabilityActive = true
        this.accountGeneration = committed.marker.generation
      }

      await this.options.runtime.publishInstalledSession()
      this.options.client.startAutoRefresh()
      this.transientState = null
      this.errorCode = null
      this.terminal({ operation: 'restore', outcome: 'success', code: 'none' })
    } catch (error) {
      const rawCode = error instanceof Error ? error.message : ''
      const contextInvalid = rawCode === 'account_context_mismatch' || rawCode === 'account_context_unavailable'
      const code = contextInvalid ? 'account_context_unavailable' : stableAtumAuthFailureCode(error)

      if (capabilityActive) {
        await Promise.resolve(
          this.options.capabilities?.revokeAccount({
            accountId: restored.user.id,
            accountGeneration: this.accountGeneration
          })
        ).catch(() => undefined)
      }

      await this.options.runtime.quiesce().catch(() => undefined)
      await this.options.client.failClosed()

      if (contextInvalid) {
        try {
          this.options.accountRoots?.clearCommit()
        } catch {
          // Custody and local resources are already closed.
        }
      }

      this.transientState = 'error'
      this.errorCode = code
      this.terminal({ operation: 'restore', outcome: 'failure', code })
    }

    return this.status()
  }

  cancel(): AtumAccountAuthStatus {
    this.activeAttempt?.abort()
    this.transientState = this.options.runtime.accountProfile()
      ? null
      : this.options.client
        ? 'signed_out'
        : 'unconfigured'
    this.errorCode = null

    return this.status()
  }

  async refresh(session: MessagingAccountSession, signal?: AbortSignal): Promise<MessagingAccountSession | null> {
    if (!this.options.client) {
      return null
    }

    const lifecycle = this.refreshLifecycle.signal
    const requestSignal = signal ? AbortSignal.any([signal, lifecycle]) : lifecycle
    this.transientState = this.transientState === 'signing_in' ? this.transientState : 'refreshing'
    this.errorCode = null

    try {
      const refreshed = await this.options.client.refresh(session, requestSignal)

      if (!requestSignal.aborted && this.transientState !== 'signing_in') {
        this.transientState = refreshed ? null : 'expired'
        this.errorCode = refreshed ? null : 'account_session_expired'
      }

      return requestSignal.aborted ? null : refreshed
    } catch (error) {
      if (requestSignal.aborted) {
        return null
      }

      const code = stableAtumAuthFailureCode(error, 'account_refresh_failed')

      if (code === 'account_session_expired' || code === 'refresh_account_mismatch') {
        await this.options.client.failClosed()
        await this.options.runtime.clearSession()
      }

      this.transientState = 'expired'
      this.errorCode = code

      return null
    }
  }

  async signOut(): Promise<AtumAccountAuthStatus> {
    // A renderer can request logout while cold restore is still checking the
    // hosted session. Let restore reach a terminal state first so it cannot
    // republish custody after a successful global sign-out.
    await this.restoreFlight

    const activeAccount = this.options.runtime.currentSession()?.user.id ?? null
    const activeGeneration = this.accountGeneration
    this.activeAttempt?.abort()
    this.activeAttempt = null
    this.abortRefreshes()
    this.signingOut = true

    try {
      let quiescenceError: string | null = null

      if (activeAccount) {
        try {
          await this.switchBarrier(
            Promise.resolve(
              this.options.capabilities?.revokeAccount({
                accountId: activeAccount,
                accountGeneration: activeGeneration
              })
            ),
            'account_capability_quiescence_timeout'
          )
        } catch (error) {
          quiescenceError = error instanceof Error ? error.message : 'account_capability_quiescence_failed'
        }
      }

      try {
        await this.switchBarrier(this.options.runtime.quiesce(), 'account_quiescence_timeout')
      } catch (error) {
        quiescenceError ??= error instanceof Error ? error.message : 'account_quiescence_failed'
      }

      let logoutError: string | null

      if (quiescenceError) {
        await this.options.client?.failClosed()
        logoutError = quiescenceError
      } else {
        logoutError = (await this.options.client?.signOut()) ?? null
      }

      try {
        this.options.accountRoots?.clearCommit()
      } catch {
        logoutError ??= 'account_context_unavailable'
      }

      const stableLogoutError = logoutError ? stableAtumAuthFailureCode(logoutError) : null
      this.transientState = stableLogoutError ? 'error' : null
      this.errorCode = stableLogoutError
      this.terminal({
        operation: 'sign_out',
        outcome: stableLogoutError ? 'failure' : 'success',
        code: stableLogoutError ?? 'none'
      })
    } finally {
      this.signingOut = false
    }

    return this.status()
  }

  stop(): void {
    const activeAccount = this.options.runtime.currentSession()?.user.id

    if (activeAccount) {
      void Promise.resolve(
        this.options.capabilities?.revokeAccount({
          accountId: activeAccount,
          accountGeneration: this.accountGeneration
        })
      ).catch(() => undefined)
    }

    this.activeAttempt?.abort()
    this.activeAttempt = null
    this.abortRefreshes()
    this.unsubscribe?.()
    this.unsubscribe = null
    void this.options.client?.dispose()
  }

  private async acquire(
    acquireCandidate: (attempt: LoginAttempt) => Promise<VerifiedAuthCandidate>,
    provider: keyof AtumAccountProviders
  ): Promise<AtumAccountAuthStatus> {
    // The window may already be interactive while cold restore is checking the
    // hosted session. Serialize custody mutations without delaying first paint.
    await this.restoreFlight

    if (!this.options.client) {
      this.transientState = 'unconfigured'
      this.errorCode = 'atum_account_unconfigured'
      this.terminal({ operation: 'acquire', provider, outcome: 'failure', code: this.errorCode })

      return this.status()
    }

    if (!this.options.client.config.providers[provider]) {
      this.transientState = this.options.runtime.accountProfile() ? null : 'signed_out'
      this.errorCode = `${provider}_provider_unavailable`
      this.terminal({ operation: 'acquire', provider, outcome: 'failure', code: this.errorCode })

      return this.status()
    }

    if (this.options.runtime.accountProfile() && !this.options.accountRoots) {
      this.errorCode = 'account_already_active'
      this.terminal({ operation: 'acquire', provider, outcome: 'failure', code: this.errorCode })

      return this.status()
    }

    if (this.activeAttempt) {
      return this.status()
    }

    const attempt = new AbortController()
    this.activeAttempt = attempt
    this.transientState = 'signing_in'
    this.errorCode = null
    let activated = false
    let quiesced = false
    let previousCommit = null as ReturnType<AccountRootAuthority['committed']>
    let committedAccountKey: string | null = null
    let capabilityAccount: { accountId: string; accountGeneration: number } | null = null

    try {
      const acquired = await acquireCandidate({ signal: attempt.signal })
      const verified = await this.options.client.verifyHostedSession(acquired.session, attempt.signal)

      if (attempt.signal.aborted || this.activeAttempt !== attempt) {
        throw new Error('authorization_cancelled')
      }

      const previousAccount = this.options.runtime.accountProfile()
      const nextGeneration = this.accountGeneration + 1

      previousCommit = this.options.accountRoots?.committed() ?? null
      this.options.accountRoots?.prepare(verified.user.id)

      if (previousAccount) {
        this.abortRefreshes()
        quiesced = true
        await this.switchBarrier(
          Promise.resolve(
            this.options.capabilities?.revokeAccount({
              accountId: previousAccount.id,
              accountGeneration: this.accountGeneration
            })
          ),
          'account_capability_quiescence_timeout'
        )
        await this.switchBarrier(this.options.runtime.quiesce(), 'account_quiescence_timeout')
      }

      const activeSession = await this.options.client.activate({ session: verified })
      activated = true

      if (attempt.signal.aborted || this.activeAttempt !== attempt) {
        throw new Error('authorization_cancelled')
      }

      this.abortRefreshes()
      await this.switchBarrier(
        this.options.runtime.installSession(activeSession, { publish: false }),
        'account_open_timeout'
      )

      if (
        attempt.signal.aborted ||
        this.activeAttempt !== attempt ||
        this.options.runtime.currentSession()?.user.id !== activeSession.user.id
      ) {
        throw new Error('authorization_cancelled')
      }

      const committed = this.options.accountRoots?.commit(activeSession.user.id, nextGeneration)
      committedAccountKey = committed?.accountKey ?? null
      this.accountGeneration = nextGeneration

      if (committed && this.options.accountRoots) {
        capabilityAccount = { accountId: activeSession.user.id, accountGeneration: nextGeneration }
        await this.switchBarrier(
          Promise.resolve(
            this.options.capabilities?.activateAccount({
              accountId: activeSession.user.id,
              generation: nextGeneration,
              paths: this.options.accountRoots.pathsForAccount(activeSession.user.id)
            })
          ),
          'account_capability_open_timeout'
        )
      }

      await this.options.runtime.publishInstalledSession()
      this.options.client.startAutoRefresh()
      this.transientState = null
    } catch (error) {
      const code = stableAtumAuthFailureCode(error, 'account_sign_in_failed')

      if (committedAccountKey) {
        try {
          this.options.accountRoots?.rollbackIfCurrent(committedAccountKey, previousCommit?.marker ?? null)
        } catch {
          // Candidate custody still closes below; preserve the initiating code.
        }
      }

      if (capabilityAccount) {
        await Promise.resolve(this.options.capabilities?.revokeAccount(capabilityAccount)).catch(() => undefined)
      }

      if (activated) {
        await this.options.client.failClosed().catch(() => undefined)
      } else if (quiesced) {
        await this.options.client.dispose().catch(() => undefined)
      }

      if (activated || quiesced) {
        await this.options.runtime.quiesce().catch(() => undefined)
      }

      if (code === 'authorization_cancelled') {
        this.transientState = 'signed_out'
        this.errorCode = null
        this.terminal({ operation: 'acquire', provider, outcome: 'cancelled', code })
      } else {
        this.transientState = 'error'
        this.errorCode = code
        this.terminal({ operation: 'acquire', provider, outcome: 'failure', code })
      }
    } finally {
      if (this.activeAttempt === attempt) {
        this.activeAttempt = null
      }
    }

    if (this.transientState === null && this.errorCode === null) {
      this.terminal({ operation: 'acquire', provider, outcome: 'success', code: 'none' })
    }

    return this.status()
  }

  private terminal(event: AtumAuthTerminalEvent): void {
    try {
      this.options.onTerminal?.(event)
    } catch {
      // Diagnostics must never alter credential custody or renderer state.
    }
  }

  private async switchBarrier<T>(operation: Promise<T>, code: string): Promise<T> {
    const timeoutMs = this.options.switchTimeoutMs ?? DEFAULT_ACCOUNT_SWITCH_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | null = null

    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(code)), timeoutMs)
        })
      ])
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }

  private abortRefreshes(): void {
    this.refreshLifecycle.abort()
    this.refreshLifecycle = new AbortController()
  }
}

function randomSecret(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

export {
  ACTIVE_AUTH_STORAGE_KEY,
  DEFAULT_AUTH_REQUEST_TIMEOUT_MS,
  DEFAULT_LOGIN_TIMEOUT_MS,
  MAX_AUTH_RESPONSE_BYTES,
  PASSWORD_LOGIN_TIMEOUT_MS
}
