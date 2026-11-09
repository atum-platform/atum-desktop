/**
 * The Mac's agent-home model, running in the app: the loop that reconciles every agent with the platform, the
 * holds that keep a stood-down agent stopped, and the two things the owner can ask for.
 *
 * It owns no logic of its own about moves (that is `controller.ts` and the flows under it). It decides WHEN each
 * agent is looked at, keeps the answers where the rest of the app can ask for them cheaply, and keeps itself out
 * of the way: a platform without the routes is asked rarely, an agent the model has not taken over is looked at
 * slowly and changed not at all, and nothing here runs for a signed-out account.
 *
 *   a move in flight                    every `fastMs`   (the move is waiting for this Mac)
 *   every other agent                    every `slowMs`   (is a move being asked for? is it managed now?)
 */
import type { CheckpointCadence } from './cadence'
import type { AgentHomeController, AgentHomeView, RequestMoveResult } from './controller'
import type { AgentHomeHolds } from './holds'
import type { HomePlatform } from './platform-client'

export interface AgentHomeServiceOptions {
  controller: AgentHomeController
  holds: AgentHomeHolds
  /** The agent principals that run on this Mac (or could), now. */
  agents(): readonly string[]
  /** Signed in and not closing: nothing runs otherwise. */
  ready(): boolean
  /** The signed-in account's identity: a change ends passes in flight and forgets what was learnt. */
  scope(): string | null
  now?(): number
  fastMs?: number
  slowMs?: number
  /**
   * The checkpoint cadence. Looked at every beat (it keeps its own, slower, rhythm) and never waited for: a checkpoint
   * takes minutes, a move must be noticed in seconds.
   */
  cadence?: CheckpointCadence
  /** A view changed: the app publishes its state again. */
  changed?(): void
  /** An agent is no longer on this Mac: whatever was kept about it elsewhere (catalog pace, owner view) goes too. */
  forget?(agent: string): void
  log?(line: string): void
}

export const DEFAULT_FAST_MS = 4_000
export const DEFAULT_SLOW_MS = 30_000
/** The loop's own beat; an agent is looked at when its time has come, never faster than this. */
const BEAT_MS = 1_000

export class AgentHomeService {
  private readonly seeded = new Set<string>()
  private readonly nextAt = new Map<string, number>()
  private readonly lastView = new Map<string, string>()
  private abort = new AbortController()
  private scopeKey: string | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private stopped = true

  constructor(private readonly options: AgentHomeServiceOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  // ------------------------------------------------------------------------------------ what the app asks

  /** Whether this Mac keeps the agent's local writers off: the answer `isMovingAgent` adds to its own. */
  holds(agent: string): boolean {
    this.seed(agent)

    return this.options.holds.has(agent)
  }

  view(agent: string): AgentHomeView | null {
    return this.options.controller.view(agent)
  }

  get controller(): AgentHomeController {
    return this.options.controller
  }

  /** Ends when the account changes or the app stops: what waits on the platform for this Mac stops waiting with it. */
  get signal(): AbortSignal {
    return this.abort.signal
  }

  /** The owner asks to move the agent to another of their Macs. */
  async move(agent: string, target: string): Promise<RequestMoveResult> {
    if (!this.options.ready()) {
      return { ok: false, reason: 'unavailable' }
    }

    const result = await this.options.controller.requestMove(agent, target, AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]))

    if (result.ok === true) {
      this.kick(agent)
    }

