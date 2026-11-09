/**
 * Desktop's consumer-side reader for the frozen `atum.look-pack/1` contract.
 *
 * Producers are strict. Consumers deliberately strip additive fields and
 * degrade only the invalid component: bad tokens do not discard a ground, and
 * one bad layer turns that appearance into its plain pinned base. Asset bytes
 * are independently verified again in Electron main before Chromium sees them.
 */

export const LOOK_PACK_PROFILE = 'atum.look-pack/1' as const
export const LOOK_GALLERY_PROFILE = 'atum.look-gallery/1' as const
export const LOOK_ROOM_ACCOUNT_DATA_TYPE = 'io.atum.chat.look' as const
export const LOOK_PACK_NEGOTIATION_HEADER = 'X-Atum-Look-Pack' as const
export const LOOK_PACK_NEGOTIATION_VALUE = '1' as const

export interface LookPackAssetVariant {
  mime: 'image/svg+xml' | 'image/webp' | 'image/png'
  sha256: string
  bytes: number
  width: number
  height: number
  use: 'full' | 'thumb'
}

export interface LookPackAssetRef {
  sha256: string
  kind: 'vector' | 'raster'
  width: number
  height: number
  variants: LookPackAssetVariant[]
}

export interface LookPackLayer {
  asset: LookPackAssetRef
  fit: 'cover' | 'contain' | 'tile'
  tile_px: number | null
  position: 'center' | 'top' | 'bottom' | 'start' | 'end'
  opacity: number
}

export interface LookPackGround {
  tone: 'dark' | 'light'
  base: string
  layers: LookPackLayer[]
}

export type LookPackFont = 'system-sans' | 'system-serif' | 'be-vietnam-pro' | 'literata'
export type LookPackRadius = 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'pill' | 'xl-tail-start' | 'xl-tail-end'

export interface LookPackChatTokens {
  colors: {
    foreground: string
    background: string
    owner_bubble: string
    app_bubble: string
    bubble_foreground: string
    border: string
  }
  radii: {
    owner_bubble: LookPackRadius
    app_bubble: LookPackRadius
    composer: LookPackRadius
  }
  fonts: { ui: LookPackFont; body: LookPackFont }
  composer: { fill: string; ink: string; action: string; action_ink: string } | null
}

export interface LookPackDerivedGround {
  worst: string
  ink: string
  ink_soft: string
  ink_muted: string
  ink_faint: string
  line: string
  scrim: string
}

export interface LookPackPublished {
  profile: typeof LOOK_PACK_PROFILE
  pack_id: string
  version: number
  digest: string
  publisher: { kind: 'app'; app_id: string } | { kind: 'atum' }
  name: Record<string, string>
  accent: { light: string; dark: string | null } | null
  chat: {
    background: { light: LookPackGround; dark: LookPackGround | null } | null
    tokens: LookPackChatTokens | null
  } | null
  panel?: {
    chrome?: { light: LookPackGround; dark: LookPackGround | null } | null
    chrome_derived?: { light?: LookPackDerivedGround; dark?: LookPackDerivedGround }
    page_base?: { light: string; dark: string | null } | null
    background: { light: LookPackGround; dark: LookPackGround | null } | null
    derived: { light?: LookPackDerivedGround; dark?: LookPackDerivedGround }
  } | null
  start_card: { band: LookPackGround | null } | null
  regions: Record<string, never>
  derived: { light?: LookPackDerivedGround; dark?: LookPackDerivedGround }
}

export type LookRoomAccountData =
  | { v: 1; background: { kind: 'default' } }
  | { v: 1; background: { kind: 'pack'; pack_id: string } }
  | { v: 1; background: { kind: 'none' } }

export const DEFAULT_LOOK_ROOM_ACCOUNT_DATA: LookRoomAccountData = Object.freeze({
  v: 1,
  background: Object.freeze({ kind: 'default' })
})

const HEX6 = /^#[0-9a-f]{6}$/iu
const HEX8 = /^#[0-9a-f]{8}$/iu
const SHA256 = /^[0-9a-f]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u
const FONTS = new Set<LookPackFont>(['system-sans', 'system-serif', 'be-vietnam-pro', 'literata'])

const RADII = new Set<LookPackRadius>([
  'none',
  'sm',
  'md',
  'lg',
  'xl',
  'pill',
  'xl-tail-start',
  'xl-tail-end'
])

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys)

  return Object.keys(value).length === expected.size && Object.keys(value).every(key => expected.has(key))
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
}

function localizedCopy(value: unknown): Record<string, string> | null {
  const raw = record(value)
  const entries = raw && Object.entries(raw)

  if (!entries || entries.length < 1 || entries.length > 16) {
    return null
  }

  const copy: Record<string, string> = {}

  for (const [locale, phrase] of entries) {
    if (!LOCALE.test(locale) || typeof phrase !== 'string' || !phrase.trim() || [...phrase.trim()].length > 40) {
      return null
    }

    copy[locale] = phrase.trim()
  }

  return copy
}

