import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentMigration, type AgentMigrationDeps, exportAgentHome, migrationConfirmCopy } from './migration'

const repo = path.resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function temp(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  directories.push(directory)

  return directory
}

function memoryStore() {
  const values = new Map<string, string>()

  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    failureCode: () => null
  }
}

function migration(overrides: Partial<AgentMigrationDeps> = {}) {
  const order: string[] = []
  const store = memoryStore()
  const home = temp('atum-agent-home-')
  writeFileSync(path.join(home, 'SOUL.md'), 'T')

  const deps: AgentMigrationDeps = {
    agentPrincipal: '00000000-0000-4000-8000-159badba71cd',
    agentName: 'T',
    writers: () => ({ executor: true, cron: true, lease: true, listening: false, gateways: [] }),
    quiesce: vi.fn(async () => void order.push('quiesce')),
    restore: vi.fn(async () => void order.push('restore')),
    hermesHome: () => home,
    exportHome: vi.fn(async (_home: string, archive: string) => {
      order.push('export')
      writeFileSync(archive, 'archive bytes', { mode: 0o600 })

      return { files: 3, bytes: 13 }
    }),
    beginCloudEnrollment: vi.fn(async () => {
      order.push('cloud_enrollment')

      return { enrollmentId: '00000000-0000-4000-8000-576f18824476', created: true }
    }),
    waitCloudEnrollment: vi.fn(async () => {}),
    revokeCloudEnrollment: vi.fn(async () => void order.push('revoke_cloud_enrollment')),
    confirm: vi.fn(async () => {
      order.push('confirm')

      return true
    }),
    switchToCloud: vi.fn(async () => void order.push('switch')),
    stagingDir: path.join(temp('atum-device-'), 'migration'),
    store,
    log: () => {},
    ...overrides
  }

  return { subject: new AgentMigration(deps), deps, order, store }
}

