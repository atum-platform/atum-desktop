/**
 * The catalog is a server-authored presentation projection. It deliberately
 * contains no origin, route, or credential details. Its closed bot transport
 * mode selects only the direct-room send path; rendering an app does not grant
 * the renderer permission to launch or connect it.
 */
import { APP_UUID } from './app-shortcuts'
import { decodeLookPack, type LookPackPublished } from './look-pack'
import { parseVerificationTier, type VerificationTier } from './verification'

export const APP_CATALOG_PROFILE = 'atum.app-catalog/1' as const
export const APP_CATALOG_V2_PROFILE = 'atum.app-catalog/2' as const
export const APP_CATALOG_V2_NEGOTIATION_HEADER = 'X-Atum-App-Catalog' as const
export const APP_CATALOG_V2_NEGOTIATION_VALUE = '2' as const

/**
 * The app-bot disclosure this Atum can show (atum-app-bots v1 §10.5, disclosure version 1).
 * The setup card records consent only to it, and main confirms a link by itself only while a
 * fresh status read says consent to it stands. A newer disclosure needs a newer Atum.
 */
export const APP_BOT_DISCLOSURE_VERSION = 1
/** Adds explicit linked-account history projection terms without invalidating
 * consent for apps that do not expose that capability. */
export const APP_BOT_HISTORY_DISCLOSURE_VERSION = 2
/** The contained first-contact readers from atum.app-bots/1.1. The platform
 * activates these only after Desktop and phone both ship the matching copy. */
export const MOON_APP_ONBOARDING_DISCLOSURE_VERSION = 3
export const ANDY_APP_ONBOARDING_DISCLOSURE_VERSION = 2
export const APP_BOT_CONSENT_LOCALES = ['vi', 'en', 'ja', 'zh', 'zh-hant'] as const

export type AppLocalizedCopy = Record<string, string>
export type AppAffiliation = 'first_party' | 'partner'
export type AppAvailability = 'available' | 'unavailable'
/** Presentation-only roster state. Absent is the legacy/available presentation; executable
 * availability stays `availability`. `coming_soon` never grants a bot, room or launch route. */
export type AppRosterState = 'available' | 'coming_soon'
export type AppSupportedMode = 'direct' | 'private_group' | 'shared_group'
export type AppBotTransportMode = 'legacy_turn' | 'bot_api'

/**
 * A server-authored app-chat identity.  This stays data-only: the renderer may
 * present it, but creating a room or trusting a device remains a native action.
 */
export interface AppBotDescriptor {
  v: 1
  user_id: string
  handle: string
  display_name: string
  avatar: { url: string; sha256: string }
  device_generation: number
  device: { device_id: string; ed25519: string; curve25519: string } | null
  state: 'starting' | 'active' | 'paused' | 'unavailable'
  groups: boolean
  consent: 'accepted' | 'required'
  disclosure_version: number
  open_route_id: string
  open_shared_memory: boolean
  purchase_route_id: string
  /** Signed transport authority. Older and unknown catalog values stay on the legacy path. */
  transport_mode?: AppBotTransportMode
  /** The reviewed guest capability. Missing on older catalogs means linked-only v1. */
  guest_enabled?: boolean
  /** The explicit direct-turn authority profile; v2 is valid only with guest_enabled. */
  direct_profile?: 'atum.turn-memory/1' | 'atum.turn-memory/2'
}

export interface AppDescriptor {
  app: string
  app_id: string
  app_version_id: string
  name: AppLocalizedCopy
  subtitle: AppLocalizedCopy | null
  description: AppLocalizedCopy | null
  icon: { url: string; sha256: string } | null
  accent: string | null
  /** Unknown future affiliations are intentionally retained but never trusted as labels. */
  affiliation: string | null
  /** The manifest agreement check's flag only: it no longer draws a mark (`verification` does). */
  verified: boolean
  /** How far Atum vouches for the app (`atum.apps.verification_tier`; shared/verification.ts):
   * official (Atum's own app, a filled check) or verified (a hollow check). Absent or null, as
   * from an older platform, draws no mark. The parser always sets it. */
  verification?: VerificationTier | null
  availability: AppAvailability
  roster_default: boolean
  roster_order: number
  /** Effective owner-scoped presentation (atum.app-catalog/1, amendment 2026-10-21).
   * Absent means `available`; a `coming_soon` descriptor is inert and cannot be launched. */
  roster_state?: AppRosterState
  supported_modes: AppSupportedMode[]
  /** Approved native provider context, separate from legacy placement modes.
   * Absent/unknown is not chat support; it never grants membership or keys. */
  matrix_room_context?: 'addressed_only' | null
  has_surface: boolean
  /** The platform can project linked private history for this app. Absent on older catalogs. */
  has_history?: boolean
  link: { mode: 'none' | 'external_account'; state: 'never_linked' | 'linked' | 'unlinked' }
  /** Null when this catalog app has no official chat identity. */
  /** Optional only while older catalog providers are still in use; decoded catalogs always set it. */
  bot?: AppBotDescriptor | null
  /** Reviewed presentation data. Absent on current catalog v1 and while L1 is not deployed. */
  look?: LookPackPublished | null
}

