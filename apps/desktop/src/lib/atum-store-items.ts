// RETIRED legacy commerce (pre-Matrix app): its Proton sale is removed and the platform switched its wallet spending and rewards off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
/**
 * The Atum Store's wire shapes and the pure projections the shelves read.
 *
 * The wire interfaces mirror exactly what Electron main returns from
 * `hermesDesktop.store.*` (see `electron/atum-store.ts`): main owns the
 * bearer, the signed entitlement envelope and every path; the renderer sees
 * these projections and nothing else. Prices arrive ONLY inside an offer — a
 * catalog row without an active offer cannot be acquired, and reads as
 * `unavailable`, never free (see `@/lib/atum-price` for the fail-closed rule).
 *
 * Localised copy arrives as `{ vi, en, ... }` records with Vietnamese
 * guaranteed by the platform's validation. The viewer's locale wins when the
 * row carries it; the fallback is en, then vi (vi stays the guaranteed final
 * fallback — the platform guarantees its presence). English comes before
 * Vietnamese because the app itself falls back viewer → en: a Japanese or
 * Chinese reader gets English store copy, matching the UI around it.
 */
import { type AtumPrice, FREE, UNAVAILABLE } from '@/lib/atum-price'

export type AtumStoreItemKind = 'skill' | 'pet' | 'agent'

export type AtumStoreItemSource =
  | { type: 'cloud_skill' }
  | { type: 'cloud_agent' }
  | { type: 'hermes_optional'; identifier: string }
  | { type: 'catalog_bundle'; sha256: string }
  | { type: 'bundled'; slug: string }
  | { type: 'catalog_asset'; sha256: string }

export interface AtumStoreOfferWire {
  billing_interval?: 'one_time' | 'month'
  id: string
  version: number
  price_protons: number
}

export interface AtumStoreItemHashWire {
  sha256: string
  hermes_release: string | null
}

export interface AtumStoreItemDetailWire {
  description: Record<string, string>
  try_prompt: Record<string, string>
  needs: string[]
}

export interface AtumStoreItemWire {
  kind: AtumStoreItemKind
  id: string
  title: Record<string, string>
  summary: Record<string, string>
  detail: AtumStoreItemDetailWire
  glyph: string
  accent: string
  source: AtumStoreItemSource | null
  featured: boolean
  sort_order: number
  offer: AtumStoreOfferWire | null
  hashes: AtumStoreItemHashWire[]
}

export interface AtumStoreEntitlementWire {
  assistant_id: string | null
  assistant_identity_id: string | null
  kind: AtumStoreItemKind
  id: string
  state: 'active' | 'revoked'
  granted_at: string
}

export interface AtumStoreCatalogWire {
  items: AtumStoreItemWire[]
  entitlements: AtumStoreEntitlementWire[]
  available_protons: number
  /**
   * What the signed envelope claims as catalog-owned, identifier only. The
   * listed catalog carries only listed items; the signed set carries every
   * state, so this is the only way a shelf can tell a free bundled pet from a
   * *delisted paid* one (re-review 2026-09-12). Absent on a catalog read from
   * an older main.
   */
  catalog_owned?: { kind: string; identifier: string; delivery: 'cloud' | 'local' }[]
}

export interface AtumStorePurchaseRecordWire {
  assistant_id: string | null
  id: string
  offer_id: string
  offer_version: number
  kind: AtumStoreItemKind
  item_id: string
  amount_protons: number
  status: 'completed' | 'refunded'
  created_at: string
  refunded_at: string | null
}

export type AtumStorePurchaseWire =
  | {
      outcome: 'completed'
      purchase: AtumStorePurchaseRecordWire
      entitlement: AtumStoreEntitlementWire
      wallet: { available_protons: number } | null
    }
  | { outcome: 'already_owned'; purchase: null; entitlement: AtumStoreEntitlementWire }
  /** The confirmed offer lost a race; the carried offer is authoritative and nothing was charged. */
  | { outcome: 'offer_changed'; offer: AtumStoreOfferWire }
  | { outcome: 'refunded'; purchase: AtumStorePurchaseRecordWire; entitlement: AtumStoreEntitlementWire | null }

export interface AtumTrainingTask {
  task_id: string
  assistant_id: string
  assistant_identity_id: string
  conversation_id: string
  skill_id: string
}

export interface AtumStorePurchaseStatusWire {
  purchase: AtumStorePurchaseRecordWire
  entitlement: AtumStoreEntitlementWire | null
}

/** The offer as the renderer uses it — the id and version the person confirms
 *  are what the purchase request carries back, verbatim. */
export interface AtumStoreOffer {
  id: string
  version: number
  priceProtons: number
}

export function projectOffer(offer: AtumStoreOfferWire | null): AtumStoreOffer | null {
  return offer ? { id: offer.id, version: offer.version, priceProtons: offer.price_protons } : null
}

/**
 * The price of a listed item is its offer's price. No active offer means the
 * item cannot be acquired at all — `unavailable`, never free. An offer at 0
 * Protons is a free acquisition: it still goes through the purchase path and
 * still writes an entitlement, so whoever acquired it while free keeps it.
 */
