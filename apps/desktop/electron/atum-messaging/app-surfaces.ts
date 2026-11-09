/**
 * app-surfaces.ts
 *
 * The two hosted, per-app surfaces the desktop was missing: **intake** (an app
 * declaring what it still needs before it can work) and **connect** (linking an
 * Atum account to an account the user already holds on the app's own service).
 *
 * Both used to exist only in the archived web shell
 * (`atum-platform/apps/shell/src/components/{intake-gate,moon-connect-card}.tsx`).
 *
 * SERVER DEPENDENCY, STATED PLAINLY. The shell's routes
 * (`/api/specialists/{id}/intake`, `/api/moon/connect/*`) authenticate with
 * Supabase SSR **cookies** and sit behind a middleware that 307-redirects a
 * cookie-less request to `/login`. The desktop holds a bearer token and never a
 * cookie, so it cannot call them — a request would come back as an HTML login
 * page, not JSON. This client therefore targets the bearer-authenticated
 * `/api/desktop/v1` namespace, mirroring the shell contract verbatim:
 *
 *   GET  /api/desktop/v1/specialists/{app}/intake     -> {complete, missing[], fields?[]}
 *   POST /api/desktop/v1/specialists/{app}/intake     -> {complete: true} | {complete, missing[]}
 *   GET  /api/desktop/v1/apps/{app}/connect/status    -> {status}
 *   POST /api/desktop/v1/apps/{app}/connect/candidate -> {status}
 *   POST /api/desktop/v1/apps/{app}/connect/start     -> {authorize_url}
 *   POST /api/desktop/v1/apps/{app}/connect/dismiss   -> {status}
 *
 * Deployment is attested here for the four connect handlers
 * (`status`/`candidate`/`start`/`dismiss`). The intake pair remains
 * compatibility-gated until its deployment is separately attested. These
 * handlers are thin
 * `authorizeDesktop()` wrappers over the same platform authority used by the
 * cookie routes. A deployment without them is normalized from an HTTP 404 or
 * the legacy same-origin `/login` redirect to `app_surface_unavailable`; it is
 * never mistaken for an empty or unlinked account.
 *
 * WHY THIS LIVES IN MAIN. The access token is vault-sealed and never crosses
 * preload — the same rule the messaging lane already follows. So every hosted
 * call happens here and the renderer sees only parsed, content-shaped results.
 * `connect/start` in particular resolves an `authorize_url` that main opens with
 * `shell.openExternal` itself: the URL is never handed to the renderer, so a
 * compromised renderer cannot turn this seam into an arbitrary-navigation
 * primitive. The browser hop to the app's OWN login page is the design — it is
 * the second half of a two-party consent, and it must happen on the app's
 * surface, not inside an Atum window.
 *
 * NOTHING ABOUT ANY PARTICULAR APP IS ENCODED HERE. The intake form is built
 * from what the server says is missing; an app that declares no intake returns
 * `{complete: true, missing: []}` and no form is ever shown. Field types and
 * option lists are read from the server's declaration when it sends one — the
 * client never assumes an app's field list.
 */

import { readFileSync, writeFileSync } from 'node:fs'

import {
  INTAKE_FIELD_NAME_PATTERN as FIELD_NAME_PATTERN,
  type IntakeStatus,
  MAX_INTAKE_FIELD_VALUE_LENGTH as MAX_FIELD_VALUE_LENGTH,
  MAX_INTAKE_FIELDS as MAX_FIELDS,
  parseAppIntakeStatus
} from '../../shared/app-intake'
import {
  APP_LAUNCH_NEGOTIATION_HEADER,
  APP_LAUNCH_NEGOTIATION_VALUE,
  APP_LAUNCH_PROFILE,
  APP_LAUNCH_REFUSALS,
  APP_MANIFEST_TTL_MS,
  type AppLaunchIssue,
  type AppLaunchRefusal,
  type AppManifest,
  type AppManifestResponse,
  type AppManifestRoute,
  type AppNetworkOrigin,
  AppSurfaceError,
  MAX_APP_NETWORK_ORIGINS,
  parseAppLaunchIssue as parseSharedAppLaunchIssue,
  parseAppManifest as parseSharedAppManifest,
  parseAppManifestResponse as parseSharedAppManifestResponse,
  REMOTE_APP_MANIFEST_PROFILE
} from '../../shared/app-view/protocol'
import { PARTICIPANT_REFS_HEADER } from '../../shared/atum-participants'

import { MessagingHttpError } from './http-client'
import type { MessagingAccountSession } from './types'

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 64 * 1024
export const APP_PANEL_SURFACE_TTL_MS = 30_000
export const APP_CATALOG_TTL_MS = 30_000

/**
 * The server caps `atum.app_match_candidates.probe_attempts` at 3. The client
 * must therefore treat the candidate probe as a scarce resource: one call per
 * app per app-session, never a poll and never a retry loop.
 */
export const CONNECT_CANDIDATE_MAX_PROBES = 3

/** App ids are the platform's own registry keys: lowercase snake/kebab. */
const APP_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/
const ROUTE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/

export type { IntakeFieldOption, IntakeFieldSpec, IntakeFieldType, IntakeStatus } from '../../shared/app-intake'

export type ConnectCandidateStatus = 'available' | 'dismissed' | 'linked' | 'none'

export interface ConnectCandidate {
  status: ConnectCandidateStatus
}

