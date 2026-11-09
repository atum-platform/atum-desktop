/**
 * `HomeRuntimeOps` for the real app: the promises the flows rely on, kept on top of what `main.ts` can do to one
 * agent's runtime on this Mac.
 *
 * `main.ts` supplies a `MacAgentHandle` per agent (a handful of closures over the runtime it already has); this
 * module owns the part that is about the placement model and nothing else: which holds are set when (see
 * `holds.ts`), that a drain never aborts the turn it waits for, that a release only lets the agent go when no other
 * hold remains, and that a fresh start on this Mac forgets the old conversation sessions. It is tested with a fake
 * handle, so none of it depends on Electron.
 */
import type { AgentEmissions } from './emissions'
import type { LeaseFacts } from './fence'
import type { AgentHomeHolds } from './holds'
import type { DrainResult, HomeRuntimeOps } from './runtime-ops'

/** What the placement model needs to do to one agent's runtime on this Mac. */
export interface MacAgentHandle {
  /** The agent's Hermes home on this Mac, or null when it has none. */
  home(): string | null
  /** The answering lease's facts for the fence; null without a live term. */
  leaseFacts(): LeaseFacts | null
  /**
   * Stop admitting new work and resolve when the turn in flight (and the publication of its answer) is over.
   * Must never abort that turn, and must keep the answering lease held and renewing: the lease is what signs
   * the drain acknowledgement and the final checkpoint. `deadline` bounds the work the drain may still finish for
   * the home (a managed job's pending delivery): it fires early enough that the drain itself still answers in budget.
   */
  drain(deadline?: AbortSignal): Promise<void>
  /**
   * Stop every writer of the home (listener, executor, scheduled jobs). Idempotent. With `keepLease` the
   * answering lease stays held (a checkpoint is being signed); without it the lease and the agent's own host
   * are given up too (this Mac is no longer the home).
   */
  stopWriters(options: { keepLease: boolean }): Promise<void>
  /** Let the app start the agent again, the way it starts any agent (readiness gate, lease, listener). */
  restart(): void
  /** This Mac becomes the home: forget the old conversation sessions (the room's history rebuilds them) and mark it. */
  beginHere(): void
  /** Whether the agent runs here; waits up to `ms` for it to. */
  running(ms: number, signal: AbortSignal): Promise<boolean>
  /** The agent is in the middle of something (a turn, a task, an owner operation): the checkpoint cadence waits for it. */
  busy?(): boolean
  /**
   * Nothing of the agent's own is writing its home (`at-rest.ts`): no turn or task in flight, and Hermes's review of the
   * last answer has finished. Must disturb nothing: no hold, no lock, no stop, no wait for a turn.
   */
  atRest(): Promise<boolean>
  /**
   * Hold the agent's writers still (admit no new turn or other write, find none in flight), or null when they cannot be held
   * now (`at-rest.ts` `agentHoldWrites`). Stops nothing and waits for no turn; the function returned lets them go.
   */
  holdWrites(): Promise<(() => void) | null>
  readiness(): { homeAccessible: boolean; runtimeUsable: boolean; matrixIntakeWorking: boolean }
}

export interface RuntimeAdapterOptions {
  handle(agent: string): MacAgentHandle | null
  /** Materialize a target that has no local handle yet, then make `handle(agent)` readable. */
  materialize?(agent: string, signal: AbortSignal): Promise<void>
  /**
   * Validate and apply the owner's home default against this Mac's live catalog, without a paid fallback.
   * Asked while the `model` hold is already set (persisted), before anything
   * can start the agent; false (including an error, or a choice that cannot be read) leaves the agent held. The
   * connection participant applies the choice and lets it go. Absent, activation holds nothing.
   */
  modelGate?(agent: string, signal: AbortSignal): Promise<boolean>
  holds: AgentHomeHolds
  /**
   * The agent's direct sends and the outbox-only switch. A drain raises the switch once the turn in flight is over and
   * answers only when nothing direct is still in flight: the drain acknowledgement is signed after both.
   */
  emissions?: AgentEmissions
  /** How long activation waits for a cold start before normal readiness reports take over. */
  activationWaitMs?: number
  log?(line: string): void
}

const DEFAULT_ACTIVATION_WAIT_MS = 30_000

