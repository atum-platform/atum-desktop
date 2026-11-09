import type {
  MatrixStoreEntitlement,
  MatrixStoreGrantSource,
  MatrixStoreInstall,
  MatrixStoreIntent,
  MatrixStoreItem,
  MatrixStoreKind,
  MatrixStoreOffer,
  MatrixStoreOwnership,
  MatrixStorePurchase,
  MatrixStoreResult
} from './matrix-store'

export const storeUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v)
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

const text = (v: unknown, max = 200): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= max &&
  !Array.from(v).some(c => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0)))

const time = (v: unknown): v is string => text(v, 40) && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v))
// New ownership metadata follows the frozen pack's timestamp spelling. Keep the
// existing date decoder for legacy response fields unchanged.
const ownershipTime = (v: unknown): v is string =>
  time(v) &&
  /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]([.][0-9]{1,6})?(Z|[+-][0-2][0-9]:[0-5][0-9])$/.test(
    v
  )
const kind = (v: unknown) => v === 'skill' || v === 'agent' || v === 'pet'
const delivery = (v: unknown) => v === 'cloud' || v === 'bundled'
const grantSource = (v: unknown): v is MatrixStoreGrantSource =>
  v === 'purchase' || v === 'gift' || v === 'compensation' || v === 'promo'

function invalid(): never {
  throw new Error('matrix_store_invalid')
}

/** The complete frozen v1.1 variants, with scope checked against their item. */
export function storeOwnership(v: unknown, itemKind: MatrixStoreKind): MatrixStoreOwnership {
  if (
    !object(v) ||
    Object.keys(v).length !== 4 ||
    !['state', 'source', 'assistantIds', 'until'].every(key => Object.hasOwn(v, key)) ||
    !Array.isArray(v.assistantIds) ||
    v.assistantIds.length > 1000 ||
    !v.assistantIds.every(storeUuid) ||
    new Set(v.assistantIds).size !== v.assistantIds.length
  ) {
    invalid()
  }

  if (v.state === 'owned') {
    const until = v.until
    if (
      !grantSource(v.source) ||
      !(until === null || ownershipTime(until)) ||
      (itemKind === 'pet' ? v.assistantIds.length !== 0 : v.assistantIds.length === 0)
    ) {
      invalid()
    }
    return { state: 'owned', source: v.source, assistantIds: [...v.assistantIds], until: until as string | null }
  }

  if (v.state === 'visiting') {
    if (itemKind !== 'pet' || v.source !== 'visit' || v.assistantIds.length !== 0 || !ownershipTime(v.until)) {
      invalid()
    }
    return { state: 'visiting', source: 'visit', assistantIds: [], until: v.until }
  }

  if (v.state !== 'available' || v.source !== null || v.assistantIds.length !== 0 || v.until !== null) {
    invalid()
  }
  return { state: 'available', source: null, assistantIds: [], until: null }
}

function copy(v: unknown): Record<string, string> {
  if (!object(v) || !text(v.vi, 12000) || Object.keys(v).length > 10) {
    invalid()
  }
  const r: Record<string, string> = {}

  for (const [k, value] of Object.entries(v)) {
    if (!/^[a-z]{2}(?:-[A-Za-z]{2})?$/.test(k) || !text(value, 12000)) {
      invalid()
    }
    r[k] = value
  }

  return r
}

/** Store copy for a window locale. The Store takes keys like `zh-TW` but refuses `zh-Hant`, so
 * Traditional Chinese copy is filed under `zh-TW` and found from the window's `zh-hant`. */
export function localizedStoreCopy(value: Record<string, string>, locale: string): string {
  const normalized = locale.toLowerCase()

  if (normalized === 'zh-hant') {
    return value['zh-hant'] ?? value['zh-Hant'] ?? value['zh-TW'] ?? value.en ?? value.vi ?? ''
  }

  return value[locale] ?? value[normalized] ?? value.en ?? value.vi ?? ''
}

export function storeIntent(v: unknown): MatrixStoreIntent {
  if (
    !object(v) ||
    Object.keys(v).some(k => !['offerId', 'offerVersion', 'assistantId', 'consentRenewal'].includes(k)) ||
    !storeUuid(v.offerId) ||
    !count(v.offerVersion) ||
    v.offerVersion === 0 ||
    (v.assistantId !== undefined && !storeUuid(v.assistantId)) ||
    (v.consentRenewal !== undefined && v.consentRenewal !== true)
  ) {
    invalid()
  }

  return {
    offerId: v.offerId,
    offerVersion: v.offerVersion,
    ...(v.assistantId ? { assistantId: v.assistantId as string } : {}),
    ...(v.consentRenewal ? { consentRenewal: true as const } : {})
  }
}