export type ConnectLifecycleStatus = 'never_linked' | 'linked' | 'unlinked'

export interface ConnectLifecycle {
  status: ConnectLifecycleStatus
  browserStep?: string
  cleanup?: 'pending' | 'complete' | 'unconfirmed'
  connectionRequired?: boolean
  available?: boolean
  connectAvailable?: boolean
  readiness?: 'not_linked' | 'pending' | 'ready' | 'unavailable'
}

export interface DesktopAppCatalogEntry {
  app: string
  app_id: string
  app_version_id: string
  name: { vi: string; en: string }
  subtitle: { vi: string; en: string } | null
  icon: { url: string; sha256: string } | null
  verified: boolean
  availability: 'available' | 'unavailable'
  supported_modes: Array<'direct' | 'private_group' | 'shared_group'>
  link: { mode: 'none' | 'external_account'; state: 'never_linked' | 'linked' | 'unlinked' }
}

export interface DesktopAppCatalog {
  apps: DesktopAppCatalogEntry[]
}

export interface AppPanelMenuItem {
  icon: string
  id: string
  label_en: string
  label_vi: string
  path: string
}

export interface AppPanelSurface {
  app: string
  composer_actions: AppPanelMenuItem[]
  panel_menu: AppPanelMenuItem[]
  web_origin: string
}

export interface AppSurfacesClientOptions {
  fetchImpl?: typeof fetch
  /** Live session provider — same seam the messaging HTTP client uses. */
  session: () => MessagingAccountSession | null
  refresh: (rejected: MessagingAccountSession) => Promise<MessagingAccountSession | null>
  /** `shell.openExternal`. Main opens the authorize URL; the renderer never sees it. */
  openExternal: (url: string) => Promise<void>
  requestTimeoutMs?: number
  probeStorePath?: string
  now?: () => number
  /** Existing backend-spawn environment seam; receives no origin or token. */
  onCatalog?: (
    accountId: string,
    apps: Array<{
      id: string
      name: string
      description: { vi: string; en: string }
      availability: 'available' | 'unavailable'
    }>
  ) => void
}

/**
 * Account-capability revocation supplied by the authenticated main-process
 * controller. The app-surface client never owns account lifecycle; it only
 * drops the account-scoped state it is holding when that authority revokes it.
 */
export interface AppSurfaceAccountRevocation {
  accountId: string
  accountGeneration: number
}

function parsePanelMenu(value: unknown): AppPanelMenuItem[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new MessagingHttpError('app_panel_surface_invalid', 200, false, null, null, null)
  }

  return value.map(entry => {
    const item = record(entry)
    const id = text(item?.id, 64)
    const labelVi = text(item?.label_vi, 200)
    const labelEn = text(item?.label_en, 200)
    const icon = text(item?.icon, 64)
    const path = text(item?.path, 2048)

    if (!id || !labelVi || !labelEn || !icon || !path || !path.startsWith('/') || path.startsWith('//')) {
      throw new MessagingHttpError('app_panel_surface_invalid', 200, false, null, null, null)
    }

    return { icon, id, label_en: labelEn, label_vi: labelVi, path }
  })
}

export function parseAppPanelSurface(value: unknown): AppPanelSurface {
  const body = record(value)
  const app = text(body?.app, 64)
  const origin = text(body?.web_origin, 2048)

  if (!app || !APP_ID_PATTERN.test(app) || !origin) {
    throw new MessagingHttpError('app_panel_surface_invalid', 200, false, null, null, null)
  }

  try {
    const parsed = new URL(origin)

    if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password) {
      throw new Error()
    }
  } catch {
    throw new MessagingHttpError('app_panel_surface_invalid', 200, false, null, null, null)
  }

  return {
    app,
    composer_actions: parsePanelMenu(body?.composer_actions),
    panel_menu: parsePanelMenu(body?.panel_menu),
    web_origin: origin
  }
}

// Compatibility re-exports for the legacy Atum messaging client. New native
// adapters import this contract from shared/app-view/protocol directly.
export {
  APP_LAUNCH_PROFILE,
  APP_LAUNCH_REFUSALS,
  APP_MANIFEST_TTL_MS,
  MAX_APP_NETWORK_ORIGINS,
  REMOTE_APP_MANIFEST_PROFILE
}
export type { AppLaunchIssue, AppLaunchRefusal, AppManifest, AppManifestResponse, AppManifestRoute, AppNetworkOrigin }

/** Refusals that mean the cached manifest can no longer be trusted for this account. */
const MANIFEST_EVICTING_REFUSALS: ReadonlySet<string> = new Set([
  'not_linked',
  'unlinked',
  'app_unavailable',
  'app_version_incompatible'
])

function legacyProtocol<T>(parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    if (error instanceof AppSurfaceError) {
      throw new MessagingHttpError(error.code, 200, false, null, null, null)
    }

    throw error
  }
}

export function parseAppManifest(value: unknown): AppManifest {
  return legacyProtocol(() => parseSharedAppManifest(value))
}

export function parseAppManifestResponse(value: unknown): AppManifestResponse {
  return legacyProtocol(() => parseSharedAppManifestResponse(value))
}

export function parseAppLaunchIssue(
  value: unknown,
  expected: { webOrigin: string; launchPath: string }
): AppLaunchIssue {
  return legacyProtocol(() => parseSharedAppLaunchIssue(value, expected))
}