describe('moving an agent to the cloud', () => {
  it('quiesces, snapshots, gets a trusted cloud enrollment, asks the owner, then switches', async () => {
    const { subject, deps, order } = migration()

    const outcome = await subject.run(new AbortController().signal)

    expect(order).toEqual(['quiesce', 'export', 'cloud_enrollment', 'confirm', 'switch'])
    expect(outcome).toMatchObject({ state: 'moved', staged: false })

    const snapshot = outcome.state === 'moved' ? outcome.snapshot! : null
    expect(snapshot).toMatchObject({ files: 3, bytes: 13 })
    expect(snapshot!.sha256).toBe(createHash('sha256').update('archive bytes').digest('hex'))
    expect(path.dirname(snapshot!.archive)).toBe(deps.stagingDir)
    expect(statSync(deps.stagingDir).mode & 0o777).toBe(0o700)

    // The owner was told what writes the agent here and that its snapshot stays on this Mac.
    expect(vi.mocked(deps.confirm).mock.calls[0]![0]).toMatchObject({
      agentName: 'T',
      writers: { executor: true, cron: true, lease: true },
      staged: false
    })
    expect(subject.last()).toMatchObject({ step: 'done', outcome: 'moved' })
    expect(deps.restore).not.toHaveBeenCalled()
  })

  it('hands the snapshot to the cloud when a staging channel exists', async () => {
    const stage = vi.fn(async () => {})
    const { subject } = migration({ stage })

    const outcome = await subject.run(new AbortController().signal)

    expect(outcome).toMatchObject({ state: 'moved', staged: true })
    expect(stage).toHaveBeenCalledOnce()
  })

  it('puts every local writer back when the owner says not now', async () => {
    const { subject, deps, order } = migration({ confirm: vi.fn(async () => false) })

    const outcome = await subject.run(new AbortController().signal)

    expect(outcome.state).toBe('cancelled')
    expect(order).toEqual(['quiesce', 'export', 'cloud_enrollment', 'revoke_cloud_enrollment', 'restore'])
    expect(deps.revokeCloudEnrollment).toHaveBeenCalledWith('00000000-0000-4000-8000-576f18824476')
    expect(deps.switchToCloud).not.toHaveBeenCalled()
  })

  it('never switches when the cloud enrollment cannot be trusted, and the agent keeps answering here', async () => {
    const { subject, deps, order } = migration({
      waitCloudEnrollment: vi.fn(async () => {
        throw new Error('matrix_cloud_handoff_expired')
      })
    })

    const outcome = await subject.run(new AbortController().signal)

    expect(outcome).toEqual({ state: 'failed', step: 'cloud_enrollment', code: 'matrix_cloud_handoff_expired' })
    expect(order).toEqual(['quiesce', 'export', 'cloud_enrollment', 'revoke_cloud_enrollment', 'restore'])
    expect(deps.switchToCloud).not.toHaveBeenCalled()
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('puts the writers back when the switch itself is refused', async () => {
    const { subject, order } = migration({
      switchToCloud: vi.fn(async () => {
        throw new Error('matrix_answering_conflict')
      })
    })

    const outcome = await subject.run(new AbortController().signal)

    expect(outcome).toMatchObject({ state: 'failed', step: 'switch' })
    expect(order).toContain('revoke_cloud_enrollment')
    expect(order.at(-1)).toBe('restore')
  })

  it('does not revoke an enrollment that was already there before this move', async () => {
    const { subject, deps, order } = migration({
      beginCloudEnrollment: vi.fn(async () => {
        order.push('cloud_enrollment')

        return { enrollmentId: '00000000-0000-4000-8000-576f18824476', created: false }
      }),
      confirm: vi.fn(async () => false)
    })

    expect((await subject.run(new AbortController().signal)).state).toBe('cancelled')
    expect(order.at(-1)).toBe('restore')
    expect(deps.revokeCloudEnrollment).not.toHaveBeenCalled()
  })

  it('restores local writers and logs a closed cleanup code when revocation remains pending', async () => {
    const logs: string[] = []

    const { subject, order, deps } = migration({
      confirm: vi.fn(async () => false),
      revokeCloudEnrollment: vi.fn(async () => {
        order.push('revoke_cloud_enrollment')
        throw new Error('device_registry_503_unavailable')
      }),
      log: line => void logs.push(line)
    })

    expect((await subject.run(new AbortController().signal)).state).toBe('cancelled')
    expect(order.at(-1)).toBe('restore')
    expect(logs).toEqual([
      `[Device] migration of ${deps.agentPrincipal.slice(0, 8)}: cloud enrollment cleanup pending: device_registry_503_unavailable`
    ])
  })

  it('moves an agent with no home on this Mac without a snapshot', async () => {
    const { subject, deps } = migration({ hermesHome: () => null })

    expect(await subject.run(new AbortController().signal)).toEqual({ state: 'moved', snapshot: null, staged: false })
    expect(deps.exportHome).not.toHaveBeenCalled()
  })

  it('runs one move at a time', async () => {
    const { subject, deps } = migration()

    const [a, b] = await Promise.all([
      subject.run(new AbortController().signal),
      subject.run(new AbortController().signal)
    ])

    expect(a).toBe(b)
    expect(deps.switchToCloud).toHaveBeenCalledOnce()
  })
})

describe("the snapshot is Hermes's own home export", () => {
  it('exports a real home with the bundled tool: memories and the session database, never settings', async () => {
    let python: string | undefined

    for (const candidate of [
      path.join(repo, '.venv/bin/python'),
      '/home/example/Projects/atum-app/.venv/bin/python',
      'python3'
    ]) {
      try {
        execFileSync(candidate, ['-c', 'import sys; assert sys.version_info >= (3, 10)'], { stdio: 'ignore' })
        python = execFileSync(candidate, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()

        break
      } catch {
        // Try the next interpreter.
      }
    }

    if (!python) {
      return
    }

    const home = temp('atum-hermes-home-')
    mkdirSync(path.join(home, 'memories'))
    writeFileSync(path.join(home, 'memories', 'MEMORY.md'), 'The demo code word is "lotus".')
    writeFileSync(path.join(home, 'SOUL.md'), 'You are T.')
    writeFileSync(path.join(home, 'config.yaml'), 'secret: never-exported')
    writeFileSync(path.join(home, '.env'), 'OPENROUTER_API_KEY=never-exported')
    const archive = path.join(temp('atum-snapshot-'), 'home.atum-home')

    const result = await exportAgentHome({ python, source: repo }, home, archive)

    expect(result.files).toBeGreaterThanOrEqual(2)
    const bytes = readFileSync(archive)
    expect(bytes.includes(Buffer.from('lotus'))).toBe(true)
    expect(bytes.includes(Buffer.from('never-exported'))).toBe(false)
    expect(statSync(archive).mode & 0o777).toBe(0o600)
  })

  it('reports a failed export as such', async () => {
    const run = ((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void
    ) => callback(new Error('exit 2'), '')) as never

    await expect(exportAgentHome({ python: '/x', source: '/y' }, '/home', '/out', run)).rejects.toThrow(
      'matrix_migration_export_failed'
    )
  })
})

describe("the owner's confirmation", () => {
  it('names the agent in every locale, and says where the backup stays when nothing is staged', () => {
    const plan = {
      agentName: 'T',
      writers: { executor: true, cron: false, lease: true, listening: false, gateways: [] },
      snapshot: {
        archive: '/home/example/Library/Application Support/Atum/device/migration/t.atum-home',
        sha256: 'x',
        bytes: 1,
        files: 1
      },
      staged: false
    }

    for (const locale of ['vi', 'en', 'zh', 'zh-hant', 'ja']) {
      const copy = migrationConfirmCopy(locale, plan)
      expect(copy.title).toContain('T')
      expect(copy.detail).toContain(plan.snapshot.archive)
      expect(copy.move.length).toBeGreaterThan(0)
      expect(copy.cancel.length).toBeGreaterThan(0)
    }

    expect(migrationConfirmCopy(undefined, plan)).toEqual(migrationConfirmCopy('vi', plan))
    const staged = migrationConfirmCopy('en', { ...plan, staged: true }).detail
    expect(staged).not.toContain(plan.snapshot.archive)
    expect(staged).toBe('T moves to cloud; Mac-only files and tools stay here.')
  })
})
