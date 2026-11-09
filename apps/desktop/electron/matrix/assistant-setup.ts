import { MATRIX_READINESS_TIMINGS, type MatrixReadinessCheck } from './readiness'

/**
 * Whether a cold first sign-in still owes the default assistant local setup.
 *
 * `setUpAssistant`'s entry guard reads the assistant's placement, but on a brand-new account
 * that guard runs before any roster exists. The roster sync inside setup is the first answer,
 * and it can say the platform already placed the assistant in the cloud. Local executor
 * enrollment is then both unwanted (the cloud is answering) and refused by the platform
 * (`cloud_answering`), so it must not start. A local assistant is unchanged.
 */
export function matrixAssistantSetupRunsLocally(input: { cloudOnly: boolean }): boolean {
  return !input.cloudOnly
}

/**
 * How long a cold setup waits before asking for the roster again.
 *
 * A first roster read that fails (or a sync that throws) before naming the product default is
 * not a setup failure: the assistant may already be in the cloud, and the next read decides.
 * Returning a delay keeps `assistantSetupState` pending and lets the existing readiness gate
 * resume setup at the same first-backoff cadence it uses for every other retry.
 */
export function matrixAssistantSetupRosterRetry(input: {
  roster: MatrixReadinessCheck | undefined
  defaultPrincipal: string | undefined
}): number | undefined {
  if (input.defaultPrincipal !== undefined || input.roster?.ok) {
    return undefined
  }

  return MATRIX_READINESS_TIMINGS.backoffMs[0]
}

/**
 * The account's `localExecutorRequired` answer for one enrollment target.
 *
 * An unnamed target is the default assistant. A named principal follows its runtime when this
 * Mac knows it; an unknown principal is never assumed cloud-only, so its local enrollment stays
 * allowed (the platform still answers for whether it may exist).
 */
export function matrixLocalExecutorRequired(input: {
  principal: string | undefined
  defaultCloudOnly: boolean
  namedCloudOnly: (principal: string) => boolean | undefined
}): boolean {
  const cloudOnly =
    input.principal === undefined ? input.defaultCloudOnly : (input.namedCloudOnly(input.principal) ?? false)

  return matrixAssistantSetupRunsLocally({ cloudOnly })
}
