import { randomUUID } from 'node:crypto'

import {
  connectionCatalogEntry,
  type ConnectionSurface,
  type PlanAcknowledgment,
  planStartDecision
} from '../../shared/connection-catalog'
import { type MatrixModelCapabilities, parseMatrixModelCapabilities } from '../../shared/matrix-model-choice'
import { type MatrixEffort, parseMatrixEffort } from '../../shared/matrix-models'
import type { MatrixPagesRequest } from '../../shared/matrix-pages'
import type {
  MatrixProviderConfirmation,
  MatrixProviderOAuthResult,
  MatrixProviderOAuthSession,
  MatrixProviderRow,
  MatrixProviderSnapshot,
  MatrixProviderWriteResult
} from '../../shared/matrix-provider-settings'
import { matrixPlanOnlyHidden, matrixPlanSignInOffered } from '../../shared/matrix-provider-terms'

import type { MatrixPagesForwardRequest } from './pages-bridge'
import {
  type MatrixSubscriptionAuthLifecycle,
  type MatrixSubscriptionCatalogPhase,
  matrixSubscriptionHttpStatus,
  matrixSubscriptionProviderStartOutcome,
  matrixSubscriptionRequestStatus
} from './subscription-auth-lifecycle'

const PREFIX = '/api/provider-settings/'
const PROFILE = '?profile=default'
const OPTIONS = '/api/model/options?profile=default&explicit_only=1&read_only=1&include_unconfigured=1'

/**
 * Known browser handoff shapes. Inventory is projected from the shared catalog;
 * every actual start separately checks the native surface and stored account consent.
 */
const KNOWN_FLOWS: Record<string, { flow: 'pkce' | 'device_code'; origin: string; pathname: string }> = {
  'openai-codex': { flow: 'device_code', origin: 'https://auth.openai.com', pathname: '/codex/device' },
  'minimax-oauth': { flow: 'device_code', origin: 'https://api.minimax.io', pathname: '/oauth/verify' },
  'xai-oauth': { flow: 'device_code', origin: 'https://accounts.x.ai', pathname: '/oauth2/device' }
}

const FLOWS: Record<string, (typeof KNOWN_FLOWS)[string]> = Object.assign(
  Object.create(null),
  Object.fromEntries(Object.entries(KNOWN_FLOWS).filter(([provider]) => matrixPlanSignInOffered(provider)))
)

/**
 * The key a curated provider takes (Connections' API key cards). Hermes marks these as
 * advanced settings, which the generic rule below skips; naming them here keeps a
 * subscription token (ANTHROPIC_TOKEN, CLAUDE_CODE_OAUTH_TOKEN) from ever being the one.
 */
const PRIMARY_KEYS: Record<string, string> = Object.assign(Object.create(null), {
  'openai-api': 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'opencode-go': 'OPENCODE_GO_API_KEY'
})

function fail(code = 'matrix_provider_response_invalid'): never {
  throw new Error(code)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, max = 512): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= max &&
    !/[\p{Cc}]/u.test(value)
  )
}

function id(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,199}$/.test(value)
}

function secret(value: unknown, blank = false): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 16_384 &&
    (blank || value.trim().length > 0) &&
    !/[\p{Cc}]/u.test(value)
  )
}

function exact(value: unknown, path: string, method: string, fields?: string[]): Record<string, unknown> {
  if (
    !record(value) ||
    Object.keys(value).some(key => !['path', 'method', 'body'].includes(key)) ||
    value.path !== path ||
    (value.method ?? 'GET') !== method
  ) {
    return fail('matrix_pages_request_forbidden')
  }

  if (!fields) {
    if (value.body !== undefined) {
      fail('matrix_pages_request_forbidden')
    }

    return {}
  }

  if (
    !record(value.body) ||
    Object.keys(value.body).length !== fields.length ||
    Object.keys(value.body).some(key => !fields.includes(key))
  ) {
    return fail('matrix_pages_request_forbidden')
  }

  return value.body
}

/**
 * The explicit levels each of one provider's listed models advertises. Only the level list
 * crosses the boundary, never the capability object's other fields (a fixture may carry
 * private metadata there). A model without an advertisement contributes no levels.
 */
function modelEfforts(entry: Record<string, unknown>, models: readonly string[]) {
  if (!record(entry.capabilities)) {
    return undefined
  }

  const efforts: Record<string, MatrixEffort[]> = {}

  for (const model of models) {
    const capability = entry.capabilities[model]

    if (!record(capability)) {
      continue
    }

    const parsed = parseMatrixModelCapabilities({
      id: model,
      displayName: model,
      efforts: capability.efforts
    })

    if (!parsed) {
      continue
    }

    const levels = parsed.efforts.filter((level): level is MatrixEffort => Boolean(parseMatrixEffort(level)))
    efforts[model] = levels
  }

  return Object.keys(efforts).length > 0 ? efforts : undefined
}