export interface AppCatalog {
  profile: typeof APP_CATALOG_PROFILE | typeof APP_CATALOG_V2_PROFILE
  apps: AppDescriptor[]
  /** Only negotiated v2 may prove an omitted app was withdrawn. */
  omissionsAuthoritative?: boolean
}

/** Whether this descriptor advertises one of the new contained-onboarding
 * disclosures whose complete five-locale reader ships with this client. */
export function usesContainedAppOnboarding(
  app: Pick<AppDescriptor, 'app' | 'bot' | 'has_history'>
): app is Pick<AppDescriptor, 'app' | 'bot' | 'has_history'> & { app: 'moon' | 'andy' } {
  return (
    (app.app === 'moon' &&
      app.has_history === true &&
      app.bot?.disclosure_version === MOON_APP_ONBOARDING_DISCLOSURE_VERSION) ||
    (app.app === 'andy' &&
      app.has_history !== true &&
      app.bot?.disclosure_version === ANDY_APP_ONBOARDING_DISCLOSURE_VERSION)
  )
}

/** The exact disclosure text this client can show for a signed descriptor.
 *
 * Keep the current v1/v2 readers valid until the platform activates the new
 * versions. Unknown future versions still mismatch and fail closed. */
export function appBotDisclosureVersion(app: Pick<AppDescriptor, 'app' | 'bot' | 'has_history'>): number {
  if (usesContainedAppOnboarding(app)) {
    return app.bot!.disclosure_version
  }

  return app.has_history ? APP_BOT_HISTORY_DISCLOSURE_VERSION : APP_BOT_DISCLOSURE_VERSION
}

const SLUG = /^[a-z][a-z0-9_-]{0,63}$/u
const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u
const ACCENT = /^#[0-9a-fA-F]{6}$/u
const SHA256 = /^[0-9a-f]{64}$/u

function invalid(): never {
  throw new Error('app_catalog_invalid')
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) {
    invalid()
  }

  return value
}

function localizedCopy(value: unknown): AppLocalizedCopy {
  const copy = object(value)
  const entries = copy && Object.entries(copy)

  if (!entries || entries.length > 16) {
    invalid()
  }

  const result: AppLocalizedCopy = {}

  for (const [locale, phrase] of entries) {
    const normalized = typeof phrase === 'string' ? phrase.trim() : ''

    if (!LOCALE.test(locale) || !normalized || normalized.length > 1000) {
      invalid()
    }

    result[locale] = normalized
  }

  return result
}

function nullableLocalizedCopy(value: unknown): AppLocalizedCopy | null {
  return value === null ? null : localizedCopy(value)
}

/** Closed optional presentation enum. Absent is legacy/available, never inferred. */
function rosterState(value: unknown): AppRosterState | undefined {
  if (value === undefined) {
    return undefined
  }

  if (value === 'available' || value === 'coming_soon') {
    return value
  }

  invalid()
}

function icon(value: unknown): AppDescriptor['icon'] {
  if (value === null) {
    return null
  }

  const candidate = object(value)
  const url = candidate && text(candidate.url, 2048)
  const sha256 = candidate && text(candidate.sha256, 64)

  if (!url || !sha256 || !SHA256.test(sha256)) {
    invalid()
  }

  try {
    const parsed = new URL(url)

    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
      invalid()
    }
  } catch {
    invalid()
  }

  return { url, sha256 }
}

function link(value: unknown): AppDescriptor['link'] {
  const candidate = object(value)
  const mode = candidate?.mode
  const state = candidate?.state

  if (
    (mode !== 'none' && mode !== 'external_account') ||
    (state !== 'never_linked' && state !== 'linked' && state !== 'unlinked')
  ) {
    invalid()
  }

  if (mode === 'none' && state !== 'never_linked') {
    invalid()
  }

  return { mode, state }
}

