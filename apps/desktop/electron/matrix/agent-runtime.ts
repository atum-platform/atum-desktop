import type { AtumAssistantMark } from '../../shared/atum-agent-portability'
import type { MatrixIdentity } from '../../shared/matrix'

import type { MatrixAgentHire } from './agent-definition'
import type { MatrixHostRole } from './sdk-host'

/** Where an agent other than the default keeps its vault entries: every one of them, so
 * retiring it removes exactly its own ( §2.7). */
export const matrixAgentScope = (principal: string) => `${MATRIX_AGENT_SCOPES}${principal}:`

/** What every agent scope starts with: the default agent's removal keeps them all. */
export const MATRIX_AGENT_SCOPES = 'agent:'

/** Display and routing metadata, read from the account's cloud roster. */
export class MatrixAgentRuntime {
  operation = false
  closed = false
  identity?: MatrixIdentity
  agentPrincipal?: string
  assistantId?: string
  name?: string
  title?: string
  mark?: AtumAssistantMark
  hire?: MatrixAgentHire
  avatarUrl: string | null = null
  matrixUser?: string

  constructor(readonly role: MatrixHostRole, readonly principal?: string) {
    this.agentPrincipal = principal
  }

  get userId(): string | undefined {
    return this.matrixUser ?? this.identity?.userId
  }
}
