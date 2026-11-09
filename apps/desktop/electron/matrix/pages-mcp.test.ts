import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixMcpResult } from '../../shared/matrix-mcp-settings'
import type { MatrixPagesRequest } from '../../shared/matrix-pages'

import { createHermesPagesTransport } from './hermes-pages-transport'
import { isMatrixMcpRequest, MatrixPagesMcpScope, type MatrixPagesMcpScopeDeps } from './pages-mcp'

const server = {
  name: 'demo',
  transport: 'http',
  auth: 'oauth',
  enabled: true,
  url: 'https://private.example/token',
  command: 'private-command',
  args: ['private-argument'],
  env: { PRIVATE_KEY: 'private-key' }
}

const catalog = {
  entries: [
    {
      name: 'catalog-demo',
      description: 'Catalog example',
      transport: 'stdio',
      auth_type: 'api_key',
      installed: false,
      enabled: false,
      needs_install: false,
      command: 'private-command',
      args: ['private-argument'],
      bootstrap: ['private-bootstrap'],
      required_env: [{ name: 'DEMO_KEY', prompt: 'New key', required: true, value: 'private-value' }]
    }
  ]
}

const get = (path = '/api/mcp/snapshot'): MatrixPagesRequest => ({ path, method: 'GET' })

const post = (path: string, body?: unknown): MatrixPagesRequest => ({
  path,
  method: 'POST',
  ...(body === undefined ? {} : { body })
})

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(next => {
    resolve = next
  })

  return { promise, resolve }
}

function setup(overrides: Partial<MatrixPagesMcpScopeDeps> = {}) {
  const deps: MatrixPagesMcpScopeDeps = {
    isCurrent: () => true,
    confirm: vi.fn().mockResolvedValue(true),
    openExternal: vi.fn(),
    reload: vi.fn().mockResolvedValue({ status: 'reloaded', loaded_rev: 'private-revision' }),
    forward: vi.fn(async request => {
      if (request.path === '/api/mcp/servers?profile=default' && request.method === 'GET') {
        return { servers: [server] }
      }

      if (request.path === '/api/mcp/catalog?profile=default') {
        return catalog
      }

      if (request.path === '/api/mcp/servers?profile=default' && request.method === 'POST') {
        return { ...server, name: (request.body as { name: string }).name }
      }

      if (request.path.endsWith('/test?profile=default')) {
        return { ok: true, tools: [{ name: 'tool', description: 'private-description' }], prompts: 2, resources: 3 }
      }

      if (request.path.endsWith('/enabled?profile=default')) {
        return { ok: true, name: 'demo', enabled: (request.body as { enabled: boolean }).enabled }
      }

      return { ok: true }
    }),
    ...overrides
  }

  return { scope: new MatrixPagesMcpScope(deps), deps }
}

afterEach(() => vi.unstubAllGlobals())

