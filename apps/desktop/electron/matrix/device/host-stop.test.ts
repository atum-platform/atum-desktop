import { describe, expect, it, vi } from 'vitest'

import { requestHostStop } from './host-stop'

const agent = '00000000-0000-4000-8000-159badba71cd'
const signal = new AbortController().signal

describe('Shell host Stop', () => {
  it('sends the exact source with owner bearer, CSRF origin and contract header', async () => {
    const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body).toEqual({ agent, requestId: expect.any(String), source: { room: '!dm:test', event: '$owner' } })
      return Response.json({ ok: true, requestId: body.requestId, cancelled: true, interrupted: true })
    })
    await expect(requestHostStop('https://shell.test/api/matrix/v1', 'synthetic-token', agent, '!dm:test', '$owner', signal, fetcher)).resolves.toEqual({ state: 'stop_requested' })
    expect(fetcher).toHaveBeenCalledWith('https://shell.test/api/host/stop', expect.objectContaining({
      method: 'POST', credentials: 'include', redirect: 'error',
      headers: { Authorization: 'Bearer synthetic-token', 'Content-Type': 'application/json', Origin: 'https://shell.test', 'X-Atum-Host-Bridge-Contract': 'atum.s2.host-bridge/1.0.0' }
    }))
  })

  it.each([401, 403, 409, 503])('reduces typed refusal %s to a short safe error and permits another attempt', async status => {
    const fetcher = vi.fn(async () => Response.json({ state: 'refused', detail: 'private\n'.repeat(100) }, { status }))
    await expect(requestHostStop('https://shell.test/api/matrix/v1', 'synthetic-token', agent, '!dm:test', '$owner', signal, fetcher)).rejects.toThrow(status === 401 ? 'matrix_s1_authentication' : 'matrix_host_stop_refused')
    await expect(requestHostStop('https://shell.test/api/matrix/v1', 'synthetic-token', agent, '!dm:test', '$owner', signal, fetcher)).rejects.toThrow(status === 401 ? 'matrix_s1_authentication' : 'matrix_host_stop_refused')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('refuses an unconfirmed receipt', async () => {
    await expect(requestHostStop('https://shell.test/api/matrix/v1', 'synthetic-token', agent, '!dm:test', '$owner', signal, async () => Response.json({ ok: true }))).rejects.toThrow('matrix_host_stop_unconfirmed')
  })
})
