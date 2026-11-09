import { storeListingLink } from './discovery-links'
import type {
  MatrixStoreInstall,
  MatrixStoreItem,
  MatrixStoreKind,
  MatrixStoreOffer,
  MatrixStoreOwnership,
  MatrixStoreSnapshot
} from './matrix-store'
import { localizedStoreCopy as localized, storeItem } from './matrix-store-contract'

/**
 * The deliberately small, read-only Store view an agent may receive. It is a
 * projection of the canonical Matrix catalog, not an acquisition API.
 *
 * Store is a Discover rail destination in the desktop rather than a URL route.
 * The Matrix Markdown host opens an exact listing through the existing Discover UI.
 */
export interface AtumStoreDiscoveryDestination {
  surface: 'discover'
  shelf: 'agents' | 'skills' | 'pets'
  itemId: string
}

export interface AtumStoreDiscoveryItem {
  itemId: string
  kind: MatrixStoreKind
  title: string
  summary: string
  description: string
  needs: string[]
  offer: MatrixStoreOffer | null
  ownership?: MatrixStoreOwnership
  install?: MatrixStoreInstall
  deliverable?: boolean
  destination: AtumStoreDiscoveryDestination
  listingLink: string
}

export interface AtumStoreDiscoveryRequest {
  /** Matches localized title, summary, and description case-insensitively. */
  query?: string
  /** One kind narrows both browsing and exact inspection. */
  kind?: MatrixStoreKind
  /** An exact catalog ID for inspection. */
  itemId?: string
  /** Bounded page size. Defaults to 10. */
  limit?: number
}

export interface AtumStoreDiscoverySuccess {
  outcome: 'ok'
  items: AtumStoreDiscoveryItem[]
  totalMatches: number
  hasMore: boolean
}

export interface AtumStoreDiscoveryFailure {
  outcome: 'error'
  code: 'invalid_request' | 'invalid_catalog' | 'catalog_unavailable'
  message: string
}

export type AtumStoreDiscoveryResult = AtumStoreDiscoverySuccess | AtumStoreDiscoveryFailure

const MAX_QUERY_LENGTH = 200
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 20
const STORE_KINDS = new Set<MatrixStoreKind>(['skill', 'agent', 'pet'])

type StoreCatalog = Pick<MatrixStoreSnapshot, 'state' | 'items'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStoreItem(value: unknown): value is MatrixStoreItem {
  try { storeItem(value); return true } catch { return false }
}

function isStoreCatalog(value: unknown): value is StoreCatalog {
  return (
    isRecord(value) &&
    (value.state === 'loading' ||
      value.state === 'ready' ||
      value.state === 'stale' ||
      value.state === 'unavailable') &&
    Array.isArray(value.items) &&
    value.items.every(isStoreItem)
  )
}

function error(code: AtumStoreDiscoveryFailure['code'], message: string): AtumStoreDiscoveryFailure {
  return { outcome: 'error', code, message }
}

