/** Preserve user-visible identity, state and recovery behavior across connection changes. */

import type { MatrixListenerTrouble } from './hermes-listener'

/** MatrixHermesListener's `onTrouble` event (020 shared contract): hermes-listener.ts owns the
 * shape and emits it; this file only reads it. Re-exported for callers of the handover. */
export type { MatrixListenerTrouble }

export const MATRIX_LEASE_HANDOVER = {
  /** Unanswered turns (or automatic recoveries) in a row on this Mac before it steps aside. */
  streak: 2,
  /** How long it stays out of the race once it has. */
  holdMs: 3 * 60_000,
  /** Handovers this many times within `windowMs` read as persistent trouble (Settings' note). */
  persistent: 3,
  windowMs: 60 * 60_000
} as const

export interface MatrixLeaseHandoverOptions<K> {
  /** Give the agent's answering lease up now, through the lease's own release path (main: its
   * lease reconcile, which releases a held-off agent but keeps a lease a message waiting on this
   * Mac needs). Called once the hold-off is set, so `competes` already reads false. */
  release(agent: K): void
  /** Its hold-off ended: look at its lease again. */
  resume(agent: K): void
  /** At most an 8-character prefix of the agent's ID, for the log. */
  label?(agent: K): string
  log?(line: string): void
  now?(): number
}

/** Why automatic listening is retrying (MatrixContinuousListening's `recovering`). */
export type MatrixListeningRecovery = 'overflow' | 'unavailable'

interface AgentState {
  /** The hold-off's end, while one runs. */
  until?: number
  timer?: ReturnType<typeof setTimeout>
  /** The listener's streak where this term's failures start: where it stood when this Mac
   * stepped aside, when a turn of the term it gave up ended, or when a new term began. */
  baseline: number
  /** The listener's last reported streak. */
  last: number
  /** The lease term this Mac holds (or last held) for the agent. */
  term?: string
  /** Automatic recoveries in a row in this term, with no watch armed in between. */
  recoveries: number
  /** When it stepped aside, within the last window. */
  handovers: number[]
}

export class MatrixLeaseHandover<K extends object> {
  private readonly agents = new WeakMap<K, AgentState>()

  constructor(private readonly options: MatrixLeaseHandoverOptions<K>) {}

  /** A turn of this agent's ended without an answer. True when this Mac stepped aside for it. */
  trouble(agent: K, event: MatrixListenerTrouble): boolean {
    const streak = Number.isSafeInteger(event?.streak) ? event.streak : 0

    if (streak < 1) {
      return false
    }

    const state = this.state(agent)

    // An answered turn reset the listener's streak since its last report.
    if (streak <= state.last) {
      state.baseline = 0
    }

    state.last = streak

    // A late report from the term it already gave up: it counts toward nothing new.
    if (this.holding(state)) {
      state.baseline = streak

      return false
    }

    if (streak - state.baseline < MATRIX_LEASE_HANDOVER.streak) {
      return false
    }

    return this.stepAside(
      agent,
      state,
      `released kind=${event.kind === 'deferred_exhausted' ? 'deferred_exhausted' : 'failed'} streak=${streak}`
    )
  }

  /** Automatic listening is retrying after a failure without having armed since the last one.
   * True when this Mac stepped aside for it. */
  recovering(agent: K, reason: MatrixListeningRecovery): boolean {
    const state = this.state(agent)

    if (this.holding(state)) {
      return false
    }

    state.recoveries += 1

    if (state.recoveries < MATRIX_LEASE_HANDOVER.streak) {
      return false
    }

    return this.stepAside(
      agent,
      state,
      `released kind=recovering reason=${reason === 'overflow' ? 'overflow' : 'unavailable'} streak=${state.recoveries}`
    )
  }

  /** A watch armed for the agent: automatic recoveries start over. */
  armed(agent: K): void {
    const state = this.agents.get(agent)

    if (state) {
      state.recoveries = 0
    }
  }

  /** This Mac holds the agent's lease under `term` (its lease token). A new term counts only
   * its own failures: an old one left in the listener's streak never adds to a fresh one. */
  leaseTerm(agent: K, term: string): void {
    const state = this.state(agent)

    if (state.term === term) {
      return
    }

    state.term = term
    state.baseline = state.last
    state.recoveries = 0
  }

  /** Whether this Mac competes for the agent's answering lease now (not during its hold-off). */
  competes(agent: K): boolean {
    const state = this.agents.get(agent)

    return !state || !this.holding(state)
  }

  /** It stepped aside for this agent three or more times within the last hour. */
  persistent(agent: K): boolean {
    const now = this.now()

    return (
      (this.agents.get(agent)?.handovers.filter(at => now - at < MATRIX_LEASE_HANDOVER.windowMs).length ?? 0) >=
      MATRIX_LEASE_HANDOVER.persistent
    )
  }

  /** Sign-out, or the agent's runtime stopped for good: nothing of it carries over. */
  forget(agent: K): void {
    const state = this.agents.get(agent)

    if (state?.timer) {
      clearTimeout(state.timer)
    }

    this.agents.delete(agent)
  }

  private stepAside(agent: K, state: AgentState, code: string): boolean {
    const now = this.now()
    state.baseline = state.last
    state.recoveries = 0
    state.handovers = [...state.handovers.filter(at => now - at < MATRIX_LEASE_HANDOVER.windowMs), now]
    state.until = now + MATRIX_LEASE_HANDOVER.holdMs

    if (state.timer) {
      clearTimeout(state.timer)
    }

    state.timer = setTimeout(() => {
      state.timer = undefined
      state.until = undefined
      this.log(agent, 'resumed')
      this.call(() => this.options.resume(agent))
    }, MATRIX_LEASE_HANDOVER.holdMs)
    state.timer.unref?.()

    this.log(agent, code)
    // `until` is set first: the release path sees this agent held off.
    this.call(() => this.options.release(agent))

    return true
  }

  private holding(state: AgentState): boolean {
    return state.until !== undefined && this.now() < state.until
  }

  private state(agent: K): AgentState {
    let state = this.agents.get(agent)

    if (!state) {
      state = { baseline: 0, last: 0, recoveries: 0, handovers: [] }
      this.agents.set(agent, state)
    }

    return state
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private log(agent: K, code: string): void {
    const label = (this.options.label?.(agent) ?? '').slice(0, 8)
    this.call(() => this.options.log?.(`[Matrix] lease handover ${label ? `${label} ` : ''}${code}`))
  }

  /** Nothing here throws into the listener's thread. */
  private call(run: () => void): void {
    try {
      run()
    } catch {
      /* The lease and the next reconcile own recovery. */
    }
  }
}
