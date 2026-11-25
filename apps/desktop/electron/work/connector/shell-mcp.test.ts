import { createHmac } from 'node:crypto'

import { expect, it, vi } from 'vitest'

import { ConnectorHttp } from './http'
import { ConnectorService } from './service'

it('shares the connector lifecycle and forwards only scoped, current-account MCP requests', async () => {
  const lifetime = new AbortController()
  let signedIn = true
  let token = 'matrix-initial-fixture'
  const refresh = vi.fn(async () => (token = 'matrix-recovered-fixture'))

  const shell = vi.fn<typeof fetch>(async (input, init) => {
    const headers = new Headers(init?.headers)
    expect(init?.redirect).toBe('error')
    expect(headers.has('cookie')).toBe(false)
    expect(new URL(String(input)).origin).toBe('https://shell.example.test')

    switch (headers.get('authorization')) {
      case 'Bearer matrix-refused-fixture': return new Response(null, { status: 401 })

      case 'Bearer matrix-unavailable-fixture': throw new Error('Shell unavailable')

      default: return Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
    }
  })

  const service = new ConnectorService('unused-receipts', {
    current: () => signedIn,
    resolve: async () => undefined,
    send: async () => '$never',
    read: async () => undefined,
    admit: async () => true
  })

  const secret = 'connector-fixture'
  const proof = (message: string) => createHmac('sha256', secret).update(message).digest('base64url')
  const auth = `Bearer ${proof('atum-work-mcp-bearer-v1')}`

  const connector = new ConnectorHttp(service, secret, {
    resource: 'https://shell.example.test/api/matrix/v1', current: () => signedIn,
    matrixToken: () => token, refreshMatrixToken: refresh, signal: lifetime.signal, fetch: shell
  })

  const endpoint = await connector.start()
  const nonce = 'efe34214-a49e-422c-8ffe-edf197818bb0'
  const probe = () => fetch(new URL(`/mcp/health?nonce=${nonce}`, endpoint), { method: 'HEAD' })

  const call = (path: string, headers?: Record<string, string>) => fetch(new URL(path, endpoint), {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json', Cookie: 'fixture=not-forwarded', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  })

  try {
    const health = await probe()
    expect(health.status).toBe(204)
    expect(health.headers.get('x-atum-work-mcp-proof')).toBe(proof(`atum-work-mcp-health-v1:${nonce}`))
    expect((await call('/mcp/google', { Authorization: `Bearer ${secret}` })).status).toBe(401)
    expect((await call('/ask')).status).toBe(401)
    expect((await call('/mcp/google', { Origin: 'https://example.invalid' })).status).toBe(404)

    expect((await call('/mcp/google')).status).toBe(200)
    token = 'matrix-refused-fixture'
    expect((await call('/mcp/owner-chats')).status).toBe(200)
    expect(refresh).toHaveBeenCalledExactlyOnceWith('matrix-refused-fixture')
    expect(shell.mock.calls.map(([input, init]) => [
      new URL(String(input)).pathname, new Headers(init?.headers).get('authorization')
    ])).toEqual([
      ['/api/mcp/google', 'Bearer matrix-initial-fixture'],
      ['/api/mcp/owner-chats', 'Bearer matrix-refused-fixture'],
      ['/api/mcp/owner-chats', 'Bearer matrix-recovered-fixture']
    ])

    token = 'matrix-unavailable-fixture'
    expect((await call('/mcp/google')).status).toBe(502)
    expect((await call('/ask', { Authorization: `Bearer ${secret}` })).status).toBe(400)
    signedIn = false
    expect((await probe()).status).toBe(404)
    expect((await call('/mcp/google')).status).toBe(404)
    expect(shell).toHaveBeenCalledTimes(4)
  } finally {
    lifetime.abort()
    await connector.close()
  }

  await expect(call('/mcp/google')).rejects.toThrow()
})