export function parseAtumStoreDiscoveryRequest(
  value: unknown
): (AtumStoreDiscoveryRequest & { limit: number }) | AtumStoreDiscoveryFailure {
  if (value === undefined) {
    return { limit: DEFAULT_LIMIT }
  }
  if (!isRecord(value)) {
    return error('invalid_request', 'Store discovery input must be an object.')
  }

  const { query, kind, itemId, limit } = value
  if (query !== undefined && (typeof query !== 'string' || query.length > MAX_QUERY_LENGTH)) {
    return error('invalid_request', `query must be a string of at most ${MAX_QUERY_LENGTH} characters.`)
  }
  if (kind !== undefined && (typeof kind !== 'string' || !STORE_KINDS.has(kind as MatrixStoreKind))) {
    return error('invalid_request', 'kind must be skill, agent, or pet.')
  }
  if (itemId !== undefined && (typeof itemId !== 'string' || !itemId.trim())) {
    return error('invalid_request', 'itemId must be a non-empty exact Store item ID.')
  }
  if (
    limit !== undefined &&
    (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
  ) {
    return error('invalid_request', `limit must be an integer from 1 through ${MAX_LIMIT}.`)
  }

  return {
    ...(query === undefined ? {} : { query: query as string }),
    ...(kind === undefined ? {} : { kind: kind as MatrixStoreKind }),
    ...(itemId === undefined ? {} : { itemId: itemId as string }),
    limit: (limit as number | undefined) ?? DEFAULT_LIMIT
  }
}

/** Matches the Storefront's search treatment of Vietnamese text. */
function normalized(value: string, locale: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase(locale)
    .replace(/đ/gu, 'd')
    .trim()
    .replace(/\s+/gu, ' ')
}

function shelfFor(kind: MatrixStoreKind): AtumStoreDiscoveryDestination['shelf'] {
  return kind === 'agent' ? 'agents' : kind === 'skill' ? 'skills' : 'pets'
}

function project(item: MatrixStoreItem, locale: string): AtumStoreDiscoveryItem {
  return {
    itemId: item.itemId,
    kind: item.kind,
    title: localized(item.title, locale),
    summary: localized(item.summary, locale),
    description: localized(item.description, locale),
    needs: [...item.needs],
    offer: item.offer === null ? null : { ...item.offer },
    ...(item.ownership === undefined
      ? {}
      : {
          ownership:
            item.ownership.state === 'owned'
              ? { ...item.ownership, assistantIds: [...item.ownership.assistantIds] }
              : { ...item.ownership, assistantIds: [] }
        }),
    ...(item.install === undefined ? {} : { install: { ...item.install } }),
    ...(item.deliverable === undefined ? {} : { deliverable: item.deliverable }),
    destination: { surface: 'discover', shelf: shelfFor(item.kind), itemId: item.itemId },
    listingLink: storeListingLink(item.itemId)
  }
}

/**
 * Projects one bounded page from a public Store snapshot. This function never
 * spends, installs, or changes the catalog; callers must route acquisition
 * through the existing consented Store flow.
 */
export function queryStoreCatalog(
  items: readonly MatrixStoreItem[],
  input: unknown = undefined,
  locale = 'en'
): AtumStoreDiscoveryResult {
  const parsed = parseAtumStoreDiscoveryRequest(input)
  if ('outcome' in parsed) {
    return parsed
  }
  if (!Array.isArray(items) || !items.every(isStoreItem)) {
    return error('invalid_catalog', 'Store catalog is malformed.')
  }

  const query = normalized(parsed.query ?? '', locale)
  const matches = items
    .filter(item => {
      if (parsed.itemId !== undefined && item.itemId !== parsed.itemId) {
        return false
      }
      if (parsed.kind !== undefined && item.kind !== parsed.kind) {
        return false
      }
      if (!query) {
        return true
      }

      const searchableText = normalized(
        [item.title, item.summary, item.description].flatMap(copy => Object.values(copy)).join(' '),
        locale
      )

      return searchableText.includes(query)
    })
    .sort((left, right) => left.sortOrder - right.sortOrder || left.itemId.localeCompare(right.itemId))

  return {
    outcome: 'ok',
    items: matches.slice(0, parsed.limit).map(item => project(item, locale)),
    totalMatches: matches.length,
    hasMore: matches.length > parsed.limit
  }
}

/**
 * Same projection when the caller holds the complete Store snapshot. A loading
 * or unavailable snapshot is reported honestly rather than as an empty Store.
 */
export function discoverAtumStore(
  catalog: unknown,
  input: unknown = undefined,
  locale = 'en'
): AtumStoreDiscoveryResult {
  if (!isStoreCatalog(catalog)) {
    return error('invalid_catalog', 'Store catalog is malformed.')
  }
  if (catalog.state !== 'ready' && catalog.state !== 'stale') {
    return error('catalog_unavailable', 'Store catalog is not available right now.')
  }

  return queryStoreCatalog(catalog.items, input, locale)
}