function assetVariant(value: unknown): LookPackAssetVariant | null {
  const raw = record(value)

  if (
    !raw ||
    !exact(raw, ['mime', 'sha256', 'bytes', 'width', 'height', 'use']) ||
    !['image/svg+xml', 'image/webp', 'image/png'].includes(String(raw.mime)) ||
    typeof raw.sha256 !== 'string' ||
    !SHA256.test(raw.sha256) ||
    !integer(raw.bytes, 1, 1_500_000) ||
    !integer(raw.width, 1, 4096) ||
    !integer(raw.height, 1, 4096) ||
    (raw.use !== 'full' && raw.use !== 'thumb')
  ) {
    return null
  }

  return {
    mime: raw.mime as LookPackAssetVariant['mime'],
    sha256: raw.sha256,
    bytes: raw.bytes,
    width: raw.width,
    height: raw.height,
    use: raw.use
  }
}

function assetRef(value: unknown): LookPackAssetRef | null {
  const raw = record(value)

  if (
    !raw ||
    !exact(raw, ['sha256', 'kind', 'width', 'height', 'variants']) ||
    typeof raw.sha256 !== 'string' ||
    !SHA256.test(raw.sha256) ||
    (raw.kind !== 'vector' && raw.kind !== 'raster') ||
    !integer(raw.width, 1, 4096) ||
    !integer(raw.height, 1, 4096) ||
    raw.width * raw.height > 12_000_000 ||
    !Array.isArray(raw.variants) ||
    raw.variants.length < 1 ||
    raw.variants.length > 6
  ) {
    return null
  }

  const variants = raw.variants.map(assetVariant)

  if (variants.some(variant => variant === null)) {
    return null
  }

  const decoded = variants as LookPackAssetVariant[]
  const keys = decoded.map(variant => `${variant.use}:${variant.mime}:${variant.width}x${variant.height}`)

  if (new Set(keys).size !== keys.length) {
    return null
  }

  return {
    sha256: raw.sha256,
    kind: raw.kind,
    width: raw.width,
    height: raw.height,
    variants: decoded
  }
}

function layer(value: unknown): LookPackLayer | null {
  const raw = record(value)
  const asset = raw && assetRef(raw.asset)

  if (
    !raw ||
    !asset ||
    (raw.fit !== 'cover' && raw.fit !== 'contain' && raw.fit !== 'tile') ||
    !['center', 'top', 'bottom', 'start', 'end'].includes(String(raw.position)) ||
    typeof raw.opacity !== 'number' ||
    raw.opacity < 0.05 ||
    raw.opacity > 1 ||
    Math.abs(raw.opacity * 100 - Math.round(raw.opacity * 100)) > Number.EPSILON * 100 ||
    ((raw.fit === 'tile') !== integer(raw.tile_px, 32, 1200)) ||
    (raw.fit !== 'tile' && raw.tile_px !== null)
  ) {
    return null
  }

  return {
    asset,
    fit: raw.fit,
    tile_px: raw.tile_px as number | null,
    position: raw.position as LookPackLayer['position'],
    opacity: raw.opacity
  }
}

/** Invalid layers never leave a partially painted ground: keep the base and drop them all. */
function ground(value: unknown): LookPackGround | null {
  const raw = record(value)

  if (
    !raw ||
    (raw.tone !== 'dark' && raw.tone !== 'light') ||
    typeof raw.base !== 'string' ||
    !HEX6.test(raw.base)
  ) {
    return null
  }

  if (!Array.isArray(raw.layers)) {
    return { tone: raw.tone, base: raw.base, layers: [] }
  }

  if (raw.layers.length > 2) {
    return { tone: raw.tone, base: raw.base, layers: [] }
  }

  const layers = raw.layers.map(layer)

  return {
    tone: raw.tone,
    base: raw.base,
    layers: layers.every(entry => entry !== null) ? (layers as LookPackLayer[]) : []
  }
}

function background(value: unknown): { light: LookPackGround; dark: LookPackGround | null } | null {
  if (value === null) {
    return null
  }

  const raw = record(value)
  const light = raw && ground(raw.light)

  if (!raw || !light) {
    return null
  }

  const dark = raw.dark === null || raw.dark === undefined ? null : ground(raw.dark)

  return raw.dark !== null && raw.dark !== undefined && !dark ? null : { light, dark }
}

