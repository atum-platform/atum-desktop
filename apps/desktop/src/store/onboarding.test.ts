import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as notifications from '@/store/notifications'
import type { OAuthProvider } from '@/types/hermes'

import {
  $desktopOnboarding,
  type DesktopOnboardingState,
  type OnboardingContext,
  refreshOnboarding,
  requestDesktopOnboarding,
  saveOnboardingLocalEndpoint,
  submitOnboardingCode
} from './onboarding'

function provider(id: string, name = id): OAuthProvider {
  return {
    cli_command: `hermes login ${id}`,
    docs_url: `https://example.com/${id}`,
    flow: 'pkce',
    id,
    name,
    status: { logged_in: false }
  }
}

function baseState(overrides: Partial<DesktopOnboardingState> = {}): DesktopOnboardingState {
  return {
    configured: false,
    flow: { status: 'idle' },
    mode: 'oauth',
    providers: null,
    reason: null,
    requested: false,
    firstRunSkipped: false,
    manual: false,
    localEndpoint: false,
    ...overrides
  }
}

function installApiMock(api: (request: { path: string }) => Promise<unknown>, productDefaultModel: null | string = null) {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { api, product: { defaultModel: async () => productDefaultModel } }
  })
}

function emptyOpenRouterGateway(): OnboardingContext['requestGateway'] {
  return async method => {
    if (method === 'setup.status') {
      return { provider_configured: true } as never
    }

    if (method === 'setup.runtime_check') {
      return { error: 'No usable credentials found for openrouter.', ok: false, provider: 'openrouter' } as never
    }

    throw new Error(`unexpected gateway method: ${method}`)
  }
}

function keylessCustomGateway(): OnboardingContext['requestGateway'] {
  return async method => {
    if (method === 'setup.status') {
      return { provider_configured: true } as never
    }

    if (method === 'setup.runtime_check') {
      return { ok: true, provider: 'custom' } as never
    }

    throw new Error(`unexpected gateway method: ${method}`)
  }
}

function onboardingContext(requestGateway: OnboardingContext['requestGateway']): OnboardingContext {
  return { requestGateway }
}

function fallbackTimeoutGateway(): OnboardingContext['requestGateway'] {
  return async method => {
    if (method === 'setup.status' || method === 'setup.runtime_check') {
      throw new Error(`request timed out: ${method}`)
    }

    throw new Error(`unexpected gateway method: ${method}`)
  }
}

