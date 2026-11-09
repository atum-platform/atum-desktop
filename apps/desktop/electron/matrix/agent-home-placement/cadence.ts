/**
 * How often the home Mac checkpoints an agent (owner decision D1, 2026-10-24: "an encrypted checkpoint is taken every
 * 15 minutes when something changed, and on idle"; losing what changed since the last one is accepted).
 *
 *   dirty   At most once every `every` (15 minutes), and only if the home has changed since the last checkpoint.
 *   idle    Once the agent has done nothing for `idleAfter` (5 minutes), and has changed since the last checkpoint:
 *           the changes made in the last minutes of a conversation are saved without waiting for the quarter hour.
 *           Once per idle period: the next one needs the agent to have been active again.
 *
 * "Changed" is a cheap content-digest comparison: the Python tool fingerprints exactly the files a capture would carry
 * (paths, sizes, modification times; no file is opened) and the cadence compares it with the fingerprint of the last
 * checkpoint it took, restored or resumed. Equal: nothing is reserved, quiesced, captured or uploaded. A write the app
 * knows about (a memory, a skill, a setting) needs no separate signal: it moves a modification time.
 *
 * What it never does:
 *
 *   - checkpoint an agent the model does not govern, or one this Mac is not the home of, or one that is moving, held,
 *     being stood down or mid-checkpoint: `eligible` says no, and a checkpoint in flight is cancelled the moment it does;
 *   - stop or restart the agent, or wait for it. A checkpoint is taken BESIDE the running agent (checkpoint.ts): its
 *     Hermes process, its sessions and everything that lives only in them stay as they are, and the next reply pays no
 *     cold start. (Before this the quarter-hour rule stopped the agent's executor and started it again.) So a
 *     checkpoint that is due while the agent is busy waits for the next quiet moment, however long that takes:
 *     never forced, never alongside a turn. The moment is `busy` (cheap, and the idle clock's) and then `atRest`
 *     (also asks Hermes whether the review of the last answer has finished). The checkpoint then holds the writers
 *     still for the fraction of a second a snapshot of the home takes (a turn that arrives meanwhile waits that long),
 *     and captures from the snapshot;
 *   - hammer a platform that says no: a failure backs the agent off (`retryMs`, a platform without the routes
 *     `unsupportedRetryMs`), and two checkpoints are never closer than `minGapMs`. A snapshot that could not be taken
 *     (the writers were busy when they were to be held, or something wrote the home inside the window) is not the
 *     platform's fault and backs nothing off: the next look, a minute on, tries again.
 */
import type { CheckpointOutcome } from './checkpoint'
import type { CheckpointReason } from './contract'
import type { AgentHomeJournal } from './journal'

export const CADENCE_EVERY_MS = 15 * 60_000
/** "Idle": no activity for this long (15 minutes for dirty state, 5 minutes for idle state). */
export const CADENCE_IDLE_AFTER_MS = 5 * 60_000

export interface CadenceOptions {
  journal: AgentHomeJournal
  now(): number
  /** This Mac checkpoints this agent: managed, this Mac is the home, nothing is moving, held or being stood down. */
  eligible(agent: string): boolean
  /** The agent is in the middle of something (a turn, a task, an owner operation): it is active, and no checkpoint is due beside it. */
  busy(agent: string): boolean
  /**
   * A good moment to capture beside the agent: nothing of its own is writing its home and Hermes's review of the last
   * answer has finished (`HomeRuntimeOps.atRest`). Asked without disturbing anything; false waits for the next look.
   */
  atRest(agent: string): Promise<boolean>
  /** The home's cheap fingerprint now, or null when the tool is not there. */
  fingerprint(agent: string, signal: AbortSignal): Promise<string | null>
  checkpoint(agent: string, reason: Extract<CheckpointReason, 'cadence_dirty' | 'idle'>, signal: AbortSignal): Promise<CheckpointOutcome>
  every?: number
  idleAfter?: number
  /** How often an agent is looked at. */
  tickMs?: number
  /** The closest two checkpoints of one agent may be. */
  minGapMs?: number
  /** How long a failed agent is left alone. */
  retryMs?: number
  /** The same, when the platform has no checkpoint routes. */
  unsupportedRetryMs?: number
  log?(line: string): void
}

interface AgentState {
  firstSeenAt: number
  lastActivityAt: number
  /** The activity time an idle checkpoint was last settled for: one per idle period. */
  idleSettledFor: number | null
  checkedAt: number
  retryAt: number
  running: AbortController | null
}

export type CadenceStep = 'skipped' | 'clean' | 'checkpointed' | 'failed' | 'busy'

export class CheckpointCadence {
  private readonly states = new Map<string, AgentState>()
  private lastTick = Number.NEGATIVE_INFINITY

  constructor(private readonly options: CadenceOptions) {}

  private now(): number {
    return this.options.now()
  }

  private state(agent: string): AgentState {
    let state = this.states.get(agent)

    if (!state) {
      // The first sight starts the clocks: an agent seen at app start is not "idle since the beginning of time".
      state = { firstSeenAt: this.now(), lastActivityAt: this.now(), idleSettledFor: null, checkedAt: Number.NEGATIVE_INFINITY, retryAt: 0, running: null }
      this.states.set(agent, state)
    }

    return state
  }

  /** The agent did something (said something, ran a turn): the idle clock starts again. */
  touch(agent: string): void {
    this.state(agent).lastActivityAt = this.now()
  }