export function priceForOffer(offer: AtumStoreOffer | null): AtumPrice {
  if (!offer) {return UNAVAILABLE}

  return offer.priceProtons === 0 ? FREE : { kind: 'protons', amount: offer.priceProtons }
}

/** The viewer's locale when the row carries it, then en (the app's own
 *  fallback), then vi (guaranteed present — the final fallback). */
export function storeCopy(copy: Record<string, string>, locale: string): string {
  return copy[locale] ?? copy.en ?? copy.vi ?? ''
}

/** `${kind}/${id}` for every ACTIVE entitlement — the whole meaning of Owned. */
export function ownedStoreKeys(catalog: AtumStoreCatalogWire | null): ReadonlySet<string> {
  const owned = new Set<string>()

  for (const entitlement of catalog?.entitlements ?? []) {
    if (entitlement.state === 'active') {
      if (entitlement.kind !== 'skill') { owned.add(`${entitlement.kind}/${entitlement.id}`) }
    }
  }

  return owned
}

export function isStoreItemOwned(catalog: AtumStoreCatalogWire | null, kind: AtumStoreItemKind, id: string, assistantId: string | null = null): boolean {
  if (kind === 'skill') {
    return Boolean(assistantId && catalog?.entitlements.some(entry => entry.kind === kind && entry.id === id && entry.state === 'active' && entry.assistant_id === assistantId))
  }

  return ownedStoreKeys(catalog).has(`${kind}/${id}`)
}

/**
 * What this build can actually deliver (plan decision 11: fulfilability is a
 * local check, not a version gate). A listed item the app cannot fulfil is
 * hidden rather than sold and followed by an update prompt.
 *
 * A `null` capability set means "not probed yet" — the item stays visible
 * rather than blanking the shelf while the probe is still out; a KNOWN
 * absence (a successful probe that does not list it) hides the row.
 */
export interface StoreFulfilmentCaps {
  /** Identifiers the bundled Hermes' skills hub actually resolves locally. */
  skillIdentifiers: ReadonlySet<string> | null
  /** Pet slugs this build ships (the gateway gallery's `bundled` rows). */
  bundledPetSlugs: ReadonlySet<string> | null
}

const FULFILMENT: Record<string, (source: AtumStoreItemSource, caps: StoreFulfilmentCaps) => boolean> = {
  'skill:cloud_skill': () => true,
  'agent:cloud_agent': () => true,
  'skill:hermes_optional': (source, caps) =>
    source.type === 'hermes_optional' && (caps.skillIdentifiers === null || caps.skillIdentifiers.has(source.identifier)),
  // Catalog-delivered bytes are a later slice; this build cannot fetch them.
  'skill:catalog_bundle': () => false,
  'pet:bundled': (source, caps) =>
    source.type === 'bundled' && (caps.bundledPetSlugs === null || caps.bundledPetSlugs.has(source.slug)),
  'pet:catalog_asset': () => false
}

export function isStoreItemFulfillable(item: AtumStoreItemWire, caps: StoreFulfilmentCaps): boolean {
  const source = item.source

  // The `agent` kind is a reserved shelf with a null source — nothing to fulfil.
  if (!source) {
    return false
  }

  const check = FULFILMENT[`${item.kind}:${source.type}`]

  // An unknown kind:source pairing is hidden for the same reason: never sell
  // what this build cannot deliver.
  return check ? check(source, caps) : false
}

/**
 * The shelf projection of a catalog skill row: the same field names the old
 * compiled-in constant carried, sourced now from the store's rows. Returns
 * null for a row that is not an `official/…` optional skill — those rows are
 * not installable through the hub adapter and never reach the shelf.
 */
export interface AtumStoreSkillEntry {
  cloudProtected?: boolean
  trainedAssistantIds?: readonly string[]
  id: string
  identifier: string
  name: Record<string, string>
  after: Record<string, string>
  description: Record<string, string>
  tryPrompt: Record<string, string>
  needs: readonly string[]
  glyph: string
  accent: string
  featured: boolean
  order: number
  offer: AtumStoreOffer | null
  owned: boolean
  price: AtumPrice
}

export function projectSkillEntry(item: AtumStoreItemWire, owned: boolean): AtumStoreSkillEntry | null {
  if (item.kind !== 'skill' || (item.source?.type !== 'hermes_optional' && item.source?.type !== 'cloud_skill')) {
    return null
  }

  const offer = projectOffer(item.offer)

  return {
    id: item.id,
    identifier: item.source.type === 'cloud_skill' ? `cloud/${item.id}` : item.source.identifier,
    cloudProtected: item.source.type === 'cloud_skill',
    name: item.title,
    after: item.summary,
    description: item.detail.description,
    tryPrompt: item.detail.try_prompt,
    needs: item.detail.needs,
    glyph: item.glyph,
    accent: item.accent,
    featured: item.featured,
    order: item.sort_order,
    offer,
    owned,
    price: priceForOffer(offer)
  }
}

/** The name the hub installs an `official/…` skill under — its last segment. */
export function storeSkillLockName(identifier: string): string {
  return identifier.split('/').filter(Boolean).at(-1) ?? identifier
}
