import {
  MATRIX_EFFORTS,
  type MatrixEffort,
  type MatrixModelRoute,
  parseMatrixModelRouteId
} from '../../shared/matrix-models'

/**
 * Favorites and recents are presentation preferences, not authority. They are scoped to the
 * human account and this device by their storage key, grant nothing, and never travel through
 * provider auth. Route ids stay stable across catalog generations; a route that is not in the
 * current catalog simply is not shown, without deleting the star that a temporarily signed-out
 * account will need again.
 */
export interface MatrixModelPickerPreferences {
  favorites: string[]
  recent: string[]
}

export const MATRIX_MODEL_FAVORITES_MAX = 200
export const MATRIX_MODEL_RECENT_MAX = 8

const EMPTY: MatrixModelPickerPreferences = { favorites: [], recent: [] }

export type MatrixModelPickerFacet = 'all' | 'favorites'

function ids(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return [
    ...new Set(value.filter((id): id is string => typeof id === 'string' && Boolean(parseMatrixModelRouteId(id))))
  ].slice(0, max)
}

function storageKey(scope: string): string {
  return `atum.model-picker.v1:${encodeURIComponent(scope || 'local')}`
}

export function readMatrixModelPickerPreferences(
  storage: Pick<Storage, 'getItem'> | undefined,
  scope: string
): MatrixModelPickerPreferences {
  try {
    const raw = storage?.getItem(storageKey(scope))

    if (!raw) {
      return EMPTY
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>

    return {
      favorites: ids(parsed?.favorites, MATRIX_MODEL_FAVORITES_MAX),
      recent: ids(parsed?.recent, MATRIX_MODEL_RECENT_MAX)
    }
  } catch {
    return EMPTY
  }
}

export function writeMatrixModelPickerPreferences(
  storage: Pick<Storage, 'setItem'> | undefined,
  scope: string,
  preferences: MatrixModelPickerPreferences
): void {
  try {
    storage?.setItem(
      storageKey(scope),
      JSON.stringify({ favorites: preferences.favorites, recent: preferences.recent })
    )
  } catch {
    // A full or private storage is not a reason to lose the model picker.
  }
}

export function matrixModelFavoriteToggle(
  preferences: MatrixModelPickerPreferences,
  routeId: string
): MatrixModelPickerPreferences {
  const favorites = preferences.favorites.includes(routeId)
    ? preferences.favorites.filter(id => id !== routeId)
    : [routeId, ...preferences.favorites].slice(0, MATRIX_MODEL_FAVORITES_MAX)

  return { ...preferences, favorites }
}

export function matrixModelRecentAdd(
  preferences: MatrixModelPickerPreferences,
  routeId: string
): MatrixModelPickerPreferences {
  return {
    ...preferences,
    recent: [routeId, ...preferences.recent.filter(id => id !== routeId)].slice(0, MATRIX_MODEL_RECENT_MAX)
  }
}

/** Accent-insensitive search across the model, provider and safe account label. */
export function matrixModelRouteSearchText(route: MatrixModelRoute): string {
  return [route.model, route.name, route.providerLabel, route.accountLabel]
    .join(' ')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
}

export function matrixModelRouteMatches(route: MatrixModelRoute, query: string): boolean {
  const phrase = query.trim()

  if (!phrase) {
    return true
  }

  const haystack = matrixModelRouteSearchText(route)
  const needle = phrase.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()

  return needle.split(/\s+/u).every(part => haystack.includes(part))
}

/** The routes one rail view shows: current first in All, favorites in star order. */
export function matrixModelRoutesForFacet(
  routes: readonly MatrixModelRoute[],
  facet: MatrixModelPickerFacet,
  preferences: MatrixModelPickerPreferences
): MatrixModelRoute[] {
  const byId = new Map(routes.map(route => [route.id, route]))

  if (facet === 'favorites') {
    return preferences.favorites.flatMap(id => {
      const route = byId.get(id)

      return route ? [route] : []
    })
  }

  return [...routes].sort((left, right) => Number(right.current) - Number(left.current))
}

/**
 * A saved thinking level the new model does not advertise must not silently look active.
 * Prefer Balanced when it is offered, else the quietest advertised level.
 */
export function matrixModelEffortReconciliation(
  efforts: readonly MatrixEffort[],
  chosen: MatrixEffort | undefined
): { supported: boolean; suggested?: MatrixEffort } {
  if (chosen === undefined) {
    return { supported: true }
  }

  if (efforts.includes(chosen)) {
    return { supported: true }
  }

  const suggested = MATRIX_EFFORTS.find(level => efforts.includes(level)) ?? efforts[0]

  return { supported: false, ...(suggested ? { suggested } : {}) }
}
