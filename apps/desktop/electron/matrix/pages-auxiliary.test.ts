import { describe, expect, it, vi } from 'vitest'

import { MATRIX_AUXILIARY_TASKS } from '../../shared/matrix-auxiliary-settings'
import type { MatrixAuxiliaryAssignment, MatrixAuxiliaryConfirmation } from '../../shared/matrix-auxiliary-settings'

import { isMatrixAuxiliaryRequest, MatrixPagesAuxiliaryScope } from './pages-auxiliary'

const readPath = '/api/model/auxiliary?profile=default'
const optionsPath = '/api/model/options?explicit_only=1&read_only=1&profile=default'
const setPath = '/api/model/set?profile=default'
const pin = { task: 'vision', provider: 'openrouter', model: 'model-next' } as const
const request = { path: '/api/auxiliary-settings/set', method: 'POST', body: pin } as const

function fixture() {
  let current = true
  let failReadback = false
  let expensive = false
  const rows: MatrixAuxiliaryAssignment[] = MATRIX_AUXILIARY_TASKS.map(task => ({ task, provider: 'auto', model: '' }))

  const catalog = {
    providers: [
      {
        slug: 'openrouter',
        authenticated: true,
        is_current: false,
        models: ['model-next', 'blocked', 'model-next'],
        unavailable_models: ['blocked'],
        api_key: 'private'
      },
      { slug: 'openai', authenticated: false, models: ['unconfigured'] },
      { slug: 'nous', authenticated: true, models: ['no-nous'] },
      { slug: 'custom', authenticated: true, models: ['no-custom'] },
      { slug: 'custom:office', authenticated: true, models: ['no-office'] },
      { slug: 'local', authenticated: true, models: ['no-local'] }
    ]
  }

  const confirm = vi.fn(async (_request: MatrixAuxiliaryConfirmation) => true)

  const forward = vi.fn(async (value: { path: string; method: string; body?: unknown }): Promise<unknown> => {
    if (value.path === optionsPath) {
      return catalog
    }

    if (value.path === readPath) {
      return {
        tasks: rows.map(row => ({ ...row, base_url: 'https://private', model: failReadback ? 'mismatch' : row.model })),
        main: { api_key: 'private' }
      }
    }

    if (value.path === setPath) {
      const body = value.body as typeof pin & { confirm_expensive_model?: boolean }

      if (expensive && !body.confirm_expensive_model) {
        return {
          ok: false,
          scope: 'auxiliary',
          provider: body.provider,
          model: body.model,
          confirm_required: true,
          confirm_message: 'private upstream text'
        }
      }

      Object.assign(rows.find(row => row.task === body.task)!, { provider: body.provider, model: body.model })

      return { ok: true, scope: 'auxiliary', tasks: [body.task], provider: body.provider, model: body.model }
    }

    throw new Error('unexpected forward')
  })

  const scope = new MatrixPagesAuxiliaryScope({ isCurrent: () => current, confirm, forward })

  return {
    scope,
    confirm,
    forward,
    catalog,
    rows,
    setCurrent: (value: boolean) => {
      current = value
    },
    failReadback: () => {
      failReadback = true
    },
    expensive: () => {
      expensive = true
    }
  }
}

