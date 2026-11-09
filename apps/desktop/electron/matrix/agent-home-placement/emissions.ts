/**
 * What this Mac is in the middle of saying as an agent, and the switch that stops it saying anything but through the
 * platform (`atum.agent-home/2.1`, single writer).
 *
 * A move hands an agent from one Mac to another. The platform fences everything that goes through its outbox, but a
 * message this Mac sends into a room by itself (a status line, a routine's result, a notice, a task event) is not
 * something the platform can order against the move. So the source Mac does the ordering for those, with two facts:
 *
 *   - `track` counts every direct send from before its first await to the moment it settles;
 *   - `switchToOutbox` says the agent emits only through the platform from now on; the guard refuses a direct send
 *     (one that is not a ledgered result) the moment it is set, and `settled` resolves when what was already in
 *     flight has landed.
 *
 * The drain acknowledgement is signed after both: the switch is up and nothing direct is still in flight. A send that
 * began before the switch came from the current home, and finished before the acknowledgement; none begins after it.
 * That is the whole barrier, and it needs no cache: both facts are this Mac's own, read synchronously.
 */
export class AgentEmissions {
  private readonly flights = new Map<string, Set<Promise<unknown>>>()
  private readonly switched = new Set<string>()

  /** From now on the agent emits only through the platform's outbox (the drain barrier is up). */
  switchToOutbox(agent: string): void {
    this.switched.add(agent)
  }

  /** The move ended without a commit, or this Mac is the home again: direct sends are allowed again. */
  release(agent: string): void {
    this.switched.delete(agent)
  }

  outboxOnly(agent: string): boolean {
    return this.switched.has(agent)
  }

  /**
   * Run one direct send. It is counted from this call (nothing awaits first), so a barrier that is raised a moment
   * later waits for it; it is dropped from the count when it settles, whichever way.
   */
  track<T>(agent: string, run: () => Promise<T>): Promise<T> {
    const flight = (async () => run())()
    const set = this.flights.get(agent) ?? new Set<Promise<unknown>>()
    set.add(flight)
    this.flights.set(agent, set)

    const done = () => {
      set.delete(flight)

      if (set.size === 0 && this.flights.get(agent) === set) {
        this.flights.delete(agent)
      }
    }

    flight.then(done, done)

    return flight
  }

  inFlight(agent: string): number {
    return this.flights.get(agent)?.size ?? 0
  }

  /**
   * Resolves `true` once no direct send of the agent is in flight (those counted so far, and any that begin while
   * waiting), `false` if `signal` ends first. A send that never settles is the caller's `false`, not a hang.
   */
  async settled(agent: string, signal: AbortSignal): Promise<boolean> {
    const ended = new Promise<false>(resolve => {
      if (signal.aborted) {
        resolve(false)

        return
      }

      signal.addEventListener('abort', () => resolve(false), { once: true })
    })

    for (;;) {
      const set = this.flights.get(agent)

      if (!set || set.size === 0) {
        return true
      }

      const settled = await Promise.race([Promise.allSettled([...set]).then(() => true as const), ended])

      if (settled === false) {
        return false
      }
    }
  }
}
