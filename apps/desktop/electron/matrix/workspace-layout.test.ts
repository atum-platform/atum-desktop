import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { ensureMatrixWorkspace, matrixWorkspaceChoice, migrateMatrixWorkspaceLayout } from './workspace-layout'
import type { MatrixWorkspaceLayoutInput } from './workspace-layout'
import { workspaceProcessProofPython } from './workspace-process.test-support'

interface LayoutMarker {
  version: number
  completedAt: number
  legacyIdentity: string[]
  workspaceIdentity: string[]
  moved: string[]
  skipped: { name: string; reason: string }[]
}

const nativePlatform = process.platform === 'darwin' || process.platform === 'linux'

const python = nativePlatform
  ? execFileSync('python3', ['-I', '-B', '-S', '-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8'
    }).trim()
  : ''

describe('workspace choice and native layout migration', () => {
  let home: string
  let legacy: string
  let workspace: string
  let userData: string
  let children: Set<ChildProcessWithoutNullStreams>

  beforeEach(() => {
    home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'atum-workspace-layout-')))
    legacy = path.join(home, 'Atum')
    workspace = path.join(legacy, 'Workspace')
    userData = path.join(home, 'user-data')
    mkdirSync(legacy)
    children = new Set()
  })

  async function stopChild(child: ChildProcessWithoutNullStreams, crash = false): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return
    }

    const exited = once(child, 'exit')

    if (crash) {
      child.kill('SIGKILL')
    } else {
      child.stdin.end()
    }

    await exited
    children.delete(child)
  }

  afterEach(async () => {
    await Promise.all([...children].map(child => stopChild(child, true)))
    rmSync(home, { recursive: true, force: true })
  })

  const input = (overrides: Partial<MatrixWorkspaceLayoutInput> = {}): MatrixWorkspaceLayoutInput => ({
    home,
    userData,
    python: workspaceProcessProofPython({
      python,
      home,
      processes: [...children].flatMap(child => child.pid ? [child.pid] : [])
    }),
    quiescent: true,
    ...overrides
  })

  const markerPath = () => path.join(userData, 'workspace-layout.json')
  const marker = (): LayoutMarker => JSON.parse(readFileSync(markerPath(), 'utf8')) as LayoutMarker

  function seed(relative: string, bytes = relative): string {
    const target = path.join(legacy, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, bytes)

    return target
  }

  async function holdingChild(cwd: string, setup = ''): Promise<ChildProcessWithoutNullStreams> {
    const child = spawn(python, ['-I', '-B', '-S', '-c', `${setup}\nprint('ready', flush=True)\ninput()`], {
      cwd,
      stdio: 'pipe'
    })

    children.add(child)
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', () => reject(new Error(`Owned process ended before ready: ${stderr}`)))
      child.stdout.once('data', chunk => {
        if (String(chunk).includes('ready')) {
          resolve()
        } else {
          reject(new Error('Owned process did not confirm readiness'))
        }
      })
    })

    return child
  }

  test('unset, relative, and missing overrides select the private default', () => {
    for (const env of [{}, { HERMES_DESKTOP_CWD: 'relative' }, { HERMES_DESKTOP_CWD: path.join(home, 'missing') }]) {
      expect(matrixWorkspaceChoice(env, home)).toEqual({ legacy, workspace, default: true })
    }

    const choice = matrixWorkspaceChoice({}, home)
    expect(ensureMatrixWorkspace(choice)).toBe(workspace)
    expect(statSync(workspace).mode & 0o777).toBe(0o700)
  })

  test('the old default and its realpath alias select Workspace', () => {
    const alias = path.join(home, 'legacy-alias')
    symlinkSync(legacy, alias, 'dir')

    for (const named of [legacy, alias]) {
      expect(matrixWorkspaceChoice({ HERMES_DESKTOP_CWD: named }, home)).toEqual({
        legacy,
        workspace,
        default: true
      })
    }
  })

  test('Drive descendants and aliases cannot become the agent workspace', () => {
    const drive = path.join(legacy, 'Drive')
    const folder = path.join(drive, 'folder')
    mkdirSync(folder, { recursive: true })
    const alias = path.join(home, 'drive-alias')
    symlinkSync(drive, alias, 'dir')

    for (const named of [drive, folder, alias, path.join(alias, 'folder')]) {
      expect(matrixWorkspaceChoice({ HERMES_DESKTOP_CWD: named }, home)).toEqual({
        legacy,
        workspace,
        default: true,
        reason: 'workspace_named_inside_drive'
      })
    }
  })

  test('configured Drive roots are fenced after resolving aliases', () => {
    const drive = path.join(home, 'custom-drive')
    mkdirSync(path.join(drive, 'folder'), { recursive: true })
    const alias = path.join(home, 'custom-drive-alias')
    symlinkSync(drive, alias, 'dir')
    expect(matrixWorkspaceChoice({ HERMES_DESKTOP_CWD: path.join(alias, 'folder') }, home, [drive])).toMatchObject({
      workspace,
      default: true,
      reason: 'workspace_named_inside_drive'
    })
  })

  test('an existing absolute project is honored exactly and does not migrate', async () => {
    const project = path.join(home, 'project')
    mkdirSync(project)
    seed('untouched.txt', 'legacy original')
    const env = { HERMES_DESKTOP_CWD: project }
    const choice = matrixWorkspaceChoice(env, home)
    expect(choice).toEqual({ legacy, workspace: project, default: false })
    expect(ensureMatrixWorkspace(choice)).toBe(project)
    await expect(migrateMatrixWorkspaceLayout(input({ env }))).resolves.toMatchObject({
      status: 'not_needed',
      moved: 0
    })
    expect(readFileSync(path.join(legacy, 'untouched.txt'), 'utf8')).toBe('legacy original')
    expect(existsSync(workspace)).toBe(false)
    expect(existsSync(markerPath())).toBe(false)
  })

  test.skipIf(!nativePlatform)(
    'moves plain files and directories while preserving the Drive binding, shortcuts, dots, and links',
    async () => {
      seed('notes.txt', 'notes bytes')
      seed('project/nested.txt', 'project bytes')
      const binding = seed('Drive/.atum-binding.json', '{"binding":"unchanged"}')
      const dotted = seed('.config/config.txt', 'private config')
      const dotFile = seed('.dotfile', 'private bytes')
      const external = path.join(home, 'external')
      mkdirSync(external)
      writeFileSync(path.join(external, 'target.txt'), 'external bytes')
      mkdirSync(path.join(legacy, 'Agents'))
      const agentLink = path.join(legacy, 'Agents', 'agent')
      const topLink = path.join(legacy, 'shortcut')
      symlinkSync(external, agentLink, 'dir')
      symlinkSync(external, topLink, 'dir')

      const result = await migrateMatrixWorkspaceLayout(input())
      expect(result.status).toBe('completed')
      expect(readFileSync(path.join(workspace, 'notes.txt'), 'utf8')).toBe('notes bytes')
      expect(readFileSync(path.join(workspace, 'project/nested.txt'), 'utf8')).toBe('project bytes')
      expect(existsSync(path.join(legacy, 'notes.txt'))).toBe(false)
      expect(existsSync(path.join(legacy, 'project'))).toBe(false)
      expect(readFileSync(binding, 'utf8')).toBe('{"binding":"unchanged"}')
      expect(readFileSync(dotted, 'utf8')).toBe('private config')
      expect(readFileSync(dotFile, 'utf8')).toBe('private bytes')
      expect(lstatSync(agentLink).isSymbolicLink()).toBe(true)
      expect(lstatSync(topLink).isSymbolicLink()).toBe(true)
      expect(readFileSync(path.join(external, 'target.txt'), 'utf8')).toBe('external bytes')
      expect(statSync(workspace).mode & 0o777).toBe(0o700)
      const receipt = marker()
      expect(receipt.version).toBe(1)
      expect(receipt.completedAt).toBeGreaterThan(0)
      expect(receipt.moved.toSorted()).toEqual(['notes.txt', 'project'])
      expect(receipt.skipped).toEqual(
        expect.arrayContaining([
          { name: 'Drive', reason: 'reserved' },
          { name: 'Agents', reason: 'reserved' },
          { name: '.config', reason: 'dot' },
          { name: '.dotfile', reason: 'dot' },
          { name: 'shortcut', reason: 'link' }
        ])
      )

      const manifestBytes = readFileSync(markerPath())
      const originalEntries = readdirSync(legacy).toSorted()
      await expect(migrateMatrixWorkspaceLayout(input())).resolves.toMatchObject({
        status: 'already_completed',
        moved: receipt.moved.length
      })
      expect(readFileSync(markerPath())).toEqual(manifestBytes)
      expect(readdirSync(legacy).toSorted()).toEqual(originalEntries)
      seed('later.txt', 'created after migration')
      await expect(migrateMatrixWorkspaceLayout(input())).resolves.toMatchObject({ status: 'already_completed' })
      expect(readFileSync(path.join(legacy, 'later.txt'), 'utf8')).toBe('created after migration')
    },
    15_000
  )

  test.skipIf(!nativePlatform)(
    'an existing destination preserves both originals and records the collision',
    async () => {
      seed('clash.txt', 'legacy original')
      mkdirSync(workspace)
      writeFileSync(path.join(workspace, 'clash.txt'), 'workspace original')
      await expect(migrateMatrixWorkspaceLayout(input())).resolves.toMatchObject({ status: 'completed', moved: 0 })
      expect(readFileSync(path.join(legacy, 'clash.txt'), 'utf8')).toBe('legacy original')
      expect(readFileSync(path.join(workspace, 'clash.txt'), 'utf8')).toBe('workspace original')
      expect(marker().skipped).toContainEqual({ name: 'clash.txt', reason: 'collision' })
    },
    15_000
  )

  test.skipIf(!nativePlatform)(
    'a destination created after the precheck cannot be overwritten by the native rename',
    async () => {
      seed('race.txt', 'legacy original')
      await expect(migrateMatrixWorkspaceLayout(input({ testRaceDestination: 'race.txt' }))).resolves.toMatchObject({
        status: 'completed',
        moved: 0
      })
      expect(readFileSync(path.join(legacy, 'race.txt'), 'utf8')).toBe('legacy original')
      expect(readFileSync(path.join(workspace, 'race.txt'), 'utf8')).toBe('synthetic-race')
      expect(marker().skipped).toContainEqual({ name: 'race.txt', reason: 'collision' })
    },
    15_000
  )

  test.skipIf(!nativePlatform)(
    'a crash after one rename resumes and retains every move in the manifest',
    async () => {
      seed('a-first.txt', 'first original')
      seed('b-second.txt', 'second original')
      await expect(migrateMatrixWorkspaceLayout(input({ testCrashAfterMove: 1 }))).resolves.toMatchObject({
        status: 'deferred',
        reason: 'workspace_layout_interrupted'
      })
      expect(readFileSync(path.join(workspace, 'a-first.txt'), 'utf8')).toBe('first original')
      expect(readFileSync(path.join(legacy, 'b-second.txt'), 'utf8')).toBe('second original')
      expect(existsSync(markerPath())).toBe(false)

      await expect(migrateMatrixWorkspaceLayout(input())).resolves.toMatchObject({ status: 'completed', moved: 2 })
      expect(readFileSync(path.join(workspace, 'a-first.txt'), 'utf8')).toBe('first original')
      expect(readFileSync(path.join(workspace, 'b-second.txt'), 'utf8')).toBe('second original')
      expect(marker().moved.toSorted()).toEqual(['a-first.txt', 'b-second.txt'])
      expect(existsSync(path.join(legacy, 'a-first.txt'))).toBe(false)
      expect(existsSync(path.join(legacy, 'b-second.txt'))).toBe(false)
    },
    15_000
  )

  test.skipIf(!nativePlatform)(
    'an actual leftover process cwd defers every move until the process exits',
    async () => {
      seed('first.txt', 'first original')
      seed('second.txt', 'second original')
      const child = await holdingChild(legacy)
      await expect(migrateMatrixWorkspaceLayout(input())).resolves.toMatchObject({
        status: 'deferred',
        moved: 0,
        reason: 'workspace_layout_deferred'
      })
      expect(readFileSync(path.join(legacy, 'first.txt'), 'utf8')).toBe('first original')
      expect(readFileSync(path.join(legacy, 'second.txt'), 'utf8')).toBe('second original')
      expect(existsSync(workspace)).toBe(false)
      expect(existsSync(markerPath())).toBe(false)

      await stopChild(child)
      await expect(migrateMatrixWorkspaceLayout(input())).resolves.toMatchObject({ status: 'completed', moved: 2 })
      expect(readFileSync(path.join(workspace, 'first.txt'), 'utf8')).toBe('first original')
      expect(readFileSync(path.join(workspace, 'second.txt'), 'utf8')).toBe('second original')
    },
    15_000
  )

  test.skipIf(!nativePlatform)(
    'an actual migration lock defers, then a killed owner releases it for the next launch',
    async () => {
      seed('original.txt', 'retained bytes')
      mkdirSync(userData)
      const lock = path.join(userData, 'workspace-layout.lock')
      writeFileSync(lock, '', { mode: 0o600 })

      const child = await holdingChild(
        userData,
        `import fcntl\nlock = open('workspace-layout.lock', 'r+')\nfcntl.flock(lock, fcntl.LOCK_EX)`
      )

      await expect(migrateMatrixWorkspaceLayout(input())).resolves.toMatchObject({ status: 'deferred', moved: 0 })
      expect(readFileSync(path.join(legacy, 'original.txt'), 'utf8')).toBe('retained bytes')
      expect(existsSync(workspace)).toBe(false)
      expect(existsSync(markerPath())).toBe(false)

      await stopChild(child, true)
      await expect(migrateMatrixWorkspaceLayout(input())).resolves.toMatchObject({ status: 'completed', moved: 1 })
      expect(readFileSync(path.join(workspace, 'original.txt'), 'utf8')).toBe('retained bytes')
    },
    15_000
  )

  test.skipIf(process.platform !== 'linux')('an unreadable fixture process defers without creating or moving anything', async () => {
    seed('original.txt', 'retained bytes')
    const proof = input()
    proof.python = workspaceProcessProofPython({ python, home, unreadable: true })
    await expect(migrateMatrixWorkspaceLayout(proof)).resolves.toMatchObject({
      status: 'deferred', moved: 0, reason: 'workspace_layout_deferred'
    })
    expect(readFileSync(path.join(legacy, 'original.txt'), 'utf8')).toBe('retained bytes')
    expect(existsSync(workspace)).toBe(false)
    expect(existsSync(markerPath())).toBe(false)
  })

  test('the in-memory live-turn guard defers before any native or filesystem operation', async () => {
    seed('original.txt', 'retained bytes')
    await expect(migrateMatrixWorkspaceLayout(input({ quiescent: false }))).resolves.toMatchObject({
      status: 'deferred',
      moved: 0
    })
    expect(readFileSync(path.join(legacy, 'original.txt'), 'utf8')).toBe('retained bytes')
    expect(existsSync(workspace)).toBe(false)
    expect(existsSync(userData)).toBe(false)
  })

  test.skipIf(!nativePlatform)(
    'a file occupying Workspace is preserved and the resolver keeps the legacy launch fallback',
    async () => {
      seed('original.txt', 'retained bytes')
      writeFileSync(workspace, 'workspace obstruction')
      expect(ensureMatrixWorkspace(matrixWorkspaceChoice({}, home))).toBe(legacy)
      await expect(migrateMatrixWorkspaceLayout(input())).resolves.toMatchObject({ status: 'blocked', moved: 0 })
      expect(readFileSync(workspace, 'utf8')).toBe('workspace obstruction')
      expect(readFileSync(path.join(legacy, 'original.txt'), 'utf8')).toBe('retained bytes')
      expect(existsSync(markerPath())).toBe(false)
    },
    15_000
  )

  test.skipIf(!nativePlatform)(
    'a Workspace link cannot redirect the move into another directory',
    async () => {
      seed('original.txt', 'retained bytes')
      const external = path.join(home, 'external')
      mkdirSync(external)
      writeFileSync(path.join(external, 'external.txt'), 'external original')
      symlinkSync(external, workspace, 'dir')
      expect(ensureMatrixWorkspace(matrixWorkspaceChoice({}, home))).toBe(legacy)
      await expect(migrateMatrixWorkspaceLayout(input())).resolves.toMatchObject({ status: 'blocked', moved: 0 })
      expect(lstatSync(workspace).isSymbolicLink()).toBe(true)
      expect(readFileSync(path.join(legacy, 'original.txt'), 'utf8')).toBe('retained bytes')
      expect(readdirSync(external)).toEqual(['external.txt'])
      expect(readFileSync(path.join(external, 'external.txt'), 'utf8')).toBe('external original')
    },
    15_000
  )

  test.skipIf(!nativePlatform)(
    'a symlink occupying the legacy root leaves its target untouched',
    async () => {
      rmSync(legacy, { recursive: true })
      const external = path.join(home, 'external')
      mkdirSync(external)
      writeFileSync(path.join(external, 'external.txt'), 'external original')
      symlinkSync(external, legacy, 'dir')
      expect(ensureMatrixWorkspace(matrixWorkspaceChoice({}, home))).toBe(home)
      await expect(migrateMatrixWorkspaceLayout(input())).resolves.toMatchObject({ status: 'blocked', moved: 0 })
      expect(lstatSync(legacy).isSymbolicLink()).toBe(true)
      expect(readdirSync(external)).toEqual(['external.txt'])
      expect(readFileSync(path.join(external, 'external.txt'), 'utf8')).toBe('external original')
    },
    15_000
  )

  test.skipIf(!nativePlatform)(
    'configured Drive, runtime, and application-data ancestors stay while ordinary content moves',
    async () => {
      const driveFile = seed('Cloud/custom-drive/.binding', 'Drive binding')
      const runtimeFile = seed('Runtime/source/runtime.py', 'runtime source')
      const profileFile = seed('Profiles/agent/state', 'profile state')
      const dataFile = seed('DesktopData/user-data/preferences.json', 'application data')
      seed('ordinary/nested.txt', 'ordinary bytes')
      userData = path.join(legacy, 'DesktopData/user-data')
      await expect(
        migrateMatrixWorkspaceLayout(
          input({
            knownDriveRoots: [path.join(legacy, 'Cloud/custom-drive')],
            runtimeSource: path.join(legacy, 'Runtime/source'),
            runtimeProfiles: path.join(legacy, 'Profiles')
          })
        )
      ).resolves.toMatchObject({ status: 'completed', moved: 1 })
      expect(readFileSync(driveFile, 'utf8')).toBe('Drive binding')
      expect(readFileSync(runtimeFile, 'utf8')).toBe('runtime source')
      expect(readFileSync(profileFile, 'utf8')).toBe('profile state')
      expect(readFileSync(dataFile, 'utf8')).toBe('application data')
      expect(readFileSync(path.join(workspace, 'ordinary/nested.txt'), 'utf8')).toBe('ordinary bytes')
      expect(marker().skipped).toEqual(
        expect.arrayContaining([
          { name: 'Cloud', reason: 'drive_root' },
          { name: 'Runtime', reason: 'runtime' },
          { name: 'Profiles', reason: 'runtime' },
          { name: 'DesktopData', reason: 'application_data' }
        ])
      )
    },
    15_000
  )

  test.skipIf(!nativePlatform)(
    'a Drive root covering the default workspace blocks before creating it',
    async () => {
      seed('original.txt', 'retained bytes')
      expect(() => ensureMatrixWorkspace(matrixWorkspaceChoice({}, home), [legacy])).toThrow('workspace_layout_blocked')
      expect(existsSync(workspace)).toBe(false)
      expect(existsSync(userData)).toBe(false)
      await expect(migrateMatrixWorkspaceLayout(input({ knownDriveRoots: [legacy] }))).resolves.toMatchObject({
        status: 'blocked',
        moved: 0
      })
      expect(existsSync(workspace)).toBe(false)
      expect(existsSync(userData)).toBe(false)
      expect(readFileSync(path.join(legacy, 'original.txt'), 'utf8')).toBe('retained bytes')
    },
    15_000
  )

  test.skipIf(!nativePlatform)(
    'a final marker bound to a different workspace cannot authorize subsequent moves',
    async () => {
      seed('first.txt', 'first original')
      await expect(migrateMatrixWorkspaceLayout(input())).resolves.toMatchObject({ status: 'completed', moved: 1 })
      const originalWorkspace = path.join(legacy, 'Workspace-original')
      execFileSync(python, [
        '-I',
        '-B',
        '-S',
        '-c',
        'import os,sys; os.rename(sys.argv[1], sys.argv[2])',
        workspace,
        originalWorkspace
      ])
      mkdirSync(workspace)
      seed('later.txt', 'later original')
      await expect(migrateMatrixWorkspaceLayout(input())).resolves.toMatchObject({ status: 'blocked', moved: 0 })
      expect(readFileSync(path.join(legacy, 'later.txt'), 'utf8')).toBe('later original')
      expect(readFileSync(path.join(originalWorkspace, 'first.txt'), 'utf8')).toBe('first original')
      expect(readdirSync(workspace)).toEqual([])
    },
    15_000
  )
})