/** Reserve the whole synthetic namespace, including malformed near-matches. */
export function isMatrixProvidersRequest(path: unknown): boolean {
  return typeof path === 'string' && path.startsWith(PREFIX)
}

export interface MatrixPagesProvidersScopeDeps {
  /** Bound by native page resolution; no renderer acceptance/surface fields. */
  surface: ConnectionSurface
  readPlanAcknowledgment(provider: string): PlanAcknowledgment | undefined
  savePlanAcknowledgment(acknowledgment: PlanAcknowledgment): void
  today?(): string
  forward(request: MatrixPagesForwardRequest): Promise<unknown>
  isCurrent(): boolean
  confirm(confirmation: MatrixProviderConfirmation): boolean | Promise<boolean>
  openExternal(url: string): void | Promise<void>
  /** Cleanup-only capability pinned to the old runtime; never starts one. */
  cancelOAuth?(upstreamSessionId: string): Promise<void>
  /** Reconcile existing execution routing only after authoritative readback. */
  selected?(
    provider: string,
    model: string,
    reasoning?: boolean,
    capability?: MatrixModelCapabilities
  ): void | Promise<void>
  /** After a confirmed disconnect: forget what this adapter cannot reach (the account's
   * shared ChatGPT sign-in, hermes-runtime.ts `matrixAccountCodexScope`). */
  disconnected?(provider: string): void | Promise<void>
  /** A plan sign-in is waiting on this backend (`true`) or no longer is (`false`): the person
   * is approving it in the browser, and the backend holding it must not be replaced meanwhile
   * (main's model check), or the approved sign-in is never saved. */
  signingIn?(active: boolean): void
  /** A plan sign-in was approved and Hermes reads it back as connected. */
  signedIn?(provider: string): void
  /** Present only for the account-scoped ChatGPT start flow. */
  authLifecycle?(): MatrixSubscriptionAuthLifecycle | undefined
}

interface OAuthBinding {
  upstream: string
  provider: string
  flow: 'pkce' | 'device_code'
}

interface Catalog {
  snapshot: MatrixProviderSnapshot
  keys: Map<string, string>
  endpointNames: Set<string>
}

/** One native hold per browser sign-in. Closing the page releases every hold, not only the last. */
export class MatrixPagesSignInHolds {
  private active = 0

  constructor(private readonly changed?: (active: boolean) => void) {}

  begin(): void {
    this.active += 1
    this.changed?.(true)
  }

  end(): void {
    if (this.active === 0) {return}
    this.active -= 1
    this.changed?.(false)
  }

  stop(): void {
    while (this.active > 0) {
      this.end()
    }
  }
}

/** Not a provider manager: this only projects and protects existing Hermes
 * routes in the selected runtime home. No renderer-selected profile or URL. */
export class MatrixPagesProvidersScope {
  private stopped = false
  private sessions = new Map<string, OAuthBinding>()
  /** Sign-ins that ended here before their backend confirmed it (a failed cancel, a backend this
   * page can no longer reach). They hold nothing; `stop` still cancels them on the original
   * runtime. */
  private orphans = new Set<OAuthBinding>()
  private writing = false
  private startingPlan: string | undefined
  private confirmedPlanStart: string | undefined
  private readonly signIns: MatrixPagesSignInHolds

  constructor(private readonly deps: MatrixPagesProvidersScopeDeps) {
    this.signIns = new MatrixPagesSignInHolds(deps.signingIn)
  }

  private current() {
    if (this.stopped || !this.deps.isCurrent()) {
      fail('matrix_pages_agent_unavailable')
    }
  }

  private async forward(request: MatrixPagesForwardRequest) {
    this.current()

    if (this.startingPlan) {
      this.assertPlanStart(this.startingPlan)
    }

    const response = await this.deps.forward(request)
    this.current()

    if (this.startingPlan) {
      this.assertPlanStart(this.startingPlan)
    }

    return response
  }

  private async confirmed(confirmation: MatrixProviderConfirmation) {
    this.current()
    const accepted = await this.deps.confirm(confirmation)
    this.current()

    return accepted
  }

  private today() {
    return this.deps.today?.() ?? new Date().toISOString().slice(0, 10)
  }

