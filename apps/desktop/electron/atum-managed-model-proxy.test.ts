import assert from 'node:assert/strict'

import { afterEach, test, vi } from 'vitest'

import {
  AtumManagedModelProxy,
  MANAGED_ACCESS_TIMEOUT_MS,
  MANAGED_ALIASES,
  MANAGED_CONTEXT_LENGTH,
  MANAGED_MAX_OUTPUT_TOKENS,
  managedLoopbackProxyBypassEnvironment,
  managedRequestBody,
  MAX_REQUEST_BYTES
} from './atum-managed-model-proxy'
import type { MessagingAccountSession } from './atum-messaging/types'

const reservationId = '00000000-0000-4000-8000-8ed3eb6a6170'
const claimId = '00000000-0000-4000-8000-967df44633da'
const proxies: AtumManagedModelProxy[] = []

afterEach(async () => {
  await Promise.all(proxies.splice(0).map(proxy => proxy.stop()))
  vi.restoreAllMocks()
})

function session(accessToken = 'atum-access'): MessagingAccountSession {
  return {
    baseUrl: 'https://atum.test',
    user: { id: 'owner', displayName: 'Owner', handle: 'owner' },
    tokens: { accessToken, refreshToken: 'atum-refresh', expiresAt: null }
  }
}

function completion(finishReason: string, content: string | null, toolCalls?: unknown[]) {
  return {
    id: 'provider-request-1',
    object: 'chat.completion',
    created: 1,
    model: 'deepseek-chat',
    choices: [{
      index: 0,
      finish_reason: finishReason,
      message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }
    }],
    usage: {
      prompt_tokens: 10,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12
    }
  }
}

test('loopback proxy authenticates locally and advertises the fixed managed catalog', async () => {
  const proxy = new AtumManagedModelProxy({
    fetchImpl: async () => new Response(null, { status: 500 }),
    tokens: { current: () => session(), refresh: async () => null }
  })

  proxies.push(proxy)
  await proxy.start()

  const environment = proxy.backendEnvironment()
  assert.equal(environment.ATUM_MANAGED_MODEL_DEFAULT, 'binh-minh')
  assert.equal(environment.HERMES_MODEL, undefined)
  assert.equal(environment.HERMES_TUI_PROVIDER, undefined)
  assert.match(environment.ATUM_MANAGED_MODEL_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/u)
  assert.ok(environment.ATUM_MANAGED_MODEL_PROXY_TOKEN.length >= 32)

  const rejected = await fetch(`${environment.ATUM_MANAGED_MODEL_BASE_URL}/models`)
  assert.equal(rejected.status, 401)

  const accepted = await fetch(`${environment.ATUM_MANAGED_MODEL_BASE_URL}/models`, {
    headers: { authorization: `Bearer ${environment.ATUM_MANAGED_MODEL_PROXY_TOKEN}` }
  })

  assert.equal(accepted.status, 200)
  assert.deepEqual(await accepted.json(), {
    object: 'list',
    data: MANAGED_ALIASES.map(id => ({
      id,
      object: 'model',
      created: 0,
      owned_by: 'atum',
      context_length: 75_000,
      // What it advertises is exactly what it accepts (the over-cap test below).
      max_output_tokens: MANAGED_MAX_OUTPUT_TOKENS
    }))
  })
})

test('managed loopback child env bypasses hostile proxies without disabling external proxy inheritance', async () => {
  const logs: string[] = []

  const hostileEnvironment = {
    HTTP_PROXY: 'http://127.0.0.1:1',
    HTTPS_PROXY: 'http://127.0.0.1:1',
    ALL_PROXY: 'http://127.0.0.1:1',
    http_proxy: 'http://127.0.0.1:2',
    https_proxy: 'http://127.0.0.1:2',
    all_proxy: 'http://127.0.0.1:2',
    NO_PROXY: 'metadata.internal',
    no_proxy: 'corp.internal,METADATA.INTERNAL'
  }

  const proxy = new AtumManagedModelProxy({
    fetchImpl: async () => new Response(null, { status: 500 }),
    log: message => logs.push(message),
    tokens: { current: () => session(), refresh: async () => null }
  })

  assert.deepEqual(proxy.backendEnvironment(hostileEnvironment), {})
  assert.deepEqual(logs, [])
  proxies.push(proxy)
  await proxy.start()

  const childEnvironment: Record<string, string> = {
    ...hostileEnvironment,
    ...proxy.backendEnvironment(hostileEnvironment)
  }

  assert.equal(childEnvironment.HTTP_PROXY, hostileEnvironment.HTTP_PROXY)
  assert.equal(childEnvironment.HTTPS_PROXY, hostileEnvironment.HTTPS_PROXY)
  assert.equal(childEnvironment.ALL_PROXY, hostileEnvironment.ALL_PROXY)
  assert.equal(childEnvironment.http_proxy, hostileEnvironment.http_proxy)
  assert.equal(childEnvironment.https_proxy, hostileEnvironment.https_proxy)
  assert.equal(childEnvironment.all_proxy, hostileEnvironment.all_proxy)
  assert.equal(childEnvironment.NO_PROXY, 'corp.internal,METADATA.INTERNAL,127.0.0.1')
  assert.equal(childEnvironment.no_proxy, childEnvironment.NO_PROXY)
  assert.match(childEnvironment.ATUM_MANAGED_MODEL_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/u)
  assert.ok(childEnvironment.ATUM_MANAGED_MODEL_PROXY_TOKEN.length >= 32)
  assert.ok(logs.includes('[atum-managed-model] Hermes child proxy bypass configured for 127.0.0.1'))
})

test('loopback bypass merge is case-insensitive and idempotent', () => {
  assert.deepEqual(
    managedLoopbackProxyBypassEnvironment({ no_proxy: '127.0.0.1,EXAMPLE.test,example.TEST' }),
    {
      NO_PROXY: '127.0.0.1,EXAMPLE.test',
      no_proxy: '127.0.0.1,EXAMPLE.test'
    }
  )
})

test('loopback bypass preserves the effective lowercase override and global wildcard semantics', () => {
  assert.deepEqual(
    managedLoopbackProxyBypassEnvironment({ NO_PROXY: 'ignored.example', no_proxy: 'effective.example' }),
    {
      NO_PROXY: 'effective.example,127.0.0.1',
      no_proxy: 'effective.example,127.0.0.1'
    }
  )
  assert.deepEqual(managedLoopbackProxyBypassEnvironment({ NO_PROXY: 'ignored.example', no_proxy: '' }), {
    NO_PROXY: '127.0.0.1',
    no_proxy: '127.0.0.1'
  })
  assert.deepEqual(managedLoopbackProxyBypassEnvironment({ NO_PROXY: '*' }), {
    NO_PROXY: '*',
    no_proxy: '*'
  })
})

test('the hatch alias is accepted on a private completion, not advertised, not shared', () => {
  assert.equal(managedRequestBody({ model: 'hatch', messages: [] })?.model, 'hatch')
  assert.ok(!(MANAGED_ALIASES as readonly string[]).includes('hatch'), '/v1/models does not list it')
})

