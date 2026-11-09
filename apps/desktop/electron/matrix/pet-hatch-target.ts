import type { MatrixPetTarget } from '../../shared/matrix-pet'

/** What main knows when a pet request names an account and one of its agents. */
export interface MatrixPetTargetFacts<Agent, Identity> {
  /** The signed-in account (`account.appScope()`), or null. */
  scope: { accountKey: string; generation: number } | null
  /** The pet scope token this account's window was given (`petScopeToken()`). */
  token: string | undefined
  agents: readonly Agent[]
  /** The agent's enrolled identity on this Mac, if any. */
  identity(agent: Agent): Identity | null | undefined
}

interface PetTargetAgent {
  closed: boolean
  agentPrincipal?: string
  invocation?: unknown
}

/**
 * The account and agent of a pet recovery request: a read or a discard of this Mac's own
 * record of an unfinished hatch. It starts nothing, so unlike a hatch it needs neither an idle
 * agent nor the Hermes runtime and Atum's model. (At launch every agent runs its model check,
 * so the window's recovery read was refused with `matrix_pet_unavailable` on every start.)
 */
export function matrixPetRecoveryTarget<Agent extends PetTargetAgent, Identity>(
  target: MatrixPetTarget,
  facts: MatrixPetTargetFacts<Agent, Identity>
): { scope: { accountKey: string; generation: number }; agent: Agent; identity: Identity } {
  const agent = facts.agents.find(value => !value.closed && value.agentPrincipal === target.agent)
  const identity = agent ? facts.identity(agent) : undefined

  if (!facts.scope || !agent || !identity || target.scope !== facts.token) {
    throw new Error('matrix_pet_unavailable')
  }

  return { scope: facts.scope, agent, identity }
}

/** A hatch (or resuming one) renders with this agent's own Hermes and Atum's model, so the agent
 * must be idle and both must be there. */
export function matrixPetHatchTarget<Agent extends PetTargetAgent, Identity, Runtime>(
  target: MatrixPetTarget,
  facts: MatrixPetTargetFacts<Agent, Identity> & { runtime: Runtime | undefined; managedModel: boolean }
): { scope: { accountKey: string; generation: number }; agent: Agent; identity: Identity; selectedRuntime: Runtime } {
  const recovered = matrixPetRecoveryTarget(target, facts)

  if (recovered.agent.invocation || !facts.runtime || !facts.managedModel) {
    throw new Error('matrix_pet_unavailable')
  }

  return { ...recovered, selectedRuntime: facts.runtime }
}
