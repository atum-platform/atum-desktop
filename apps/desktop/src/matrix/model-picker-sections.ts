import type { MatrixModelRoute } from '../../shared/matrix-models'

import { matrixModelRouteMatches, matrixModelRoutesForFacet } from './model-picker-preferences'

/**
 * What the model card shows, as data. The 2026-10-26 UI is one flat list filtered by a source
 * rail; these buckets preserve deterministic Atum/favorite/provider ordering before the renderer
 * flattens them. A model lives in exactly one bucket. Nothing here knows about React or the bridge.
 */

/**
 * Badges drawn beside a model's name. Only data the product has: Atum names its default, and no
 * catalog route carries a "Legacy" flag yet, so there is no such badge to draw.
 */
export type PickerBadge = 'default'

/** A row of the card: a model, which connection it answers through, and why it cannot be chosen. */
export interface PickerRoute {
  route: MatrixModelRoute
  note?: 'default' | 'soon'
  disabled?: boolean
  badges?: readonly PickerBadge[]
  /** Atum's own one-line description of the model, from its line-up row. */
  tagline?: 'everyday' | 'hard' | 'flagship'
  /** A subscription model row: its second line names the plan, not the model again. */
  subscription?: boolean
  /** The model's own default level, when it advertises one (a subscription pick). */
  defaultEffort?: MatrixModelRoute['efforts'][number]
  /** Why a listed model cannot be chosen here yet, drawn on its second line. */
  reason?: string
}

/** A provider family: the id every route carries, and its safe display name. */
export interface PickerProvider {
  id: string
  label: string
}

export interface PickerFilter {
  favoritesOnly: boolean
  /** One provider id (Atum's own rows are `atum`); absent shows every connection. */
  source?: string
}

export const NO_PICKER_FILTER: PickerFilter = { favoritesOnly: false }

export interface PickerSection {
  /** Internal ordering key; the renderer does not draw a section header. */
  id: string
  provider?: PickerProvider
  rows: readonly PickerRoute[]
  /** The current selection is one of these rows. */
  current: boolean
  /** A group header, when a caller names one; the rail and each row's provider line group the rest. */
  heading?: string
  /** One short line in a provider's list (ChatGPT signed out, not ready for cloud assistants). The
   * fix is the rail's Connect, never a row in the list. */
  note?: string
}

export const PICKER_DEFAULTS_SECTION = 'defaults'

export function pickerProviderSectionId(provider: string): string {
  return `provider:${provider}`
}

export function pickerFilterActive(filter: PickerFilter): boolean {
  return filter.favoritesOnly || filter.source !== undefined
}

export interface PickerSectionsInput {
  /** Atum's line-up rows, in order; none where Atum is not what answers here. */
  atum: readonly PickerRoute[]
  /** The account subscriptions this Mac-hosted agent may use, by their readable names. */
  subscriptions?: readonly PickerRoute[]
  subscriptionHeading?: string
  /** A quiet explanation when a connected subscription has no selectable model here. */
  subscriptionNote?: string
  /** The provider that note is about: it shows only in that provider's list. */
  subscriptionNoteFor?: string
  /** Every model the Mac's connections list, in the catalog's order. */
  connected: readonly PickerRoute[]
  /** Provider families in rail/list order. */
  providers: readonly PickerProvider[]
  /** Starred route ids, newest first. */
  favorites: readonly string[]
  query: string
  filter: PickerFilter
  /** The route that answers now, per destination; a pick in flight counts. */
  isCurrent: (route: MatrixModelRoute) => boolean
}

/**
 * Internal buckets in flat-list order: Atum's models and stars first, then the optional
 * Subscriptions group, then each provider's remaining models. Search and the active rail filter
 * apply to every bucket. A starred model whose connection is signed out is not listed, and its
 * persisted star waits for it.
 */
export function pickerSections(input: PickerSectionsInput): PickerSection[] {
  const {
    atum,
    connected,
    providers,
    favorites,
    query,
    filter,
    isCurrent,
    subscriptions = [],
    subscriptionHeading,
    subscriptionNote,
    subscriptionNoteFor
  } = input

  const starIds = new Set(favorites)

  const passes = ({ route }: PickerRoute) =>
    (!filter.favoritesOnly || starIds.has(route.id)) &&
    (filter.source === undefined || route.provider === filter.source) &&
    matrixModelRouteMatches(route, query)

  // Subscription rows can also be present in the current-home catalog. Merge by stable route id
  // before building Favorites so starring one never draws the same model once at the top and once
  // again in the Subscriptions group.
  const allConnected = [...connected, ...subscriptions].filter(
    (each, index, rows) => rows.findIndex(candidate => candidate.route.id === each.route.id) === index
  )
  const byId = new Map(allConnected.map(each => [each.route.id, each]))

  // The stars keep their own order (newest first); a route the catalog lacks is not drawn.
  const starred = matrixModelRoutesForFacet(
    allConnected.map(each => each.route),
    'favorites',
    { favorites: [...favorites], recent: [] }
  ).flatMap(route => byId.get(route.id) ?? [])

  const defaults = [...atum, ...starred].filter(passes)

  // A subscription model appears once, in the Subscriptions group, never again under its
  // provider's own section.
  const subscriptionIds = new Set(subscriptions.map(each => each.route.id))
  const subscriptionRows = subscriptions.filter(each => !starIds.has(each.route.id)).filter(passes)

  const others = connected
    .filter(each => !starIds.has(each.route.id) && !subscriptionIds.has(each.route.id))
    .filter(passes)

  // Providers the catalog's accounts did not name still get a section, in first-seen order.
  const known = new Map(providers.map(provider => [provider.id, provider]))

  for (const { route } of others) {
    if (!known.has(route.provider)) {
      known.set(route.provider, { id: route.provider, label: route.providerLabel })
    }
  }

  const sections: PickerSection[] = []

  // Atum's line-up and stars own the first rows (and ⌘1…⌘n), exactly as before account
  // subscriptions existed; the Subscriptions group follows them.
  if (defaults.length) {
    sections.push({
      id: PICKER_DEFAULTS_SECTION,
      rows: defaults,
      current: defaults.some(each => isCurrent(each.route))
    })
  }

  // The note is about one subscription (ChatGPT signed out or not ready yet): it shows in that
  // provider's own list only, never under another provider or in favourites.
  const subscriptionNoteShown =
    subscriptionNote &&
    !filter.favoritesOnly &&
    !query.trim() &&
    (filter.source === undefined || filter.source === (subscriptionNoteFor ?? filter.source))
      ? subscriptionNote
      : undefined

  if (subscriptionRows.length || subscriptionNoteShown) {
    sections.push({
      id: 'subscriptions',
      ...(subscriptionHeading ? { heading: subscriptionHeading } : {}),
      rows: subscriptionRows,
      ...(subscriptionNoteShown ? { note: subscriptionNoteShown } : {}),
      current: subscriptionRows.some(each => isCurrent(each.route))
    })
  }

  for (const provider of known.values()) {
    const rows = others.filter(each => each.route.provider === provider.id)

    if (rows.length) {
      sections.push({
        id: pickerProviderSectionId(provider.id),
        provider,
        rows,
        current: rows.some(each => isCurrent(each.route))
      })
    }
  }

  return sections
}