function requireRouteId(value: unknown): string {
  const routeId = typeof value === 'string' ? value.trim() : ''

  if (!ROUTE_ID_PATTERN.test(routeId)) {
    throw new MessagingHttpError('route_unknown', 404, false, null, null, null)
  }

  return routeId
}

function requireAppId(value: unknown): string {
  const appId = typeof value === 'string' ? value.trim().toLowerCase() : ''

  if (!APP_ID_PATTERN.test(appId)) {
    throw new MessagingHttpError('app_id_invalid', 400, false, null, null, null)
  }

  return appId
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()

  return trimmed && trimmed.length <= max ? trimmed : null
}

const CATALOG_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const SHA256_PATTERN = /^[0-9a-f]{64}$/iu

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)

    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

/** Validate the catalog at the main-process boundary. This is deliberately a
 * display projection: manifest origins, routes, credentials, and launch URLs
 * do not belong in this response or its cache. */
export function parseDesktopAppCatalog(value: unknown): DesktopAppCatalog {
  const root = record(value)
  const apps = root?.apps

  if (!Array.isArray(apps) || apps.length > 128) {
    throw new MessagingHttpError('app_catalog_invalid', 200, false, null, null, null)
  }

  const seen = new Set<string>()

  return {
    apps: apps.map(item => {
      const entry = record(item)
      const app = requireAppId(entry?.app)
      const appId = text(entry?.app_id, 64)
      const appVersionId = text(entry?.app_version_id, 64)
      const name = record(entry?.name)
      const nameVi = text(name?.vi, 200)
      const nameEn = text(name?.en, 200)
      const subtitleValue = entry?.subtitle === null ? null : record(entry?.subtitle)
      const subtitleVi = subtitleValue ? text(subtitleValue.vi, 300) : null
      const subtitleEn = subtitleValue ? text(subtitleValue.en, 300) : null
      const iconValue = entry?.icon === null ? null : record(entry?.icon)
      const iconUrl = iconValue ? text(iconValue.url, 2048) : null
      const iconSha = iconValue ? text(iconValue.sha256, 64) : null
      const supported = entry?.supported_modes
      const link = record(entry?.link)

      if (
        !appId ||
        !CATALOG_UUID_PATTERN.test(appId) ||
        !appVersionId ||
        !CATALOG_UUID_PATTERN.test(appVersionId) ||
        !nameVi ||
        !nameEn ||
        typeof entry?.verified !== 'boolean' ||
        (subtitleValue !== null && (!subtitleVi || !subtitleEn)) ||
        (iconValue !== null && (!iconUrl || !iconSha || !SHA256_PATTERN.test(iconSha) || !isHttpsUrl(iconUrl))) ||
        (entry?.availability !== 'available' && entry?.availability !== 'unavailable') ||
        !Array.isArray(supported) ||
        supported.length > 3 ||
        !supported.every(mode => mode === 'direct' || mode === 'private_group' || mode === 'shared_group') ||
        !link ||
        (link.mode !== 'none' && link.mode !== 'external_account') ||
        (link.state !== 'never_linked' && link.state !== 'linked' && link.state !== 'unlinked') ||
        seen.has(app)
      ) {
        throw new MessagingHttpError('app_catalog_invalid', 200, false, null, null, null)
      }

      seen.add(app)

      return {
        app,
        app_id: appId,
        app_version_id: appVersionId,
        name: { vi: nameVi, en: nameEn },
        subtitle: subtitleValue === null ? null : { vi: subtitleVi!, en: subtitleEn! },
        icon: iconValue === null ? null : { url: iconUrl!, sha256: iconSha! },
        verified: entry?.verified === true,
        availability: entry.availability,
        supported_modes: [...new Set(supported)],
        link: { mode: link.mode, state: link.state }
      }
    })
  }
}

/**
 * `{complete, missing[]}` is the contract. The form is EXACTLY `missing[]`, in
 * server order — an app that declares nothing sends an empty array and the
 * client renders no form at all.
 */
export function parseIntakeStatus(value: unknown): IntakeStatus {
  try {
    return parseAppIntakeStatus(value)
  } catch (error) {
    if (error instanceof AppSurfaceError && error.code === 'intake_status_invalid') {
      throw new MessagingHttpError(error.code, 200, false, null, null, null)
    }

    throw error
  }
}

export function parseConnectCandidate(value: unknown): ConnectCandidate {
  const body = record(value)
  const status = body?.status

  if (status === 'available' || status === 'dismissed' || status === 'linked' || status === 'none') {
    return { status }
  }

  throw new MessagingHttpError('connect_candidate_invalid', 200, false, null, null, null)
}

