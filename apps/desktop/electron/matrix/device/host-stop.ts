import { randomUUID } from 'node:crypto'

import type { MatrixCloudStopOutcome } from '../../../shared/matrix'
import { readDomainJson } from '../domain'

/** Shell authenticates its owner cookie session. A MAS or process bearer is never sent here. */
export async function requestHostStop(
  base: string,
  agent: string,
  room: string,
  event: string,
  signal: AbortSignal,
  fetcher: typeof fetch
): Promise<MatrixCloudStopOutcome> {
  const url = new URL(base)
  if (
    url.protocol !== 'https:' || url.username || url.password ||
    !/^!.{1,1023}$/.test(room) || !/^\$.{1,1023}$/.test(event)
  ) {
    throw new Error('matrix_host_stop_invalid')
  }
  const requestId = randomUUID()
  const response = await fetcher(new URL('/api/host/stop', url).href, {
    method: 'POST',
    credentials: 'include',
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      Origin: url.origin,
      'X-Atum-Host-Bridge-Contract': 'atum.s2.host-bridge/1.0.0'
    },
    body: JSON.stringify({ agent, requestId, source: { room, event } }),
    signal
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error('matrix_host_stop_refused')
  }
  const receipt = (await readDomainJson(response, 4096)) as Record<string, unknown> | null
  signal.throwIfAborted()
  if (
    !receipt || receipt.ok !== true || receipt.requestId !== requestId ||
    receipt.cancelled !== true || typeof receipt.interrupted !== 'boolean'
  ) {
    throw new Error('matrix_host_stop_unconfirmed')
  }
  return { state: 'stop_requested' }
}
