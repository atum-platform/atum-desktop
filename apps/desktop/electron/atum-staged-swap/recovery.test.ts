import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { cleanStaleStages, confirmHealthyStart, retireBackup } from './cleanup'
import { recoverAtStartup, recoverStagedSwap } from './recovery'
import {
  consumeFailureNotice,
  isStockOnly,
  markShown,
  markStarted,
  readJournal,
  stagedSwapEnabled,
  stageRoot,
  writeFileAtomicSync,
  writeJournal
} from './store'
import { temporaryRoots } from './test-fixtures'

const roots = temporaryRoots()

afterEach(roots.cleanup)

const ID = 'com.atum.matrix-candidate'

/** A disposable Applications folder, Caches staging root and update-handoff folder. */
async function world(options: { target?: boolean; backup?: boolean; journal?: boolean } = {}) {
  const home = await roots.make()
  const root = stageRoot(home, ID)
  const target = path.join(home, 'Applications', 'Atum.app')
  const backup = path.join(root, 'previous.app')
  const next = path.join(root, 'update-abc123', 'Atum.app')
  const handoffDirectory = path.join(home, 'userdata', 'update-handoff')

  const write = async (bundle: string, text: string) => {
    await fs.mkdir(bundle, { recursive: true })
    await fs.writeFile(path.join(bundle, 'version'), text)
  }

  await fs.mkdir(handoffDirectory, { recursive: true })
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.mkdir(path.dirname(next), { recursive: true })

  // State after a finished swap: the new version sits in the target, the old one in the backup.
  if (options.target !== false) {await write(target, 'new')}

  if (options.backup !== false) {await write(backup, 'old')}

  if (options.journal !== false) {
    writeJournal(root, { v: 2, target, backup, next, fromVersion: '1.0.0', toVersion: '1.0.1', relaunch: true })
  }

  const calls = { open: [] as string[], terminate: [] as string[], exit: 0, verify: [] as string[] }

  const run = (self: string, extra: Partial<Parameters<typeof recoverStagedSwap>[0]> = {}) => recoverStagedSwap({
    home, id: ID, bundle: self, handoffDirectory, log: () => {},
    exit: () => {calls.exit++},
    open: async bundle => {calls.open.push(bundle)},
    verify: async bundle => {calls.verify.push(bundle)},
    terminate: async bundle => {calls.terminate.push(bundle)},
    ...extra
  })

  const text = (bundle: string) => fs.readFile(path.join(bundle, 'version'), 'utf8')

  return { home, root, target, backup, next, handoffDirectory, calls, run, text, write }
}

describe('recovery after the two-rename gap', () => {
  it.each(['backup', 'next', 'other'] as const)('puts the backup back and reopens the app, whichever copy (%s) launches', async which => {
    const w = await world({ target: false })
    const selves = { backup: w.backup, next: w.next, other: path.join(w.home, 'Elsewhere.app') }

    await w.write(w.next, 'staged')
    expect(await w.run(selves[which])).toBe(true)
    expect(await w.text(w.target)).toBe('old')
    expect(w.calls.open).toEqual([w.target])
    expect(w.calls.exit).toBe(1)
    expect(w.calls.verify).toEqual([w.backup])
    expect(readJournal(w.home, w.root)).toBeNull()
    expect(isStockOnly(w.root, '1.0.1')).toBe(true)
  })

  it('says so once, and only to the version that was running', async () => {
    const w = await world({ target: false })

    await w.run(w.backup)
    expect(consumeFailureNotice(w.root, '1.0.0')).toBe(true)
    expect(consumeFailureNotice(w.root, '1.0.0')).toBe(false)
  })

  it('does not put back a backup that fails verification', async () => {
    const w = await world({ target: false })

    await expect(w.run(w.backup, { verify: async () => {throw new Error('bad signature')} })).rejects.toThrow('bad signature')
    await expect(fs.stat(w.target)).rejects.toThrow()
    expect(w.calls.exit).toBe(0)
  })

  it('survives a torn or hostile journal without throwing or touching anything', async () => {
    const w = await world({ target: false, journal: false })

    await fs.writeFile(path.join(w.root, 'journal.json'), '{"v":2,"target":"/Applic')
    expect(await w.run(w.backup)).toBe(false)
    await fs.writeFile(path.join(w.root, 'journal.json'), JSON.stringify({ v: 2, target: '/etc/passwd.app', backup: '/x', next: '/y', fromVersion: 'a', toVersion: 'b', relaunch: true }))
    expect(await w.run(w.backup)).toBe(false)
    expect(w.calls.open).toEqual([])
  })

  it('writes the journal without ever exposing a torn file', async () => {
    const dir = await roots.make()
    const file = path.join(dir, 'journal.json')

    writeFileAtomicSync(file, JSON.stringify({ a: 1 }))
    writeFileAtomicSync(file, JSON.stringify({ a: 2 }))
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ a: 2 })
    expect((await fs.readdir(dir)).sort()).toEqual(['journal.json'])
  })
})

