import { afterEach, describe, expect, it, vi } from 'vitest'

import { MATRIX_NARRATION_DISPLAY } from '../../shared/matrix-turn-style'
import { ATUM_APPROVALS_DEFAULT_MODE } from '../atum-approval-default'

import { type MatrixCloudAgentMacRole, matrixCloudAgentNeedsLocalReadiness } from './cloud-agent-placement'
import type { MatrixHermesConnection } from './hermes-runtime'
import {
  applyMatrixFullHermes,
  applyMatrixManagedDefaults,
  configureMatrixHermes,
  configureMatrixManagedModel,
  finishMatrixAtumModelSwitch,
  MATRIX_FULL_HERMES_CONFIG,
  MATRIX_MANAGED_CONTEXT_LENGTH,
  MATRIX_MANAGED_ENDPOINT,
  MATRIX_MODEL_CHECK_WRITES,
  matrixAtumModelSwitchBlocked,
  matrixHermesReadiness,
  matrixSetupBlock,
  parseMatrixHermesModel,
  prepareMatrixHermesModel
} from './hermes-setup'

const value = { baseUrl: 'https://models.example/v1', model: 'provider/model', apiKey: 'test-key' }
const signal = () => new AbortController().signal

function fixture() {
  const request = vi.fn<(method: string) => Promise<unknown>>(async method =>
    method === 'setup.runtime_check' ? { ok: true } : { ready: true }
  )

  const api = vi.fn<MatrixHermesConnection['api']>(async () => {})
  const connection = { gateway: { request }, api } as unknown as MatrixHermesConnection

  return { request, api, connection }
}

afterEach(() => vi.useRealTimers())

