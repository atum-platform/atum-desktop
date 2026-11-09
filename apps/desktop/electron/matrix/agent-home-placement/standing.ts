import type { HomeMove, HomePlacement } from './contract'
/**
 * Is this Mac the home of this agent right now? The stand-down fence.
 *
 * "A Mac that isn't the home never answers." Before it admits work, takes a checkpoint, runs an effect
 * or publishes, this Mac asks the platform (the only authority on placement) and compares the answer with
 * itself. The decision is a pure function of the placement record, this Mac's `deviceServiceId` and its
 * journal, so every case is tested without a network:
 *
 *   legacy      the placement model does not govern this agent here (epoch 1, no move, never seen
 *               managed): today's lease and execution policy decide, and nothing in this module
 *               changes that. A platform that has no such route, or does not know the agent (an
 *               app's bot), leaves an agent that was never managed exactly here.
 *   home        this Mac is the placement's exact `deviceServiceId`: it may answer.
 *   draining    this Mac is the home and a move away is under way: the turn in flight finishes, nothing
 *               new is admitted.
 *   activating  this Mac was just made the home and is not yet running the agent: nothing is answered.
 *   elsewhere   another Mac, or the cloud, is the home. This Mac never answers, whatever its lease says.
 *   unknown     the agent IS under the placement model and this Mac cannot tell (the platform is
 *               unreachable or refuses): it holds, because a partitioned old home that keeps
 *               answering is the very thing the fence exists to stop.
 *
 * The lease stays short underneath (90 seconds) and renews only through the existing path; this check
 * is on top of it. What an agent says in a room is fenced by `fenceEmission` below, which never waits on the
 * platform for an agent the model does not govern, and never believes a cached "may act" for one it does.
 * The cached verdict (`check` without `fresh`) is for the app's own synchronous questions and the view; no
 * decision to send, to acknowledge a drain or to sign anything is made from it.
 */
import type { AgentEmissions } from './emissions'
import type { HomeJournal } from './journal'
import type { AgentHomeJournal } from './journal'
import type { HomePlatform } from './platform-client'

export type Standing =
  | { state: 'legacy' }
  | { state: 'home'; placement: HomePlacement }
  /** `quiesced`: the final checkpoint is committed and the drain acknowledged; nothing more is said from here. */
  | { state: 'draining'; placement: HomePlacement; move: HomeMove; quiesced: boolean }
  | { state: 'activating'; placement: HomePlacement }
  | { state: 'elsewhere'; placement: HomePlacement }
  | { state: 'unknown'; reason: 'unreachable' | 'unauthorized' | 'invalid' | 'forbidden' | 'unsupported' | 'not_enrolled' }

/** The moves a source Mac drains for: from the request until the platform commits or ends it. */
const MOVING_AWAY = new Set(['requested', 'draining', 'ready_to_commit'])

/** Has the placement model taken this agent over? An epoch beyond the first needs a committed move. */
export function placementManages(placement: HomePlacement, journal: HomeJournal): boolean {
  return journal.managed || placement.homeEpoch >= 2 || placement.activeMove !== null
}

export function decideStanding(input: { placement: HomePlacement; me: string; journal: HomeJournal }): Standing {
  const { placement, me, journal } = input

  if (!placementManages(placement, journal)) {
    return { state: 'legacy' }
  }

  if (placement.location.kind !== 'mac' || placement.location.deviceServiceId !== me) {
    return { state: 'elsewhere', placement }
  }

  const move = placement.activeMove

  if (move && MOVING_AWAY.has(move.status) && move.source.kind === 'mac' && move.source.deviceServiceId === me) {
    return {
      state: 'draining',
      placement,
      move,
      quiesced: journal.move?.role === 'source' && journal.move.moveId === move.moveId && journal.move.phase === 'drained'
    }
  }

  // Made the home by a committed move, and the agent has not been brought up here yet.
  if (journal.move?.role === 'target' && ['committing', 'activating'].includes(journal.move.phase)) {
    return { state: 'activating', placement }
  }

  return { state: 'home', placement }
}

/** May this Mac admit new work? Only the home, and an agent the model does not manage. */
export const mayAct = (standing: Standing): boolean => standing.state === 'home' || standing.state === 'legacy'