test('managed requests preserve only one of the three public aliases', () => {
  for (const model of MANAGED_ALIASES) {
    assert.equal(managedRequestBody({ model, messages: [] })?.model, model)
  }

  assert.equal(managedRequestBody({ model: 'deepseek-v4-pro', messages: [] }), null)
})

test('a request for the whole gateway alias output (16,384 tokens) passes through unchanged', () => {
  // The gateway caps every managed alias at 16,384 output tokens (atum-models.yaml); the Mac
  // must never refuse less than the gateway allows.
  assert.equal(managedRequestBody({ model: 'binh-minh', messages: [], max_tokens: 16_384 })?.max_tokens, 16_384)
  assert.ok(MANAGED_MAX_OUTPUT_TOKENS >= 16_384)
  assert.equal(managedRequestBody({ model: 'binh-minh', messages: [], max_tokens: MANAGED_MAX_OUTPUT_TOKENS + 1 }), null)
})

test('advertised context stays below the bounded transport budget', () => {
  // Reserve 5 bytes per token plus 25 KB for JSON/tool-schema overhead. This
  // invariant keeps automatic compression ahead of the 400 KB request cap.
  assert.ok(MANAGED_CONTEXT_LENGTH * 5 <= MAX_REQUEST_BYTES - 25_000)
})

test('access state is read without creating a reservation', async () => {
  const paths: string[] = []
  const timeout = vi.spyOn(AbortSignal, 'timeout')

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async input => {
      paths.push(new URL(String(input)).pathname)

      return new Response(
        JSON.stringify({
          state: 'ready',
          access_alias: 'binh-minh',
          billing_currency: 'protons',
          alias_version: 'binh-minh-v1',
          available_protons: 25,
          held_protons: 0,
          next_quote_protons: 5
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
  })

  assert.equal((await proxy.accessState()).state, 'ready')
  assert.deepEqual(paths, ['/api/managed-model/access'])
  assert.equal(timeout.mock.calls.at(-1)?.[0], MANAGED_ACCESS_TIMEOUT_MS)
})

test('access state refreshes authentication once and keeps expiry distinct', async () => {
  const refresh = async () => session('refreshed-access')
  const seenTokens: string[] = []

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session('expired-access'), refresh },
    fetchImpl: async (_input, init) => {
      seenTokens.push(new Headers(init?.headers).get('authorization') ?? '')

      return seenTokens.length === 1
        ? new Response('{}', { status: 401 })
        : new Response(JSON.stringify({ state: 'insufficient_funds', access_alias: 'binh-minh', billing_currency: 'protons' }), { status: 200 })
    }
  })

  assert.deepEqual(await proxy.accessState(), { state: 'insufficient_funds', access_alias: 'binh-minh', billing_currency: 'protons' })
  assert.deepEqual(seenTokens, ['Bearer expired-access', 'Bearer refreshed-access'])

  const expired = new AtumManagedModelProxy({
    tokens: { current: () => null, refresh: async () => null },
    fetchImpl: async () => {
      throw new Error('must not call')
    }
  })

  assert.deepEqual(await expired.accessState(), { state: 'authentication_expired' })
})

test('access state fails closed on malformed and transport responses', async () => {
  const malformed = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async () => new Response(JSON.stringify({ state: 'future_state' }), { status: 200 })
  })

  const failed = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async () => {
      throw new Error('offline')
    }
  })

  assert.deepEqual(await malformed.accessState(), { state: 'unavailable' })
  assert.deepEqual(await failed.accessState(), { state: 'unavailable' })
})

test('one reservation spans the first tool call and its terminal continuation', async () => {
  const hostedRequests: Array<{ body: unknown; headers: Headers; path: string }> = []
  let completionIndex = 0

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input))
      const headers = new Headers(init?.headers)
      const body = init?.body ? JSON.parse(String(init.body)) : null
      hostedRequests.push({ body, headers, path: url.pathname })

      if (url.pathname.endsWith('/reservations')) {
        return new Response(JSON.stringify({
          reservation_id: reservationId,
          claim_id: claimId,
          expires_at: new Date(Date.now() + 60_000).toISOString()
        }), {
          status: 201,
          headers: { 'content-type': 'application/json' }
        })
      }

      completionIndex += 1

      const value = completionIndex === 1
        ? completion('tool_calls', null, [{
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"README.md"}' }
          }])
        : completion('stop', 'done')

      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-atum-settlement-state': 'settled' }
      })
    }
  })

  proxies.push(proxy)
  await proxy.start()
  const environment = proxy.backendEnvironment()
  const endpoint = `${environment.ATUM_MANAGED_MODEL_BASE_URL}/chat/completions`

  const headers = {
    authorization: `Bearer ${environment.ATUM_MANAGED_MODEL_PROXY_TOKEN}`,
    'content-type': 'application/json'
  }

  const first = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'binh-minh',
      messages: [{ role: 'user', content: 'read it' }],
      stream: false,
      stream_options: { include_usage: true },
      parallel_tool_calls: true
    })
  })

  assert.equal(first.status, 200)
  assert.equal((await first.json() as { choices: Array<{ finish_reason: string }> }).choices[0].finish_reason, 'tool_calls')

  const unrelated = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'binh-minh',
      messages: [{ role: 'user', content: 'different conversation' }],
      stream: false
    })
  })

  assert.equal(unrelated.status, 409)
  assert.deepEqual(await unrelated.json(), {
    error: {
      message: 'managed_turn_in_progress',
      type: 'atum_managed_model_error',
      code: 'managed_turn_in_progress'
    }
  })

  const second = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'binh-minh',
      messages: [
        { role: 'user', content: 'read it' },
        { role: 'assistant', content: null, tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"README.md"}' }
        }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'Atum' }
      ],
      stream: false
    })
  })

  assert.equal(second.status, 200)

  assert.deepEqual(hostedRequests.map(request => request.path), [
    '/api/managed-model/reservations',
    '/api/managed-model/chat/completions',
    '/api/managed-model/chat/completions'
  ])
  assert.deepEqual(hostedRequests[0].body, { model: 'binh-minh', request_id: hostedRequests[1].headers.get('x-atum-request-id') })
  assert.notEqual(hostedRequests[1].headers.get('x-atum-request-id'), hostedRequests[2].headers.get('x-atum-request-id'))
  assert.equal(hostedRequests[1].headers.get('x-atum-reservation-id'), reservationId)
  assert.equal(hostedRequests[1].headers.get('x-atum-claim-id'), claimId)
  assert.equal(hostedRequests[2].headers.get('x-atum-reservation-id'), reservationId)
  assert.equal(hostedRequests[2].headers.get('x-atum-claim-id'), null)
  assert.equal((hostedRequests[1].body as Record<string, unknown>).stream, false)
  assert.equal('stream_options' in (hostedRequests[1].body as Record<string, unknown>), false)
  assert.equal('parallel_tool_calls' in (hostedRequests[1].body as Record<string, unknown>), false)
})