  /** Whether a checkpoint of this agent is in flight. */
  running(agent: string): boolean {
    return Boolean(this.states.get(agent)?.running)
  }

  /** A move began, the agent is held or this Mac is not its home: end a checkpoint in flight (its reservation is failed or expires). */
  cancel(agent: string): void {
    this.states.get(agent)?.running?.abort()
  }

  /** Looks at every agent whose turn has come (at most once per `tickMs`); never throws and never waits for a checkpoint. */
  tick(agents: readonly string[]): void {
    const now = this.now()

    if (now - this.lastTick < (this.options.tickMs ?? 30_000)) {
      return
    }

    this.lastTick = now

    for (const agent of agents) {
      void this.look(agent)
    }
  }

  /** One agent, now. Exposed for the tests and for a status check; `tick` is the way the app calls it. */
  async look(agent: string): Promise<CadenceStep> {
    const state = this.state(agent)

    try {
      if (state.running) {
        return 'busy'
      }

      if (!this.options.eligible(agent)) {
        // Nothing is owed while this Mac is not the home or the agent is moving; the idle period starts over.
        state.idleSettledFor = null

        return 'skipped'
      }

      const now = this.now()

      if (this.options.busy(agent)) {
        // Active: the idle clock starts again, and a checkpoint that is due waits for a quiet moment, however long that is.
        state.lastActivityAt = now

        return 'skipped'
      }

      if (now < state.retryAt) {
        return 'skipped'
      }

      const journal = this.options.journal.read(agent)
      const last = journal.lastCommittedAt ?? state.firstSeenAt
      const sinceLast = now - last

      if (sinceLast < (this.options.minGapMs ?? 2 * 60_000)) {
        return 'skipped'
      }

      const every = this.options.every ?? CADENCE_EVERY_MS
      const due = sinceLast >= every
      const idle = now - state.lastActivityAt >= (this.options.idleAfter ?? CADENCE_IDLE_AFTER_MS) && state.idleSettledFor !== state.lastActivityAt

      if (!due && !idle) {
        return 'skipped'
      }

      if (now - state.checkedAt < 60_000) {
        return 'skipped'
      }

      state.checkedAt = now

      const controller = new AbortController()
      state.running = controller

      try {
        const fingerprint = await this.options.fingerprint(agent, controller.signal)

        if (fingerprint !== null && fingerprint === journal.lastFingerprint) {
          // Nothing changed since the last checkpoint: nothing is reserved, quiesced or uploaded.
          if (idle) {
            state.idleSettledFor = state.lastActivityAt
          }

          return 'clean'
        }

        // Changed, and due: but only beside an agent at rest. Asked after the (free) clean check, so an unchanged home never asks Hermes anything.
        if (!(await this.options.atRest(agent))) {
          return 'busy'
        }

        if (!this.options.eligible(agent) || controller.signal.aborted) {
          return 'skipped'
        }

        const reason = due ? 'cadence_dirty' : 'idle'
        const outcome = await this.options.checkpoint(agent, reason, controller.signal)

        if (outcome.state === 'committed') {
          state.retryAt = 0

          if (idle) {
            state.idleSettledFor = state.lastActivityAt
          }

          this.options.log?.(`[Home] ${agent.slice(0, 8)} checkpoint ${reason} generation ${outcome.generation}`)

          return 'checkpointed'
        }

        // Cancelled because a move began or the agent was held: nothing is wrong with the platform, so nothing backs off.
        if (controller.signal.aborted) {
          return 'skipped'
        }

        // The writers were busy when they were to be held still, or something wrote the home inside the window: the agent is
        // working, not the platform failing. The next look (the throttle above is a minute) tries again; nothing to back off from.
        if (outcome.reason === 'home_changed') {
          const why =
            outcome.detail === 'writers_busy'
              ? 'the agent’s writers were busy when they were to be held still'
              : 'something wrote the home while its writers were held still'

          this.options.log?.(`[Home] ${agent.slice(0, 8)} checkpoint ${reason} not taken: ${why}`)

          return 'busy'
        }

        state.retryAt = this.now() + (outcome.reason === 'unsupported' ? (this.options.unsupportedRetryMs ?? 30 * 60_000) : (this.options.retryMs ?? 5 * 60_000))

        // Said once per back-off, in the closed words of the checkpoint (no path, no key, no bytes): a store that refuses
        // the archive's size (`upload_failed (too_large)`) would otherwise leave the home unprotected without a word.
        this.options.log?.(`[Home] ${agent.slice(0, 8)} checkpoint ${reason} failed: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}`)

        return 'failed'
      } finally {
        state.running = null
      }
    } catch (error) {
      state.running = null
      state.retryAt = this.now() + (this.options.retryMs ?? 5 * 60_000)
      this.options.log?.(`[Home] ${agent.slice(0, 8)} checkpoint cadence failed: ${error instanceof Error ? error.message : 'unknown'}`)

      return 'failed'
    }
  }

  /** The app is stopping, or another account signed in: nothing may go on checkpointing. */
  cancelAll(): void {
    for (const state of this.states.values()) {
      state.running?.abort()
    }
  }

  /** Forget an agent that is no longer on this Mac. */
  forget(agent: string): void {
    this.states.get(agent)?.running?.abort()
    this.states.delete(agent)
  }
}
