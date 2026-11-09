/**
 * Graceful Mac handover for sleep and quit (reliability program R4).
 *
 * The listener already knows how to drain one admitted turn without accepting another. The lease
 * mirrors that boundary: an active room turn changes its exact v2 term to local `yielding`, while an
 * idle runtime releases immediately. Quit may additionally hold native operations and await the
 * admitted turns before ordinary SDK/process teardown begins.
 */

interface MatrixRuntimeDrainTarget {
  operation: boolean
  invocation?: { abort: AbortController; roomId?: string; pending: Promise<unknown> }
  lease?: { drain(): boolean; release(): Promise<void> }
  listener: { drainAndStop(reason: 'cancelled' | 'unavailable'): void }
}

export const MATRIX_RUNTIME_DRAIN_TIMEOUT_MS = 15_000

export function drainMatrixRuntimes(
  agents: readonly MatrixRuntimeDrainTarget[],
  options: { holdOperations: boolean; reason: 'cancelled' | 'unavailable'; timeoutMs?: number }
): Promise<{ timedOut: boolean }> {
  const active: Promise<unknown>[] = []
  const slots: NonNullable<MatrixRuntimeDrainTarget['invocation']>[] = []
  const releases: Promise<unknown>[] = []

  for (const agent of agents) {
    if (options.holdOperations) {
      agent.operation = true
    }

    try {
      agent.listener.drainAndStop(options.reason)
    } catch {
      // One malformed/retired runtime must not prevent every other agent from draining.
    }

    if (agent.invocation?.roomId) {
      try {
        agent.lease?.drain()
      } catch {
        // The pending turn is still bounded below; ordinary teardown owns the broken lease.
      }

      slots.push(agent.invocation)
      active.push(agent.invocation.pending)
    } else {
      try {
        const release = agent.lease?.release()

        if (release) {
          releases.push(release)
        }
      } catch {
        // Release is best effort; the server term still expires at its original deadline.
      }
    }
  }

  const settled = Promise.allSettled([...active, ...releases]).then(() => false)

  if (options.timeoutMs === undefined) {
    return settled.then(timedOut => ({ timedOut }))
  }

  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(true), Math.max(0, options.timeoutMs!))
    timer.unref?.()
  })

  return Promise.race([settled, timeout]).then(timedOut => {
    clearTimeout(timer)

    if (timedOut) {
      for (const slot of slots) {
        slot.abort.abort()
      }
    }

    return { timedOut }
  })
}