  private assertPlanStart(provider: string) {
    this.current()
    const acknowledgment = this.deps.readPlanAcknowledgment(provider)

    if (
      planStartDecision({
        provider,
        surface: this.deps.surface,
        trustedAcknowledgment: acknowledgment,
        today: this.today()
      }) !== 'allowed'
    ) {
      fail('provider_terms_blocked')
    }

    return acknowledgment
  }

  /** Consent is a separate native step: direct/forged starts without stored
   * consent fail before even reading the upstream catalog. No credential work. */
  private async acknowledgePlan(provider: string): Promise<MatrixProviderWriteResult> {
    this.confirmedPlanStart = undefined
    const entry = connectionCatalogEntry(provider, 'plan')
    const existing = this.deps.readPlanAcknowledgment(provider)

    const candidate: PlanAcknowledgment = {
      provider,
      policyVersion: entry?.policyVersion ?? '',
      acknowledgedAt: this.today()
    }

    // This candidate is only a preflight for showing consent, never OAuth admission.
    if (
      planStartDecision({
        provider,
        surface: this.deps.surface,
        trustedAcknowledgment: candidate,
        today: this.today()
      }) !== 'allowed'
    ) {
      fail('provider_terms_blocked')
    }

    const acknowledgment =
      planStartDecision({
        provider,
        surface: this.deps.surface,
        trustedAcknowledgment: existing,
        today: this.today()
      }) === 'allowed' && existing
        ? existing
        : candidate

    if (
      !(await this.confirmed({
        kind: 'provider-oauth',
        provider,
        ...(entry?.planSignIn === 'pending_approval' ? { planRisk: acknowledgment } : {})
      }))
    ) {
      this.deps.authLifecycle?.()?.nativeConsentResult('cancelled')

      return { status: 'cancelled' }
    }

    this.deps.authLifecycle?.()?.nativeConsentResult('accepted')

    if (
      planStartDecision({
        provider,
        surface: this.deps.surface,
        trustedAcknowledgment: acknowledgment,
        today: this.today()
      }) !== 'allowed'
    ) {
      fail('provider_terms_blocked')
    }

    this.current()
    this.deps.savePlanAcknowledgment(acknowledgment)
    this.deps.authLifecycle?.()?.acknowledgmentPersisted()
    this.current()
    const stored = this.assertPlanStart(provider)
    // Reuse this exact native confirmation once, within this same page lifetime.
    this.confirmedPlanStart = JSON.stringify(stored)

    return { status: 'applied' }
  }