describe('recovery after the swap', () => {
  it('swaps the old app back when the backup runs and the new version never showed a window', async () => {
    const w = await world()

    expect(await w.run(w.backup)).toBe(true)
    expect(w.calls.terminate).toEqual([w.target])
    expect(await w.text(w.target)).toBe('old')
    const failed = (await fs.readdir(path.dirname(w.next))).filter(name => name.includes('.failed-'))

    expect(failed).toHaveLength(1)
    expect(await w.text(path.join(path.dirname(w.next), failed[0]))).toBe('new')
    expect(w.calls.open).toEqual([w.target])
    expect(isStockOnly(w.root, '1.0.1')).toBe(true)
    expect(readJournal(w.home, w.root)).toBeNull()
  })

  it('leaves a healthy update alone and just opens the real app when the backup is launched', async () => {
    const w = await world()

    markShown(w.handoffDirectory)
    expect(await w.run(w.backup)).toBe(true)
    expect(await w.text(w.target)).toBe('new')
    expect(await w.text(w.backup)).toBe('old')
    expect(w.calls.open).toEqual([w.target])
    expect(w.calls.terminate).toEqual([])
    expect(isStockOnly(w.root, '1.0.1')).toBe(false)
  })

  it('lets the new version run on its first launch, and while a slow one is still alive', async () => {
    const w = await world()

    expect(await w.run(w.target)).toBe(false)
    markStarted(w.handoffDirectory, process.pid)
    expect(await w.run(w.target)).toBe(false)
    expect(w.calls.exit).toBe(0)
  })

  it('rolls the new version back when an earlier launch of it died before showing a window', async () => {
    const w = await world()
    const gone = spawn('/usr/bin/true', [], { stdio: 'ignore' })

    await new Promise(resolve => gone.once('exit', resolve))
    markStarted(w.handoffDirectory, gone.pid!)
    expect(await w.run(w.target)).toBe(true)
    expect(w.calls.terminate).toEqual([])
    expect(await w.text(w.target)).toBe('old')
    expect(w.calls.open).toEqual([w.target])
  })

  it('drops a journal whose swap never started', async () => {
    const w = await world({ backup: false })

    expect(await w.run(w.target)).toBe(false)
    expect(readJournal(w.home, w.root)).toBeNull()
    expect(await w.text(w.target)).toBe('new')
  })
})

