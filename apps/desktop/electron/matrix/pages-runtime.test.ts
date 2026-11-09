import { describe, expect, it, vi } from 'vitest'

import { createMatrixPagesRuntimeScope, isMatrixRuntimeRequest } from './pages-runtime'

type ForwardRequest = { path: string; method: string; body?: unknown }

function forwarded(calls: unknown[][]): ForwardRequest[] {
  return calls.map(call => call[0] as ForwardRequest)
}

const modelInfo = (provider = 'openrouter', model = 'openai/gpt-5') => ({
  provider,
  model,
  effective_context_length: 128_000,
  api_key: 'must-not-reach-page'
})

const catalog = (provider = 'openrouter', models = ['openai/gpt-5']) => ({
  providers: [
    {
      slug: provider,
      is_current: true,
      authenticated: true,
      models,
      unavailable_models: ['blocked-model'],
      api_key: 'must-not-reach-page'
    }
  ]
})

const memory = (providers: unknown[] = []) => ({
  active: '',
  providers,
  builtin_files: { memory: 99, user: 22 },
  secrets: ['must-not-reach-page']
})

function scope(responses: unknown[], current: () => boolean = () => true) {
  const forward = vi.fn(async () => responses.shift())
  const confirm = vi.fn(async () => true)

  return { scope: createMatrixPagesRuntimeScope({ isCurrent: current, forward, confirm }), forward, confirm }
}

describe('native Runtime route ownership', () => {
  it('recognizes only the synthetic snapshot and the two existing guarded writes', () => {
    expect(isMatrixRuntimeRequest('/api/runtime/snapshot')).toBe(true)
    expect(isMatrixRuntimeRequest('/api/model/set')).toBe(true)
    expect(isMatrixRuntimeRequest('/api/memory/provider')).toBe(true)
    expect(isMatrixRuntimeRequest('/api/runtime/snapshot?profile=default')).toBe(false)
    expect(isMatrixRuntimeRequest('/api/config')).toBe(false)
  })

  it.each([
    { path: '/api/config' },
    { path: '/api/runtime/snapshot?profile=default' },
    { path: '/api/runtime/snapshot', method: 'POST' },
    { path: '/api/runtime/snapshot', body: {} },
    { path: '/api/model/set', method: 'POST', body: { scope: 'auxiliary', provider: 'openrouter', model: 'openai/gpt-5' } },
    { path: '/api/model/set', method: 'POST', body: { provider: 'openrouter', model: 'openai/gpt-5' } },
    {
      path: '/api/model/set',
      method: 'POST',
      body: { scope: 'main', provider: 'openrouter', model: 'openai/gpt-5', profile: 'other' }
    },
    {
      path: '/api/model/set',
      method: 'POST',
      body: { scope: 'main', provider: 'openrouter', model: 'openai/gpt-5', api_key: 'secret' }
    },
    {
      path: '/api/model/set',
      method: 'POST',
      body: { scope: 'main', provider: 'openrouter', model: 'openai/gpt-5', confirm_expensive_model: true }
    },
    { path: '/api/memory/provider', method: 'PUT', body: { provider: 'mem0', base_url: 'http://private' } },
    { path: '/api/memory/provider', method: 'POST', body: { provider: 'mem0' } }
  ])('rejects injected or arbitrary page requests %#', async request => {
    const f = scope([])
    await expect(f.scope.request(request as never)).rejects.toThrow('matrix_pages_request_forbidden')
    expect(f.forward).not.toHaveBeenCalled()
  })
})