const MATRIX_ID = /^@app-[a-z][a-z0-9_-]*:atumplatform\.com$/u
const DEVICE_ID = /^[A-Za-z0-9._=-]{1,255}$/u
const BASE64 = /^[A-Za-z0-9+/]{43}$/u

function bot(value: unknown): AppBotDescriptor | null {
  if (value === null || value === undefined) {
    return null
  }

  const candidate = object(value)
  const device = candidate && candidate.device === null ? null : object(candidate?.device)
  const userId = candidate ? text(candidate.user_id, 1024) : ''
  const handle = candidate ? text(candidate.handle, 64) : ''
  const displayName = candidate ? text(candidate.display_name, 120) : ''
  const generation = typeof candidate?.device_generation === 'number' ? candidate.device_generation : Number.NaN
  const disclosureVersion = typeof candidate?.disclosure_version === 'number' ? candidate.disclosure_version : Number.NaN
  const state = candidate?.state
  const consent = candidate?.consent
  const openRouteId = candidate ? text(candidate.open_route_id, 64) : ''
  const purchaseRouteId = candidate ? text(candidate.purchase_route_id, 64) : ''
  const transportMode: AppBotTransportMode = candidate?.transport_mode === 'bot_api' ? 'bot_api' : 'legacy_turn'
  const guestEnabled = candidate?.guest_enabled === undefined ? false : candidate.guest_enabled
  const directProfile = candidate?.direct_profile === undefined ? 'atum.turn-memory/1' : candidate.direct_profile

  if (
    !candidate ||
    candidate.v !== 1 ||
    !userId ||
    !MATRIX_ID.test(userId) ||
    !/^[a-z][a-z0-9_]*_bot$/u.test(handle) ||
    !displayName.trim() ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !Number.isSafeInteger(disclosureVersion) ||
    disclosureVersion < 1 ||
    (state !== 'starting' && state !== 'active' && state !== 'paused' && state !== 'unavailable') ||
    (consent !== 'accepted' && consent !== 'required') ||
    typeof candidate.groups !== 'boolean' ||
    typeof candidate.open_shared_memory !== 'boolean' ||
    !openRouteId ||
    !SLUG.test(openRouteId) ||
    !purchaseRouteId ||
    !SLUG.test(purchaseRouteId) ||
    typeof guestEnabled !== 'boolean' ||
    (directProfile !== 'atum.turn-memory/1' && directProfile !== 'atum.turn-memory/2') ||
    guestEnabled !== (directProfile === 'atum.turn-memory/2')
  ) {
    invalid()
  }

  const avatar = icon(candidate.avatar)

  if (!avatar) {
    invalid()
  }

  if (device && (!DEVICE_ID.test(String(device.device_id ?? '')) || !BASE64.test(String(device.ed25519 ?? '')) || !BASE64.test(String(device.curve25519 ?? '')))) {
    invalid()
  }

  if (!device && state === 'active') {
    invalid()
  }

  return {
    v: 1,
    user_id: userId,
    handle,
    display_name: displayName,
    avatar,
    device_generation: generation,
    device: device
      ? { device_id: device.device_id as string, ed25519: device.ed25519 as string, curve25519: device.curve25519 as string }
      : null,
    state,
    groups: candidate.groups,
    consent,
    disclosure_version: disclosureVersion,
    open_route_id: openRouteId,
    open_shared_memory: candidate.open_shared_memory,
    purchase_route_id: purchaseRouteId,
    transport_mode: transportMode,
    guest_enabled: guestEnabled,
    direct_profile: directProfile
  }
}

