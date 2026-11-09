import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { DeviceGrant } from './contracts'
import { DRIVE_BINDING_MARKER, type StatFn } from './drive-root-identity'
import { playedStat, waitForFilesystemClock } from './fs-identity.fixture'
import { type DriveJournalFacts, DriveWorkspaceCopies } from './workspace'

// Preserve the recovery and user-visible behavior covered by this path.
// publication guard against a direct edit made in the Drive folder while a copy was open.

const bases: string[] = []
afterEach(() => {
  for (const base of bases.splice(0)) {rmSync(base, { recursive: true, force: true })}
})

const write = (file: string, content: string) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function drive(base: string, name: string): string {
  const root = path.join(base, name)
  write(path.join(root, '.atum-drive-binding.json'), '{}')
  mkdirSync(path.join(root, 'Agents', 'T'), { recursive: true })

  return root
}

/** `statFor` plays the filesystem under the Drive root (it is given the root's path): see `fs-identity.fixture.ts`. */
function setup(statFor?: (root: string) => StatFn) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'atum-ws-roots-')))
  bases.push(base)
  const state: { root: string | null; clean: Map<string, DriveJournalFacts>; saved: string | null } = { root: drive(base, 'Drive A'), clean: new Map(), saved: null }

  const copies = new DriveWorkspaceCopies({
    drive: {
      manifestFor: async paths => (state.root ? { root: state.root, files: new Map(paths.map(p => [p, state.clean.get(p) ?? null])) } : null),
      savedRoot: () => state.saved
    },
    workspaceLabel: async () => '/Agents/T',
    tasksRoot: path.join(base, 'Atum Tasks'),
    artifactsRoot: path.join(base, 'userData', 'artifacts'),
    stat: statFor?.(state.root!)
  })

  const grant = (): DeviceGrant => ({
    grantId: randomUUID(), ownerUserId: '@owner:atum.test', agentPrincipal: randomUUID(), agentUserId: '@t:atum.test',
    invocationId: randomUUID(), originKind: 'device', originAssertionHash: null, writerEpoch: { leaseGeneration: 3, leaseTokenHash: 'h'.repeat(43) },
    targetDeviceServiceId: randomUUID(), enrollmentEpoch: 1, accountEpoch: 1, scopes: ['terminal', 'files'], connectionId: randomUUID(),
    issuedAt: 0, expiresAt: 1
  })

  const bind = (root: string, relative: string, etag: string) =>
    state.clean.set(`Agents/T/${relative}`, { resource: { storage: 's', space: 'personal', opaque: relative }, etag, size: statSync(path.join(root, 'Agents', 'T', relative)).size })

  return { base, state, copies, grant, bind }
}

