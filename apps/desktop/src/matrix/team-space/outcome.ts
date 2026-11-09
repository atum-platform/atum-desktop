import type {
  MatrixCompanyErrorCode,
  MatrixCompanyMutation,
  MatrixCompanyValue
} from '../../../shared/matrix-company'
import type { MatrixCompanyCopy } from '../../../shared/matrix-company-copy'
import type { MatrixCompanyRefusalReason } from '../../../shared/matrix-company-team-space'
import type { MatrixTeamSpaceCopy } from '../../../shared/matrix-team-space-copy'

/**
 * What a Team Space control learns from a mutation. `uncertain` means the platform's answer was
 * lost, so the request stays in the pending journal and the workspace offers its Retry: the
 * control closes and leaves the retry to it, never repeating the request under a new id.
 */
export type MutationOutcome =
  | { ok: true; value: MatrixCompanyValue }
  | {
      ok: false
      error: MatrixCompanyErrorCode
      reason?: MatrixCompanyRefusalReason
      uncertain: boolean
      /**
       * This window refused to send it: the viewer's standing changed while the control was open, so nothing left the
       * app. It is never `uncertain`, and nothing is retried.
       */
      notAllowed?: true | 'conversations'
    }

/** Runs one mutation through the workspace (journal, gating, retry); undefined when it was blocked. */
export type TeamSpaceMutate = (mutation: MatrixCompanyMutation) => Promise<MutationOutcome | undefined>

/** The one wording for a failed company call, by the status code the platform answered. */
export function companyErrorText(error: MatrixCompanyErrorCode | undefined, copy: MatrixCompanyCopy): string {
  switch (error) {
    case 'authentication': return copy.authentication

    case 'denied': return copy.denied

    case 'missing': return copy.missing

    case 'conflict': return copy.conflict

    case 'limit': return copy.limit

    case 'invalid': return copy.invalid

    case 'cancelled': return copy.cancelled

    default: return copy.unavailable
  }
}

/** This window's own refusal, the platform's typed reason when it named one this client understands, else the status's wording. */
export function outcomeText(
  outcome: Extract<MutationOutcome, { ok: false }>,
  team: MatrixTeamSpaceCopy,
  company: MatrixCompanyCopy
): string {
  if (outcome.notAllowed) {
    // Company DMs gone, or the directory they rest on unreadable: not a change of role.
    return outcome.notAllowed === 'conversations' ? team.conversationsDisabled : team.noLongerAllowed
  }

  return outcome.reason ? team.refusal[outcome.reason] : companyErrorText(outcome.error, company)
}
