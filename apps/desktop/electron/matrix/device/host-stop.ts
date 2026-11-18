import type { MatrixCloudStopOutcome } from '../../../shared/matrix'
import type { MatrixScheduleIdentity } from '../../../shared/matrix-progress-marker'
import { readDomainJson } from '../domain'

export type HostStopSource = { room: string; event: string } | ({ kind: 'schedule' } & MatrixScheduleIdentity)

/** Uses the account domain grant, refreshed by s1Request on authentication failure. */
export async function requestHostStop(
  base: string,
  token: string,
  agent: string,
  source: HostStopSource,
  requestId: string,
  signal: AbortSignal,
  fetcher: typeof fetch
): Promise<MatrixCloudStopOutcome> {
  const url = new URL(base)
  if (
    url.protocol !== 'https:' || url.username || url.password ||
    (!('kind' in source) && (!/^!.{1,1023}$/.test(source.room) || !/^\$.{1,1023}$/.test(source.event)))
  ) {
    throw new Error('matrix_host_stop_invalid')
  }
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
    body: JSON.stringify({ agent, requestId, source }),
    signal
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(response.status === 401 ? 'matrix_s1_authentication' : 'matrix_host_stop_refused')
  }
  const receipt = (await readDomainJson(response, 4096)) as Record<string, unknown> | null
  signal.throwIfAborted()
  if (receipt?.ok !== true || receipt.requestId !== requestId) {
    throw new Error('matrix_host_stop_unconfirmed')
  }
  if ('kind' in source) {
    if (response.status !== 200) {
      throw new Error('matrix_host_stop_unconfirmed')
    }

    // The host verifies the native tuple before replying under this exact request ID.
    if (receipt.state === 'interrupted' && receipt.cancelled === true && receipt.interrupted === true) {
      return { state: 'stopped' }
    }
    if (receipt.cancelled === false && receipt.interrupted === false) {
      if (receipt.state === 'finished') { return { state: 'finished' } }
      if (receipt.state === 'pending' || receipt.state === 'unknown') { return { state: 'stop_requested' } }
    }
    throw new Error('matrix_host_stop_unconfirmed')
  }
  if (receipt.cancelled !== true || typeof receipt.interrupted !== 'boolean') {
    throw new Error('matrix_host_stop_unconfirmed')
  }
  // A cut to the manual turn's tools only confirms that Stop was requested.
  return { state: receipt.interrupted ? 'stopped' : 'stop_requested' }
}