describe('the roots a device command may write', () => {
  it('is the current account’s Drive, identity-verified, and nothing before the engine vouches for one', async () => {
    const s = setup()
    expect(s.copies.writableDriveRoots(), 'nothing learned yet').toEqual([])
    await s.copies.refresh()
    expect(s.copies.writableDriveRoots()).toEqual([s.state.root])
    expect(s.copies.driveRoots()).toEqual([s.state.root])
  })

  it('needs the engine’s binding marker as a regular file', async () => {
    const s = setup()
    await s.copies.refresh()
    rmSync(path.join(s.state.root!, '.atum-drive-binding.json'))
    expect(s.copies.writableDriveRoots()).toEqual([])
    mkdirSync(path.join(s.state.root!, '.atum-drive-binding.json'))
    expect(s.copies.writableDriveRoots(), 'a directory is not the marker').toEqual([])
  })

  it('fails closed when the root is replaced by a symlink; the old root stays learned (deny-only)', async () => {
    const s = setup()
    const old = s.state.root!
    await s.copies.refresh()
    const elsewhere = drive(s.base, 'Somewhere Else')
    renameSync(old, `${old}-moved`)
    symlinkSync(elsewhere, old)

    expect(s.copies.writableDriveRoots()).toEqual([])
    expect(s.copies.driveRoots()).toEqual([old])
  })

  it('fails closed when the directory at the root is not the one the engine vouched for (inode change)', async () => {
    const s = setup()
    const root = s.state.root!
    await s.copies.refresh()
    // Linux stamps files from a coarse clock and may give the new directory the old inode number back:
    // let the clock tick so the new directory is told apart by its creation time (see the played cases below).
    waitForFilesystemClock(s.base)
    rmSync(root, { recursive: true })
    write(path.join(root, '.atum-drive-binding.json'), '{}')

    expect(s.copies.writableDriveRoots(), 'same path and marker, new directory').toEqual([])
    await s.copies.refresh()
    expect(s.copies.writableDriveRoots(), 'the engine vouches for the new directory').toEqual([root])
  })

  // A filesystem that gives a removed directory's inode number to the next one made (ext4 and overlay do;
  // the first CI run on Linux caught it) cannot be told apart by device and inode. These play it.
  describe('when the filesystem reuses the inode number of a removed directory', () => {
    const marker = (root: string) => path.join(root, DRIVE_BINDING_MARKER)

    it('tells the new directory apart by its creation time', async () => {
      let birthtimeMs = 1000
      const s = setup(root => playedStat({ [root]: () => ({ ino: 42, birthtimeMs }) }))
      const root = s.state.root!
      await s.copies.refresh()
      expect(s.copies.writableDriveRoots(), 'control: nothing changed').toEqual([root])

      birthtimeMs = 2000 // same device, same inode number, created later
      expect(s.copies.writableDriveRoots(), 'a recreated root with the old inode number').toEqual([])
      expect(s.copies.driveRoots(), 'still protected (deny-only)').toEqual([root])

      await s.copies.refresh()
      expect(s.copies.writableDriveRoots(), 'the engine vouches for the new directory').toEqual([root])
    })

    it('tells it apart by the binding marker where the filesystem keeps no creation time', async () => {
      let stamp = { ino: 77, mtimeMs: 5000 }

      const s = setup(root =>
        playedStat({
          [root]: () => ({ ino: 42, birthtimeMs: 0 }),
          [marker(root)]: () => ({ ino: stamp.ino, birthtimeMs: 0, mtimeMs: stamp.mtimeMs })
        })
      )

      const root = s.state.root!
      await s.copies.refresh()
      expect(s.copies.writableDriveRoots(), 'control: nothing changed').toEqual([root])

      stamp = { ino: 77, mtimeMs: 5001 } // a recreated marker that got its inode number back
      expect(s.copies.writableDriveRoots(), 'same inode numbers, a newer marker').toEqual([])

      stamp = { ino: 78, mtimeMs: 5000 }
      expect(s.copies.writableDriveRoots(), 'another marker inode').toEqual([])

      await s.copies.refresh()
      expect(s.copies.writableDriveRoots(), 'vouched for again').toEqual([root])
    })

    it('does not write a root it cannot tell apart: no creation time, and no marker when it was vouched for', async () => {
      const s = setup(root => playedStat({ [root]: () => ({ ino: 42, birthtimeMs: 0 }) }))
      const root = s.state.root!
      rmSync(marker(root))
      await s.copies.refresh()
      write(marker(root), '{}') // a marker appears under the same numbers: nothing to compare it with

      expect(s.copies.writableDriveRoots()).toEqual([])
      await s.copies.refresh()
      expect(s.copies.writableDriveRoots(), 'once the engine vouches for it with the marker in place').toEqual([root])
    })
  })

  it('drops the root when the engine stops vouching (signed out, other account, error) but forgets no pin', async () => {
    const s = setup()
    const a = s.state.root!
    await s.copies.refresh()
    expect(s.copies.writableDriveRoots()).toEqual([a])

    s.state.root = null
    await s.copies.refresh()
    expect(s.copies.writableDriveRoots()).toEqual([])
    expect(s.copies.driveRoots()).toEqual([a])

    const b = drive(s.base, 'Drive B')
    s.state.root = b
    await s.copies.refresh()
    expect(s.copies.writableDriveRoots(), 'only the account signed in now').toEqual([b])
    expect(s.copies.driveRoots()).toEqual([a, b])
  })

  it('a saved-but-unvouched folder is learned for pinning, never writable', async () => {
    const s = setup()
    const saved = drive(s.base, 'Saved Only')
    s.state.saved = saved
    s.state.root = null
    await s.copies.refresh()
    expect(s.copies.driveRoots()).toEqual([saved])
    expect(s.copies.writableDriveRoots()).toEqual([])
  })
})