function chatTokens(value: unknown): LookPackChatTokens | null {
  const raw = record(value)
  const colors = raw && record(raw.colors)
  const radii = raw && record(raw.radii)
  const fonts = raw && record(raw.fonts)
  const composer = raw?.composer === null ? null : record(raw?.composer)

  if (
    !raw ||
    !exact(raw, ['colors', 'radii', 'fonts', 'composer']) ||
    !colors ||
    !exact(colors, ['foreground', 'background', 'owner_bubble', 'app_bubble', 'bubble_foreground', 'border']) ||
    !Object.values(colors).every(value => typeof value === 'string' && HEX6.test(value)) ||
    !radii ||
    !exact(radii, ['owner_bubble', 'app_bubble', 'composer']) ||
    !Object.values(radii).every(value => RADII.has(value as LookPackRadius)) ||
    !fonts ||
    !exact(fonts, ['ui', 'body']) ||
    !Object.values(fonts).every(value => FONTS.has(value as LookPackFont)) ||
    (raw.composer !== null &&
      (!composer ||
        !exact(composer, ['fill', 'ink', 'action', 'action_ink']) ||
        !Object.values(composer).every(value => typeof value === 'string' && HEX6.test(value))))
  ) {
    return null
  }

  return {
    colors: colors as unknown as LookPackChatTokens['colors'],
    radii: radii as unknown as LookPackChatTokens['radii'],
    fonts: fonts as unknown as LookPackChatTokens['fonts'],
    composer: composer as unknown as LookPackChatTokens['composer']
  }
}

function derivedGround(value: unknown): LookPackDerivedGround | null {
  const raw = record(value)

  if (
    !raw ||
    !exact(raw, ['worst', 'ink', 'ink_soft', 'ink_muted', 'ink_faint', 'line', 'scrim']) ||
    typeof raw.worst !== 'string' ||
    !HEX6.test(raw.worst) ||
    typeof raw.scrim !== 'string' ||
    !HEX6.test(raw.scrim) ||
    !['ink', 'ink_soft', 'ink_muted', 'ink_faint', 'line'].every(
      key => typeof raw[key] === 'string' && HEX8.test(raw[key] as string)
    )
  ) {
    return null
  }

  return raw as unknown as LookPackDerivedGround
}

function publisher(value: unknown): LookPackPublished['publisher'] | null {
  const raw = record(value)

  if (!raw) {
    return null
  }

  if (raw.kind === 'atum') {
    return { kind: 'atum' }
  }

  if (
    raw.kind === 'app' &&
    typeof raw.app_id === 'string' &&
    UUID.test(raw.app_id)
  ) {
    return { kind: 'app', app_id: raw.app_id.toLowerCase() }
  }

  return null
}

/** Strip additive fields and retain every independently valid look component. */
export function decodeLookPack(value: unknown): LookPackPublished | null {
  const raw = record(value)

  if (!raw || raw.profile !== LOOK_PACK_PROFILE) {
    return null
  }

  const decodedPublisher = publisher(raw.publisher)
  const name = localizedCopy(raw.name)
  const accentRaw = raw.accent === null ? null : record(raw.accent)

  const accent =
    accentRaw &&
    exact(accentRaw, ['light', 'dark']) &&
    typeof accentRaw.light === 'string' &&
    HEX6.test(accentRaw.light) &&
    (accentRaw.dark === null || (typeof accentRaw.dark === 'string' && HEX6.test(accentRaw.dark)))
      ? { light: accentRaw.light, dark: accentRaw.dark as string | null }
      : raw.accent === null
        ? null
        : undefined

  if (
    typeof raw.pack_id !== 'string' ||
    !UUID.test(raw.pack_id) ||
    !integer(raw.version, 1, 2_147_483_647) ||
    typeof raw.digest !== 'string' ||
    !SHA256.test(raw.digest) ||
    !decodedPublisher ||
    !name ||
    accent === undefined
  ) {
    return null
  }

  let chat: LookPackPublished['chat'] = null
  const chatRaw = record(raw.chat)

  if (raw.chat !== null && chatRaw) {
    chat = {
      background: background(chatRaw.background),
      tokens: chatTokens(chatRaw.tokens)
    }
  }

  let startCard: LookPackPublished['start_card'] = null
  const startRaw = record(raw.start_card)

  if (raw.start_card !== null && startRaw) {
    startCard = { band: startRaw.band === null ? null : ground(startRaw.band) }
  }

  const derivedRaw = record(raw.derived)

  if (!derivedRaw) {
    return null
  }

  const derived: LookPackPublished['derived'] = {}

  for (const appearance of ['light', 'dark'] as const) {
    if (derivedRaw[appearance] !== undefined) {
      const decoded = derivedGround(derivedRaw[appearance])

      if (!decoded) {
        return null
      }

      derived[appearance] = decoded
    }
  }

  return {
    profile: LOOK_PACK_PROFILE,
    pack_id: raw.pack_id.toLowerCase(),
    version: raw.version,
    digest: raw.digest,
    publisher: decodedPublisher,
    name,
    accent,
    chat,
    ...(raw.panel === undefined ? {} : { panel: decodePanel(raw.panel) }),
    start_card: startCard,
    regions: {},
    derived
  }
}

