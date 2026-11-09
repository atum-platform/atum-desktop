import type { MatrixExecutionPolicyView } from '../../shared/execution-policy'
import type { MatrixReadiness, MatrixSnapshot } from '../../shared/matrix'

import { matrixExecutionPolicyKeepsLocalRuntime } from './execution-policy'

/** Local/cloud placement follows the saved execution policy and current lease. */
export type MatrixCloudAgentMacRole = 'answering' | 'standby'

/** The chat's authoritative destination. A standby runtime is failover capacity, not the route
 * answering this turn, so its optional local provider state cannot block the cloud. */
export function matrixCloudAgentAnswersInCloud(input: {
  cloudRoute: boolean
  role: MatrixCloudAgentMacRole | undefined
}): boolean {
  // View counterpart: shared/matrix-agent-actions.ts matrixAgentAnswersInCloud.
  return input.cloudRoute && input.role !== 'answering'
}

/**
 * Whether the assistant can answer now, independent of whether THIS Mac's optional runtime is
 * ready. A cloud or standby destination is authoritative while it answers; local enrollment and
 * host readiness matter only when this Mac is the answering destination.
 */
export function matrixAgentAnswerReady(input: {
  cloudRoute: boolean
  role: MatrixCloudAgentMacRole | undefined
  localAuthority: boolean
  localHostReady: boolean
}): boolean {
  return matrixCloudAgentAnswersInCloud(input) || (input.localAuthority && input.localHostReady)
}

/**
 * What the window may say about setup while another destination answers. A standby runtime still
 * performs its local probes, but their failure is failover maintenance, not a broken assistant.
 * Keep that private to the runtime until this Mac becomes the answering destination.
 */
export function matrixCloudAgentSetupForUser(input: {
  cloudRoute: boolean
  role: MatrixCloudAgentMacRole | undefined
  setup: MatrixSnapshot['assistantSetup']
}): MatrixSnapshot['assistantSetup'] {
  return matrixCloudAgentAnswersInCloud(input) ? undefined : input.setup
}

/** The answering cloud destination is the user-visible readiness authority, never this Mac's
 * optional standby probe. The probe keeps running internally so takeover remains warm. */
export function matrixCloudAgentReadinessForUser(input: {
  cloudRoute: boolean
  role: MatrixCloudAgentMacRole | undefined
  local: MatrixReadiness | undefined
  since: number
}): MatrixReadiness | undefined {
  return matrixCloudAgentAnswersInCloud(input)
    ? { phase: 'ready', since: input.local?.since ?? input.since }
    : input.local
}

/**
 * Whether this Mac still owes the agent its local readiness path. A cloud-only agent has no local
 * work here, but a saved-policy standby must run the same enrollment, host and Hermes steps as the
 * answering Mac so it can take the lease without a cold start. Chat readiness remains remote while
 * it is standby; this only decides whether the local readiness probes execute.
 */
export function matrixCloudAgentNeedsLocalReadiness(input: {
  cloudRoute: boolean
  role: MatrixCloudAgentMacRole | undefined
}): boolean {
  return !input.cloudRoute || input.role !== undefined
}

/**
 * A create response said the platform placed this agent in the cloud, but the roster has not
 * shown the switch yet: the row still answers `local` until the controller trusts the
 * enrollment (platform decision 3). From the response on, the cloud owns the room and the
 * executor, so this Mac must behave as cloud-only regardless of the roster; once the roster
 * says `cloud`, the ordinary saved-policy/lease decision takes over again.
 */
export function matrixPlacedCloudOnly(input: {
  principal: string | undefined
  placed: ReadonlySet<string>
  cloudRoster: ReadonlySet<string>
}): boolean {
  return input.principal !== undefined && input.placed.has(input.principal) && !input.cloudRoster.has(input.principal)
}

/**
 * The agents a create answer placed in the cloud this session (`placed`/`pending_trust`), kept
 * until the roster shows `answering: 'cloud'`. The set is session-scoped: a fresh sign-in or an
 * account change never inherits the previous session's ids, and an id the roster no longer lists
 * as active (retired, removed or tombstoned) never reaches the switch, so a read drops it rather
 * than leaking it until sign-out.
 */
export class MatrixPlacedAgents extends Set<string> {
  /** Ids a roster read has listed as active since they were placed. */
  private readonly listedOnce = new Set<string>()

  override delete(principal: string): boolean {
    this.listedOnce.delete(principal)

    return super.delete(principal)
  }

  /** A fresh account/session starts with nothing placed. */
  reset(): void {
    this.clear()
    this.listedOnce.clear()
  }

  /**
   * Keep only the ids the read still lists as active. An id is dropped only after a read has listed
   * it at least once: a read that was already in flight when the create answered can come back
   * without the new agent, and dropping it then would let this Mac set up a local executor for an
   * agent the cloud owns.
   */
  retain(roster: readonly { principal: string; status: string }[]): void {
    const listed = new Set(roster.filter(agent => agent.status === 'active').map(agent => agent.principal))

    for (const principal of this) {
      if (listed.has(principal)) {
        this.listedOnce.add(principal)
      } else if (this.listedOnce.has(principal)) {
        this.delete(principal)
      }
    }
  }
}

export function matrixCloudAgentMacRole(input: {
  view: MatrixExecutionPolicyView | undefined
  deviceServiceId: string | undefined
  leaseState: string | undefined
  powerEligible: boolean
}): MatrixCloudAgentMacRole | undefined {
  if (
    !matrixExecutionPolicyKeepsLocalRuntime(input.view, input.deviceServiceId, input.leaseState, input.powerEligible)
  ) {
    return undefined
  }

  return input.leaseState === 'held' ? 'answering' : 'standby'
}

/**
 * Scheduled work on one agent's backend: Hermes's cron ticker (the agent's own jobs), the app
 * side of its deliveries, a paid hire's Store jobs and the default assistant's check-ins.
 *
 * - `attach`: the app answers the backend's delivery, Store-job and check-in requests. Those are
 *   gated by the lease at the moment they run (a check-in claims it, a Store run binds only on
 *   the holder, and the proxy answers `[SILENT]` anywhere else; store-schedules.ts), so they may
 *   be attached on every Mac that runs the agent.
 * - `tick`: the backend launches with its cron ticker on (`HERMES_DESKTOP_CRON`, a launch-time
 *   decision). The person's `matrix-run-jobs` switch still turns a whole Mac off.
 * - `holdUntilAnswering`: the ticker dispatches nothing until this Mac holds the agent's term.
 *   A cloud-route agent's other destinations (the cloud, another Mac) run its jobs while they
 *   answer, so a standby Mac must not run its copy of them too (the 27 runs of Alfred's old
 *   one-minute job on the mini). It is the lease, not the launch, that decides, so a Mac taking
 *   over starts firing without a restart that would give the term up.
 *
 * A plain local agent is unchanged: it is not held and runs wherever `matrix-run-jobs` says.
 */
export interface MatrixAgentJobsPlan {
  attach: boolean
  tick: boolean
  holdUntilAnswering: boolean
}

export function matrixAgentJobsPlan(input: {
  cloudRoute: boolean
  role: MatrixCloudAgentMacRole | undefined
  runsJobsHere: boolean
}): MatrixAgentJobsPlan {
  if (!input.cloudRoute) {
    return { attach: true, tick: input.runsJobsHere, holdUntilAnswering: false }
  }

  if (!input.role) {
    return { attach: false, tick: false, holdUntilAnswering: true }
  }

  return { attach: true, tick: input.runsJobsHere, holdUntilAnswering: input.role !== 'answering' }
}