describe('native auxiliary model authority', () => {
  it('projects fixed task facts and only usable catalogs with exact selected-home reads', async () => {
    const f = fixture()
    const value = await f.scope.request({ path: '/api/auxiliary-settings/snapshot' })
    expect(value).toEqual({ tasks: f.rows, providers: [{ id: 'openrouter', models: ['model-next'] }] })
    expect(JSON.stringify(value)).not.toMatch(/private|base_url|api_key/)
    expect(f.forward.mock.calls.map(call => call[0])).toEqual([
      { path: readPath, method: 'GET' },
      { path: optionsPath, method: 'GET' }
    ])
    expect(isMatrixAuxiliaryRequest('/api/auxiliary-settings/snapshot?profile=other')).toBe(true)
    expect(isMatrixAuxiliaryRequest('/api/model/auxiliary')).toBe(false)
  })
  it('pins exactly one task across providers after native confirmation and readback', async () => {
    const f = fixture()
    await expect(f.scope.request(request)).resolves.toEqual({ status: 'applied', ...pin })
    expect(f.confirm).toHaveBeenCalledExactlyOnceWith({ ...pin, kind: 'pin' })
    expect(f.forward.mock.calls.filter(call => call[0].method === 'POST')).toEqual([
      [{ path: setPath, method: 'POST', body: { scope: 'auxiliary', ...pin } }]
    ])
    expect(f.rows.filter(row => row.task !== 'vision').every(row => row.provider === 'auto')).toBe(true)
    expect(f.forward.mock.calls.at(-1)?.[0].path).toBe(readPath)
  })
  it('returns a task to automatic without requiring any configured provider', async () => {
    const f = fixture()
    f.catalog.providers = []
    f.rows[0] = { task: 'vision', provider: 'custom', model: 'old' }
    await expect(
      f.scope.request({ ...request, body: { task: 'vision', provider: 'auto', model: '' } })
    ).resolves.toEqual({ status: 'applied', task: 'vision', provider: 'auto', model: '' })
    expect(f.forward.mock.calls.some(call => call[0].path === optionsPath)).toBe(false)
  })
  it('cancels without any write and rechecks catalog after a dialog', async () => {
    const f = fixture()
    f.confirm.mockResolvedValue(false)
    await expect(f.scope.request(request)).resolves.toEqual({ status: 'cancelled' })
    expect(f.forward.mock.calls.some(call => call[0].method === 'POST')).toBe(false)
    f.confirm.mockImplementation(async () => {
      f.catalog.providers[0].models = []

      return true
    })
    await expect(f.scope.request(request)).rejects.toThrow('matrix_auxiliary_response_invalid')
    expect(f.forward.mock.calls.some(call => call[0].method === 'POST')).toBe(false)
  })
  it('challenges expensive models, confirms natively and rechecks before the sole flagged retry', async () => {
    const f = fixture()
    f.expensive()
    await expect(f.scope.request(request)).resolves.toEqual({ status: 'applied', ...pin })
    expect(f.confirm.mock.calls.map(call => call[0])).toEqual([
      { ...pin, kind: 'pin' },
      { ...pin, kind: 'expensive-model' }
    ])
    expect(f.forward.mock.calls.filter(call => call[0].path === optionsPath)).toHaveLength(3)
    expect(f.forward.mock.calls.filter(call => call[0].method === 'POST').map(call => call[0].body)).toEqual([
      { scope: 'auxiliary', ...pin },
      { scope: 'auxiliary', ...pin, confirm_expensive_model: true }
    ])
  })
  it('does not retry an expensive choice if its fresh catalog no longer permits it', async () => {
    const f = fixture()
    f.expensive()
    f.confirm
      .mockImplementationOnce(async () => true)
      .mockImplementationOnce(async () => {
        f.catalog.providers[0].authenticated = false

        return true
      })
    await expect(f.scope.request(request)).rejects.toThrow('matrix_auxiliary_response_invalid')
    expect(f.forward.mock.calls.filter(call => call[0].method === 'POST')).toHaveLength(1)
  })
  it('retires a pending confirmation when account/executor authority changes', async () => {
    const f = fixture()
    f.confirm.mockImplementation(async () => {
      f.setCurrent(false)

      return true
    })
    await expect(f.scope.request(request)).rejects.toThrow('matrix_pages_agent_unavailable')
    expect(f.forward.mock.calls.some(call => call[0].method === 'POST')).toBe(false)
  })
  it('does not report applied when authority disappears during readback', async () => {
    const f = fixture()
    const implementation = f.forward.getMockImplementation()!
    f.forward.mockImplementation(async value => {
      const result = await implementation(value)

      if (value.path === readPath) {f.setCurrent(false)}

      return result
    })
    await expect(f.scope.request(request)).rejects.toThrow('matrix_pages_agent_unavailable')
    expect(f.forward.mock.calls.filter(call => call[0].method === 'POST')).toHaveLength(1)
  })
  it('cancels the expensive challenge without the flagged retry', async () => {
    const f = fixture()
    f.expensive()
    f.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await expect(f.scope.request(request)).resolves.toEqual({ status: 'cancelled' })
    expect(f.forward.mock.calls.filter(call => call[0].method === 'POST')).toHaveLength(1)
  })
  it('rejects mismatching readback instead of claiming success', async () => {
    const f = fixture()
    f.failReadback()
    await expect(f.scope.request(request)).rejects.toThrow('matrix_auxiliary_response_invalid')
  })
  it('redacts raw transport exceptions', async () => {
    const f = fixture()
    f.forward.mockRejectedValue(new Error('https://private?api_key=do-not-print'))
    await expect(f.scope.request(request)).rejects.toThrow('matrix_auxiliary_request_failed')
  })
  it.each([
    { ...request, path: '/api/auxiliary-settings/set?profile=other' },
    { ...request, path: '/api/model/set' },
    { ...request, body: { ...pin, task: '' } },
    { ...request, body: { ...pin, task: '__reset__' } },
    { ...request, body: { ...pin, task: 'unknown' } },
    { ...request, body: { ...pin, scope: 'auxiliary' } },
    { ...request, body: { ...pin, profile: 'other' } },
    { ...request, body: { ...pin, base_url: 'https://private' } },
    { ...request, body: { ...pin, api_key: 'private' } },
    { ...request, body: { ...pin, confirm_expensive_model: true } },
    ...['nous', 'custom', 'local', 'custom:office'].map(provider => ({ ...request, body: { ...pin, provider } })),
    { ...request, body: { ...pin, provider: 'auto', model: 'pinned' } },
    { path: '/api/auxiliary-settings/snapshot', body: {} }
  ])('rejects renderer-selected authority without forwarding %#', async value => {
    const f = fixture()
    await expect(f.scope.request(value as never)).rejects.toThrow('matrix_pages_request_forbidden')
    expect(f.forward).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
  })
  it('denies unavailable catalog models without a write', async () => {
    const f = fixture()
    await expect(f.scope.request({ ...request, body: { ...pin, model: 'blocked' } })).rejects.toThrow(
      'matrix_auxiliary_response_invalid'
    )
    expect(f.confirm).not.toHaveBeenCalled()
  })
  it('fails closed on malformed, duplicated or missing task snapshots', async () => {
    for (const value of [null, { tasks: [] }, { tasks: [frozenRow(), frozenRow()] }]) {
      const forward = vi.fn(async () => value)
      const scope = new MatrixPagesAuxiliaryScope({ isCurrent: () => true, forward, confirm: () => true })
      await expect(scope.request({ path: '/api/auxiliary-settings/snapshot' })).rejects.toThrow(
        'matrix_auxiliary_response_invalid'
      )
    }
  })
  it('serializes mutations while a native confirmation is open', async () => {
    const f = fixture()
    let release!: (value: boolean) => void
    f.confirm.mockImplementation(
      () =>
        new Promise<boolean>(resolve => {
          release = resolve
        })
    )
    const first = f.scope.request(request)
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce())
    await expect(f.scope.request(request)).rejects.toThrow('matrix_auxiliary_request_failed')
    release(false)
    await expect(first).resolves.toEqual({ status: 'cancelled' })
  })
})

function frozenRow() {
  return { task: 'vision', provider: 'auto', model: '' }
}
