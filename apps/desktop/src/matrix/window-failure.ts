import type { MatrixWindowFailureSource } from '../../shared/matrix-window-failure'
import { matrixWindowFailureCode } from '../../shared/matrix-window-failure'

import { type MatrixChatFailure, matrixChatFailure } from './chat-error'

const RETRYABLE = new Set<MatrixChatFailure>([
  'offline',
  'busy',
  'not_ready',
  'agent_unavailable',
  'assistant_cant_start',
  'assistant_unreachable',
  'company_file_preparing',
  'company_file_unavailable',
  'app_bot_starting',
  'app_bot_syncing',
  'app_bot_unavailable'
])

/**
 * Report one privacy-safe line through the existing Matrix UI IPC channel. Diagnostics are
 * best-effort and never own the action or its presentation.
 */
export function reportMatrixWindowFailure(
  source: MatrixWindowFailureSource,
  cause: unknown,
  online = true,
  hasRetry = false
): MatrixChatFailure {
  const failure = matrixChatFailure(cause, online)

  window.atumMatrix.windowFailureDiagnostic?.({
    source,
    code: matrixWindowFailureCode(cause),
    retryable: hasRetry || RETRYABLE.has(failure)
  })

  return failure
}