// The staged swap is macOS-only (ditto bundles, Apple-silicon updates); its file-moving suites run on macOS.
describe.skipIf(process.platform !== 'darwin')('cleanup', () => {
  it('deletes staged copies and an unrecoverable backup, but keeps what a live journal references', async () => {
    const w = await world({ journal: false })

    await w.write(path.join(w.root, 'update-zzz999', 'Atum.app'), 'stale')
    expect((await cleanStaleStages({ home: w.home, id: ID })).map(entry => path.basename(entry)).sort())
      .toEqual(['previous.app', 'update-abc123', 'update-zzz999'])
    expect(await fs.readdir(w.root)).toEqual([])

    const kept = await world()

    await kept.write(path.join(kept.root, 'update-zzz999', 'Atum.app'), 'stale')
    await cleanStaleStages({ home: kept.home, id: ID })
    expect((await fs.readdir(kept.root)).sort()).toEqual(['journal.json', 'previous.app', 'update-abc123'])
  })

  it('retires the rollback copy only once the new version has shown a window', async () => {
    const w = await world()
    const options = { home: w.home, id: ID, bundle: w.target, handoffDirectory: w.handoffDirectory, log: () => {} }

    expect(await retireBackup(options)).toBe(false)
    expect(await w.text(w.backup)).toBe('old')
    markShown(w.handoffDirectory)
    expect(await retireBackup({ ...options, bundle: path.join(w.home, 'Other.app') })).toBe(false)
    expect(await retireBackup(options)).toBe(true)
    await expect(fs.stat(w.backup)).rejects.toThrow()
    expect(readJournal(w.home, w.root)).toBeNull()
  })

  it('keeps the journal when the delete fails, so the next launch retries and staging is not stuck', async () => {
    const w = await world()

    markShown(w.handoffDirectory)
    const options = { home: w.home, id: ID, bundle: w.target, handoffDirectory: w.handoffDirectory, log: () => {} }

    expect(await retireBackup({ ...options, remove: async () => false })).toBe(false)
    expect(readJournal(w.home, w.root)).not.toBeNull()
    expect(await retireBackup(options)).toBe(true)
  })
})

describe('kill switch', () => {
  it('is off unless updates.stagedSwap is exactly true', async () => {
    const dir = await roots.make()
    const file = path.join(dir, 'updates.json')

    expect(stagedSwapEnabled(file)).toBe(false)
    await fs.writeFile(file, '{ not json')
    expect(stagedSwapEnabled(file)).toBe(false)

    for (const value of [{}, { updates: {} }, { updates: { stagedSwap: 'true' } }, { updates: { stagedSwap: false } }, { stagedSwap: true }]) {
      await fs.writeFile(file, JSON.stringify(value))
      expect(stagedSwapEnabled(file)).toBe(false)
    }

    await fs.writeFile(file, JSON.stringify({ channel: 'latest', updates: { stagedSwap: true } }))
    expect(stagedSwapEnabled(file)).toBe(true)
  })
})

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** The pid of a process that has already exited. */
async function deadPid(): Promise<number> {
  const gone = spawn('/usr/bin/true', [], { stdio: 'ignore' })

  await new Promise(resolve => gone.once('exit', resolve))

  return gone.pid!
}

describe.skipIf(process.platform !== 'darwin')('a hidden login launch after an install on Quit (re-review F3)', () => {
  it('counts as healthy: the next launch keeps the update and the rollback copy is retired', async () => {
    const w = await world()

    // Quit-install state: markers cleared, journal and backup in place. The first launch is a hidden login item:
    // it owns the instance lock (started) and gets through start-up, but never puts a window up.
    markStarted(w.handoffDirectory, await deadPid())
    clearTimeout(confirmHealthyStart({ home: w.home, id: ID, bundle: w.target, handoffDirectory: w.handoffDirectory, log: () => {} }))
    // That process is now gone (logout, or the person quit it). The next, visible launch must not roll back.
    expect(await w.run(w.target)).toBe(false)
    expect(w.calls.exit).toBe(0)
    expect(await w.text(w.target)).toBe('new')
    expect(isStockOnly(w.root, '1.0.1')).toBe(false)
    expect(await retireBackup({ home: w.home, id: ID, bundle: w.target, handoffDirectory: w.handoffDirectory, log: () => {} })).toBe(true)
    await expect(fs.stat(w.backup)).rejects.toThrow()
    expect(readJournal(w.home, w.root)).toBeNull()
  })
})

describe('a hidden login launch with no staged swap pending', () => {
  it('writes nothing, so a switched-off Mac behaves as before', async () => {
    const w = await world({ journal: false })

    expect(confirmHealthyStart({ hidden: true, home: w.home, id: ID, bundle: w.target, handoffDirectory: w.handoffDirectory, log: () => {} })).toBeNull()
    expect(await fs.readdir(w.handoffDirectory)).toEqual([])
  })
})

