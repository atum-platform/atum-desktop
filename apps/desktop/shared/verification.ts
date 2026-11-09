import type { AppDescriptor } from './app-catalog'
import type { MatrixOfficialAccount } from './matrix-founder'

/**
 * How far Atum vouches for an account or an app (owner decision 2026-10-05, in the icon
 * pack's convention):
 *
 * - `official`, a filled check: run by Atum (the Founder, later Support) or one of Atum's
 *   own apps (Moon, Andy, …);
 * - `verified`, a hollow check: checked by Atum but not run by it (later: partner apps and
 *   accounts not affiliated with Atum).
 *
 * Anything else is unverified and draws no mark. A tier only ever comes from the platform:
 * an account's from the official accounts read, an app's from its catalog descriptor, a
 * bot's from its app. Never from a name, a handle, a room name or an avatar.
 */
export type VerificationTier = 'official' | 'verified'

/** A tier from the wire: the two known words, else none (unknown future tiers draw nothing). */
export function parseVerificationTier(value: unknown): VerificationTier | null {
  return value === 'official' || value === 'verified' ? value : null
}

/** An app's tier, from its catalog descriptor only. The legacy `verified` boolean is not a tier. */
export function appVerificationTier(
  app: Pick<AppDescriptor, 'verification'> | null | undefined
): VerificationTier | null {
  return parseVerificationTier(app?.verification)
}

/** An account's tier, from the platform's official accounts only, by its exact Matrix id. An
 * unavailable read (no list) marks nobody. */
export function accountVerificationTier(
  accounts: readonly MatrixOfficialAccount[] | null | undefined,
  userId: string | null | undefined
): VerificationTier | null {
  if (!accounts || !userId) {
    return null
  }

  return parseVerificationTier(accounts.find(account => account.userId === userId)?.tier)
}
