/**
 * The Mac's whole part in an agent's home, one agent at a time (`atum.agent-home/2.1`, slice 1: manual Mac moves).
 *
 * `reconcile(agent)` is the one pass that everything hangs from. It reads the platform's placement (the only
 * authority), compares it with this Mac and its journal, and does the next thing that is this Mac's to do:
 *
 *   a move whose SOURCE is this Mac        drain, acknowledge, final checkpoint, wait, stand down   (move-source.ts)
 *   a move whose TARGET is this Mac        verify, commit, restore, activate                         (move-target.ts)
 *   a journaled move that has ended        finish it: stand down, answer again, or finish activating
 *   this Mac is the settled home           report readiness, now and then                            (readiness.ts)
 *
 * It is safe to call as often as one likes and from a restart at any point: one pass at a time per agent, every
 * step journaled before it is taken, every platform operation idempotent. An agent the placement model has not
 * taken over (epoch 1, no move, never seen managed) is left exactly as it is: nothing here changes how a legacy
 * agent answers, and a platform that has no such routes changes nothing at all.
 *
 * The owner's two operations are `requestMove` and `cancelMove`; both go to the platform and nowhere else, and
 * whichever Mac the owner is using may ask: the source and the target find out by reading the placement.
 */
import { randomUUID } from 'node:crypto'

import type { HomeArchiveStore, HomeSealKeySource } from './archive-store'
import { type CheckpointOutcome, takeCheckpoint } from './checkpoint'
import type { PlacementConnectionAuth } from './connection-auth'
import type { AgentHomeConnectionParticipant } from './connection-participant'
import type { PlacementConnectionPlatform } from './connection-platform'
import type { CheckpointReason, HomeLocation, HomeMove, HomePlacement } from './contract'
import type { MacExecutorAuth } from './executor-auth'
import type { HomeTool } from './home-tool'
import { AgentHomeJournal, type JournalStore } from './journal'
import { checkpointDepsOf, finishSource, runSource } from './move-source'
import { activate, recoverTarget, runTarget } from './move-target'
import type { HomePlatform } from './platform-client'
import { type ReadinessResult, reportReadiness } from './readiness'
import { RetryLedger } from './retry-ledger'
import { DEFAULT_BUDGETS, type HomeContext, type HomeRuntimeOps, realSleep } from './runtime-ops'
import { HomeStanding, placementManages } from './standing'

/** A move in plain steps, for the agent's settings. */
export type MoveStep = 'asking' | 'saving' | 'handing_over' | 'taking_over'

export interface AgentHomeView {
  lives: { kind: 'cloud' } | { kind: 'mac'; deviceServiceId: string; thisMac: boolean }
  move: null | {
    step: MoveStep
    from: HomeLocation
    to: HomeLocation
    /** What this Mac is doing in it. */
    role: 'source' | 'target' | 'other'
  }
  /** The owner may ask for a move now (the home is a Mac and nothing is moving). */
  canMove: boolean
  /** Why the last attempt did not finish, as a closed code; null when nothing is wrong. */
  issue: string | null
  activation?: { state: 'ready' | 'not_ready'; reason: string | null }
}

export type RequestMoveResult =
  | { ok: true; moveId: string }
  | { ok: false; reason: 'unsupported' | 'not_enrolled' | 'cloud_source' | 'already_there' | 'busy' | 'stale' | 'forbidden' | 'unavailable' }

export interface ControllerOptions {
  platform: HomePlatform
  auth: MacExecutorAuth
  tool: HomeTool
  store: HomeArchiveStore
  keys: HomeSealKeySource
  journalStore: JournalStore
  runtime: HomeRuntimeOps
  connection?: { platform: PlacementConnectionPlatform; auth: PlacementConnectionAuth }
  participant?: AgentHomeConnectionParticipant
  me(): string | null
  dirs: HomeContext['dirs']
  budgets?: Partial<HomeContext['budgets']>
  now?(): number
  uuid?(): string
  /** How a flow waits (a commit that meets a publication in flight); the clock's own by default. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>
  log?(line: string): void
  /** How long a "may act" standing is believed without asking the platform again. */
  standingCacheMs?: number
  /** How often the home Mac reports readiness. */
  readinessEveryMs?: number
  /** Test seam: see `HomeContext.step`. */
  step?(name: string): void
  /**
   * A pass read the placement of an agent the model manages and this Mac is not its home (another Mac, or the
   * cloud): the app stops it here once per observed home epoch. Not called for the Mac a
   * committed move has made the home, whatever the journal still says about the move.
   */
  notHome?(agent: string): Promise<void>
}

