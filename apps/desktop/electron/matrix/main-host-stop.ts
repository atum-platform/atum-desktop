import { createHash, randomUUID } from 'node:crypto'

import type { MatrixCloudStopOutcome } from '../../shared/matrix'
import { matrixScheduleIdentity } from '../../shared/matrix-progress-marker'

import type { MatrixAccount } from './account'
import { stopCloudTurn } from './device/cloud-stop'
import { type HostStopSource, requestHostStop } from './device/host-stop'

interface MatrixStopDispatch {
  principal?: string
  cloud: boolean
  host: boolean
  ready: boolean
  request: { roomId: string } & (
    | { action: 'stopTurn'; eventId: unknown }
    | { action: 'stopSchedule'; schedule: unknown }
  )
}

interface MatrixStopDependencies {
  s1Request: MatrixAccount['s1Request']
  s1Call: Parameters<typeof stopCloudTurn>[0]
  fetcher: typeof fetch
  hostStop?: typeof requestHostStop
  legacyStop?: typeof stopCloudTurn
}

/** Stable UUIDv8 for the same exact execution, scoped again by owner at Shell. */
function scheduleRequestId(agent: string, source: Extract<HostStopSource, { kind: 'schedule' }>): string {
  const bytes = createHash('sha256').update(JSON.stringify(['atum.schedule-stop', agent, source.job, source.execution]))
    .digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x80
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')

  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

/** The caller retains its room and account-epoch guards. */
export function dispatchMatrixStop(input: MatrixStopDispatch, deps: MatrixStopDependencies): Promise<MatrixCloudStopOutcome> {
  const { principal, request } = input
  if (!input.cloud || !principal) { throw new Error('matrix_agent_unavailable') }
  if (input.host && !input.ready) { throw new Error('matrix_not_ready') }
  let source: HostStopSource

  if (request.action === 'stopSchedule') {
    const schedule = matrixScheduleIdentity(request.schedule)
    if (!input.host || !schedule) { throw new Error('matrix_host_stop_invalid') }
    source = { kind: 'schedule', ...schedule }
  } else {
    if (typeof request.eventId !== 'string') { throw new Error('matrix_host_stop_invalid') }
    if (!input.host) {
      return (deps.legacyStop ?? stopCloudTurn)(deps.s1Call, principal, request.roomId, request.eventId, AbortSignal.timeout(30_000))
    }
    source = { room: request.roomId, event: request.eventId }
  }

  // Allocate before s1Request so refreshing an expired grant keeps the same intent.
  const requestId = 'kind' in source ? scheduleRequestId(principal, source) : randomUUID()
  // Shell's 30s host budget sits inside the account grant and receipt deadline.
  return deps.s1Request((token, base, signal) =>
    (deps.hostStop ?? requestHostStop)(base, token, principal, source, requestId, signal, deps.fetcher),
  AbortSignal.timeout(40_000), { timeoutMs: 40_000 })
}
