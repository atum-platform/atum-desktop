import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ConnectionSurface, PlanAcknowledgment } from '../../shared/connection-catalog'

import { matrixSubscriptionPlanSignInGate, updateMatrixSubscriptionSignIn } from './account-subscription-flow'
import { createHermesPagesTransport } from './hermes-pages-transport'
import { isMatrixProvidersRequest, MatrixPagesProvidersScope, MatrixPagesSignInHolds } from './pages-providers'
import { MatrixSubscriptionAuthLifecycle } from './subscription-auth-lifecycle'

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(next => {
    resolve = next
  })

  return { promise, resolve }
}

function fixture(
  options: {
    surface?: ConnectionSurface
    acknowledgment?: PlanAcknowledgment | null
    today?: string
    authLifecycle?: MatrixSubscriptionAuthLifecycle
  } = {}
) {
  let current = true
  let today = options.today ?? '2026-10-27'

  let acknowledgment =
    options.acknowledgment === undefined
      ? { provider: 'openai-codex', policyVersion: '2026-10-27', acknowledgedAt: '2026-10-27' }
      : (options.acknowledgment ?? undefined)

  const readPlanAcknowledgment = vi.fn((provider: string) =>
    acknowledgment?.provider === provider ? acknowledgment : undefined
  )

  const savePlanAcknowledgment = vi.fn((value: PlanAcknowledgment) => {
    acknowledgment = value
  })

  const info: Record<string, unknown> = {
    provider: 'openrouter',
    model: 'model-old',
    api_key: 'secret-never-render',
    capabilities: { supports_reasoning: true }
  }

  const providers = [
    {
      slug: 'openrouter',
      name: 'OpenRouter',
      authenticated: true,
      is_current: true,
      models: ['model-old', 'model-new'],
      base_url: 'http://backend-private'
    },
    { slug: 'anthropic', name: 'Anthropic', authenticated: true, is_current: false, models: ['claude-next'] },
    { slug: 'opencode-go', name: 'OpenCode Go', authenticated: false, is_current: false, models: ['kimi-k3'] },
    { slug: 'nous', name: 'Nous', authenticated: true, is_current: false, models: ['nous-model'] }
  ]

  const oauth = [
    {
      id: 'anthropic',
      name: 'Anthropic',
      flow: 'pkce',
      disconnectable: true,
      status: { logged_in: true, token_preview: 'secret-token-preview', source_label: '/private/home/auth' }
    },
    { id: 'openai-codex', name: 'Codex', flow: 'device_code', disconnectable: true, status: { logged_in: false } },
    { id: 'qwen-oauth', name: 'Qwen', flow: 'external', disconnectable: false, status: { logged_in: true } },
    { id: 'xai-oauth', name: 'xAI', flow: 'device_code', disconnectable: true, status: { logged_in: false } },
    { id: 'minimax-oauth', name: 'MiniMax', flow: 'device_code', disconnectable: true, status: { logged_in: false } },
    { id: 'copilot-acp', name: 'Copilot', flow: 'external', disconnectable: false, status: { logged_in: false } },
    { id: 'nous', name: 'Nous', flow: 'device_code', disconnectable: true, status: { logged_in: true } }
  ]

  const endpoints: Array<Record<string, unknown>> = []

  const env = {
    OPENROUTER_API_KEY: {
      category: 'provider',
      provider: 'openrouter',
      is_password: true,
      advanced: false,
      is_set: true,
      redacted_value: 'secret-env-preview'
    },
    OPENROUTER_BASE_URL: { category: 'provider', provider: 'openrouter', is_password: false, is_set: true },
    // Hermes lists Anthropic's subscription token first and marks every Anthropic key advanced.
    ANTHROPIC_TOKEN: { category: 'provider', provider: 'anthropic', is_password: true, advanced: true, is_set: false },
    ANTHROPIC_API_KEY: {
      category: 'provider',
      provider: 'anthropic',
      is_password: true,
      advanced: true,
      is_set: false
    },
    OPENCODE_GO_API_KEY: {
      category: 'provider',
      provider: 'opencode-go',
      is_password: true,
      advanced: true,
      is_set: false,
      redacted_value: 'secret-opencode-preview'
    },
    TOOL_API_KEY: { category: 'tool', provider: 'tool', is_password: true, is_set: true },
    CUSTOM_SECRET: { category: 'custom', is_password: true, is_set: true }
  }

  const forward = vi.fn(async (request: { path: string; method: string; body?: unknown }): Promise<unknown> => {
    const path = request.path.split('?')[0]

    if (path === '/api/model/options') {
      return { providers }
    }

    if (path === '/api/model/info') {
      return { ...info }
    }

    if (path === '/api/env' && request.method === 'GET') {
      return env
    }

    if (path === '/api/env') {
      return { ok: true, key: 'OPENROUTER_API_KEY', config_updates: ['private-home'] }
    }

    if (path === '/api/providers/oauth') {
      return { providers: oauth }
    }

    if (path === '/api/providers/custom-endpoints' && request.method === 'GET') {
      return { endpoints, current: info }
    }

    if (path === '/api/providers/custom-endpoints') {
      const body = request.body as Record<string, unknown>
      endpoints.push({
        id: body.id,
        name: body.name,
        models: [body.model],
        is_current: false,
        api_key_preview: 'secret-key-preview',
        base_url: body.base_url
      })

      return { ok: true, id: body.id, endpoints }
    }

    if (path === '/api/model/set') {
      const body = request.body as { provider: string; model: string }
      info.provider = body.provider
      info.model = body.model

      return {
        ok: true,
        scope: 'main',
        ...body,
        api_key: 'secret-upstream',
        stale_aux: [{ task: 'vision', base_url: 'private-host' }]
      }
    }

    if (path.endsWith('/start')) {
      return {
        session_id: 'upstream-session',
        flow: 'device_code',
        verification_url: 'https://auth.openai.com/codex/device',
        user_code: 'PRIVATE-CODE',
        expires_in: 900
      }
    }

    if (path.includes('/poll/')) {
      return { session_id: 'upstream-session', status: 'pending', error_message: 'private-token' }
    }

    if (path.endsWith('/submit')) {
      return { ok: true, status: 'approved', access_token: 'private-token' }
    }

    if (path.startsWith('/api/providers/oauth/sessions/')) {
      return { ok: true }
    }

    if (path === '/api/providers/oauth/anthropic' && request.method === 'DELETE') {
      return { ok: true, provider: 'anthropic' }
    }

    if (path === '/api/providers/oauth/openai-codex' && request.method === 'DELETE') {
      return { ok: true, provider: 'openai-codex' }
    }

    throw new Error(`secret-upstream-exception ${request.path}`)
  })

  const confirm = vi.fn().mockResolvedValue(true)
  const openExternal = vi.fn().mockResolvedValue(undefined)
  const cancelOAuth = vi.fn().mockResolvedValue(undefined)
  const selected = vi.fn().mockResolvedValue(undefined)
  const disconnected = vi.fn().mockResolvedValue(undefined)
  const signingIn = vi.fn<(active: boolean) => void>()
  const signedIn = vi.fn<(provider: string) => void>()

  const scope = new MatrixPagesProvidersScope({
    surface: options.surface ?? 'connections',
    readPlanAcknowledgment,
    savePlanAcknowledgment,
    today: () => today,
    forward,
    confirm,
    openExternal,
    cancelOAuth,
    selected,
    disconnected,
    signingIn,
    signedIn,
    isCurrent: () => current,
    authLifecycle: () => options.authLifecycle
  })

  return {
    scope,
    readPlanAcknowledgment,
    savePlanAcknowledgment,
    setAcknowledgment: (value: PlanAcknowledgment | undefined) => {
      acknowledgment = value
    },
    setToday: (value: string) => {
      today = value
    },
    forward,
    confirm,
    openExternal,
    cancelOAuth,
    selected,
    disconnected,
    signingIn,
    signedIn,
    info,
    providers,
    oauth,
    endpoints,
    retire: () => {
      current = false
    }
  }
}

