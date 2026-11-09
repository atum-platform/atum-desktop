import type { AppPanelPages } from '../app-panel'
/**
 * Server-authored app-view contract shared by native authority adapters.
 *
 * This deliberately knows nothing about a transport, auth session, or legacy
 * messaging runtime. Callers may use these parsers with any authenticated
 * fixed-route client, while main retains all URL-bearing values.
 */
import {
  parseParticipantRef,
  parseParticipantSnapshot,
  type ParticipantDisplay,
  type ParticipantRef
} from '../atum-participants'

export const APP_MANIFEST_TTL_MS = 30_000
export const APP_LAUNCH_PROFILE = 'atum.app-launch/1'
export const APP_LAUNCH_V2_PROFILE = 'atum.app-launch/2'
// Vendored from @atum/protocol app-manifest.ts (platform #792).
export const APP_LAUNCH_NEGOTIATION_HEADER = 'Atum-App-Launch-Profile' as const
export const APP_LAUNCH_NEGOTIATION_VALUE = APP_LAUNCH_V2_PROFILE
export const REMOTE_APP_MANIFEST_PROFILE = 'atum.remote-app-manifest/1'

const APP_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/
const ROUTE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ICON_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/
const APP_LOCAL_PATH_PATTERN = /^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@-]+)*\/?)?$/
const LAUNCH_CODE_PATTERN = /^[A-Za-z0-9_-]{43,86}$/
const ORIGIN_HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/

/** The platform's launch refusal vocabulary (`details.launch_error`). */
export const APP_LAUNCH_REFUSALS = [
  'not_linked',
  'unlinked',
  'membership_inactive',
  'app_unavailable',
  'app_version_incompatible',
  'route_unknown',
  'route_session_not_required',
  'temporarily_unavailable'
] as const
export type AppLaunchRefusal = (typeof APP_LAUNCH_REFUSALS)[number]

export interface AppManifestRoute {
  id: string
  label: { vi: string; en: string }
  icon: string
  /** Main-owned route declaration; never project this into preload. */
  path: string
  placements: Array<'menu' | 'composer'>
  session: 'required' | 'none'
}

export interface AppNetworkOrigin {
  origin: string
  kinds: Array<'connect'>
}

export const MAX_APP_NETWORK_ORIGINS = 8

export interface AppManifest {
  profile: typeof REMOTE_APP_MANIFEST_PROFILE
  manifest_version: string
  app: {
    id: string
    slug: string
    app_version_id: string
    name: { vi: string; en: string }
    verified: boolean
    availability: 'available' | 'unavailable' | 'incompatible'
  }
  link: { mode: 'none' | 'external_account'; state: 'never_linked' | 'linked' | 'unlinked' }
  launch: { profile: typeof APP_LAUNCH_PROFILE | typeof APP_LAUNCH_V2_PROFILE; path: string } | null
  embed?: { profile: 'atum.panel/1'; chrome: 'host' } | null
  routes: AppManifestRoute[]
}

export interface AppManifestResponse {
  panel?: AppPanelPages | null
  manifest: AppManifest
  web_origin: string
  network_origins: AppNetworkOrigin[]
  participantRef?: ParticipantRef | null
  participant?: ParticipantDisplay | null
}

export interface AppLaunchIssue {
  launchUrl: string
  expiresAt: number
}

/**
 * Neutral error shared by fixed-route app authority adapters. Its structural
 * shape also lets the controller consume legacy MessagingTransportError values
 * without importing a token-owning transport runtime.
 */
export class AppSurfaceError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
    readonly retryAfterMs: number | null = null,
    readonly details: Record<string, unknown> | null = null
  ) {
    super(code)
    this.name = 'AppSurfaceError'
  }
}

/** The structural portion of legacy/new transport errors the controller needs. */
export interface AppViewTransportFailure {
  code: string
  status?: number
  retryAfterMs?: number | null
  details?: Record<string, unknown> | null
}

export function appViewTransportFailure(value: unknown): AppViewTransportFailure | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Partial<AppViewTransportFailure>

  if (typeof candidate.code !== 'string') {
    return null
  }

  return candidate as AppViewTransportFailure
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function text(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null
}

function protocolError(code: 'app_manifest_invalid' | 'app_launch_invalid'): never {
  throw new AppSurfaceError(code, 200)
}

function localizedText(value: unknown): { vi: string; en: string } | null {
  const body = record(value)
  const vi = body ? text(body.vi, 120) : null
  const en = body ? text(body.en, 120) : null

  return body && vi && en && Object.keys(body).length === 2 ? { vi, en } : null
}