export function storeOffer(v: unknown): MatrixStoreOffer {
  if (
    !object(v) ||
    !storeUuid(v.id) ||
    !count(v.version) ||
    v.version === 0 ||
    !count(v.priceMicroProtons) ||
    !['account', 'agent'].includes(v.scope as string) ||
    !['one_time', 'month'].includes(v.billingInterval as string) ||
    !delivery(v.delivery)
  ) {
    invalid()
  }

  if (
    (v.billingInterval === 'month' && !count(v.renewalPriceMicroProtons)) ||
    (v.billingInterval === 'one_time' && v.renewalPriceMicroProtons !== undefined)
  ) {
    invalid()
  }

  return {
    id: v.id,
    version: v.version,
    priceMicroProtons: v.priceMicroProtons,
    scope: v.scope as MatrixStoreOffer['scope'],
    billingInterval: v.billingInterval as MatrixStoreOffer['billingInterval'],
    delivery: v.delivery as MatrixStoreOffer['delivery'],
    ...(v.billingInterval === 'month' ? { renewalPriceMicroProtons: v.renewalPriceMicroProtons as number } : {})
  }
}

/** The frozen v1.1 `install` shape: exactly a source and an official Hub identifier. */
function storeInstall(v: unknown): MatrixStoreInstall | undefined {
  return object(v) &&
    Object.keys(v).length === 2 &&
    v.source === 'hermes_hub' &&
    text(v.id, 200) &&
    /^official\/[a-z0-9_-]+\/[a-z0-9_-]+$/.test(v.id)
    ? { source: 'hermes_hub', id: v.id }
    : undefined
}

/** A row's Hub install, when it is one this desktop can hand to the Skills Hub: a free skill
 * whose item ID names the same identifier. `null` (the Marketplace's "none") is no install. */
function hubInstall(v: Record<string, unknown>): MatrixStoreInstall | undefined | false {
  if (v.install === undefined || v.install === null) {
    return undefined
  }

  const install = storeInstall(v.install)

  return install && v.kind === 'skill' && v.offer === null && v.itemId === `skill/${install.id}` ? install : false
}

export function storeItem(v: unknown): MatrixStoreItem {
  if (
    !object(v) ||
    !text(v.itemId, 128) ||
    !/^(skill|agent|pet)\/[a-z0-9][a-z0-9_/-]{0,119}$/.test(v.itemId) ||
    !kind(v.kind) ||
    !v.itemId.startsWith(`${v.kind}/`) ||
    !Array.isArray(v.needs) ||
    v.needs.length > 20 ||
    !v.needs.every(n => text(n, 128)) ||
    !text(v.glyph, 8) ||
    !text(v.accent, 7) ||
    !/^#[a-f0-9]{6}$/i.test(v.accent) ||
    typeof v.featured !== 'boolean' ||
    !count(v.sortOrder) ||
    Object.hasOwn(v, 'requires') ||
    (Object.hasOwn(v, 'deliverable') && typeof v.deliverable !== 'boolean')
  ) {
    invalid()
  }

  const install = hubInstall(v)

  if (install === false) {
    invalid()
  }

  return {
    itemId: v.itemId,
    kind: v.kind as MatrixStoreItem['kind'],
    title: copy(v.title),
    summary: copy(v.summary),
    description: copy(v.description),
    tryPrompt: copy(v.tryPrompt),
    needs: v.needs as string[],
    glyph: v.glyph,
    accent: v.accent,
    featured: v.featured,
    sortOrder: v.sortOrder,
    offer: v.offer === null ? null : storeOffer(v.offer),
    ...(Object.hasOwn(v, 'ownership') ? { ownership: storeOwnership(v.ownership, v.kind as MatrixStoreKind) } : {}),
    ...(typeof v.deliverable === 'boolean' ? { deliverable: v.deliverable } : {}),
    ...(install ? { install } : {})
  }
}

/**
 * The catalog response. A row offering a Hub install this desktop cannot perform (another
 * source, a malformed identifier, a priced or non-skill row) is left out, so one row the
 * desktop cannot use never blanks the Store. Every other malformed row still rejects the
 * whole response, as the frozen pack pins (`catalog-one-bad-row`).
 */
export function storeCatalog(v: unknown): MatrixStoreItem[] {
  return storeList(v, 'items', entry => entry).flatMap(entry =>
    object(entry) && hubInstall(entry) === false ? [] : [storeItem(entry)]
  )
}