describe('native Runtime snapshot projection', () => {
  it('does not report builtin memory when the upstream memory response is invalid', async () => {
    for (const response of [null, {}, { active: null, providers: [] }, { active: '' }]) {
      const f = scope([modelInfo(), catalog(), response])
      await expect(f.scope.request({ path: '/api/runtime/snapshot' })).rejects.toThrow('matrix_runtime_response_invalid')
    }
  })
  it('composes exact fixed reads and projects no config, secret, or raw auxiliary payload', async () => {
    const f = scope([
      modelInfo(),
      catalog('openrouter', ['openai/gpt-5', 'blocked-model', 'openai/gpt-5']),
      memory([
        {
          name: 'mem0',
          description: 'Configured memory',
          status: 'ready',
          configured: true,
          available: true,
          setup: { token: 'secret' }
        },
        { name: 'hindsight', description: 'Needs a key', status: 'needs_config' },
        { name: 'gone', description: 'Unavailable', status: 'missing' }
      ])
    ])

    await expect(f.scope.request({ path: '/api/runtime/snapshot' })).resolves.toEqual({
      main: { provider: 'openrouter', model: 'openai/gpt-5', contextLength: 128_000 },
      modelEditable: true,
      models: ['openai/gpt-5'],
      memory: {
        active: '',
        providers: [
          { name: 'mem0', description: 'Configured memory', status: 'ready' },
          { name: 'hindsight', description: 'Needs a key', status: 'needs_config' },
          { name: 'gone', description: 'Unavailable', status: 'unavailable' }
        ]
      }
    })
    expect(forwarded(f.forward.mock.calls)).toEqual([
      { path: '/api/model/info?profile=default', method: 'GET' },
      { path: '/api/model/options?explicit_only=1&read_only=1&profile=default', method: 'GET' },
      { path: '/api/memory?profile=default', method: 'GET' }
    ])
  })

  it('makes missing info and custom/local/Nous current providers read-only without leaking their response fields', async () => {
    for (const provider of ['', 'custom', 'local', 'custom:office', 'nous']) {
      const f = scope([provider ? modelInfo(provider) : {}, provider ? catalog(provider) : undefined, memory()])
      const result = await f.scope.request({ path: '/api/runtime/snapshot' })
      expect(result).toMatchObject({ main: provider ? { provider } : null, modelEditable: false, models: [] })
    }
  })

  it('requires an authenticated current catalog row rather than trusting an independent provider entry', async () => {
    const f = scope([
      modelInfo(),
      { providers: [{ slug: 'openrouter', is_current: false, authenticated: true, models: ['openai/gpt-5'] }] },
      memory()
    ])

    await expect(f.scope.request({ path: '/api/runtime/snapshot' })).resolves.toMatchObject({
      modelEditable: false,
      models: []
    })
  })

  it('rejects a scope that goes stale while any fixed upstream read is pending', async () => {
    let current = true

    const forward = vi.fn(async () => {
      current = false

      return modelInfo()
    })

    const f = createMatrixPagesRuntimeScope({ isCurrent: () => current, confirm: () => true, forward })
    await expect(f.request({ path: '/api/runtime/snapshot' })).rejects.toThrow('matrix_pages_agent_unavailable')
    expect(forward).toHaveBeenCalledOnce()
  })
})