function appLocalPath(value: unknown): string | null {
  const path = typeof value === 'string' && value.length <= 512 ? value : null

  if (
    !path ||
    !APP_LOCAL_PATH_PATTERN.test(path) ||
    path.split('/').some(segment => segment === '.' || segment === '..')
  ) {
    return null
  }

  try {
    const resolved = new URL(path, 'https://sentinel.invalid')

    return resolved.origin === 'https://sentinel.invalid' &&
      resolved.pathname === path &&
      !resolved.search &&
      !resolved.hash
      ? path
      : null
  } catch {
    return null
  }
}

function safeWebOriginText(value: unknown): string | null {
  const raw = text(value, 2048)

  if (!raw) {
    return null
  }

  try {
    const parsed = new URL(raw)
    const finalLabel = parsed.hostname.split('.').at(-1) ?? ''

    return parsed.protocol === 'https:' &&
      parsed.origin === raw &&
      !parsed.username &&
      !parsed.password &&
      ORIGIN_HOSTNAME_PATTERN.test(parsed.hostname) &&
      parsed.hostname.length <= 253 &&
      !parsed.hostname.split('.').some(label => label.length > 63) &&
      /^[a-z]/.test(finalLabel)
      ? parsed.origin
      : null
  } catch {
    return null
  }
}

function parseManifestRoute(value: unknown): AppManifestRoute {
  const route = record(value)
  const id = route ? text(route.id, 64) : null
  const label = route ? localizedText(route.label) : null
  const icon = route ? text(route.icon, 64) : null
  const path = route ? appLocalPath(route.path) : null
  const placements = route && Array.isArray(route.placements) ? route.placements : null
  const session = route?.session

  if (
    !id ||
    !ROUTE_ID_PATTERN.test(id) ||
    !label ||
    !icon ||
    !ICON_NAME_PATTERN.test(icon) ||
    !path ||
    !placements ||
    placements.length < 1 ||
    placements.length > 2 ||
    placements.some(placement => placement !== 'menu' && placement !== 'composer') ||
    new Set(placements).size !== placements.length ||
    (session !== 'required' && session !== 'none')
  ) {
    return protocolError('app_manifest_invalid')
  }

  return { id, label, icon, path, placements: placements as Array<'menu' | 'composer'>, session }
}

export function parseAppManifest(value: unknown): AppManifest {
  const body = record(value)
  const app = body ? record(body.app) : null
  const link = body ? record(body.link) : null
  const launch = body ? (body.launch === null ? null : record(body.launch)) : undefined
  const routes = body && Array.isArray(body.routes) && body.routes.length <= 32 ? body.routes : null
  const manifestVersion = body ? text(body.manifest_version, 32) : null
  const appId = app ? text(app.id, 36) : null
  const slug = app ? text(app.slug, 64) : null
  const versionId = app ? text(app.app_version_id, 36) : null
  const name = app ? localizedText(app.name) : null
  const availability = app?.availability
  const linkMode = link?.mode
  const linkState = link?.state

  if (
    !body ||
    body.profile !== REMOTE_APP_MANIFEST_PROFILE ||
    !manifestVersion ||
    !SEMVER_PATTERN.test(manifestVersion) ||
    !app ||
    !appId ||
    !UUID_PATTERN.test(appId) ||
    !slug ||
    !APP_ID_PATTERN.test(slug) ||
    !versionId ||
    !UUID_PATTERN.test(versionId) ||
    !name ||
    typeof app.verified !== 'boolean' ||
    (availability !== 'available' && availability !== 'unavailable' && availability !== 'incompatible') ||
    !link ||
    (linkMode !== 'none' && linkMode !== 'external_account') ||
    (linkState !== 'never_linked' && linkState !== 'linked' && linkState !== 'unlinked') ||
    (linkMode === 'none' && linkState !== 'never_linked') ||
    launch === undefined ||
    !routes
  ) {
    return protocolError('app_manifest_invalid')
  }

  let launchDeclaration: AppManifest['launch'] = null

  if (launch !== null) {
    const launchPath = appLocalPath(launch.path)

    if ((launch.profile !== APP_LAUNCH_PROFILE && launch.profile !== APP_LAUNCH_V2_PROFILE) || !launchPath || Object.keys(launch).length !== 2) {
      return protocolError('app_manifest_invalid')
    }

    launchDeclaration = { profile: launch.profile, path: launchPath }
  }

  const embed = record(body.embed)

  if (body.embed != null && (!embed || embed.profile !== 'atum.panel/1' || embed.chrome !== 'host' || Object.keys(embed).length !== 2)) {
    return protocolError('app_manifest_invalid')
  }

  const parsedRoutes = routes.map(parseManifestRoute)

  if (
    new Set(parsedRoutes.map(route => route.id)).size !== parsedRoutes.length ||
    (launchDeclaration === null && parsedRoutes.some(route => route.session === 'required'))
  ) {
    return protocolError('app_manifest_invalid')
  }

  return {
    profile: REMOTE_APP_MANIFEST_PROFILE,
    manifest_version: manifestVersion,
    app: {
      id: appId.toLowerCase(),
      slug,
      app_version_id: versionId.toLowerCase(),
      name,
      verified: app.verified,
      availability
    },
    link: { mode: linkMode, state: linkState },
    launch: launchDeclaration,
    ...(body.embed === undefined ? {} : { embed: embed ? { profile: 'atum.panel/1' as const, chrome: 'host' as const } : null }),
    routes: parsedRoutes
  }
}