export function storeEntitlement(v: unknown): MatrixStoreEntitlement {
  if (
    !object(v) ||
    !storeUuid(v.id) ||
    !text(v.itemId, 128) ||
    !kind(v.kind) ||
    !/^(skill|agent|pet)\/[a-z0-9][a-z0-9_/-]{0,119}$/.test(v.itemId) ||
    !v.itemId.startsWith(`${v.kind}/`) ||
    !['active', 'revoked'].includes(v.state as string) ||
    !(v.assistantId === null || storeUuid(v.assistantId)) ||
    !delivery(v.delivery) ||
    !time(v.grantedAt) ||
    (Object.hasOwn(v, 'source') && !grantSource(v.source))
  ) {
    invalid()
  }

  if (v.kind === 'pet' ? v.assistantId !== null : !storeUuid(v.assistantId)) {
    invalid()
  }
  let subscription: MatrixStoreEntitlement['subscription'] = null

  if (v.subscription !== null) {
    const s = v.subscription

    if (
      !object(s) ||
      !['active', 'cancelled', 'lapsed'].includes(s.state as string) ||
      !time(s.renewAt) ||
      !count(s.priceMicroProtons) ||
      !count(s.offerVersion) ||
      s.offerVersion === 0
    ) {
      invalid()
    }

    subscription = {
      state: s.state as 'active' | 'cancelled' | 'lapsed',
      renewAt: s.renewAt,
      priceMicroProtons: s.priceMicroProtons,
      offerVersion: s.offerVersion
    }
  }

  if ((v.kind === 'agent') !== (subscription !== null)) {
    invalid()
  }

  return {
    id: v.id,
    itemId: v.itemId,
    kind: v.kind as MatrixStoreEntitlement['kind'],
    state: v.state as MatrixStoreEntitlement['state'],
    assistantId: v.assistantId as string | null,
    delivery: v.delivery as MatrixStoreEntitlement['delivery'],
    grantedAt: v.grantedAt,
    subscription,
    ...(grantSource(v.source) ? { source: v.source } : {})
  }
}

export function storePurchase(v: unknown): MatrixStorePurchase {
  if (
    !object(v) ||
    !storeUuid(v.id) ||
    !['delivery_pending', 'granted', 'completed', 'reversed'].includes(v.state as string) ||
    !text(v.itemId, 128) ||
    !storeUuid(v.offerId) ||
    !count(v.offerVersion) ||
    v.offerVersion === 0 ||
    !storeUuid(v.idempotencyKey) ||
    !(v.assistantId === null || storeUuid(v.assistantId)) ||
    !count(v.amountMicroProtons) ||
    !time(v.createdAt)
  ) {
    invalid()
  }

  return {
    id: v.id,
    state: v.state as MatrixStorePurchase['state'],
    itemId: v.itemId,
    offerId: v.offerId,
    offerVersion: v.offerVersion,
    idempotencyKey: v.idempotencyKey,
    assistantId: v.assistantId as string | null,
    amountMicroProtons: v.amountMicroProtons,
    createdAt: v.createdAt
  }
}

export function storeResult(v: unknown): MatrixStoreResult {
  if (!object(v)) {
    invalid()
  }

  if (v.outcome === 'offer_changed') {
    return { outcome: v.outcome, offer: storeOffer(v.offer) }
  }

  if (
    v.outcome === 'refused' &&
    ['insufficient_protons', 'offer_unavailable', 'feature_unavailable', 'forbidden', 'pet_credit_reserved'].includes(
      v.code as string
    )
  ) {
    return {
      outcome: v.outcome,
      code: v.code as
        | 'insufficient_protons'
        | 'offer_unavailable'
        | 'feature_unavailable'
        | 'forbidden'
        | 'pet_credit_reserved'
    }
  }

  if (v.outcome === 'already_owned' && v.purchase === null) {
    return { outcome: v.outcome, purchase: null, entitlement: storeEntitlement(v.entitlement) }
  }

  if (v.outcome === 'purchased') {
    const purchase = storePurchase(v.purchase)
    const entitlement = v.entitlement === null ? null : storeEntitlement(v.entitlement)

    if ((purchase.state === 'completed' || purchase.state === 'granted') && !entitlement) {
      invalid()
    }

    if (entitlement && (entitlement.itemId !== purchase.itemId || entitlement.assistantId !== purchase.assistantId)) {
      invalid()
    }

    return { outcome: v.outcome, purchase, entitlement }
  }

  invalid()
}

export function storeList<T>(v: unknown, key: string, parse: (entry: unknown) => T): T[] {
  if (!object(v) || !Array.isArray(v[key]) || (v[key] as unknown[]).length > 1000) {
    invalid()
  }

  return (v[key] as unknown[]).map(parse)
}
