import {
  MATRIX_HOST_DESK_MAX_BYTES,
  MatrixHostDeskPathSchema,
  type MatrixHostDeskRead,
  type MatrixHostDeskResponse,
  MatrixHostDeskResponseSchema
} from '../../../shared/matrix-agent-desk'
import { readDomainJson } from '../domain'

/**
 * One owner-scoped desk read through the Shell (`POST /api/host/desk`), with the same domain
 * bearer as host Stop. The body is exactly `{agent, read, path?}`: the owner comes only from
 * the bearer. Every reply is checked against the contract; anything off it is refused.
 */
export async function requestHostDesk(
  base: string,
  token: string,
  agent: string,
  request: MatrixHostDeskRead,
  signal: AbortSignal,
  fetcher: typeof fetch
): Promise<MatrixHostDeskResponse> {
  const url = new URL(base)
  const path = request.read === 'files' ? request.path : undefined

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !['schedule', 'memory', 'files'].includes(request.read) ||
    (path !== undefined && !MatrixHostDeskPathSchema.safeParse(path).success)
  ) {
    throw new Error('matrix_host_desk_invalid')
  }

  const response = await fetcher(new URL('/api/host/desk', url).href, {
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Origin: url.origin,
      'X-Atum-Host-Bridge-Contract': 'atum.s2.host-bridge/1.0.0'
    },
    body: JSON.stringify({ agent, read: request.read, ...(path !== undefined ? { path } : {}) }),
    signal
  })

  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(response.status === 401 ? 'matrix_s1_authentication' : 'matrix_host_desk_refused')
  }

  const reply = MatrixHostDeskResponseSchema.safeParse(await readDomainJson(response, MATRIX_HOST_DESK_MAX_BYTES))
  signal.throwIfAborted()

  if (!reply.success || reply.data.read !== request.read) {
    throw new Error('matrix_host_desk_invalid')
  }

  if (reply.data.read === 'files') {
    const [root, ...parts] = (path ?? 'home').split('/')

    if (reply.data.root !== root || reply.data.path !== parts.join('/')) {
      throw new Error('matrix_host_desk_invalid')
    }
  }

  return reply.data
}
