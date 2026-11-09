import type { MacCityLocation, MacSourcesResult } from './contract'
import { permissionResult, unavailableResult } from './contract'

interface ExistingOwnerLocation {
  enabled: boolean
  city?: string
  region?: string
  country?: string
}

export interface PreciseMacLocation {
  city: string
  region?: string
  country?: string
  lat: number
  lon: number
  accuracyMeters: number
}

export interface MacLocationProviderDependencies {
  timeZone(): string | undefined
  ownerLocation(signal: AbortSignal): Promise<ExistingOwnerLocation>
  /** Future signed CoreLocation helper. It may prompt only when allowPrompt is true. */
  precise?(signal: AbortSignal, allowPrompt: boolean): Promise<PreciseMacLocation | null>
}

/**
 * City-level understanding reuses the already-shipped platform owner-location record and this
 * Mac's IANA time zone. Precise location is a clean optional port: until the signed helper exists,
 * a precise call returns permission_needed instead of silently widening or inventing coordinates.
 */
export class MacLocationProvider {
  constructor(private readonly dependencies: MacLocationProviderDependencies) {}

  async current(
    precision: 'city' | 'precise',
    signal: AbortSignal,
    allowPrompt: boolean
  ): Promise<MacSourcesResult> {
    signal.throwIfAborted()
    const timeZone = this.dependencies.timeZone()

    if (!timeZone) {
      return unavailableResult()
    }

    if (precision === 'precise') {
      if (!this.dependencies.precise || !allowPrompt) {
        return permissionResult('location')
      }

      try {
        const precise = await this.dependencies.precise(signal, true)
        signal.throwIfAborted()

        return precise ? { ...precise, timeZone } : permissionResult('location')
      } catch {
        signal.throwIfAborted()

        return permissionResult('location')
      }
    }

    try {
      const location = await this.dependencies.ownerLocation(signal)
      signal.throwIfAborted()

      if (!location.enabled) {
        return permissionResult('location')
      }

      const result: MacCityLocation = {
        timeZone,
        ...(location.city ? { city: location.city.slice(0, 120) } : {}),
        ...(location.region ? { region: location.region.slice(0, 120) } : {}),
        ...(location.country ? { country: location.country.slice(0, 2).toUpperCase() } : {})
      }

      return result
    } catch {
      signal.throwIfAborted()

      return unavailableResult()
    }
  }
}