  private async catalog(): Promise<Catalog> {
    const options = await this.catalogForward('model_options', { path: OPTIONS, method: 'GET' })

    const oauth = await this.catalogForward('oauth_catalog', {
      path: `/api/providers/oauth${PROFILE}`,
      method: 'GET'
    })

    const env = await this.catalogForward('environment', { path: `/api/env${PROFILE}`, method: 'GET' })

    const endpoints = await this.catalogForward('custom_endpoints', {
      path: `/api/providers/custom-endpoints${PROFILE}`,
      method: 'GET'
    })

    const info = await this.catalogForward('model_info', { path: `/api/model/info${PROFILE}`, method: 'GET' })

    if (
      !record(options) ||
      !Array.isArray(options.providers) ||
      !record(oauth) ||
      !Array.isArray(oauth.providers) ||
      !record(env) ||
      !record(endpoints) ||
      !Array.isArray(endpoints.endpoints)
    ) {
      fail()
    }

    const rows = new Map<string, MatrixProviderRow>()
    const keys = new Map<string, string>()
    const endpointNames = new Set<string>()
    const endpointIds = new Set<string>()

    for (const entry of options.providers) {
      if (
        !record(entry) ||
        !id(entry.slug) ||
        !text(entry.name ?? entry.label ?? entry.slug) ||
        !Array.isArray(entry.models)
      ) {
        continue
      }

      const models = entry.models.filter((model): model is string => text(model, 1024)).slice(0, 2000)
      const efforts = modelEfforts(entry, models)

      rows.set(entry.slug, {
        id: entry.slug,
        name: String(entry.name ?? entry.label ?? entry.slug),
        ready: entry.authenticated === true && entry.slug !== 'nous',
        current: entry.is_current === true,
        models,
        keyAvailable: false,
        keySet: false,
        oauth: null,
        ...(efforts ? { efforts } : {})
      })
    }

    for (const entry of endpoints.endpoints) {
      if (!record(entry) || !id(entry.id) || !text(entry.name) || !Array.isArray(entry.models)) {
        continue
      }

      endpointNames.add(entry.name.toLocaleLowerCase())
      endpointIds.add(entry.id)
      // Configured no-key local endpoints are usable; the model writer reads
      // their actual stored URL/key itself, never from the renderer payload.
      const row = rows.get(entry.id)

      if (row) {
        row.ready = true
        row.name = entry.name
      } else {
        rows.set(entry.id, {
          id: entry.id,
          name: entry.name,
          ready: true,
          current: entry.is_current === true,
          models: entry.models.filter((model): model is string => text(model, 1024)).slice(0, 2000),
          keyAvailable: false,
          keySet: false,
          oauth: null
        })
      }
    }

    for (const [key, entry] of Object.entries(env)) {
      if (
        !/^[A-Z][A-Z0-9_]{0,199}$/.test(key) ||
        !record(entry) ||
        entry.category !== 'provider' ||
        entry.is_password !== true ||
        !id(entry.provider) ||
        entry.provider === 'nous'
      ) {
        continue
      }

      const row = rows.get(entry.provider)

      if (!row) {
        continue
      }

      // One primary credential per provider, using Hermes catalog membership.
      // Advanced/alias fields are not a generic environment editor.
      const preferred = PRIMARY_KEYS[entry.provider]

      if (preferred ? key !== preferred : entry.advanced === true) {
        continue
      }

      if (!keys.has(entry.provider)) {
        keys.set(entry.provider, key)
        row.keyAvailable = true
        row.keySet = entry.is_set === true
      }
    }

    for (const entry of oauth.providers) {
      if (
        !record(entry) ||
        !id(entry.id) ||
        !text(entry.name) ||
        !['pkce', 'device_code', 'external'].includes(String(entry.flow)) ||
        !record(entry.status)
      ) {
        continue
      }

      const row = rows.get(entry.id) ?? {
        id: entry.id,
        name: entry.name,
        ready: false,
        current: false,
        models: [],
        keyAvailable: false,
        keySet: false,
        oauth: null
      }

      row.oauth = {
        flow: entry.flow as 'pkce' | 'device_code' | 'external',
        connected: entry.status.logged_in === true,
        supported: Boolean(
          FLOWS[entry.id] &&
          FLOWS[entry.id].flow === entry.flow &&
          connectionCatalogEntry(entry.id, 'plan')?.surface === this.deps.surface
        ),
        disconnectable: entry.disconnectable === true && entry.id !== 'nous' && entry.flow !== 'external'
      }

      try {
        const acknowledgment = this.deps.readPlanAcknowledgment(entry.id)

        if (acknowledgment) {
          row.oauth.acknowledgment = {
            policyVersion: acknowledgment.policyVersion,
            acknowledgedAt: acknowledgment.acknowledgedAt
          }
        }
      } catch {
        // A broken consent record cannot break API-key/profile management.
        // The start and acknowledgment paths still refuse it before upstream work.
      }

      rows.set(entry.id, row)
    }

    // One safe connection kind per row: a local endpoint, a plan, or a key. A signed-out
    // plan stays a plan so the picker can offer the way back to Connections.
    for (const row of rows.values()) {
      if (endpointIds.has(row.id)) {
        row.kind = 'endpoint'
      } else if (row.oauth?.connected) {
        row.kind = 'plan'
      } else if (row.keySet) {
        row.kind = 'key'
      } else if (row.oauth) {
        row.kind = 'plan'
      }
    }

    // Read a concrete level list from the selected model's inventory, never from its name
    // or supports_reasoning flag. Older/unknown inventories advertise no levels.
    const providerEntry = record(info)
      ? options.providers.find(entry => record(entry) && entry.slug === info.provider)
      : undefined

    const modelCapabilities =
      record(providerEntry) && record(providerEntry.capabilities) && record(info)
        ? providerEntry.capabilities[String(info.model)]
        : undefined

    const capability = record(info)
      ? parseMatrixModelCapabilities({
          id: info.model,
          displayName: info.model,
          efforts: record(modelCapabilities) ? modelCapabilities.efforts : undefined
        })
      : undefined

    const current =
      record(info) && text(info.provider) && text(info.model, 1024)
        ? {
            provider: info.provider,
            model: info.model,
            ...(record(info.capabilities) && typeof info.capabilities.supports_reasoning === 'boolean'
              ? { reasoning: info.capabilities.supports_reasoning }
              : {}),
            ...(capability
              ? { capability: { ...capability, efforts: capability.efforts.filter(level => level !== 'max') } }
              : {})
          }
        : null

    // A plan-only row Atum does not offer stays out of the list, unless it is connected or
    // in use: then it shows, so the person can see it and disconnect it.
    const providers = [...rows.values()].filter(
      row => !matrixPlanOnlyHidden(row.id) || row.current || row.oauth?.connected || current?.provider === row.id
    )

    return { snapshot: { providers, current }, keys, endpointNames }
  }