export function parseConnectLifecycle(value: unknown): ConnectLifecycle {
  const body = record(value)
  const status = body?.status

  if (status === 'never_linked' || status === 'linked' || status === 'unlinked') {
    const result: ConnectLifecycle =
      typeof body?.browser_step === 'string' ? { status, browserStep: body.browser_step } : { status }

    if (body && 'connect_available' in body) {
      if (typeof body.connect_available !== 'boolean') {
        throw new MessagingHttpError('connect_status_invalid', 200, false, null, null, null)
      }

      result.connectAvailable = body.connect_available
    }

    const hasReadiness = body && ['connection_required', 'available', 'readiness'].some(key => key in body)

    if (!hasReadiness) {
      return result
    }

    if (
      typeof body?.connection_required === 'boolean' &&
      typeof body.available === 'boolean' &&
      ['not_linked', 'pending', 'ready', 'unavailable'].includes(String(body.readiness)) &&
      (status === 'linked') !== (body.readiness === 'not_linked')
    ) {
      return {
        ...result,
        connectionRequired: body.connection_required,
        available: body.available,
        readiness: body.readiness as ConnectLifecycle['readiness'],
        ...(status === 'unlinked'
          ? {
              cleanup: ['pending', 'complete', 'unconfirmed'].includes(String(body.cleanup))
                ? (body.cleanup as ConnectLifecycle['cleanup'])
                : ('unconfirmed' as const)
            }
          : {})
      }
    }
  }

  throw new MessagingHttpError('connect_status_invalid', 200, false, null, null, null)
}

/**
 * The authorize URL is attacker-reachable in the worst case (a compromised or
 * misconfigured platform response) and main is about to hand it to the OS.
 * Only an absolute https URL with no embedded credentials is ever opened.
 */
export function parseAuthorizeUrl(value: unknown): string {
  const body = record(value)
  const raw = body ? text(body.authorize_url, 2048) : null

  if (!raw) {
    throw new MessagingHttpError('connect_authorize_url_invalid', 200, false, null, null, null)
  }

  let url: URL

  try {
    url = new URL(raw)
  } catch {
    throw new MessagingHttpError('connect_authorize_url_invalid', 200, false, null, null, null)
  }

  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new MessagingHttpError('connect_authorize_url_invalid', 200, false, null, null, null)
  }

  return url.toString()
}

/**
 * Normalize both error shapes this lane can see: the desktop envelope
 * (`{error:{code,…}}`) used by `/api/desktop/v1`, and the flat `{error:"code"}`
 * the shell-era app routes return. Anything else becomes a stable code — an
 * upstream body is never reflected to the renderer.
 */
function isDesktopErrorEnvelope(bytes: string): boolean {
  try {
    const nested = record(record(JSON.parse(bytes))?.error)

    return typeof nested?.code === 'string'
  } catch {
    return false
  }
}

function errorCode(body: unknown, status: number): MessagingHttpError {
  const envelope = record(body)
  const nested = record(envelope?.error)
  const code = text(nested?.code, 120) ?? text(envelope?.error, 120)
  // The one upstream detail worth keeping: WHICH field an app rejected, so the
  // form can attach the message to that control. The upstream `error` string
  // itself is discarded — it is app-authored text and the UI shows its own copy.
  const field = text(envelope?.field, 64)
  // The launch lane's own vocabulary travels in `details.launch_error`, and a
  // rate limit carries how long to wait. Both are closed shapes; nothing else
  // from the body is kept.
  const nestedDetails = record(nested?.details)
  const launchError = text(nestedDetails?.launch_error, 64)

  const retryAfterMs =
    typeof nested?.retry_after_ms === 'number' && Number.isFinite(nested.retry_after_ms)
      ? Math.max(0, Math.min(Math.floor(nested.retry_after_ms), 3_600_000))
      : null

  const details: Record<string, unknown> = {}

  if (field && FIELD_NAME_PATTERN.test(field)) {
    details.field = field
  }

  if (launchError && (APP_LAUNCH_REFUSALS as readonly string[]).includes(launchError)) {
    details.launch_error = launchError
  }

  if (retryAfterMs !== null) {
    details.retry_after_ms = retryAfterMs
  }

  return new MessagingHttpError(
    code ?? 'app_surface_request_failed',
    status,
    status === 429 || status >= 500,
    null,
    null,
    Object.keys(details).length > 0 ? details : null
  )
}

export class AtumAppSurfacesClient {
  private readonly fetchImpl: typeof fetch
  private readonly requestTimeoutMs: number
  /** Probe budget per signed-in user and app for this process lifetime. */
  private readonly probes = new Map<string, number>()
  /** Replay a settled result across renderer remounts without spending again. */
  private readonly candidateResults = new Map<string, ConnectCandidate>()
  /** StrictMode/remounts may overlap; all callers share the one scarce request. */
  private readonly candidateRequests = new Map<string, Promise<ConnectCandidate>>()
  private readonly panelSurfaces = new Map<string, { expiresAt: number; value: AppPanelSurface }>()
  private readonly panelSurfaceRequests = new Map<string, Promise<AppPanelSurface>>()
  private readonly manifests = new Map<string, { expiresAt: number; value: AppManifestResponse }>()
  private readonly manifestRequests = new Map<string, Promise<AppManifestResponse>>()
  private readonly catalogs = new Map<string, { expiresAt: number; value: DesktopAppCatalog }>()
  private readonly catalogRequests = new Map<string, Promise<DesktopAppCatalog>>()
  /** Incrementing epoch prevents a pre-revocation request from repopulating a cache. */
  private readonly accountEpochs = new Map<string, number>()
  /** Revocation aborts only this client's account-scoped in-flight requests. */
  private readonly accountRequestControllers = new Map<string, AbortController>()

  constructor(private readonly options: AppSurfacesClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

    if (options.probeStorePath) {
      try {
        const stored = JSON.parse(readFileSync(options.probeStorePath, 'utf8')) as string[]

        for (const key of stored) {
          this.probes.set(key, 1)
        }
      } catch {
        /* first launch or invalid old state */
      }
    }
  }