describe('recovery is single-flight (re-review F4)', () => {
  it('runs once when the waiter-launched backup and the panel-launched new version recover at the same time; the loser leaves quietly', async () => {
    const w = await world()

    markStarted(w.handoffDirectory, await deadPid())

    const slowVerify = async (bundle: string) => {
      w.calls.verify.push(bundle)
      await sleep(80)
    }

    const results = await Promise.all([w.run(w.backup, { verify: slowVerify }), w.run(w.target, { verify: slowVerify })])

    expect(results).toEqual([true, true])
    expect(w.calls.verify).toEqual([w.backup])
    expect(w.calls.open).toEqual([w.target])
    expect(w.calls.exit).toBe(2)
    expect(await w.text(w.target)).toBe('old')
    expect((await fs.readdir(path.dirname(w.next))).filter(name => name.includes('.failed-'))).toHaveLength(1)
    expect(await fs.readdir(w.root)).not.toContain('recovery.lock')
  })

  it('does not touch anything while another live recovery holds the lock, and does not throw', async () => {
    const w = await world()

    await fs.writeFile(path.join(w.root, 'recovery.lock'), String(process.pid))
    expect(await w.run(w.backup)).toBe(true)
    expect(w.calls.exit).toBe(1)
    expect(w.calls.verify).toEqual([])
    expect(w.calls.open).toEqual([])
    expect(await w.text(w.target)).toBe('new')
    expect(readJournal(w.home, w.root)).not.toBeNull()
  })

  it('takes over a lock left by a crashed recovery, or one older than ten minutes', async () => {
    const dead = await world()

    await fs.writeFile(path.join(dead.root, 'recovery.lock'), String(await deadPid()))
    expect(await dead.run(dead.backup)).toBe(true)
    expect(await dead.text(dead.target)).toBe('old')

    const old = await world()

    await fs.writeFile(path.join(old.root, 'recovery.lock'), String(process.pid))
    expect(await old.run(old.backup, { now: () => Date.now() + 11 * 60_000 })).toBe(true)
    expect(await old.text(old.target)).toBe('old')
  })

  it('releases the lock when recovery fails, so a later launch can try again', async () => {
    const w = await world()

    await expect(w.run(w.backup, { verify: async () => {throw new Error('bad signature')} })).rejects.toThrow('bad signature')
    expect(await fs.readdir(w.root)).not.toContain('recovery.lock')
  })

  it('does not take the lock on a launch that has nothing to recover', async () => {
    const w = await world()

    expect(await w.run(w.target)).toBe(false)
    expect(await fs.readdir(w.root)).not.toContain('recovery.lock')
  })
})

describe('start-up result (re-review F5)', () => {
  it('says "exiting" when recovery took over, so the caller never goes on to take the instance lock', async () => {
    const w = await world({ target: false })
    const exits: string[] = []
    const base = { home: w.home, id: ID, handoffDirectory: w.handoffDirectory, log: () => {}, open: async () => {}, verify: async () => {}, terminate: async () => {} }

    expect(await recoverAtStartup({ ...base, bundle: w.backup, exit: () => {exits.push('exit')} })).toBe('exiting')
    expect(exits).toEqual(['exit'])
  })

  it('says "continue" with no journal, and "failed" (updates paused) only when recovery really threw', async () => {
    const quiet = await world({ journal: false })
    const base = { handoffDirectory: quiet.handoffDirectory, log: () => {}, exit: () => {throw new Error('must not exit')} }

    expect(await recoverAtStartup({ ...base, home: quiet.home, id: ID, bundle: quiet.target })).toBe('continue')

    const broken = await world({ target: false })

    expect(await recoverAtStartup({
      ...base, home: broken.home, id: ID, bundle: broken.backup, handoffDirectory: broken.handoffDirectory,
      open: async () => {}, verify: async () => {throw new Error('bad signature')}
    })).toBe('failed')
  })

  it('a recovery that lost the race exits quietly and is never reported as a failure that pauses updates', async () => {
    const w = await world()

    await fs.writeFile(path.join(w.root, 'recovery.lock'), String(process.pid))
    const exits: string[] = []

    expect(await recoverAtStartup({
      home: w.home, id: ID, bundle: w.backup, handoffDirectory: w.handoffDirectory, log: () => {}, exit: () => {exits.push('exit')},
      open: async () => {}, verify: async () => {}, terminate: async () => {}
    })).toBe('exiting')
    expect(exits).toEqual(['exit'])
  })
})
