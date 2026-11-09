import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DRIVE_BINDING_MARKER, readRootIdentity, type RootIdentity, sameRoot, type StatFacts, type StatFn } from './drive-root-identity'

// "Is this still the directory I looked at?" for a Drive root (review round 3, 2026-10-24): device and
// inode alone are not enough where a filesystem hands a removed directory's inode number to the next
// one. The logic is tested on played numbers; two cases touch the real filesystem.

type Kind = 'dir' | 'file' | 'link'

const facts = (kind: Kind, numbers: Partial<Pick<StatFacts, 'dev' | 'ino' | 'birthtimeMs' | 'mtimeMs'>> = {}): StatFacts => ({
  dev: 1,
  ino: 10,
  birthtimeMs: 1000,
  mtimeMs: 5000,
  ...numbers,
  isDirectory: () => kind === 'dir',
  isFile: () => kind === 'file',
  isSymbolicLink: () => kind === 'link'
})

const ROOT = '/Volumes/Atum/Drive'
const MARKER = path.join(ROOT, DRIVE_BINDING_MARKER)

/** A `stat` over a table; a path that is not in it does not exist. */
const table =
  (entries: Record<string, StatFacts>): StatFn =>
  file => {
    const found = entries[file]

    if (!found) {
      throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' })
    }

    return found
  }

function identity(root: StatFacts, marker?: StatFacts): RootIdentity {
  const read = readRootIdentity(ROOT, table(marker ? { [ROOT]: root, [MARKER]: marker } : { [ROOT]: root }))

  if (!read) {
    throw new Error('expected an identity')
  }

  return read
}

describe('a root with a creation time', () => {
  const before = identity(facts('dir'), facts('file'))

  it('is the same directory while device, inode and creation time are the same', () => {
    expect(sameRoot(before, identity(facts('dir'), facts('file')))).toBe(true)
  })

  it('is NOT the same when the inode number was handed to a directory created later (the Linux reuse)', () => {
    expect(sameRoot(before, identity(facts('dir', { birthtimeMs: 1001 }), facts('file')))).toBe(false)
  })

  it('is not the same on another inode or another device', () => {
    expect(sameRoot(before, identity(facts('dir', { ino: 11 }), facts('file')))).toBe(false)
    expect(sameRoot(before, identity(facts('dir', { dev: 2 }), facts('file')))).toBe(false)
  })

  it('does not look at the marker, so the engine rewriting it does not change which directory this is', () => {
    expect(sameRoot(before, identity(facts('dir'), facts('file', { ino: 99, mtimeMs: 9000 })))).toBe(true)
    expect(sameRoot(before, identity(facts('dir')))).toBe(true)
  })

  it('is not the same when the filesystem stopped reporting a creation time', () => {
    expect(sameRoot(before, identity(facts('dir', { birthtimeMs: 0 }), facts('file')))).toBe(false)
  })
})

describe('a root on a filesystem that keeps no creation time', () => {
  const none = { birthtimeMs: 0 }
  const before = identity(facts('dir', none), facts('file', { ...none, ino: 77, mtimeMs: 5000 }))

  it('is the same directory while the marker is the same file', () => {
    expect(sameRoot(before, identity(facts('dir', none), facts('file', { ...none, ino: 77, mtimeMs: 5000 })))).toBe(true)
  })

  it('is NOT the same when the marker was recreated, even with the same inode numbers', () => {
    // Root inode repeated, marker inode repeated, but it is a newer file.
    expect(sameRoot(before, identity(facts('dir', none), facts('file', { ...none, ino: 77, mtimeMs: 5001 })))).toBe(false)
    // A different marker inode at the old modification time.
    expect(sameRoot(before, identity(facts('dir', none), facts('file', { ...none, ino: 78, mtimeMs: 5000 })))).toBe(false)
  })

  it('prefers the marker’s creation time to its modification time when it has one', () => {
    const born = identity(facts('dir', none), facts('file', { ino: 77, birthtimeMs: 4000, mtimeMs: 5000 }))

    expect(sameRoot(born, identity(facts('dir', none), facts('file', { ino: 77, birthtimeMs: 4000, mtimeMs: 6000 })))).toBe(true)
    expect(sameRoot(born, identity(facts('dir', none), facts('file', { ino: 77, birthtimeMs: 4001, mtimeMs: 5000 })))).toBe(false)
  })

  it('cannot tell without a marker on both sides, and then it is not the same', () => {
    const bare = identity(facts('dir', none))

    expect(bare.marker).toBeNull()
    expect(sameRoot(bare, identity(facts('dir', none)))).toBe(false)
    expect(sameRoot(bare, identity(facts('dir', none), facts('file', none)))).toBe(false)
    expect(sameRoot(before, identity(facts('dir', none)))).toBe(false)
  })

  it('still needs the device and inode to repeat', () => {
    expect(sameRoot(before, identity(facts('dir', { ...none, ino: 11 }), facts('file', { ...none, ino: 77, mtimeMs: 5000 })))).toBe(false)
  })
})