function parseNetworkOrigins(value: unknown): AppNetworkOrigin[] {
  if (value === undefined) {
    return []
  }

  if (!Array.isArray(value) || value.length > MAX_APP_NETWORK_ORIGINS) {
    return protocolError('app_manifest_invalid')
  }

  const parsed = value.map(entry => {
    const item = record(entry)
    const origin = safeWebOriginText(item?.origin)
    const kinds = item?.kinds

    if (!origin || !Array.isArray(kinds) || kinds.length !== 1 || kinds[0] !== 'connect') {
      return protocolError('app_manifest_invalid')
    }

    return { origin, kinds: ['connect'] as Array<'connect'> }
  })

  if (new Set(parsed.map(entry => entry.origin)).size !== parsed.length) {
    return protocolError('app_manifest_invalid')
  }

  return parsed
}

export function parseAppManifestResponse(value: unknown): AppManifestResponse {
  const body = record(value)
  const origin = body ? safeWebOriginText(body.web_origin) : null

  if (!body || !origin) {
    return protocolError('app_manifest_invalid')
  }

  const manifest = parseAppManifest(body.manifest)
  let participantFields: Pick<AppManifestResponse, 'participantRef' | 'participant'> = {}

  if (body.participant_ref !== undefined || body.participant !== undefined) {
    if (body.participant_ref === null && body.participant === null) {
      participantFields = { participantRef: null, participant: null }
    } else {
      try {
        const ref = parseParticipantRef(body.participant_ref)
        const participant = parseParticipantSnapshot(body.participant)

        if (
          ref.kind !== 'app' ||
          ref.id !== manifest.app.id.toLowerCase() ||
          participant?.kind !== 'app' ||
          participant.id !== ref.id ||
          manifest.link.state !== 'linked'
        ) {
          return protocolError('app_manifest_invalid')
        }

        participantFields = { participantRef: ref, participant }
      } catch {
        return protocolError('app_manifest_invalid')
      }
    }
  }

  return {
    manifest,
    web_origin: origin,
    network_origins: parseNetworkOrigins(body.network_origins),
    ...participantFields
  }
}

export function parseAppLaunchIssue(
  value: unknown,
  expected: { webOrigin: string; launchPath: string }
): AppLaunchIssue {
  const body = record(value)
  const raw = body ? text(body.launch_url, 2048) : null
  const expiresAt = body ? text(body.expires_at, 64) : null

  if (!body || !raw || !expiresAt || Object.keys(body).length !== 2) {
    return protocolError('app_launch_invalid')
  }

  let url: URL

  try {
    url = new URL(raw)
  } catch {
    return protocolError('app_launch_invalid')
  }

  const keys = Array.from(url.searchParams.keys())
  const code = url.searchParams.get('code')

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.origin !== expected.webOrigin ||
    url.pathname !== expected.launchPath ||
    keys.length !== 1 ||
    keys[0] !== 'code' ||
    !code ||
    !LAUNCH_CODE_PATTERN.test(code)
  ) {
    return protocolError('app_launch_invalid')
  }

  const expiresMs = Date.parse(expiresAt)

  if (!Number.isFinite(expiresMs) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt)) {
    return protocolError('app_launch_invalid')
  }

  return { launchUrl: url.toString(), expiresAt: expiresMs }
}

/** Frozen atum-platform c4d08470, spec/app-launch/v2. Only authenticated main reads this.
 * Subject, signed envelope and completion receipt remain server-to-server; desktop never mints them. */
export interface BotPanelStatus {
  profile: 'atum.bot-panel-status/1'
  attempt_id: string
  state: 'pending' | 'linked' | 'unlinked' | 'expired'
  binding_revision: number
}

export function parseBotPanelStatus(value: unknown): BotPanelStatus | null {
  if (value === null) {return null}
  const body = record(value)

  if (!body || Object.keys(body).length !== 4 || body.profile !== 'atum.bot-panel-status/1'
    || typeof body.attempt_id !== 'string' || !UUID_PATTERN.test(body.attempt_id)
    || !['pending', 'linked', 'unlinked', 'expired'].includes(String(body.state))
    || !Number.isSafeInteger(body.binding_revision) || Number(body.binding_revision) < 0) {
    throw new AppSurfaceError('app_panel_status_invalid')
  }

  return body as unknown as BotPanelStatus
}

export function requiresPlatformConnection(link: AppManifest['link']): boolean {
  return link.mode === 'external_account' && link.state !== 'linked'
}
