/**
 * Two questions about an agent's writers, for the checkpoints taken beside the running agent. Neither stops anything.
 *
 *   `agentAtRest`     Is this a good moment? Free to ask, takes nothing and waits for nothing: the cadence asks it before it
 *                     starts a checkpoint at all, so a busy agent is never reserved for.
 *   `agentHoldWrites` Hold them still, for the moment it takes to stage a snapshot of the home (checkpoint.ts): admit no new
 *                     write, find none in flight, and say so with the function that lets them go. This is the barrier that
 *                     makes the snapshot one moment of the home instead of a reading of files a writer may be changing.
 *
 * What each asks, the second only if the first says yes:
 *
 *   1. The app's own facts (`resting`): no turn, task, local question, start, claim, operation or content sync of the agent's
 *      (agent-runtime.ts `matrixAgentQuiet`).
 *   2. Hermes's own: the memory and skill review it runs in the background after an answer (the `bg-review` threads) has
 *      finished writing. `runtime.quiesce` is Hermes's flush hook for that question (the cloud controller asks it before it
 *      exports a home); with `timeout_ms: 0` it joins nothing and answers at once with what is still running.
 *
 * A hold takes the agent's turn lock first (`lock`, which every path that starts Hermes on this agent waits for: a local turn,
 * the listening watch, an explicit run, a model change), so nothing can begin while the two questions are asked and while
 * the snapshot is staged. A turn that arrives meanwhile is not refused, only kept waiting for the fraction of a second the
 * hold lasts. The hold is never kept longer than that: the caller lets it go the moment the snapshot is staged, and reads the
 * snapshot, not the home, from then on.
 *
 * What the hold cannot reach is not on the lock: a Hermes cron job already running, the owner's own editor. The snapshot says
 * so for those (its second look at the home before the window ends), and the checkpoint is thrown away rather than kept.
 */

/** The part of Hermes's RPC client this needs (`JsonRpcGatewayClient.request`). */
export interface HermesRpc {
  request<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<T>
}

export interface AtRestFacts {
  /** The app's own facts say nothing of the agent's is in flight. */
  resting(): boolean
  /** The running Hermes's RPC, or undefined while none is up (nothing then writes the home). */
  hermes(): HermesRpc | undefined
  log?(line: string): void
}

export interface HoldFacts extends AtRestFacts {
  /**
   * The agent's turn lock, if it is free this instant (`MatrixHermesTurnLock.tryAcquire`), as the function that lets it go;
   * null while a turn holds it or waits for it. `resting` here is asked with the lock held, so it must not count the lock.
   */
  lock(): (() => void) | null
}

/** Hermes answers in milliseconds; one that does not (a wedged backend) is not at rest. */
export const REVIEW_PROBE_TIMEOUT_MS = 5_000

/** Has the background review of Hermes finished? Never waits for it: an unanswered or unintelligible probe is "no". */
export async function hermesReviewFinished(hermes: HermesRpc, log?: (line: string) => void): Promise<boolean> {
  try {
    const answer = await hermes.request<{ drained?: unknown } | null>('runtime.quiesce', { timeout_ms: 0 }, REVIEW_PROBE_TIMEOUT_MS)

    return answer?.drained === true
  } catch (error) {
    log?.(`[Home] could not ask Hermes whether its review has finished: ${error instanceof Error ? error.message : 'unknown'}`)

    return false
  }
}

export async function agentAtRest(facts: AtRestFacts): Promise<boolean> {
  if (!facts.resting()) {
    return false
  }

  const hermes = facts.hermes()

  if (hermes && !(await hermesReviewFinished(hermes, facts.log))) {
    return false
  }

  // A turn can begin while Hermes answers, and then the answer is old.
  return facts.resting()
}

/**
 * Hold the agent's writers still: the function that lets them go, or null when they cannot be held now (a turn is in flight
 * or waiting, something else of the agent's is at work, or Hermes's review of the last answer is not over). Nothing is stopped
 * and nothing waits for a turn: a null is "not now", and the checkpoint is tried again at the next quiet moment.
 */
export async function agentHoldWrites(facts: HoldFacts): Promise<(() => void) | null> {
  const release = facts.lock()

  if (!release) {
    return null
  }

  let kept = false

  try {
    // The lock is ours: no turn, watch or model change can begin from here. What is left to ask is what was already under way.
    if (!facts.resting()) {
      return null
    }

    const hermes = facts.hermes()

    if (hermes && !(await hermesReviewFinished(hermes, facts.log))) {
      return null
    }

    // Not everything of the agent's takes the lock (an account operation, a content sync): ask once more now that Hermes has answered.
    if (!facts.resting()) {
      return null
    }

    kept = true

    return release
  } finally {
    if (!kept) {
      release()
    }
  }
}
