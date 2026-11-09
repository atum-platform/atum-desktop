import { randomUUID } from 'node:crypto'

import { validStopEvent } from '../../../../../packages/device-protocol/stop-target'
import type { MatrixCloudStopOutcome } from '../../../shared/matrix'

import { type S1Call, s1Route } from './cloud-agent'

/** The owner chooses a target; native chooses the agent, route and idempotency key. */
export async function stopCloudTurn(
  call: S1Call,
  agentPrincipal: string,
  roomId: string,
  eventId: string,
  signal: AbortSignal
): Promise<MatrixCloudStopOutcome> {
  if (eventId.startsWith('$atum-') && !validStopEvent(eventId)) {
    throw new Error('matrix_cloud_stop_invalid')
  }

  const resource = { kind: 'cloud-stop' as const, requestId: randomUUID(), agentPrincipal, roomId, eventId }
  s1Route(resource)
  const value = (await call(resource, signal)) as Record<string, unknown> | null
  signal.throwIfAborted()
  const target = value?.target as Record<string, unknown> | null

  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'agentPrincipal,state,stoppedAt,target' ||
    value.agentPrincipal !== agentPrincipal ||
    !target ||
    Object.keys(target).sort().join(',') !== 'eventId,kind,roomId' ||
    target.kind !== 'turn' ||
    target.roomId !== roomId ||
    target.eventId !== eventId ||
    !Number.isSafeInteger(value.stoppedAt) ||
    Number(value.stoppedAt) < 0 ||
    !['stopped', 'stop_requested', 'completed'].includes(value.state as string)
  ) {
    throw new Error('matrix_cloud_stop_unconfirmed')
  }

  return { state: value.state as MatrixCloudStopOutcome['state'] }
}