    return result
  }

  /** The owner cancels the move in flight. */
  async cancel(agent: string): Promise<{ ok: boolean }> {
    if (!this.options.ready()) {
      return { ok: false }
    }

    const result = await this.options.controller.cancelMove(agent, AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]))

    if (result.ok) {
      this.kick(agent)
    }

    return result
  }

  // ------------------------------------------------------------------------------------------- the loop

  start(): void {
    if (!this.stopped) {
      return
    }

    this.stopped = false
    this.schedule(BEAT_MS)
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
    this.abort.abort()
    this.abort = new AbortController()
    this.options.cadence?.cancelAll()
  }

  /** Look at this agent (or all of them) at the next beat instead of when its time comes. */
  kick(agent?: string): void {
    for (const each of agent ? [agent] : this.options.agents()) {
      this.nextAt.set(each, 0)
    }

    if (!this.stopped) {
      this.schedule(0)
    }
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick().finally(() => {
        if (!this.stopped) {
          this.schedule(BEAT_MS)
        }
      })
    }, ms)
    this.timer.unref?.()
  }

  /** One beat: every agent whose time has come is reconciled. Never throws. */
  tick(): Promise<void> {
    if (this.running) {
      return this.running
    }

    const run = this.beat().finally(() => {
      if (this.running === run) {
        this.running = undefined
      }
    })

    this.running = run

    return run
  }

  private async beat(): Promise<void> {
    const scope = this.options.scope()

    if (scope !== this.scopeKey) {
      // Another account, or none: what was learnt about the previous one's agents is not this one's.
      this.scopeKey = scope
      this.abort.abort()
      this.abort = new AbortController()
      this.options.cadence?.cancelAll()
      this.nextAt.clear()
      this.lastView.clear()
    }

    if (!this.options.ready() || !scope) {
      return
    }

    const agents = new Set(this.options.agents())

    for (const known of [...this.seeded]) {
      if (!agents.has(known)) {
        this.seeded.delete(known)
        this.nextAt.delete(known)
        this.lastView.delete(known)
        this.options.holds.forget(known)
        this.options.cadence?.forget(known)
        this.options.forget?.(known)
      }
    }

    const now = this.now()
    const signal = this.abort.signal
    let changed = false

    await Promise.all(
      [...agents].map(async agent => {
        this.seed(agent)

        if ((this.nextAt.get(agent) ?? 0) > now || signal.aborted) {
          return
        }

        // Pushed far out first, so a pass that dies does not make this agent a hot loop.
        this.nextAt.set(agent, now + (this.options.slowMs ?? DEFAULT_SLOW_MS))

        try {
          const view = await this.options.controller.reconcile(agent, signal)

          // A move that has begun, or a hold, ends a checkpoint in flight at once: the move's own comes after it.
          if (view?.move || this.options.holds.has(agent)) {
            this.options.cadence?.cancel(agent)
          }

          // Only a move in flight needs fast reconciliation; managed placement is otherwise idle.
          const busy = view !== null && view.move !== null
          this.nextAt.set(agent, this.now() + (busy ? (this.options.fastMs ?? DEFAULT_FAST_MS) : (this.options.slowMs ?? DEFAULT_SLOW_MS)))
          const shown = JSON.stringify(view)

          if (this.lastView.get(agent) !== shown) {
            this.lastView.set(agent, shown)
            changed = true
          }
        } catch (error) {
          if (!signal.aborted) {
            this.options.log?.(`[Home] ${agent.slice(0, 8)} pass failed: ${error instanceof Error ? error.message : 'unknown'}`)
          }
        }
      })
    )

    if (!signal.aborted) {
      this.options.cadence?.tick([...agents])
    }

    if (changed && !signal.aborted) {
      this.options.changed?.()
    }
  }

  private seed(agent: string): void {
    if (!this.seeded.has(agent)) {
      this.seeded.add(agent)
      this.options.holds.seed(agent)
    }
  }
}

/**
 * A platform that has no such routes is asked about each agent only now and then, so an app that is ahead of its
 * platform does not hit it on every beat. Only the placement read is remembered; a move the owner asks for is
 * always sent.
 */
export function rememberUnsupported(inner: HomePlatform, options: { now(): number; ttlMs?: number }): HomePlatform {
  const until = new Map<string, number>()
  const ttl = options.ttlMs ?? 10 * 60_000

  return {
    async readPlacement(agent, signal) {
      if (options.now() < (until.get(agent) ?? 0)) {
        return { ok: false, kind: 'unsupported', status: 404 }
      }

      const result = await inner.readPlacement(agent, signal)

      if (result.ok === false && result.kind === 'unsupported') {
        until.set(agent, options.now() + ttl)
      } else {
        until.delete(agent)
      }

      return result
    },
    requestMove: (agent, input, signal) => inner.requestMove(agent, input, signal),
    commitMove: (agent, input, signal) => inner.commitMove(agent, input, signal),
    abortMove: (agent, input, signal) => inner.abortMove(agent, input, signal),
    ackDrain: (agent, body, signal) => inner.ackDrain(agent, body, signal),
    reserveCheckpoint: (agent, body, signal) => inner.reserveCheckpoint(agent, body, signal),
    commitCheckpoint: (agent, body, signal) => inner.commitCheckpoint(agent, body, signal),
    reportReadiness: (agent, body, signal) => inner.reportReadiness(agent, body, signal),
    enqueuePublication: (agent, envelope, signal) => inner.enqueuePublication(agent, envelope, signal)
  }
}
