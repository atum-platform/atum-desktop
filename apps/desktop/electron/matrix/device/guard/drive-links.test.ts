import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DRIVE_BINDING_MARKER } from '../drive-root-identity'
import { playedStat, waitForFilesystemClock } from '../fs-identity.fixture'

import { DriveLinkScanner } from './drive-links'

const dirs: string[] = []
const scanners: DriveLinkScanner[] = []
afterEach(() => {
  for (const scanner of scanners.splice(0)) {scanner.dispose()}

  for (const dir of dirs.splice(0)) {rmSync(dir, { recursive: true, force: true })}
})

function drive() {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'atum-links-')))
  dirs.push(base)
  const root = path.join(base, 'Drive')
  mkdirSync(path.join(root, 'a', 'b'), { recursive: true })
  // A Drive root carries the engine's marker: it is what tells the root from a replacement on a
  // filesystem that keeps no creation time, so a walk is not restarted at every step there.
  writeFileSync(path.join(root, DRIVE_BINDING_MARKER), '{}')

  return { base, root }
}

// A generous default clock budget: a test that expects one step to finish must not depend on how busy the CI host is
// (the step is time-sliced). Tests of the time slice itself pass their own stepMs.
function scanner(options: ConstructorParameters<typeof DriveLinkScanner>[0] = {}) {
  const made = new DriveLinkScanner({ stepMs: 60_000, ...options })
  scanners.push(made)

  return made
}

/** A path is denied when it is listed, or lies under a listed folder. */
const covered = (denied: readonly string[], file: string) => denied.some(entry => file === entry || file.startsWith(entry + path.sep))

/** A fake clock that moves one millisecond every time it is read. */
function ticking() {
  let clock = 0

  return () => (clock += 1)
}

describe('DriveLinkScanner', () => {
  it('finds a regular file that has another name, in any depth, and nothing else', () => {
    const { base, root } = drive()
    writeFileSync(path.join(base, 'outside'), 'secret')
    writeFileSync(path.join(root, 'plain.md'), 'x')
    linkSync(path.join(base, 'outside'), path.join(root, 'a', 'b', 'sneaky'))
    symlinkSync(path.join(base, 'outside'), path.join(root, 'soft'))
    mkdirSync(path.join(base, 'elsewhere'))
    symlinkSync(path.join(base, 'elsewhere'), path.join(root, 'dirlink'))

    expect(scanner().step([root])).toEqual([path.join(root, 'a', 'b', 'sneaky')])
  })

  it('covers a large tree over several steps instead of blocking one', () => {
    const { base, root } = drive()
    writeFileSync(path.join(base, 'outside'), 'secret')

    for (let n = 0; n < 6; n++) {
      mkdirSync(path.join(root, `d${n}`))
      writeFileSync(path.join(root, `d${n}`, 'f'), 'x')
    }

    linkSync(path.join(base, 'outside'), path.join(root, 'd5', 'late'))
    const walker = scanner({ stepEntries: 3 })
    const late = path.join(root, 'd5', 'late')
    let found = walker.step([root])
    expect(found, 'one bounded step does not finish the walk').not.toContain(late)

    for (let step = 0; step < 30 && !found.includes(late); step++) {found = walker.step([root])}
    expect(found).toEqual([late])
  })

  it('rescans after the interval, forgets a link that was removed, and restarts on a replaced root', () => {
    const { base, root } = drive()
    writeFileSync(path.join(base, 'outside'), 'secret')
    linkSync(path.join(base, 'outside'), path.join(root, 'one'))
    let clock = 0
    const walker = scanner({ now: () => clock, rescanAfterMs: 1000 })
    expect(walker.step([root])).toEqual([path.join(root, 'one')])

    rmSync(path.join(root, 'one'))
    clock = 500
    expect(walker.step([root]), 'not rescanned yet').toEqual([path.join(root, 'one')])
    clock = 1500
    expect(walker.step([root]), 'the rescan finished and the removed link is no longer denied').toEqual([])

    // Linux stamps files from a coarse clock and may give the new directory the old inode number back:
    // let the clock tick so the new root is told apart by its creation time (played below, deterministically).
    waitForFilesystemClock(base)
    rmSync(root, { recursive: true })
    mkdirSync(root)
    writeFileSync(path.join(root, 'two'), 'x')
    linkSync(path.join(root, 'two'), path.join(root, 'three'))
    expect(walker.step([root]).sort(), 'a replaced root is scanned from scratch').toEqual([path.join(root, 'three'), path.join(root, 'two')])
  })

  // A filesystem that gives a removed directory's inode number to the next one made (ext4 and overlay do;
  // the first CI run on Linux caught it) cannot be told apart by device and inode. These play it.
  describe('when the filesystem reuses the inode number of a removed root', () => {
    it('walks the replacement from scratch, told apart by its creation time', () => {
      const { base, root } = drive()
      writeFileSync(path.join(base, 'outside'), 'secret')
      linkSync(path.join(base, 'outside'), path.join(root, 'one'))
      let birthtimeMs = 1000
      const walker = scanner({ stat: playedStat({ [root]: () => ({ ino: 42, birthtimeMs }) }) })
      expect(walker.step([root])).toEqual([path.join(root, 'one')])

      rmSync(path.join(root, 'one'))
      expect(walker.step([root]), 'control: the same root is not walked again before the interval').toEqual([path.join(root, 'one')])

      birthtimeMs = 2000 // same device, same inode number, a directory created later
      expect(walker.step([root]), 'a different root is scanned from scratch: the removed link is no longer denied').toEqual([])
    })

    it('finds the links of the replacement, which the old walk had not seen', () => {
      const { base, root } = drive()
      writeFileSync(path.join(base, 'outside'), 'secret')
      let birthtimeMs = 1000
      const walker = scanner({ stat: playedStat({ [root]: () => ({ ino: 42, birthtimeMs }) }) })
      expect(walker.step([root]), 'an empty Drive: finished').toEqual([])

      linkSync(path.join(base, 'outside'), path.join(root, 'late'))
      expect(walker.step([root]), 'control: a finished walk is not repeated before the interval').toEqual([])

      birthtimeMs = 2000
      expect(walker.step([root])).toEqual([path.join(root, 'late')])
    })

    it('tells it apart by the binding marker where the filesystem keeps no creation time', () => {
      const { base, root } = drive()
      writeFileSync(path.join(base, 'outside'), 'secret')
      linkSync(path.join(base, 'outside'), path.join(root, 'one'))
      let marker = { ino: 77, mtimeMs: 5000 }

      const walker = scanner({
        stat: playedStat({
          [root]: () => ({ ino: 42, birthtimeMs: 0 }),
          [path.join(root, DRIVE_BINDING_MARKER)]: () => ({ ino: marker.ino, birthtimeMs: 0, mtimeMs: marker.mtimeMs })
        })
      })

      expect(walker.step([root])).toEqual([path.join(root, 'one')])
      rmSync(path.join(root, 'one'))
      expect(walker.step([root]), 'control: the same marker, the same root').toEqual([path.join(root, 'one')])

      marker = { ino: 77, mtimeMs: 5001 } // a recreated marker that got its inode number back
      expect(walker.step([root])).toEqual([])
    })
  })

  it('skips a root that is gone or is a link, and stops walking a root that is no longer listed', () => {
    const { base, root } = drive()
    writeFileSync(path.join(base, 'outside'), 'secret')
    linkSync(path.join(base, 'outside'), path.join(root, 'one'))

    expect(scanner().step([path.join(base, 'missing')])).toEqual([])
    symlinkSync(root, path.join(base, 'RootLink'))
    expect(scanner().step([path.join(base, 'RootLink')])).toEqual([])

    const walker = scanner()
    expect(walker.step([root])).toEqual([path.join(root, 'one')])
    expect(walker.step([]), 'signed out: nothing is listed').toEqual([])
  })
})

