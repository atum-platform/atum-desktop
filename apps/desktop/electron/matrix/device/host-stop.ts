import { randomUUID } from 'node:crypto'

import type { MatrixCloudStopOutcome } from '../../../shared/matrix'
import { readDomainJson } from '../domain'

/** Uses the account domain grant, refreshed by s1Request on authentication failure. */
export async function requestHostStop(
  base: string,
  token: string,
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
    credentials: 'omit',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Origin: url.origin,
      'X-Atum-Host-Bridge-Contract': 'atum.s2.host-bridge/1.0.0'
    },
    body: JSON.stringify({ agent, requestId, source: { room, event } }),
    signal
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(response.status === 401 ? 'matrix_s1_authentication' : 'matrix_host_stop_refused')
  }
  const receipt = (await readDomainJson(response, 4096)) as Record<string, unknown> | null
  signal.throwIfAborted()
  if (
    !receipt || receipt.ok !== true || receipt.requestId !== requestId ||
    receipt.cancelled !== true || typeof receipt.interrupted !== 'boolean'
  ) {
    throw new Error('matrix_host_stop_unconfirmed')
  }
  // `cancelled` means the host cut the turn's tools; only `interrupted` is the agent confirming
  // the turn stopped. Without it the agent may still be finishing a reply.
  return { state: receipt.interrupted ? 'stopped' : 'stop_requested' }
}