test('releases a source-read permit only for a protected Workspace tool turn and its session', async () => {
  const grants: Array<{ sessionId: string; permits: number }> = []
  let completionIndex = 0

  const toolCall = {
    id: 'call-workspace',
    type: 'function',
    function: { name: 'atum_utilities.py', arguments: '{"action":"inbox"}' }
  }

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    onWorkspaceSourceRead: (sessionId, permits) => grants.push({ sessionId, permits }),
    fetchImpl: async input => {
      const path = new URL(String(input)).pathname

      if (path.endsWith('/reservations')) {
        return new Response(JSON.stringify({
          reservation_id: reservationId,
          claim_id: claimId,
          expires_at: new Date(Date.now() + 60_000).toISOString()
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      }

      completionIndex += 1
      const protectedRoute = completionIndex !== 2

      const value = completionIndex === 2
        ? completion('stop', 'done')
        : completion('tool_calls', null, completionIndex === 3
          ? [{ id: 'call-generic', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }]
          : [toolCall, { ...toolCall, id: `call-${completionIndex}` }])

      return new Response(JSON.stringify(value), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          ...(protectedRoute ? { 'x-atum-workspace-source-route': '1' } : {})
        }
      })
    }
  })

  proxies.push(proxy)
  await proxy.start()
  const environment = proxy.backendEnvironment()
  const endpoint = `${environment.ATUM_MANAGED_MODEL_BASE_URL}/chat/completions`

  const headers = {
    authorization: `Bearer ${environment.ATUM_MANAGED_MODEL_PROXY_TOKEN}`,
    'content-type': 'application/json',
    'x-atum-session-id': 'workspace-session-a'
  }

  const firstBody = { model: 'binh-minh', messages: [{ role: 'user', content: 'Check my inbox' }], stream: false }

  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(firstBody) })).status, 200)
  assert.deepEqual(grants, [{ sessionId: 'workspace-session-a', permits: 2 }])

  assert.equal((await fetch(endpoint, {
    method: 'POST', headers, body: JSON.stringify({
      ...firstBody,
      messages: [
        ...firstBody.messages,
        { role: 'assistant', content: null, tool_calls: [toolCall, { ...toolCall, id: 'call-1' }] },
        { role: 'tool', tool_call_id: toolCall.id, content: 'No unread mail.' },
        { role: 'tool', tool_call_id: 'call-1', content: 'No events.' }
      ]
    })
  })).status, 200)

  assert.equal((await fetch(endpoint, {
    method: 'POST', headers, body: JSON.stringify({
      model: 'binh-minh', messages: [{ role: 'user', content: 'Check tomorrow' }], stream: false
    })
  })).status, 200)
  assert.deepEqual(grants, [{ sessionId: 'workspace-session-a', permits: 2 }])
})

test('protected private Workspace requests pin Nguyet to Binh for both reservation and dispatch', async () => {
  const hosted: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = []
  const grants: Array<{ sessionId: string; permits: number }> = []

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    workspaceProtected: () => true,
    onWorkspaceSourceRead: (sessionId, permits) => grants.push({ sessionId, permits }),
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      hosted.push({ path, body, headers: new Headers(init?.headers) })

      if (path.endsWith('/reservations')) {
        return new Response(JSON.stringify({ reservation_id: reservationId, claim_id: claimId }), {
          status: 201, headers: { 'content-type': 'application/json' }
        })
      }

      return new Response(JSON.stringify(completion('tool_calls', null, [{
        id: 'workspace-call', type: 'function', function: { name: 'atum_utilities.py', arguments: '{"action":"inbox"}' }
      }])), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-atum-workspace-source-route': '1' }
      })
    }
  })

  proxies.push(proxy)
  await proxy.start()
  const environment = proxy.backendEnvironment()

  const response = await fetch(`${environment.ATUM_MANAGED_MODEL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${environment.ATUM_MANAGED_MODEL_PROXY_TOKEN}`,
      'content-type': 'application/json', 'x-atum-session-id': 'workspace-private-a'
    },
    body: JSON.stringify({ model: 'nguyet-thuc', messages: [{ role: 'user', content: 'private inbox' }] })
  })

  assert.equal(response.status, 200)
  assert.deepEqual(hosted.map(request => request.body.model), ['binh-minh', 'binh-minh'])
  assert.equal(hosted[1].headers.get('x-atum-workspace-protected'), '1')
  assert.deepEqual(grants, [{ sessionId: 'workspace-private-a', permits: 1 }])
})

test('protected routing refuses an unattested provider response without returning its result or granting permits', async () => {
  let upstreamCalls = 0
  const grants: Array<{ sessionId: string; permits: number }> = []

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    workspaceProtected: () => true,
    onWorkspaceSourceRead: (sessionId, permits) => grants.push({ sessionId, permits }),
    fetchImpl: async input => {
      const path = new URL(String(input)).pathname

      if (path.endsWith('/reservations')) {
        return new Response(JSON.stringify({ reservation_id: reservationId, claim_id: claimId }), {
          status: 201, headers: { 'content-type': 'application/json' }
        })
      }

      upstreamCalls += 1

      return new Response(JSON.stringify(completion('tool_calls', 'private provider result', [{
        id: 'workspace-call', type: 'function', function: { name: 'atum_utilities.py', arguments: '{}' }
      }])), { status: 200, headers: { 'content-type': 'application/json' } })
    }
  })

  proxies.push(proxy)
  await proxy.start()
  const environment = proxy.backendEnvironment()

  const response = await fetch(`${environment.ATUM_MANAGED_MODEL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${environment.ATUM_MANAGED_MODEL_PROXY_TOKEN}`,
      'content-type': 'application/json', 'x-atum-session-id': 'workspace-private-b'
    },
    body: JSON.stringify({ model: 'binh-minh', messages: [{ role: 'user', content: 'private inbox' }] })
  })

  assert.equal(response.status, 502)
  assert.deepEqual(await response.json(), {
    error: { message: 'workspace_route_unconfirmed', type: 'atum_managed_model_error', code: 'workspace_route_unconfirmed' }
  })
  assert.equal(upstreamCalls, 1)
  assert.deepEqual(grants, [])
})

