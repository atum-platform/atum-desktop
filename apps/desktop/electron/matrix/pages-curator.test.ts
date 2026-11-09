import { expect, it, vi } from 'vitest'

import { MatrixPagesCuratorScope } from './pages-curator'

function fixture(allowed = true) {
  let current = true
  let paused = false
  let running = false
  const confirm = vi.fn(async () => allowed)

  const forward = vi.fn(async (request: { path: string; method: string; body?: unknown }): Promise<unknown> => {
    if (request.path.startsWith('/api/actions/')) {
      return {
        profile_scoped: true,
        name: 'curator-run',
        pid: 99,
        running,
        exit_code: null,
        lines: ['/fixture/home/private.log'],
        archive: '/private/archive'
      }
    }

    if (request.method === 'GET') {
      return {
        profile_scoped: true,
        enabled: true,
        paused,
        consolidate: false,
        interval_hours: 168,
        last_run_at: null,
        secret: 'private-data'
      }
    }

    if (request.method === 'PUT') {
      paused = (request.body as { paused: boolean }).paused

      return { ok: true, profile_scoped: true, paused }
    }

    running = true

    return { ok: true, profile_scoped: true, name: 'curator-run', pid: 99 }
  })

  const scope = new MatrixPagesCuratorScope({ home: '/fixture/home', isCurrent: () => current, forward, confirm })

  return {
    scope,
    forward,
    confirm,
    retire: () => {
      current = false
    }
  }
}

const prefix = '/api/command-center/curator/'

it('reads typed facts only and redacts home without leaking PID, archive or backend extras', async () => {
  const f = fixture()
  const result = await f.scope.request({ path: prefix + 'status', method: 'GET' })
  expect(JSON.stringify(result)).not.toContain('/fixture/home')
  expect(JSON.stringify(result)).not.toContain('private-data')
  expect(JSON.stringify(result)).not.toContain('pid')
  expect(JSON.stringify(result)).not.toContain('archive')
  expect(f.confirm).not.toHaveBeenCalled()
})
it('cancellation reads capability but sends no mutation', async () => {
  const f = fixture(false)
  expect(await f.scope.request({ path: prefix + 'pause', method: 'POST' })).toEqual({ status: 'cancelled' })
  expect(f.forward.mock.calls.every(([r]) => r.method === 'GET')).toBe(true)
})
it('pause/resume uses authoritative readback and run-now retains the existing receipt', async () => {
  const f = fixture()
  await expect(f.scope.request({ path: prefix + 'pause', method: 'POST' })).resolves.toMatchObject({
    status: 'completed',
    value: { paused: true }
  })
  await expect(f.scope.request({ path: prefix + 'resume', method: 'POST' })).resolves.toMatchObject({
    status: 'completed',
    value: { paused: false }
  })
  await f.scope.request({ path: prefix + 'run', method: 'POST' })
  await f.scope.request({ path: prefix + 'run', method: 'POST' })
  expect(f.forward.mock.calls.filter(([r]) => r.method === 'POST')).toEqual([
    [{ path: '/api/curator/run?profile=default', method: 'POST' }]
  ])
})
it.each([
  { path: prefix + 'pause?profile=foreign', method: 'POST' },
  { path: prefix + 'run', method: 'POST', body: { home: '/foreign' } },
  { path: prefix + 'status', method: 'PUT' },
  { path: prefix + 'run', method: 'GET' },
  { path: prefix + '../run', method: 'POST' },
  { path: prefix + 'run', method: 'POST', command: 'rm' }
])('denies renderer authority %j', async request => {
  const f = fixture()
  await expect(f.scope.request(request)).rejects.toThrow('matrix_pages_request_denied')
  expect(f.forward).not.toHaveBeenCalled()
})
it('old unscoped runtime fails before consent or mutation', async () => {
  const f = fixture()
  f.forward.mockResolvedValue({ enabled: true, paused: false })
  await expect(f.scope.request({ path: prefix + 'run', method: 'POST' })).rejects.toThrow('matrix_curator_unavailable')
  expect(f.confirm).not.toHaveBeenCalled()
  expect(f.forward.mock.calls.every(([r]) => r.method === 'GET')).toBe(true)
})
it('late consent and overlapping request cannot release the original mutation fence', async () => {
  const f = fixture()
  let finish!: (v: boolean) => void
  f.confirm.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const first = f.scope.request({ path: prefix + 'pause', method: 'POST' })
  await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce())
  await expect(f.scope.request({ path: prefix + 'run', method: 'POST' })).rejects.toThrow('pages_agent_busy')
  await expect(f.scope.request({ path: prefix + 'resume', method: 'POST' })).rejects.toThrow('pages_agent_busy')
  f.retire()
  finish(true)
  await expect(first).rejects.toThrow('pages_agent_unavailable')
  expect(f.forward.mock.calls.every(([r]) => r.method === 'GET')).toBe(true)
})
it('a lost mutation response is generic and sends no automatic retry', async () => {
  const f = fixture()
  const original = f.forward.getMockImplementation()!
  f.forward.mockImplementation(request =>
    request.method === 'GET' ? original(request) : Promise.reject(new Error('private-secret'))
  )
  await expect(f.scope.request({ path: prefix + 'run', method: 'POST' })).rejects.toThrow('matrix_curator_unavailable')
  expect(f.forward.mock.calls.filter(([r]) => r.method === 'POST')).toHaveLength(1)
})
