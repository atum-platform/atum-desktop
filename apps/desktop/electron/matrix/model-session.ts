import type { JsonRpcGatewayClient } from '../../../shared/src/json-rpc-gateway'
import type { MatrixRoom } from '../../shared/matrix'
import {
  type MatrixProductEffort,
  parseMatrixModelChoice,
  parseMatrixProductEffort
} from '../../shared/matrix-model-choice'
import { isAtumModelName, parseMatrixEffort } from '../../shared/matrix-models'

/** Until Connections/default resolution joins, unsupported choices stop before execution.
 * Other assistants' overrides remain stored without affecting this assistant. */
export function requireMatrixSessionChoice(
  room: Pick<MatrixRoom, 'modelChoice' | 'modelChoiceInvalid'> | undefined,
  agentPrincipal?: string
): void {
  if (room?.modelChoiceInvalid) {
    throw new Error('matrix_model_choice_unavailable')
  }

  if (room?.modelChoice === undefined) {
    return
  }

  const choice = parseMatrixModelChoice(room.modelChoice)

  if (
    !choice ||
    choice.source !== 'atum' ||
    !isAtumModelName(choice.model) ||
    (choice.effort !== undefined && !parseMatrixEffort(choice.effort)) ||
    (Object.keys(choice.agents ?? {}).length > 0 && !agentPrincipal) ||
    (agentPrincipal && Object.hasOwn(choice.agents ?? {}, agentPrincipal))
  ) {
    throw new Error('matrix_model_choice_unavailable')
  }
}

/** Closed refusal; no upstream message/model/credential is exposed to the caller. */
export class MatrixSessionEffortError extends Error {
  constructor() {
    super('matrix_session_effort_unavailable')
  }
}

/** New-session parameter only. No effort means the backend's own default. */
export function matrixSessionEffortParams(effort: MatrixProductEffort | undefined): {
  reasoning_effort?: MatrixProductEffort
} {
  if (effort !== undefined && !parseMatrixProductEffort(effort)) {
    throw new MatrixSessionEffortError()
  }

  return effort ? { reasoning_effort: effort } : {}
}

/** Apply at the idle turn boundary; any refusal must stop before prompt.submit. */
export async function applyMatrixSessionEffort(
  gateway: Pick<JsonRpcGatewayClient, 'request'>,
  sessionId: string,
  info: { reasoning_effort?: unknown } | undefined,
  effort: MatrixProductEffort | undefined,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()

  if (!sessionId || (effort !== undefined && !parseMatrixProductEffort(effort))) {
    throw new MatrixSessionEffortError()
  }

  if (effort === undefined || info?.reasoning_effort === effort) {
    return
  }

  try {
    const answer = await gateway.request<{ key?: unknown; value?: unknown }>(
      'config.set',
      { key: 'reasoning', value: effort, session_id: sessionId, scope: 'session' },
      15_000,
      signal
    )

    signal.throwIfAborted()

    if (answer?.key !== 'reasoning' || answer.value !== effort) {
      throw new MatrixSessionEffortError()
    }
  } catch {
    signal.throwIfAborted()
    throw new MatrixSessionEffortError()
  }
}