  private async catalogForward(phase: MatrixSubscriptionCatalogPhase, request: MatrixPagesForwardRequest) {
    const lifecycle = this.deps.authLifecycle?.()

    if (!lifecycle) {
      return this.forward(request)
    }

    const started = Date.now()
    lifecycle.catalogPhase(phase, 'begin', 0, 'pending')

    try {
      const result = await this.forward(request)
      lifecycle.catalogPhase(phase, 'ok', Date.now() - started, 'ok')

      return result
    } catch (error) {
      lifecycle.catalogPhase(phase, 'failed', Date.now() - started, matrixSubscriptionRequestStatus(error))
      throw error
    }
  }

  private async eligible(provider: string, model?: string) {
    const catalog = await this.catalog()
    const row = catalog.snapshot.providers.find(row => row.id === provider)

    if (!row || provider === 'nous' || (model !== undefined && (!row.ready || !row.models.includes(model)))) {
      fail('matrix_provider_not_ready')
    }

    return { row, catalog }
  }

  private binding(value: unknown): OAuthBinding {
    if (!text(value, 100)) {
      fail('matrix_pages_request_forbidden')
    }

    const binding = this.sessions.get(value)

    if (!binding) {
      fail('matrix_pages_request_forbidden')
    }

    return binding
  }

  private async cancelBinding(handle: string, binding: OAuthBinding) {
    try {
      const result = await this.forward({
        path: `/api/providers/oauth/sessions/${encodeURIComponent(binding.upstream)}${PROFILE}`,
        method: 'DELETE'
      })

      if (!record(result) || typeof result.ok !== 'boolean') {
        fail()
      }
    } catch (error) {
      // The person ended it, so it no longer holds the backend (holdsSignIn). Its upstream
      // session is still cancelled on the original runtime when this scope stops.
      this.orphans.add(binding)

      throw error
    } finally {
      this.release(handle)
    }

    return { status: 'cancelled' } as const
  }

  private async start(provider: string): Promise<MatrixProviderOAuthSession | MatrixProviderWriteResult> {
    const acknowledgment = this.assertPlanStart(provider)

    const alreadyConfirmed =
      this.confirmedPlanStart !== undefined && this.confirmedPlanStart === JSON.stringify(acknowledgment)

    this.confirmedPlanStart = undefined
    this.startingPlan = provider
    const { row } = await this.eligible(provider)

    if (!row.oauth?.supported || !FLOWS[provider] || this.sessions.size > 0) {
      fail('matrix_pages_request_forbidden')
    }

    if (
      !alreadyConfirmed &&
      !(await this.confirmed({
        kind: 'provider-oauth',
        provider,
        ...(connectionCatalogEntry(provider, 'plan')?.planSignIn === 'pending_approval' && acknowledgment
          ? { planRisk: acknowledgment }
          : {})
      }))
    ) {
      return { status: 'cancelled' }
    }

    this.assertPlanStart(provider)

    if (!(await this.eligible(provider)).row.oauth?.supported) {
      fail()
    }

    // Capture a late-created session even after retirement, then cancel it
    // against this same pinned backend. It can never be resumed on another page.
    this.assertPlanStart(provider)
    const lifecycle = this.deps.authLifecycle?.()
    const dispatchStarted = Date.now()
    lifecycle?.providerStartDispatchBegin()
    let result: unknown

    try {
      result = await this.deps.forward({
        path: `/api/providers/oauth/${provider}/start${PROFILE}`,
        method: 'POST'
      })

      if (!record(result) || !text(result.session_id, 128) || !/^[A-Za-z0-9_-]+$/.test(result.session_id)) {
        fail()
      }
    } catch (error) {
      lifecycle?.providerStartDispatchEnd(
        matrixSubscriptionProviderStartOutcome(error),
        Date.now() - dispatchStarted,
        matrixSubscriptionHttpStatus(error) ?? (record(result) ? 200 : undefined)
      )
      throw error
    }

    if (!record(result)) {
      fail()
    }

    const binding: OAuthBinding = {
      upstream: String(result.session_id),
      provider,
      flow: FLOWS[provider].flow
    }

    const handle = randomUUID()
    this.sessions.set(handle, binding)
    this.signIns.begin()
    let dispatchEnded = false

    try {
      this.current()
      this.assertPlanStart(provider)

      const rawUrl = binding.flow === 'pkce' ? result.auth_url : result.verification_url

      if (!text(rawUrl, 8192)) {
        fail()
      }

      const url = new URL(rawUrl)
      const expected = FLOWS[provider]

      if (
        result.flow !== binding.flow ||
        url.origin !== expected.origin ||
        url.pathname !== expected.pathname ||
        url.username ||
        url.password ||
        url.hash
      ) {
        fail()
      }

      if (binding.flow === 'device_code' && !text(result.user_code, 128)) {
        fail()
      }

      lifecycle?.providerStartDispatchEnd('code_ready', Date.now() - dispatchStarted, 200)
      dispatchEnded = true

      const expiresIn =
        typeof result.expires_in === 'number' && Number.isFinite(result.expires_in)
          ? Math.min(Math.max(result.expires_in, 1), 900)
          : 900

      const pollInterval =
        typeof result.poll_interval === 'number' && Number.isFinite(result.poll_interval)
          ? Math.min(Math.max(result.poll_interval, 2), 30)
          : 3

      this.current()
      const openStarted = Date.now()

      try {
        await this.deps.openExternal(url.href)
        lifecycle?.openExternalEnd('ok', Date.now() - openStarted)
      } catch (error) {
        lifecycle?.openExternalEnd('failed', Date.now() - openStarted)

        throw error
      }

      this.assertPlanStart(provider)

      return {
        status: 'pending',
        session: handle,
        provider,
        flow: binding.flow,
        expiresIn,
        pollInterval,
        ...(binding.flow === 'device_code' ? { userCode: String(result.user_code) } : {})
      }
    } catch (error) {
      if (!dispatchEnded) {
        lifecycle?.providerStartDispatchEnd(
          matrixSubscriptionProviderStartOutcome(error),
          Date.now() - dispatchStarted,
          200
        )
      }

      this.release(handle)
      await this.cleanup(binding).catch(() => undefined)
      throw error
    }
  }