const DEFAULT_READINESS_MS = 60_000

const isLocation = (location: HomeLocation, me: string | null): boolean =>
  location.kind === 'mac' && me !== null && location.deviceServiceId === me

export class AgentHomeController {
  readonly ctx: HomeContext
  readonly standing: HomeStanding
  private readonly running = new Map<string, Promise<AgentHomeView | null>>()
  private readonly views = new Map<string, AgentHomeView | null>()
  private readonly issues = new Map<string, string>()
  private readonly stoodDown = new Map<string, number>()
  private readonly lastReport = new Map<string, number>()
  private readonly readinessEveryMs: number
  private readonly notHome?: (agent: string) => Promise<void>
  private readonly participant?: AgentHomeConnectionParticipant

  constructor(options: ControllerOptions) {
    const now = options.now ?? Date.now
    const journal = new AgentHomeJournal(options.journalStore)
    this.notHome = options.notHome
    this.participant = options.participant

    this.standing = new HomeStanding({
      platform: options.platform,
      journal,
      me: options.me,
      now,
      cacheMs: options.standingCacheMs,
      log: options.log
    })

    this.readinessEveryMs = options.readinessEveryMs ?? DEFAULT_READINESS_MS

    this.ctx = {
      platform: options.platform,
      auth: options.auth,
      tool: options.tool,
      store: options.store,
      keys: options.keys,
      journal,
      standing: this.standing,
      connection: options.connection,
      runtime: options.runtime,
      retry: new RetryLedger({ now, uuid: options.uuid }),
      me: options.me,
      dirs: options.dirs,
      budgets: { ...DEFAULT_BUDGETS, ...options.budgets },
      sleep: options.sleep ?? realSleep,
      now,
      uuid: options.uuid ?? randomUUID,
      log: options.log ?? (() => undefined),
      step: options.step
    }
  }

  /** The last view built for the agent; null when the platform has nothing to say about it. */
  view(agent: string): AgentHomeView | null {
    return this.views.get(agent) ?? null
  }

  /** One pass for one agent. A second call while one runs shares it. */
  reconcile(agent: string, signal: AbortSignal): Promise<AgentHomeView | null> {
    const running = this.running.get(agent)

    if (running) {
      return running
    }

    const pass = this.pass(agent, signal).finally(() => {
      if (this.running.get(agent) === pass) {
        this.running.delete(agent)
      }
    })

    this.running.set(agent, pass)

    return pass
  }

  // -------------------------------------------------------------------------------- the pass