const request = (path: string, body?: unknown, method = 'POST') => ({
  path: `/api/provider-settings/${path}`,
  method,
  ...(body === undefined ? {} : { body })
})

const catalogWrites = (f: ReturnType<typeof fixture>) => f.forward.mock.calls.filter(([call]) => call.method !== 'GET')

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('releases every concurrent sign-in hold on stop so the plan gate cannot remain pending', () => {
  const host = { signIns: 0 }
  const holds = new MatrixPagesSignInHolds(active => void updateMatrixSubscriptionSignIn(host, active))

  holds.begin()
  holds.begin()
  expect(matrixSubscriptionPlanSignInGate({ ...host, planSignIn: true })).toBe('pending')

  holds.stop()
  expect(host.signIns).toBe(0)
  expect(matrixSubscriptionPlanSignInGate({ ...host, planSignIn: true })).toBe('required')
})

describe('selected-agent provider authority', () => {
  it('projects actual catalogs without env names, key previews, token status, source paths or backend URLs', async () => {
    const f = fixture()

    const result = (await f.scope.request(request('snapshot', undefined, 'GET'))) as {
      current: Record<string, unknown>
      providers: Array<Record<string, unknown>>
    }

    expect(result.current).toMatchObject({ provider: 'openrouter', model: 'model-old', reasoning: true })
    expect(result.providers).toEqual(
      expect.arrayContaining([
        {
          id: 'openrouter',
          name: 'OpenRouter',
          ready: true,
          current: true,
          models: ['model-old', 'model-new'],
          keyAvailable: true,
          keySet: true,
          oauth: null,
          kind: 'key'
        },
        expect.objectContaining({
          id: 'nous',
          ready: false,
          oauth: { flow: 'device_code', connected: true, supported: false, disconnectable: false }
        })
      ])
    )
    expect(JSON.stringify(result)).not.toMatch(/secret|private|OPENROUTER_API_KEY|base_url|source_label|token_preview/)
    expect(
      f.forward.mock.calls.every(
        ([call]) => new URL(call.path, 'http://local').searchParams.get('profile') === 'default'
      )
    ).toBe(true)
  })

  it.each([
    request('key', { provider: 'openrouter', value: 'key', profile: 'other' }, 'PUT'),
    request('select', { provider: 'nous', model: 'nous-model' }),
    request('select', { provider: 'openrouter', model: 'not-listed' }),
    request('key', { provider: 'tool', value: 'key' }, 'PUT'),
    request('key', { provider: 'openrouter', value: 'line\nbreak' }, 'PUT'),
    request('oauth/start', { provider: 'qwen-oauth' }),
    request('oauth/poll', { session: 'upstream-session' }),
    request('oauth/start?profile=other', { provider: 'openai-codex' }),
    request('snapshot', {}, 'GET')
  ])('rejects renderer routing, unsupported providers and unbound sessions: %j', async value => {
    const f = fixture()
    await expect(f.scope.request(value)).rejects.toThrow(/forbidden|not_ready|provider_terms_blocked/)
    expect(f.confirm).not.toHaveBeenCalled()
    expect(catalogWrites(f)).toHaveLength(0)
  })

  it('confirms credential writes using only native catalog membership', async () => {
    const f = fixture()
    await expect(
      f.scope.request(request('key', { provider: 'openrouter', value: 'synthetic-key' }, 'PUT'))
    ).resolves.toEqual({ status: 'applied' })
    expect(f.confirm).toHaveBeenCalledWith({ kind: 'provider-key', provider: 'openrouter' })
    expect(catalogWrites(f)).toEqual([
      [{ path: '/api/env?profile=default', method: 'PUT', body: { key: 'OPENROUTER_API_KEY', value: 'synthetic-key' } }]
    ])
  })

  it('cancels declined writes and fences pending approvals on retirement', async () => {
    const f = fixture()
    f.confirm.mockResolvedValueOnce(false)
    await expect(f.scope.request(request('select', { provider: 'anthropic', model: 'claude-next' }))).resolves.toEqual({
      status: 'cancelled'
    })
    const approval = deferred<boolean>()
    f.confirm.mockReturnValueOnce(approval.promise)
    const pending = f.scope.request(request('select', { provider: 'anthropic', model: 'claude-next' }))
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledTimes(2))
    f.retire()
    approval.resolve(true)
    await expect(pending).rejects.toThrow('matrix_pages_agent_unavailable')
    expect(catalogWrites(f)).toHaveLength(0)
  })

  it('selects another provider only from fresh catalog and reconciles routing after readback', async () => {
    const f = fixture()
    const result = await f.scope.request(request('select', { provider: 'anthropic', model: 'claude-next' }))
    expect(result).toEqual({ status: 'applied', staleAux: true })
    expect(f.selected).toHaveBeenCalledExactlyOnceWith('anthropic', 'claude-next', true, undefined)
    expect(catalogWrites(f)[0][0]).toEqual({
      path: '/api/model/set?profile=default',
      method: 'POST',
      body: { scope: 'main', provider: 'anthropic', model: 'claude-next' }
    })
  })

  it('revalidates changed catalog after confirmation and does not reconcile uncertain writes', async () => {
    const f = fixture()
    f.confirm.mockImplementation(async () => {
      f.providers[1].authenticated = false

      return true
    })
    await expect(f.scope.request(request('select', { provider: 'anthropic', model: 'claude-next' }))).rejects.toThrow(
      'matrix_provider_not_ready'
    )
    expect(catalogWrites(f)).toHaveLength(0)
    expect(f.selected).not.toHaveBeenCalled()
  })

  it('adds local HTTP/IPv6 endpoints without making them default or exposing credentials', async () => {
    const f = fixture()

    const result = await f.scope.request(
      request('endpoint', { name: 'Local model', baseUrl: 'http://[::1]:11434/v1', model: 'local-model', apiKey: '' })
    )

    expect(result).toEqual({ status: 'applied' })
    expect(f.confirm).toHaveBeenCalledWith({
      kind: 'provider-endpoint',
      name: 'Local model',
      baseUrl: 'http://[::1]:11434/v1',
      model: 'local-model'
    })
    expect(catalogWrites(f)[0][0].body).toMatchObject({
      name: 'Local model',
      api_key: '',
      discover_models: false,
      make_default: false
    })
    expect(f.selected).not.toHaveBeenCalled()
    expect(f.info.provider).toBe('openrouter')
  })

  it.each([
    'not a URL',
    'file:///tmp/private',
    'https://user:key@host/v1',
    'https://host/v1?api_key=key',
    'https://host/v1#secret'
  ])('refuses unsafe endpoint URLs %s', async baseUrl => {
    const f = fixture()
    await expect(
      f.scope.request(request('endpoint', { name: 'Local', baseUrl, model: 'model', apiKey: '' }))
    ).rejects.toThrow('matrix_pages_request_forbidden')
    expect(f.confirm).not.toHaveBeenCalled()
  })

  it('checks duplicate endpoint names before and after approval', async () => {
    const f = fixture()
    f.confirm.mockImplementation(async () => {
      f.endpoints.push({ id: 'existing', name: 'Local', models: ['model'] })

      return true
    })
    await expect(
      f.scope.request(
        request('endpoint', { name: 'Local', baseUrl: 'http://localhost:1234/v1', model: 'model', apiKey: '' })
      )
    ).rejects.toThrow('matrix_provider_name_exists')
    expect(catalogWrites(f)).toHaveLength(0)
  })

  it('keeps upstream OAuth ID and URL native while binding opaque continuation to one scope', async () => {
    const f = fixture()
    const result = (await f.scope.request(request('oauth/start', { provider: 'openai-codex' }))) as { session: string }
    expect(JSON.stringify(result)).not.toMatch(/upstream-session|https/)
    expect(f.openExternal).toHaveBeenCalledWith('https://auth.openai.com/codex/device')
    await expect(f.scope.request(request('oauth/poll', { session: result.session }))).resolves.toEqual({
      status: 'pending'
    })
    await expect(fixture().scope.request(request('oauth/poll', { session: result.session }))).rejects.toThrow(
      'matrix_pages_request_forbidden'
    )
    // A device-code sign-in takes no pasted code.
    await expect(
      f.scope.request(request('oauth/submit', { session: result.session, code: 'synthetic-code' }))
    ).rejects.toThrow('matrix_pages_request_forbidden')
    const original = f.forward.getMockImplementation()!
    f.forward.mockImplementation(call =>
      call.path.includes('/poll/') ? Promise.resolve({ status: 'approved' }) : original(call)
    )
    // Hermes saved it: it reads ChatGPT back as connected.
    f.oauth.find(each => each.id === 'openai-codex')!.status = { logged_in: true }
    await expect(f.scope.request(request('oauth/poll', { session: result.session }))).resolves.toEqual({
      status: 'approved'
    })
    await expect(f.scope.request(request('oauth/poll', { session: result.session }))).rejects.toThrow(
      'matrix_pages_request_forbidden'
    )
    expect(f.signedIn).toHaveBeenCalledExactlyOnceWith('openai-codex')
    // The backend was held for the sign-in, and freed once it was over.
    expect(f.signingIn.mock.calls).toEqual([[true], [false]])
  })

  it('emits only closed lifecycle markers even when every upstream field is sensitive', async () => {
    const lines: string[] = []
    const lifecycle = new MatrixSubscriptionAuthLifecycle(line => lines.push(line))
    const f = fixture({ authLifecycle: lifecycle })

    const sensitive = {
      providerSession: 'provider-session-SENSITIVE',
      userCode: 'USER-CODE-SENSITIVE',
      deviceAuth: 'device-auth-SENSITIVE',
      authorizationCode: 'authorization-code-SENSITIVE',
      verifier: 'verifier-SENSITIVE',
      token: 'token-SENSITIVE',
      body: 'body-SENSITIVE',
      cookie: 'cookie-SENSITIVE',
      query: 'query-SENSITIVE',
      account: 'account-SENSITIVE'
    }

    const original = f.forward.getMockImplementation()!

    f.forward.mockImplementation(call =>
      call.path.includes('/start')
        ? Promise.resolve({
            session_id: sensitive.providerSession,
            flow: 'device_code',
            verification_url: `https://auth.openai.com/codex/device?state=${sensitive.query}`,
            user_code: sensitive.userCode,
            device_auth_id: sensitive.deviceAuth,
            authorization_code: sensitive.authorizationCode,
            code_verifier: sensitive.verifier,
            access_token: sensitive.token,
            body: sensitive.body,
            cookie: sensitive.cookie,
            account_id: sensitive.account
          })
        : original(call)
    )

    lifecycle.subscriptionStartReceived()
    lifecycle.hermesSpawned()
    lifecycle.hermesPortReady(12.4)
    await f.scope.request(request('oauth/acknowledge', { provider: 'openai-codex' }))
    await f.scope.request(request('oauth/start', { provider: 'openai-codex' }))
    lifecycle.startIpcSettled('pending')
    lifecycle.hermesExit({ code: 0, signal: null, intentional: true })

    const joined = lines.join('\n')
    expect(lines).toHaveLength(30)
    expect(lines.every(line => line.startsWith(`[Matrix] chatgpt_auth attempt=${lifecycle.attempt} `))).toBe(true)
    expect(joined).toContain('native_consent_result=accepted')
    expect(joined).toContain('provider_start_dispatch_end outcome=code_ready')
    expect(joined).toContain('open_external_end outcome=ok')
    expect(joined).toContain('start_ipc_settled outcome=pending')
    expect(joined).toContain('hermes_exit intentional=true code_class=zero')

    for (const value of Object.values(sensitive)) {
      expect(joined).not.toContain(value)
    }

    await f.scope.stop()
  })

  it('logs relay publication and agent refresh as status classes only', () => {
    const lines: string[] = []
    const lifecycle = new MatrixSubscriptionAuthLifecycle(line => lines.push(line))

    lifecycle.followUp('relay_publication', 'http_5xx')
    lifecycle.followUp('agent_refresh', 'ok')

    expect(lines).toEqual([
      `[Matrix] chatgpt_auth attempt=${lifecycle.attempt} relay_publication status_class=http_5xx`,
      `[Matrix] chatgpt_auth attempt=${lifecycle.attempt} agent_refresh status_class=ok`
    ])
  })

  it('reports an approved sign-in that Hermes does not read back as failed, never as done', async () => {
    const f = fixture()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = (await f.scope.request(request('oauth/start', { provider: 'openai-codex' }))) as { session: string }
    const original = f.forward.getMockImplementation()!
    f.forward.mockImplementation(call =>
      call.path.includes('/poll/') ? Promise.resolve({ status: 'approved' }) : original(call)
    )

    await expect(f.scope.request(request('oauth/poll', { session: result.session }))).resolves.toEqual({
      status: 'error'
    })
    expect(f.signedIn).not.toHaveBeenCalled()
    expect(f.signingIn.mock.calls).toEqual([[true], [false]])
    // A closed reason code, nothing from the backend.
    expect(JSON.stringify(warn.mock.calls)).toContain('matrix_plan_sign_in_unsaved')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-token')
    warn.mockRestore()
  })

  it('holds the backend until an approved sign-in is read back, and frees it even when that read fails', async () => {
    const f = fixture()
    const result = (await f.scope.request(request('oauth/start', { provider: 'openai-codex' }))) as { session: string }
    const original = f.forward.getMockImplementation()!
    const heldDuringRead: boolean[][] = []

    f.forward.mockImplementation(call => {
      if (call.path.includes('/poll/')) {
        return Promise.resolve({ status: 'approved' })
      }

      if (call.path.split('?')[0] === '/api/providers/oauth') {
        heldDuringRead.push(f.signingIn.mock.calls.map(([active]) => active))
      }

      return original(call)
    })
    f.oauth.find(each => each.id === 'openai-codex')!.status = { logged_in: true }

    await expect(f.scope.request(request('oauth/poll', { session: result.session }))).resolves.toEqual({
      status: 'approved'
    })
    // Hermes was read back while the backend was still held; it was freed only after.
    expect(heldDuringRead.length).toBeGreaterThan(0)
    expect(heldDuringRead).toEqual(heldDuringRead.map(() => [true]))
    expect(f.signingIn.mock.calls).toEqual([[true], [false]])

    // The read-back loses its backend: the sign-in fails, and the backend is still freed.
    const lost = fixture()

    const second = (await lost.scope.request(request('oauth/start', { provider: 'openai-codex' }))) as {
      session: string
    }

    const lostOriginal = lost.forward.getMockImplementation()!

    lost.forward.mockImplementation(call => {
      if (call.path.includes('/poll/')) {
        return Promise.resolve({ status: 'approved' })
      }

      if (call.path.split('?')[0] === '/api/providers/oauth') {
        return Promise.reject(new Error('backend gone'))
      }

      return lostOriginal(call)
    })

    await expect(lost.scope.request(request('oauth/poll', { session: second.session }))).rejects.toThrow()
    expect(lost.signedIn).not.toHaveBeenCalled()
    expect(lost.signingIn.mock.calls).toEqual([[true], [false]])
  })

  it('frees the backend when a sign-in is cancelled or its page closes', async () => {
    const cancelled = fixture()

    const result = (await cancelled.scope.request(request('oauth/start', { provider: 'openai-codex' }))) as {
      session: string
    }

    await cancelled.scope.request(request('oauth/cancel', { session: result.session }))
    expect(cancelled.signingIn.mock.calls).toEqual([[true], [false]])

    const closed = fixture()
    await closed.scope.request(request('oauth/start', { provider: 'openai-codex' }))
    await closed.scope.stop()
    expect(closed.signingIn.mock.calls).toEqual([[true], [false]])
  })

  it('frees the backend at once when a cancel fails, and still cancels upstream when the page closes', async () => {
    const f = fixture()
    const session = (await f.scope.request(request('oauth/start', { provider: 'openai-codex' }))) as { session: string }
    const original = f.forward.getMockImplementation()!
    f.forward.mockImplementation(call =>
      call.path.includes('/sessions/') ? Promise.reject(new Error('private-error')) : original(call)
    )

    await expect(f.scope.request(request('oauth/cancel', { session: session.session }))).rejects.toThrow(
      'matrix_provider_request_failed'
    )
    // Not held until the page closes: a restart waiting on this backend may run now.
    expect(f.signingIn.mock.calls).toEqual([[true], [false]])
    await expect(f.scope.request(request('oauth/poll', { session: session.session }))).rejects.toThrow(
      'matrix_pages_request_forbidden'
    )
    await f.scope.stop()
    expect(f.cancelOAuth).toHaveBeenCalledExactlyOnceWith('upstream-session')
    expect(f.signingIn.mock.calls).toEqual([[true], [false]])
  })

  it.each(['oauth/poll', 'oauth/cancel'])(
    'frees the backend when %s cannot reach the backend holding the sign-in',
    async action => {
      const f = fixture()

      const session = (await f.scope.request(request('oauth/start', { provider: 'openai-codex' }))) as {
        session: string
      }

      f.retire()
      await expect(f.scope.request(request(action, { session: session.session }))).rejects.toThrow(
        'matrix_pages_agent_unavailable'
      )
      expect(f.signingIn.mock.calls).toEqual([[true], [false]])
      await f.scope.stop()
      // Cleanup stays with the original runtime, once.
      expect(f.cancelOAuth).toHaveBeenCalledExactlyOnceWith('upstream-session')
      expect(f.signingIn.mock.calls).toEqual([[true], [false]])
    }
  )

  it('keeps a sign-in whose poll failed for a passing reason, so the page can poll again', async () => {
    const f = fixture()
    const session = (await f.scope.request(request('oauth/start', { provider: 'openai-codex' }))) as { session: string }
    const original = f.forward.getMockImplementation()!
    f.forward.mockImplementationOnce(call =>
      call.path.includes('/poll/') ? Promise.reject(new Error('private-error')) : original(call)
    )

    await expect(f.scope.request(request('oauth/poll', { session: session.session }))).rejects.toThrow(
      'matrix_provider_request_failed'
    )
    expect(f.signingIn.mock.calls).toEqual([[true]])
    await expect(f.scope.request(request('oauth/poll', { session: session.session }))).resolves.toEqual({
      status: 'pending'
    })
  })

  it('cancels OAuth on disposal using original-runtime cleanup after authority is retired', async () => {
    const f = fixture()
    await f.scope.request(request('oauth/start', { provider: 'openai-codex' }))
    f.retire()
    await f.scope.stop()
    expect(f.cancelOAuth).toHaveBeenCalledExactlyOnceWith('upstream-session')
    await expect(f.scope.request(request('snapshot', undefined, 'GET'))).rejects.toThrow(
      'matrix_pages_agent_unavailable'
    )
  })

  it('cancels a late start without opening a browser after view retirement', async () => {
    const f = fixture()
    const late = deferred<unknown>()
    const original = f.forward.getMockImplementation()!
    f.forward.mockImplementation(call => (call.path.includes('/start') ? late.promise : original(call)))
    const pending = f.scope.request(request('oauth/start', { provider: 'openai-codex' }))
    await vi.waitFor(() => expect(catalogWrites(f)).toHaveLength(1))
    f.retire()
    await f.scope.stop()
    late.resolve({
      session_id: 'late-session',
      flow: 'device_code',
      verification_url: 'https://auth.openai.com/codex/device',
      user_code: 'CODE'
    })
    await expect(pending).rejects.toThrow('matrix_pages_agent_unavailable')
    expect(f.cancelOAuth).toHaveBeenCalledWith('late-session')
    expect(f.openExternal).not.toHaveBeenCalled()
  })

  it('refuses arbitrary OAuth handoff URLs and masks upstream exceptions', async () => {
    const f = fixture()
    const original = f.forward.getMockImplementation()!
    f.forward.mockImplementation(call =>
      call.path.includes('/start')
        ? Promise.resolve({
            session_id: 'upstream-session',
            flow: 'device_code',
            verification_url: 'https://evil.test/codex/device',
            user_code: 'CODE'
          })
        : original(call)
    )
    await expect(f.scope.request(request('oauth/start', { provider: 'openai-codex' }))).rejects.toThrow(
      'matrix_provider_response_invalid'
    )
    expect(f.openExternal).not.toHaveBeenCalled()
    expect(f.cancelOAuth).toHaveBeenCalledWith('upstream-session')
    f.forward.mockRejectedValueOnce(new Error('private-secret-host'))
    await expect(f.scope.request(request('snapshot', undefined, 'GET'))).rejects.toThrow(
      'matrix_provider_request_failed'
    )
  })

  it.each([['openai-codex', 'https://auth.openai.com/codex/device?user_code=CODE']])(
    'uses the existing %s device-flow handoff shape and origin',
    async (provider, verificationUrl) => {
      const f = fixture()

      if (!f.oauth.some(row => row.id === provider)) {
        f.oauth.push({
          id: provider,
          name: provider,
          flow: 'device_code',
          disconnectable: true,
          status: { logged_in: false }
        })
      }

      const original = f.forward.getMockImplementation()!
      f.forward.mockImplementation(call =>
        call.path.includes('/start')
          ? Promise.resolve({
              session_id: 'device-session',
              flow: 'device_code',
              verification_url: verificationUrl,
              user_code: 'CODE',
              expires_in: 600,
              poll_interval: 5
            })
          : original(call)
      )
      const result = await f.scope.request(request('oauth/start', { provider }))
      expect(result).toMatchObject({
        status: 'pending',
        provider,
        flow: 'device_code',
        userCode: 'CODE',
        expiresIn: 600,
        pollInterval: 5
      })
      expect(f.openExternal).toHaveBeenCalledWith(verificationUrl)
      expect(JSON.stringify(result)).not.toContain('device-session')
      await f.scope.stop()
    }
  )

  it.each(['anthropic', 'xai-oauth', 'minimax-oauth', 'copilot-acp', 'qwen-oauth'])(
    'refuses %s plan sign-in in main even when Hermes offers a flow for it',
    async provider => {
      const f = fixture()
      const row = f.oauth.find(each => each.id === provider)!
      // Even an upstream that claims the flow the adapter used to support is refused.
      row.flow = provider === 'anthropic' ? 'pkce' : 'device_code'
      await expect(f.scope.request(request('oauth/start', { provider }))).rejects.toThrow('provider_terms_blocked')
      expect(f.confirm).not.toHaveBeenCalled()
      expect(catalogWrites(f)).toHaveLength(0)
      expect(f.openExternal).not.toHaveBeenCalled()
    }
  )

  it('hides plan-only sign-ins Atum does not offer, unless one is already connected', async () => {
    const f = fixture()

    const ids = async () =>
      ((await f.scope.request(request('snapshot', undefined, 'GET'))) as { providers: { id: string }[] }).providers.map(
        row => row.id
      )

    expect(await ids()).toEqual(expect.arrayContaining(['openai-codex', 'anthropic', 'openrouter']))
    expect(await ids()).not.toEqual(expect.arrayContaining(['xai-oauth']))
    expect(await ids()).not.toContain('minimax-oauth')
    expect(await ids()).not.toContain('copilot-acp')
    // Qwen is signed in (an existing connection): it stays visible so it can be seen.
    expect(await ids()).toContain('qwen-oauth')

    // Anthropic keeps its row for the API key; its subscription sign-in is not offered.
    const snapshot = (await f.scope.request(request('snapshot', undefined, 'GET'))) as {
      providers: { id: string; keyAvailable: boolean; oauth: { supported: boolean } | null }[]
    }

    const anthropic = snapshot.providers.find(row => row.id === 'anthropic')!
    expect(anthropic.oauth?.supported).toBe(false)
    expect(anthropic.keyAvailable).toBe(true)
  })

  it("writes a curated provider's API key, never its subscription token", async () => {
    const f = fixture()
    await expect(
      f.scope.request(request('key', { provider: 'anthropic', value: 'synthetic-key' }, 'PUT'))
    ).resolves.toEqual({ status: 'applied' })
    expect(catalogWrites(f)).toEqual([
      [{ path: '/api/env?profile=default', method: 'PUT', body: { key: 'ANTHROPIC_API_KEY', value: 'synthetic-key' } }]
    ])
  })

  it('lets main forget what it holds for a disconnected ChatGPT plan', async () => {
    const f = fixture()
    f.oauth.find(each => each.id === 'openai-codex')!.status = { logged_in: true }
    await expect(f.scope.request(request('oauth/disconnect', { provider: 'openai-codex' }))).resolves.toEqual({
      status: 'applied'
    })
    expect(f.disconnected).toHaveBeenCalledExactlyOnceWith('openai-codex')

    f.confirm.mockResolvedValueOnce(false)
    f.disconnected.mockClear()
    await expect(f.scope.request(request('oauth/disconnect', { provider: 'openai-codex' }))).resolves.toEqual({
      status: 'cancelled'
    })
    expect(f.disconnected).not.toHaveBeenCalled()
  })

  it('requires separate expensive-model confirmation without trusting a renderer confirmation flag', async () => {
    const f = fixture()
    const original = f.forward.getMockImplementation()!
    let attempts = 0
    f.forward.mockImplementation(call => {
      if (call.path.startsWith('/api/model/set') && attempts++ === 0) {
        return Promise.resolve({
          ok: false,
          scope: 'main',
          provider: 'anthropic',
          model: 'claude-next',
          confirm_required: true,
          confirm_message: 'High-cost model'
        })
      }

      return original(call)
    })
    await expect(f.scope.request(request('select', { provider: 'anthropic', model: 'claude-next' }))).resolves.toEqual({
      status: 'applied',
      staleAux: true
    })
    expect(f.confirm.mock.calls).toEqual([
      [{ kind: 'provider-select', provider: 'anthropic', model: 'claude-next' }],
      [{ kind: 'expensive-model', provider: 'anthropic', model: 'claude-next', message: 'High-cost model' }]
    ])
    expect(catalogWrites(f)[1][0].body).toEqual({
      scope: 'main',
      provider: 'anthropic',
      model: 'claude-next',
      confirm_expensive_model: true
    })
  })

  it('retains a failed cancel for original-runtime cleanup and prevents overlapping writes', async () => {
    const f = fixture()
    const session = (await f.scope.request(request('oauth/start', { provider: 'openai-codex' }))) as { session: string }
    const original = f.forward.getMockImplementation()!
    f.forward.mockImplementation(call =>
      call.path.includes('/sessions/') ? Promise.reject(new Error('private-error')) : original(call)
    )
    await expect(f.scope.request(request('oauth/cancel', { session: session.session }))).rejects.toThrow(
      'matrix_provider_request_failed'
    )
    await f.scope.stop()
    expect(f.cancelOAuth).toHaveBeenCalledWith('upstream-session')

    const active = fixture()
    const approval = deferred<boolean>()
    active.confirm.mockReturnValueOnce(approval.promise)
    const pending = active.scope.request(request('key', { provider: 'openrouter', value: 'synthetic-key' }, 'PUT'))
    await vi.waitFor(() => expect(active.confirm).toHaveBeenCalled())
    await expect(
      active.scope.request(request('select', { provider: 'anthropic', model: 'claude-next' }))
    ).rejects.toThrow('pages_agent_busy')
    approval.resolve(false)
    await expect(pending).resolves.toEqual({ status: 'cancelled' })
  })

  it('passes projected routes through actual home-resolving transport without renderer-selected home', async () => {
    const home = '/tmp/owned/agents/selected'
    const paths: string[] = []
    const f = fixture()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        const url = new URL(input)
        paths.push(url.pathname + url.search)
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer native-token')

        const result =
          url.pathname === '/api/profiles'
            ? {
                profiles: [
                  { name: 'selected', path: home },
                  { name: 'other', path: '/tmp/owned/agents/other' }
                ]
              }
            : await f.forward({
                path: url.pathname + url.search,
                method: init.method!,
                ...(init.body ? { body: JSON.parse(String(init.body)) } : {})
              })

        return Response.json(result)
      })
    )

    const scoped = new MatrixPagesProvidersScope({
      surface: 'connections',
      readPlanAcknowledgment: () => undefined,
      savePlanAcknowledgment: () => {
        throw new Error('unexpected_consent_write')
      },
      forward: createHermesPagesTransport(12345, 'native-token', home, new AbortController().signal),
      isCurrent: () => true,
      confirm: () => true,
      openExternal: () => {}
    })

    await scoped.request(request('key', { provider: 'openrouter', value: 'synthetic-key' }, 'PUT'))
    expect(
      paths
        .filter(path => path !== '/api/profiles')
        .every(path => new URL(path, 'http://local').searchParams.get('profile') === 'selected')
    ).toBe(true)
  })
})

