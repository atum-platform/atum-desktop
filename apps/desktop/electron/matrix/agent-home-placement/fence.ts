/**
 * The authority fence a Mac executor presents (`atum.agent-home/2.1`): who the agent's home is, at which
 * epoch, under which executor term and lease, for which operation.
 *
 * Nothing in it is this Mac's say-so. The owner, agent, home and epoch come from the placement the platform
 * just answered; the lease id, its exact platform expiry and the executor term come from the lease grant the
 * platform gave this Mac (`MatrixExecutorLease.fenceFacts`). The platform checks every field against its own
 * record, so a fence assembled from stale facts is refused with a closed reason and the Mac assembles it
 * again from fresh ones.
 */
import type { HomeAuthorityFence, HomeLeaseFence, HomeOperation, HomePlacement } from './contract'
import { isUuid } from './contract'

/** What the answering lease contributes (`MatrixExecutorLease.fenceFacts`). */
export interface LeaseFacts {
  leaseId: string
  leaseExpiresAtPlatform: number
  executorTerm: number
}

/** The lease half of the fence, or null when this Mac has no live term whose grant carried a generation. */
export function fenceFromLease(placement: HomePlacement, facts: LeaseFacts | null): HomeLeaseFence | null {
  if (
    !facts ||
    !isUuid(facts.leaseId) ||
    !Number.isSafeInteger(facts.executorTerm) ||
    facts.executorTerm < 1 ||
    !Number.isSafeInteger(facts.leaseExpiresAtPlatform) ||
    facts.leaseExpiresAtPlatform < 0
  ) {
    return null
  }

  return {
    ownerUserId: placement.ownerUserId,
    agentPrincipal: placement.agentPrincipal,
    homeId: placement.homeId,
    homeEpoch: placement.homeEpoch,
    executorTerm: facts.executorTerm,
    leaseId: facts.leaseId,
    leaseExpiresAtPlatform: facts.leaseExpiresAtPlatform
  }
}

export const withOperation = (lease: HomeLeaseFence, operation: HomeOperation): HomeAuthorityFence => ({ ...lease, operation })
