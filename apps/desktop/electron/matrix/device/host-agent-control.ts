import {
  type MatrixHostAgentControl,
  MatrixHostAgentControlRequestSchema,
  type MatrixHostAgentControlResponse,
  MatrixHostAgentControlResponseSchema
} from '../../../shared/matrix-agent-desk'
import { readDomainJson } from '../domain'

/**
 * One owner-scoped agent control through the Shell (`POST /api/host/agent-control`), with the
 * same domain bearer as host Stop and the desk reads. The body is exactly `{agent, action, job?}`:
 * the owner comes only from the bearer. A stopped runtime (409) and the shared 10-second cooldown
 * (429, `busy`) are their own errors; the reply must be the contract's `{action, changed}` for the
 * same action.
 */
export async function requestHostAgentControl(
  base: string,
  token: string,
  agent: string,
  request: MatrixHostAgentControl,
  signal: AbortSignal,
  fetcher: typeof fetch
): Promise<MatrixHostAgentControlResponse> {
  const url = new URL(base)
  const checked = MatrixHostAgentControlRequestSchema.safeParse(request)

  if (url.protocol !== 'https:' || url.username || url.password || !checked.success) {
    throw new Error('matrix_host_control_invalid')
  }

  const response = await fetcher(new URL('/api/host/agent-control', url).href, {
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Origin: url.origin,
      'X-Atum-Host-Bridge-Contract': 'atum.s2.host-bridge/1.0.0'
    },
    body: JSON.stringify({ agent, ...checked.data }),
    signal
  })

  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(
      response.status === 401
        ? 'matrix_s1_authentication'
        : response.status === 409
          ? 'matrix_host_control_stopped'
          : response.status === 429
            ? 'matrix_host_control_busy'
            : 'matrix_host_control_refused'
    )
  }

  const reply = MatrixHostAgentControlResponseSchema.safeParse(await readDomainJson(response, 4096))
  signal.throwIfAborted()

  if (!reply.success || reply.data.action !== checked.data.action) {
    throw new Error('matrix_host_control_invalid')
  }

  return reply.data
}