  /** Account-authorized app registration. Cache ownership and cancellation
   * follow the existing app-surface contract, while only display metadata is
   * projected through IPC. */
  async catalog(signal?: AbortSignal, force = false): Promise<DesktopAppCatalog> {
    const accountId = this.requireSession().user.id
    const epoch = this.accountEpoch(accountId)
    const cached = this.catalogs.get(accountId)

    if (!force && cached && cached.expiresAt > (this.options.now?.() ?? Date.now())) {
      return cached.value
    }

    const inFlight = this.catalogRequests.get(accountId)

    if (inFlight) {
      return inFlight
    }

    const request = this.request(
      '/api/desktop/v1/apps',
      {},
      parseDesktopAppCatalog,
      this.accountRequestSignal(accountId, undefined, signal)
    ).then(value => {
      if (this.accountEpoch(accountId) !== epoch || this.options.session()?.user.id !== accountId) {
        throw new MessagingHttpError('app_surface_cancelled', 0, false, null, null, null)
      }

      this.catalogs.set(accountId, { expiresAt: (this.options.now?.() ?? Date.now()) + APP_CATALOG_TTL_MS, value })
      this.options.onCatalog?.(
        accountId,
        value.apps.map(app => ({
          id: app.app,
          name: app.name.en,
          description: app.subtitle ?? { vi: '', en: '' },
          availability: app.availability
        }))
      )

      return value
    })

    this.catalogRequests.set(accountId, request)

    try {
      return await request
    } finally {
      if (this.catalogRequests.get(accountId) === request) {
        this.catalogRequests.delete(accountId)
      }
    }
  }

  async intakeStatus(app: unknown, signal?: AbortSignal): Promise<IntakeStatus> {
    const appId = requireAppId(app)
    const accountId = this.requireSession().user.id

    return this.request(
      `/api/desktop/v1/specialists/${encodeURIComponent(appId)}/intake`,
      {},
      parseIntakeStatus,
      this.accountRequestSignal(accountId, appId, signal)
    )
  }

  async panelSurface(app: unknown, signal?: AbortSignal): Promise<AppPanelSurface> {
    const appId = requireAppId(app)
    const session = this.requireSession()
    const accountId = session.user.id
    const cacheKey = this.accountAppKey(accountId, appId)
    const epoch = this.accountEpoch(accountId, appId)
    const cached = this.panelSurfaces.get(cacheKey)

    if (cached && cached.expiresAt > (this.options.now?.() ?? Date.now())) {
      return cached.value
    }

    const inFlight = this.panelSurfaceRequests.get(cacheKey)

    if (inFlight) {
      return inFlight
    }

    const request = this.request(
      `/api/desktop/v1/specialists/${encodeURIComponent(appId)}/surface`,
      {},
      parseAppPanelSurface,
      this.accountRequestSignal(accountId, appId, signal)
    ).then(value => {
      if (value.app !== appId) {
        throw new MessagingHttpError('app_panel_surface_invalid', 200, false, null, null, null)
      }

      if (this.accountEpoch(accountId, appId) === epoch) {
        this.panelSurfaces.set(cacheKey, {
          expiresAt: (this.options.now?.() ?? Date.now()) + APP_PANEL_SURFACE_TTL_MS,
          value
        })
      }

      return value
    })

    this.panelSurfaceRequests.set(cacheKey, request)

    try {
      return await request
    } finally {
      if (this.panelSurfaceRequests.get(cacheKey) === request) {
        this.panelSurfaceRequests.delete(cacheKey)
      }
    }
  }

  /**
   * Submit the collected values. `values` is whatever the declaration asked
   * for — the client validates SHAPE (string keys, snake_case names, bounded
   * length) and never semantics, because only the app knows what its own
   * fields mean.
   */
  async intakeSubmit(app: unknown, values: unknown, signal?: AbortSignal): Promise<IntakeStatus> {
    const appId = requireAppId(app)
    const accountId = this.requireSession().user.id
    const source = record(values)

    if (!source) {
      throw new MessagingHttpError('intake_values_invalid', 400, false, null, null, null)
    }

    const payload: Record<string, string> = {}

    for (const [name, raw] of Object.entries(source).slice(0, MAX_FIELDS)) {
      if (!FIELD_NAME_PATTERN.test(name) || typeof raw !== 'string' || raw.length > MAX_FIELD_VALUE_LENGTH) {
        throw new MessagingHttpError('intake_values_invalid', 400, false, null, null, null)
      }

      payload[name] = raw
    }

    if (Object.keys(payload).length === 0) {
      throw new MessagingHttpError('intake_values_invalid', 400, false, null, null, null)
    }

    return this.request(
      `/api/desktop/v1/specialists/${encodeURIComponent(appId)}/intake`,
      { method: 'POST', body: JSON.stringify(payload) },
      // A submission that the app accepts answers `{complete: true}`; anything
      // still outstanding comes back as a fresh field list, so one parser
      // serves both and the caller never has to guess.
      parseIntakeStatus,
      this.accountRequestSignal(accountId, appId, signal)
    )
  }