function decodePanel(value: unknown): LookPackPublished['panel'] {
  const raw = record(value)

  if (!raw) {
    return null
  }
  const derivedRaw = record(raw.derived)
  const derived: NonNullable<LookPackPublished['panel']>['derived'] = {}

  for (const appearance of ['light', 'dark'] as const) {
    if (derivedRaw?.[appearance] !== undefined) {
      const decoded = derivedGround(derivedRaw[appearance])

      if (!decoded) {
        return null
      }
      derived[appearance] = decoded
    }
  }

  const chrome = background(raw.chrome)
  const chromeDerivedRaw = record(raw.chrome_derived)
  const chromeDerived: NonNullable<LookPackPublished['panel']>['derived'] = {}
  for (const appearance of ['light', 'dark'] as const) {
    const decoded = derivedGround(chromeDerivedRaw?.[appearance])
    if (decoded) {
      chromeDerived[appearance] = decoded
    }
  }
  const page = record(raw.page_base)
  const pageBase =
    page &&
    typeof page.light === 'string' &&
    HEX6.test(page.light) &&
    (page.dark === null || (typeof page.dark === 'string' && HEX6.test(page.dark)))
      ? { light: page.light, dark: page.dark as string | null }
      : null

  return {
    background: background(raw.background),
    derived,
    ...(raw.chrome === undefined
      ? {}
      : {
          chrome:
            chrome && chrome.light.layers.length <= 1 && (!chrome.dark || chrome.dark.layers.length <= 1)
              ? chrome
              : null
        }),
    ...(raw.chrome_derived === undefined ? {} : { chrome_derived: chromeDerived }),
    ...(raw.page_base === undefined ? {} : { page_base: pageBase })
  }
}

export function decodeLookGallery(value: unknown): LookPackPublished[] | null {
  const raw = record(value)

  if (raw?.profile !== LOOK_GALLERY_PROFILE || !Array.isArray(raw.items) || raw.items.length > 24) {
    return null
  }

  const seen = new Set<string>()
  const items: LookPackPublished[] = []

  for (const value of raw.items) {
    const pack = decodeLookPack(value)

    if (pack && !seen.has(pack.pack_id)) {
      seen.add(pack.pack_id)
      items.push(pack)
    }
  }

  return items
}

/** Strict writer/main-boundary reader. */
export function parseLookRoomAccountData(value: unknown): LookRoomAccountData | null {
  const raw = record(value)
  const selected = raw && record(raw.background)

  if (!raw || !selected || !exact(raw, ['v', 'background']) || raw.v !== 1) {
    return null
  }

  if (selected.kind === 'default' && exact(selected, ['kind'])) {
    return { v: 1, background: { kind: 'default' } }
  }

  if (selected.kind === 'none' && exact(selected, ['kind'])) {
    return { v: 1, background: { kind: 'none' } }
  }

  if (
    selected.kind === 'pack' &&
    exact(selected, ['kind', 'pack_id']) &&
    typeof selected.pack_id === 'string' &&
    UUID.test(selected.pack_id)
  ) {
    return { v: 1, background: { kind: 'pack', pack_id: selected.pack_id.toLowerCase() } }
  }

  return null
}

/** Unknown versions/kinds/fields resolve to default and are never rewritten. */
export function decodeLookRoomAccountData(value: unknown): LookRoomAccountData {
  return parseLookRoomAccountData(value) ?? DEFAULT_LOOK_ROOM_ACCOUNT_DATA
}

/** Chromium desktop prefers the canonical sanitised vector; raster is a bounded fallback. */
export function preferredLookVariant(
  asset: LookPackAssetRef,
  use: LookPackAssetVariant['use'] = 'full'
): LookPackAssetVariant | null {
  const choices = asset.variants.filter(variant => variant.use === use)

  if (use === 'full') {
    return (
      choices.find(variant => variant.mime === 'image/svg+xml') ??
      [...choices].sort((left, right) => right.width * right.height - left.width * left.height)[0] ??
      null
    )
  }

  return choices.find(variant => variant.mime === 'image/webp') ?? choices[0] ?? null
}

export function lookPackAssets(pack: LookPackPublished): LookPackAssetRef[] {
  const assets = new Map<string, LookPackAssetRef>()
  const grounds = [pack.chat?.background?.light, pack.chat?.background?.dark, pack.start_card?.band, pack.panel?.background?.light, pack.panel?.background?.dark, pack.panel?.chrome?.light, pack.panel?.chrome?.dark]

  for (const value of grounds) {
    for (const item of value?.layers ?? []) {
      assets.set(item.asset.sha256, item.asset)
    }
  }

  return [...assets.values()]
}