describe('DriveLinkScanner: one huge directory', () => {
  /** `count` plain files and `links` hard links to one outside file, all directly in the Drive root. */
  function crowded(count: number, links: number) {
    const { base, root } = drive()
    writeFileSync(path.join(base, 'outside'), 'secret')

    for (let n = 0; n < count; n++) {writeFileSync(path.join(root, `f${String(n).padStart(5, '0')}`), '')}
    const linked: string[] = []

    for (let n = 0; n < links; n++) {
      const link = path.join(root, `link-${n}`)
      linkSync(path.join(base, 'outside'), link)
      linked.push(link)
    }

    return { root, linked }
  }

  it('reads it a slice at a time, never more than the entry budget per step, and still finds every link', () => {
    const { root, linked } = crowded(1500, 5)
    const walker = scanner({ stepEntries: 100, stepMs: 60_000 })
    let denied: string[] = []
    let steps = 0
    let completed = false

    for (let attempt = 0; attempt < 40; attempt++) {
      const before = walker.examined
      denied = walker.step([root])
      const examined = walker.examined - before

      expect(examined, `step ${attempt}`).toBeLessThanOrEqual(100)

      if (examined === 0) {
        completed = true
        break
      }

      steps += 1
    }

    // Directory enumeration order is filesystem-specific: tmpfs may return every link in the first
    // slice. Drive the walk until its first no-op step so the entry cap itself proves the slicing.
    expect(completed, 'finished the walk').toBe(true)
    expect([...denied].sort()).toEqual([...linked].sort())
    expect(steps, 'took more than one step').toBeGreaterThan(1)
    // The 1500 files and 5 links, the folders `a` and `a/b`, and the marker.
    expect(walker.examined, 'each entry was read once').toBe(1500 + 5 + 2 + 1)
  })

  it('checks the clock for every entry, not once per directory', () => {
    const { root } = crowded(3000, 0)
    const walker = scanner({ now: ticking(), stepMs: 50, stepEntries: 1_000_000 })

    walker.step([root])
    expect(walker.examined, 'about one entry per tick').toBeLessThanOrEqual(60)
    expect(walker.examined).toBeGreaterThan(0)
  })

  it('keeps the directory open between steps and closes it when the walk ends or the scanner is disposed', () => {
    const { root } = crowded(300, 1)
    const walker = scanner({ stepEntries: 100, stepMs: 60_000 })

    for (let step = 0; step < 20; step++) {walker.step([root])}
    expect(walker.step([root])).toHaveLength(1)

    const half = scanner({ stepEntries: 100, stepMs: 60_000 })
    half.step([root])
    expect(() => half.dispose()).not.toThrow()
    expect(() => half.dispose()).not.toThrow()
  })
})