it('offers the OpenCode Go subscription key and writes only its env name', async () => {
  const f = fixture()

  const snapshot = (await f.scope.request(request('snapshot', undefined, 'GET'))) as {
    providers: { id: string; keyAvailable: boolean; keySet: boolean }[]
  }

  expect(snapshot.providers.find(row => row.id === 'opencode-go')).toMatchObject({
    keyAvailable: true,
    keySet: false
  })
  expect(JSON.stringify(snapshot)).not.toMatch(/OPENCODE_GO|secret-opencode/)

  await expect(
    f.scope.request(request('key', { provider: 'opencode-go', value: 'synthetic-opencode-key' }, 'PUT'))
  ).resolves.toEqual({ status: 'applied' })
  expect(f.confirm).toHaveBeenCalledWith({ kind: 'provider-key', provider: 'opencode-go' })
  expect(catalogWrites(f)).toContainEqual([
    {
      path: '/api/env?profile=default',
      method: 'PUT',
      body: { key: 'OPENCODE_GO_API_KEY', value: 'synthetic-opencode-key' }
    }
  ])
})

it('reserves malformed routes in only the provider settings namespace', () => {
  expect(isMatrixProvidersRequest('/api/provider-settings/oauth/start?profile=other')).toBe(true)
  expect(isMatrixProvidersRequest('/api/providers/oauth')).toBe(false)
})

