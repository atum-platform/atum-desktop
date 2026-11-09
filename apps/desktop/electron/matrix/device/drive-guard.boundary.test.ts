/**
 * The owner's Drive under the real macOS sandbox (review 2026-10-24, P1s). Profiles come from the
 * shipping path: `DriveWorkspaceCopies` (which roots are writable) -> `DeviceHostSupervisor.profileFor`
 * (protected paths, hard-link walk, Seatbelt generator) -> `/usr/bin/sandbox-exec`. macOS only.
 *
 * What these pin down, and what they deliberately do not claim:
 * - ordinary edits in the current Drive work; the root, engine state and a past account's root hold;
 * - a past root replaced by a symlink never makes the link's target writable; a current root whose
 *   directory changed is not writable at all;
 * - a hard link to a protected file that was made outside the sandbox is denied by its Drive name,
 *   and the sandbox itself cannot make one;
 * - `python Drive/job.py` runs (intended), `./Drive/run.sh` does not;
 * - the kernel does NOT stop `rm -rf <Drive>` from removing ordinary files before the pinned root
 *   makes it fail: the classifier gates that command (`drive-delete.ts`), asserted here against the
 *   same roots the profile uses.
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DeviceGrant } from './contracts'
import { DriveLinkScanner } from './guard/drive-links'
import { DeviceHostSupervisor } from './host'
import { classifyExecute } from './policy'
import { DriveWorkspaceCopies } from './workspace'

const darwin = process.platform === 'darwin'

describe.skipIf(!darwin)('the owner’s Drive at the real sandbox boundary', () => {
  let base = ''
  let home = ''
  let current = ''
  let userData = ''
  let engine: { root: string | null }
  let copies: DriveWorkspaceCopies
  let links: DriveLinkScanner | { step(roots: readonly string[]): string[] }
  let host: DeviceHostSupervisor

  const put = (file: string, content: string) => {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
  }

  const makeDrive = (root: string) => {
    put(path.join(root, '.atum-drive-binding.json'), '{}\n')
    put(path.join(root, '.atum-drive-journal.db'), 'journal\n')
    put(path.join(root, 'notes.md'), 'notes\n')
  }

  const grant = (): DeviceGrant => ({
    grantId: randomUUID(), ownerUserId: '@owner:atum.test', agentPrincipal: randomUUID(), agentUserId: '@t:atum.test',
    invocationId: randomUUID(), originKind: 'device', originAssertionHash: null, writerEpoch: { leaseGeneration: 3, leaseTokenHash: 'h'.repeat(43) },
    targetDeviceServiceId: randomUUID(), enrollmentEpoch: 1, accountEpoch: 1, scopes: ['terminal', 'files'], connectionId: randomUUID(),
    issuedAt: 0, expiresAt: 1
  })

  /** Run one command under the profile a device command would get right now. */
  const sh = (script: string) => {
    const profile = path.join(base, `profile-${randomUUID()}.sb`)
    writeFileSync(profile, host.profileFor([], null))
    const result = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, '/bin/bash', '-c', script], {
      cwd: home, encoding: 'utf8', timeout: 20_000, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home }
    })

    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }

  beforeEach(async () => {
    base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'atum-dg-')))
    home = path.join(base, 'home')
    current = path.join(home, 'Atum', 'Drive')
    userData = path.join(home, 'Library', 'Application Support', 'Atum')
    engine = { root: current }
    mkdirSync(path.join(home, '.ssh'), { recursive: true })
    mkdirSync(userData, { recursive: true })
    writeFileSync(path.join(home, '.ssh', 'id_canary'), 'ssh-canary\n')
    writeFileSync(path.join(userData, 'vault'), 'vault-canary\n')
    makeDrive(current)

    copies = new DriveWorkspaceCopies({
      drive: { manifestFor: async () => (engine.root ? { root: engine.root, files: new Map() } : null) },
      workspaceLabel: async () => '/Agents/T',
      tasksRoot: path.join(home, 'Atum Tasks'),
      artifactsRoot: path.join(base, 'artifacts')
    })

    await copies.refresh()
    links = new DriveLinkScanner()

    host = new DeviceHostSupervisor({
      launcherPath: '/res/launcher',
      pythonPath: '/res/python',
      hermesRoot: '/res/hermes',
      egressProxyPort: 51515,
      egressProxyToken: 'x'.repeat(40),
      home,
      runtimeRoots: () => ({
        userData,
        driveRoot: copies.driveRoot(),
        driveRoots: copies.driveRoots(),
        writableDriveRoots: copies.writableDriveRoots(),
        writeOutsideWorkingRoot: true,
        agentWorkingRoots: [path.join(home, 'Atum Tasks')]
      }),
      cuaDriverSocket: path.join(base, 'cua.sock'),
      realpath: file => realpathSync.native(file),
      driveLinks: { step: roots => links.step(roots) } as DriveLinkScanner
    })
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('lets ordinary edits through and keeps the pins, the engine state and the app’s secrets', () => {
    expect(sh(`mkdir -p "${current}/Q3" && echo deck > "${current}/Q3/deck.md" && mv "${current}/Q3/deck.md" "${current}/Q3/final.md" && rm "${current}/Q3/final.md" && rm -rf "${current}/Q3"`).status).toBe(0)
    expect(sh(`echo edited > "${current}/notes.md"`).status).toBe(0)
    expect(readFileSync(path.join(current, 'notes.md'), 'utf8')).toBe('edited\n')
    expect(sh(`echo x >> "${current}/.atum-drive-journal.db"`).status).not.toBe(0)
    expect(sh(`mv "${current}" "${current}-gone"`).status).not.toBe(0)
    expect(sh(`cat "${home}/.ssh/id_canary"`).status).not.toBe(0)
    expect(readFileSync(path.join(current, '.atum-drive-journal.db'), 'utf8')).toBe('journal\n')
  })

  it('has the classifier gate the delete the kernel cannot tell apart from an ordinary one', () => {
    const drive = { home, roots: copies.driveRoots() }

    for (const command of [
      `rm -rf "${current}"`,
      `rm -rf "${current}"/*`,
      `rm -rf "${path.dirname(current)}"`,
      `find "${current}" -delete`,
      // the review's round-2 bypasses: a single `&`, brace expansion, and an unfiltered find
      `true & rm -rf "${current}"`,
      `rm -rf "${current}"/{*,.*}`,
      `find "${current}" -type f -delete`
    ]) {
      expect([...classifyExecute({ tool: 'terminal', args: { command } }, drive)], command).toEqual(['bulk_destructive'])
    }

    for (const command of [
      `rm "${current}/Q3/old.md"`,
      `rm -rf "${current}/Q3"`,
      `mv "${current}/a.md" "${current}/b.md"`,
      `find "${current}" -name '*.tmp' -delete`,
      `find "${current}/Q3" -delete`,
      `true & rm -rf "${current}/Q3/"{a,b}`
    ]) {
      expect(classifyExecute({ tool: 'terminal', args: { command } }, drive).size, command).toBe(0)
    }
  })

  describe('stale roots', () => {
    it('a past account’s root is deny-only, and replacing it with a symlink does not make the target writable', async () => {
      const old = path.join(home, 'Old Account', 'Drive')
      makeDrive(old)
      engine.root = old
      await copies.refresh()
      engine.root = current
      await copies.refresh()
      expect(new Set(copies.driveRoots())).toEqual(new Set([current, old]))
      expect(copies.writableDriveRoots()).toEqual([current])
      expect(sh(`echo x > "${old}/notes.md"`).status, 'past root, untouched').not.toBe(0)

      // The old root is removed and a symlink to a folder outside HOME (writable temp space) takes its place.
      const outside = path.join(base, 'outside')
      put(path.join(outside, 'precious.txt'), 'precious\n')
      rmSync(old, { recursive: true })
      symlinkSync(outside, old)

      expect(sh(`echo pwned > "${old}/precious.txt"`).status).not.toBe(0)
      expect(sh(`echo pwned > "${outside}/precious.txt"`).status).not.toBe(0)
      expect(sh(`rm "${outside}/precious.txt"`).status).not.toBe(0)
      expect(readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('precious\n')
      expect(sh(`echo ok > "${current}/notes.md"`).status, 'the current Drive is unaffected').toBe(0)
    })

    it('without the deny, that target IS writable (control)', () => {
      const outside = path.join(base, 'outside')
      put(path.join(outside, 'precious.txt'), 'precious\n')
      expect(sh(`echo free > "${outside}/precious.txt"`).status).toBe(0)
    })

    it('a current root whose directory changed is not writable at all, and is write-denied through its new target', async () => {
      const outside = path.join(base, 'outside')
      makeDrive(outside)
      renameSync(current, `${current}-moved`)
      symlinkSync(outside, current)

      expect(copies.writableDriveRoots()).toEqual([])
      expect(sh(`echo pwned > "${current}/notes.md"`).status).not.toBe(0)
      expect(sh(`echo pwned > "${outside}/notes.md"`).status).not.toBe(0)
      expect(readFileSync(path.join(outside, 'notes.md'), 'utf8')).toBe('notes\n')
    })

    it('a recreated directory at the same path is not writable until the engine vouches for it again', async () => {
      rmSync(current, { recursive: true })
      makeDrive(current)

      expect(sh(`echo x > "${current}/notes.md"`).status).not.toBe(0)
      await copies.refresh()
      expect(sh(`echo x > "${current}/notes.md"`).status).toBe(0)
    })

    it('signed out: nothing in Drive is writable, everything stays readable', async () => {
      engine.root = null
      await copies.refresh()

      expect(sh(`echo x > "${current}/notes.md"`).status).not.toBe(0)
      expect(sh(`cat "${current}/notes.md"`).stdout.trim()).toBe('notes')
    })
  })

  describe('hard links', () => {
    it('denies a pre-existing hard link to a protected file by its Drive name, and leaves the original alone', () => {
      linkSync(path.join(home, '.ssh', 'id_canary'), path.join(current, 'innocent.txt'))
      linkSync(path.join(userData, 'vault'), path.join(current, 'vault.txt'))

      expect(sh(`cat "${current}/innocent.txt"`).status).not.toBe(0)
      expect(sh(`echo planted >> "${current}/innocent.txt"`).status).not.toBe(0)
      expect(sh(`cat "${current}/vault.txt"`).status).not.toBe(0)
      expect(sh(`echo planted >> "${current}/vault.txt"`).status).not.toBe(0)
      expect(sh(`rm "${current}/innocent.txt"`).status).not.toBe(0)
      expect(readFileSync(path.join(home, '.ssh', 'id_canary'), 'utf8')).toBe('ssh-canary\n')
      expect(readFileSync(path.join(userData, 'vault'), 'utf8')).toBe('vault-canary\n')
      expect(sh(`echo ok > "${current}/notes.md"`).status, 'ordinary files are unaffected').toBe(0)
    })

    it('pins the folder holding the link, so it cannot be renamed away from its denied path', () => {
      mkdirSync(path.join(current, 'sub'))
      linkSync(path.join(home, '.ssh', 'id_canary'), path.join(current, 'sub', 'k'))

      expect(sh(`mv "${current}/sub" "${current}/elsewhere" && cat "${current}/elsewhere/k"`).status).not.toBe(0)
      expect(sh(`cat "${current}/sub/k"`).status).not.toBe(0)
    })

    it('past the file cap, the folder holding another link is denied as a whole (the cap never leaves a link writable)', () => {
      links = new DriveLinkScanner({ maxDenied: 1 })
      put(path.join(current, 'sub', 'plain.txt'), 'plain\n')
      linkSync(path.join(home, '.ssh', 'id_canary'), path.join(current, 'sub', 'k1'))
      linkSync(path.join(userData, 'vault'), path.join(current, 'sub', 'k2'))

      for (const name of ['k1', 'k2']) {
        expect(sh(`cat "${current}/sub/${name}"`).status, name).not.toBe(0)
        expect(sh(`echo planted >> "${current}/sub/${name}"`).status, name).not.toBe(0)
        expect(sh(`rm "${current}/sub/${name}"`).status, name).not.toBe(0)
      }

      expect(sh(`cat "${current}/sub/plain.txt"`).status, 'the folder is denied as a whole').not.toBe(0)
      expect(sh(`mv "${current}/sub" "${current}/elsewhere"`).status, 'and cannot be renamed away').not.toBe(0)
      expect(readFileSync(path.join(home, '.ssh', 'id_canary'), 'utf8')).toBe('ssh-canary\n')
      expect(readFileSync(path.join(userData, 'vault'), 'utf8')).toBe('vault-canary\n')
      expect(sh(`echo ok > "${current}/notes.md"`).status, 'the rest of the Drive is unaffected').toBe(0)
    })

    it('control: without the walk the same link reads and writes through (what the walk is for)', () => {
      linkSync(path.join(home, '.ssh', 'id_canary'), path.join(current, 'innocent.txt'))
      links = { step: () => [] }

      expect(sh(`cat "${current}/innocent.txt"`).stdout.trim()).toBe('ssh-canary')
    })

    it('the sandbox cannot make such a link itself', () => {
      expect(sh(`ln "${home}/.ssh/id_canary" "${current}/new.txt"`).status).not.toBe(0)
      expect(sh(`ln "${userData}/vault" "${current}/vault.txt"`).status).not.toBe(0)
      expect(sh(`cat "${current}/new.txt"`).status).not.toBe(0)
    })
  })

  describe('programs in the Drive', () => {
    it('runs a script through an interpreter (intended), but not as a program by path', () => {
      put(path.join(current, 'job.py'), 'print("ran via interpreter")\n')
      put(path.join(current, 'run.sh'), '#!/bin/sh\necho ran directly\n')
      chmodSync(path.join(current, 'run.sh'), 0o755)

      expect(sh(`/usr/bin/python3 "${current}/job.py"`).stdout.trim()).toBe('ran via interpreter')
      expect(sh(`/bin/sh "${current}/run.sh"`).stdout.trim()).toBe('ran directly')
      expect(sh(`"${current}/run.sh"`).status).not.toBe(0)
      expect(sh(`"${current}/run.sh"`).stdout).not.toContain('ran directly')
    })
  })
})
