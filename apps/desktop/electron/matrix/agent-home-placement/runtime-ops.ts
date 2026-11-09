/**
 * What the placement model needs of the running Mac, and the context its flows share.
 *
 * `HomeRuntimeOps` is the one place the model touches what already exists: the agent's runtime, listener and
 * answering lease (`main.ts`, `runtime-drain.ts`, `lease.ts`). The flows (`move-source.ts`, `move-target.ts`,
 * `readiness.ts`, `checkpoint.ts`) are written against it, so they are tested with a fake runtime that keeps
 * the same promises, and main wires the real one in a single place.
 */
import type { HomeArchiveStore, HomeSealKeySource } from './archive-store'
import type { PlacementConnectionAuth } from './connection-auth'
import type { PlacementConnectionPlatform } from './connection-platform'
import type { MacExecutorAuth } from './executor-auth'
import type { LeaseFacts } from './fence'
import type { HomeTool } from './home-tool'
import type { AgentHomeJournal } from './journal'
import type { HomePlatform } from './platform-client'
import type { RetryLedger } from './retry-ledger'
import type { HomeStanding } from './standing'

export type DrainResult = 'quiesced' | 'timed_out'

export interface HomeRuntimeOps {
  /** The agent's Hermes home on this Mac, or null when it has none. */
  home(agent: string): string | null
  /** Create/recover this target's enrollment and local home without admitting work. */
  materialize(agent: string, signal: AbortSignal): Promise<string | null>
  /** The answering lease's facts for the fence (`MatrixExecutorLease.fenceFacts`); null without a live term. */
  leaseFacts(agent: string): LeaseFacts | null
  /**
   * Stop admitting new work and wait, up to `budgetMs`, for the turn in flight (and its publication) to end. Then the
   * agent is switched to the platform's outbox only, and the answer waits for every direct send already in flight to
   * land: `quiesced` means the agent has said everything it will say from this Mac as the home, and can say nothing
   * directly from now on. The drain acknowledgement is signed on that word and no earlier.
   * Idempotent: asked again while already quiesced it answers `quiesced` at once.
   */
  drain(agent: string, budgetMs: number, signal: AbortSignal): Promise<DrainResult>
  /**
   * Hold every writer of the home still (executor, jobs, gateways, listening); the function returned lets them go.
   * This STOPS the agent's executor and starts it again afterwards, which is a cold start and loses what lives only in
   * that process. It is for a checkpoint taken because the agent is leaving or the owner asked (`move_drain`,
   * `manual`); the cadence's checkpoints (`cadence_dirty`, `idle`) never use it: they ask `atRest`, hold the writers still
   * only for a snapshot (`holdWrites`), and capture from that beside the running agent.
   */
  quiesce(agent: string): Promise<() => Promise<void>>
  /**
   * The agent is between turns, and what Hermes does after an answer (its memory and skill review) has finished:
   * nothing of its own is writing its home. Asked without disturbing anything: nothing is stopped, held or waited for.
   * False means "not now" and the cadence asks again at its next look. It is a good moment, not a lock: a turn may
   * begin the instant after, which is why the writers are held (`holdWrites`) for the snapshot that is taken from it.
   */
  atRest(agent: string): Promise<boolean>
  /**
   * Hold the agent's writers still for the moment it takes to stage a snapshot of the home: admit no new write to it (a turn
   * that arrives meanwhile waits, in order, and is let in when the hold ends), and find none in flight, Hermes's own review of
   * the last answer included. Returns the function that lets them go, or null when they cannot be held now: the checkpoint is
   * then not taken and the cadence asks again at its next look. Nothing is stopped and nothing waits for a turn: the executor,
   * its sessions and everything that lives only in them stay as they are. The caller lets go as soon as the snapshot is staged
   * (a fraction of a second), never after the capture, the seal or the upload.
   */
  holdWrites(agent: string): Promise<(() => void) | null>
  /** A drain that did not end in a move: the agent answers again (and may send directly again). */
  resume(agent: string): Promise<void>
  /** This Mac stopped being the home: stop the executor and listener and give up the answering lease. */
  standDown(agent: string): Promise<void>
  /**
   * This Mac became the home and its portable part is restored: bring the agent up here with a NEW session
   * that rebuilds its context from the Matrix room (the old session history never moves), and compete for
   * the answering lease. Resolves after startup is issued; live readiness reports track a slow cold start.
   */
  activate(agent: string, signal: AbortSignal): Promise<void>
  /** The three facts of a readiness report. */
  readiness(agent: string): { homeAccessible: boolean; runtimeUsable: boolean; matrixIntakeWorking: boolean }
  power(): 'awake' | 'asleep_wakeable' | 'asleep_not_wakeable' | 'unknown'
}

export interface HomeContext {
  platform: HomePlatform
  auth: MacExecutorAuth
  tool: HomeTool
  store: HomeArchiveStore
  keys: HomeSealKeySource
  journal: AgentHomeJournal
  standing: HomeStanding
  /** Additive 2.5 import/catalog/model routes. Absent against a 2.1-only platform. */
  connection?: { platform: PlacementConnectionPlatform; auth: PlacementConnectionAuth }
  runtime: HomeRuntimeOps
  /** Ids of an operation whose answer is unknown, so a retry is the same operation (`retry-ledger.ts`). */
  retry: RetryLedger
  /** This Mac's `deviceServiceId`, or null when it is not enrolled. */
  me(): string | null
  /** Private folders: plaintext and sealed staging, the backups of what a restore replaces, quarantined copies. */
  dirs: { work: string; backups: string; quarantine: string }
  budgets: {
    /** How long a drain waits for the turn in flight. */
    drainMs: number
    /** How long a source stays quiesced for a target that has not committed before it ends the move. */
    targetWaitMs: number
    /** Failed final-checkpoint or restore tries before a move is ended. */
    attempts: number
    /** How long a commit that meets a publication being sent is retried, within one pass (the lease ends in about 45 s). */
    publicationWaitMs: number
  }
  /** Waits, ending early when the signal does (test seam: a fake clock). */
  sleep(ms: number, signal: AbortSignal): Promise<void>
  now(): number
  uuid(): string
  log(line: string): void
  /** Test seam: a flow reports each named step after it is journaled (a test throws here to model a crash). */
  step?(name: string): void
}

export const DEFAULT_BUDGETS: HomeContext['budgets'] = {
  drainMs: 120_000,
  targetWaitMs: 15 * 60_000,
  attempts: 3,
  publicationWaitMs: 60_000
}

/** A wait that a signal ends early (and never rejects): the caller looks at the signal itself. */
export const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise(resolve => {
    if (signal.aborted) {
      resolve()

      return
    }

    const timer = setTimeout(done, ms)

    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }

    signal.addEventListener('abort', done, { once: true })
    timer.unref?.()
  })
