/**
 * One signed call to the platform, the way every executor call is made.
 *
 *   - the placement is read fresh and the standing decided from it; a Mac that may not do this (not the home,
 *     or a move has taken it away) does not sign anything;
 *   - the fence is built from that placement and this Mac's lease facts; a Mac without a live term whose
 *     grant carried a generation has no authority to present, and says so;
 *   - the body is signed fresh for every attempt (the platform refuses a frame it has seen);
 *   - a refusal that fresh facts can answer (the expiry moved, the term was replaced, the frame aged out) is
 *     tried again, up to three times in all; every other answer is returned as it is.
 *
 * Nothing here decides what a failure means for the caller; it returns the platform's own closed answer.
 */
import type { HomeAuthorityFence, HomeLeaseFence, HomeOperation, HomePlacement } from './contract'
import { ExecutorAuthError, type MacExecutorAuth } from './executor-auth'
import { fenceFromLease, type LeaseFacts, withOperation } from './fence'
import type { HomePlatformFailure } from './platform-client'
import type { HomeStanding, Standing } from './standing'

export interface SignedCallDeps {
  standing: HomeStanding
  auth: MacExecutorAuth
  leaseFacts(agent: string): LeaseFacts | null
}

export type SignedFailure =
  | { kind: 'not_home'; standing: Standing['state'] }
  | { kind: 'no_authority'; detail: string }
  | HomePlatformFailure

export type SignedResult<T> = { ok: true; value: T; placement: HomePlacement } | { ok: false; failure: SignedFailure }

export interface SignedInput {
  placement: HomePlacement
  lease: HomeLeaseFence
  /** The lease plus the operation; absent for a readiness report, which presents the lease alone. */
  fence: HomeAuthorityFence | null
}

/**
 * A refusal that fresh lease facts, or a fresh frame, can answer. `stale_authority` is the publication route's one word
 * for "the fence or the placement revision you signed is not the platform's now": a checkpoint that committed between
 * this Mac's read and its frame moves the revision, and nothing is wrong with the Mac. It is read again and signed again;
 * only a Mac that is no longer the home stops, and the standing check says so.
 */
export const REFRESHABLE_REFUSALS: ReadonlySet<string> = new Set([
  'wrong_lease',
  'lease_expired',
  'stale_executor_term',
  'replayed',
  'signature_expired',
  'stale_authority'
])

const ATTEMPTS = 3

export async function signedCall<T>(
  deps: SignedCallDeps,
  agent: string,
  operation: HomeOperation | null,
  allowed: (standing: Standing) => boolean,
  build: (input: SignedInput) => Promise<{ ok: true; value: T } | HomePlatformFailure>,
  signal: AbortSignal
): Promise<SignedResult<T>> {
  let last: HomePlatformFailure | undefined

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const standing = await deps.standing.check(agent, signal, { fresh: true })

    if (!allowed(standing)) {
      return { ok: false, failure: { kind: 'not_home', standing: standing.state } }
    }

    const placement = (standing as Extract<Standing, { placement: HomePlacement }>).placement
    const lease = placement ? fenceFromLease(placement, deps.leaseFacts(agent)) : null

    if (!lease) {
      return { ok: false, failure: { kind: 'no_authority', detail: 'lease_term_unavailable' } }
    }

    let answer: { ok: true; value: T } | HomePlatformFailure

    try {
      answer = await build({ placement, lease, fence: operation ? withOperation(lease, operation) : null })
    } catch (error) {
      if (error instanceof ExecutorAuthError) {
        return { ok: false, failure: { kind: 'no_authority', detail: error.code } }
      }

      throw error
    }

    if (answer.ok === true) {
      return { ok: true, value: answer.value, placement }
    }

    last = answer

    if (!(answer.kind === 'refused' && REFRESHABLE_REFUSALS.has(answer.reason))) {
      break
    }
  }

  return { ok: false, failure: last! }
}

/** The closed word for why a call failed, for logs and the status line (never a path, a name or a body). */
export function failureWord(failure: SignedFailure): string {
  if (failure.kind === 'refused') {
    return failure.reason
  }

  if (failure.kind === 'not_home') {
    return `not_home_${failure.standing}`
  }

  return failure.kind === 'no_authority' ? failure.detail : failure.kind
}