  /**
   * Ask whether this account has a matching account on the app's own service.
   *
   * Called AT MOST ONCE per app per process. The server records every probe
   * against a hard cap of 3 attempts, so a retry loop here would permanently
   * burn a real user's ability to be matched. A failure is reported, not
   * retried.
   */
  async connectCandidate(app: unknown, signal?: AbortSignal): Promise<ConnectCandidate> {
    const appId = requireAppId(app)
    const session = this.requireSession()
    const accountId = session.user.id
    const probeKey = this.accountAppKey(accountId, appId)
    const epoch = this.accountEpoch(accountId, appId)
    const cached = this.candidateResults.get(probeKey)

    if (cached) {
      return cached
    }

    const inFlight = this.candidateRequests.get(probeKey)

    if (inFlight) {
      return inFlight
    }

    const spent = this.probes.get(probeKey) ?? 0

    if (spent >= 1) {
      throw new MessagingHttpError('connect_probe_already_spent', 429, false, null, null, null)
    }

    this.probes.set(probeKey, spent + 1)
    this.persistProbes()

    const request = this.request(
      `/api/desktop/v1/apps/${encodeURIComponent(appId)}/connect/candidate`,
      { method: 'POST' },
      parseConnectCandidate,
      this.accountRequestSignal(accountId, appId, signal)
    ).then(result => {
      if (this.accountEpoch(accountId, appId) === epoch) {
        this.candidateResults.set(probeKey, result)
      }

      return result
    })

    this.candidateRequests.set(probeKey, request)

    try {
      return await request
    } finally {
      if (this.candidateRequests.get(probeKey) === request) {
        this.candidateRequests.delete(probeKey)
      }
    }
  }

  /**
   * Called by the authenticated account controller before it releases an
   * account. Account-dependent surfaces must never survive into another
   * account's desktop session, even for the short panel TTL.
   */
  revokeAccount(input: AppSurfaceAccountRevocation): void {
    const accountId = input.accountId

    if (!accountId) {
      return
    }

    this.accountEpochs.set(accountId, this.accountEpoch(accountId) + 1)
    const prefix = `${accountId}:`

    for (const [key, controller] of this.accountRequestControllers) {
      if (key === accountId || key.startsWith(prefix)) {
        controller.abort()
        this.accountRequestControllers.delete(key)
      }
    }

    for (const key of this.probes.keys()) {
      if (key.startsWith(prefix)) {
        this.probes.delete(key)
      }
    }

    for (const key of this.candidateResults.keys()) {
      if (key.startsWith(prefix)) {
        this.candidateResults.delete(key)
      }
    }

    for (const key of this.candidateRequests.keys()) {
      if (key.startsWith(prefix)) {
        this.candidateRequests.delete(key)
      }
    }

    for (const key of this.panelSurfaces.keys()) {
      if (key.startsWith(prefix)) {
        this.panelSurfaces.delete(key)
      }
    }

    for (const key of this.panelSurfaceRequests.keys()) {
      if (key.startsWith(prefix)) {
        this.panelSurfaceRequests.delete(key)
      }
    }

    for (const key of this.manifests.keys()) {
      if (key.startsWith(prefix)) {
        this.manifests.delete(key)
      }
    }

    for (const key of this.manifestRequests.keys()) {
      if (key.startsWith(prefix)) {
        this.manifestRequests.delete(key)
      }
    }

    this.catalogs.delete(accountId)
    this.catalogRequests.delete(accountId)
    this.options.onCatalog?.(accountId, [])

    this.persistProbes()
  }

  /** Withdraw only this app's cached authority and requests; other apps stay live. */
  revokeApp(input: { accountId: string; app: string }): void {
    const key = this.accountAppKey(input.accountId, requireAppId(input.app))
    this.accountEpochs.set(key, (this.accountEpochs.get(key) ?? 0) + 1)
    this.accountRequestControllers.get(key)?.abort()
    this.accountRequestControllers.delete(key)
    this.candidateResults.delete(key)
    this.candidateRequests.delete(key)
    this.panelSurfaces.delete(key)
    this.panelSurfaceRequests.delete(key)
    this.manifests.delete(key)
    this.manifestRequests.delete(key)
    // Deliberate disconnect never replenishes the scarce match probe budget.
  }

  /**
   * The server-authored manifest for one app, cached briefly per account. A
   * launch refusal that changes what the account may do with the app evicts
   * it (see `launch`), so the cache never outlives a revocation.
   */
  async manifest(app: unknown, signal?: AbortSignal): Promise<AppManifestResponse> {
    const appId = requireAppId(app)
    const accountId = this.requireSession().user.id
    const cacheKey = this.accountAppKey(accountId, appId)
    const epoch = this.accountEpoch(accountId, appId)
    const cached = this.manifests.get(cacheKey)

    if (cached && cached.expiresAt > (this.options.now?.() ?? Date.now())) {
      return cached.value
    }

    const inFlight = this.manifestRequests.get(cacheKey)

    if (inFlight) {
      return inFlight
    }

    const request = this.request(
      `/api/desktop/v1/apps/${encodeURIComponent(appId)}/manifest`,
      { headers: { [PARTICIPANT_REFS_HEADER]: '1', [APP_LAUNCH_NEGOTIATION_HEADER]: APP_LAUNCH_NEGOTIATION_VALUE } },
      parseAppManifestResponse,
      this.accountRequestSignal(accountId, appId, signal)
    ).then(value => {
      if (value.manifest.app.slug !== appId) {
        throw new MessagingHttpError('app_manifest_invalid', 200, false, null, null, null)
      }

      if (value.participant && value.participant.ownerUserId !== accountId.toLowerCase()) {
        throw new MessagingHttpError('app_manifest_invalid', 200, false, null, null, null)
      }

      if (this.accountEpoch(accountId, appId) !== epoch || this.options.session()?.user.id !== accountId) {
        throw new MessagingHttpError('app_surface_cancelled', 0, false, null, null, null)
      }

      if (this.accountEpoch(accountId, appId) === epoch) {
        this.manifests.set(cacheKey, { expiresAt: (this.options.now?.() ?? Date.now()) + APP_MANIFEST_TTL_MS, value })
      }

      return value
    })

    this.manifestRequests.set(cacheKey, request)

    try {
      return await request
    } finally {
      if (this.manifestRequests.get(cacheKey) === request) {
        this.manifestRequests.delete(cacheKey)
      }
    }
  }

