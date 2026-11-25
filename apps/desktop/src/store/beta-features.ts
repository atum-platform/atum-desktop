import { atom } from 'nanostores'

/**
 * Beta features for the active signed-in profile (shared/beta-features.ts): Team Space, hires and
 * skill purchases. Presentation only; the platform still decides every request.
 *
 * Unknown is "not beta". A read that fails keeps the profile's last answer, so a beta account is
 * not greyed out by one missed read once the platform has named it.
 */
export interface BetaFeaturesProjection {
  profile: string | null
  granted: boolean
}

interface BetaStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const STORAGE_PREFIX = 'hermes.desktop.atum.beta.profile.v1:'

export const $betaFeatures = atom<BetaFeaturesProjection>({ profile: null, granted: false })
let storage: BetaStorage | undefined

function browserStorage(): BetaStorage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export function activateBetaFeaturesProfile(profile: string | null, cache = browserStorage()): void {
  if ($betaFeatures.get().profile === profile) {
    return
  }

  storage = cache
  let granted = false

  if (profile) {
    try {
      granted = storage?.getItem(STORAGE_PREFIX + encodeURIComponent(profile)) === 'true'
    } catch {
      /* No cache: not beta until the platform says so. */
    }
  }

  $betaFeatures.set({ profile, granted })
}

/** A late answer for another profile, or one that could not be read (null), changes nothing. */
export function applyBetaFeatures(profile: string, granted: boolean | null): boolean {
  const current = $betaFeatures.get()

  if (current.profile !== profile || typeof granted !== 'boolean') {
    return false
  }

  if (current.granted !== granted) {
    $betaFeatures.set({ profile, granted })
  }

  try {
    storage?.setItem(STORAGE_PREFIX + encodeURIComponent(profile), String(granted))
  } catch {
    /* Keep the in-memory answer when persistence is unavailable. */
  }

  return true
}

export function betaFeaturesFor(profile: string | null, projection = $betaFeatures.get()): boolean {
  return Boolean(profile) && projection.profile === profile && projection.granted
}
