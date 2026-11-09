import { CONNECTION_CATALOG } from './connection-catalog'

/** Compatibility inventory only. Native OAuth admission uses planStartDecision;
 * the recorded owner's acceptance never substitutes for this account's consent. */
export type MatrixPlanSignInStatus = 'owner-accepted' | 'prohibited' | 'unverified'

export interface MatrixPlanSignInTerms {
  status: MatrixPlanSignInStatus
  reviewedAt: string
  planOnly: boolean
}

export const MATRIX_PLAN_SIGN_IN_TERMS: Readonly<Record<string, MatrixPlanSignInTerms>> = Object.freeze(
  Object.fromEntries(
    CONNECTION_CATALOG.filter(entry => entry.kind === 'plan').map<[string, MatrixPlanSignInTerms]>(entry => [
      entry.provider,
      {
        status:
          entry.planSignIn === 'pending_approval' && entry.ownerAcceptance
            ? 'owner-accepted'
            : entry.planSignIn === 'prohibited'
              ? 'prohibited'
              : 'unverified',
        reviewedAt: entry.reviewedAt,
        planOnly: !CONNECTION_CATALOG.some(other => other.provider === entry.provider && other.kind !== 'plan')
      }
    ])
  )
)

function termsOf(provider: string): MatrixPlanSignInTerms | undefined {
  return Object.hasOwn(MATRIX_PLAN_SIGN_IN_TERMS, provider) ? MATRIX_PLAN_SIGN_IN_TERMS[provider] : undefined
}

/** Advertises the pending Advanced row; this is never permission to start. */
export function matrixPlanSignInOffered(provider: string): boolean {
  return termsOf(provider)?.status === 'owner-accepted'
}

/** Existing connections remain reachable for disconnect in the native adapter. */
export function matrixPlanOnlyHidden(provider: string): boolean {
  const terms = termsOf(provider)

  return Boolean(terms?.planOnly && terms.status !== 'owner-accepted')
}