describe('Hermes-owned setup', () => {
  it('preserves an explicit own provider when its credentials resolve', async () => {
    const f = fixture()
    const model = { provider: 'openai-codex', default: 'owner-model', context_length: 196_608 }
    f.request.mockImplementation(async (method: string) => {
      if (method === 'config.get') {return { config: { model } }}

      return method === 'setup.runtime_check' ? { ok: true } : { ready: true }
    })
    const result = await prepareMatrixHermesModel(f.connection, value, signal())
    expect(result).toEqual({
      ownModel: true,
      readiness: { state: 'ready' },
      connected: { provider: 'openai-codex', model: 'owner-model' }
    })

    expect(f.api).toHaveBeenCalledExactlyOnceWith('/api/config', {
      config: {
        auxiliary: { title_generation: { enabled: false } },
        compression: { protect_first_n: 0 }
      }
    })

    expect(model).toEqual({ provider: 'openai-codex', default: 'owner-model', context_length: 196_608 })
  })
  it.each(['standby', 'answering'] as MatrixCloudAgentMacRole[])(
    'falls back to the managed model without a setup block for an unsigned plan on a %s runtime', async role => {
      const f = fixture()
      let ready = false
      f.request.mockImplementation(async (method: string) => {
        if (method === 'config.get') {
          return { config: { model: { provider: 'openai-codex', default: 'owner-model' } } }
        }

        return method === 'setup.runtime_check' ? { ok: ready } : { ready: true }
      })
      f.api.mockImplementation(async () => { ready = true })

      expect(matrixCloudAgentNeedsLocalReadiness({ cloudRoute: true, role })).toBe(true)
      expect(await prepareMatrixHermesModel(f.connection, value, signal())).toEqual({
        ownModel: false,
        readiness: { state: 'ready' }
      })
      expect(f.api).toHaveBeenCalledWith(
        '/api/providers/custom-endpoints',
        expect.objectContaining({ id: MATRIX_MANAGED_ENDPOINT.id, make_default: true })
      )
      expect(matrixSetupBlock({ setup: undefined, planSignIn: false, enrolled: true })).toBeUndefined()
    }
  )
  it('repairs a managed profile and initializes a fresh one, not a failed own-provider selection', async () => {
    for (const provider of ['auto', MATRIX_MANAGED_ENDPOINT.id]) {
      const f = fixture()
      let ready = false
      f.request.mockImplementation(async (method: string) => {
        if (method === 'config.get') {return { config: { model: { provider } } }}

        return method === 'setup.runtime_check' ? { ok: ready } : { ready: true }
      })
      f.api.mockImplementation(async () => { ready = true })
      expect(await prepareMatrixHermesModel(f.connection, value, signal())).toEqual({ ownModel: false, readiness: { state: 'ready' } })
      expect(f.api).toHaveBeenCalledWith('/api/providers/custom-endpoints', expect.objectContaining({ id: MATRIX_MANAGED_ENDPOINT.id }))
    }
  })
  it('only applies the managed context limit to an already managed profile', async () => {
    const f = fixture()
    f.request.mockImplementation(async (method: string) => {
      if (method === 'config.get') {return { config: { model: { provider: MATRIX_MANAGED_ENDPOINT.id } } }}

      return method === 'setup.runtime_check' ? { ok: true } : { ready: true }
    })
    expect(await prepareMatrixHermesModel(f.connection, value, signal())).toEqual({ ownModel: false, readiness: { state: 'ready' } })
    expect(f.api).toHaveBeenCalledExactlyOnceWith('/api/config', { config: expect.objectContaining({ model: { context_length: MATRIX_MANAGED_CONTEXT_LENGTH } }) })
  })
  it('does not replace a provider when its configuration cannot be inspected', async () => {
    const f = fixture()
    f.request.mockRejectedValue(new Error('unavailable'))
    await expect(prepareMatrixHermesModel(f.connection, value, signal())).rejects.toThrow()
    expect(f.api).not.toHaveBeenCalled()
  })
  it.each([{ config: null }, { config: { model: { provider: 123 } } }])(
    'does not write when Hermes returns malformed provider configuration: %j', async config => {
      const f = fixture()
      f.request.mockResolvedValue(config)
      await expect(prepareMatrixHermesModel(f.connection, value, signal())).rejects.toThrow('matrix_setup_failed')
      expect(f.api).not.toHaveBeenCalled()
    }
  )
  it('does not silently rebind an unavailable legacy provider to a different endpoint', async () => {
    const f = fixture()
    f.request.mockImplementation(async method => method === 'config.get'
      ? { config: { model: { provider: 'atum-managed' } } }
      : { ok: false })
    expect(await prepareMatrixHermesModel(f.connection, value, signal())).toEqual({
      ownModel: true, readiness: { state: 'model_required' }
    })
    expect(f.api).not.toHaveBeenCalled()
  })
  it('falls back only for an optional plan Atum offers, not for key-based or unsupported providers', async () => {
    for (const [provider, fallback] of [
      ['openai-codex', true],
      ['openrouter', false],
      ['claude-code', false]
    ] as const) {
      const f = fixture()
      let ready = false
      f.request.mockImplementation(async method => method === 'config.get'
        ? { config: { model: { provider, default: 'some-model' } } }
        : method === 'setup.runtime_check' ? { ok: ready } : { ready: true })
      f.api.mockImplementation(async () => { ready = true })

      const result = await prepareMatrixHermesModel(f.connection, value, signal())
      expect(result.ownModel).toBe(!fallback)
      expect(result.readiness).toEqual({ state: fallback ? 'ready' : 'model_required' })
      expect(f.api).toHaveBeenCalledTimes(fallback ? 2 : 0)
    }
  })
  it("puts back Hermes's defaults and the old app's approval posture over an earlier narrow profile", async () => {
    const f = fixture()
    await applyMatrixFullHermes(f.connection, signal())
    expect(f.api).toHaveBeenCalledExactlyOnceWith('/api/config', { config: MATRIX_FULL_HERMES_CONFIG })
    // Never narrower than Hermes, and the old app's posture: it acts without asking (the
    // hardline blocklist and deny rules still apply), remembers, works in the real home.
    expect(MATRIX_FULL_HERMES_CONFIG.approvals.mode).toBe(ATUM_APPROVALS_DEFAULT_MODE)
    expect(MATRIX_FULL_HERMES_CONFIG.compression).toEqual({ protect_first_n: 0 })
    expect(MATRIX_FULL_HERMES_CONFIG.memory).toEqual({ memory_enabled: true, user_profile_enabled: true })
    expect(MATRIX_FULL_HERMES_CONFIG.terminal.home_mode).not.toBe('profile')
    // Tirith is setup's business: Hermes reports the terminal ready only when it fails closed.
    expect(MATRIX_FULL_HERMES_CONFIG).not.toHaveProperty('security')
    // Web search works for everyone with no key: the free backend the runtime bundles (FR6).
    expect(MATRIX_FULL_HERMES_CONFIG.web.backend).toBe('ddgs')
  })
  it("writes out the settings that carry the agent's words to the owner for a new home, the same ones the cloud writes", async () => {
    const f = fixture()
    await applyMatrixFullHermes(f.connection, signal())
    const sent = (f.api.mock.calls[0]![1] as { config: { display?: unknown } }).config
    // Hermes defaults to these; a new home states them so no default can silence the owner's progress.
    expect(sent.display).toEqual({ tool_progress: 'all', interim_assistant_messages: true, show_commentary: true })
    expect(sent.display).toEqual(MATRIX_NARRATION_DISPLAY)
    // Part of what the launch-time model check writes, so a build that changes it checks the profile once.
    expect(MATRIX_MODEL_CHECK_WRITES.full.display).toEqual(MATRIX_NARRATION_DISPLAY)
    // Only the full profile carries them: the defaults an earlier build's profile is brought up to never rewrite a
    // choice the person made (display settings are theirs once the full profile has been applied).
    const defaults = fixture()
    await applyMatrixManagedDefaults(defaults.connection, signal())
    expect(JSON.stringify(defaults.api.mock.calls)).not.toContain('display')
  })
  it("saves Atum's model under its own endpoint name, never the old built-in provider's", async () => {
    // 'atum-managed' is the old app's registered Hermes provider; it reads its key from
    // ATUM_MANAGED_MODEL_PROXY_TOKEN, so an endpoint saved under that id resolves to it
    // and has no key. That left the new app's assistant without a model.
    expect(MATRIX_MANAGED_ENDPOINT.id).not.toBe('atum-managed')
    const f = fixture()
    const proxy = { baseUrl: 'http://127.0.0.1:21890/v1', model: 'binh-minh', apiKey: 'proxy-key' }
    expect(await configureMatrixManagedModel(f.connection, proxy, signal())).toEqual({ state: 'ready' })
    expect(f.api).toHaveBeenCalledWith(
      '/api/providers/custom-endpoints',
      expect.objectContaining({ id: MATRIX_MANAGED_ENDPOINT.id, base_url: proxy.baseUrl, model: 'binh-minh', make_default: true })
    )
    // The old app's context length, declared so Hermes never probes the gateway for it.
    expect(f.api).toHaveBeenCalledWith('/api/config', {
      config: expect.objectContaining({
        model: { context_length: MATRIX_MANAGED_CONTEXT_LENGTH },
        auxiliary: { title_generation: { enabled: false } }
      })
    })
  })
  it('turns chat titles off for every executor profile, managed or not', async () => {
    const f = fixture()
    await configureMatrixHermes(f.connection, value, signal())

    const config = (f.api.mock.calls as unknown as Array<[string, { config: Record<string, unknown> }]>).find(
      ([route]) => route === '/api/config'
    )?.[1].config

    expect(config?.auxiliary).toEqual({ title_generation: { enabled: false } })
    // A bring-your-own model keeps Hermes's own context detection.
    expect(config).not.toHaveProperty('model')
  })
  it('brings a profile from an earlier build up to the current defaults', async () => {
    const f = fixture()
    await applyMatrixManagedDefaults(f.connection, signal())
    expect(f.api.mock.calls).toEqual([
      [
        '/api/config',
        {
          config: {
            model: { context_length: MATRIX_MANAGED_CONTEXT_LENGTH },
            auxiliary: { title_generation: { enabled: false } },
            compression: { protect_first_n: 0 }
          }
        }
      ]
    ])
  })
  it('uses Hermes endpoints and returns only readiness, never credentials or raw errors', async () => {
    const f = fixture()
    expect(await configureMatrixHermes(f.connection, value, signal())).toEqual({ state: 'ready' })
    expect(f.api.mock.calls).toEqual([
      [
        '/api/providers/custom-endpoints',
        expect.objectContaining({
          base_url: value.baseUrl,
          model: value.model,
          api_key: value.apiKey,
          replace_api_key: true,
          make_default: true
        })
      ],
      // Only Atum's additions; Hermes's defaults for everything else.
      [
        '/api/config',
        {
          config: {
            auxiliary: { title_generation: { enabled: false } },
            compression: { protect_first_n: 0 }
          }
        }
      ]
    ])
    expect(f.request).toHaveBeenCalledExactlyOnceWith('setup.runtime_check', {}, 60_000, expect.any(AbortSignal))
  })
  it.each([
    'http://remote.example/v1',
    'https://user:pass@example.com/v1',
    'https://example.com/?key=secret',
    'https://example.com/#secret',
    'file:///tmp/config',
    'bad'
  ])('rejects unsafe endpoint %s', baseUrl => {
    expect(() => parseMatrixHermesModel({ ...value, baseUrl })).toThrow('matrix_setup_invalid')
  })
  it('permits an explicitly configured loopback model, with no ambient profile selector', () => {
    expect(
      parseMatrixHermesModel({ ...value, baseUrl: 'http://127.0.0.1:1234/v1/', apiKey: '', profile: 'other' })
    ).toEqual({ ...value, baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '' })

    for (const bad of [null, {}, { ...value, model: '' }, { ...value, apiKey: 'bad\nkey' }]) {
      expect(() => parseMatrixHermesModel(bad)).toThrow('matrix_setup_invalid')
    }
  })
  it('uses the native runtime resolver for preflight and rejects an unresolved model', async () => {
    const f = fixture()
    expect(await matrixHermesReadiness(f.connection, signal())).toEqual({ state: 'ready' })
    expect(f.request).toHaveBeenCalledExactlyOnceWith('setup.runtime_check', {}, 60_000, expect.any(AbortSignal))
    f.request.mockResolvedValue({ ok: false })
    expect(await matrixHermesReadiness(f.connection, signal())).toEqual({ state: 'model_required' })
    f.request.mockResolvedValue({})
    expect(await matrixHermesReadiness(f.connection, signal())).toEqual({ state: 'model_required' })
  })
  it('propagates runtime RPC failures without declaring readiness', async () => {
    const f = fixture()
    f.request.mockRejectedValue(new Error('runtime unavailable'))
    await expect(matrixHermesReadiness(f.connection, signal())).rejects.toThrow('runtime unavailable')
  })
  it('honors cancellation after the native runtime check', async () => {
    const f = fixture()
    const abort = new AbortController()
    f.request.mockImplementation(async () => {
      abort.abort()

      return { ok: true }
    })
    await expect(configureMatrixHermes(f.connection, value, abort.signal)).rejects.toThrow()
    expect(f.api).toHaveBeenCalledTimes(2)
  })
})