/** May this Mac publish an answer? Also the home that drains for a move, until its drain is acknowledged:
 * the turn in flight finishes and says its piece, because a move waits for it. */
export const mayPublish = (standing: Standing): boolean =>
  mayAct(standing) || (standing.state === 'draining' && !standing.quiesced)

/** May this Mac take a checkpoint of the home? The home, including while it drains for a move. */
export const mayCheckpoint = (standing: Standing): boolean => standing.state === 'home' || standing.state === 'draining'

export interface HomeStandingOptions {
  platform: HomePlatform
  journal: AgentHomeJournal
  /** This Mac's `deviceServiceId`, or null when it is not enrolled. */
  me(): string | null
  now?(): number
  /** How long a "may act" verdict is believed without asking again. */
  cacheMs?: number
  /**
   * How long an agent the model has not taken over waits for the platform before today's rules govern it, so a
   * slow or silent platform cannot hold up its answers. An agent that is managed waits for the full call: it
   * fails closed.
   */
  legacyWaitMs?: number
  log?(line: string): void
}

const DEFAULT_CACHE_MS = 5_000
const DEFAULT_LEGACY_WAIT_MS = 1_500
/** A platform with no such route is asked again this rarely (a deploy, not a restart, changes that). */
const UNSUPPORTED_CACHE_MS = 10 * 60_000

interface Cached {
  standing: Standing
  at: number
  /** How long this verdict is believed without asking again. */
  ttl: number
}

export class HomeStanding {
  private readonly cache = new Map<string, Cached>()
  private readonly inflight = new Map<string, Promise<Standing>>()

