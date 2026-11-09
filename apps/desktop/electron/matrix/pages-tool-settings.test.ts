import { describe, expect, it, vi } from 'vitest'

import type { MatrixPagesRequest } from '../../shared/matrix-pages'
import type { MatrixToolSettingsConfirmation } from '../../shared/matrix-tool-settings'

import { isMatrixToolSettingsRequest, MatrixPagesToolSettingsScope } from './pages-tool-settings'
const CONFIG = '/api/config?profile=default'
const SCHEMA = '/api/config/schema?profile=default'
const BACKENDS = '/api/tools/terminal/backends?profile=default'
const SET = '/api/tools/terminal/backend?profile=default'

const request = (field = 'terminal.backend', value: unknown = 'docker'): MatrixPagesRequest => ({
  path: '/api/tool-settings/set',
  method: 'POST',
  body: { field, value }
})

function fixture() {
  let current = true

  const config = {
    model: { default: 'main', api_key: 'private' },
    terminal: { backend: 'local', cwd: 'private/path', docker_volumes: ['private'], env_passthrough: ['PRIVATE'] },
    computer_use: { max_image_dimension: 1456, capture_after_mode: 'som', cua_telemetry: false, no_overlay: null }
  }

  const schema = {
    fields: {
      'computer_use.max_image_dimension': { type: 'number' },
      'computer_use.capture_after_mode': { type: 'string' }
    }
  } as { fields: Record<string, { type: string }> }

  const rows = [
    { name: 'local', status: 'ready', detail: 'private' },
    { name: 'docker', status: 'needs_setup', description: 'private' },
    { name: 'ssh', status: 'unavailable', detail: 'private@host' }
  ]

  const confirm = vi.fn(async (_value: MatrixToolSettingsConfirmation) => true)

  const forward = vi.fn(async (value: { path: string; method: string; body?: unknown }): Promise<unknown> => {
    if (value.path === SCHEMA) {return structuredClone(schema)}

    if (value.path === BACKENDS) {return { active: config.terminal.backend, backends: structuredClone(rows) }}

    if (value.path === SET) {
      config.terminal.backend = (value.body as { backend: string }).backend

      return { ok: true, backend: config.terminal.backend }
    }

    if (value.path === CONFIG && value.method === 'PUT') {
      Object.assign(config.computer_use, (value.body as { config: { computer_use: object } }).config.computer_use)

      return { ok: true }
    }

    if (value.path === CONFIG) {return structuredClone(config)}
    throw new Error('unexpected')
  })

  const scope = new MatrixPagesToolSettingsScope({ isCurrent: () => current, forward, confirm })

  return {
    scope,
    forward,
    confirm,
    config,
    schema,
    rows,
    retire: () => {
      current = false
    }
  }
}

