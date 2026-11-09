import { atom } from 'nanostores'

/** Presentation only. Domain permissions and admission remain with their owners. */
export const SURFACE_IDS = ['home', 'drive', 'discover', 'teamSpace'] as const
export type SurfaceId = (typeof SURFACE_IDS)[number]
export type SurfaceState = 'on' | 'needs_setup' | 'coming_soon' | 'needs_update' | 'hidden'

export interface SurfaceEntry {
  id: SurfaceId
  state: SurfaceState
  reason?: 'not_for_platform' | 'retired'
  minClient?: string
}

export type SurfaceSet = Readonly<Record<SurfaceId, SurfaceEntry>>

export interface SurfaceProjection {
  profile: string | null
  places: SurfaceSet
}

interface SurfaceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const DEFAULT_SURFACES: SurfaceSet = {
  home: { id: 'home', state: 'on' },
  drive: { id: 'drive', state: 'on' },
  discover: { id: 'discover', state: 'coming_soon' },
  teamSpace: { id: 'teamSpace', state: 'coming_soon' }
}

const STATES: SurfaceState[] = ['on', 'needs_setup', 'coming_soon', 'needs_update', 'hidden']
const STORAGE_PREFIX = 'hermes.desktop.atum.surfaces.profile.v1:'

/** Only a complete, explicit set may replace the last usable rail. */
export function parseSurfaceSet(value: unknown): SurfaceSet | null {
  if (!Array.isArray(value) || value.length !== SURFACE_IDS.length) {
    return null
  }

  const entries = new Map<SurfaceId, SurfaceEntry>()

  for (const row of value) {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      !SURFACE_IDS.includes(row.id) ||
      !STATES.includes(row.state) ||
      entries.has(row.id) ||
      Object.keys(row).some(key => !['id', 'state', 'reason', 'minClient'].includes(key))
    ) {
      return null
    }

    if (row.state === 'hidden' ? !['not_for_platform', 'retired'].includes(row.reason) : row.reason !== undefined) {
      return null
    }

    if (
      row.minClient !== undefined &&
      (typeof row.minClient !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(row.minClient))
    ) {
      return null
    }

    entries.set(row.id, {
      id: row.id,
      state: row.state,
      ...(row.reason === undefined ? {} : { reason: row.reason }),
      ...(row.minClient === undefined ? {} : { minClient: row.minClient })
    })
  }

  if (![...entries.values()].some(row => row.state !== 'hidden')) {
    return null
  }

  return Object.fromEntries(SURFACE_IDS.map(id => [id, entries.get(id)!])) as SurfaceSet
}

export const $surfaces = atom<SurfaceProjection>({ profile: null, places: DEFAULT_SURFACES })
let storage: SurfaceStorage | undefined

function browserStorage(): SurfaceStorage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export function activateSurfaceProfile(profile: string | null, cache = browserStorage()): void {
  if ($surfaces.get().profile === profile) {
    return
  }

  storage = cache
  let places = DEFAULT_SURFACES

  if (profile) {
    try {
      const saved = storage?.getItem(STORAGE_PREFIX + encodeURIComponent(profile))
      places = saved ? (parseSurfaceSet(JSON.parse(saved)) ?? places) : places
    } catch {
      /* Cache failure leaves a complete, usable rail. */
    }
  }

  $surfaces.set({ profile, places })
}

/** A late response from another profile, a failed read or an empty set changes nothing. */
export function applySurfaceSource(profile: string, value: unknown): boolean {
  const current = $surfaces.get()

  if (current.profile !== profile) {
    return false
  }

  const places = parseSurfaceSet(value)

  if (!places) {
    return false
  }

  if (JSON.stringify(current.places) === JSON.stringify(places)) {
    return true
  }

  $surfaces.set({ profile, places })

  try {
    storage?.setItem(STORAGE_PREFIX + encodeURIComponent(profile), JSON.stringify(Object.values(places)))
  } catch {
    /* Keep the in-memory truth when persistence is unavailable. */
  }

  return true
}

export function surfacesForProfile(profile: string | null, projection = $surfaces.get()): SurfaceSet {
  return projection.profile === profile ? projection.places : DEFAULT_SURFACES
}
