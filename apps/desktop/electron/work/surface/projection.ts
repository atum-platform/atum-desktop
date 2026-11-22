import type { MatrixWorkAgentActivity, MatrixWorkAssistants, MatrixWorkPlan } from '../../../shared/matrix-work'
import type { GateServiceState } from '../gate/service'

/** The slice of lane G's read-only state the Work screen draws. */
export type GateSurfaceState = Pick<
  GateServiceState,
  'agents' | 'enrolled' | 'phase' | 'socket' | 'switchOn' | 'workGrantAccepted'
> &
  Partial<Pick<GateServiceState, 'planConnected' | 'planSwitchOn'>>

/**
 * The plan switch (gate 4b): drawn while T3 says the plan is connected on this Mac, and whenever it is on (so it can be turned
 * off). Never drawn for a Mac with no Work route. A plan that is not connected and a switch that is off say nothing.
 */
export function projectWorkPlan(state: GateSurfaceState | null | undefined): MatrixWorkPlan | undefined {
  if (!state?.enrolled || !state.workGrantAccepted) {
    return undefined
  }

  if (state.planSwitchOn) {
    return 'on'
  }

  return state.planConnected === 'connected' ? 'off' : undefined
}

/**
 * One quiet state for "Assistants can start work here". Ordered: what the owner can change comes before
 * what only time or Atum can fix, so a switched-off Mac reads "off", not "reconnecting".
 */
export function projectWorkAssistants(state: GateSurfaceState | null | undefined): MatrixWorkAssistants {
  if (!state?.enrolled) {
    return 'not_enrolled'
  }

  if (!state.workGrantAccepted) {
    return 'needs_grant'
  }

  if (!state.switchOn) {
    return 'off'
  }

  if (state.socket === 'down') {
    return 'unreachable'
  }

  switch (state.phase) {
    case 'open':
      return 'on'

    case 'stale':
      return 'stale'

    default:
      // `holding`, and `closed` with the switch on (the route is opening).
      return 'holding'
  }
}

/** Only agents with something running or a stop owed; never the agent list itself. */
export function projectWorkAgents(state: GateSurfaceState | null | undefined): MatrixWorkAgentActivity[] {
  return (state?.agents ?? [])
    .filter(agent => agent.running > 0 || agent.stopOwed > 0)
    .map(agent => ({ principal: agent.principal, running: agent.running, stopping: agent.stopOwed > 0 }))
    .sort((left, right) => left.principal.localeCompare(right.principal))
}
