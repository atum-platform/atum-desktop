import type { MatrixAgentView } from '../../shared/matrix'
import { matrixAgentAnswersInCloud } from '../../shared/matrix-agent-actions'
import type { WorkAgentPlans } from '../../shared/matrix-work'
import { type WorkRelayMachineKind, workRelayMachineKind, type WorkRelaySelection } from '../../shared/matrix-work-relay'

/**
 * Where an assistant is working, as the icon beside its name shows it (owner 2026-11-28): the
 * cloud, or the one Mac its turns relay through. `online: false` is that Mac while it is off (its
 * turns wait or fall back), drawn dimmed as the picker's machine rows draw an offline Mac.
 */
export type AgentPlace =
  | { kind: 'cloud' }
  | { kind: 'mac'; name: string; machine: WorkRelayMachineKind; online: boolean }

export interface AgentPlaceInput {
  agent: Pick<MatrixAgentView, 'answering' | 'home' | 'macRole'>
  /** The agent's plan read (`work.readAgentPlans`, agent-plans-store.ts): undefined before it settles, null when it failed. */
  plans: WorkAgentPlans | null | undefined
  /** The selection the pickers name (`agentPlansShownSelection`): a pick in flight first, then the server's. */
  selection: WorkRelaySelection | null
}

/**
 * One rule, from state the window already holds; never a guess. In order:
 *
 * 1. An assistant whose home is a Mac (atum.agent-home/2.1 `lives`) works on that Mac.
 * 2. An assistant this Mac answers for, or one not on the cloud route: unknown (the retired local paths).
 * 3. A cloud assistant on an Atum or connected model (no plan selection) works in the cloud.
 * 4. A cloud assistant on a Mac plan works on the Mac that serves the selected model: the one that
 *    is on, or, with every serving Mac off, the only one there is. Two or more on is unknown: the
 *    cloud picks one per turn and the window is not told which.
 *
 * Until the plan read settles, or when it failed, the place is unknown and nothing is drawn.
 */
export function agentPlace({ agent, plans, selection }: AgentPlaceInput): AgentPlace | undefined {
  const lives = agent.home?.lives

  if (lives?.kind === 'mac') {
    const reach = agent.home?.placement?.reachability

    return { kind: 'mac', name: lives.name, machine: workRelayMachineKind(lives.name), online: reach !== 'asleep' && reach !== 'offline' }
  }

  if (!matrixAgentAnswersInCloud(agent) || !plans) {
    return undefined
  }

  if (!selection) {
    return { kind: 'cloud' }
  }

  const serving = (plans.machines?.[selection.plan] ?? []).filter(
    machine => !machine.models || machine.models.includes(selection.model)
  )

  const on = serving.filter(machine => machine.online)
  const mac = on.length === 1 ? on[0] : on.length === 0 && serving.length === 1 ? serving[0] : undefined

  return mac ? { kind: 'mac', name: mac.name, machine: mac.kind, online: mac.online } : undefined
}