  evictManifest(app: unknown): void {
    const appId = requireAppId(app)
    const session = this.options.session()

    if (!session) {
      return
    }

    this.manifests.delete(this.accountAppKey(session.user.id, appId))
  }

  /**
   * Mint a one-time launch for a session-required route. Everything that
   * decides whether a launch may exist lives on the platform; this client
   * only binds the answer to the manifest it holds. The URL is returned to
   * main's app-view controller and to nothing else.
   */
  async launch(app: unknown, routeId: unknown, signal?: AbortSignal): Promise<AppLaunchIssue> {
    const appId = requireAppId(app)
    const route = requireRouteId(routeId)
    const accountId = this.requireSession().user.id
    const epoch = this.accountEpoch(accountId, appId)
    const accountSignal = this.accountRequestSignal(accountId, appId, signal)
    const { manifest, web_origin: webOrigin } = await this.manifest(appId, accountSignal)
    const declared = manifest.routes.find(entry => entry.id === route)

    if (!declared) {
      throw new MessagingHttpError('route_unknown', 404, false, null, null, null)
    }

    if (declared.session !== 'required' || manifest.launch === null) {
      throw new MessagingHttpError('route_session_not_required', 409, false, null, null, null)
    }

    const launchPath = manifest.launch.path

    try {
      const issued = await this.request(
        `/api/desktop/v1/apps/${encodeURIComponent(appId)}/launch`,
        { method: 'POST', headers: { [APP_LAUNCH_NEGOTIATION_HEADER]: APP_LAUNCH_NEGOTIATION_VALUE }, body: JSON.stringify({ route_id: route }) },
        value => parseAppLaunchIssue(value, { webOrigin, launchPath }),
        accountSignal
      )

      if (accountSignal.aborted || this.accountEpoch(accountId, appId) !== epoch) {
        throw new MessagingHttpError('app_surface_cancelled', 0, false, null, null, null)
      }

      return issued
    } catch (error) {
      if (error instanceof MessagingHttpError) {
        const refusal =
          error.details && typeof error.details.launch_error === 'string' ? error.details.launch_error : null

        if (refusal) {
          if (MANIFEST_EVICTING_REFUSALS.has(refusal)) {
            this.manifests.delete(this.accountAppKey(accountId, appId))
          }

          throw new MessagingHttpError(
            refusal,
            error.status,
            refusal === 'temporarily_unavailable',
            null,
            null,
            error.details
          )
        }
      }

      throw error
    }
  }

  /** Read the server-owned link lifecycle. Unlike discovery, this is safe to refresh. */
  async connectStatus(app: unknown, signal?: AbortSignal): Promise<ConnectLifecycle> {
    const appId = requireAppId(app)
    const accountId = this.requireSession().user.id

    return this.request(
      `/api/desktop/v1/apps/${encodeURIComponent(appId)}/connect/status`,
      {},
      parseConnectLifecycle,
      this.accountRequestSignal(accountId, appId, signal)
    )
  }

  /**
   * Begin the link. Main opens the returned authorize URL in the SYSTEM
   * BROWSER — the user authenticates on the app's own surface, which is the
   * consent this flow exists to obtain. The URL never reaches the renderer.
   */
  async connectStart(app: unknown, signal?: AbortSignal): Promise<{ opened: true }> {
    const appId = requireAppId(app)
    const accountId = this.requireSession().user.id
    const epoch = this.accountEpoch(accountId, appId)
    const accountSignal = this.accountRequestSignal(accountId, appId, signal)

    const authorizeUrl = await this.request(
      `/api/desktop/v1/apps/${encodeURIComponent(appId)}/connect/start`,
      { method: 'POST' },
      parseAuthorizeUrl,
      accountSignal
    )

    if (accountSignal.aborted || this.accountEpoch(accountId, appId) !== epoch) {
      throw new MessagingHttpError('app_surface_cancelled', 0, false, null, null, null)
    }

    try {
      await this.options.openExternal(authorizeUrl)
    } catch {
      throw new MessagingHttpError('connect_browser_unavailable', 0, false, null, null, null)
    }

    return { opened: true }
  }