/** Decode one descriptor for the native workspace companion without assuming a catalog transport. */
export function parseAppDescriptor(value: unknown): AppDescriptor {
  const candidate = object(value)

  if (!candidate) {
    invalid()
  }

  const app = text(candidate.app, 64)
  const appId = text(candidate.app_id, 64).toLowerCase()
  const appVersionId = text(candidate.app_version_id, 64).toLowerCase()
  const accent = candidate.accent
  const affiliation = candidate.affiliation
  const modes = candidate.supported_modes

  if (!SLUG.test(app) || !APP_UUID.test(appId) || !APP_UUID.test(appVersionId)) {
    invalid()
  }

  const parsedBot = bot(candidate.bot)

  // An official bot's Matrix identity is derived from its app slug. A catalog
  // cannot attach a different @app-* identity to an app it does not own.
  if (parsedBot && parsedBot.user_id !== `@app-${app}:atumplatform.com`) {
    invalid()
  }

  if (accent !== null && (typeof accent !== 'string' || !ACCENT.test(accent))) {
    invalid()
  }

  if (affiliation !== null && (typeof affiliation !== 'string' || !affiliation.trim() || affiliation.length > 64)) {
    invalid()
  }

  if (
    typeof candidate.verified !== 'boolean' ||
    (candidate.availability !== 'available' && candidate.availability !== 'unavailable')
  ) {
    invalid()
  }

  if (
    typeof candidate.roster_default !== 'boolean' ||
    typeof candidate.roster_order !== 'number' ||
    !Number.isInteger(candidate.roster_order) ||
    candidate.roster_order < 0 ||
    candidate.roster_order > 2_147_483_647
  ) {
    invalid()
  }

  const parsedLink = link(candidate.link)
  const parsedRosterState = rosterState(candidate.roster_state)
  const parsedLook = candidate.look === undefined ? undefined : decodeLookPack(candidate.look)

  // A presentation-only row is inert. Refuse a descriptor that tries to carry a bot, a
  // surface, room context, history or a link: none may become launch authority by mistake.
  if (
    parsedRosterState === 'coming_soon' &&
    (candidate.availability !== 'unavailable' ||
      parsedBot !== null ||
      candidate.has_surface !== false ||
      candidate.has_history === true ||
      !Array.isArray(modes) ||
      modes.length > 0 ||
      (candidate.matrix_room_context !== undefined && candidate.matrix_room_context !== null) ||
      parsedLink.mode !== 'none')
  ) {
    invalid()
  }

  if (
    typeof candidate.has_surface !== 'boolean' ||
    (candidate.has_history !== undefined && typeof candidate.has_history !== 'boolean') ||
    !Array.isArray(modes) ||
    modes.length > 3
  ) {
    invalid()
  }

  if (
    !modes.every(mode => mode === 'direct' || mode === 'private_group' || mode === 'shared_group') ||
    new Set(modes).size !== modes.length
  ) {
    invalid()
  }

  return {
    app,
    app_id: appId,
    app_version_id: appVersionId,
    name: localizedCopy(candidate.name),
    subtitle: nullableLocalizedCopy(candidate.subtitle),
    description: nullableLocalizedCopy(candidate.description),
    icon: icon(candidate.icon),
    accent: accent as string | null,
    affiliation: affiliation as string | null,
    verified: candidate.verified,
    verification: parseVerificationTier(candidate.verification),
    availability: candidate.availability,
    roster_default: candidate.roster_default,
    roster_order: candidate.roster_order,
    ...(parsedRosterState ? { roster_state: parsedRosterState } : {}),
    supported_modes: [...modes],
    matrix_room_context: candidate.matrix_room_context === 'addressed_only' ? 'addressed_only' : null,
    has_surface: candidate.has_surface,
    has_history: candidate.has_history === true,
    link: parsedLink,
    bot: parsedBot,
    ...(candidate.look === undefined ? {} : { look: parsedLook })
  }
}

function parsedV2Bot(value: unknown): AppBotDescriptor | null {
  try {
    return bot(value)
  } catch {
    return null
  }
}

function v2ActionHasSurface(value: unknown): boolean {
  const action = object(value)
  const capabilities = action?.required_capabilities

  return Boolean(
    action &&
      action.kind === 'launch_route' &&
      typeof action.route_id === 'string' &&
      SLUG.test(action.route_id) &&
      Array.isArray(capabilities) &&
      capabilities.includes('app.surface.route')
  )
}

/**
 * Catalog v2 is richer than this established desktop projection. Decode its
 * authority-bearing core, then map only facts the current native workspace
 * already understands. Optional/future presentation and action details never
 * become authority. The look is decoded independently and may fail alone.
 */