test('a false protection callback preserves a private alias, while a throwing callback fails before forwarding', async () => {
  const hosted: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = []

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    workspaceProtected: () => false,
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname
      hosted.push({ path, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) })

      return path.endsWith('/reservations')
        ? new Response(JSON.stringify({ reservation_id: reservationId, claim_id: claimId }), { status: 201 })
        : new Response(JSON.stringify(completion('stop', 'done')), { status: 200 })
    }
  })

  proxies.push(proxy)
  await proxy.start()
  const environment = proxy.backendEnvironment()
  const endpoint = `${environment.ATUM_MANAGED_MODEL_BASE_URL}/chat/completions`
  const headers = { authorization: `Bearer ${environment.ATUM_MANAGED_MODEL_PROXY_TOKEN}`, 'content-type': 'application/json' }
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ model: 'nguyet-thuc', messages: [] }) })).status, 200)
  assert.deepEqual(hosted.map(request => request.body.model), ['nguyet-thuc', 'nguyet-thuc'])
  assert.equal(hosted[1].headers.get('x-atum-workspace-protected'), null)

  let forwarded = 0

  const throwing = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    workspaceProtected: () => { throw new Error('workspace callback failed') },
    fetchImpl: async () => {
      forwarded += 1

      return new Response(null, { status: 500 })
    }
  })

  proxies.push(throwing)
  await throwing.start()
  const failedEnvironment = throwing.backendEnvironment()

  const failed = await fetch(`${failedEnvironment.ATUM_MANAGED_MODEL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${failedEnvironment.ATUM_MANAGED_MODEL_PROXY_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'binh-minh', messages: [] })
  })

  assert.equal(failed.status, 502)
  assert.equal(forwarded, 0)
})

test('protected shared jobs reject non-Binh aliases before reserving an upstream turn', async () => {
  let forwarded = 0

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    workspaceProtected: () => true,
    fetchImpl: async () => {
      forwarded += 1

      return new Response(null, { status: 500 })
    }
  })

  proxies.push(proxy)
  await proxy.start()

  const shared = proxy.issueSharedJobToken({
    jobId: 'workspace-shared', leaseToken: 'lease', alias: 'nguyet-thuc', accountId: 'owner', baseUrl: 'https://atum.test', deviceCredential: () => 'device'
  })

  const response = await fetch(`${shared.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${shared.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nguyet-thuc', messages: [] })
  })

  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), {
    error: { message: 'workspace_route_required', type: 'atum_managed_model_error', code: 'workspace_route_required' }
  })
  assert.equal(forwarded, 0)
})

test('private reservations are isolated by workspace session and fenced when the account changes', async () => {
  const hosted: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = []
  let failAuthority = false
  let reservationCount = 0
  let current = session()
  let holdReservation = false
  let releaseReservation!: (response: Response) => void

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => current, refresh: async () => null },
    workspaceProtected: () => { if (failAuthority) { throw new Error("authority temporarily unavailable") };

 return false },
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      hosted.push({ path, body, headers: new Headers(init?.headers) })

      if (path.endsWith('/reservations')) {
        if (holdReservation) { return await new Promise<Response>(resolve => { releaseReservation = resolve }) }
        reservationCount += 1

        return new Response(JSON.stringify({ reservation_id: `reservation-${reservationCount}`, claim_id: `claim-${reservationCount}` }), { status: 201 })
      }

      const messages = body.messages as unknown[]

      return new Response(JSON.stringify(messages.length === 1 && (messages[0] as { content?: string }).content === 'main'
        ? completion('tool_calls', null, [{ id: 'call-main', type: 'function', function: { name: 'read_file', arguments: '{}' } }])
        : completion('stop', 'done')), { status: 200 })
    }
  })

  proxies.push(proxy)
  await proxy.start()
  const environment = proxy.backendEnvironment()
  const endpoint = `${environment.ATUM_MANAGED_MODEL_BASE_URL}/chat/completions`

  const headers = (sessionId: string) => ({
    authorization: `Bearer ${environment.ATUM_MANAGED_MODEL_PROXY_TOKEN}`,
    'content-type': 'application/json', 'x-atum-session-id': sessionId
  })

  const main = { model: 'binh-minh', messages: [{ role: 'user', content: 'main' }] }
  assert.equal((await fetch(endpoint, { method: 'POST', headers: headers('session-A'), body: JSON.stringify(main) })).status, 200)
  failAuthority = true
  assert.equal((await fetch(endpoint, { method: 'POST', headers: headers('failed-session'), body: JSON.stringify({ model: 'binh-minh', messages: [] }) })).status, 502)
  failAuthority = false
  assert.equal((await fetch(endpoint, { method: 'POST', headers: headers('session-B'), body: JSON.stringify({ model: 'binh-minh', messages: [{ role: 'user', content: 'auxiliary' }] }) })).status, 200)
  assert.equal((await fetch(endpoint, {
    method: 'POST', headers: headers('session-A'), body: JSON.stringify({
      model: 'binh-minh', messages: [...main.messages, { role: 'assistant', content: null, tool_calls: [{ id: 'call-main', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call-main', content: 'done' }]
    })
  })).status, 200)
  assert.equal(reservationCount, 2)
  assert.deepEqual(hosted.filter(request => request.path.endsWith('/chat/completions')).map(request => request.headers.get('x-atum-reservation-id')), ['reservation-1', 'reservation-2', 'reservation-1'])

  holdReservation = true
  const pending = fetch(endpoint, { method: 'POST', headers: headers('session-C'), body: JSON.stringify({ model: 'binh-minh', messages: [] }) })
  await vi.waitFor(() => assert.ok(releaseReservation))
  current = { ...session(), user: { id: 'other', displayName: 'Other', handle: 'other' } }
  releaseReservation(new Response(JSON.stringify({ reservation_id: 'late', claim_id: 'late' }), { status: 201 }))
  assert.equal((await pending).status, 401)
  assert.equal(hosted.filter(request => request.path.endsWith('/chat/completions')).length, 3)
})

test('rejects a revoked backend before forwarding any private completion', async () => {
  let live = true
  const fetchImpl = vi.fn(async () => new Response('{}', { status: 500 }))

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null }, fetchImpl,
    privateRequestLive: token => () => token === 'current-backend' && live
  })

  proxies.push(proxy)
  await proxy.start()
  const environment = proxy.backendEnvironment()
  live = false

  const response = await fetch(`${environment.ATUM_MANAGED_MODEL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${environment.ATUM_MANAGED_MODEL_PROXY_TOKEN}`, 'content-type': 'application/json', 'x-atum-backend-token': 'current-backend' },
    body: JSON.stringify({ model: 'binh-minh', messages: [{ role: 'user', content: 'old account history' }] })
  })

  assert.equal(response.status, 401)
  assert.equal(fetchImpl.mock.calls.length, 0)
})

