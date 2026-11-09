import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The host's hold on one agent's Hermes cron ticker (reliability plan R5; hermes_cli/web_server.py
 * `_desktop_cron_can_dispatch`). A ticker is started once per backend launch, so "this Mac runs
 * the agent's jobs only while it answers for the agent" cannot be a launch flag: the Mac that
 * takes the term starts Hermes first and acquires the lease after. A marker file per agent does
 * it instead. While it exists the backend's ticker keeps running but dispatches nothing; lifting
 * it lets the same ticker fire on its next tick, with no restart that would hand the term back.
 *
 * The marker lives beside the app's own device state, not in the agent's Hermes home, so nothing
 * that rewrites or restores that home (a home import, a snapshot, a skill) lifts the hold. Every failure holds: a job that waits is recoverable, a
 * job that runs on two machines is not.
 */
export class MatrixCronHolds {
  constructor(private readonly directory: string) {}

  /** The marker's absolute path for an agent (a hash of its host role, never a name). */
  path(agentKey: string): string {
    return path.join(this.directory, createHash('sha256').update(agentKey).digest('hex').slice(0, 32))
  }

  /** Separate from the legacy whole-profile hold: no change to unselected profiles.
   * Atomic replacement keeps readers from observing a partial inventory. Survives restart.
   */
  managed(agentKey: string, jobIds: readonly string[]): void {
    if (jobIds.some(id => !/^[A-Za-z0-9_-]{1,64}$/u.test(id))) {throw new Error('invalid_managed_job_id')}
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const target = `${this.path(agentKey)}.managed`
    const temporary = `${target}.tmp`
    writeFileSync(temporary, JSON.stringify({ profile: 'atum.mac-job-hold/1', jobIds: [...new Set(jobIds)] }), { mode: 0o600 })
    renameSync(temporary, target)
  }

  clearManaged(agentKey: string): void {
    rmSync(`${this.path(agentKey)}.managed`, { force: true })
  }

  /** Whether the agent's ticker is held (an unreadable marker is a hold). */
  held(agentKey: string): boolean {
    try {
      return existsSync(this.path(agentKey))
    } catch {
      return true
    }
  }

  /** Holds the ticker. Returns whether it is held afterwards; false means the caller must not run it. */
  hold(agentKey: string): boolean {
    // Reconciled on every lease and policy change: an existing marker is left as it is.
    if (this.held(agentKey)) {
      return true
    }

    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      writeFileSync(this.path(agentKey), '', { mode: 0o600 })
    } catch {
      return this.held(agentKey)
    }

    return true
  }

  /** Lifts the hold. Returns whether it is lifted; a marker that cannot be removed stays a hold. */
  lift(agentKey: string): boolean {
    try {
      rmSync(this.path(agentKey), { force: true })
    } catch {
      return false
    }

    return !this.held(agentKey)
  }
}

/**
 * Applies an agent's jobs plan (cloud-agent-placement.ts `matrixAgentJobsPlan`) to its ticker's
 * marker. Returns whether the ticker may run: false only when the plan needs a hold and it could not
 * be written, in which case a backend must not be launched with a ticker at all.
 */
export function applyMatrixJobsHold(
  holds: MatrixCronHolds,
  agentKey: string,
  plan: { holdUntilAnswering: boolean }
): boolean {
  if (plan.holdUntilAnswering) {
    return holds.hold(agentKey)
  }

  holds.lift(agentKey)

  return true
}

/**
 * Reconciles an already-running backend's ticker with its agent's jobs plan. A launch that cannot
 * write the hold it needs simply starts without a ticker (`applyMatrixJobsHold` false), but a
 * ticker that is already running cannot be told to stop except through the marker: when the marker
 * cannot be written the running ticker is un-held, and it would dispatch jobs on a Mac that must
 * not. `unheld` says exactly that, so the caller restarts the backend with the ticker off (its
 * launch re-applies the hold, fails the same way and starts without it) instead of leaving it
 * running. A backend with no ticker has nothing to stop, whatever happened to the marker, and a
 * lift that failed is still a hold.
 */
export function reconcileMatrixJobsHold(
  holds: MatrixCronHolds,
  agentKey: string,
  plan: { holdUntilAnswering: boolean },
  tickerRunning: boolean
): { unheld: boolean } {
  const mayRun = applyMatrixJobsHold(holds, agentKey, plan)

  return { unheld: tickerRunning && !mayRun }
}

/**
 * Whether a running backend lacks the cron ticker its agent's plan now wants firing: this Mac runs
 * the agent's jobs (`tick`), nothing holds them (`!holdUntilAnswering`, so this Mac answers for the
 * agent), and the backend was launched without a ticker. That happens to a backend that launched
 * while the plan was holding and the hold could not be written (`applyMatrixJobsHold` false starts
 * it tickerless): lifting the marker later changes nothing, because there is no ticker to read it,
 * so the agent's jobs would fire nowhere until an unrelated relaunch. The caller restarts the
 * backend with the ticker on. A standby backend without a ticker is fine (it must not fire), and
 * it is flagged the moment it takes the term.
 */
export function matrixJobsTickerMissing(
  plan: { tick: boolean; holdUntilAnswering: boolean },
  tickerRunning: boolean
): boolean {
  return plan.tick && !plan.holdUntilAnswering && !tickerRunning
}