describe('native Runtime model writes', () => {
  it('reports Hermes-normalized model names only after the scoped read confirms them', async () => {
    const f = scope([
      modelInfo('anthropic', 'claude-sonnet-4-6'),
      catalog('anthropic', ['anthropic/claude-opus-4.6']),
      { ok: true, scope: 'main', provider: 'anthropic', model: 'claude-opus-4-6' },
      modelInfo('anthropic', 'claude-opus-4-6')
    ])

    await expect(f.scope.request({ path: '/api/model/set', method: 'POST',
      body: { scope: 'main', provider: 'anthropic', model: 'anthropic/claude-opus-4.6' }
    })).resolves.toMatchObject({ status: 'applied', model: 'claude-opus-4-6' })
  })

  it('freshly validates the current authenticated catalog, writes an exact main assignment, then returns normalized truth only', async () => {
    const f = scope([
      modelInfo(),
      catalog(),
      {
        ok: true,
        scope: 'main',
        provider: 'openrouter',
        model: 'openai/gpt-5',
        stale_aux: [{ task: 'private', model: 'hidden' }]
      },
      modelInfo('openrouter', 'openai/gpt-5')
    ])

    await expect(
      f.scope.request({
        path: '/api/model/set',
        method: 'POST',
        body: { scope: 'main', provider: 'openrouter', model: 'openai/gpt-5' }
      })
    ).resolves.toEqual({
      status: 'applied',
      kind: 'model',
      provider: 'openrouter',
      model: 'openai/gpt-5',
      staleAux: true
    })
    expect(forwarded(f.forward.mock.calls)).toEqual([
      { path: '/api/model/info?profile=default', method: 'GET' },
      { path: '/api/model/options?explicit_only=1&read_only=1&profile=default', method: 'GET' },
      {
        path: '/api/model/set?profile=default',
        method: 'POST',
        body: { scope: 'main', provider: 'openrouter', model: 'openai/gpt-5' }
      },
      { path: '/api/model/info?profile=default', method: 'GET' }
    ])
  })

  it('keeps the native managed endpoint writable while custom endpoints remain excluded', async () => {
    const f = scope([
      modelInfo('atum-gateway', 'binh-minh'),
      catalog('atum-gateway', ['binh-minh']),
      { ok: true, scope: 'main', provider: 'atum-gateway', model: 'binh-minh' },
      modelInfo('atum-gateway', 'binh-minh')
    ])

    await expect(
      f.scope.request({
        path: '/api/model/set',
        method: 'POST',
        body: { scope: 'main', provider: 'atum-gateway', model: 'binh-minh' }
      })
    ).resolves.toMatchObject({ status: 'applied', provider: 'atum-gateway', model: 'binh-minh' })
  })

  it.each([
    ['provider switches', modelInfo('anthropic'), catalog('anthropic'), 'openrouter'],
    [
      'unauthenticated rows',
      modelInfo(),
      { providers: [{ slug: 'openrouter', is_current: true, authenticated: false, models: ['openai/gpt-5'] }] },
      'openrouter'
    ],
    ['unavailable models', modelInfo(), catalog('openrouter', ['blocked-model']), 'openrouter'],
    ['Nous side effects', modelInfo('nous'), catalog('nous'), 'nous'],
    ['custom endpoint writes', modelInfo('custom:office'), catalog('custom:office'), 'custom:office'],
    ['local endpoint writes', modelInfo('local'), catalog('local'), 'local']
  ])('rejects %s before a model write', async (_label, info, options, provider) => {
    const f = scope([info, options])
    await expect(
      f.scope.request({
        path: '/api/model/set',
        method: 'POST',
        body: { scope: 'main', provider, model: 'openai/gpt-5' }
      })
    ).rejects.toThrow('matrix_runtime_response_invalid')
    expect(forwarded(f.forward.mock.calls).some(call => call.path.startsWith('/api/model/set'))).toBe(false)
  })

  it('handles exactly one native expensive-model confirmation and revalidates before its sole retry', async () => {
    const f = scope([
      modelInfo(),
      catalog(),
      {
        ok: false,
        scope: 'main',
        provider: 'openrouter',
        model: 'openai/gpt-5',
        confirm_required: true,
        confirm_message: 'Costs more.'
      },
      modelInfo(),
      catalog(),
      { ok: true, scope: 'main', provider: 'openrouter', model: 'openai/gpt-5' },
      modelInfo()
    ])

    await expect(
      f.scope.request({
        path: '/api/model/set',
        method: 'POST',
        body: { scope: 'main', provider: 'openrouter', model: 'openai/gpt-5' }
      })
    ).resolves.toMatchObject({ status: 'applied', kind: 'model', staleAux: false })
    expect(f.confirm).toHaveBeenCalledWith({
      kind: 'expensive-model',
      provider: 'openrouter',
      model: 'openai/gpt-5',
      message: 'Costs more.'
    })
    expect(
      forwarded(f.forward.mock.calls)
        .filter(call => call.path.startsWith('/api/model/set'))
        .map(call => call.body)
    ).toEqual([
      { scope: 'main', provider: 'openrouter', model: 'openai/gpt-5' },
      { scope: 'main', provider: 'openrouter', model: 'openai/gpt-5', confirm_expensive_model: true }
    ])
  })

  it('does not write after a declined or stale expensive-model dialog, and rejects malformed confirmation responses', async () => {
    const declined = scope([
      modelInfo(),
      catalog(),
      { ok: false, scope: 'main', provider: 'openrouter', model: 'openai/gpt-5', confirm_required: true }
    ])

    declined.confirm.mockResolvedValue(false)
    await expect(
      declined.scope.request({
        path: '/api/model/set',
        method: 'POST',
        body: { scope: 'main', provider: 'openrouter', model: 'openai/gpt-5' }
      })
    ).resolves.toEqual({ status: 'cancelled' })

    let current = true

    const stale = scope(
      [
        modelInfo(),
        catalog(),
        { ok: false, scope: 'main', provider: 'openrouter', model: 'openai/gpt-5', confirm_required: true }
      ],
      () => current
    )

    stale.confirm.mockImplementation(async () => {
      current = false

      return true
    })
    await expect(
      stale.scope.request({
        path: '/api/model/set',
        method: 'POST',
        body: { scope: 'main', provider: 'openrouter', model: 'openai/gpt-5' }
      })
    ).rejects.toThrow('matrix_pages_agent_unavailable')

    const malformed = scope([
      modelInfo(),
      catalog(),
      { ok: false, scope: 'main', provider: 'other', model: 'openai/gpt-5', confirm_required: true }
    ])

    await expect(
      malformed.scope.request({
        path: '/api/model/set',
        method: 'POST',
        body: { scope: 'main', provider: 'openrouter', model: 'openai/gpt-5' }
      })
    ).rejects.toThrow('matrix_runtime_response_invalid')
  })
})