test('non-streaming hosted response is projected into OpenAI SSE for Hermes', async () => {
  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async input => {
      const url = new URL(String(input))

      return url.pathname.endsWith('/reservations')
        ? new Response(JSON.stringify({ reservation_id: reservationId, claim_id: claimId }), {
            status: 201,
            headers: { 'content-type': 'application/json' }
          })
        : new Response(JSON.stringify(completion('stop', 'Xin chào')), {
            status: 200,
            headers: { 'content-type': 'application/json', 'x-atum-settlement-state': 'settled' }
          })
    }
  })

  proxies.push(proxy)
  await proxy.start()
  const environment = proxy.backendEnvironment()

  const response = await fetch(`${environment.ATUM_MANAGED_MODEL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${environment.ATUM_MANAGED_MODEL_PROXY_TOKEN}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model: 'binh-minh', messages: [{ role: 'user', content: 'hello' }], stream: true })
  })

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/u)
  assert.equal(response.headers.get('x-atum-settlement-state'), 'settled')
  const text = await response.text()
  assert.match(text, /"content":"Xin chào"/u)
  assert.match(text, /"finish_reason":"stop"/u)
  assert.match(text, /"prompt_tokens":10/u)
  assert.match(text, /data: \[DONE\]/u)
})

test('a lost response recovers the same request and reservation before the next turn', async () => {
  let chatAttempts = 0
  let reservations = 0
  const requestIds: Array<string | null> = []

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input))

      if (url.pathname.endsWith('/reservations')) {
        reservations += 1

        return new Response(JSON.stringify({ reservation_id: reservationId, claim_id: claimId }), {
          status: 201,
          headers: { 'content-type': 'application/json' }
        })
      }

      chatAttempts += 1
      requestIds.push(new Headers(init?.headers).get('x-atum-request-id'))

      if (chatAttempts === 1) {
        throw new Error('offline')
      }

      return new Response(JSON.stringify(completion('stop', 'recovered')), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  })

  proxies.push(proxy)
  await proxy.start()
  const environment = proxy.backendEnvironment()
  const endpoint = `${environment.ATUM_MANAGED_MODEL_BASE_URL}/chat/completions`

  const headers = {
    authorization: `Bearer ${environment.ATUM_MANAGED_MODEL_PROXY_TOKEN}`,
    'content-type': 'application/json'
  }

  const failed = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'binh-minh', messages: [{ role: 'user', content: 'first' }] })
  })

  assert.equal(failed.status, 200)
  assert.equal(reservations, 1)
  assert.equal(requestIds[0], requestIds[1])

  const recovered = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'binh-minh', messages: [{ role: 'user', content: 'second' }] })
  })

  assert.equal(recovered.status, 200)
  assert.equal(reservations, 2)
})

test('signed-out request fails closed without calling the hosted edge', async () => {
  let hostedCalls = 0

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => null, refresh: async () => null },
    fetchImpl: async () => {
      hostedCalls += 1

      return new Response(null, { status: 500 })
    }
  })

  proxies.push(proxy)
  await proxy.start()
  const environment = proxy.backendEnvironment()

  const response = await fetch(`${environment.ATUM_MANAGED_MODEL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${environment.ATUM_MANAGED_MODEL_PROXY_TOKEN}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model: 'binh-minh', messages: [{ role: 'user', content: 'hello' }] })
  })

  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), {
    error: {
      message: 'authentication_expired',
      type: 'atum_managed_model_error',
      code: 'authentication_expired'
    }
  })
  assert.equal(hostedCalls, 0)
})

test.each([402, 429])('reservation cutoff %s is passed through without provider dispatch', async status => {
  const hostedPaths: string[] = []

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async input => {
      hostedPaths.push(new URL(String(input)).pathname)

      return new Response(JSON.stringify({ error: status === 402 ? 'managed_budget_exhausted' : 'managed_rate_limited' }), {
        status,
        headers: { 'content-type': 'application/json' }
      })
    }
  })

  proxies.push(proxy)
  await proxy.start()
  const environment = proxy.backendEnvironment()

  const response = await fetch(`${environment.ATUM_MANAGED_MODEL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${environment.ATUM_MANAGED_MODEL_PROXY_TOKEN}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model: 'binh-minh', messages: [{ role: 'user', content: 'hello' }] })
  })

  assert.equal(response.status, status)
  assert.deepEqual(await response.json(), {
    error: {
      message: status === 402 ? 'managed_budget_exhausted' : 'managed_rate_limited',
      type: 'atum_managed_model_error',
      code: status === 402 ? 'managed_budget_exhausted' : 'managed_rate_limited'
    }
  })
  assert.deepEqual(hostedPaths, ['/api/managed-model/reservations'])
})

test('completion cutoff is passed through and clears the reservation', async () => {
  let reservations = 0
  let completions = 0

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async input => {
      const path = new URL(String(input)).pathname

      if (path.endsWith('/reservations')) {
        reservations += 1

        return new Response(JSON.stringify({ reservation_id: reservationId, claim_id: claimId }), {
          status: 201,
          headers: { 'content-type': 'application/json' }
        })
      }

      completions += 1

      return completions === 1
        ? new Response(JSON.stringify({ error: 'managed_rate_limited' }), {
            status: 429,
            headers: { 'content-type': 'application/json' }
          })
        : new Response(JSON.stringify(completion('stop', 'recovered')), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
    }
  })

  proxies.push(proxy)
  await proxy.start()
  const environment = proxy.backendEnvironment()
  const endpoint = `${environment.ATUM_MANAGED_MODEL_BASE_URL}/chat/completions`

  const headers = {
    authorization: `Bearer ${environment.ATUM_MANAGED_MODEL_PROXY_TOKEN}`,
    'content-type': 'application/json'
  }

  const request = (content: string) => fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'binh-minh', messages: [{ role: 'user', content }] })
  })

  const rejected = await request('first')

  assert.equal(rejected.status, 429)
  const recovered = await request('second')

  assert.equal(recovered.status, 200)
  assert.equal(reservations, 2)
})

test('unsupported constrained decoding is rejected instead of silently dropped', async () => {
  let hostedCalls = 0

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async () => {
      hostedCalls += 1

      return new Response(null, { status: 500 })
    }
  })

  proxies.push(proxy)
  await proxy.start()
  const environment = proxy.backendEnvironment()

  const response = await fetch(`${environment.ATUM_MANAGED_MODEL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${environment.ATUM_MANAGED_MODEL_PROXY_TOKEN}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'binh-minh',
      messages: [{ role: 'user', content: 'json please' }],
      response_format: { type: 'json_object' }
    })
  })

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: {
      message: 'response_format is not supported by Atum managed models',
      type: 'atum_managed_model_error',
      code: 'unsupported_managed_parameter'
    }
  })
  assert.equal(hostedCalls, 0)
})

test('null response_format is treated as absent', async () => {
  const hostedPaths: string[] = []

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async input => {
      const path = new URL(String(input)).pathname
      hostedPaths.push(path)

      return path.endsWith('/reservations')
        ? new Response(JSON.stringify({ reservation_id: reservationId, claim_id: claimId }), {
            status: 201,
            headers: { 'content-type': 'application/json' }
          })
        : new Response(JSON.stringify(completion('stop', 'ok')), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
    }
  })

  proxies.push(proxy)
  await proxy.start()
  const environment = proxy.backendEnvironment()

  const response = await fetch(`${environment.ATUM_MANAGED_MODEL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${environment.ATUM_MANAGED_MODEL_PROXY_TOKEN}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'binh-minh',
      messages: [{ role: 'user', content: 'hello' }],
      response_format: null
    })
  })

  assert.equal(response.status, 200)
  assert.deepEqual(hostedPaths, [
    '/api/managed-model/reservations',
    '/api/managed-model/chat/completions'
  ])
})

test('output requests over the advertised cap fail before reservation', async () => {
  let hostedCalls = 0

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async () => {
      hostedCalls += 1

      return new Response(null, { status: 500 })
    }
  })

  proxies.push(proxy)
  await proxy.start()
  const environment = proxy.backendEnvironment()

  const response = await fetch(`${environment.ATUM_MANAGED_MODEL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${environment.ATUM_MANAGED_MODEL_PROXY_TOKEN}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'binh-minh',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: MANAGED_MAX_OUTPUT_TOKENS + 1
    })
  })

  assert.equal(response.status, 400)
  assert.equal(hostedCalls, 0)
})