describe('native catalog policy admission', () => {
  it.each([
    'anthropic',
    'claude-code',
    'copilot',
    'copilot-acp',
    'qwen-oauth',
    'xai-oauth',
    'minimax-oauth',
    'unknown-plan'
  ])('refuses forced %s start and consent before any upstream request', async provider => {
    const f = fixture()

    for (const action of ['oauth/start', 'oauth/acknowledge']) {
      await expect(f.scope.request(request(action, { provider }))).rejects.toThrow('provider_terms_blocked')
    }

    expect(f.forward).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.savePlanAcknowledgment).not.toHaveBeenCalled()
  })

  it.each([
    { surface: 'advanced' as const },
    { acknowledgment: null },
    { acknowledgment: { provider: 'other-account', policyVersion: '2026-10-27', acknowledgedAt: '2026-10-27' } },
    { acknowledgment: { provider: 'openai-codex', policyVersion: '2026-10-26', acknowledgedAt: '2026-10-27' } },
    { acknowledgment: { provider: 'openai-codex', policyVersion: '2026-10-27', acknowledgedAt: '2026-10-26' } },
    { acknowledgment: { provider: 'openai-codex', policyVersion: '2026-10-27', acknowledgedAt: '2026-10-28' } },
    { today: '2026-12-12' }
  ])('requires native Advanced and current dated account consent: %j', async options => {
    const f = fixture(options)
    await expect(f.scope.request(request('oauth/start', { provider: 'openai-codex' }))).rejects.toThrow(
      'provider_terms_blocked'
    )
    expect(f.forward).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
  })

  it('records consent only after the native dialog, displays its exact date, and reuses that dialog once', async () => {
    const f = fixture({ acknowledgment: null })
    await expect(f.scope.request(request('oauth/acknowledge', { provider: 'openai-codex' }))).resolves.toEqual({
      status: 'applied'
    })
    expect(f.forward).not.toHaveBeenCalled()
    expect(f.savePlanAcknowledgment).toHaveBeenCalledExactlyOnceWith({
      provider: 'openai-codex',
      policyVersion: '2026-10-27',
      acknowledgedAt: '2026-10-27'
    })

    const snapshot = (await f.scope.request(request('snapshot', undefined, 'GET'))) as {
      providers: { id: string; oauth: { acknowledgment?: unknown } | null }[]
    }

    expect(snapshot.providers.find(row => row.id === 'openai-codex')?.oauth?.acknowledgment).toEqual({
      policyVersion: '2026-10-27',
      acknowledgedAt: '2026-10-27'
    })
    await f.scope.request(request('oauth/start', { provider: 'openai-codex' }))
    expect(f.confirm).toHaveBeenCalledOnce()
    expect(catalogWrites(f).filter(([call]) => call.path.endsWith('/start?profile=default'))).toHaveLength(1)
    await f.scope.stop()
  })

  it.each(['declined', 'storage', 'retired', 'expired'])(
    'a %s consent step cannot create an OAuth session',
    async reason => {
      const f = fixture({ acknowledgment: null })

      if (reason === 'storage') {
        f.savePlanAcknowledgment.mockImplementation(() => {
          throw new Error('storage_failed')
        })
      }

      f.confirm.mockImplementation(async () => {
        if (reason === 'retired') {
          f.retire()
        }

        if (reason === 'expired') {
          f.setToday('2026-12-12')
        }

        return reason !== 'declined'
      })
      const pending = f.scope.request(request('oauth/acknowledge', { provider: 'openai-codex' }))

      if (reason === 'declined') {
        await expect(pending).resolves.toEqual({ status: 'cancelled' })
      } else {
        await expect(pending).rejects.toThrow()
      }

      expect(f.forward).not.toHaveBeenCalled()

      if (reason !== 'storage') {
        expect(f.savePlanAcknowledgment).not.toHaveBeenCalled()
      }
    }
  )

  it('rejects renderer acceptance fields and keeps late native confirmation from writing after retirement', async () => {
    const f = fixture({ acknowledgment: null })
    await expect(
      f.scope.request(
        request('oauth/acknowledge', {
          provider: 'openai-codex',
          acknowledgedAt: '2026-10-07',
          accepted: true
        })
      )
    ).rejects.toThrow('matrix_pages_request_forbidden')
    await expect(
      f.scope.request(
        request('oauth/start', {
          provider: 'openai-codex',
          surface: 'advanced'
        })
      )
    ).rejects.toThrow('matrix_pages_request_forbidden')
    const approval = deferred<boolean>()
    f.confirm.mockReturnValueOnce(approval.promise)
    const pending = f.scope.request(request('oauth/acknowledge', { provider: 'openai-codex' }))
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalled())
    await expect(f.scope.request(request('oauth/acknowledge', { provider: 'openai-codex' }))).rejects.toThrow(
      'pages_agent_busy'
    )
    f.retire()
    approval.resolve(true)
    await expect(pending).rejects.toThrow('matrix_pages_agent_unavailable')
    expect(f.savePlanAcknowledgment).not.toHaveBeenCalled()
    expect(f.forward).not.toHaveBeenCalled()
  })

  it.each(['catalog', 'confirmation'])(
    'rechecks stored consent after the %s await and never starts with a revoked record',
    async stage => {
      const f = fixture()

      if (stage === 'catalog') {
        const original = f.forward.getMockImplementation()!
        f.forward.mockImplementationOnce(async call => {
          const result = await original(call)
          f.setAcknowledgment(undefined)

          return result
        })
      } else {
        f.confirm.mockImplementationOnce(async () => {
          f.setAcknowledgment(undefined)

          return true
        })
      }

      await expect(f.scope.request(request('oauth/start', { provider: 'openai-codex' }))).rejects.toThrow(
        'provider_terms_blocked'
      )
      expect(catalogWrites(f)).toHaveLength(0)
      expect(f.openExternal).not.toHaveBeenCalled()
    }
  )

  it('curated inventory cannot advertise a new plan start but keeps disconnect and API-key management', async () => {
    const f = fixture({ surface: 'advanced', acknowledgment: null })
    f.oauth.find(row => row.id === 'openai-codex')!.status.logged_in = true

    const snapshot = (await f.scope.request(request('snapshot', undefined, 'GET'))) as {
      providers: { id: string; oauth: { supported: boolean; connected: boolean } | null }[]
    }

    expect(snapshot.providers.find(row => row.id === 'openai-codex')?.oauth).toMatchObject({
      connected: true,
      supported: false
    })
    await expect(f.scope.request(request('oauth/disconnect', { provider: 'openai-codex' }))).resolves.toEqual({
      status: 'applied'
    })
    await expect(
      f.scope.request(request('key', { provider: 'anthropic', value: 'synthetic-key' }, 'PUT'))
    ).resolves.toEqual({ status: 'applied' })
  })
})

