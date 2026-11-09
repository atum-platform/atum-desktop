import type { MatrixAliasBridge, MatrixAliasErrorCode } from '../../shared/matrix-aliases'

/** How giving a new assistant its handle ended. `exhausted`: every candidate was taken or reserved.
 * `existing`: it already had this handle, and nothing was claimed. */
export type MatrixAgentHandleOutcome =
  | { ok: true; handle: string; existing?: true }
  | { ok: false; reason: MatrixAgentHandleRefusal }

export type MatrixAgentHandleRefusal = MatrixAliasErrorCode | 'exhausted'

/**
 * Refusals that pressing Retry again cannot change: handles are not open, this account may not
 * have one, or every handle this name gives is taken or reserved. The create sheet finishes
 * quietly on these, and the assistant's card offers a handle later. Every other reason (no
 * connection, an expired sign-in, a wait, an earlier change still unanswered) is worth a Retry.
 */
const SETTLED: ReadonlySet<MatrixAgentHandleRefusal> = new Set(['closed', 'denied', 'missing', 'invalid', 'exhausted'])

export function matrixAgentHandleRetryable(outcome: MatrixAgentHandleOutcome): boolean {
  return !outcome.ok && !SETTLED.has(outcome.reason)
}

/**
 * Main keeps one claim or rename whose answer was lost (a timeout, a dropped connection) and
 * refuses every different change, locally and as `conflict`, until that one is answered. Resend
 * it exactly as it was (same handle, same request ID), so the platform replays it and main clears
 * it. Returns the outcome when that settles this assistant's handle or cannot be cleared now, and
 * null when nothing is left pending and the walk may run.
 */
async function settleEarlierChange(
  bridge: MatrixAliasBridge,
  assistantId: string
): Promise<MatrixAgentHandleOutcome | null> {
  const journal = await bridge.pending()

  if (!journal.ok) {
    return { ok: false, reason: journal.error }
  }

  const earlier = journal.request

  if (!earlier) {
    return null
  }

  const answer = await bridge.request(earlier)

  if (earlier.action === 'claim' && earlier.assistantId === assistantId && answer.ok && answer.value.kind === 'claim') {
    return { ok: true, handle: answer.value.handle }
  }

  // Main clears its journal only on an answer it trusts; whether it did is the only question.
  const after = await bridge.pending()

  if (!after.ok) {
    return { ok: false, reason: after.error }
  }

  return after.request ? { ok: false, reason: answer.ok ? 'unavailable' : answer.error } : null
}

/**
 * Gives an assistant that already exists the first free handle among `groups`, through the same
 * directory calls the card's handle editor makes (pending, current, check, claim). Nobody types
 * anything: the create sheet asks only for a name, and the card changes the handle later.
 *
 * Safe to run again after a failure: an earlier claim whose answer was lost is resent as it was,
 * an assistant that already has a handle keeps it, and the walk never claims a second one.
 * A group is one stem with its numbers; a reserved stem ends its group, since the directory
 * reads a short number after a stem as the stem itself.
 */
export async function claimMatrixAgentHandle(
  bridge: MatrixAliasBridge,
  assistantId: string,
  groups: readonly (readonly string[])[],
  requestId: () => string = () => globalThis.crypto.randomUUID()
): Promise<MatrixAgentHandleOutcome> {
  const settled = await settleEarlierChange(bridge, assistantId)

  if (settled) {
    return settled
  }

  const current = await bridge.request({ action: 'current', assistantId })

  if (!current.ok) {
    return { ok: false, reason: current.error }
  }

  if (current.value.kind === 'current' && current.value.alias) {
    return { ok: true, handle: current.value.alias.handle, existing: true }
  }

  for (const group of groups) {
    for (const handle of group) {
      const check = await bridge.request({ action: 'check', handle, assistantId })

      if (!check.ok) {
        return { ok: false, reason: check.error }
      }

      if (check.value.kind !== 'check') {
        return { ok: false, reason: 'unavailable' }
      }

      if (!check.value.available) {
        if (check.value.code === 'alias_reserved') {
          break
        }

        continue
      }

      const claim = await bridge.request({ action: 'claim', handle, assistantId, requestId: requestId() })

      if (claim.ok && claim.value.kind === 'claim') {
        return { ok: true, handle: claim.value.handle }
      }

      // Nothing was pending when the walk began, so this is the platform's answer: someone
      // took it between the check and the claim. The next candidate.
      if (!claim.ok && claim.error === 'conflict') {
        continue
      }

      return { ok: false, reason: claim.ok ? 'unavailable' : claim.error }
    }
  }

  return { ok: false, reason: 'exhausted' }
}
