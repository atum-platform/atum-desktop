import { describe, expect, it, vi } from 'vitest'

import type { MatrixComputerUseSnapshot } from '../../shared/matrix-computer-use'

import { createMatrixPagesComputerUseGrantScope, isMatrixComputerUseGrantRequest } from './pages-computer-use-grant'

const START = '/api/tools/computer-use/permissions/grant'
const STATUS = '/api/actions/computer-use-grant/status?profile=default&lines=1'

const action = (overrides: Record<string, unknown> = {}) => ({
  name: 'computer-use-grant',
  running: false,
  pid: null,
  exit_code: null,
  lines: ['private output'],
  ...overrides
})

function fixture() {
  let current = true
  let nextAction: unknown = action()
  let reply: unknown = { ok: true, name: 'computer-use-grant', pid: 123, lines: ['private output'] }

  const status = vi.fn<() => Promise<MatrixComputerUseSnapshot>>().mockResolvedValue({
    platform: 'darwin',
    installed: true,
    ready: null,
    accessibility: null,
    screenRecording: null,
    screenRecordingCapturable: null
  })

  const confirm = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)

  const forward = vi.fn(async (request: { path: string; method: string }) => {
    if (request.path === STATUS && request.method === 'GET') {return nextAction}

    if (request.path === START + '?profile=default' && request.method === 'POST') {return reply}
    throw new Error('Unexpected upstream authority')
  })

  const deps = { platform: 'darwin', isCurrent: () => current, status, confirm, forward }
  const scope = createMatrixPagesComputerUseGrantScope(deps)

  return {
    scope,
    deps,
    status,
    confirm,
    forward,
    retire: () => {
      current = false
    },
    action: (value: unknown) => {
      nextAction = value
    },
    reply: (value: unknown) => {
      reply = value
    },
    start: () => scope.request({ path: START, method: 'POST' }),
    poll: (id: string) => scope.request({ path: START + 's/' + id, method: 'GET' })
  }
}

async function issued(f: ReturnType<typeof fixture>) {
  const start = await f.start()
  expect(start.status).toBe('started')

  if (start.status !== 'started') {throw new Error('Start expected')}
  expect(start.operationId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  expect(Object.keys(start)).toEqual(['status', 'operationId'])

  return start.operationId
}

describe('native-confirmed CuaDriver grant admission', () => {
  it('keeps grant IPC separate from passive and generic action authority', () => {
    expect(isMatrixComputerUseGrantRequest(START)).toBe(true)
    expect(isMatrixComputerUseGrantRequest(START + 's/opaque')).toBe(true)
    expect(isMatrixComputerUseGrantRequest('/api/tools/computer-use/status')).toBe(false)
    expect(isMatrixComputerUseGrantRequest('/api/actions/computer-use-grant/status')).toBe(false)
  })
  it.each([
    { path: START },
    { path: START, method: 'GET' },
    { path: START + '?profile=default', method: 'POST' },
    { path: START, method: 'POST', body: undefined },
    { path: START, method: 'POST', body: {} },
    { path: START, method: 'POST', confirm: true },
    { path: START, method: 'POST', profile: 'other' },
    { path: START, method: 'POST', pid: 123 },
    { path: START + '/', method: 'POST' },
    { path: '/api/actions/computer-use-grant/status', method: 'GET' },
    { path: START + 's/opaque?lines=200', method: 'GET' },
    { path: START + 's/opaque/extra', method: 'GET' },
    { path: START + 's/opaque', method: 'DELETE' }
  ])('refuses expanded request authority %# before any native work', async value => {
    const f = fixture()
    await expect(f.scope.request(value as never)).rejects.toThrow('matrix_pages_request_forbidden')
    expect(f.status).not.toHaveBeenCalled()
    expect(f.forward).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
  })
  it.each(['garbage', 'computer-use-grant', '123', '00000000-0000-4000-8000-af16785cab34'])(
    'never reads an unissued operation %s',
    async id => {
      const f = fixture()
      await expect(f.poll(id)).resolves.toEqual({ status: 'unknown' })
      expect(f.forward).not.toHaveBeenCalled()
    }
  )
  it.each(['unsupported', 'not-installed', 'busy', 'unknown', 'retired'] as const)(
    'refuses %s before prompting',
    async reason => {
      const f = fixture()

      if (reason === 'unsupported') {f.deps.platform = 'linux'}

      if (reason === 'not-installed') {f.status.mockResolvedValue({ platform: 'darwin', installed: false } as never)}

      if (reason === 'busy') {f.action(action({ running: true, pid: 77 }))}

      if (reason === 'unknown') {f.action({})}

      if (reason === 'retired') {f.retire()}
      expect(await f.start()).toEqual(
        reason === 'unknown' || reason === 'retired' ? { status: 'unknown' } : { status: 'blocked', reason }
      )
      expect(f.confirm).not.toHaveBeenCalled()
      expect(f.forward.mock.calls.some(([value]) => value.method === 'POST')).toBe(false)
    }
  )
  it('requires fresh checks on both sides of consent and performs exactly one fixed POST', async () => {
    const f = fixture()
    await issued(f)
    expect(f.status).toHaveBeenCalledTimes(2)
    expect(f.confirm).toHaveBeenCalledOnce()
    expect(f.forward.mock.calls.map(([value]) => value)).toEqual([
      { path: STATUS, method: 'GET' },
      { path: STATUS, method: 'GET' },
      { path: START + '?profile=default', method: 'POST' }
    ])
  })
  it.each(['cancel', 'retire', 'uninstall', 'busy'] as const)(
    'does not POST when %s happens during native confirmation',
    async change => {
      const f = fixture()
      f.confirm.mockImplementation(async () => {
        if (change === 'retire') {f.retire()}

        if (change === 'uninstall') {f.status.mockResolvedValue({ platform: 'darwin', installed: false } as never)}

        if (change === 'busy') {f.action(action({ running: true, pid: 66 }))}

        return change !== 'cancel'
      })
      expect(await f.start()).toEqual(
        change === 'cancel' || change === 'retire'
          ? { status: 'cancelled' }
          : { status: 'blocked', reason: change === 'uninstall' ? 'not-installed' : 'busy' }
      )
      expect(f.forward.mock.calls.some(([value]) => value.method === 'POST')).toBe(false)
    }
  )
  it('blocks an overlapping start while consent is pending', async () => {
    const f = fixture()
    let resolve!: (value: boolean) => void
    f.confirm.mockImplementation(
      () =>
        new Promise(next => {
          resolve = next
        })
    )
    const pending = f.start()
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce())
    expect(await f.start()).toEqual({ status: 'blocked', reason: 'busy' })
    resolve(false)
    expect(await pending).toEqual({ status: 'cancelled' })
  })
  it.each([
    null,
    {},
    { ok: true, name: 'foreign', pid: 123 },
    { ok: false, name: 'computer-use-grant', pid: 123 },
    { ok: true, name: 'computer-use-grant', pid: 0 },
    { ok: true, name: 'computer-use-grant', pid: '123' }
  ])('does not issue or retry after a malformed/lost start %#', async reply => {
    const f = fixture()
    f.reply(reply)
    expect(await f.start()).toEqual({ status: 'unknown' })
    expect(f.forward.mock.calls.filter(([value]) => value.method === 'POST')).toHaveLength(1)
  })
  it('redacts a lost POST, maps only typed busy, and discards a late retired start', async () => {
    for (const error of ['private token=secret', 'pages_agent_busy']) {
      const f = fixture()
      f.forward.mockImplementation(async value => {
        if (value.method === 'POST') {throw new Error(error)}

        return action()
      })
      expect(await f.start()).toEqual(
        error === 'pages_agent_busy' ? { status: 'blocked', reason: 'busy' } : { status: 'unknown' }
      )
    }

    const f = fixture()
    f.forward.mockImplementation(async value => {
      if (value.method === 'POST') {
        f.retire()

        return { ok: true, name: 'computer-use-grant', pid: 123 }
      }

      return action()
    })
    expect(await f.start()).toEqual({ status: 'unknown' })
  })
})