describe('DriveLinkScanner: past the cap a link is never left writable', () => {
  function tree(links: Record<string, number>, plain: Record<string, number> = {}) {
    const { base, root } = drive()
    writeFileSync(path.join(base, 'outside'), 'secret')
    const linked: string[] = []

    for (const [folder, count] of Object.entries(links)) {
      mkdirSync(path.join(root, folder), { recursive: true })

      for (let n = 0; n < count; n++) {
        const link = path.join(root, folder, `l${n}`)
        linkSync(path.join(base, 'outside'), link)
        linked.push(link)
      }
    }

    for (const [folder, count] of Object.entries(plain)) {
      mkdirSync(path.join(root, folder), { recursive: true })

      for (let n = 0; n < count; n++) {writeFileSync(path.join(root, folder, `p${n}`), 'x')}
    }

    return { base, root, linked }
  }

  it('denies the folder holding a link found after the file cap, and keeps scanning the others', () => {
    const { root, linked } = tree({ one: 5, two: 2, three: 1 }, { clean: 3 })
    const denied = scanner({ maxDenied: 3 }).step([root])

    for (const link of linked) {expect(covered(denied, link), link).toBe(true)}
    expect(denied.some(entry => path.dirname(entry) === root && path.basename(entry) === 'clean'), 'a folder with no link is not denied').toBe(false)
    expect(covered(denied, path.join(root, 'clean', 'p0')), 'nor what is in it').toBe(false)
    expect(covered(denied, path.join(root, 'notes-elsewhere')), 'nor the rest of the Drive').toBe(false)
    expect(denied.filter(entry => !entry.endsWith(path.sep) && path.basename(entry).startsWith('l')).length, 'at most the file cap are listed one by one').toBeLessThanOrEqual(3)
  })

  it('gives the whole folder of a link found past the cap, plain neighbours included', () => {
    const { root, linked } = tree({ one: 2 }, { one: 2 })
    const denied = scanner({ maxDenied: 1 }).step([root])

    for (const link of linked) {expect(covered(denied, link)).toBe(true)}
    expect(covered(denied, path.join(root, 'one', 'p0')), 'a neighbour of the folder-denied link is denied with it').toBe(true)
    expect(covered(denied, path.join(root, 'notes.md'))).toBe(false)
  })

  it('does not walk inside a folder it has denied as a whole', () => {
    const { root } = tree({ one: 3 }, { 'one/deep': 400 })
    const limited = scanner({ maxDenied: 1, stepEntries: 100_000 })
    const denied = limited.step([root])

    expect(covered(denied, path.join(root, 'one', 'deep', 'p0')), 'the subfolder is under the denied folder').toBe(true)
    expect(limited.examined, 'its 400 files are never read').toBeLessThan(100)
  })

  it('folds folders into their parents past the folder cap, in the limit the Drive root', () => {
    const { root, linked } = tree({ 'g/a': 1, 'g/b': 1, 'g/c': 1, 'h/d': 1, 'h/e': 1, 'i/f': 1 })
    const folded = scanner({ maxDenied: 0, maxFolders: 3 }).step([root])

    for (const link of linked) {expect(covered(folded, link), link).toBe(true)}
    expect(folded.length).toBeLessThanOrEqual(3)

    const total = scanner({ maxDenied: 0, maxFolders: 1 }).step([root])
    expect(total, 'a single entry that covers everything').toHaveLength(1)

    for (const link of linked) {expect(covered(total, link), link).toBe(true)}
  })

  it('denies the root itself when the link sits right in it past the cap', () => {
    const { base, root } = drive()
    writeFileSync(path.join(base, 'outside'), 'secret')
    linkSync(path.join(base, 'outside'), path.join(root, 'x'))
    linkSync(path.join(base, 'outside'), path.join(root, 'y'))

    expect(scanner({ maxDenied: 1 }).step([root])).toEqual([root])
  })

  it('stays within the cap across a rescan, and a folder denial lasts only as long as the links do', () => {
    const { base, root } = drive()
    writeFileSync(path.join(base, 'outside'), 'secret')
    mkdirSync(path.join(root, 'sub'))
    linkSync(path.join(base, 'outside'), path.join(root, 'sub', 'x'))
    linkSync(path.join(base, 'outside'), path.join(root, 'sub', 'y'))
    let clock = 0
    const walker = scanner({ maxDenied: 1, now: () => clock, rescanAfterMs: 1000 })

    expect(walker.step([root])).toEqual([path.join(root, 'sub')])
    rmSync(path.join(root, 'sub', 'x'))
    rmSync(path.join(root, 'sub', 'y'))
    clock = 2000
    expect(walker.step([root]), 'the rescan finds none: nothing is denied').toEqual([])
  })
})