  constructor(private readonly options: HomeStandingOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /**
   * Whether the placement model governs this agent here: this Mac's own journal says so (it has seen the agent at an
   * epoch beyond the first, with a move, or it asked for one). A read of the local store; it asks no one and waits for
   * nothing, which is what lets an agent that was never moved send without a round trip to the platform.
   */
  isManaged(agent: string): boolean {
    return this.options.journal.read(agent).managed
  }

  /** The last verdict, however old; undefined if the agent was never checked. */
  last(agent: string): Standing | undefined {
    return this.cache.get(agent)?.standing
  }

  /**
   * A placement the service's pass has just read is a verdict too: the standing it decides is kept like one this
   * class asked for, so the guard and the app's synchronous questions ("is this agent under the model?") are as
   * fresh as the pass, with no second read.
   */
  observe(agent: string, placement: HomePlacement): Standing | undefined {
    const me = this.options.me()
    const journal = this.options.journal.read(agent)

    if (!me) {
      return undefined
    }

    const managed = placementManages(placement, journal)
    const standing = decideStanding({ placement, me, journal: { ...journal, managed } })

    this.cache.set(agent, { standing, at: this.now(), ttl: this.options.cacheMs ?? DEFAULT_CACHE_MS })

    return standing
  }

  invalidate(agent: string): void {
    this.cache.delete(agent)
  }

  /**
   * The standing right now. Without `fresh`, a verdict that lets this Mac act is believed for `cacheMs` and a read
   * already in flight is shared; every other verdict is asked about again at once. **No decision to send, to
   * acknowledge a drain or to sign anything is made from a believed verdict**: every such decision asks with
   * `fresh: true` (`fenceEmission`, `signedCall`, `MacPublications`), because a Mac that has just lost its home must not
   * go on saying things for the length of a cache. The believed verdict is for what only looks (a view, a log line).
   */
  async check(agent: string, signal: AbortSignal, options: { fresh?: boolean } = {}): Promise<Standing> {
    const cached = this.cache.get(agent)

    if (!options.fresh && cached && mayAct(cached.standing) && this.now() - cached.at < cached.ttl) {
      return cached.standing
    }

    const pending = this.inflight.get(agent)

    if (pending && !options.fresh) {
      return pending
    }

    const run = this.read(agent, signal).finally(() => {
      if (this.inflight.get(agent) === run) {
        this.inflight.delete(agent)
      }
    })

    this.inflight.set(agent, run)

    return run
  }

  private async read(agent: string, signal: AbortSignal): Promise<Standing> {
    const journal = this.options.journal.read(agent)
    const me = this.options.me()
    let standing: Standing
    let ttl = this.options.cacheMs ?? DEFAULT_CACHE_MS

    if (!me) {
      standing = journal.managed ? { state: 'unknown', reason: 'not_enrolled' } : { state: 'legacy' }
    } else {
      // Not yet seen under the model: do not let a slow platform hold up what today's rules would allow.
      const bounded = journal.managed
        ? signal
        : AbortSignal.any([signal, AbortSignal.timeout(this.options.legacyWaitMs ?? DEFAULT_LEGACY_WAIT_MS)])

      const result = await this.options.platform.readPlacement(agent, bounded)

      if (result.ok === true) {
        const managed = placementManages(result.value, journal)

        if (managed && !journal.managed) {
          this.options.journal.update(agent, entry => {
            entry.managed = true
            entry.homeId = result.value.homeId
          })
        }

        standing = decideStanding({ placement: result.value, me, journal: { ...journal, managed } })
      } else if (!journal.managed) {
        // The model has not taken this agent: a platform without the routes, one that does not know the
        // agent, or a bad moment, leave today's behaviour exactly as it is.
        standing = { state: 'legacy' }

        if (result.kind === 'unsupported') {
          ttl = UNSUPPORTED_CACHE_MS
        }
      } else {
        const reason =
          result.kind === 'unsupported'
            ? 'unsupported'
            : result.kind === 'forbidden'
              ? 'forbidden'
              : result.kind === 'unauthorized'
                ? 'unauthorized'
                : result.kind === 'invalid'
                  ? 'invalid'
                  : 'unreachable'

        standing = { state: 'unknown', reason }
      }
    }

    const previous = this.cache.get(agent)?.standing

    this.cache.set(agent, { standing, at: this.now(), ttl })

    if (previous?.state !== standing.state) {
      this.options.log?.(`[Home] ${agent.slice(0, 8)} standing ${previous?.state ?? 'new'} -> ${standing.state}`)
    }

    return standing
  }
}

/** Thrown to a caller that asked to act while this Mac is not the home. A closed code, never a path or a name. */
export class NotTheHomeError extends Error {
  constructor(readonly standing: Standing['state']) {
    super('matrix_agent_not_home')
    this.name = 'NotTheHomeError'
  }
}

/**
 * Everything the agent can put into a room, or a room's state, as itself: the commands of its SDK host that make
 * the agent say something (the stand-down fence's cut), and `sendTaskFiles`, the owner's own message to the agent that
 * the app sends for a Drive task (it comes from the owner's session, so the guard on the agent's queue never sees it;
 * `fenceEmission` is called for it by hand). Typing and read receipts are not here: they say nothing in a room.
 */
export const AGENT_PUBLISH_KINDS: ReadonlySet<string> = new Set([
  'publishResult',
  'publishCron',
  'publishNotice',
  'publishGroupNotice',
  'sendAgentTask',
  'sendTaskFiles'
])

export interface EmissionGuard {
  /** The principal of the agent the queue belongs to (absent: the queue is not an agent's). */
  agent?(): string | undefined
  standing: HomeStanding
  signal?(): AbortSignal
  /** A refusal that needs no platform: this Mac has itself stood the agent down. Checked first, every time. */
  stoodDown?(agent: string): boolean
  /**
   * Whether the placement model governs the agent: a synchronous answer from this Mac's own journal. Absent, it is the
   * standing service's (`HomeStanding.isManaged`). An agent it does not govern is never made to wait for anything.
   */
  managed?(agent: string): boolean
  /** The drain barrier is up for the agent: it emits only through the platform's outbox, and nothing direct is allowed. */
  outboxOnly?(agent: string): boolean
  /** Counts the agent's direct sends so a drain waits for them. */
  flights?: AgentEmissions
  /** The agent said something (the cadence's idea of activity). */
  activity?(agent: string): void
  /**
   * An agent the model does not govern has just said something: look at its placement in the background, soon. It is a
   * request, not a question: the send does not wait for it and does not depend on its answer.
   */
  discover?(agent: string): void
  /**
   * An agent the placement model governs does not send its results into a room itself: this takes a `publishResult`
   * of such an agent and returns the event id once the platform has sent it. The command is never sent from here on
   * this path: `send` is the raw queue (for preparing the bytes), and `direct` is the one exception, a send the hook
   * may make only when the platform's worker is switched off and nothing of the result was ever enqueued. `direct`
   * is fenced like any other direct send. Absent: a result is fenced like every other command.
   */
  outbox?(
    command: Record<string, unknown>,
    context: {
      agent: string
      send: (value: unknown, timeoutMs?: number) => Promise<unknown>
      direct: (value: unknown, timeoutMs?: number) => Promise<unknown>
      timeoutMs?: number
    }
  ): Promise<unknown>
}

/**
 * The one decision about whether this Mac may say something in a room as an agent, for every kind in
 * `AGENT_PUBLISH_KINDS`. In order:
 *
 *   1. This Mac stood the agent down: refused, with no question to anyone.
 *   2. The model does not govern the agent (the journal says so, synchronously): `send` at once. Nothing waits on the
 *      platform; the app's background pass is what finds out that an agent has been given a move.
 *   3. A governed agent's `publishResult` goes only through the platform's outbox (`outbox`), and nowhere else.
 *   4. Everything else of a governed agent (a routine's result, a notice, a status line, a group notice, a task
 *      event, an owner's task files) has no ledger operation the outbox could carry, so it is sent directly, and only
 *      from the Mac the platform names as the home RIGHT NOW (a fresh read, never a remembered one), only while the
 *      drain barrier is down, and counted while it is in flight so a drain waits for it.
 *
 * The barrier (`AgentEmissions`) closes the rest: when a move away begins draining, the agent is switched to
 * outbox-only and what was in flight is waited for before the drain is acknowledged. A direct send before that comes
 * from the current home; none follows.
 */
export async function fenceEmission(
  guard: EmissionGuard,
  agent: string,
  kind: string,
  command: unknown,
  send: (value: unknown, timeoutMs?: number) => Promise<unknown>,
  timeoutMs?: number
): Promise<unknown> {
  guard.activity?.(agent)

  if (guard.stoodDown?.(agent)) {
    throw new NotTheHomeError('elsewhere')
  }

  const flights = guard.flights
  const managed = guard.managed ? guard.managed(agent) : guard.standing.isManaged(agent)

  if (!managed) {
    guard.discover?.(agent)

    return flights ? flights.track(agent, () => send(command, timeoutMs)) : send(command, timeoutMs)
  }

  const signal = guard.signal?.() ?? AbortSignal.timeout(20_000)

  const direct = (value: unknown, timeout?: number): Promise<unknown> => {
    const run = async (): Promise<unknown> => {
      if (guard.stoodDown?.(agent)) {
        throw new NotTheHomeError('elsewhere')
      }

      if (guard.outboxOnly?.(agent)) {
        throw new NotTheHomeError('draining')
      }

      // The platform is asked now. A verdict from a few seconds ago is how a Mac that has just lost its home says one
      // more thing, and nothing here is cheap enough to be worth that.
      const standing = await guard.standing.check(agent, signal, { fresh: true })

      if (!mayPublish(standing)) {
        throw new NotTheHomeError(standing.state)
      }

      // The barrier went up, or the agent was stood down, while the platform was being asked.
      if (guard.stoodDown?.(agent)) {
        throw new NotTheHomeError('elsewhere')
      }

      if (guard.outboxOnly?.(agent)) {
        throw new NotTheHomeError('draining')
      }

      return send(value, timeout)
    }

    return flights ? flights.track(agent, run) : run()
  }

  if (kind === 'publishResult' && guard.outbox) {
    return guard.outbox(command as Record<string, unknown>, { agent, send, direct, timeoutMs })
  }

  return direct(command, timeoutMs)
}

/**
 * Guards one agent host's command queue: every command that makes the agent say something goes through
 * `fenceEmission`. The queue is otherwise untouched.
 */
export function guardAgentPublication<Q extends { command(value: unknown, timeoutMs?: number): Promise<unknown> }>(
  queue: Q,
  guard: EmissionGuard & { agent(): string | undefined }
): Q {
  const send = queue.command.bind(queue)

  queue.command = async (value: unknown, timeoutMs?: number) => {
    const kind = value && typeof value === 'object' ? (value as { kind?: unknown }).kind : undefined
    const agent = guard.agent()

    if (typeof kind === 'string' && AGENT_PUBLISH_KINDS.has(kind) && agent) {
      return fenceEmission(guard, agent, kind, value, send, timeoutMs)
    }

    return send(value, timeoutMs)
  }

  return queue
}
