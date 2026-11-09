import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { EncryptedStore } from '../encrypted-store'

import type { MatrixHermesRuntimeConfig } from './hermes-runtime'
import { ensureMatrixWorkspace, matrixWorkspaceChoice } from './workspace-layout'
import { workspaceProcessProofPython } from './workspace-process.test-support'
import { readMatrixWorkspaceDriveRoots } from './workspace-root-facts'
import { MatrixWorkspaceStartup } from './workspace-startup'

const nativePlatform = process.platform === 'darwin' || process.platform === 'linux'

const python = nativePlatform
  ? execFileSync(
      process.env.ATUM_WORKSPACE_PROOF_PYTHON ?? 'python3',
      ['-I', '-B', '-S', '-c', 'import sys; print(sys.executable)'],
      { encoding: 'utf8' }
    ).trim()
  : ''

describe.skipIf(!nativePlatform)('native workspace startup assembly', () => {
  let home: string
  let legacy: string
  let workspace: string
  let userData: string
  let bindings: EncryptedStore
  let history: EncryptedStore

  beforeEach(() => {
    home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'atum-workspace-startup-')))
    legacy = path.join(home, 'Atum')
    workspace = path.join(legacy, 'Workspace')
    userData = path.join(home, 'user-data')
    mkdirSync(legacy)
    mkdirSync(userData)

    const seal = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString()
    }

    bindings = new EncryptedStore(path.join(userData, 'drive.json'), seal)
    history = new EncryptedStore(path.join(userData, 'drive-roots.json'), seal)
    vi.stubEnv('HERMES_DESKTOP_CWD', '')
    writeFileSync(path.join(legacy, 'notes.txt'), 'original bytes')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  function fixture(quiescent = true) {
    const runtime: MatrixHermesRuntimeConfig = {
      python: workspaceProcessProofPython({ python, home }),
      source: path.join(home, 'runtime'),
      profiles: path.join(home, 'profiles')
    }

    const log = vi.fn()
    const roots = () => readMatrixWorkspaceDriveRoots(history, bindings)
    const startup = new MatrixWorkspaceStartup({ home, userData, runtime, roots, quiescent: () => quiescent, log })

    return { runtime, startup, log, roots }
  }

  test('one native pass precedes every runtime and preserves inactive account roots before identity hydration', async () => {
    const drive = path.join(legacy, 'custom-drive')
    mkdirSync(drive)
    writeFileSync(path.join(drive, 'keep.txt'), 'Drive bytes')
    bindings.setItem('drive-root:inactive', JSON.stringify({ root: drive, dev: 1, ino: 2 }))
    const before = readFileSync(path.join(userData, 'drive.json'))
    const f = fixture()
    await expect(f.runtime.beforeOpen!()).rejects.toThrow('workspace_layout_deferred')
    const pass = f.startup.start()
    expect(f.startup.start()).toBe(pass)
    await f.runtime.beforeOpen!()
    expect(readFileSync(path.join(workspace, 'notes.txt'), 'utf8')).toBe('original bytes')
    expect(readFileSync(path.join(drive, 'keep.txt'), 'utf8')).toBe('Drive bytes')
    expect(readFileSync(path.join(userData, 'drive.json'))).toEqual(before)
    expect(f.runtime.workspaceHome).toBe(home)
    expect(f.runtime.knownDriveRoots!()).toEqual([drive])
    expect(f.startup.watched()).toBe(
      ensureMatrixWorkspace(matrixWorkspaceChoice(process.env, home, f.roots()), f.roots())
    )
    expect(f.log).not.toHaveBeenCalled()
  })

  test('a live executor/turn fact defers every move until a later launch', async () => {
    const f = fixture(false)
    await f.startup.start()
    expect(existsSync(workspace)).toBe(false)
    expect(readFileSync(path.join(legacy, 'notes.txt'), 'utf8')).toBe('original bytes')
    expect(f.log).toHaveBeenCalledWith('workspace_layout_deferred')
    await expect(f.runtime.beforeOpen!()).resolves.toBeUndefined()
  })

  test('the same native cwd override suppresses migration and selects the watched project', async () => {
    const project = path.join(home, 'project')
    mkdirSync(project)
    vi.stubEnv('HERMES_DESKTOP_CWD', project)
    const f = fixture()
    await f.startup.start()
    expect(existsSync(workspace)).toBe(false)
    expect(readFileSync(path.join(legacy, 'notes.txt'), 'utf8')).toBe('original bytes')
    expect(f.startup.watched()).toBe(project)
    expect(ensureMatrixWorkspace(matrixWorkspaceChoice(process.env, home, f.roots()), f.roots())).toBe(project)
  })

  test.each(['file', 'link'])('watched and runtime agree after a %s collision without replacing it', async kind => {
    if (kind === 'file') {
      writeFileSync(workspace, 'collision bytes')
    } else {
      const external = path.join(home, 'external')
      mkdirSync(external)
      writeFileSync(path.join(external, 'keep.txt'), 'external bytes')
      symlinkSync(external, workspace, 'dir')
    }

    const f = fixture()
    await f.startup.start()
    expect(f.startup.watched()).toBe(legacy)
    expect(ensureMatrixWorkspace(matrixWorkspaceChoice(process.env, home, f.roots()), f.roots())).toBe(legacy)
    expect(readFileSync(path.join(legacy, 'notes.txt'), 'utf8')).toBe('original bytes')
    expect(
      kind === 'file' ? readFileSync(workspace, 'utf8') : readFileSync(path.join(workspace, 'keep.txt'), 'utf8')
    ).toBe(kind === 'file' ? 'collision bytes' : 'external bytes')
  })

  test('unreadable history cannot become an empty protected-root list at startup or on a watched read', async () => {
    writeFileSync(path.join(userData, 'drive.json'), '{corrupt synthetic index')
    const f = fixture()
    await f.startup.start()
    expect(existsSync(workspace)).toBe(false)
    expect(readFileSync(path.join(legacy, 'notes.txt'), 'utf8')).toBe('original bytes')
    expect(f.log).toHaveBeenCalledWith('workspace_layout_deferred')
    expect(() => f.runtime.knownDriveRoots!()).toThrow('workspace_layout_deferred')
    expect(() => f.startup.watched()).toThrow('workspace_layout_deferred')
  })

  test('watched facts are freshly read and a newly protected default becomes unavailable', async () => {
    const f = fixture()
    await f.startup.start()
    expect(f.startup.watched()).toBe(workspace)
    history.setItem('roots', JSON.stringify([legacy]))
    expect(() => f.startup.watched()).toThrow('workspace_layout_blocked')
  })

  test('quit aborts only the owned native helper and permanently closes its runtime barrier', async () => {
    const ready = path.join(home, 'owned-helper-ready')
    const script = path.join(home, 'owned-helper.py')
    const wrapper = path.join(home, 'owned-python')
    writeFileSync(
      script,
      'import os, pathlib, sys, time\npathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\ntime.sleep(30)\n'
    )
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(python)} -I -B -S ${quote(script)} ${quote(ready)}\n`, {
      mode: 0o700
    })
    const unrelated = spawn(python, ['-I', '-B', '-S', '-c', 'import time; time.sleep(30)'], { stdio: 'ignore' })
    const f = fixture()
    f.runtime.python = wrapper

    try {
      const pass = f.startup.start()
      // A real child process: a busy runner can take more than the default second to start it.
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 5_000 })
      const helperPid = Number(readFileSync(ready, 'utf8'))
      f.startup.stop()
      await pass
      await expect(f.runtime.beforeOpen!()).rejects.toThrow()
      await vi.waitFor(() => expect(() => process.kill(helperPid, 0)).toThrow(), { timeout: 5_000 })
      expect(unrelated.exitCode).toBeNull()
      expect(unrelated.signalCode).toBeNull()
      expect(existsSync(workspace)).toBe(false)
    } finally {
      const exited = once(unrelated, 'exit')
      unrelated.kill('SIGTERM')
      await exited
      f.startup.stop()
    }
  })
})
