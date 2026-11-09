import { describe, expect, it, vi } from 'vitest'

import type { MatrixPagesRequest } from '../../shared/matrix-pages'
import type { MatrixVoiceSettingsConfirmation } from '../../shared/matrix-voice-settings'

import { isMatrixVoiceSettingsRequest, MatrixPagesVoiceSettingsScope } from './pages-voice-settings'

const configPath = '/api/config?profile=default'
const schemaPath = '/api/config/schema?profile=default'

const set = (field = 'tts.openai.voice', value: unknown = 'nova'): MatrixPagesRequest => ({
  path: '/api/voice-settings/set',
  method: 'POST',
  body: { field, value }
})

function fixture() {
  let current = true

  const config = {
    model: { provider: 'keep', default: 'main' },
    stt: { enabled: true, provider: 'local', local: { model: 'base', language: '' } },
    tts: {
      provider: 'openai',
      openai: { model: 'tts-1', voice: 'alloy', api_key: 'private' },
      providers: { office: { command: 'private command' } }
    },
    voice: { max_recording_seconds: 600, auto_tts: true }
  } as Record<string, unknown>

  const schema = {
    fields: {
      'stt.enabled': { type: 'boolean' },
      'stt.provider': { type: 'select', options: ['local', 'openai', 'office'] },
      'tts.provider': { type: 'select', options: ['openai', 'office', '../invalid', 'openai'] },
      'tts.openai.voice': { type: 'string' },
      'voice.max_recording_seconds': { type: 'number' },
      'tts.xai.speed': { type: 'number' },
      'tts.xai.sample_rate': { type: 'number' },
      'tts.xai.optimize_streaming_latency': { type: 'number' },
      'tts.xai.bit_rate': { type: 'number' },
      'tts.openai.api_key': { type: 'string' },
      'tts.providers.office.command': { type: 'string' },
      'voice.auto_tts': { type: 'boolean' }
    }
  } as { fields: Record<string, { type: string; options?: string[] }> }

  const confirm = vi.fn(async (_value: MatrixVoiceSettingsConfirmation) => true)

  const forward = vi.fn(async (request: { path: string; method: string; body?: unknown }): Promise<unknown> => {
    if (request.path === schemaPath) {return structuredClone(schema)}

    if (request.path !== configPath) {throw new Error('unexpected')}

    if (request.method === 'GET') {return structuredClone(config)}
    const nested = (request.body as { config: Record<string, unknown> }).config

    const merge = (target: Record<string, unknown>, incoming: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(incoming)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          if (!target[key] || typeof target[key] !== 'object') {target[key] = {}}
          merge(target[key] as Record<string, unknown>, value as Record<string, unknown>)
        } else {target[key] = value}
      }
    }

    merge(config, nested)

    return { ok: true }
  })

  const scope = new MatrixPagesVoiceSettingsScope({ isCurrent: () => current, forward, confirm })

  return {
    scope,
    config,
    schema,
    forward,
    confirm,
    retire: () => {
      current = false
    }
  }
}

