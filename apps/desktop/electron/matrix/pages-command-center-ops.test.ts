import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { MatrixPagesCommandCenterOpsScope } from './pages-command-center-ops'

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

function fixture(home = '/private/fixture-agent') {
  let current = true
  let running = false
  let exit: number | null = null
  let archive: string | null = null

  const forward = vi.fn(async (request: { path: string; method: string }): Promise<unknown> => {
    const action = request.path.includes('doctor') ? 'doctor' : 'backup'

    if (request.method === 'POST') {
      running = true

      return { ok: true, name: action, pid: 42, archive: 'private' }
    }

    return {
      name: action,
      profile_scoped: true,
      profile_only: true,
      running,
      exit_code: exit,
      pid: 42,
      archive,
      lines: [
        `saved ${home}`,
        'Authorization: Bearer fixture-secret',
        ...Array.from({ length: 200 }, () => 'x'.repeat(5000))
      ],
      home: 'private',
      api_key: 'private'
    }
  })

  const confirm = vi.fn(async () => true)
  const reveal = vi.fn()
  const scope = new MatrixPagesCommandCenterOpsScope({ home, isCurrent: () => current, forward, confirm, reveal })

  return {
    scope,
    forward,
    confirm,
    reveal,
    setCurrent: (value: boolean) => {
      current = value
    },
    setStatus: (run: boolean, code: number | null, zip: string | null = null) => {
      running = run
      exit = code
      archive = zip
    }
  }
}