describe('refreshOnboarding', () => {
  beforeEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
  })

  afterEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
    vi.restoreAllMocks()
  })

  it('refreshes OAuth providers again when onboarding was explicitly requested', async () => {
    const api = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth') {
        return { providers: [provider('fresh')] }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)
    $desktopOnboarding.set(baseState({ providers: [provider('cached')] }))
    requestDesktopOnboarding('Need provider setup')

    const ready = await refreshOnboarding(onboardingContext(emptyOpenRouterGateway()))

    expect(ready).toBe(false)
    expect(api).toHaveBeenCalledTimes(1)
    expect($desktopOnboarding.get().providers?.map(p => p.id)).toEqual(['fresh'])
    expect($desktopOnboarding.get().reason).toContain('No usable credentials found for openrouter.')
    expect($desktopOnboarding.get().reason).toContain('setup.status reports configured credentials')
  })

  it('keeps cached providers when onboarding was not re-requested', async () => {
    const api = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth') {
        return { providers: [provider('fresh')] }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)
    $desktopOnboarding.set(baseState({ providers: [provider('cached')] }))

    const ready = await refreshOnboarding(onboardingContext(emptyOpenRouterGateway()))

    expect(ready).toBe(false)
    expect(api).not.toHaveBeenCalled()
    expect($desktopOnboarding.get().providers?.map(p => p.id)).toEqual(['cached'])
  })

  it('does not downgrade configured=true on fallback-only readiness failures', async () => {
    const api = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth') {
        return { providers: [provider('fresh')] }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)
    // Simulate a returning user: cache is set and store is configured.
    window.localStorage.setItem('hermes-desktop-onboarded-v1', '1')
    $desktopOnboarding.set(
      baseState({
        configured: true,
        providers: [provider('cached')],
        reason: null,
        requested: false
      })
    )

    const ready = await refreshOnboarding(onboardingContext(fallbackTimeoutGateway()))

    expect(ready).toBe(false)
    expect(api).not.toHaveBeenCalled()
    expect($desktopOnboarding.get().configured).toBe(true)
    expect($desktopOnboarding.get().reason).toBeNull()
    // The cache must survive the refresh — proving we didn't downgrade.
    expect(window.localStorage.getItem('hermes-desktop-onboarded-v1')).toBe('1')
  })

  it('shows a non-blocking notification when preserving configured on fallback', async () => {
    const notifySpy = vi.spyOn(notifications, 'notify')

    installApiMock(vi.fn())
    $desktopOnboarding.set(
      baseState({
        configured: true,
        providers: [provider('cached')],
        reason: null,
        requested: false
      })
    )

    await refreshOnboarding(onboardingContext(fallbackTimeoutGateway()))

    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'runtime-not-ready',
        kind: 'error'
      })
    )
    expect($desktopOnboarding.get().configured).toBe(true)
  })

  it('enters setup when the selected OpenRouter credential is genuinely empty', async () => {
    installApiMock(vi.fn())
    window.localStorage.setItem('hermes-desktop-onboarded-v1', '1')
    $desktopOnboarding.set(
      baseState({
        configured: true,
        providers: [provider('cached')],
        reason: null,
        requested: false
      })
    )

    const ready = await refreshOnboarding(onboardingContext(emptyOpenRouterGateway()))

    expect(ready).toBe(false)
    expect($desktopOnboarding.get().configured).toBe(false)
    expect($desktopOnboarding.get().reason).toContain('No usable credentials found for openrouter.')
    expect(window.localStorage.getItem('hermes-desktop-onboarded-v1')).toBeNull()
  })

  it('keeps a keyless custom runtime out of setup', async () => {
    const api = vi.fn()

    installApiMock(api)
    $desktopOnboarding.set(baseState({ configured: false, reason: 'stale setup error', requested: true }))

    const ready = await refreshOnboarding(onboardingContext(keylessCustomGateway()))

    expect(ready).toBe(true)
    expect(api).not.toHaveBeenCalled()
    expect($desktopOnboarding.get()).toMatchObject({
      configured: true,
      reason: null,
      requested: false
    })
  })

  it('does not preserve configured when onboarding was explicitly requested', async () => {
    const api = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth') {
        return { providers: [provider('fresh')] }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)
    $desktopOnboarding.set(
      baseState({
        configured: true,
        providers: [provider('cached')],
        reason: null,
        requested: true
      })
    )

    const ready = await refreshOnboarding(onboardingContext(fallbackTimeoutGateway()))

    expect(ready).toBe(false)
    // requested overrides preservation — should downgrade.
    expect($desktopOnboarding.get().configured).toBe(false)
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('still surfaces onboarding when fallback failure happens before configured state', async () => {
    const api = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth') {
        return { providers: [provider('fresh')] }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)
    $desktopOnboarding.set(baseState({ configured: false, providers: null, requested: true }))

    const ready = await refreshOnboarding(onboardingContext(fallbackTimeoutGateway()))

    expect(ready).toBe(false)
    expect(api).toHaveBeenCalledTimes(1)
    expect($desktopOnboarding.get().configured).toBe(false)
    expect($desktopOnboarding.get().reason).toContain('request timed out')
  })

  it('deduplicates concurrent provider refresh calls', async () => {
    let resolveProviders!: (value: { providers: OAuthProvider[] }) => void

    const providersPromise = new Promise<{ providers: OAuthProvider[] }>(resolve => {
      resolveProviders = value => {
        resolve(value)
      }
    })

    const api = vi.fn(async ({ path }: { path: string }) => {
      if (path === '/api/providers/oauth') {
        return providersPromise
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)
    $desktopOnboarding.set(baseState({ requested: true }))

    const first = refreshOnboarding(onboardingContext(emptyOpenRouterGateway()))
    const second = refreshOnboarding(onboardingContext(emptyOpenRouterGateway()))

    await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1))

    resolveProviders({ providers: [provider('shared')] })
    await Promise.all([first, second])

    expect($desktopOnboarding.get().providers?.map(p => p.id)).toEqual(['shared'])
  })
})

