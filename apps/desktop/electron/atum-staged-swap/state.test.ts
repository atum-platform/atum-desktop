import { renameSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { snapshot, snapshotSync } from './stage'
import {
  blockingProcesses,
  ineligible,
  isNotarizedAssessment,
  isPinnedTeam,
  launchDecision,
  type LaunchFacts,
  parseJournal,
  parseProcesses,
  safeArchivePaths,
  sameSigningTeam,
  snapshotMatches,
  type StageState,
  swapSync,
  transition,
  undoSwapSync
} from './state'
import { temporaryRoots } from './test-fixtures'

const roots = temporaryRoots()

afterEach(roots.cleanup)

const eligible = {
  enabled: true, macMajor: 26, translocated: false, writable: true, sameVolume: true, gktool: true,
  freeBytes: 8 * 1024 ** 3, bundleBytes: 1024 ** 3, zipBytes: 512 * 1024 ** 2
}

describe('staging trust', () => {
  it('rejects archive paths that could escape extraction', () => {
    expect(safeArchivePaths('Test.app/Contents/MacOS/Test\nTest.app/Contents/Info.plist\n')).toBe(true)

    for (const name of ['/tmp/escape', '../escape', 'App/../../escape', 'App\\escape', 'App\u0000escape']) {expect(safeArchivePaths(name)).toBe(false)}
  })

  it('requires matching nonempty Developer ID teams, and the pinned one', () => {
    expect(sameSigningTeam('TeamIdentifier=7D5FC62RXD', 'TeamIdentifier=7D5FC62RXD')).toBe(true)
    expect(sameSigningTeam('TeamIdentifier=7D5FC62RXD', 'TeamIdentifier=XXXXXXXXXX')).toBe(false)
    expect(sameSigningTeam('TeamIdentifier=not set', 'TeamIdentifier=not set')).toBe(false)
    expect(sameSigningTeam('', '')).toBe(false)
    expect(isPinnedTeam('Identifier=x\nTeamIdentifier=7D5FC62RXD\n')).toBe(true)
    expect(isPinnedTeam('TeamIdentifier=XXXXXXXXXX')).toBe(false)
  })

  it('accepts only a notarized spctl assessment', () => {
    expect(isNotarizedAssessment('/x.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: A (T)')).toBe(true)
    expect(isNotarizedAssessment('/x.app: accepted\nsource=Developer ID\n')).toBe(false)
    expect(isNotarizedAssessment('/x.app: rejected\nsource=no usable signature')).toBe(false)
    expect(isNotarizedAssessment('note: source=Notarized Developer ID is mentioned mid-line')).toBe(false)
  })

  it('reserves expanded app, rollback, ZIP and working room, and needs gktool', () => {
    expect(ineligible(eligible)).toBeNull()
    expect(ineligible({ ...eligible, freeBytes: 2 * eligible.bundleBytes + eligible.zipBytes })).toBe('disk')
    expect(ineligible({ ...eligible, freeBytes: Number.NaN })).toBe('disk')
    expect(ineligible({ ...eligible, writable: false })).toBe('permissions')
    expect(ineligible({ ...eligible, sameVolume: false })).toBe('volume')
    expect(ineligible({ ...eligible, translocated: true })).toBe('translocated')
    expect(ineligible({ ...eligible, enabled: false })).toBe('disabled')
    expect(ineligible({ ...eligible, macMajor: 12 })).toBe('macos')
    expect(ineligible({ ...eligible, gktool: false })).toBe('gktool')
  })

  it('reaches Restart only after staging and verification', () => {
    let state: StageState = 'download'

    for (const next of ['stage', 'verify', 'ready', 'swap', 'relaunch'] as StageState[]) {state = transition(state, next)}
    expect(state).toBe('relaunch')
    expect(() => transition('download', 'ready')).toThrow()
  })

  it.each(['download', 'verify', 'stage', 'ready', 'swap', 'relaunch'] as StageState[])('falls to stock from %s', state => {
    expect(transition(state, 'failure')).toBe('fallback')
  })
})

describe('seal', () => {
  it('detects same-size writes, mode changes, additions and escaped symlinks on real files', async () => {
    const root = await roots.make()

    await fs.writeFile(path.join(root, 'runtime.py'), 'old')
    const before = await snapshot(root)

    expect(snapshotMatches(before, await snapshot(root))).toBe(true)
    expect(snapshotMatches(before, snapshotSync(root))).toBe(true)
    await fs.writeFile(path.join(root, 'runtime.py'), 'new')
    expect(snapshotMatches(before, await snapshot(root))).toBe(false)
    const edited = await snapshot(root)

    await fs.chmod(path.join(root, 'runtime.py'), 0o700)
    expect(snapshotMatches(edited, await snapshot(root))).toBe(false)
    const mode = await snapshot(root)

    await fs.writeFile(path.join(root, '__proto__'), 'tracked')
    expect(snapshotMatches(mode, await snapshot(root))).toBe(false)
    expect((await snapshot(root)).__proto__).toBeTypeOf('string')
    await fs.symlink('/usr/bin/true', path.join(root, 'escape'))
    await expect(snapshot(root)).rejects.toThrow('escapes')
    expect(() => snapshotSync(root)).toThrow('escapes')
  })

  it('refuses a hard link planted next to a staged file', async () => {
    const root = await roots.make()
    const outside = await roots.make()

    await fs.writeFile(path.join(root, 'runtime.py'), 'code')
    await fs.link(path.join(root, 'runtime.py'), path.join(outside, 'writable-alias'))
    await expect(snapshot(root)).rejects.toThrow('hard link')
    expect(() => snapshotSync(root)).toThrow('hard link')
  })

  it('ignores only the entries the rename itself changes', async () => {
    const root = await roots.make()

    await fs.mkdir(path.join(root, 'App.app'))
    await fs.writeFile(path.join(root, 'App.app', 'file'), 'x')
    const before = await snapshot(path.join(root, 'App.app'))
    const moved = path.join(root, 'Moved.app')

    await fs.rename(path.join(root, 'App.app'), moved)
    const after = await snapshot(moved)

    expect(snapshotMatches(before, after, [''])).toBe(true)
    await fs.writeFile(path.join(moved, 'file'), 'y')
    expect(snapshotMatches(before, await snapshot(moved), [''])).toBe(false)
  })
})

describe('swap', () => {
  async function pair() {
    const root = await roots.make()
    const target = path.join(root, 'target.app')
    const staged = path.join(root, 'new.app')
    const backup = path.join(root, 'old.app')

    await fs.mkdir(target)
    await fs.mkdir(staged)
    await fs.writeFile(path.join(target, 'version'), 'old')
    await fs.writeFile(path.join(staged, 'version'), 'new')

    return { target, staged, backup }
  }

  it.each([0, 1, 2])('keeps a complete installed app with rename failure at %s', async failure => {
    const { target, staged, backup } = await pair()
    let call = 0

    const swap = () => swapSync(target, staged, backup, (from, to) => {
      if (++call === failure) {throw new Error('injected rename failure')}
      renameSync(from, to)
    })

    if (failure) {expect(swap).toThrow()} else {swap()}
    expect(await fs.readFile(path.join(target, 'version'), 'utf8')).toBe(failure ? 'old' : 'new')

    if (!failure) {expect(await fs.readFile(path.join(backup, 'version'), 'utf8')).toBe('old')}
  })

  it('retains the complete backup if restoration also fails', async () => {
    const { target, staged, backup } = await pair()
    let call = 0

    expect(() => swapSync(target, staged, backup, (from, to) => {
      if (++call > 1) {throw new Error('rename refused')}
      renameSync(from, to)
    })).toThrow(AggregateError)
    expect(await fs.readFile(path.join(backup, 'version'), 'utf8')).toBe('old')
  })

  it('reverses a finished swap that failed the post-swap check', async () => {
    const { target, staged, backup } = await pair()

    swapSync(target, staged, backup)
    undoSwapSync(target, staged, backup)
    expect(await fs.readFile(path.join(target, 'version'), 'utf8')).toBe('old')
    expect(await fs.readFile(path.join(staged, 'version'), 'utf8')).toBe('new')
    await expect(fs.stat(backup)).rejects.toThrow()
  })
})

describe('journal', () => {
  const home = '/home/example'
  const root = `${home}/Library/Caches/id/staged-swap`

  const valid = {
    v: 2, target: '/Applications/Atum.app', backup: `${root}/previous.app`, next: `${root}/update-abc123/Atum.app`,
    fromVersion: '1.0.0', toVersion: '1.0.1', relaunch: true
  }

  it('accepts only paths this updater could have written', () => {
    expect(parseJournal(valid, home, root)).toEqual(valid)
    expect(parseJournal({ ...valid, target: `${home}/Applications/Atum.app` }, home, root)).not.toBeNull()
    expect(parseJournal({ ...valid, target: '/tmp/Atum.app' }, home, root)).toBeNull()
    expect(parseJournal({ ...valid, target: '/Applications/sub/Atum.app' }, home, root)).toBeNull()
    expect(parseJournal({ ...valid, backup: '/Applications/previous.app' }, home, root)).toBeNull()
    expect(parseJournal({ ...valid, next: `${root}/other/Atum.app` }, home, root)).toBeNull()
    expect(parseJournal({ ...valid, next: '/Applications/Other.app' }, home, root)).toBeNull()
    expect(parseJournal({ ...valid, v: 1 }, home, root)).toBeNull()
    expect(parseJournal({ ...valid, relaunch: 'yes' }, home, root)).toBeNull()
    expect(parseJournal(null, home, root)).toBeNull()
  })
})

describe('launch decision', () => {
  const base: LaunchFacts = {
    self: 'target', targetExists: true, backupExists: true, shown: false, startedPid: null, startedAlive: false
  }

  it.each(['backup', 'next', 'other', 'target'] as const)('puts the backup back when the target is missing, whichever copy (%s) launches', self => {
    expect(launchDecision({ ...base, self, targetExists: false })).toBe('restore-missing-target')
  })

  it('does nothing without a target and without a backup', () => {
    expect(launchDecision({ ...base, targetExists: false, backupExists: false })).toBe('none')
  })

  it('drops a journal whose swap never started or whose backup was retired', () => {
    expect(launchDecision({ ...base, backupExists: false })).toBe('drop-stale-journal')
  })

  it('restores when the backup runs and the new version never showed a window', () => {
    expect(launchDecision({ ...base, self: 'backup' })).toBe('restore-failed-update')
  })

  it('does not run the backup once the new version has shown a window', () => {
    expect(launchDecision({ ...base, self: 'backup', shown: true })).toBe('leave-healthy-backup')
    expect(launchDecision({ ...base, self: 'target', shown: true })).toBe('none')
  })

  it('treats a first launch, or a slow one still alive, as healthy', () => {
    expect(launchDecision(base)).toBe('none')
    expect(launchDecision({ ...base, startedPid: 123, startedAlive: true })).toBe('none')
  })

  it('rolls back a new version whose earlier launch started and died before its window', () => {
    expect(launchDecision({ ...base, startedPid: 123, startedAlive: false })).toBe('restore-failed-update')
  })
})

describe('process fence', () => {
  const bundle = '/Applications/Atum Matrix Candidate.app'
  const frameworks = `${bundle}/Contents/Frameworks`
  const main = 100

  const rows = (...entries: Array<[number, number, string]>) => entries.map(([pid, ppid, command]) => ({ pid, ppid, command }))

  it('parses ps output with spaces in the command', () => {
    expect(parseProcesses(`  101   100 ${frameworks}/Atum Helper.app/Contents/MacOS/Atum Helper\n  bad line\n`)).toEqual(
      rows([101, 100, `${frameworks}/Atum Helper.app/Contents/MacOS/Atum Helper`])
    )
  })

  it("tolerates Electron's own utility and GPU helpers, which live as long as the main process", () => {
    const live = rows(
      [100, 1, `${bundle}/Contents/MacOS/Atum Matrix Candidate`],
      [101, main, `${frameworks}/Atum Helper.app/Contents/MacOS/Atum Helper`],
      [102, main, `${frameworks}/Atum Helper (GPU).app/Contents/MacOS/Atum Helper (GPU)`]
    )

    expect(blockingProcesses(live, bundle, main)).toEqual([])
  })

  it('waits for renderers, runtime children, and helpers that are not the main process\'s own', () => {
    const renderer = [103, main, `${frameworks}/Atum Helper (Renderer).app/Contents/MacOS/Atum Helper (Renderer)`] as [number, number, string]
    const python = [104, main, `${bundle}/Contents/Resources/runtime/bin/python3`] as [number, number, string]
    const strayHelper = [105, 999, `${frameworks}/Atum Helper.app/Contents/MacOS/Atum Helper`] as [number, number, string]
    const unrelated = [106, 1, '/Applications/Other.app/Contents/MacOS/Other'] as [number, number, string]

    expect(blockingProcesses(rows(renderer, python, strayHelper, unrelated), bundle, main).map(row => row.pid)).toEqual([103, 104, 105])
  })

  it('matches by path prefix, not by substring', () => {
    const lookalike = rows([107, main, `${bundle}-copy/Contents/Resources/python3`])

    expect(blockingProcesses(lookalike, bundle, main)).toEqual([])
  })
})
