/**
 * Who owns the window during Atum cold start.
 *
 * Atum has exactly ONE startup surface: the Atum mark/rings plate rendered by
 * `GatewayConnectingOverlay`. Historically three surfaces could be alive at the
 * same moment — the startup plate (z-1200), the legacy Hermes
 * `DesktopOnboardingOverlay` welcome form (z-1300, and therefore able to WIN),
 * and `AtumShellRoot` painting either the product shell or the sign-in form
 * underneath a translucent plate. The packaged boot screenshot showed all of
 * that at once: the auth form ghosting through the startup card, with copy that
 * could flip locale mid-boot once config hydrated.
 *
 * The fix is ownership, not opacity: while startup owns the window, the Atum UI
 * is not mounted at all, so there is nothing to shine through a translucent
 * plate. This module is the single, testable source of that decision, shared by
 * the overlay (which decides whether to show) and the controller (which decides
 * whether to mount the shell), so the two can never disagree by a frame.
 *
 * State enumeration, for the record:
 *   loading            → startup plate only; shell + auth NOT mounted.
 *   boot failure       → startup bows out; `BootFailureOverlay` owns recovery
 *                        and the shell mounts behind it so its actions work.
 *   post-boot offline  → cold boot already completed; the shell stays up and
 *                        the small offline recovery pill appears instead.
 *   gateway switch     → soft switch, shell stays mounted, no startup plate.
 *   warm reload        → gateway already open; startup never shows, shell is
 *                        mounted on the first frame.
 */

import { atom } from 'nanostores'

import { persistString, storedString } from '@/lib/storage'

const WELCOME_SEEN_KEY = 'hermes.desktop.atum.welcomeSeen'

export interface AtumStartupInput {
  /** `$desktopBoot.error` — terminal failure for this boot cycle. */
  bootError: null | string
  /** `$desktopBoot.progress` (0-100). */
  bootProgress: number
  /** `$desktopBoot.running`. */
  bootRunning: boolean
  /** `$desktopBoot.visible`. */
  bootVisible: boolean
  /** True once a cold boot has completed in this window; latches forever. */
  coldBootDone: boolean
  /** `$gatewayState`. */
  gatewayState: string
  /** `$gatewaySwitching` — a soft profile switch, not a cold start. */
  gatewaySwitching: boolean
}

/**
 * True while the cold-start plate is the only thing that may paint.
 *
 * Deliberately identical to the overlay's own `connecting` predicate: the
 * overlay is visible exactly when this is true, so the shell being hidden
 * exactly when this is true means the two surfaces tile the window with no
 * overlap and no gap.
 */
export function atumStartupOwnsWindow(input: AtumStartupInput): boolean {
  if (input.coldBootDone || input.gatewaySwitching || input.bootError) {
    return false
  }

  if (input.gatewayState === 'open') {
    return false
  }

  return input.bootVisible || input.bootRunning || input.bootProgress < 100
}

/**
 * Latched by the startup overlay for the duration of its EXIT choreography.
 *
 * `atumStartupOwnsWindow` goes false the instant the gateway opens, but the
 * plate is still on screen fading its content out. Mounting the shell then
 * would put the product UI back underneath a still-visible translucent plate —
 * the exact regression this pass removes. The overlay therefore holds the lock
 * until it begins fading ITSELF out, at which point the shell fades up through
 * the disappearing plate.
 *
 * It is a plain atom rather than a computed store because only the overlay can
 * know where it is in its own animation.
 */
export const $atumStartupHolding = atom(false)

export function setAtumStartupHolding(holding: boolean): void {
  if ($atumStartupHolding.get() !== holding) {
    $atumStartupHolding.set(holding)
  }
}

/** The welcome belongs after boot/auth and before the product shell. */
export function atumWelcomeShouldPlay(): boolean {
  if (import.meta.env.ATUM_DEMO_REPLAY_WELCOME === '1') {
    return true
  }

  return storedString(WELCOME_SEEN_KEY) !== 'true'
}

export function markAtumWelcomeSeen(): void {
  persistString(WELCOME_SEEN_KEY, 'true')
}