describe('OAuth onboarding', () => {
  beforeEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
  })

  afterEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
    vi.restoreAllMocks()
  })

  it('clears stale readiness errors after OAuth succeeds and model confirmation is shown', async () => {
    const model = 'anthropic/claude-opus-4.8'
    const calls: { body?: unknown; path: string }[] = []

    installApiMock(async ({ body, path }: { body?: unknown; path: string }) => {
      calls.push({ body, path })

      if (path === '/api/providers/oauth/nous/submit') {
        return { ok: true, status: 'approved' }
      }

      if (path.startsWith('/api/model/options')) {
        return {
          providers: [
            {
              name: 'Nous Portal',
              slug: 'nous',
              models: [model]
            }
          ]
        }
      }

      if (path.startsWith('/api/model/recommended-default?')) {
        return { provider: 'nous', model, free_tier: false }
      }

      if (path === '/api/model/set') {
        return { ok: true, provider: 'nous', model, gateway_tools: [] }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    const requestGateway: OnboardingContext['requestGateway'] = async (method, params) => {
      if (method === 'reload.env') {
        return {} as never
      }

      if (method === 'setup.status') {
        return { provider_configured: true } as never
      }

      if (method === 'setup.runtime_check') {
        expect(params).toEqual({ provider: 'nous' })

        return { ok: true } as never
      }

      throw new Error(`unexpected gateway method: ${method}`)
    }

    $desktopOnboarding.set(
      baseState({
        flow: {
          status: 'awaiting_user',
          provider: provider('nous', 'Nous Portal'),
          start: {
            auth_url: 'https://portal.example/auth',
            expires_in: 600,
            flow: 'pkce',
            session_id: 'portal-session'
          },
          code: 'fresh-code'
        },
        reason:
          'No access token found for Nous Portal login. setup.status reports configured credentials, but runtime resolution still failed.',
        requested: true
      })
    )

    await submitOnboardingCode(onboardingContext(requestGateway))

    const state = $desktopOnboarding.get()
    expect(state.reason).toBeNull()
    expect(state.flow.status).toBe('confirming_model')

    if (state.flow.status === 'confirming_model') {
      expect(state.flow.label).toBe('Nous Portal')
      expect(state.flow.currentModel).toBe(model)
    }

    expect(calls.some(c => c.path === '/api/model/set')).toBe(true)

    const optionsIndex = calls.findIndex(c => c.path.startsWith('/api/model/options'))
    const recommendedIndex = calls.findIndex(c => c.path.startsWith('/api/model/recommended-default'))
    const setIndex = calls.findIndex(c => c.path === '/api/model/set')

    expect(optionsIndex).toBeGreaterThanOrEqual(0)
    expect(recommendedIndex).toBeGreaterThan(optionsIndex)
    expect(setIndex).toBeGreaterThan(recommendedIndex)
  })

  // G7: the packaged product pin, not the engine's silent default and not the
  // packaging host's ~/.hermes/config.yaml, decides the never-chosen-yet model.
  async function runCodexOnboarding({
    models,
    productDefaultModel
  }: {
    models: string[]
    productDefaultModel: null | string
  }) {
    const calls: { path: string }[] = []

    installApiMock(async ({ path }: { path: string }) => {
      calls.push({ path })

      if (path === '/api/providers/oauth/openai-codex/submit') {
        return { ok: true, status: 'approved' }
      }

      if (path.startsWith('/api/model/options')) {
        return { providers: [{ name: 'OpenAI Codex', slug: 'openai-codex', models }] }
      }

      if (path.startsWith('/api/model/recommended-default?')) {
        return { provider: 'openai-codex', model: 'gpt-5.4', free_tier: null }
      }

      if (path === '/api/model/set') {
        return { ok: true, provider: 'openai-codex', model: models[0], gateway_tools: [] }
      }

      throw new Error(`unexpected api path: ${path}`)
    }, productDefaultModel)

    const requestGateway: OnboardingContext['requestGateway'] = async method => {
      if (method === 'reload.env') {return {} as never}

      if (method === 'setup.status') {return { provider_configured: true } as never}

      if (method === 'setup.runtime_check') {return { ok: true } as never}

      throw new Error(`unexpected gateway method: ${method}`)
    }

    $desktopOnboarding.set(
      baseState({
        flow: {
          status: 'awaiting_user',
          provider: provider('openai-codex', 'OpenAI Codex'),
          start: {
            auth_url: 'https://codex.example/auth',
            expires_in: 600,
            flow: 'pkce',
            session_id: 'codex-session'
          },
          code: 'fresh-code'
        },
        requested: true
      })
    )

    await submitOnboardingCode(onboardingContext(requestGateway))

    const flow = $desktopOnboarding.get().flow

    return { calls, flow }
  }

  it('starts a packaged build on the pinned spark model instead of the backend recommendation', async () => {
    const { calls, flow } = await runCodexOnboarding({
      models: ['gpt-5.4', 'gpt-5.3-codex-spark'],
      productDefaultModel: 'gpt-5.3-codex-spark'
    })

    expect(flow.status).toBe('confirming_model')

    if (flow.status === 'confirming_model') {
      // Not models[0] ('gpt-5.4'), and not the /api/model/recommended-default
      // answer (also 'gpt-5.4') — the product pin outranks both.
      expect(flow.currentModel).toBe('gpt-5.3-codex-spark')
    }

    // The confirm card is still shown, so the user can change it immediately;
    // the pin supplies a starting value, it does not lock the picker.
    expect(calls.some(c => c.path === '/api/model/set')).toBe(true)
  })

  it('leaves providers that do not offer the pinned model on the engine recommendation', async () => {
    const { flow } = await runCodexOnboarding({
      models: ['gpt-5.4', 'gpt-5.4-mini'],
      productDefaultModel: 'gpt-5.3-codex-spark'
    })

    expect(flow.status).toBe('confirming_model')

    if (flow.status === 'confirming_model') {
      expect(flow.currentModel).toBe('gpt-5.4')
    }
  })

  it('falls back to the engine recommendation on unpinned builds', async () => {
    const { flow } = await runCodexOnboarding({
      models: ['gpt-5.4', 'gpt-5.3-codex-spark'],
      productDefaultModel: null
    })

    expect(flow.status).toBe('confirming_model')

    if (flow.status === 'confirming_model') {
      expect(flow.currentModel).toBe('gpt-5.4')
    }
  })
})

describe('saveOnboardingLocalEndpoint', () => {
  beforeEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
  })

  afterEach(() => {
    window.localStorage.clear()
    $desktopOnboarding.set(baseState())
    vi.restoreAllMocks()
  })

  function readyGateway(): OnboardingContext['requestGateway'] {
    return async method => {
      if (method === 'reload.env') {
        return {} as never
      }

      if (method === 'setup.status') {
        return { provider_configured: true } as never
      }

      if (method === 'setup.runtime_check') {
        return { ok: true } as never
      }

      throw new Error(`unexpected gateway method: ${method}`)
    }
  }

  it('errors when the endpoint advertises no models (nothing to route to)', async () => {
    const calls: string[] = []
    installApiMock(async ({ path }: { path: string }) => {
      calls.push(path)

      if (path === '/api/providers/validate') {
        return { ok: true, reachable: true, message: '', models: [] }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    const result = await saveOnboardingLocalEndpoint('http://127.0.0.1:8000/v1', '', {
      requestGateway: readyGateway()
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('no models')
    // Must not attempt to persist an assignment without a model.
    expect(calls).not.toContain('/api/model/set')
  })

  it('auto-discovers the model and persists provider=custom + base_url, then finishes', async () => {
    const calls: { body?: unknown; path: string }[] = []

    const api = vi.fn(async ({ body, path }: { body?: unknown; path: string }) => {
      calls.push({ body, path })

      if (path === '/api/providers/validate') {
        return { ok: true, reachable: true, message: '', models: ['llama-3.1-8b', 'qwen2.5-7b'] }
      }

      if (path === '/api/model/set') {
        return { ok: true, provider: 'custom', model: 'llama-3.1-8b', base_url: 'http://127.0.0.1:8000/v1' }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)
    const onCompleted = vi.fn()

    const result = await saveOnboardingLocalEndpoint('http://127.0.0.1:8000/v1', '', {
      onCompleted,
      requestGateway: readyGateway()
    })

    expect(result.ok).toBe(true)

    const assign = calls.find(c => c.path === '/api/model/set')
    expect(assign?.body).toMatchObject({
      scope: 'main',
      provider: 'custom',
      model: 'llama-3.1-8b',
      base_url: 'http://127.0.0.1:8000/v1'
    })

    expect(onCompleted).toHaveBeenCalledTimes(1)
    expect($desktopOnboarding.get().configured).toBe(true)
  })

  it('forwards the API key to the probe and persists it for auth-gated endpoints', async () => {
    const calls: { body?: unknown; path: string }[] = []

    const api = vi.fn(async ({ body, path }: { body?: unknown; path: string }) => {
      calls.push({ body, path })

      if (path === '/api/providers/validate') {
        return { ok: true, reachable: true, message: '', models: ['gpt-oss-120b'] }
      }

      if (path === '/api/model/set') {
        return { ok: true, provider: 'custom', model: 'gpt-oss-120b', base_url: 'https://text.example.com/v1' }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    installApiMock(api)

    const result = await saveOnboardingLocalEndpoint('https://text.example.com/v1', 'sk-secret', {
      requestGateway: readyGateway()
    })

    expect(result.ok).toBe(true)

    // The probe must receive the key so an auth-gated /v1/models enumerates.
    const probe = calls.find(c => c.path === '/api/providers/validate')
    expect(probe?.body).toMatchObject({
      key: 'OPENAI_BASE_URL',
      value: 'https://text.example.com/v1',
      api_key: 'sk-secret'
    })

    // And the key must be persisted alongside the endpoint for runtime auth.
    const assign = calls.find(c => c.path === '/api/model/set')
    expect(assign?.body).toMatchObject({
      scope: 'main',
      provider: 'custom',
      model: 'gpt-oss-120b',
      base_url: 'https://text.example.com/v1',
      api_key: 'sk-secret'
    })
  })

  it('reports the runtime reason when resolution still fails after saving', async () => {
    installApiMock(async ({ path }: { path: string }) => {
      if (path === '/api/providers/validate') {
        return { ok: true, reachable: true, message: '', models: ['llama-3.1-8b'] }
      }

      if (path === '/api/model/set') {
        return { ok: true }
      }

      throw new Error(`unexpected api path: ${path}`)
    })

    const failingGateway: OnboardingContext['requestGateway'] = async method => {
      if (method === 'reload.env') {
        return {} as never
      }

      if (method === 'setup.status') {
        return { provider_configured: false } as never
      }

      if (method === 'setup.runtime_check') {
        return { ok: false, error: 'No provider can serve the selected model.' } as never
      }

      throw new Error(`unexpected gateway method: ${method}`)
    }

    const result = await saveOnboardingLocalEndpoint('http://127.0.0.1:8000/v1', '', {
      requestGateway: failingGateway
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('No provider can serve the selected model.')
    expect($desktopOnboarding.get().configured).not.toBe(true)
  })
})

describe('manual subscription provider selection', () => {
  afterEach(() => {
    $desktopOnboarding.set(baseState())
    vi.restoreAllMocks()
  })

  async function saveKimi({ missing = false, failSave = false, declined = false, generic = false, offline = false } = {}) {
    const { saveOnboardingApiKey, startManualOnboarding } = await import('./onboarding')
    const writes: unknown[] = []

    const api = vi.fn(async ({ path, body }: { path: string; body?: unknown }) => {
      if (path === '/api/env') {return { ok: true }}

      if (path.startsWith('/api/model/options')) {
        if (offline) {throw new Error('Offline')}

        return { providers: [
          { slug: 'atum-managed', name: 'Atum', models: ['binh-minh'] },
          ...missing ? [] : [{ slug: 'kimi-coding', name: 'Kimi / Moonshot', key_env: 'KIMI_API_KEY', models: ['kimi-for-coding'] }]
        ] }
      }

      if (path.startsWith('/api/model/recommended-default')) {return { model: 'kimi-for-coding' }}

      if (path === '/api/model/set') {
        writes.push(body)

        if (failSave) {throw new Error('Unable to save model')}

        return { ok: !declined, gateway_tools: [] }
      }

      throw new Error(`Unexpected path: ${path}`)
    })

    installApiMock(api)
    $desktopOnboarding.set(baseState({ configured: true }))

    startManualOnboarding(null)
    $desktopOnboarding.set({ ...$desktopOnboarding.get(), requireProviderMatch: !generic })

    const result = await saveOnboardingApiKey('KIMI_API_KEY', 'test-key', 'Kimi Code', {
      requestGateway: async () => ({ ok: true, provider_configured: true }) as never
    })

    return { result, writes }
  }

  it('uses the catalog credential mapping to switch from Atum to Kimi and confirm its model', async () => {
    const { result, writes } = await saveKimi()
    expect(result.ok).toBe(true)
    expect(writes).toEqual([{ scope: 'main', provider: 'kimi-coding', model: 'kimi-for-coding' }])
    expect($desktopOnboarding.get().flow).toMatchObject({ status: 'confirming_model', providerSlug: 'kimi-coding' })
  })

  it('does not fall back to Atum or report success when Kimi has no model catalog', async () => {
    const { result, writes } = await saveKimi({ missing: true })
    expect(result.ok).toBe(false)
    expect(result.message).toBeTruthy()
    expect(writes).toEqual([])
    expect($desktopOnboarding.get().manual).toBe(true)
    expect($desktopOnboarding.get().flow.status).toBe('idle')
  })

  it('does not confirm a model when the backend returns an unsuccessful assignment', async () => {
    const { result } = await saveKimi({ declined: true })
    expect(result.ok).toBe(false)
    expect(result.message).toBeTruthy()
    expect($desktopOnboarding.get().flow.status).toBe('idle')
  })

  it('preserves the generic manual setup fallback', async () => {
    const { result, writes } = await saveKimi({ generic: true, missing: true })
    expect(result.ok).toBe(true)
    expect(writes).toEqual([expect.objectContaining({ provider: 'atum-managed' })])
  })

  it('keeps a targeted setup open on a catalog transport failure', async () => {
    const { result, writes } = await saveKimi({ offline: true })
    expect(result.ok).toBe(false)
    expect(result.message).toBeTruthy()
    expect(writes).toEqual([])
  })

  it('shows a recoverable error after targeted OAuth when its model catalog is unavailable', async () => {
    installApiMock(async ({ path }) => {
      if (path.endsWith('/submit')) {return { ok: true, status: 'approved' }}

      if (path.startsWith('/api/model/options')) {return { providers: [] }}
      throw new Error(`Unexpected path: ${path}`)
    })
    $desktopOnboarding.set(baseState({
      manual: true,
      requireProviderMatch: true,
      flow: {
        status: 'awaiting_user', provider: provider('openai-codex'), code: 'test-code',
        start: { flow: 'pkce', session_id: 'test-session', auth_url: 'https://example.com', expires_in: 600 }
      }
    }))
    await submitOnboardingCode({ requestGateway: async () => ({ ok: true }) as never })
    expect($desktopOnboarding.get().flow).toMatchObject({ status: 'error' })
    expect($desktopOnboarding.get().manual).toBe(true)
  })

  it('keeps setup open when saving the subscription model fails', async () => {
    const { result } = await saveKimi({ failSave: true })
    expect(result).toEqual({ ok: false, message: 'Unable to save model' })
    expect($desktopOnboarding.get().flow.status).toBe('idle')
    expect($desktopOnboarding.get().manual).toBe(true)
  })
})