  async connectDismiss(app: unknown, signal?: AbortSignal): Promise<ConnectCandidate> {
    const appId = requireAppId(app)
    const session = this.requireSession()
    const accountId = session.user.id
    const probeKey = this.accountAppKey(accountId, appId)
    const epoch = this.accountEpoch(accountId, appId)
    const candidate = this.candidateResults.get(probeKey)

    // Dismissal is authority over an offer main has actually observed. A
    // hostile renderer cannot manufacture candidates or seed this cache by
    // invoking dismiss before discovery (or after a non-available result).
    if (candidate?.status !== 'available') {
      throw new MessagingHttpError('connect_candidate_unavailable', 409, false, null, null, null)
    }

    const result = await this.request(
      `/api/desktop/v1/apps/${encodeURIComponent(appId)}/connect/dismiss`,
      { method: 'POST' },
      parseConnectCandidate,
      this.accountRequestSignal(accountId, appId, signal)
    )

    if (this.accountEpoch(accountId, appId) === epoch) {
      this.candidateResults.set(probeKey, result)
    }

    return result
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    parse: (value: unknown) => T,
    signal?: AbortSignal
  ): Promise<T> {
    const session = this.requireSession()

    try {
      return await this.send(session, path, init, parse, signal)
    } catch (error) {
      if (!(error instanceof MessagingHttpError) || error.status !== 401) {
        throw error
      }

      const refreshed = await this.options.refresh(session)

      if (!refreshed) {
        throw error
      }

      return this.send(refreshed, path, init, parse, signal)
    }
  }

  private async send<T>(
    session: MessagingAccountSession,
    path: string,
    init: RequestInit,
    parse: (value: unknown) => T,
    signal?: AbortSignal
  ): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    headers.set('authorization', `Bearer ${session.tokens.accessToken}`)

    if (init.body !== undefined) {
      headers.set('content-type', 'application/json; charset=utf-8')
    }

    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs)
    let response: Response
    let bytes: string

    try {
      response = await this.fetchImpl(`${session.baseUrl}${path}`, {
        ...init,
        headers,
        cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      })

      // Optional desktop routes deploy independently from the client. Classify
      // their absence from transport facts before reading or parsing a body:
      // old Next.js deployments may return an HTML/empty 404 or redirect a
      // bearer request through the cookie-era same-origin login middleware.
      if (isLegacyLoginRedirect(response, session.baseUrl)) {
        throw new MessagingHttpError('app_surface_unavailable', response.status, false, null, null, null)
      }

      bytes = await this.readBounded(response)

      // A 404 is capability absence unless it carries the desktop error
      // envelope: a deployed route answers 404 with `{error:{code}}` (for
      // example a launch for an undeclared route), an old deployment with
      // HTML or nothing.
      if (response.status === 404 && !isDesktopErrorEnvelope(bytes)) {
        throw new MessagingHttpError('app_surface_unavailable', response.status, false, null, null, null)
      }
    } catch (error) {
      if (signal?.aborted) {
        throw new MessagingHttpError('app_surface_cancelled', 0, false, null, null, null)
      }

      if (error instanceof MessagingHttpError) {
        throw error
      }

      // `app_surface_unavailable` is reserved for a runtime/deployment that
      // does not expose this optional capability. A transport failure is
      // transient and must remain distinguishable so the UI can offer one
      // explicit retry without turning focus into an automatic loop.
      throw new MessagingHttpError('app_surface_request_failed', 0, true, null, null, null)
    }

    let body: unknown

    try {
      body = bytes ? JSON.parse(bytes) : null
    } catch {
      throw new MessagingHttpError('app_surface_invalid_response', response.status, false, null, null, null)
    }

    if (!response.ok) {
      throw errorCode(body, response.status)
    }

    return parse(body)
  }

  private async readBounded(response: Response): Promise<string> {
    if (!response.body) {
      return ''
    }

    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let size = 0

    for (;;) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      size += value.byteLength

      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new MessagingHttpError('app_surface_response_too_large', response.status, false, null, null, null)
      }

      chunks.push(Buffer.from(value))
    }

    return Buffer.concat(chunks).toString('utf8')
  }

  private requireSession(): MessagingAccountSession {
    const session = this.options.session()

    if (!session) {
      throw new MessagingHttpError('auth_unavailable', 401, false, null, null, null)
    }

    return session
  }

  private accountAppKey(accountId: string, appId: string): string {
    return `${accountId}:${appId}`
  }

  private accountEpoch(accountId: string, appId?: string): number {
    return (
      (this.accountEpochs.get(accountId) ?? 0) +
      (appId ? (this.accountEpochs.get(this.accountAppKey(accountId, appId)) ?? 0) : 0)
    )
  }

  private accountRequestSignal(accountId: string, appId?: string, signal?: AbortSignal): AbortSignal {
    const signals = signal ? [signal] : []

    for (const key of [accountId, ...(appId ? [this.accountAppKey(accountId, appId)] : [])]) {
      let controller = this.accountRequestControllers.get(key)

      if (!controller) {
        controller = new AbortController()
        this.accountRequestControllers.set(key, controller)
      }

      signals.push(controller.signal)
    }

    return AbortSignal.any(signals)
  }

  private persistProbes(): void {
    if (!this.options.probeStorePath) {
      return
    }

    try {
      writeFileSync(this.options.probeStorePath, JSON.stringify([...this.probes.keys()]), { mode: 0o600 })
    } catch {
      /* guarded in memory */
    }
  }
}

function isLegacyLoginRedirect(response: Response, baseUrl: string): boolean {
  if (!response.redirected || !response.url) {
    return false
  }

  try {
    const finalUrl = new URL(response.url)
    const expectedOrigin = new URL(baseUrl).origin

    return finalUrl.origin === expectedOrigin && finalUrl.pathname === '/login'
  } catch {
    return false
  }
}
