/**
 * Owner-global Matrix account data. Once observed, v1 is a sticky boundary;
 * publication may restore an earlier observed timestamp. Matrix has no CAS:
 * concurrent first writes can race, so the earliest observed boundary remains
 * authoritative locally even if a later server write replaces it.
 */
export const MATRIX_GOOGLE_FENCE_ACCOUNT_DATA = 'io.atum.google_fence'

export interface MatrixGoogleFence {
  v: 1
  since: number
}

/**
 * `unknown` never authorizes a clear. `current` is only emitted after the SDK
 * has completed a network sync; null then proves this observer saw no fence.
 */
export type MatrixGoogleFenceObservation =
  | { state: 'unknown' }
  | { state: 'current'; since: number | null }

/** Strictly parse the frozen, JSON account-data shape. */
export function parseMatrixGoogleFence(value: unknown): MatrixGoogleFence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)

  if (
    keys.length !== 2 ||
    !keys.includes('v') ||
    !keys.includes('since') ||
    record.v !== 1 ||
    typeof record.since !== 'number' ||
    !Number.isSafeInteger(record.since) ||
    record.since < 0
  ) {
    return null
  }

  return { v: 1, since: record.since }
}