const status = '/api/command-center/maintenance/backup/status'
it.each([
  { path: '/api/ops/backup', method: 'POST' },
  { path: status + '?profile=default' },
  { path: status + '?' },
  { path: status + '#x' },
  { path: status, method: 'POST' },
  { path: status, headers: {} },
  { path: '/api/command-center/maintenance/backup/run', method: 'POST', body: {} },
  { path: '/api/command-center/maintenance/security-audit/run', method: 'POST' },
  { path: '/api/command-center/maintenance/backup/%73tatus' },
  { path: 'https://evil.invalid' + status },
  { path: status + '/..' },
  { path: '/api/command-center/maintenance/backup/reveal', method: 'GET' }
])('rejects caller authority before any I/O: %j', async request => {
  const f = fixture()
  await expect(f.scope.request(request)).rejects.toThrow('matrix_pages_request_denied')
  expect(f.forward).not.toHaveBeenCalled()
  expect(f.confirm).not.toHaveBeenCalled()
  expect(f.reveal).not.toHaveBeenCalled()
})
it('cancel defaults to zero backend requests', async () => {
  const f = fixture()
  f.confirm.mockResolvedValue(false)
  expect(await f.scope.request({ path: '/api/command-center/maintenance/doctor/run', method: 'POST' })).toEqual({
    status: 'cancelled'
  })
  expect(f.forward).not.toHaveBeenCalled()
})
it('runs only the fixed action after consent and reuses a live process on later confirmations', async () => {
  const f = fixture()
  const request = { path: '/api/command-center/maintenance/backup/run', method: 'POST' }
  const first = await f.scope.request(request)
  expect(first).toMatchObject({ status: 'started', value: { state: 'running', backupAvailable: false } })
  await f.scope.request(request)
  expect(f.forward.mock.calls.filter(([r]) => r.method === 'POST')).toEqual([
    [{ path: '/api/ops/backup?profile=default', method: 'POST', body: {} }]
  ])
  expect(f.confirm).toHaveBeenCalledTimes(2)
})
it('projects bounded status, drops private fields and distinguishes lost state from success', async () => {
  const f = fixture()
  f.forward.mockResolvedValueOnce({
    name: 'backup',
    profile_scoped: true,
    profile_only: true,
    running: false,
    exit_code: null,
    pid: 77,
    archive: '/private/archive.zip',
    lines: ['Authorization: Bearer fixture-secret', `saved /private/fixture-agent/.env`],
    api_key: 'private'
  })
  expect(await f.scope.request({ path: status })).toEqual({
    action: 'backup',
    state: 'unknown',
    lines: ['Authorization: Bearer <redacted>', 'saved [agent home]/.env'],
    truncated: false,
    backupAvailable: false
  })
  const value = await f.scope.request({ path: status })
  expect(value).toMatchObject({ lines: Array.from({ length: 200 }, () => 'x'.repeat(4096)), truncated: true })
  expect(JSON.stringify(value)).not.toContain('"pid"')
})
it('retires a confirmation when the agent or account changes', async () => {
  const f = fixture()
  f.confirm.mockImplementation(async () => {
    f.setCurrent(false)

    return true
  })
  await expect(f.scope.request({ path: '/api/command-center/maintenance/doctor/run', method: 'POST' })).rejects.toThrow(
    'matrix_pages_agent_unavailable'
  )
  expect(f.forward).not.toHaveBeenCalled()
})
it('rejects double-click while consent is pending and never publishes late status', async () => {
  const f = fixture()
  let approve!: (value: boolean) => void
  f.confirm.mockImplementation(
    () =>
      new Promise(resolve => {
        approve = resolve
      })
  )
  const request = { path: '/api/command-center/maintenance/doctor/run', method: 'POST' }
  const first = f.scope.request(request)
  await expect(f.scope.request(request)).rejects.toThrow('matrix_local_maintenance_busy')
  approve(false)
  await first
  f.forward.mockImplementationOnce(async () => {
    f.setCurrent(false)

    return { name: 'backup', running: false, exit_code: 0, lines: [] }
  })
  await expect(f.scope.request({ path: status })).rejects.toThrow('matrix_pages_agent_unavailable')
})
it.each([
  { profile_scoped: true, name: 'wrong', running: false, exit_code: 0, lines: [] },
  { profile_scoped: true, name: 'backup', running: true, exit_code: 0, lines: [] },
  { profile_scoped: true, name: 'backup', running: false, exit_code: '0', lines: [] }
])('rejects invalid state %j', async raw => {
  const f = fixture()
  f.forward.mockResolvedValueOnce(raw as never)
  await expect(f.scope.request({ path: status })).rejects.toThrow('matrix_local_maintenance_invalid_response')
})
it('rechecks a private completed archive at explicit reveal; denies foreign paths, links and public mode', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'atum-maintenance-'))
  homes.push(home)
  await mkdir(path.join(home, 'backups'))
  const archive = path.join(home, 'backups', 'hermes-backup-2026-10-02-123456-0123abcd.zip')
  await writeFile(archive, Buffer.alloc(24), { mode: 0o600 })
  const f = fixture(home)
  f.setStatus(false, 0, archive)
  expect(await f.scope.request({ path: status })).toMatchObject({ state: 'succeeded', backupAvailable: true })
  expect(f.reveal).not.toHaveBeenCalled()
  await f.scope.request({ path: '/api/command-center/maintenance/backup/reveal', method: 'POST' })
  expect(f.reveal).toHaveBeenCalledExactlyOnceWith(archive)
  await chmod(archive, 0o644)
  await expect(
    f.scope.request({ path: '/api/command-center/maintenance/backup/reveal', method: 'POST' })
  ).rejects.toThrow('matrix_local_backup_unavailable')
  await rm(archive)
  await symlink(path.join(home, 'config.yaml'), archive)
  await writeFile(path.join(home, 'config.yaml'), 'private')
  expect(await f.scope.request({ path: status })).toMatchObject({ backupAvailable: false })
  f.setStatus(false, 0, '/private/foreign.zip')
  expect(await f.scope.request({ path: status })).toMatchObject({ backupAvailable: false })
  expect(f.reveal).toHaveBeenCalledOnce()
})

it('fails closed on an older runtime before launching a profile-insensitive command', async () => {
  const f = fixture()
  f.forward.mockResolvedValueOnce({ name: 'backup', running: false, exit_code: null, lines: [] } as never)
  await expect(f.scope.request({ path: '/api/command-center/maintenance/backup/run', method: 'POST' })).rejects.toThrow(
    'matrix_local_maintenance_invalid_response'
  )
  expect(f.forward.mock.calls.some(([request]) => request.method === 'POST')).toBe(false)
})