it('publishes only explicit current-model effort levels and withholds Max without leaking private metadata', async () => {
  const f = fixture()
  const provider = f.providers[0] as Record<string, unknown>
  provider.capabilities = { 'model-old': { efforts: ['low', 'high', 'max'], api_key: 'private-canary' } }
  const snapshot = await f.scope.request(request('snapshot', undefined, 'GET'))
  expect(snapshot).toMatchObject({
    current: { capability: { id: 'model-old', displayName: 'model-old', efforts: ['low', 'high'] } }
  })
  expect(JSON.stringify(snapshot)).not.toContain('private-canary')
  provider.capabilities = { 'another-model': { efforts: ['low', 'high'] } }
  expect(await f.scope.request(request('snapshot', undefined, 'GET'))).toMatchObject({
    current: { provider: 'openrouter', model: 'model-old' }
  })
  expect(
    ((await f.scope.request(request('snapshot', undefined, 'GET'))) as { current: Record<string, unknown> }).current
      .capability
  ).toBeUndefined()
})

it('passes the selected model descriptor to native routing only after authoritative readback', async () => {
  const f = fixture()

  ;(f.providers[1] as Record<string, unknown>).capabilities = { 'claude-next': { efforts: ['low', 'high'] } }
  await f.scope.request(request('select', { provider: 'anthropic', model: 'claude-next' }))
  expect(f.selected).toHaveBeenCalledExactlyOnceWith('anthropic', 'claude-next', true, {
    id: 'claude-next',
    displayName: 'claude-next',
    efforts: ['low', 'high']
  })
})