  private async pass(agent: string, signal: AbortSignal): Promise<AgentHomeView | null> {
    const { ctx } = this
    const me = ctx.me()
    const read = await ctx.platform.readPlacement(agent, signal)

    if (read.ok === false) {
      // No such routes, not an eligible agent, or a bad moment: an agent never managed shows nothing and
      // changes nothing; a managed one keeps its last view with the reason.
      const known = this.views.get(agent) ?? null

      if (known) {
        this.issues.set(agent, read.kind === 'unsupported' ? 'platform_unsupported' : `platform_${read.kind}`)

        return this.remember(agent, { ...known, issue: this.issues.get(agent)! })
      }

      this.views.set(agent, null)

      return null
    }

    let placement = read.value
    const journal = ctx.journal.read(agent)

    if (placementManages(placement, journal) && !journal.managed) {
      ctx.journal.update(agent, entry => {
        entry.managed = true
        entry.homeId = placement.homeId
      })
    }

    // What the platform just said is the Mac's current verdict: the guard and the app's questions read it.
    this.standing.observe(agent, placement)

    let acted = false
    let issue: string | null = null

    if (me) {
      const move = placement.activeMove
      const entry = ctx.journal.read(agent).move
      const mine = isLocation(placement.location, me)

      // A managed agent whose home is somewhere else does not run here, whatever else this Mac knows about it.
      if (!mine && ctx.journal.read(agent).managed) {
        if (this.stoodDown.get(agent) !== placement.homeEpoch) {
          await this.notHome?.(agent)
          this.stoodDown.set(agent, placement.homeEpoch)
        }
      } else {
        this.stoodDown.delete(agent)
      }

      if (move && mine && move.source.kind === 'mac' && move.source.deviceServiceId === me && MOVING.has(move.status)) {
        const result = await runSource(ctx, agent, placement, move, signal)
        acted = true
        // A move that ended without a commit says why (the agent answers again; the owner should know it stayed).
        issue =
          result.step === 'failed' || result.step === 'checkpointing' || result.step === 'resumed'
            ? (result.detail ?? result.step)
            : null
      } else if (move && move.target.kind === 'mac' && move.target.deviceServiceId === me) {
        const result = await runTarget(ctx, agent, placement, move, signal)
        acted = result.step !== 'waiting_for_source'
        issue = result.step === 'failed' || result.step === 'abandoned' ? (result.detail ?? result.step) : null
      } else if (entry?.role === 'source') {
        const result = await finishSource(ctx, agent, placement, signal)
        acted = true
        issue = result.step === 'failed' ? (result.detail ?? null) : null
      } else if (entry?.role === 'target') {
        const result = await recoverTarget(ctx, agent, placement, signal)
        acted = true
        issue = result.step === 'failed' ? (result.detail ?? null) : null
      } else if (mine && placementManages(placement, ctx.journal.read(agent))) {
        await this.maybeReport(agent, signal)
      }
    }

    if (acted) {
      // What was done changed the placement; the view shows what the platform says now.
      const after = await ctx.platform.readPlacement(agent, signal)

      if (after.ok === true) {
        placement = after.value
      }
    }

    if (issue) {
      this.issues.set(agent, issue)
    } else if (acted || this.issues.get(agent)?.startsWith('platform_')) {
      // The platform answered this pass: a `platform_*` reason from an earlier unreachable
      // read is over (the app must stop saying it is not connected). A move's own failure from
      // an earlier pass stays until the next action, so its diagnosis is not erased unseen.
      this.issues.delete(agent)
    }

    if (this.participant) {
      try {
        await this.participant.reconcile(agent, placement, signal)
      } catch (error) {
        if (!signal.aborted) {
          ctx.log(`[Home] ${agent.slice(0, 8)} connection reconcile failed: ${error instanceof Error ? error.message : 'unknown'}`)
        }
      }
    }

    return this.remember(agent, this.build(placement, me, this.issues.get(agent) ?? null))
  }

  /** The home Mac's readiness report, when one is due. */
  private async maybeReport(agent: string, signal: AbortSignal): Promise<ReadinessResult | null> {
    const last = this.lastReport.get(agent)

    if (last !== undefined && this.ctx.now() - last < this.readinessEveryMs) {
      return null
    }

    this.lastReport.set(agent, this.ctx.now())

    return reportReadiness(this.ctx, agent, signal)
  }

  /** A readiness report now, whatever the interval (also the way a test or a status check asks). */
  async report(agent: string, signal: AbortSignal): Promise<ReadinessResult> {
    this.lastReport.set(agent, this.ctx.now())

    return reportReadiness(this.ctx, agent, signal)
  }

  // ------------------------------------------------------------------------------ the view

  private remember(agent: string, view: AgentHomeView | null): AgentHomeView | null {
    this.views.set(agent, view)

    return view
  }

  private build(placement: HomePlacement, me: string | null, issue: string | null): AgentHomeView {
    const move = placement.activeMove
    const mineAsSource = move && isLocation(move.source, me)
    const mineAsTarget = move && isLocation(move.target, me)
    const entry = this.ctx.journal.read(placement.agentPrincipal).move

    return {
      lives:
        placement.location.kind === 'cloud'
          ? { kind: 'cloud' }
          : { kind: 'mac', deviceServiceId: placement.location.deviceServiceId, thisMac: placement.location.deviceServiceId === me },
      move: move
        ? {
            step: stepOf(move, entry?.role === 'target' && ['restoring', 'restored', 'committing', 'activating'].includes(entry.phase)),
            from: move.source,
            to: move.target,
            role: mineAsSource ? 'source' : mineAsTarget ? 'target' : 'other'
          }
        : null,
      canMove: !move && me !== null,
      issue,
      ...(isLocation(placement.location, me) && placementManages(placement, this.ctx.journal.read(placement.agentPrincipal))
        ? { activation: this.activationState(placement.agentPrincipal, issue) } : {})
    }
  }

  private activationState(agent: string, issue: string | null): NonNullable<AgentHomeView['activation']> {
    const checks = this.ctx.runtime.readiness(agent)
    const journal = this.ctx.journal.read(agent)
    const application = this.participant?.projection(agent)
    const modelReason = journal.modelHold ? (application?.reason ?? 'model_unavailable') : null
    const ready = !journal.move && !journal.modelHold && Boolean(this.ctx.runtime.leaseFacts(agent)) &&
      checks.homeAccessible && checks.runtimeUsable && checks.matrixIntakeWorking
    return { state: ready ? 'ready' : 'not_ready', reason: ready ? null : modelReason ?? issue ?? 'runtime_not_ready' }
  }