  /** Forget one sign-in and release exactly the native hold it acquired. */
  private release(handle: string) {
    if (this.sessions.delete(handle)) {
      this.signIns.end()
    }
  }

  /** A sign-in request this page could not deliver because its backend is gone or replaced
   * (`matrix_pages_agent_unavailable`): the sign-in can never finish here, so it must not keep
   * holding the backend until the page closes. `stop` still cancels it on the original runtime. */
  private abandon(value: unknown) {
    const action = record(value) && typeof value.path === 'string' ? value.path.slice(PREFIX.length) : ''
    const handle = record(value) && record(value.body) ? value.body.session : undefined
    const binding = typeof handle === 'string' ? this.sessions.get(handle) : undefined

    if (binding && ['oauth/poll', 'oauth/submit', 'oauth/cancel'].includes(action)) {
      this.orphans.add(binding)
      this.release(handle as string)
    }
  }

  private async oauthStatus(handle: string, code?: string): Promise<MatrixProviderOAuthResult> {
    const binding = this.binding(handle)

    if (code !== undefined && binding.flow !== 'pkce') {
      fail('matrix_pages_request_forbidden')
    }

    const result = await this.forward(
      code === undefined
        ? {
            path: `/api/providers/oauth/${binding.provider}/poll/${encodeURIComponent(binding.upstream)}${PROFILE}`,
            method: 'GET'
          }
        : {
            path: `/api/providers/oauth/${binding.provider}/submit${PROFILE}`,
            method: 'POST',
            body: { session_id: binding.upstream, code }
          }
    )

    if (
      !record(result) ||
      !['pending', 'approved', 'denied', 'expired', 'error', 'cancelled'].includes(String(result.status))
    ) {
      fail()
    }

    if (result.status === 'pending') {
      return { status: 'pending' }
    }

    // The sign-in is over: forgotten at once (a second poll is refused), while its backend stays
    // held until Hermes has been read back, so a restart that waited for it cannot stop the
    // backend under that read.
    const released = this.sessions.delete(handle)

    try {
      if (result.status !== 'approved') {
        return { status: result.status as MatrixProviderOAuthResult['status'] }
      }

      // Approved upstream is not yet saved: only a sign-in Hermes now reads back as connected
      // counts, so one that was lost on the way says so instead of looking done.
      const row = (await this.catalog()).snapshot.providers.find(each => each.id === binding.provider)

      if (!row?.oauth?.connected) {
        console.warn(`[Matrix] plan sign-in not saved: matrix_plan_sign_in_unsaved provider=${binding.provider}`)

        return { status: 'error' }
      }

      this.deps.signedIn?.(binding.provider)

      return { status: 'approved' }
    } finally {
      if (released) {
        this.signIns.end()
      }
    }
  }

