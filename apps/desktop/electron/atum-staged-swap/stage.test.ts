import { type ChildProcess, execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { snapshot, StagedSwap, type StageTools } from './stage'
import { markStockOnly, readJournal, stageRoot } from './store'
import { fakeSystem, type FakeSystem, temporaryRoots, writeBundle, writeZip } from './test-fixtures'
import type { WaiterOptions } from './waiter'

const roots = temporaryRoots()
const children: ChildProcess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {child.kill('SIGKILL')}
  await roots.cleanup()
})

const ID = 'com.atum.matrix-candidate'

async function world(options: { system?: FakeSystem; tools?: Partial<StageTools>; processWaitMs?: number } = {}) {
  const home = await roots.make()
  const target = path.join(home, 'Applications', 'Atum.app')
  const handoffDirectory = path.join(home, 'userdata', 'update-handoff')

  await writeBundle(target, '1.0.0')
  await fs.mkdir(handoffDirectory, { recursive: true })
  const system = options.system ?? fakeSystem()
  const waiters: WaiterOptions[] = []

  const spawnWaiter = vi.fn(async (waiter: WaiterOptions) => {
    waiters.push(waiter)

    return { kill() {} }
  })

  const log: string[] = []

  const swap = new StagedSwap({
    home, id: ID, target, version: '1.0.0', handoffDirectory, enabled: () => true, log: line => log.push(line),
    processWaitMs: options.processWaitMs ?? 300,
    tools: { run: system.run, processes: async () => [], spawnWaiter, gktoolPresent: async () => true, macMajor: () => 26, ...options.tools }
  })

  return { home, target, handoffDirectory, system, swap, waiters, spawnWaiter, log, root: stageRoot(home, ID) }
}

const version = (bundle: string) => fs.readFile(path.join(bundle, 'Contents', 'Resources', 'runtime.py'), 'utf8')

// macOS-only: real ditto bundles, codesign/spctl seams, the BSD `ps` tree.
describe.skipIf(process.platform !== 'darwin')('prepare', () => {
  it('unpacks, seals, verifies and only then reports ready', async () => {
    const w = await world()
    const zip = await writeZip(w.home, '1.0.1')

    await w.swap.prepare(zip, '1.0.1')
    expect(w.swap.ready).toBe(true)
    expect(w.log).toContain('[updates] stage state=ready')
    // Prewarm runs before the seal; every trust check runs after it.
    const order = w.system.calls

    expect(order.indexOf('gktool scan')).toBeLessThan(order.indexOf('codesign --verify'))
    expect(order).toContain('spctl -a')
    expect(order.some(call => call.startsWith('xcrun'))).toBe(false)
    const staged = (await fs.readdir(w.root)).filter(name => name.startsWith('update-'))

    expect(staged).toHaveLength(1)
  })

  it('rejects a tamper that happens during verification, and leaves nothing staged', async () => {
    let staged = ''

    const w = await world({
      system: fakeSystem({
        async onVerify(bundle) {
          staged = bundle
          await fs.writeFile(path.join(bundle, 'Contents', 'Resources', 'runtime.py'), 'print("evil")\n')
        }
      })
    })

    await expect(w.swap.prepare(await writeZip(w.home, '1.0.1'), '1.0.1')).rejects.toThrow('changed during verification')
    expect(w.swap.ready).toBe(false)
    expect(staged).not.toBe('')
    await expect(fs.stat(staged)).rejects.toThrow()
  })

  it.each([
    ['not notarized', { notarized: false }, 'not notarized'],
    ['a different team', { team: 'XXXXXXXXXX' }, 'identity']
  ])('rejects %s', async (_name, system, message) => {
    const w = await world({ system: fakeSystem(system) })

    await expect(w.swap.prepare(await writeZip(w.home, '1.0.1'), '1.0.1')).rejects.toThrow(message)
    expect((await fs.readdir(w.root)).filter(name => name.startsWith('update-'))).toEqual([])
  })

  it('rejects an archive that lacks asar integrity, a wrong version, or a downgrade', async () => {
    const w = await world()

    await expect(w.swap.prepare(await writeZip(w.home, '1.0.1', 'Atum.app', false), '1.0.1')).rejects.toThrow('identity')
    await expect(w.swap.prepare(await writeZip(w.home, '1.0.2'), '1.0.1')).rejects.toThrow('identity')
    await expect(w.swap.prepare(await writeZip(w.home, '0.9.0'), '0.9.0')).rejects.toThrow('increase')
  })

  it('sweeps stale staged copies even when the Mac is ineligible (no gktool, low disk)', async () => {
    const w = await world({ tools: { gktoolPresent: async () => false } })

    await fs.mkdir(path.join(w.root, 'update-abc123', 'Atum.app'), { recursive: true })
    await fs.mkdir(path.join(w.root, 'update-xyz789', 'Atum.app'), { recursive: true })

    await expect(w.swap.prepare(await writeZip(w.home, '1.0.1'), '1.0.1')).rejects.toThrow('gktool')
    expect(await fs.readdir(w.root)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^update-/u)]))
  })

  it('does not stay disabled for ever behind an orphaned rollback copy', async () => {
    const w = await world()

    await fs.mkdir(path.join(w.root, 'previous.app'), { recursive: true })
    await w.swap.prepare(await writeZip(w.home, '1.0.1'), '1.0.1')
    expect(w.swap.ready).toBe(true)
    await expect(fs.stat(path.join(w.root, 'previous.app'))).rejects.toThrow()
  })

  it('goes straight to stock for a version that already failed', async () => {
    const w = await world()

    await fs.mkdir(w.root, { recursive: true })
    markStockOnly(w.root, '1.0.1', 'test')
    await expect(w.swap.prepare(await writeZip(w.home, '1.0.1'), '1.0.1')).rejects.toThrow('disabled')
  })

  it('refuses a target in an unsupported folder', async () => {
    const w = await world()

    const outside = new StagedSwap({
      home: w.home, id: ID, target: path.join(w.home, 'Elsewhere', 'Atum.app'), version: '1.0.0',
      handoffDirectory: w.handoffDirectory, enabled: () => true, log: () => {}, tools: { run: w.system.run }
    })

    await expect(outside.prepare(await writeZip(w.home, '1.0.1'), '1.0.1')).rejects.toThrow('Unsupported')
  })
})