export function createHomeRuntimeOps(options: RuntimeAdapterOptions): HomeRuntimeOps {
  const { holds } = options
  const begun = new Set<string>()
  const log = options.log ?? (() => undefined)

  const letGoIfFree = (agent: string, handle: MacAgentHandle | null) => {
    if (handle && !holds.has(agent)) {
      handle.restart()
    }
  }

  return {
    home: agent => options.handle(agent)?.home() ?? null,

    async materialize(agent, signal) {
      let handle = options.handle(agent)

      if (!handle && options.materialize) {
        await options.materialize(agent, signal)
        signal.throwIfAborted()
        handle = options.handle(agent)
      }

      return handle?.home() ?? null
    },

    leaseFacts: agent => options.handle(agent)?.leaseFacts() ?? null,

    async drain(agent, budgetMs, signal): Promise<DrainResult> {
      const handle = options.handle(agent)
      const started = Date.now()

      holds.add(agent, 'drain')

      // The turn is never aborted here: a drain that runs out of time is a move that ends, and the turn
      // goes on to finish where it is.
      // Bounded follow-up work (managed deliveries) stops at three quarters of the budget, leaving the rest for the
      // direct sends below, so a slow delivery never turns a planned move into a timed-out one.
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, Math.floor(budgetMs * 3 / 4)))])

      const ended = handle
        ? handle.drain(deadline).then(
            () => 'quiesced' as const,
            () => 'timed_out' as const
          )
        : Promise.resolve('quiesced' as const)

      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined

      const late = new Promise<DrainResult>(resolve => {
        timer = setTimeout(() => resolve('timed_out'), Math.max(0, budgetMs))
        timer.unref?.()
        onAbort = () => resolve('timed_out')
        signal.addEventListener('abort', onAbort, { once: true })
      })

      try {
        const turn = signal.aborted ? 'timed_out' : await Promise.race([ended, late])

        if (turn !== 'quiesced') {
          return turn
        }

        // The turn is over and said its piece; from here the agent emits only through the platform. What it was
        // already saying directly (a status line, a notice) lands before this answers, and nothing starts after.
        const emissions = options.emissions

        if (!emissions) {
          return 'quiesced'
        }

        emissions.switchToOutbox(agent)

        const left = Math.max(1, budgetMs - (Date.now() - started))
        const settled = await emissions.settled(agent, AbortSignal.any([signal, AbortSignal.timeout(left)]))

        if (!settled) {
          log(`[Home] ${agent.slice(0, 8)} a direct send did not land in time: the drain is not acknowledged`)
        }

        return settled ? 'quiesced' : 'timed_out'
      } finally {
        clearTimeout(timer)

        if (onAbort) {
          signal.removeEventListener('abort', onAbort)
        }
      }
    },

    async quiesce(agent) {
      const handle = options.handle(agent)

      holds.add(agent, 'quiesce')

      try {
        // The lease stays: the checkpoint this quiesce is for is signed with it.
        await handle?.stopWriters({ keepLease: true })
      } catch (error) {
        holds.remove(agent, 'quiesce')
        throw error
      }

      let released = false

      return async () => {
        if (released) {
          return
        }

        released = true
        holds.remove(agent, 'quiesce')
        letGoIfFree(agent, handle)
      }
    },

    // Sets no hold and touches nothing: an agent that is not on this Mac has nothing running that could write its home.
    atRest: async agent => (await options.handle(agent)?.atRest()) ?? true,

    // Sets no agent-home hold (`holds.ts`: those stop the executor) and stops nothing: it admits no new write for the moment of a
    // snapshot. An agent that is not on this Mac has nothing running that could write its home, so there is nothing to hold.
    holdWrites: async agent => {
      const handle = options.handle(agent)

      return handle ? handle.holdWrites() : () => undefined
    },

    async resume(agent) {
      options.emissions?.release(agent)
      holds.remove(agent, 'drain')
      holds.remove(agent, 'quiesce')
      holds.remove(agent, 'standDown')
      letGoIfFree(agent, options.handle(agent))
    },

    async standDown(agent) {
      begun.delete(agent)
      holds.remove(agent, 'drain')
      holds.add(agent, 'standDown')
      await options.handle(agent)?.stopWriters({ keepLease: false })
    },

    async activate(agent, signal) {
      const handle = options.handle(agent)

      if (!handle) {
        throw new Error('no_local_agent')
      }

      // The saved home default is held BEFORE the agent can start: a fresh profile answers on the platform's paid model,
      // and a turn must never run on a model nobody chose. The hold is persisted, so a restart cannot start the agent
      // either; it is let go only once the choice is this Mac's own.
      if (options.modelGate) {
        holds.add(agent, 'model')
      }

      // A fresh session per conversation, rebuilt from the room's history by the turn that opens it.
      if (!begun.has(agent)) {
        handle.beginHere()
        begun.add(agent)
      }
      options.emissions?.release(agent)
      holds.remove(agent, 'drain')
      holds.remove(agent, 'quiesce')
      holds.remove(agent, 'standDown')

      if (options.modelGate) {
        const ready = await options.modelGate(agent, signal).catch(() => false)

        if (!ready) {
          log(`[Home] ${agent.slice(0, 8)} held until its saved model is applied here`)

          throw new Error('model_unavailable')
        }

        holds.remove(agent, 'model')
      }

      handle.restart()

      const up = await handle.running(options.activationWaitMs ?? DEFAULT_ACTIVATION_WAIT_MS, signal)

      // Starting is one activation, even when the cold readiness gate is still progressing. Its normal
      // reports own readiness; repeating restart here would reset that gate indefinitely.
      if (!up) {log(`[Home] ${agent.slice(0, 8)} not running yet after activation`)}
    },

    readiness: agent => options.handle(agent)?.readiness() ?? { homeAccessible: false, runtimeUsable: false, matrixIntakeWorking: false },

    power: () => 'awake'
  }
}