describe('what is a creation time', () => {
  it('is only a positive number; the epoch, nothing or garbage means the filesystem kept none', () => {
    for (const birthtimeMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(identity(facts('dir', { birthtimeMs }), facts('file')).birthtimeMs, String(birthtimeMs)).toBe(0)
    }

    expect(identity(facts('dir', { birthtimeMs: 12.5 }), facts('file')).birthtimeMs).toBe(12.5)
  })
})

describe('readRootIdentity', () => {
  it('has none for a path that is missing, unreadable, a link or not a directory', () => {
    expect(readRootIdentity(ROOT, table({}))).toBeNull()
    expect(readRootIdentity(ROOT, table({ [ROOT]: facts('link') }))).toBeNull()
    expect(readRootIdentity(ROOT, table({ [ROOT]: facts('file') }))).toBeNull()
    expect(readRootIdentity(ROOT, () => { throw new Error('EACCES') })).toBeNull()
  })

  it('takes the marker only when it is a regular file', () => {
    expect(readRootIdentity(ROOT, table({ [ROOT]: facts('dir'), [MARKER]: facts('file', { ino: 7, birthtimeMs: 0, mtimeMs: 42 }) }))?.marker).toEqual({ ino: 7, stampMs: 42 })
    expect(readRootIdentity(ROOT, table({ [ROOT]: facts('dir'), [MARKER]: facts('dir') }))?.marker, 'a directory is not the marker').toBeNull()
    expect(readRootIdentity(ROOT, table({ [ROOT]: facts('dir'), [MARKER]: facts('link') }))?.marker, 'nor is a link').toBeNull()
    expect(readRootIdentity(ROOT, table({ [ROOT]: facts('dir') }))?.marker, 'nor is nothing').toBeNull()
  })
})

describe('on the real filesystem', () => {
  const bases: string[] = []

  afterEach(() => {
    for (const base of bases.splice(0)) {
      rmSync(base, { recursive: true, force: true })
    }
  })

  const made = () => {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'atum-root-identity-')))
    bases.push(base)

    return base
  }

  it('reads the directory and its marker, and sees the same root twice', () => {
    const root = path.join(made(), 'Drive')
    mkdirSync(root)
    writeFileSync(path.join(root, DRIVE_BINDING_MARKER), '{}')

    const first = readRootIdentity(root)
    const second = readRootIdentity(root)

    expect(first?.marker).not.toBeNull()
    expect(first && second && sameRoot(first, second)).toBe(true)
  })

  it('has none for a symlink to a directory, and none for a root that was removed', () => {
    const base = made()
    const root = path.join(base, 'Drive')
    mkdirSync(root)
    symlinkSync(root, path.join(base, 'Link'))

    expect(readRootIdentity(path.join(base, 'Link'))).toBeNull()
    rmSync(root, { recursive: true })
    expect(readRootIdentity(root)).toBeNull()
  })
})