describe('what the launch-time model check writes (G1-13)', () => {
  // A later launch skips the check while its stamp matches (model-check.ts), and the stamp
  // covers MATRIX_MODEL_CHECK_WRITES plus the proxy's address, model and key. So every body
  // the check sends, with those three inputs taken out, must be built from that descriptor:
  // a new write that is not listed there fails here instead of being skipped silently.
  const writes = MATRIX_MODEL_CHECK_WRITES

  const listed = [
    { route: '/api/providers/custom-endpoints', body: { ...writes.endpoint, ...writes.endpointOptions } },
    {
      route: '/api/config',
      body: {
        config: { auxiliary: writes.auxiliary, compression: writes.compression, model: { context_length: writes.contextLength } }
      }
    },
    { route: '/api/config', body: { config: { auxiliary: writes.auxiliary, compression: writes.compression } } },
    { route: '/api/config', body: { config: writes.full } }
  ]

  const inputs = new Set(['base_url', 'model', 'api_key'])

  const sent = (api: ReturnType<typeof fixture>['api']) =>
    api.mock.calls.map(([route, body]) => ({
      route,
      body:
        route === '/api/providers/custom-endpoints'
          ? Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([key]) => !inputs.has(key)))
          : body
    }))

  it.each([
    ['a fresh profile, which gets Atum\'s endpoint', 'auto', false],
    ['a profile already on Atum\'s model', MATRIX_MANAGED_ENDPOINT.id, true],
    ["the person's own model", 'openai-codex', true]
  ])('sends only listed writes for %s', async (_name, provider, resolves) => {
    const f = fixture()
    let ready = resolves
    f.request.mockImplementation(async (method: string) => {
      if (method === 'config.get') {
        return { config: { model: { provider } } }
      }

      return method === 'setup.runtime_check' ? { ok: ready } : { ready: true }
    })
    f.api.mockImplementation(async () => {
      ready = true
    })

    await prepareMatrixHermesModel(f.connection, value, signal())
    await applyMatrixFullHermes(f.connection, signal())

    expect(f.api.mock.calls.length).toBeGreaterThan(1)

    for (const call of sent(f.api)) {
      expect(listed).toContainEqual(call)
    }
  })
})