describe('native three-field tool-settings authority', () => {
  it('projects configured facts and closed backend health without paths or credentials', async () => {
    const f = fixture()
    expect(await f.scope.request({ path: '/api/tool-settings/snapshot' })).toEqual({
      configuredBackend: 'local',
      backends: [
        { id: 'local', status: 'ready' },
        { id: 'docker', status: 'needs_setup' },
        { id: 'ssh', status: 'unavailable' }
      ],
      capture: { maxImageDimension: 1456, mode: 'som', dimensionEditable: true, modeEditable: true }
    })
    expect(isMatrixToolSettingsRequest('/api/tool-settings/set?profile=other')).toBe(true)
    expect(isMatrixToolSettingsRequest('/api/tools/terminal/backend')).toBe(false)
    expect(f.forward.mock.calls.map(call => call[0])).toEqual([
      { path: BACKENDS, method: 'GET' },
      { path: SCHEMA, method: 'GET' },
      { path: CONFIG, method: 'GET' }
    ])
  })
  it('persists exactly one backend via the existing endpoint after native Allow and exact readback', async () => {
    const f = fixture()
    const before = structuredClone(f.config)
    await expect(f.scope.request(request())).resolves.toEqual({
      status: 'applied',
      field: 'terminal.backend',
      value: 'docker'
    })
    expect(f.confirm).toHaveBeenCalledExactlyOnceWith({ field: 'terminal.backend', value: 'docker' })
    expect(f.forward.mock.calls.filter(call => call[0].method === 'PUT')).toEqual([
      [{ path: SET, method: 'PUT', body: { backend: 'docker' } }]
    ])
    expect(f.config).toEqual({ ...before, terminal: { ...before.terminal, backend: 'docker' } })
    expect(f.forward.mock.calls.at(-1)?.[0]).toEqual({ path: CONFIG, method: 'GET' })
  })
  it.each([
    ['computer_use.max_image_dimension', 0],
    ['computer_use.max_image_dimension', 4096],
    ['computer_use.capture_after_mode', 'ax']
  ])('writes only the selected Cua leaf (%s)', async (field, value) => {
    const f = fixture()
    const before = structuredClone(f.config)
    await expect(f.scope.request(request(field as string, value))).resolves.toEqual({ status: 'applied', field, value })
    expect(f.forward.mock.calls.filter(call => call[0].method === 'PUT')).toEqual([
      [
        {
          path: CONFIG,
          method: 'PUT',
          body: { config: { computer_use: { [(field as string).split('.')[1]]: value } } }
        }
      ]
    ])
    expect(f.config.terminal).toEqual(before.terminal)
    expect(f.config.model).toEqual(before.model)
    expect(f.config.computer_use.cua_telemetry).toBe(false)
    expect(f.config.computer_use.no_overlay).toBeNull()
  })
  it('cancels before a write and revalidates capabilities after Allow', async () => {
    const f = fixture()
    f.confirm.mockResolvedValueOnce(false)
    await expect(f.scope.request(request())).resolves.toEqual({ status: 'cancelled' })
    f.confirm.mockImplementation(async () => {
      f.rows.splice(1, 1)

      return true
    })
    await expect(f.scope.request(request())).rejects.toThrow('matrix_pages_request_forbidden')
    expect(f.forward.mock.calls.some(call => call[0].method === 'PUT')).toBe(false)
  })
  it('retires an Allow dialog or write response after account/executor handoff', async () => {
    const f = fixture()
    f.confirm.mockImplementation(async () => {
      f.retire()

      return true
    })
    await expect(f.scope.request(request())).rejects.toThrow('matrix_pages_agent_unavailable')
    expect(f.forward.mock.calls.some(call => call[0].method === 'PUT')).toBe(false)
    const g = fixture()
    const impl = g.forward.getMockImplementation()!
    g.forward.mockImplementation(async value => {
      const result = await impl(value)

      if (value.method === 'PUT') {g.retire()}

      return result
    })
    await expect(g.scope.request(request())).rejects.toThrow('matrix_pages_agent_unavailable')
    expect(g.forward.mock.calls.at(-1)?.[0].method).toBe('PUT')
  })
  it.each([false, true])('requires exact acknowledgement and config readback (%s)', async badAck => {
    const f = fixture()
    const impl = f.forward.getMockImplementation()!
    f.forward.mockImplementation(async value =>
      value.method === 'PUT' ? (badAck ? { ok: true, backend: 'ssh' } : { ok: true, backend: 'docker' }) : impl(value)
    )
    await expect(f.scope.request(request())).rejects.toThrow('matrix_tool_settings_response_invalid')
  })
  it.each([
    ...[
      'computer_use.cua_telemetry',
      'computer_use.no_overlay',
      'terminal.cwd',
      'terminal.timeout',
      'terminal.ssh_host',
      'terminal.docker_volumes',
      'terminal.env_passthrough',
      'terminal.docker_network',
      'toolsets',
      'security',
      '__proto__',
      'constructor'
    ].map(field => request(field, 'private')),
    { ...request(), path: '/api/tool-settings/set?profile=other' },
    { ...request(), path: '/api/config' },
    { ...request(), method: 'PUT' },
    { ...request(), body: { field: 'terminal.backend', value: 'docker', profile: 'other' } },
    { ...request(), body: { field: 'terminal.backend', value: 'docker', config: {} } },
    { path: '/api/tool-settings/snapshot', body: {} }
  ])('rejects extra authority and excluded fields before forwarding %#', async value => {
    const f = fixture()
    await expect(f.scope.request(value as MatrixPagesRequest)).rejects.toThrow('matrix_pages_request_forbidden')
    expect(f.forward).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
  })
  it.each([
    ['terminal.backend', 'unknown'],
    ['terminal.backend', 'DOCKER'],
    ['computer_use.max_image_dimension', -1],
    ['computer_use.max_image_dimension', 0.5],
    ['computer_use.max_image_dimension', 4097],
    ['computer_use.max_image_dimension', '1456'],
    ['computer_use.capture_after_mode', 'unknown']
  ])('rejects invalid values before confirmation (%s)', async (field, value) => {
    const f = fixture()
    await expect(f.scope.request(request(field as string, value))).rejects.toThrow('matrix_pages_request_forbidden')
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.forward.mock.calls.some(call => call[0].method === 'PUT')).toBe(false)
  })
  it('keeps unsupported schema settings absent and denies their writes', async () => {
    const f = fixture()
    delete f.schema.fields['computer_use.max_image_dimension']
    await expect(f.scope.request({ path: '/api/tool-settings/snapshot' })).resolves.toMatchObject({
      capture: { dimensionEditable: false }
    })
    await expect(f.scope.request(request('computer_use.max_image_dimension', 512))).rejects.toThrow(
      'matrix_pages_request_forbidden'
    )
  })
  it('fails closed on malformed catalogs and hides raw upstream errors', async () => {
    const f = fixture()
    f.rows.push({ ...f.rows[0] })
    await expect(f.scope.request({ path: '/api/tool-settings/snapshot' })).rejects.toThrow(
      'matrix_tool_settings_response_invalid'
    )
    f.forward.mockRejectedValue(new Error('https://private?api_key=secret'))
    await expect(f.scope.request(request())).rejects.toThrow('matrix_tool_settings_request_failed')
  })
  it('serializes writes while an Allow dialog is open', async () => {
    const f = fixture()
    let release!: (value: boolean) => void
    f.confirm.mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve
        })
    )
    const first = f.scope.request(request())
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce())
    await expect(f.scope.request(request())).rejects.toThrow('matrix_tool_settings_request_failed')
    release(false)
    await expect(first).resolves.toEqual({ status: 'cancelled' })
  })
})
