/**
 * The closed set of reasons `GET /cloud/status` may name while `access.effective` is `none`.
 * Main's parser (`electron/matrix/device/cloud-agent.ts`) and the renderer's reader
 * (`src/matrix/cloud-access.ts`) both validate against this one list, so the two can never
 * disagree about what a reason means.
 */
export const MATRIX_CLOUD_ACCESS_REASONS = [
  'trial_expired',
  'trial_not_accepted',
  'paid_lapsed',
  'no_offer',
  'entitlement_required'
] as const

export type MatrixCloudAccessReason = (typeof MATRIX_CLOUD_ACCESS_REASONS)[number]

export function isMatrixCloudAccessReason(value: unknown): value is MatrixCloudAccessReason {
  return (MATRIX_CLOUD_ACCESS_REASONS as readonly unknown[]).includes(value)
}
