import {
  type AgentProfileDetail,
  agentProfileRequest,
  type AgentProfileRequest,
  agentProfileResult,
  type AgentProfileResult
} from '../../shared/agent-profile-management'

import { MatrixAgentDefinitionError } from './agent-definition'

export interface MatrixAgentProfileManagementOptions {
  /** The principal whose current Hermes turn originated this request. */
  originPrincipal: string
  /**
   * Execute through the canonical platform boundary. The platform derives ownership and
   * current Main authority in the same transaction; local roster caches are never authority.
   */
  request(request: AgentProfileRequest, signal: AbortSignal): Promise<unknown>
  current(): boolean
  saved?(profile: AgentProfileDetail): void
}

const errors = new Set([
  'conflict',
  'denied',
  'duplicate',
  'invalid',
  'locked',
  'missing',
  'offline',
  'reserved',
  'unavailable'
])

function failure(value: unknown): AgentProfileResult {
  const error = typeof value === 'string' && errors.has(value) ? value : 'unavailable'
  return { error: error as Extract<AgentProfileResult, { error: string }>['error'] }
}

/**
 * Validate one model-facing request and pass it to the server-authoritative profile path.
 * This adapter owns only turn lifetime and output validation, not identity or role policy.
 */
export async function manageMatrixAgentProfile(
  options: MatrixAgentProfileManagementOptions,
  value: unknown,
  signal: AbortSignal
): Promise<AgentProfileResult> {
  const request = agentProfileRequest(value)
  if (!request) {return { error: 'invalid' }}

  const live = () => {
    signal.throwIfAborted()
    if (!options.current()) {throw new Error('matrix_agent_profile_stale')}
  }

  try {
    live()
    const raw = await options.request(request, signal)
    live()
    const result = agentProfileResult(raw, {
      originPrincipal: options.originPrincipal,
      ...(request.operation === 'list'
        ? {}
        : { targetPrincipal: request.target ?? options.originPrincipal })
    })
    if (!result) {return { error: 'unavailable' }}
    if ('profile' in result && result.profile) {options.saved?.(result.profile)}
    return result
  } catch (error) {
    if (signal.aborted) {throw error}
    if (error instanceof MatrixAgentDefinitionError) {return failure(error.code)}
    return { error: 'unavailable' }
  }
}