  // -------------------------------------------------------------------- the owner's operations

  async requestMove(agent: string, targetDeviceServiceId: string, signal: AbortSignal): Promise<RequestMoveResult> {
    const { ctx } = this

    if (!ctx.me()) {
      return { ok: false, reason: 'not_enrolled' }
    }

    const read = await ctx.platform.readPlacement(agent, signal)

    if (read.ok === false) {
      return { ok: false, reason: read.kind === 'unsupported' ? 'unsupported' : read.kind === 'forbidden' ? 'forbidden' : 'unavailable' }
    }

    const placement = read.value

    if (placement.location.kind !== 'mac') {
      return { ok: false, reason: 'cloud_source' }
    }

    if (placement.location.deviceServiceId === targetDeviceServiceId) {
      return { ok: false, reason: 'already_there' }
    }

    // A move needs the platform's archive and key routes to finish. Find out before the agent is disturbed:
    // asking for a move that cannot end would stop the agent for as long as it takes to find that out. The routes admit
    // the placement's Mac and the target of its active move (atum-platform #664), so only the home Mac can ask them
    // yet; from the owner's other Mac the move is asked without the probe, and the home Mac finds out when it takes the
    // final checkpoint (a move that cannot finish ends there, after the tries it is allowed).
    if (placement.location.deviceServiceId === ctx.me()) {
      const probe = await ctx.keys.key({ agent, homeId: placement.homeId }, signal)

      if (probe.ok === false) {
        return { ok: false, reason: probe.kind === 'unsupported' ? 'unsupported' : probe.kind === 'forbidden' ? 'forbidden' : 'unavailable' }
      }
    }

    const answer = await ctx.platform.requestMove(
      agent,
      {
        moveId: ctx.uuid(),
        idempotencyKey: ctx.uuid(),
        target: { kind: 'mac', deviceServiceId: targetDeviceServiceId },
        expectedHomeEpoch: placement.homeEpoch,
        expectedPlacementRevision: placement.placementRevision
      },
      signal
    )

    if (answer.ok === false) {
      return { ok: false, reason: answer.kind === 'conflict' ? 'stale' : answer.kind === 'forbidden' ? 'forbidden' : answer.kind === 'unsupported' ? 'unsupported' : 'unavailable' }
    }

    ctx.journal.update(agent, entry => {
      entry.managed = true
      entry.homeId = placement.homeId
    })
    this.standing.invalidate(agent)
    this.issues.delete(agent)

    return { ok: true, moveId: answer.value.move.moveId }
  }

  /** Cancel the move in flight. The agent goes on answering from where it is: nothing was committed. */
  async cancelMove(agent: string, signal: AbortSignal): Promise<{ ok: boolean }> {
    const { ctx } = this
    const read = await ctx.platform.readPlacement(agent, signal)

    if (read.ok === false || !read.value.activeMove) {
      return { ok: false }
    }

    const answer = await ctx.platform.abortMove(
      agent,
      {
        moveId: read.value.activeMove.moveId,
        idempotencyKey: read.value.activeMove.idempotencyKey,
        expectedHomeEpoch: read.value.homeEpoch,
        expectedPlacementRevision: read.value.placementRevision,
        reason: 'owner_cancelled'
      },
      signal
    )

    this.standing.invalidate(agent)

    return { ok: answer.ok === true && ['aborted', 'already_aborted'].includes(answer.value) }
  }

  /** A checkpoint of the home this Mac holds: the owner's ('manual', the default) or the cadence's ('cadence_dirty', 'idle'). */
  checkpoint(agent: string, signal: AbortSignal, reason: CheckpointReason = 'manual'): Promise<CheckpointOutcome> {
    return takeCheckpoint(checkpointDepsOf(this.ctx), { agent, reason }, signal)
  }

  /** Finish an activation that a restart interrupted (also called by the pass). */
  resumeActivation(agent: string, signal: AbortSignal) {
    return activate(this.ctx, agent, signal)
  }
}

const MOVING: ReadonlySet<string> = new Set(['requested', 'draining', 'ready_to_commit'])

function stepOf(move: HomeMove, takingOver: boolean): MoveStep {
  if (takingOver) {
    return 'taking_over'
  }

  return move.status === 'requested' ? 'asking' : move.status === 'draining' ? 'saving' : 'handing_over'
}