describe('native per-agent voice settings', () => {
  it('projects only editable schema fields, effective recording cap and live provider choices', async () => {
    const f = fixture()
    const result = await f.scope.request({ path: '/api/voice-settings/snapshot' })
    expect(result).toMatchObject({
      fields: expect.arrayContaining([
        { key: 'tts.provider', type: 'select', value: 'openai', options: ['openai', 'office'] },
        { key: 'voice.max_recording_seconds', type: 'number', value: 120, min: 1, max: 120, integer: true }
      ])
    })
    expect(JSON.stringify(result)).not.toMatch(/private|api_key|command|auto_tts/)
    expect(f.forward.mock.calls.map(call => call[0])).toEqual([
      { path: schemaPath, method: 'GET' },
      { path: configPath, method: 'GET' }
    ])
    expect(isMatrixVoiceSettingsRequest('/api/voice-settings/set?profile=other')).toBe(true)
    expect(isMatrixVoiceSettingsRequest('/api/config')).toBe(false)
  })
  it('writes exactly one nested scalar and verifies it without replacing siblings', async () => {
    const f = fixture()
    const before = structuredClone(f.config)
    await expect(f.scope.request(set())).resolves.toEqual({
      status: 'applied',
      field: 'tts.openai.voice',
      value: 'nova'
    })
    expect(f.confirm).toHaveBeenCalledExactlyOnceWith({ field: 'tts.openai.voice', value: 'nova' })
    expect(f.forward.mock.calls.filter(call => call[0].method === 'PUT')).toEqual([
      [{ path: configPath, method: 'PUT', body: { config: { tts: { openai: { voice: 'nova' } } } } }]
    ])
    expect(f.config).toEqual({
      ...before,
      tts: { ...(before.tts as object), openai: { model: 'tts-1', voice: 'nova', api_key: 'private' } }
    })
    expect(f.forward.mock.calls.at(-1)?.[0]).toEqual({ path: configPath, method: 'GET' })
  })
  it('allows choosing a command provider already exposed by Hermes without editing its command', async () => {
    const f = fixture()
    await expect(f.scope.request(set('tts.provider', 'office'))).resolves.toMatchObject({ status: 'applied' })
    expect((f.config.tts as { providers: unknown }).providers).toEqual({ office: { command: 'private command' } })
  })
  it('cancels without mutation and rejects a provider removed during confirmation', async () => {
    const f = fixture()
    f.confirm.mockResolvedValueOnce(false)
    await expect(f.scope.request(set())).resolves.toEqual({ status: 'cancelled' })
    f.confirm.mockImplementation(async () => {
      f.schema.fields['tts.provider'].options = ['office']

      return true
    })
    await expect(f.scope.request(set('tts.provider', 'openai'))).rejects.toThrow('matrix_pages_request_forbidden')
    expect(f.forward.mock.calls.some(call => call[0].method === 'PUT')).toBe(false)
  })
  it('retires confirmation and in-flight responses when the account or executor changes', async () => {
    const f = fixture()
    f.confirm.mockImplementation(async () => {
      f.retire()

      return true
    })
    await expect(f.scope.request(set())).rejects.toThrow('matrix_pages_agent_unavailable')
    expect(f.forward.mock.calls.some(call => call[0].method === 'PUT')).toBe(false)
    const g = fixture()
    const impl = g.forward.getMockImplementation()!
    g.forward.mockImplementation(async request => {
      const response = await impl(request)

      if (request.method === 'PUT') {g.retire()}

      return response
    })
    await expect(g.scope.request(set())).rejects.toThrow('matrix_pages_agent_unavailable')
    expect(g.forward.mock.calls.at(-1)?.[0].method).toBe('PUT')
  })
  it.each([false, true])('never reports applied for an unverified acknowledgement/readback (%s)', async badAck => {
    const f = fixture()
    const impl = f.forward.getMockImplementation()!
    f.forward.mockImplementation(async request =>
      request.method === 'PUT' ? (badAck ? { ok: false } : { ok: true }) : impl(request)
    )
    await expect(f.scope.request(set())).rejects.toThrow('matrix_voice_settings_response_invalid')
  })
  it.each([
    ...[
      'api_key',
      'tts.openai.api_key',
      'tts.openai.base_url',
      'tts.providers.office.command',
      'voice.auto_tts',
      'voice.record_key',
      'tts.neutts.ref_audio',
      '__proto__',
      'constructor',
      'unknown'
    ].map(field => set(field, 'private')),
    { ...set(), path: '/api/voice-settings/set?profile=other' },
    { ...set(), path: '/api/config' },
    { ...set(), method: 'PUT' },
    { ...set(), body: { field: 'tts.openai.voice', value: 'nova', profile: 'other' } },
    { ...set(), body: { field: 'tts.openai.voice', value: 'nova', config: {} } },
    { path: '/api/voice-settings/snapshot', body: {} }
  ])('rejects renderer authority and excluded settings before forwarding %#', async request => {
    const f = fixture()
    await expect(f.scope.request(request as MatrixPagesRequest)).rejects.toThrow('matrix_pages_request_forbidden')
    expect(f.forward).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
  })
  it.each([
    ['stt.enabled', 'false'],
    ['tts.provider', 'unknown'],
    ['voice.max_recording_seconds', 0],
    ['voice.max_recording_seconds', 121],
    ['voice.max_recording_seconds', 2.5],
    ['voice.max_recording_seconds', '20'],
    ['tts.xai.speed', 0.6],
    ['tts.xai.speed', 1.6],
    ['tts.xai.sample_rate', 16000],
    ['tts.xai.optimize_streaming_latency', 2.5],
    ['tts.xai.bit_rate', 0],
    ['tts.openai.voice', 'unsafe\nvalue']
  ])('denies invalid values without confirmation or write (%s)', async (field, value) => {
    const f = fixture()
    await expect(f.scope.request(set(field as string, value))).rejects.toThrow('matrix_pages_request_forbidden')
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.forward.mock.calls.some(call => call[0].method === 'PUT')).toBe(false)
  })
  it('supports boolean, empty auto-language and valid numeric values', async () => {
    const f = fixture()
    f.schema.fields['stt.local.language'] = { type: 'string' }

    for (const [field, value] of [
      ['stt.enabled', false],
      ['stt.local.language', ''],
      ['tts.xai.speed', 1.2],
      ['tts.xai.sample_rate', 24000],
      ['voice.max_recording_seconds', 30]
    ] as const) {
      await expect(f.scope.request(set(field, value))).resolves.toEqual({ status: 'applied', field, value })
    }
  })
  it('serializes writes while native confirmation is pending', async () => {
    const f = fixture()
    let release!: (value: boolean) => void
    f.confirm.mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve
        })
    )
    const first = f.scope.request(set())
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce())
    await expect(f.scope.request(set())).rejects.toThrow('matrix_voice_settings_request_failed')
    release(false)
    await expect(first).resolves.toEqual({ status: 'cancelled' })
  })
  it('reports malformed typed saved values as unknown and redacts upstream errors', async () => {
    const f = fixture()
    f.config.stt = { enabled: 'false', provider: true }
    await expect(f.scope.request({ path: '/api/voice-settings/snapshot' })).resolves.toMatchObject({
      fields: expect.arrayContaining([{ key: 'stt.enabled', type: 'boolean', value: null }])
    })
    f.forward.mockRejectedValue(new Error('https://private?api_key=secret'))
    await expect(f.scope.request(set())).rejects.toThrow('matrix_voice_settings_request_failed')
  })
})