describe.skipIf(process.platform !== 'darwin')('install', () => {
  async function prepared(options: Parameters<typeof world>[0] = {}) {
    const w = await world(options)

    await w.swap.prepare(await writeZip(w.home, '1.0.1'), '1.0.1')

    return w
  }

  it('swaps in the staged app, keeps the old one as the backup and journals it', async () => {
    const w = await prepared()

    await w.swap.install({ relaunch: true })
    expect(await version(w.target)).toContain('1.0.1')
    expect(await version(path.join(w.root, 'previous.app'))).toContain('1.0.0')
    const journal = readJournal(w.home, w.root)

    expect(journal).toMatchObject({ v: 2, target: w.target, fromVersion: '1.0.0', toVersion: '1.0.1', relaunch: true })
    expect(w.waiters).toHaveLength(1)
    expect(w.waiters[0]).toMatchObject({ target: w.target, backup: path.join(w.root, 'previous.app'), relaunch: true })
    expect(w.swap.waiterRunning).toBe(true)
    const progress = await fs.readFile(path.join(w.root, 'progress.log'), 'utf8')

    expect(progress).toContain('stage state=swap')
    expect(progress).toContain('stage state=relaunch')
  })

  it('clears stale launch markers before the launcher exists', async () => {
    const w = await prepared()

    await fs.writeFile(path.join(w.handoffDirectory, 'shown'), 'stale')
    await fs.writeFile(path.join(w.handoffDirectory, 'started'), '1')
    await w.swap.install({ relaunch: false })
    expect(await fs.readdir(w.handoffDirectory)).toEqual([])
    expect(w.waiters[0].relaunch).toBe(false)
  })

  it("does not wait for Electron's own utility and GPU helpers", async () => {
    let target = ''
    const frameworks = () => `${target}/Contents/Frameworks`

    const w = await prepared({
      tools: {
        processes: async () => [
          { pid: process.pid + 1, ppid: process.pid, command: `${frameworks()}/Atum Helper.app/Contents/MacOS/Atum Helper` },
          { pid: process.pid + 2, ppid: process.pid, command: `${frameworks()}/Atum Helper (GPU).app/Contents/MacOS/Atum Helper (GPU)` }
        ]
      }
    })

    target = w.target
    await w.swap.install({ relaunch: true })
    expect(await version(w.target)).toContain('1.0.1')
  })

  it('stops before changing anything when an old runtime child will not exit', async () => {
    let target = ''

    const w = await prepared({
      processWaitMs: 250,
      tools: {
        processes: async () => [{ pid: process.pid + 1, ppid: 1, command: `${target}/Contents/Resources/runtime/python3` }]
      }
    })

    target = w.target
    await expect(w.swap.install({ relaunch: true })).rejects.toThrow('Old bundle processes still running')
    expect(await version(w.target)).toContain('1.0.0')
    expect(readJournal(w.home, w.root)).toBeNull()
    expect(w.swap.waiterRunning).toBe(true)
  })

  it('does not wait on helpers that are real children of this process', async () => {
    const home = await roots.make()
    const bundle = path.join(home, 'Fake.app')
    const dir = `${bundle}/Contents/Frameworks/Fake Helper.app/Contents/MacOS`

    await fs.mkdir(dir, { recursive: true })
    await fs.symlink(process.execPath, path.join(dir, 'Fake Helper'))
    const helper = spawn(path.join(dir, 'Fake Helper'), ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })

    children.push(helper)

    const swap = new StagedSwap({
      home, id: ID, target: bundle, version: '1.0.0', handoffDirectory: home, enabled: () => true, log: () => {}, processWaitMs: 300,
      // Exercise real ps and parentage without macOS background-priority starvation under test load.
      tools: { run: promisify(execFile) }
    })

    // The real ps, the real parent/child relation: the helper is ours and alive, and does not block.
    await vi.waitFor(async () => {await swap.waitForBundleProcesses()}, { timeout: 15_000 })
    expect(helper.exitCode).toBeNull()

    const runtime = path.join(bundle, 'Contents', 'Resources')

    await fs.mkdir(runtime, { recursive: true })
    await fs.symlink(process.execPath, path.join(runtime, 'python3'))
    const python = spawn(path.join(runtime, 'python3'), ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })

    children.push(python)
    await vi.waitFor(async () => {await expect(swap.waitForBundleProcesses()).rejects.toThrow('still running')}, { timeout: 15_000 })
    python.kill('SIGKILL')
    await vi.waitFor(async () => {await swap.waitForBundleProcesses()}, { timeout: 15_000 })
  })

  it('rejects a tamper between prepare and the click, and leaves the installed app alone', async () => {
    const w = await prepared()
    const bundle = path.join(w.root, (await fs.readdir(w.root)).find(name => name.startsWith('update-'))!, 'Atum.app')

    await fs.writeFile(path.join(bundle, 'Contents', 'Resources', 'runtime.py'), 'print("evil")\n')
    await expect(w.swap.install({ relaunch: true })).rejects.toThrow('tamper')
    expect(await version(w.target)).toContain('1.0.0')
    // The launcher already exists (re-review F2), so it reopens the intact old app; no journal is left behind.
    expect(w.swap.waiterRunning).toBe(true)
    expect(readJournal(w.home, w.root)).toBeNull()
    expect((await fs.readdir(w.handoffDirectory)).sort()).toEqual([])
  })

  it('has the launcher running before a slow click-time re-check finishes, so the exit backstop can never leave Atum closed with nothing to reopen it', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {release = resolve})

    const w = await prepared({ tools: { seal: async bundle => {await gate;

 return snapshot(bundle)} } })

    const installing = w.swap.install({ relaunch: true })

    // The re-check is still stat-walking. The launcher and its journal must already exist.
    await vi.waitFor(() => expect(w.spawnWaiter).toHaveBeenCalledOnce(), { timeout: 2000 })
    expect(w.swap.waiterRunning).toBe(true)
    expect(readJournal(w.home, w.root)).toMatchObject({ target: w.target, relaunch: true })
    expect(await version(w.target)).toContain('1.0.0')
    release()
    await installing
    expect(await version(w.target)).toContain('1.0.1')
  })

  it('still refuses a staged app that fails a slow click-time re-check, with the launcher already there to reopen the old one', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {release = resolve})
    let bundle = ''

    const w = await prepared({
      tools: {
        seal: async directory => {
          await gate
          await fs.writeFile(path.join(directory, 'Contents', 'Resources', 'runtime.py'), 'print("evil")\n')

          return snapshot(directory)
        }
      }
    })

    bundle = (await fs.readdir(w.root)).find(name => name.startsWith('update-'))!
    expect(bundle).toBeTruthy()
    const installing = w.swap.install({ relaunch: true })
    const settled = expect(installing).rejects.toThrow('tamper')

    await vi.waitFor(() => expect(w.swap.waiterRunning).toBe(true), { timeout: 2000 })
    release()
    await settled
    expect(await version(w.target)).toContain('1.0.0')
    expect(readJournal(w.home, w.root)).toBeNull()
  })

  it('catches a tamper in the window after the click check and puts the old app back', async () => {
    let bundle = ''
    let tampered = false

    const w = await prepared({
      tools: {
        // Runs after the click-time re-check and before the renames.
        processes: async () => {
          if (!tampered) {
            tampered = true
            await fs.writeFile(path.join(bundle, 'Contents', 'Resources', 'runtime.py'), 'print("evil")\n')
          }

          return []
        }
      }
    })

    bundle = path.join(w.root, (await fs.readdir(w.root)).find(name => name.startsWith('update-'))!, 'Atum.app')
    await expect(w.swap.install({ relaunch: true })).rejects.toThrow('after swap')
    expect(await version(w.target)).toContain('1.0.0')
    await expect(fs.stat(path.join(w.root, 'previous.app'))).rejects.toThrow()
    expect(readJournal(w.home, w.root)).toBeNull()
  })

  it('does not touch the installed app when the launcher cannot start', async () => {
    const w = await prepared({ tools: { spawnWaiter: async () => {throw new Error('spawn /bin/sh ENOENT')} } })

    await expect(w.swap.install({ relaunch: true })).rejects.toThrow('ENOENT')
    expect(w.swap.waiterRunning).toBe(false)
    expect(await version(w.target)).toContain('1.0.0')
    expect(readJournal(w.home, w.root)).toBeNull()
  })

  it('refuses to install what was never prepared', async () => {
    const w = await world()

    await expect(w.swap.install({ relaunch: true })).rejects.toThrow('tamper')
  })
})