describe('native Runtime memory writes', () => {
  const ready = () =>
    memory([{ name: 'mem0', description: 'Memory', configured: true, available: true, status: 'ready' }])

  it('requires native confirmation and fresh ready status before exact provider selection', async () => {
    const f = scope([ready(), ready(), { ok: true, active: 'mem0', api_key: 'must-not-reach-page' }])
    await expect(
      f.scope.request({ path: '/api/memory/provider', method: 'PUT', body: { provider: 'mem0' } })
    ).resolves.toEqual({ status: 'applied', kind: 'memory', active: 'mem0' })
    expect(f.confirm).toHaveBeenCalledWith({ kind: 'memory', provider: 'mem0' })
    expect(forwarded(f.forward.mock.calls)).toEqual([
      { path: '/api/memory?profile=default', method: 'GET' },
      { path: '/api/memory?profile=default', method: 'GET' },
      { path: '/api/memory/provider?profile=default', method: 'PUT', body: { provider: 'mem0' } }
    ])
  })

  it('allows built-in empty provider but rejects unavailable/unconfigured, changed, malformed and unsuccessful status/write responses', async () => {
    const builtin = scope([memory(), memory(), { ok: true, active: '' }])
    await expect(
      builtin.scope.request({ path: '/api/memory/provider', method: 'PUT', body: { provider: '' } })
    ).resolves.toMatchObject({ active: '' })

    const unavailable = scope([memory([{ name: 'mem0', configured: true, available: false, status: 'unavailable' }])])
    await expect(
      unavailable.scope.request({ path: '/api/memory/provider', method: 'PUT', body: { provider: 'mem0' } })
    ).rejects.toThrow('matrix_runtime_response_invalid')

    const changesDuringConfirm = scope([
      ready(),
      memory([{ name: 'mem0', configured: true, available: true, status: 'needs_config' }])
    ])

    await expect(
      changesDuringConfirm.scope.request({ path: '/api/memory/provider', method: 'PUT', body: { provider: 'mem0' } })
    ).rejects.toThrow('matrix_runtime_response_invalid')

    const badWrite = scope([ready(), ready(), { ok: true, active: 'other' }])
    await expect(
      badWrite.scope.request({ path: '/api/memory/provider', method: 'PUT', body: { provider: 'mem0' } })
    ).rejects.toThrow('matrix_runtime_response_invalid')
  })

  it('does not write after a cancelled or stale memory confirmation', async () => {
    const cancelled = scope([ready()])
    cancelled.confirm.mockResolvedValue(false)
    await expect(
      cancelled.scope.request({ path: '/api/memory/provider', method: 'PUT', body: { provider: 'mem0' } })
    ).resolves.toEqual({ status: 'cancelled' })
    expect(cancelled.forward).toHaveBeenCalledOnce()

    let current = true
    const stale = scope([ready()], () => current)
    stale.confirm.mockImplementation(async () => {
      current = false

      return true
    })
    await expect(
      stale.scope.request({ path: '/api/memory/provider', method: 'PUT', body: { provider: 'mem0' } })
    ).rejects.toThrow('matrix_pages_agent_unavailable')
  })
})
