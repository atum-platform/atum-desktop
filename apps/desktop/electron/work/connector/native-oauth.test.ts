import type { Session } from 'electron'
import { expect, it, vi } from 'vitest'

import type { NativeConnector } from './native'
import { approveNativeAgent } from './native-oauth'

it('finishes native CSRF approval and relays the callback to the same agent without exporting tokens', async () => {
  const authorization = new URL('https://mac.example.test/oauth/mcp/authorize')
  authorization.search = new URLSearchParams({ client_id: 'client', redirect_uri: 'https://callback.example.test/callback',
    state: 'state', resource: 'https://mac.example.test/mcp', code_challenge: 'challenge', response_type: 'code' }).toString()
  let calls = 0
  const handle = vi.fn(async (path: string, _method: string, body: Record<string, unknown>) => {
    if (path.includes('callback')) {
      expect(body).toMatchObject({ agent: 'agent', session_id: 'oauth-session', code: 'one-time-code', state: 'state' })
      expect(body).not.toHaveProperty('cookie')
      return { status: 'approved' }
    }
    return ++calls === 1 ? { auth_url: authorization.href, session_id: 'oauth-session' } : { threadId: 'pinned' }
  })
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(new URL(url).origin).toBe('https://mac.example.test')
    expect(init.redirect).toBe('error')
    if (url.endsWith('/approval')) {return Response.json({ csrfToken: 'csrf', oneClickAccess: ['full-access'] })}
    expect(JSON.parse(String(init.body)).decision).toEqual({ _tag: 'browser-session', access: 'full-access', csrfToken: 'csrf' })
    return Response.json({ redirectTo: 'https://callback.example.test/callback?code=one-time-code&state=state' })
  })
  await approveNativeAgent({ connector: { handle, consent: async () => ({ grants: [] }) } as unknown as NativeConnector,
    owner: { fetch: fetcher, cookies: { get: async () => [{ name: 'session', value: 'decoy-cookie' }] } } as unknown as Session,
    origin: 'http://127.0.0.1:12345', agent: 'agent', current: () => true,
    request: { mac: 'mac', plan: 'codex', alsoWhenScheduled: true, connectUrl: 'https://mac.example.test/mcp' } })
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(handle).toHaveBeenCalledTimes(3)
})

it('refuses a flow that points approval to another environment', async () => {
  const fetcher = vi.fn()
  await expect(approveNativeAgent({ connector: { handle: async () => ({ auth_url: 'https://foreign.example.test/oauth/mcp/authorize', session_id: 'id' }),
    consent: async () => ({ grants: [] }) } as unknown as NativeConnector,
    owner: { fetch: fetcher } as unknown as Session, origin: 'http://127.0.0.1:12345', agent: 'agent', current: () => true,
    request: { mac: 'mac', plan: 'codex', alsoWhenScheduled: false, connectUrl: 'https://mac.example.test/mcp' } })).rejects.toThrow('invalid_authorization')
  expect(fetcher).not.toHaveBeenCalled()
})
