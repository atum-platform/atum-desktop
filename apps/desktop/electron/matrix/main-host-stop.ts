import type { MatrixCloudStopOutcome } from '../../shared/matrix'

import type { MatrixAccount } from './account'
import { stopCloudTurn } from './device/cloud-stop'
import { requestHostStop } from './device/host-stop'

interface MatrixStopDispatch {
  principal?: string
  cloud: boolean
  host: boolean
  ready: boolean
  roomId: string
  eventId: string
}

interface MatrixStopDependencies {
  s1Request: MatrixAccount['s1Request']
  s1Call: Parameters<typeof stopCloudTurn>[0]
  fetcher: typeof fetch
  hostStop?: typeof requestHostStop
  legacyStop?: typeof stopCloudTurn
}

/** No Electron state: the caller retains its room and account-epoch guards. */
export function dispatchMatrixStop(input: MatrixStopDispatch, deps: MatrixStopDependencies): Promise<MatrixCloudStopOutcome> {
  const { principal, roomId, eventId } = input
  if (!input.cloud || !principal) throw new Error('matrix_agent_unavailable')
  if (input.host && !input.ready) throw new Error('matrix_not_ready')
  if (input.host) {
    // Shell's host transport alone has a 30s budget. Keep the grant/receipt path
    // alive beyond it, without extending deadlines for unrelated S1 operations.
    return deps.s1Request((token, base, signal) =>
      (deps.hostStop ?? requestHostStop)(base, token, principal, roomId, eventId, signal, deps.fetcher),
    AbortSignal.timeout(40_000), { timeoutMs: 40_000 })
  }
  return (deps.legacyStop ?? stopCloudTurn)(deps.s1Call, principal, roomId, eventId, AbortSignal.timeout(30_000))
}