describe('issued grant original PID custody', () => {
  it('coalesces overlapping IPC reads so a terminal outcome cannot regress', async () => {
    const f = fixture()
    const id = await issued(f)
    let resolve!: (value: unknown) => void
    f.forward.mockImplementationOnce(() => new Promise(next => { resolve = next }))
    const before = f.forward.mock.calls.length
    const first = f.poll(id)
    const second = f.poll(id)
    expect(f.forward).toHaveBeenCalledTimes(before + 1)
    resolve(action({ pid: 123, exit_code: 0 }))
    expect(await first).toEqual({ status: 'completed' })
    expect(await second).toEqual({ status: 'completed' })
    expect(await f.poll(id)).toEqual({ status: 'completed' })
    expect(f.forward).toHaveBeenCalledTimes(before + 1)
  })

  it('projects only a matching running process, then freezes completion without granting anything', async () => {
    const f = fixture()
    const id = await issued(f)
    f.action(action({ running: true, pid: 123 }))
    expect(await f.poll(id)).toEqual({ status: 'running' })
    f.action(action({ pid: 123, exit_code: 0 }))
    expect(await f.poll(id)).toEqual({ status: 'completed' })
    const calls = f.forward.mock.calls.length
    f.action(action({ pid: 999, exit_code: 2 }))
    expect(await f.poll(id)).toEqual({ status: 'completed' })
    expect(f.forward).toHaveBeenCalledTimes(calls)
    f.retire()
    expect(await f.poll(id)).toEqual({ status: 'unknown' })
  })
  it.each([2, -15])('projects a matching nonzero exit %s as process failure', async code => {
    const f = fixture()
    const id = await issued(f)
    f.action(action({ pid: 123, exit_code: code }))
    expect(await f.poll(id)).toEqual({ status: 'failed' })
  })
  it.each([
    action(),
    action({ pid: 999, exit_code: 0 }),
    action({ running: true, pid: 999 }),
    action({ name: 'foreign', pid: 123, exit_code: 0 }),
    action({ running: 'false', pid: 123, exit_code: 0 }),
    action({ running: true, pid: 123, exit_code: 0 }),
    action({ pid: 123, exit_code: null }),
    action({ pid: '123', exit_code: 0 }),
    action({ pid: 123, exit_code: '0' }),
    null
  ])('freezes malformed/missing/foreign status %# as unknown instead of adopting it', async response => {
    const f = fixture()
    const id = await issued(f)
    f.action(response)
    expect(await f.poll(id)).toEqual({ status: 'unknown' })
    f.action(action({ pid: 123, exit_code: 0 }))
    expect(await f.poll(id)).toEqual({ status: 'unknown' })
  })
  it('redacts failed or late retired operation reads', async () => {
    const f = fixture()
    const id = await issued(f)
    f.forward.mockRejectedValueOnce(new Error('private log'))
    expect(await f.poll(id)).toEqual({ status: 'unknown' })
    const g = fixture()
    const other = await issued(g)
    g.forward.mockImplementationOnce(async () => {
      g.retire()

      return action({ pid: 123, exit_code: 0 })
    })
    expect(await g.poll(other)).toEqual({ status: 'unknown' })
  })
})