describe('why an unfinished setup blocks its agent', () => {
  it('names a signed-out plan as the sign-in it needs, and anything else as a setup failure', () => {
    expect(matrixSetupBlock({ setup: 'failed', planSignIn: true, enrolled: true })).toBe('plan_sign_in')
    expect(matrixSetupBlock({ setup: 'failed', planSignIn: false, enrolled: true })).toBe('setup_failed')
    // Not enrolled here: no plan sign-in can help before that.
    expect(matrixSetupBlock({ setup: 'failed', planSignIn: true, enrolled: false })).toBe('setup_failed')
    expect(matrixSetupBlock({ setup: undefined, planSignIn: false, enrolled: false })).toBe('setup_failed')
    // A setup that finished, or is still running, blocks nothing here.
    expect(matrixSetupBlock({ setup: undefined, planSignIn: true, enrolled: true })).toBeUndefined()
    expect(matrixSetupBlock({ setup: 'working', planSignIn: false, enrolled: true })).toBeUndefined()
  })

  it('lets an explicit Atum-model switch recover without the failed assistant backend', () => {
    expect(
      matrixAtumModelSwitchBlocked({
        operation: false,
        agentOperation: false,
        domainOperation: false,
        invocation: false,
        signIn: false,
        accountReady: true,
        runtime: true,
        managedModel: true
      })
    ).toBe(false)

    const recheck = vi.fn()
    const host = { planSignIn: true, readiness: { recheck } }

    finishMatrixAtumModelSwitch(host, false)
    expect(host.planSignIn).toBe(true)
    expect(recheck).not.toHaveBeenCalled()

    finishMatrixAtumModelSwitch(host, true)
    expect(host.planSignIn).toBe(false)
    expect(recheck).toHaveBeenCalledOnce()
  })

  it('does not switch to a managed model while another operation or sign-in owns the profile', () => {
    const available = {
      operation: false,
      agentOperation: false,
      domainOperation: false,
      invocation: false,
      signIn: false,
      accountReady: true,
      runtime: true,
      managedModel: true
    }

    for (const key of ['operation', 'agentOperation', 'domainOperation', 'invocation', 'signIn'] as const) {
      expect(matrixAtumModelSwitchBlocked({ ...available, [key]: true })).toBe(true)
    }
  })
})
