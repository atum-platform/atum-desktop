/**
 * RETIRED legacy wallet (pre-Matrix app). Renderer-safe projection of the
 * read-only legacy Proton wallet. The legacy desktop checkout that sold into
 * this wallet was retired on 2026-10-05 (atum-platform
 * docs/archive/legacy-desktop-checkout); Matrix top-ups live in
 * shared/matrix-checkout.ts. Balances arrive only from main; this module
 * validates the narrow, public shape before it reaches presentation state.
 */

/** Wallet amounts stay authoritative when inference is paused. A pause cannot restore free inference. */
export interface ProtonWallet {
  balance_protons: number
  funded: boolean
  spending_enabled: boolean
  available_protons: number
  held_protons: number
  trial_protons: number
  ai_protons_per_usd: number
}

interface JsonRecord {
  [key: string]: unknown
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nonnegativeSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function nonnegativeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function parseProtonWallet(value: unknown): ProtonWallet | null {
  if (!isRecord(value)) {return null}

  const balance_protons = nonnegativeSafeInteger(value.balance_protons)
  const available_protons = nonnegativeFiniteNumber(value.available_protons)
  const held_protons = nonnegativeFiniteNumber(value.held_protons)
  const trial_protons = nonnegativeFiniteNumber(value.trial_protons)
  const ai_protons_per_usd = nonnegativeFiniteNumber(value.ai_protons_per_usd)

  if (
    balance_protons === null ||
    typeof value.funded !== 'boolean' ||
    typeof value.spending_enabled !== 'boolean' ||
    available_protons === null ||
    held_protons === null ||
    trial_protons === null ||
    ai_protons_per_usd === null
  ) {
    return null
  }

  return {
    balance_protons,
    funded: value.funded,
    spending_enabled: value.spending_enabled,
    available_protons,
    held_protons,
    trial_protons,
    ai_protons_per_usd
  }
}