function parseAppDescriptorV2(value: unknown): AppDescriptor {
  const candidate = object(value)
  const chat = candidate && object(candidate.chat)
  const actions = candidate?.actions

  if (
    !candidate ||
    !chat ||
    typeof chat.direct !== 'boolean' ||
    (chat.direct_profile !== null &&
      chat.direct_profile !== 'atum.turn-memory/1' &&
      chat.direct_profile !== 'atum.turn-memory/2') ||
    chat.direct !== (chat.direct_profile !== null) ||
    typeof chat.guest_capable !== 'boolean' ||
    chat.guest_capable !== (chat.direct_profile === 'atum.turn-memory/2') ||
    (chat.linking !== 'none' && chat.linking !== 'optional' && chat.linking !== 'required') ||
    typeof chat.addressed_groups !== 'boolean' ||
    !Array.isArray(actions) ||
    actions.length > 64
  ) {
    invalid()
  }

  const parsedLink = link(candidate.link)

  if ((chat.linking === 'none') !== (parsedLink.mode === 'none')) {
    invalid()
  }

  let parsedBot = parsedV2Bot(candidate.bot)

  if (
    parsedBot &&
    (parsedBot.user_id !== `@app-${String(candidate.app)}:atumplatform.com` ||
      parsedBot.direct_profile !== chat.direct_profile ||
      parsedBot.guest_enabled !== chat.guest_capable ||
      parsedBot.groups !== chat.addressed_groups)
  ) {
    parsedBot = null
  }

  const verification = parseVerificationTier(candidate.verification)
  const parsedLook = decodeLookPack(candidate.look)
  const modes: AppSupportedMode[] = [
    ...(chat.direct ? (['direct'] as const) : []),
    ...(chat.addressed_groups ? (['private_group', 'shared_group'] as const) : [])
  ]

  const descriptor = parseAppDescriptor({
    app: candidate.app,
    app_id: candidate.app_id,
    app_version_id: candidate.app_version_id,
    name: candidate.name,
    subtitle: candidate.subtitle,
    description: candidate.description,
    icon: candidate.icon,
    accent: parsedLook?.accent?.light ?? null,
    affiliation: candidate.affiliation,
    verified: verification !== null,
    verification,
    availability: candidate.availability,
    roster_default: candidate.roster_default,
    roster_order: candidate.roster_order,
    ...(candidate.roster_state === undefined ? {} : { roster_state: candidate.roster_state }),
    supported_modes: modes,
    matrix_room_context: chat.addressed_groups ? 'addressed_only' : null,
    has_surface: actions.some(v2ActionHasSurface),
    // V2 folds linked-history behavior into a required external-account chat.
    has_history: chat.linking === 'required',
    link: parsedLink,
    bot: parsedBot,
    ...(candidate.look === undefined ? {} : { look: parsedLook })
  })

  return parsedLook?.publisher.kind === 'app' && parsedLook.publisher.app_id !== descriptor.app_id
    ? { ...descriptor, look: null }
    : descriptor
}

/**
 * Parses only the catalog profile this client recognizes. Extra optional
 * presentation fields are ignored inside v1; a profile change is not guessed
 * at, because that could turn future authority data into present UI meaning.
 */
export function parseAppCatalog(value: unknown): AppCatalog {
  const candidate = object(value)

  if (candidate?.profile !== APP_CATALOG_PROFILE && candidate?.profile !== APP_CATALOG_V2_PROFILE) {
    throw new Error('app_catalog_profile_unsupported')
  }

  if (!Array.isArray(candidate.apps) || candidate.apps.length > 100) {
    invalid()
  }

  const apps = candidate.apps.map(candidate.profile === APP_CATALOG_V2_PROFILE ? parseAppDescriptorV2 : parseAppDescriptor)
  const ids = new Set<string>()
  const slugs = new Set<string>()

  for (const app of apps) {
    if (ids.has(app.app_id) || slugs.has(app.app)) {
      invalid()
    }

    ids.add(app.app_id)
    slugs.add(app.app)
  }

  return {
    profile: candidate.profile,
    apps,
    ...(candidate.profile === APP_CATALOG_V2_PROFILE
      ? { omissionsAuthoritative: candidate.omissions_authoritative === true }
      : {})
  }
}

export function appLocalizedCopy(copy: AppLocalizedCopy | null, locale: string, fallback = ''): string {
  return copy?.[locale] ?? copy?.en ?? fallback
}

/**
 * Every name the apps in a catalog go by: each app's name in each language it ships, its bot's
 * display name and its slug read as words ("etax-mobile" is "etax mobile"). The assistant-name
 * rules keep them for the apps (shared/matrix-assistant-name.ts, `apps`), so nobody is called
 * what an app is called; neither file lists an app. Empty for no catalog.
 */
export function appCatalogNames(
  apps: ReadonlyArray<Pick<AppDescriptor, 'app' | 'name' | 'bot'>> | null | undefined
): string[] {
  const names = new Set<string>()

  for (const app of apps ?? []) {
    for (const name of [...Object.values(app.name ?? {}), app.bot?.display_name, app.app.replaceAll('-', ' ')]) {
      if (typeof name === 'string' && name.trim()) {
        names.add(name.trim())
      }
    }
  }

  return [...names]
}