  async request(value: MatrixPagesRequest | unknown): Promise<unknown> {
    try {
      return await this.dispatch(value)
    } catch (error) {
      const code = error instanceof Error ? error.message : ''

      if (code === 'matrix_pages_agent_unavailable') {
        this.abandon(value)
      }

      if (
        [
          'matrix_pages_request_forbidden',
          'matrix_pages_agent_unavailable',
          'pages_agent_busy',
          'matrix_provider_name_exists',
          'matrix_provider_not_ready',
          'matrix_provider_response_invalid',
          'provider_terms_blocked'
        ].includes(code)
      ) {
        throw error
      }

      return fail('matrix_provider_request_failed')
    }
  }

  private async dispatch(value: MatrixPagesRequest | unknown): Promise<unknown> {
    this.current()

    if (!record(value) || !isMatrixProvidersRequest(value.path)) {
      fail('matrix_pages_request_forbidden')
    }

    const path = String(value.path)

    if (path === `${PREFIX}snapshot`) {
      exact(value, path, 'GET')

      return (await this.catalog()).snapshot
    }

    const action = path.slice(PREFIX.length)

    const specs: Record<string, [string, string[]]> = {
      key: ['PUT', ['provider', 'value']],
      select: ['POST', ['provider', 'model']],
      endpoint: ['POST', ['name', 'baseUrl', 'model', 'apiKey']],
      'oauth/start': ['POST', ['provider']],
      'oauth/acknowledge': ['POST', ['provider']],
      'oauth/poll': ['POST', ['session']],
      'oauth/submit': ['POST', ['session', 'code']],
      'oauth/cancel': ['POST', ['session']],
      'oauth/disconnect': ['POST', ['provider']]
    }

    const spec = specs[action]

    if (!spec) {
      fail('matrix_pages_request_forbidden')
    }

    const body = exact(value, path, spec[0], spec[1])

    if (action.startsWith('oauth/') && ['oauth/poll', 'oauth/submit', 'oauth/cancel'].includes(action)) {
      const binding = this.binding(body.session)

      if (action === 'oauth/cancel') {
        return this.cancelBinding(String(body.session), binding)
      }

      if (action === 'oauth/submit' && !secret(body.code)) {
        fail('matrix_pages_request_forbidden')
      }

      return this.oauthStatus(String(body.session), action === 'oauth/submit' ? String(body.code) : undefined)
    }

    if (this.writing) {
      fail('pages_agent_busy')
    }

    this.writing = true

    try {
      if (action === 'endpoint') {
        if (
          !text(body.name, 100) ||
          !/^[\p{L}\p{N}][\p{L}\p{N} ._()-]*$/u.test(body.name) ||
          !text(body.model, 1024) ||
          !secret(body.apiKey, true) ||
          !text(body.baseUrl, 2048)
        ) {
          fail('matrix_pages_request_forbidden')
        }

        let url: URL

        try {
          url = new URL(body.baseUrl)
        } catch {
          return fail('matrix_pages_request_forbidden')
        }

        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !url.hostname
        ) {
          fail('matrix_pages_request_forbidden')
        }

        const name = body.name

        if ((await this.catalog()).endpointNames.has(name.toLocaleLowerCase())) {
          fail('matrix_provider_name_exists')
        }

        if (!(await this.confirmed({ kind: 'provider-endpoint', name, baseUrl: url.href, model: body.model }))) {
          return { status: 'cancelled' }
        }

        if ((await this.catalog()).endpointNames.has(name.toLocaleLowerCase())) {
          fail('matrix_provider_name_exists')
        }

        const endpointId = `atum-provider-${randomUUID()}`

        const response = await this.forward({
          path: `/api/providers/custom-endpoints${PROFILE}`,
          method: 'POST',
          body: {
            id: endpointId,
            name,
            base_url: url.href.replace(/\/$/, ''),
            model: body.model,
            api_key: body.apiKey,
            discover_models: false,
            make_default: false
          }
        })

        if (!record(response) || response.ok !== true || response.id !== endpointId) {
          fail()
        }

        if (
          !(await this.catalog()).snapshot.providers.some(
            row => row.id === endpointId && row.models.includes(String(body.model))
          )
        ) {
          fail()
        }

        return { status: 'applied' }
      }

      if (!id(body.provider)) {
        fail('matrix_pages_request_forbidden')
      }

      const provider = body.provider

      if (action === 'oauth/start') {
        return await this.start(provider)
      }

      if (action === 'oauth/acknowledge') {
        return await this.acknowledgePlan(provider)
      }

      if (action === 'key') {
        if (!secret(body.value)) {
          fail('matrix_pages_request_forbidden')
        }

        const { catalog } = await this.eligible(provider)
        const key = catalog.keys.get(provider)

        if (!key) {
          fail('matrix_pages_request_forbidden')
        }

        if (!(await this.confirmed({ kind: 'provider-key', provider }))) {
          return { status: 'cancelled' }
        }

        if ((await this.eligible(provider)).catalog.keys.get(provider) !== key) {
          fail()
        }

        const response = await this.forward({
          path: `/api/env${PROFILE}`,
          method: 'PUT',
          body: { key, value: body.value }
        })

        if (!record(response) || response.ok !== true) {
          fail()
        }

        return { status: 'applied' }
      }

      if (action === 'oauth/disconnect') {
        if (!(await this.eligible(provider)).row.oauth?.disconnectable) {
          fail('matrix_pages_request_forbidden')
        }

        if (!(await this.confirmed({ kind: 'provider-disconnect', provider }))) {
          return { status: 'cancelled' }
        }

        if (!(await this.eligible(provider)).row.oauth?.disconnectable) {
          fail()
        }

        const response = await this.forward({ path: `/api/providers/oauth/${provider}${PROFILE}`, method: 'DELETE' })

        if (!record(response) || response.ok !== true || response.provider !== provider) {
          fail()
        }

        this.current()
        await this.deps.disconnected?.(provider)

        return { status: 'applied' }
      }

      if (!text(body.model, 1024)) {
        fail('matrix_pages_request_forbidden')
      }

      const model = body.model
      await this.eligible(provider, model)

      if (!(await this.confirmed({ kind: 'provider-select', provider, model }))) {
        return { status: 'cancelled' }
      }

      await this.eligible(provider, model)

      const request: MatrixPagesForwardRequest = {
        path: `/api/model/set${PROFILE}`,
        method: 'POST',
        body: { scope: 'main', provider, model }
      }

      let response = await this.forward(request)

      if (
        record(response) &&
        response.ok === false &&
        response.confirm_required === true &&
        response.scope === 'main' &&
        response.provider === provider &&
        response.model === model &&
        text(response.confirm_message, 2048)
      ) {
        if (!(await this.confirmed({ kind: 'expensive-model', provider, model, message: response.confirm_message }))) {
          return { status: 'cancelled' }
        }

        await this.eligible(provider, model)
        response = await this.forward({
          ...request,
          body: { scope: 'main', provider, model, confirm_expensive_model: true }
        })
      }

      if (
        !record(response) ||
        response.ok !== true ||
        response.scope !== 'main' ||
        response.provider !== provider ||
        !text(response.model, 1024)
      ) {
        fail()
      }

      const readback = (await this.catalog()).snapshot.current

      if (readback?.provider !== response.provider || readback.model !== response.model) {
        fail()
      }

      this.current()
      await this.deps.selected?.(readback.provider, readback.model, readback.reasoning, readback.capability)
      this.current()

      return { status: 'applied', staleAux: Array.isArray(response.stale_aux) && response.stale_aux.length > 0 }
    } catch (error) {
      const code = error instanceof Error ? error.message : ''

      if (
        [
          'matrix_pages_request_forbidden',
          'matrix_pages_agent_unavailable',
          'pages_agent_busy',
          'matrix_provider_name_exists',
          'matrix_provider_not_ready',
          'matrix_provider_response_invalid',
          'provider_terms_blocked'
        ].includes(code)
      ) {
        throw error
      }

      return fail('matrix_provider_request_failed')
    } finally {
      this.writing = false
      this.startingPlan = undefined
    }
  }

  /** Best-effort cancellation against the same backend; late results are never
   * published, even if runtime shutdown prevents cleanup from reaching it. */
  async stop(): Promise<void> {
    this.stopped = true
    this.confirmedPlanStart = undefined
    const sessions = [...this.sessions.values()]
    const orphans = [...this.orphans]
    this.sessions.clear()
    this.orphans.clear()
    this.signIns.stop()

    await Promise.all([...sessions, ...orphans].map(binding => this.cleanup(binding).catch(() => undefined)))
  }

  private cleanup(binding: OAuthBinding): Promise<unknown> {
    return this.deps.cancelOAuth
      ? this.deps.cancelOAuth(binding.upstream)
      : this.deps.forward({
          path: `/api/providers/oauth/sessions/${encodeURIComponent(binding.upstream)}${PROFILE}`,
          method: 'DELETE'
        })
  }
}