describe('selected-agent native MCP authority', () => {
  it('reserves the full MCP prefix and rejects arbitrary upstream/profile/config routes', async () => {
    const { scope, deps } = setup()
    expect(isMatrixMcpRequest('/api/mcp/servers?profile=foreign')).toBe(true)
    expect(isMatrixMcpRequest('/api/config')).toBe(false)

    for (const request of [
      get('/api/mcp/servers'),
      get('/api/mcp/snapshot?profile=foreign'),
      post('/api/mcp/add', { name: 'other', profile: 'foreign' }),
      { ...get(), profile: 'foreign' },
      post('/api/mcp/reload', { confirm: true, session_id: 'foreign' })
    ]) {
      await expect(scope.request(request)).rejects.toThrow()
    }

    expect(deps.forward).not.toHaveBeenCalled()
    expect(deps.reload).not.toHaveBeenCalled()
  })

  it('projects only bounded names, transport/auth state and catalog provisioning prompts', async () => {
    const { scope, deps } = setup()
    const snapshot = await scope.request(get())
    expect(snapshot).toEqual({
      servers: [{ name: 'demo', transport: 'http', auth: 'oauth', enabled: true }],
      catalog: [
        {
          name: 'catalog-demo',
          description: 'Catalog example',
          transport: 'stdio',
          auth: 'api_key',
          installed: false,
          enabled: false,
          needsInstall: false,
          requiredEnv: [{ name: 'DEMO_KEY', prompt: 'New key', required: true }]
        }
      ]
    })
    expect(JSON.stringify(snapshot)).not.toContain('private-')
    expect(deps.confirm).not.toHaveBeenCalled()
    expect(deps.reload).not.toHaveBeenCalled()
    expect(deps.forward).toHaveBeenCalledTimes(2)
  })

  it('confirms provisioning and forwards only exact inputs without echoing them', async () => {
    const { scope, deps } = setup()

    const result = await scope.request(
      post('/api/mcp/add', {
        name: 'new-server',
        transport: 'stdio',
        command: 'example-command',
        args: ['--demo'],
        env: { DEMO_KEY: 'new-secret' }
      })
    )

    expect(deps.confirm).toHaveBeenCalledWith({
      kind: 'mcp-add',
      name: 'new-server',
      transport: 'stdio',
      target: 'example-command'
    })
    expect(deps.forward).toHaveBeenLastCalledWith({
      path: '/api/mcp/servers?profile=default',
      method: 'POST',
      body: { name: 'new-server', command: 'example-command', args: ['--demo'], env: { DEMO_KEY: 'new-secret' } }
    })
    expect(result).toEqual({ status: 'applied' })
    expect(deps.reload).not.toHaveBeenCalled()
  })

  it('accepts one-time bearer provisioning but not URLs with embedded credentials or profile fields', async () => {
    const { scope, deps } = setup()
    await expect(
      scope.request(
        post('/api/mcp/add', {
          name: 'new-server',
          transport: 'http',
          url: 'https://mcp.example/?workspace=example&token=synthetic-query',
          auth: 'header',
          bearerToken: 'new-secret'
        })
      )
    ).resolves.toEqual({ status: 'applied' })
    expect(deps.forward).toHaveBeenLastCalledWith({
      path: '/api/mcp/servers?profile=default',
      method: 'POST',
      body: {
        name: 'new-server',
        url: 'https://mcp.example/?workspace=example&token=synthetic-query',
        auth: 'header',
        bearer_token: 'new-secret'
      }
    })
    expect(deps.confirm).toHaveBeenCalledWith({
      kind: 'mcp-add',
      name: 'new-server',
      transport: 'http',
      target: 'https://mcp.example/'
    })

    for (const body of [
      { name: 'other', transport: 'http', url: 'https://user:password@mcp.example/', auth: 'none' },
      { name: 'other', transport: 'http', url: 'file:///private', auth: 'none' },
      { name: 'other', transport: 'stdio', command: 'command', args: [], env: {}, profile: 'foreign' }
    ]) {
      await expect(scope.request(post('/api/mcp/add', body))).rejects.toThrow('matrix_mcp_request_failed')
    }
  })

  it('does not execute test/remove/toggle/reload when native confirmation is denied', async () => {
    const { scope, deps } = setup({ confirm: vi.fn().mockResolvedValue(false) })

    for (const request of [
      post('/api/mcp/test', { name: 'demo' }),
      post('/api/mcp/remove', { name: 'demo' }),
      post('/api/mcp/enabled', { name: 'demo', enabled: false }),
      post('/api/mcp/reload')
    ]) {
      expect(await scope.request(request)).toEqual({ status: 'cancelled' })
    }

    expect((deps.forward as ReturnType<typeof vi.fn>).mock.calls.every(([request]) => request.method === 'GET')).toBe(
      true
    )
    expect(deps.reload).not.toHaveBeenCalled()
  })

  it('reports a concurrent mutation as busy without starting another action', async () => {
    const approval = deferred<boolean>()
    const { scope, deps } = setup({ confirm: () => approval.promise })
    const action = scope.request(post('/api/mcp/reload'))
    await expect(scope.request(post('/api/mcp/reload'))).rejects.toThrow('pages_agent_busy')
    expect(deps.reload).not.toHaveBeenCalled()
    approval.resolve(false)
    await expect(action).resolves.toEqual({ status: 'cancelled' })
    expect(deps.reload).not.toHaveBeenCalled()
  })

  it('fences pending approval and late responses when the view/account/agent retires', async () => {
    let current = true
    const approval = deferred<boolean>()
    const { scope, deps } = setup({ isCurrent: () => current, confirm: () => approval.promise })
    const action = scope.request(post('/api/mcp/test', { name: 'demo' }))
    await vi.waitFor(() => expect(deps.forward).toHaveBeenCalled())
    current = false
    approval.resolve(true)
    await expect(action).rejects.toThrow('matrix_mcp_request_failed')
    expect(deps.forward).toHaveBeenCalledTimes(1)

    const response = deferred<unknown>()
    const other = setup({ forward: () => response.promise })
    const snapshot = other.scope.request(get())
    other.scope.stop()
    response.resolve({ servers: [], entries: [] })
    await expect(snapshot).rejects.toThrow('matrix_mcp_request_failed')
  })

  it('returns capability counts and drops tool descriptions/errors entirely', async () => {
    const { scope, deps } = setup()
    expect(await scope.request(post('/api/mcp/test', { name: 'demo' }))).toEqual({
      status: 'tested',
      ok: true,
      toolCount: 1,
      prompts: 2,
      resources: 3
    })
    expect(deps.confirm).toHaveBeenCalledWith({ kind: 'mcp-test', name: 'demo' })

    const failure = setup({
      forward: vi.fn(async request =>
        request.method === 'GET'
          ? { servers: [server] }
          : { ok: false, error: 'private-token=value https://private', tools: [] }
      )
    })

    expect(await failure.scope.request(post('/api/mcp/test', { name: 'demo' }))).toEqual({
      status: 'tested',
      ok: false,
      toolCount: 0,
      prompts: 0,
      resources: 0
    })
  })

  it('preserves config mutations and makes reload a separate native-only RPC', async () => {
    const { scope, deps } = setup()
    await scope.request(post('/api/mcp/enabled', { name: 'demo', enabled: false }))
    await scope.request(post('/api/mcp/remove', { name: 'demo' }))
    expect(deps.reload).not.toHaveBeenCalled()
    expect(await scope.request(post('/api/mcp/reload'))).toEqual({ status: 'applied' })
    expect(deps.confirm).toHaveBeenLastCalledWith({ kind: 'mcp-reload' })
    expect(deps.reload).toHaveBeenCalledWith()
  })

  it('binds OAuth polling and one-time browser handoff to the retained server/flow', async () => {
    const flow = {
      server_name: 'demo',
      flow_id: 'native-flow',
      status: 'authorization_required',
      authorization_url: 'https://auth.example/authorize?state=one-time',
      error: 'private-error'
    }

    const { scope, deps } = setup({
      forward: vi.fn(async request =>
        request.method === 'GET' && request.path.startsWith('/api/mcp/servers?') ? { servers: [server] } : flow
      )
    })

    const start = (await scope.request(post('/api/mcp/auth', { name: 'demo' }))) as Extract<
      MatrixMcpResult,
      { status: 'operation' }
    >

    expect(start.state).toBe('authorization_required')
    expect(JSON.stringify(start)).not.toMatch(/native-flow|auth\.example|one-time|private-error/)
    expect(deps.openExternal).toHaveBeenCalledOnce()
    await scope.request(post('/api/mcp/auth/status', { operationId: start.operationId }))
    expect(deps.forward).toHaveBeenLastCalledWith({
      path: '/api/mcp/oauth/flows/native-flow?profile=default',
      method: 'GET'
    })
    expect(deps.openExternal).toHaveBeenCalledOnce()
    await expect(scope.request(post('/api/mcp/auth/status', { operationId: 'native-flow' }))).rejects.toThrow()
    const foreign = setup()
    await expect(
      foreign.scope.request(post('/api/mcp/auth/status', { operationId: start.operationId }))
    ).rejects.toThrow()
  })

  it('cancels OAuth continuation synchronously while a late status read is pending', async () => {
    const late = deferred<unknown>()

    const { scope, deps } = setup({
      forward: vi.fn(async request => {
        if (request.path.startsWith('/api/mcp/servers?')) {
          return { servers: [server] }
        }

        if (request.path.endsWith('/auth?profile=default')) {
          return { server_name: 'demo', flow_id: 'native-flow', status: 'starting' }
        }

        return late.promise
      })
    })

    const start = (await scope.request(post('/api/mcp/auth', { name: 'demo' }))) as Extract<
      MatrixMcpResult,
      { status: 'operation' }
    >

    const poll = scope.request(post('/api/mcp/auth/status', { operationId: start.operationId }))
    expect(await scope.request(post('/api/mcp/auth/cancel', { operationId: start.operationId }))).toEqual({
      ...start,
      state: 'cancelled'
    })
    late.resolve({
      server_name: 'demo',
      flow_id: 'native-flow',
      status: 'authorization_required',
      authorization_url: 'https://auth.example/?state=one-time'
    })
    expect(await poll).toEqual({ ...start, state: 'cancelled' })
    expect(deps.openExternal).not.toHaveBeenCalled()
  })

  it('rejects a mismatched OAuth server and non-HTTPS/credential-bearing browser handoff', async () => {
    for (const override of [
      { server_name: 'foreign' },
      { authorization_url: 'http://auth.example/?state=x' },
      { authorization_url: 'https://user:password@auth.example/?state=x' }
    ]) {
      const { scope, deps } = setup({
        forward: vi.fn(async request =>
          request.path.startsWith('/api/mcp/servers?')
            ? { servers: [server] }
            : {
                server_name: 'demo',
                flow_id: 'native-flow',
                status: 'authorization_required',
                authorization_url: 'https://auth.example/?state=x',
                ...override
              }
        )
      })

      await expect(scope.request(post('/api/mcp/auth', { name: 'demo' }))).rejects.toThrow('matrix_mcp_request_failed')
      expect(deps.openExternal).not.toHaveBeenCalled()
    }
  })

  it('restricts catalog credentials to declared keys and tracks a background action without logs', async () => {
    const { scope, deps } = setup({
      forward: vi.fn(async request => {
        if (request.path.startsWith('/api/mcp/catalog?')) {
          return { entries: [{ ...catalog.entries[0], needs_install: true }] }
        }

        if (request.path.startsWith('/api/mcp/catalog/install?')) {
          return { ok: true, name: 'catalog-demo', background: true, action: 'mcp-install-catalog-demo-123abc45' }
        }

        return {
          name: 'mcp-install-catalog-demo-123abc45',
          running: false,
          exit_code: 0,
          pid: 1,
          lines: ['private-secret-log']
        }
      })
    })

    await expect(
      scope.request(post('/api/mcp/install', { name: 'catalog-demo', env: { UNDECLARED: 'secret' } }))
    ).rejects.toThrow()
    await expect(scope.request(post('/api/mcp/install', { name: 'catalog-demo', env: {} }))).rejects.toThrow()

    const start = (await scope.request(
      post('/api/mcp/install', { name: 'catalog-demo', env: { DEMO_KEY: 'new-key' } })
    )) as Extract<MatrixMcpResult, { status: 'operation' }>

    expect(deps.confirm).toHaveBeenCalledWith({ kind: 'mcp-install', name: 'catalog-demo', needsInstall: true })
    const status = await scope.request(post('/api/mcp/install/status', { operationId: start.operationId }))
    expect(status).toEqual({ ...start, state: 'applied' })
    expect(JSON.stringify(status)).not.toContain('private')
    expect(deps.forward).toHaveBeenLastCalledWith({
      path: '/api/actions/mcp-install-catalog-demo-123abc45/status?lines=0&profile=default',
      method: 'GET'
    })
  })

  it('uses the real native transport to resolve only the selected home, never a renderer profile', async () => {
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer native-only')
        seen.push(url)

        if (url.endsWith('/api/profiles')) {
          return new Response(
            JSON.stringify({
              profiles: [
                { name: 'default', path: '/tmp/foreign' },
                { name: 'owned', path: '/tmp/owned' }
              ]
            })
          )
        }

        expect(new URL(url).searchParams.get('profile')).toBe('owned')

        return new Response(JSON.stringify(url.includes('/catalog?') ? catalog : { servers: [server] }))
      })
    )

    const { scope } = setup({
      forward: createHermesPagesTransport(41000, 'native-only', '/tmp/owned', new AbortController().signal)
    })

    const snapshot = await scope.request(get())
    expect(seen.filter(url => url.endsWith('/api/profiles'))).toHaveLength(1)
    expect(JSON.stringify(snapshot)).not.toMatch(/native-only|41000|foreign|owned|private-/)
  })
})