test('a slid reservation expiry from the platform keeps a long tool turn on one reservation', async () => {
  const hostedRequests: string[] = []
  let completionIndex = 0

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async input => {
      const url = new URL(String(input))
      hostedRequests.push(url.pathname)

      if (url.pathname.endsWith('/reservations')) {
        // The platform's initial lifetime has already lapsed by the time the
        // first call returns; only the per-call slide keeps the turn alive.
        return new Response(
          JSON.stringify({
            reservation_id: reservationId,
            claim_id: claimId,
            expires_at: new Date(Date.now() - 1_000).toISOString()
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        )
      }

      completionIndex += 1

      const value =
        completionIndex === 1
          ? completion('tool_calls', null, [
              { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }
            ])
          : completion('stop', 'done')

      return new Response(JSON.stringify(value), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-atum-reservation-expires-at': new Date(Date.now() + 300_000).toISOString()
        }
      })
    }
  })

  proxies.push(proxy)
  await proxy.start()
  const environment = proxy.backendEnvironment()
  const endpoint = `${environment.ATUM_MANAGED_MODEL_BASE_URL}/chat/completions`

  const headers = {
    authorization: `Bearer ${environment.ATUM_MANAGED_MODEL_PROXY_TOKEN}`,
    'content-type': 'application/json'
  }

  const first = [{ role: 'user', content: 'read it' }]

  const second = [
    ...first,
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }]
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'Atum' }
  ]

  const one = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ model: 'binh-minh', messages: first }) })
  assert.equal(one.status, 200)
  const two = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ model: 'binh-minh', messages: second }) })
  assert.equal(two.status, 200)

  assert.deepEqual(hostedRequests, [
    '/api/managed-model/reservations',
    '/api/managed-model/chat/completions',
    '/api/managed-model/chat/completions'
  ])
})

test('usage history is parsed read-only and fails closed', async () => {
  const turn = {
    reservation_id: '00000000-0000-4000-8000-760ea72ca9df',
    access_alias: 'binh-minh',
    display_name: 'Bình Minh',
    status: 'settled',
    actual_microcredits: 1176,
    quoted_microcredits: 6774,
    provider_calls: 7,
    prompt_tokens: 7000,
    cache_hit_tokens: 0,
    completion_tokens: 700,
    started_at: '2026-09-02T12:58:00+00:00',
    settled_at: '2026-09-02T13:00:00+00:00'
  }

  const paths: string[] = []

  const healthy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async input => {
      paths.push(new URL(String(input)).pathname + new URL(String(input)).search)

      return new Response(JSON.stringify({ turns: [turn] }), { status: 200 })
    }
  })

  assert.deepEqual(await healthy.usageHistory(500), { state: 'resolved', turns: [turn] })
  assert.deepEqual(paths, ['/api/managed-model/usage?limit=50'])

  const malformed = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async () => new Response(JSON.stringify({ turns: [{ ...turn, status: 'internal' }] }), { status: 200 })
  })

  assert.deepEqual(await malformed.usageHistory(), { state: 'unavailable' })

  const expired = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async () => new Response(JSON.stringify({ error: 'authentication_expired' }), { status: 401 })
  })

  assert.deepEqual(await expired.usageHistory(), { state: 'authentication_expired' })
})

test('thinking controls reach the hosted edge only in the shape it advertises', async () => {
  const bodies: Array<Record<string, unknown>> = []

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input))

      if (url.pathname.endsWith('/reservations')) {
        return new Response(JSON.stringify({ reservation_id: reservationId, claim_id: claimId }), {
          status: 201,
          headers: { 'content-type': 'application/json' }
        })
      }

      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)

      return new Response(JSON.stringify(completion('stop', 'ok')), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  })

  proxies.push(proxy)
  await proxy.start()
  const environment = proxy.backendEnvironment()
  const endpoint = `${environment.ATUM_MANAGED_MODEL_BASE_URL}/chat/completions`

  const headers = {
    authorization: `Bearer ${environment.ATUM_MANAGED_MODEL_PROXY_TOKEN}`,
    'content-type': 'application/json'
  }

  const send = (extra: Record<string, unknown>) =>
    fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'binh-minh', messages: [{ role: 'user', content: 'hi' }], ...extra })
    })

  assert.equal((await send({ reasoning_effort: 'max', thinking: { type: 'enabled' } })).status, 200)
  assert.equal(bodies[0]!.reasoning_effort, 'max')
  assert.deepEqual(bodies[0]!.thinking, { type: 'enabled' })

  assert.equal((await send({ thinking: { type: 'disabled' } })).status, 200)
  assert.deepEqual(bodies[1]!.thinking, { type: 'disabled' })
  assert.equal('reasoning_effort' in bodies[1]!, false)

  // A depth the edge would reject is dropped here rather than dispatched: the
  // turn proceeds at the provider default instead of failing with a 400.
  assert.equal((await send({ reasoning_effort: 'medium' })).status, 200)
  assert.equal('reasoning_effort' in bodies[2]!, false)

  assert.equal((await send({ thinking: { type: 'enabled', budget: 512 } })).status, 200)
  assert.equal('thinking' in bodies[3]!, false)

  assert.equal((await send({ thinking: 'enabled' })).status, 200)
  assert.equal('thinking' in bodies[4]!, false)
})

