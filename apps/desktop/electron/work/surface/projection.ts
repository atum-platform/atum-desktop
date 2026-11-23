import { WORK_RELAY_PROVIDER, type WorkRelayPlan } from '../../../shared/matrix-work-relay'

import type {
  MatrixWorkAgentActivity,
  MatrixWorkAssistants,
  MatrixWorkPlan,
  MatrixWorkPlanConnect,
  MatrixWorkPlanConsent
} from '../../../shared/matrix-work'
import type { WorkSubscriptionState } from '../gate/contract'
import type { GateServiceState } from '../gate/service'

/** The slice of lane G's read-only state the Work screen draws. */
export type GateSurfaceState = Pick<
  GateServiceState,
  'agents' | 'enrolled' | 'phase' | 'socket' | 'switchOn' | 'workGrantAccepted'
> &
  Partial<Pick<GateServiceState, 'planConnected' | 'planSwitchOn' | 'connectedPlans' | 'relayAccountConsent'>>

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

  return state.planConnected === 'connected' || state.connectedPlans?.length ? 'off' : undefined
}

/** T3's own provider screen, on the Codex instance (`apps/web/src/routes/_chat.settings.providers.tsx` in the fork). */
export function workPlanConnectPath(plan: WorkRelayPlan): string {
  return `/settings/providers?instanceId=${WORK_RELAY_PROVIDER[plan].instanceId}`
}
export const WORK_PLAN_CONNECT_PATH = workPlanConnectPath('codex')

/**
 * Gate 4a: the Connect step and row. Hidden until main says every 4a row holds for this account; then `offer` until T3 itself says
 * the plan is connected on this Mac. `unknown` (T3 could not be asked) still offers: the screen it opens is T3's own.
 */
export function projectWorkPlanConnect(open: boolean, state: GateSurfaceState | null | undefined): MatrixWorkPlanConnect | undefined {
  if (!open) {
    return undefined
  }

  return state?.planConnected === 'connected' ? 'connected' : 'offer'
}

/**
 * The owner page's view of the consent record: who is named, which Macs can be named (this one first, then the owner's other Macs
 * whose plan fact is connected, plus any Mac the record already names), and when it was granted. A Mac the read does not list and the
 * record does not name is not offered: the platform refuses a Mac with no Work route.
 */
export function projectWorkConsent(
  read: WorkSubscriptionState,
  thisMac: string | undefined,
  entitled: readonly string[] = []
): MatrixWorkPlanConsent {
  const record = read.consent
  const on = record.state === 'on'
  const named = new Set(on ? record.devices : [])
  const names = new Map(read.facts.flatMap(fact => (fact.displayName ? [[fact.deviceServiceId, fact.displayName] as const] : [])))
  const ids = [
    ...(thisMac ? [thisMac] : []),
    ...read.facts.filter(fact => fact.status === 'connected').map(fact => fact.deviceServiceId),
    ...named
  ].filter((id, index, all) => all.indexOf(id) === index)

  return {
    state: record.state,
    agents: on ? [...record.agents] : [],
    eligible: [...entitled, ...(on ? record.agents : [])].filter((id, index, all) => all.indexOf(id) === index),
    macs: ids.map(id => ({
      id,
      thisMac: id === thisMac,
      named: named.has(id),
      ...(names.has(id) ? { name: names.get(id) } : {})
    })),
    alsoWhenScheduled: on && record.alsoWhenScheduled,
    ...(record.grantedAt !== undefined ? { grantedAt: record.grantedAt } : {})
  }
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
