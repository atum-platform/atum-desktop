import { expect, it, vi } from 'vitest'

import { MatrixPagesCommandCenterScope } from './pages-command-center'

function fixture() {
  let current = true

  const raw = {
    status: {
      version: '0.17.0',
      gateway_running: false,
      active_sessions: 2,
      overall: 'degraded',
      components: {
        gateway: { status: 'degraded' },
        dashboard: { status: 'ok' },
        storage: { status: 'ok' },
        platforms: { status: 'ok' }
      },
      hermes_home: '/private/owner',
      config_path: 'private/config',
      gateway_pid: 123,
      api_key: 'private'
    },
    logs: { file: 'agent', lines: ['hello', 'Authorization: Bearer fixture-secret', 'sk-abcdefghijklmnopqrstu'] },
    usage: {
      period_days: 30,
      totals: { total_sessions: 1, total_api_calls: 2, total_input: 17, total_output: 4, private: 'secret' },
      daily: [{ day: '2026-10-02', input_tokens: 17, output_tokens: 4, secret: 'private' }],
      by_model: [{ model: 'fixture-model', input_tokens: 17, output_tokens: 4, api_key: 'private' }],
      cost: 123
    },
    curator: {
      enabled: false,
      paused: true,
      interval_hours: 24,
      last_run_at: '2026-10-01T00:00:00+00:00',
      private: 'secret'
    }
  }

  const forward = vi.fn(async (request: { path: string }) => {
    if (request.path.startsWith('/api/status?')) {return structuredClone(raw.status)}

    if (request.path.startsWith('/api/logs?')) {return structuredClone(raw.logs)}

    if (request.path.startsWith('/api/analytics/usage?')) {return structuredClone(raw.usage)}

    if (request.path.startsWith('/api/curator?')) {return structuredClone(raw.curator)}
    throw new Error('unexpected')
  })

  const scope = new MatrixPagesCommandCenterScope({ isCurrent: () => current, forward })

  return {
    scope,
    forward,
    raw,
    retire: () => {
      current = false
    }
  }
}

it('projects four existing reads, only the native-selected profile reaches transport', async () => {
  const f = fixture()
  const status = await f.scope.request({ path: '/api/command-center/status' })
  expect(status).toMatchObject({ version: '0.17.0', gatewayRunning: false, activeSessions: 2, overall: 'degraded' })
  expect(JSON.stringify(status)).not.toMatch(/private|config_path|hermes_home|api_key|gateway_pid/)
  expect(await f.scope.request({ path: '/api/command-center/logs?file=agent&level=ALL' })).toEqual({
    file: 'agent',
    lines: ['hello', 'Authorization: Bearer <redacted>', '<redacted>'],
    truncated: false
  })
  expect(await f.scope.request({ path: '/api/command-center/usage?days=30' })).toMatchObject({
    days: 30,
    totals: { sessions: 1, calls: 2, input: 17, output: 4 },
    models: [{ name: 'fixture-model', input: 17, output: 4 }]
  })
  expect(await f.scope.request({ path: '/api/command-center/curator' })).toMatchObject({
    enabled: false,
    paused: true,
    lastRunAt: '2026-10-01T00:00:00+00:00'
  })
  expect(f.forward.mock.calls.map(([value]) => value)).toEqual([
    { path: '/api/status?profile=default', method: 'GET' },
    { path: '/api/logs?file=agent&level=ALL&lines=200&profile=default', method: 'GET' },
    { path: '/api/analytics/usage?days=30&profile=default', method: 'GET' },
    { path: '/api/curator?profile=default', method: 'GET' }
  ])
})
it.each([
  { path: '/api/command-center/status', method: 'POST' },
  { path: '/api/command-center/status', body: {} },
  { path: '/api/command-center/status?profile=other' },
  { path: '/api/command-center/status?' },
  { path: '/api/command-center/logs?file=gui' },
  { path: '/api/command-center/logs?level=DEBUG' },
  { path: '/api/command-center/logs?file=agent&file=errors' },
  { path: '/api/command-center/logs?search=secret' },
  { path: '/api/command-center/logs?lines=1000' },
  { path: '/api/command-center/usage?days=365' },
  { path: '/api/command-center/usage?days=030' },
  { path: '/api/command-center/usage?days=30&profile=other' },
  { path: '/api/command-center/curator/paused' },
  { path: '/api/command-center/doctor' },
  { path: '/api/command-center/../config' },
  { path: '/api/command-center/%73tatus' },
  { path: '/api/command-center/status', headers: { Authorization: 'secret' } }
])('denies renderer authority or unbounded query before forwarding: %j', async value => {
  const f = fixture()
  await expect(f.scope.request(value)).rejects.toThrow('matrix_pages_request_denied')
  expect(f.forward).not.toHaveBeenCalled()
})
it('retirement before or during the read never publishes old data', async () => {
  const before = fixture()
  before.retire()
  await expect(before.scope.request({ path: '/api/command-center/status' })).rejects.toThrow(
    'matrix_pages_agent_unavailable'
  )
  expect(before.forward).not.toHaveBeenCalled()
  const during = fixture()
  during.forward.mockImplementation(async () => {
    during.retire()

    return during.raw.status
  })
  await expect(during.scope.request({ path: '/api/command-center/status' })).rejects.toThrow(
    'matrix_pages_agent_unavailable'
  )
})
it('bounds and redacts log text without publishing paths or raw errors', async () => {
  const f = fixture()
  f.raw.logs.lines = Array.from({ length: 201 }, () => 'x'.repeat(5000))

  const result = (await f.scope.request({ path: '/api/command-center/logs' })) as {
    lines: string[]
    truncated: boolean
  }

  expect(result.lines).toHaveLength(200)
  expect(result.lines.every(line => line.length === 4096)).toBe(true)
  expect(result.truncated).toBe(true)
  f.forward.mockRejectedValue(new Error('https://private?token=secret'))
  await expect(f.scope.request({ path: '/api/command-center/status' })).rejects.toThrow(
    /^matrix_pages_command_center_failed$/
  )
})
it('malformed typed values remain unknown and malformed payloads fail closed', async () => {
  const f = fixture()
  Object.assign(f.raw.status, {
    version: 'private/path',
    gateway_running: 'yes',
    active_sessions: -1,
    overall: 'healthy'
  })
  expect(await f.scope.request({ path: '/api/command-center/status' })).toMatchObject({
    version: null,
    gatewayRunning: null,
    activeSessions: null,
    overall: 'unknown'
  })
  f.raw.usage.period_days = 7
  await expect(f.scope.request({ path: '/api/command-center/usage?days=30' })).rejects.toThrow(
    'matrix_pages_command_center_invalid_response'
  )
  f.forward.mockResolvedValue(null as never)
  await expect(f.scope.request({ path: '/api/command-center/curator' })).rejects.toThrow(
    'matrix_pages_command_center_invalid_response'
  )
})