describe('a copy file the owner also edited directly in Drive', () => {
  async function opened() {
    const s = setup()
    const root = s.state.root!
    const folder = path.join(root, 'Agents', 'T')
    write(path.join(folder, 'deck.md'), 'v1')
    write(path.join(folder, 'other.md'), 'o1')
    s.bind(root, 'deck.md', '"e1"')
    s.bind(root, 'other.md', '"o1"')
    const grant = s.grant()
    await s.copies.refresh()
    const { cwd } = await s.copies.prepare(grant)

    return { s, root, folder, grant, cwd }
  }

  it('publishes an ordinary change as before', async () => {
    const { s, grant, cwd } = await opened()
    write(path.join(cwd, 'deck.md'), 'agent version')
    write(path.join(cwd, 'new.md'), 'brand new')
    expect((await s.copies.changes(grant.grantId)).changed.sort()).toEqual(['deck.md', 'new.md'])
  })

  it('withholds it while the Drive edit is unsynced; the agent’s version stays and a note says so', async () => {
    const { s, folder, grant, cwd } = await opened()
    write(path.join(cwd, 'deck.md'), 'agent version')
    write(path.join(cwd, 'other.md'), 'agent other')
    write(path.join(folder, 'deck.md'), 'the owner typed this directly, longer')
    s.state.clean.delete('Agents/T/deck.md')

    expect((await s.copies.changes(grant.grantId)).changed).toEqual(['other.md'])
    expect(readFileSync(path.join(cwd, 'deck.md'), 'utf8')).toBe('agent version')
    expect(readFileSync(path.join(cwd, '.atum', 'DRIVE-CHANGED.txt'), 'utf8')).toContain('deck.md')
  })

  it('withholds a new file when Drive got one of the same name meanwhile', async () => {
    const { s, folder, grant, cwd } = await opened()
    write(path.join(cwd, 'fresh.md'), 'agent made this')
    write(path.join(folder, 'fresh.md'), 'owner made this')

    expect((await s.copies.changes(grant.grantId)).changed).toEqual([])
    expect(existsSync(path.join(cwd, 'fresh.md'))).toBe(true)
  })

  it('leaves it to the controller’s version check once the engine has the Drive version (clean) or Drive is untouched', async () => {
    const { s, root, folder, grant, cwd } = await opened()
    write(path.join(cwd, 'deck.md'), 'agent version')
    write(path.join(cwd, 'other.md'), 'agent other')
    write(path.join(folder, 'deck.md'), 'owner version, since synced')
    s.bind(root, 'deck.md', '"e2"')

    expect((await s.copies.changes(grant.grantId)).changed.sort()).toEqual(['deck.md', 'other.md'])
    expect(existsSync(path.join(cwd, '.atum', 'DRIVE-CHANGED.txt'))).toBe(false)
  })

  it('holds the file when the engine gives no answer', async () => {
    const { s, folder, grant, cwd } = await opened()
    write(path.join(cwd, 'deck.md'), 'agent version')
    write(path.join(folder, 'deck.md'), 'owner version, longer than before')
    s.state.root = null

    expect((await s.copies.changes(grant.grantId)).changed).toEqual([])
  })

  it('names what it held back in the result of changes(), and only then', async () => {
    const { s, folder, grant, cwd } = await opened()
    write(path.join(cwd, 'deck.md'), 'agent version')
    expect(await s.copies.changes(grant.grantId), 'nothing held back, no field').toEqual({ changed: ['deck.md'], deleted: [] })

    write(path.join(folder, 'deck.md'), 'the owner typed this directly, longer')
    s.state.clean.delete('Agents/T/deck.md')
    expect(await s.copies.changes(grant.grantId)).toEqual({ changed: [], deleted: [], withheld: ['deck.md'] })
  })
})