test('shared jobs pin one alias, ledger their reservation, and never share a private turn', async () => {
  const hosted: Array<{ path: string, body: Record<string, unknown>, headers: Headers }> = []
  const recorded: string[] = []
  let sharedCompletions = 0
  let deviceCredential = 'device-1'

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      hosted.push({ path, body, headers: new Headers(init?.headers) })

      if (path.endsWith('/reservations')) {
        return new Response(JSON.stringify({ reservation_id: `${reservationId}-${hosted.length}`, claim_id: claimId }), {
          status: 201,
          headers: { 'content-type': 'application/json' }
        })
      }

      if (body.messages && sharedCompletions++ === 0) {
        return new Response(JSON.stringify(completion('tool_calls', null, [{
          id: 'forged',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"private.txt"}' }
        }])), { status: 200, headers: { 'content-type': 'application/json' } })
      }

      return new Response(JSON.stringify(completion('stop', 'done')), { status: 200, headers: { 'content-type': 'application/json' } })
    }
  })

  proxies.push(proxy)
  await proxy.start()

  const shared = proxy.issueSharedJobToken({
    jobId: 'job-1',
    leaseToken: 'lease-1',
    alias: 'nguyet-thuc',
    accountId: 'owner',
    baseUrl: 'https://atum.test',
    deviceCredential: () => deviceCredential,
    onReservation: async id => { recorded.push(id) }
  })

  const master = proxy.backendEnvironment()
  const endpoint = `${shared.baseUrl}/chat/completions`
  const sharedHeaders = { authorization: `Bearer ${shared.token}`, 'content-type': 'application/json' }
  const masterHeaders = { authorization: `Bearer ${master.ATUM_MANAGED_MODEL_PROXY_TOKEN}`, 'content-type': 'application/json' }

  const models = await fetch(`${shared.baseUrl}/models`, { headers: { authorization: `Bearer ${shared.token}` } })
  assert.deepEqual((await models.json() as { data: Array<{ id: string }> }).data.map(row => row.id), ['nguyet-thuc'])

  const rejectedAlias = await fetch(endpoint, {
    method: 'POST', headers: sharedHeaders,
    body: JSON.stringify({ model: 'binh-minh', messages: [], tools: [] })
  })

  assert.equal(rejectedAlias.status, 400)

  const rejectedTools = await fetch(endpoint, {
    method: 'POST', headers: sharedHeaders,
    body: JSON.stringify({
      model: 'nguyet-thuc',
      messages: [],
      tools: [{ type: 'function', function: { name: 'read_file' } }]
    })
  })

  assert.equal(rejectedTools.status, 400)

  const rejectedPrivateExtra = await fetch(endpoint, {
    method: 'POST', headers: sharedHeaders,
    body: JSON.stringify({ model: 'nguyet-thuc', messages: [], metadata: { private: true } })
  })

  assert.equal(rejectedPrivateExtra.status, 400)

  // A heartbeat rotated the credential after this child token was issued.
  deviceCredential = 'device-rotated'
  const firstMessages = [{ role: 'user', content: 'discuss this' }]

  const first = await fetch(endpoint, {
    method: 'POST', headers: sharedHeaders,
    body: JSON.stringify({ model: 'nguyet-thuc', messages: firstMessages })
  })

  assert.equal(first.status, 200)

  const privateTurn = await fetch(endpoint, {
    method: 'POST', headers: masterHeaders,
    body: JSON.stringify({ model: 'binh-minh', messages: [{ role: 'user', content: 'private' }] })
  })

  assert.equal(privateTurn.status, 200)

  const continuation = await fetch(endpoint, {
    method: 'POST', headers: sharedHeaders,
    body: JSON.stringify({
      model: 'nguyet-thuc',
      messages: [
        ...firstMessages,
        { role: 'assistant', content: null, tool_calls: [{ id: 'forged', type: 'function', function: { name: 'read_file', arguments: '{"path":"private.txt"}' } }] },
        { role: 'tool', tool_call_id: 'forged', content: 'Tool read_file does not exist. Available tools:' }
      ]
    })
  })

  assert.equal(continuation.status, 200)
  assert.deepEqual(recorded, [`${reservationId}-1`])
  assert.deepEqual(hosted.filter(request => request.path.endsWith('/reservations')).map(request => {
    const { request_id: requestId, ...body } = request.body
    assert.equal(typeof requestId, 'string')

    return body
  }), [
    { model: 'nguyet-thuc', shared_job_id: 'job-1', lease_token: 'lease-1' },
    { model: 'binh-minh' }
  ])
  assert.equal(hosted[0]!.headers.get('x-atum-device-credential'), 'device-rotated')
  assert.equal(hosted.filter(request => request.path.endsWith('/chat/completions')).length, 3)
})

test('shared reservation recording failures and ambiguous completion failures block further dispatch', async () => {
  let providerCalls = 0

  const callbackProxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async input => {
      providerCalls += 1

      return new Response(JSON.stringify({ reservation_id: reservationId, claim_id: claimId }), { status: 201 })
    }
  })

  proxies.push(callbackProxy)
  await callbackProxy.start()

  const callbackToken = callbackProxy.issueSharedJobToken({
    jobId: 'job-callback', leaseToken: 'lease', alias: 'binh-minh', accountId: 'owner', baseUrl: 'https://atum.test',
    deviceCredential: () => 'device', onReservation: async () => { throw new Error('ledger failed') }
  })

  const callbackEndpoint = `${callbackToken.baseUrl}/chat/completions`
  const callbackHeaders = { authorization: `Bearer ${callbackToken.token}`, 'content-type': 'application/json' }

  const callbackResponse = await fetch(callbackEndpoint, {
    method: 'POST', headers: callbackHeaders, body: JSON.stringify({ model: 'binh-minh', messages: [] })
  })

  assert.equal(callbackResponse.status, 503)
  assert.equal(providerCalls, 1)
  assert.equal((await fetch(callbackEndpoint, {
    method: 'POST', headers: callbackHeaders, body: JSON.stringify({ model: 'binh-minh', messages: [] })
  })).status, 401)

  let completionCalls = 0

  const lostProxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async input => {
      if (new URL(String(input)).pathname.endsWith('/reservations')) {
        return new Response(JSON.stringify({ reservation_id: reservationId, claim_id: claimId }), { status: 201 })
      }

      completionCalls += 1
      throw new Error('lost response')
    }
  })

  proxies.push(lostProxy)
  await lostProxy.start()

  const lost = lostProxy.issueSharedJobToken({
    jobId: 'job-lost', leaseToken: 'lease', alias: 'binh-minh', accountId: 'owner', baseUrl: 'https://atum.test', deviceCredential: () => 'device'
  })

  const lostEndpoint = `${lost.baseUrl}/chat/completions`
  const lostHeaders = { authorization: `Bearer ${lost.token}`, 'content-type': 'application/json' }
  assert.equal((await fetch(lostEndpoint, {
    method: 'POST', headers: lostHeaders, body: JSON.stringify({ model: 'binh-minh', messages: [] })
  })).status, 409)
  assert.equal((await fetch(lostEndpoint, {
    method: 'POST', headers: lostHeaders, body: JSON.stringify({ model: 'binh-minh', messages: [] })
  })).status, 409)
  assert.equal(completionCalls, 3)
})

