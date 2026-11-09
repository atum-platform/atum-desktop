import type { MatrixEnrollment } from '../../shared/matrix'

import type { MatrixAccount } from './account'
import { matrixAgentContentTarget } from './agent-content'
import type { MatrixAgentRuntime } from './agent-runtime'
import type { MatrixHermesRuntimeConfig } from './hermes-runtime'

type Account = Pick<MatrixAccount, 'appScope' | 'agentDefinition' | 'agentSkill'> &
  Partial<Pick<MatrixAccount, 'agentMemory' | 'writeAgentMemory'>>

/** Main's current authority and machine facts, read again by every live check. */
export interface MatrixMainAgentContentSource {
  /** The root custody object, whether or not it holds the current product-default role. */
  defaultAgent: MatrixAgentRuntime
  agents: ReadonlyMap<string, MatrixAgentRuntime>
  account(): Account | undefined
  runtime(): MatrixHermesRuntimeConfig | undefined
  closing(): boolean
  /** False for a Google-latched home: its portable memory must stay on this Mac. */
  memoryAllowed?(agent: MatrixAgentRuntime): boolean
  enrollment(agent: MatrixAgentRuntime): MatrixEnrollment
  /** The agent's Hermes home on this Mac (main's agentHermesHome); absent, its executor's own. */
  home?(
    agent: MatrixAgentRuntime,
    identity: { principal: string; executorId: string },
    runtime: MatrixHermesRuntimeConfig
  ): string
}

/** The single production binding for both content work and its optional roster view.
 * An absent/revoked domain is checked before enrollment, whose read may throw. */
export function matrixMainAgentContentTarget(source: MatrixMainAgentContentSource, agent: MatrixAgentRuntime) {
  const principal = agent.agentPrincipal
  const current = () => (agent.principal ? source.agents.get(agent.principal) : source.defaultAgent)

  if (!principal || current() !== agent || agent.closed || source.closing()) {
    return undefined
  }

  const scope = source.account()?.appScope()
  const currentRuntime = source.runtime()

  if (!scope || !currentRuntime) {
    return undefined
  }

  const identity = source.enrollment(agent).identity
  const assistantId = agent.assistantId
  const memoryAllowed = () => source.memoryAllowed?.(agent) !== false

  return matrixAgentContentTarget({
    principal,
    assistantId,
    identity: identity ?? undefined,
    runtime: currentRuntime,
    ...(identity && source.home ? { home: source.home(agent, identity, currentRuntime) } : {}),
    live: () => {
      const currentScope = source.account()?.appScope()

      if (
        !currentScope ||
        agent.closed ||
        source.closing() ||
        source.runtime() !== currentRuntime ||
        scope.accountKey !== currentScope.accountKey ||
        scope.generation !== currentScope.generation ||
        agent.assistantId !== assistantId ||
        agent.agentPrincipal !== principal ||
        current() !== agent
      ) {
        return false
      }

      const enrolled = source.enrollment(agent).identity

      return Boolean(
        identity &&
        enrolled &&
        identity.agentPrincipal === principal &&
        enrolled.agentPrincipal === identity.agentPrincipal &&
        enrolled.executorId === identity.executorId &&
        enrolled.principal === identity.principal &&
        enrolled.userId === identity.userId &&
        enrolled.deviceId === identity.deviceId
      )
    },
    definition: (id, signal) => source.account()!.agentDefinition(id, signal),
    skill: (id, sha256, signal) => source.account()!.agentSkill(id, sha256, signal),
    ...(source.memoryAllowed ? { memoryAllowed } : {}),
    ...(source.account()?.agentMemory && source.account()?.writeAgentMemory
      ? {
          memory: (id: string, signal: AbortSignal) => source.account()!.agentMemory!(id, signal),
          writeMemory: (id: string, input: Parameters<MatrixAccount['writeAgentMemory']>[1], signal: AbortSignal) =>
            source.account()!.writeAgentMemory!(id, input, signal, memoryAllowed)
        }
      : {})
  })
}