describe('the last look before a file leaves the Mac (publicationGuard)', () => {
  async function opened() {
    const s = setup()
    const root = s.state.root!
    const folder = path.join(root, 'Agents', 'T')
    write(path.join(folder, 'deck.md'), 'v1')
    write(path.join(folder, 'other.md'), 'o1')
    s.bind(root, 'deck.md', '"e1"')
    s.bind(root, 'other.md', '"o1"')
    const grant = s.grant()
    await s.copies.refresh()
    const { cwd } = await s.copies.prepare(grant)
    write(path.join(cwd, 'deck.md'), 'agent version')
    write(path.join(cwd, 'other.md'), 'agent other')

    return { s, root, folder, grant, cwd }
  }

  it('has none for a grant with no copy', () => {
    expect(setup().copies.publicationGuard(randomUUID())).toBeNull()
  })

  it('keeps back the file the owner edited after the freeze, and passes the rest', async () => {
    const { s, folder, grant, cwd } = await opened()
    expect((await s.copies.changes(grant.grantId)).changed.sort(), 'the freeze saw nothing wrong').toEqual(['deck.md', 'other.md'])
    const guard = s.copies.publicationGuard(grant.grantId)!

    expect(await guard(['deck.md', 'other.md'])).toEqual([])
    write(path.join(folder, 'deck.md'), 'the owner typed this after the freeze, longer')
    s.state.clean.delete('Agents/T/deck.md')

    expect(await guard(['other.md'])).toEqual([])
    expect(await guard(['deck.md', 'other.md'])).toEqual(['deck.md'])
    expect(readFileSync(path.join(cwd, 'deck.md'), 'utf8'), 'the agent version stays').toBe('agent version')
    expect(readFileSync(path.join(cwd, '.atum', 'DRIVE-CHANGED.txt'), 'utf8')).toContain('deck.md')
  })

  it('keeps working after the grant ended, and its note lists what both looks held back', async () => {
    const { s, root, folder, grant, cwd } = await opened()
    write(path.join(folder, 'other.md'), 'the owner typed this before the freeze, longer')
    s.state.clean.delete('Agents/T/other.md')
    expect((await s.copies.changes(grant.grantId)).withheld).toEqual(['other.md'])
    const guard = s.copies.publicationGuard(grant.grantId)!
    s.copies.end(grant.grantId)

    write(path.join(folder, 'deck.md'), 'the owner typed this after the freeze, longer')
    s.state.clean.delete('Agents/T/deck.md')
    expect(await guard(['deck.md'])).toEqual(['deck.md'])
    const note = readFileSync(path.join(cwd, '.atum', 'DRIVE-CHANGED.txt'), 'utf8')

    expect(note).toContain('deck.md')
    expect(note).toContain('other.md')
    s.bind(root, 'deck.md', '"e2"')
    expect(await guard(['deck.md']), 'once the engine has the owner version it is the controller’s version check').toEqual([])
  })

  it('holds a file when the engine cannot be asked', async () => {
    const { s, folder, grant } = await opened()
    const guard = s.copies.publicationGuard(grant.grantId)!
    write(path.join(folder, 'deck.md'), 'the owner typed this after the freeze, longer')
    s.state.root = null

    expect(await guard(['deck.md'])).toEqual(['deck.md'])
  })
})