test('a shared job permits at most three continuation calls on its one reservation', async () => {
  let reservations = 0
  let completions = 0

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async input => {
      if (new URL(String(input)).pathname.endsWith('/reservations')) {
        reservations += 1

        return new Response(JSON.stringify({ reservation_id: reservationId, claim_id: claimId }), { status: 201 })
      }

      completions += 1

      return new Response(JSON.stringify(completion('tool_calls', null, [{
        id: `call-${completions}`,
        type: 'function',
        function: { name: 'read_file', arguments: '{}' }
      }])), { status: 200 })
    }
  })

  proxies.push(proxy)
  await proxy.start()

  const shared = proxy.issueSharedJobToken({
    jobId: 'job-cap', leaseToken: 'lease', alias: 'binh-minh', accountId: 'owner', baseUrl: 'https://atum.test', deviceCredential: () => 'device'
  })

  const endpoint = `${shared.baseUrl}/chat/completions`
  const headers = { authorization: `Bearer ${shared.token}`, 'content-type': 'application/json' }
  const messages: Array<Record<string, unknown>> = []

  for (let index = 1; index <= 3; index += 1) {
    const response = await fetch(endpoint, {
      method: 'POST', headers, body: JSON.stringify({ model: 'binh-minh', messages })
    })

    assert.equal(response.status, 200)
    messages.push(
      { role: 'assistant', content: null, tool_calls: [{ id: `call-${index}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: `call-${index}`, content: 'Tool read_file does not exist. Available tools:' }
    )
  }

  const capped = await fetch(endpoint, {
    method: 'POST', headers, body: JSON.stringify({ model: 'binh-minh', messages })
  })

  assert.equal(capped.status, 429)
  assert.equal(reservations, 1)
  assert.equal(completions, 3)
})

test('shared tokens refuse an account switch during reservation or completion and expire after a terminal reply', async () => {
  let current = session()
  let resolveReservation!: (value: Response) => void
  let resolveCompletion!: (value: Response) => void
  let phase: 'reserve_hold' | 'completion_hold' | 'normal' = 'reserve_hold'

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => current, refresh: async () => null },
    fetchImpl: async input => {
      if (new URL(String(input)).pathname.endsWith('/reservations')) {
        if (phase === 'reserve_hold') {
          return await new Promise<Response>(resolve => { resolveReservation = resolve })
        }

        return new Response(JSON.stringify({ reservation_id: reservationId, claim_id: claimId }), { status: 201 })
      }

      if (phase === 'completion_hold') {
        return await new Promise<Response>(resolve => { resolveCompletion = resolve })
      }

      return new Response(JSON.stringify(completion('stop', 'done')), { status: 200 })
    }
  })

  proxies.push(proxy)
  await proxy.start()

  const reserveToken = proxy.issueSharedJobToken({
    jobId: 'job-reserve-switch', leaseToken: 'lease', alias: 'binh-minh', accountId: 'owner', baseUrl: 'https://atum.test', deviceCredential: () => 'device'
  })

  const headers = { authorization: `Bearer ${reserveToken.token}`, 'content-type': 'application/json' }

  const pendingReserve = fetch(`${reserveToken.baseUrl}/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify({ model: 'binh-minh', messages: [] })
  })

  await vi.waitFor(() => assert.ok(resolveReservation))
  current = { ...session(), baseUrl: 'https://other.test', user: { id: 'other', displayName: 'Other', handle: 'other' } }
  resolveReservation(new Response(JSON.stringify({ reservation_id: reservationId, claim_id: claimId }), { status: 201 }))
  assert.equal((await pendingReserve).status, 401)

  current = session()
  phase = 'completion_hold'
  resolveReservation = undefined!
  resolveCompletion = undefined!

  const completionToken = proxy.issueSharedJobToken({
    jobId: 'job-completion-switch', leaseToken: 'lease', alias: 'binh-minh', accountId: 'owner', baseUrl: 'https://atum.test', deviceCredential: () => 'device'
  })

  const completionHeaders = { authorization: `Bearer ${completionToken.token}`, 'content-type': 'application/json' }

  const pendingCompletion = fetch(`${completionToken.baseUrl}/chat/completions`, {
    method: 'POST', headers: completionHeaders, body: JSON.stringify({ model: 'binh-minh', messages: [] })
  })

  await vi.waitFor(() => assert.ok(resolveCompletion))
  current = { ...session(), baseUrl: 'https://other.test', user: { id: 'other', displayName: 'Other', handle: 'other' } }
  resolveCompletion(new Response(JSON.stringify(completion('stop', 'must not leak')), { status: 200 }))
  assert.equal((await pendingCompletion).status, 401)

  current = session()
  phase = 'normal'

  const terminal = proxy.issueSharedJobToken({
    jobId: 'job-terminal', leaseToken: 'lease', alias: 'binh-minh', accountId: 'owner', baseUrl: 'https://atum.test', deviceCredential: () => 'device'
  })

  const terminalHeaders = { authorization: `Bearer ${terminal.token}`, 'content-type': 'application/json' }

  const terminalResponse = await fetch(`${terminal.baseUrl}/chat/completions`, {
    method: 'POST', headers: terminalHeaders, body: JSON.stringify({ model: 'binh-minh', messages: [] })
  })

  assert.equal(terminalResponse.status, 200)
  assert.equal((await fetch(`${terminal.baseUrl}/chat/completions`, {
    method: 'POST', headers: terminalHeaders, body: JSON.stringify({ model: 'binh-minh', messages: [] })
  })).status, 401)

  const revoked = proxy.issueSharedJobToken({
    jobId: 'job-revoked', leaseToken: 'lease', alias: 'binh-minh', accountId: 'owner', baseUrl: 'https://atum.test', deviceCredential: () => 'device'
  })

  revoked.revoke()
  assert.equal((await fetch(`${revoked.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${revoked.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'binh-minh', messages: [] })
  })).status, 401)

  await proxy.stop()
  assert.throws(() => proxy.issueSharedJobToken({
    jobId: 'job-stopped', leaseToken: 'lease', alias: 'binh-minh', accountId: 'owner', baseUrl: 'https://atum.test', deviceCredential: () => 'device'
  }), /invalid_shared_managed_job/u)
})

test('a Mac daily-cap completion refusal reaches Hermes as the closed provider code', async () => {
  const details = {
    reason: 'daily_cap_exhausted',
    cap: { dailyProtons: 200_000, timeZone: 'Asia/Ho_Chi_Minh', warningPercent: 80, counts: 'atum_billed_only' },
    spend: { day: '2026-10-21', usedProtons: 200_123 }
  }

  let completions = 0

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async input => {
      const path = new URL(String(input)).pathname

      if (path.endsWith('/reservations')) {
        return new Response(JSON.stringify({ reservation_id: reservationId, claim_id: claimId }), { status: 201 })
      }

      completions += 1

      return new Response(JSON.stringify({ error: 'daily_cap_exhausted', retryable: false, details }), {
        status: 403,
        headers: { 'content-type': 'application/json' }
      })
    }
  })

  proxies.push(proxy)
  await proxy.start()
  const environment = proxy.backendEnvironment()

  const response = await fetch(`${environment.ATUM_MANAGED_MODEL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${environment.ATUM_MANAGED_MODEL_PROXY_TOKEN}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model: 'binh-minh', messages: [{ role: 'user', content: 'hello' }] })
  })

  assert.equal(response.status, 403)
  assert.equal(completions, 1)
  assert.deepEqual(await response.json(), {
    error: {
      message: 'atum_daily_cap_exhausted',
      type: 'atum_managed_model_error',
      code: 'atum_daily_cap_exhausted',
      details
    }
  })
})

test('a daily-cap reservation refusal is the same closed code before any completion', async () => {
  let completions = 0

  const proxy = new AtumManagedModelProxy({
    tokens: { current: () => session(), refresh: async () => null },
    fetchImpl: async input => {
      const path = new URL(String(input)).pathname

      if (path.endsWith('/reservations')) {
        return new Response(JSON.stringify({
          error: 'daily_cap_exhausted',
          retryable: false,
          details: { reason: 'daily_cap_exhausted' }
        }), { status: 403 })
      }

      completions += 1

      return new Response(null, { status: 200 })
    }
  })

  proxies.push(proxy)
  await proxy.start()
  const environment = proxy.backendEnvironment()

  const response = await fetch(`${environment.ATUM_MANAGED_MODEL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${environment.ATUM_MANAGED_MODEL_PROXY_TOKEN}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model: 'binh-minh', messages: [{ role: 'user', content: 'hello' }] })
  })

  assert.equal(response.status, 403)
  assert.equal(completions, 0)
  assert.deepEqual(await response.json(), {
    error: {
      message: 'atum_daily_cap_exhausted',
      type: 'atum_managed_model_error',
      code: 'atum_daily_cap_exhausted',
      details: { reason: 'daily_cap_exhausted' }
    }
  })
})
