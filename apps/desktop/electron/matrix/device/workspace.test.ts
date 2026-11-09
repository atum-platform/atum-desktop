import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { DeviceGrant } from './contracts'
import {
  cloneInto,
  CONFLICT_COPY,
  ConflictCopyRelay,
  type DeviceWorkspaceManifest,
  type DriveJournalFacts,
  DriveWorkspaceCopies,
  excludedFromWorkspace,
  pruneWorkspaceCopies
} from './workspace'

// A Mac's Drive working copies (S1 WS-5 device) on real files: the Drive root and ~/Atum Tasks are
// temporary directories on this Mac's own volume (APFS, so the copies are clones); the engine's
// journal facts come from a scripted MatrixDrive.manifestFor.

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true })}
})
const sha = (content: string | Buffer) => createHash('sha256').update(content).digest('hex')

const write = (file: string, content: string | Buffer) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function setup(options: { label?: string | null; clone?: (sources: string[], destination: string) => Promise<void> } = {}) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'atum-ws-copies-')))
  roots.push(home)
  const drive = path.join(home, 'Atum Drive')
  const folder = path.join(drive, 'Agents', 'T')
  mkdirSync(folder, { recursive: true })
  /** Files the engine's journal calls clean, by Drive-root-relative path. */
  const clean = new Map<string, DriveJournalFacts>()
  const asked: string[][] = []

  const copies = new DriveWorkspaceCopies({
    drive: {
      manifestFor: async paths => {
        asked.push([...paths])

        return { root: drive, files: new Map(paths.map(p => [p, clean.get(p) ?? null])) }
      }
    },
    workspaceLabel: async () => (options.label === undefined ? '/Agents/T' : options.label),
    tasksRoot: path.join(home, 'Atum Tasks'),
    artifactsRoot: path.join(home, 'userData', 'device', 'artifacts'),
    ...(options.clone ? { clone: options.clone } : {})
  })

  const grant = (over: Partial<DeviceGrant> = {}): DeviceGrant => ({
    grantId: randomUUID(), ownerUserId: '@owner:atum.test', agentPrincipal: randomUUID(), agentUserId: '@t:atum.test',
    invocationId: randomUUID(), originKind: 'device', originAssertionHash: null, writerEpoch: { leaseGeneration: 3, leaseTokenHash: 'h'.repeat(43) },
    targetDeviceServiceId: randomUUID(), enrollmentEpoch: 1, accountEpoch: 1, scopes: ['terminal', 'files'], connectionId: randomUUID(),
    issuedAt: 0, expiresAt: 1, ...over
  })

  const bind = (relative: string, etag: string) => {
    clean.set(`Agents/T/${relative}`, { resource: { storage: 'storage', space: 'personal', opaque: `id-${sha(relative).slice(0, 8)}` }, etag,
      size: statSync(path.join(folder, ...relative.split('/'))).size })
  }

  return { home, drive, folder, copies, grant, clean, bind, asked, tasks: path.join(home, 'Atum Tasks'), artifacts: path.join(home, 'userData', 'device', 'artifacts') }
}

describe('a working copy of the agent’s Drive folder', () => {
  it('clones the folder into ~/Atum Tasks/<name>/<task8>, binding only clean files to their server version', async () => {
    const s = setup()
    write(path.join(s.folder, 'notes', 'a.md'), 'alpha')
    write(path.join(s.folder, 'draft.md'), 'local edit')
    write(path.join(s.folder, 'Tài liệu', 'ghi chú.md'), 'tiếng Việt')
    write(path.join(s.folder, '.env'), 'SECRET=1')
    write(path.join(s.folder, '.hermes', 'plugins', 'x.py'), 'evil()')
    write(path.join(s.home, 'secret.txt'), 'outside the folder')
    symlinkSync(path.join(s.home, 'secret.txt'), path.join(s.folder, 'link.md'))
    linkSync(path.join(s.home, 'secret.txt'), path.join(s.folder, 'hard.md'))
    s.bind('notes/a.md', '"e-a"')
    s.bind('Tài liệu/ghi chú.md', '"e-vi"')
    const grant = s.grant()

    const { cwd, manifest } = await s.copies.prepare(grant)
    expect(cwd).toBe(path.join(s.tasks, 'T', grant.invocationId!.slice(0, 8)))
    expect(readFileSync(path.join(cwd, 'notes', 'a.md'), 'utf8')).toBe('alpha')
    expect(readFileSync(path.join(cwd, 'Tài liệu', 'ghi chú.md'), 'utf8')).toBe('tiếng Việt')

    for (const never of ['.env', '.hermes', 'link.md', 'hard.md']) {expect(existsSync(path.join(cwd, never)), never).toBe(false)}
    expect(readFileSync(path.join(cwd, '.atum', 'UNHYDRATED.txt'), 'utf8')).toMatch(/hard\.md\thard link[\s\S]*link\.md\tlink|link\.md\tlink[\s\S]*hard\.md\thard link/)
    // A copy, not the Drive file: the agent's edits never reach the synced tree.
    write(path.join(cwd, 'notes', 'a.md'), 'alpha, edited by the agent')
    expect(readFileSync(path.join(s.folder, 'notes', 'a.md'), 'utf8')).toBe('alpha')

    const parsed = JSON.parse(manifest) as DeviceWorkspaceManifest
    expect(parsed).toMatchObject({ v: 1, deviceServiceId: grant.targetDeviceServiceId, taskId: grant.invocationId, folder: '/Agents/T', truncated: false })
    expect(parsed.files.map(f => [f.path, f.sha256, f.server?.etag ?? null]), 'in walk order (code units)').toEqual([
      ['Tài liệu/ghi chú.md', sha('tiếng Việt'), '"e-vi"'],
      ['draft.md', sha('local edit'), null],
      ['notes/a.md', sha('alpha'), '"e-a"']])
    expect(parsed.files[2]).toMatchObject({ size: 5, inode: lstatSync(path.join(s.folder, 'notes', 'a.md')).ino, mtimeNs: expect.stringMatching(/^[0-9]+$/) })
    expect(s.asked.at(-1)!.sort(), 'the engine is asked about Drive-root paths').toEqual(['Agents/T/Tài liệu/ghi chú.md', 'Agents/T/draft.md', 'Agents/T/notes/a.md'])

    expect(await s.copies.prepare(grant), 'the first device use of a turn makes the copy; later ones reuse it').toEqual({ cwd, manifest })
    expect(await s.copies.ownWorkingRoot(grant.grantId)).toBe(cwd)
    expect(s.copies.driveRoot()).toBe(s.drive)
    expect(s.copies.agentWorkingRoots()).toEqual([s.tasks])
  })

  it('emits the portable workspace manifest envelope', async () => {
    const s = setup()
    write(path.join(s.folder, 'a.md'), 'alpha')
    s.bind('a.md', '"e"')
    const produced = JSON.parse((await s.copies.prepare(s.grant())).manifest)
    const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../packages/device-protocol/fixtures/device-workspace/fixtures/device-workspace-manifest.json'), 'utf8'))

    const shape = (value: unknown): unknown => Array.isArray(value) ? value.slice(0, 1).map(shape)
      : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, shape((value as Record<string, unknown>)[key])])) : typeof value

    expect(shape(produced)).toEqual(shape(fixture))
  })

  it('binds no server version to a file that changed while it was copied', async () => {
    const s = setup()
    write(path.join(s.folder, 'a.md'), 'alpha')
    s.bind('a.md', '"e"')
    const drive = (s.copies as unknown as { options: { drive: { manifestFor: (p: readonly string[]) => Promise<unknown> } } }).options.drive
    const original = drive.manifestFor

    drive.manifestFor = async paths => {
      if (paths.length) {utimesSync(path.join(s.folder, 'a.md'), new Date(), new Date(Date.now() + 5_000))} // synced again meanwhile

      return original(paths)
    }

    const parsed = JSON.parse((await s.copies.prepare(s.grant())).manifest) as DeviceWorkspaceManifest
    expect(parsed.files.map(f => [f.path, f.server])).toEqual([['a.md', null]])
  })

  it('refuses a symlinked folder, Drive path or copy path, and is unavailable without a workspace', async () => {
    const linked = setup()
    const elsewhere = path.join(linked.home, 'elsewhere')
    mkdirSync(elsewhere)
    rmSync(linked.folder, { recursive: true })
    symlinkSync(elsewhere, linked.folder)
    await expect(linked.copies.prepare(linked.grant())).rejects.toThrow('workspace_symlink')

    const tasks = setup()
    mkdirSync(path.join(tasks.home, 'real-tasks'))
    symlinkSync(path.join(tasks.home, 'real-tasks'), tasks.tasks)
    await expect(tasks.copies.prepare(tasks.grant())).rejects.toThrow('workspace_symlink')

    const swapped = setup()
    write(path.join(swapped.folder, 'a.md'), 'alpha')
    const grant = swapped.grant()
    const { cwd } = await swapped.copies.prepare(grant)
    renameSync(cwd, `${cwd}.moved`)
    symlinkSync(swapped.drive, cwd) // an agent command swaps its own copy for a link to the synced tree
    expect(await swapped.copies.ownWorkingRoot(grant.grantId)).toBeNull()
    await expect(swapped.copies.prepare(grant)).rejects.toThrow('workspace_symlink')
    await expect(swapped.copies.collect([path.join(cwd, 'a.md')])).resolves.toEqual([])

    const none = setup({ label: null })
    await expect(none.copies.prepare(none.grant())).rejects.toThrow('workspace_unavailable')
  })
})

describe('cloning', () => {
  it.runIf(process.platform === 'darwin')('clones with clonefile and never follows a symlink operand', async () => {
    const s = setup()
    write(path.join(s.home, 'src', 'a.md'), 'alpha')
    write(path.join(s.home, 'secret.txt'), 'outside')
    symlinkSync(path.join(s.home, 'secret.txt'), path.join(s.home, 'src', 'link.md'))
    mkdirSync(path.join(s.home, 'dst'))
    await cloneInto([path.join(s.home, 'src', 'a.md'), path.join(s.home, 'src', 'link.md')], path.join(s.home, 'dst'))
    expect(readFileSync(path.join(s.home, 'dst', 'a.md'), 'utf8')).toBe('alpha')
    expect(lstatSync(path.join(s.home, 'dst', 'link.md')).isSymbolicLink(), 'kept a link, so the caller refuses it').toBe(true)
  })

  it('refuses a source swapped for a link between the walk and the descriptor-copy fallback', async () => {
    let folder = ''

    const s = setup({ clone: async () => {
      rmSync(path.join(folder, 'a.md'))
      symlinkSync(path.join(path.dirname(path.dirname(folder)), '..', 'secret.txt'), path.join(folder, 'a.md'))
    } })

    folder = s.folder
    write(path.join(s.home, 'secret.txt'), 'outside')
    write(path.join(s.folder, 'a.md'), 'alpha')
    await expect(s.copies.prepare(s.grant())).rejects.toThrow('workspace_symlink')
  })

  it('copies from a checked descriptor when it cannot clone (another volume), within a bound', async () => {
    const s = setup({ clone: async () => {} })
    write(path.join(s.folder, 'small.md'), 'small')
    write(path.join(s.folder, 'video.mov'), Buffer.alloc(33_554_433))
    const { cwd, manifest } = await s.copies.prepare(s.grant())
    expect(readFileSync(path.join(cwd, 'small.md'), 'utf8')).toBe('small')
    expect(existsSync(path.join(cwd, 'video.mov'))).toBe(false)
    expect(readFileSync(path.join(cwd, '.atum', 'UNHYDRATED.txt'), 'utf8')).toContain('video.mov\ttoo large to copy')
    expect((JSON.parse(manifest) as DeviceWorkspaceManifest).files.map(f => f.path)).toEqual(['small.md'])
  })
})

describe('what a turn produced in its copy', () => {
  it('lists new, changed and deleted files, and freezes the named ones as artifacts', async () => {
    const s = setup()
    write(path.join(s.folder, 'notes', 'a.md'), 'alpha')
    write(path.join(s.folder, 'old.md'), 'old')
    write(path.join(s.folder, 'same.md'), 'same')
    const grant = s.grant()
    const { cwd } = await s.copies.prepare(grant)
    write(path.join(cwd, 'notes', 'a.md'), 'alpha, edited')
    write(path.join(cwd, 'brief.md'), 'the brief')
    rmSync(path.join(cwd, 'old.md'))
    write(path.join(cwd, '.env.local'), 'X=1')
    utimesSync(path.join(cwd, 'same.md'), new Date(), new Date(Date.now() + 9_000)) // touched, not changed
    expect(await s.copies.changes(grant.grantId)).toEqual({ changed: ['brief.md', 'notes/a.md'], deleted: ['old.md'] })

    write(path.join(s.home, 'id_rsa.txt'), 'a key the agent cannot read')
    linkSync(path.join(s.home, 'id_rsa.txt'), path.join(cwd, 'leak.md'))
    symlinkSync(path.join(s.home, 'id_rsa.txt'), path.join(cwd, 'link.md'))
    write(path.join(cwd, 'big.bin'), Buffer.alloc(8_388_609))

    const artifacts = await s.copies.collect([path.join(cwd, 'brief.md'), 'notes/a.md', path.join(cwd, 'leak.md'), path.join(cwd, 'link.md'),
      path.join(cwd, 'big.bin'), path.join(cwd, '.env.local'), path.join(s.folder, 'old.md'), path.join(cwd, '..', 'escape.md')])

    expect(artifacts.map(a => [a.name, a.size, a.sha256])).toEqual([
      ['brief.md', 9, Buffer.from(sha('the brief'), 'hex').toString('base64url')],
      ['notes/a.md', 13, Buffer.from(sha('alpha, edited'), 'hex').toString('base64url')]])

    for (const artifact of artifacts) {
      expect(path.dirname(artifact.path)).toBe(s.artifacts)
      expect(statSync(artifact.path).mode & 0o777).toBe(0o600)
    }

    // Frozen: the agent changing its copy afterwards does not change what is sent.
    write(path.join(cwd, 'brief.md'), 'changed after collection')
    expect(readFileSync(artifacts[0]!.path, 'utf8')).toBe('the brief')
    await s.copies.release(artifacts)
    expect(artifacts.some(a => existsSync(a.path))).toBe(false)
  })
})

describe('the engine’s conflict copies', () => {
  it('are offered once each from the agents’ folders, and a copy too large to send is recorded', async () => {
    const s = setup()
    write(path.join(s.folder, 'brief_conflict-20261005-153000.md'), 'the Mac’s version')
    write(path.join(s.folder, 'reports', 'q3 (conflicted copy 2026-10-05 153000).md'), 'another')
    write(path.join(s.folder, 'brief.md'), 'the server’s version')
    write(path.join(s.folder, 'video_conflict-20261005-153000.mov'), Buffer.alloc(8_388_609))
    write(path.join(s.drive, 'Documents', 'elsewhere_conflict-20261005-153000.md'), 'not an agent folder')
    let kept: string[] = []
    const agent = randomUUID()

    const relay = new ConflictCopyRelay({ drive: { manifestFor: async () => ({ root: s.drive, files: new Map() }) },
      folders: async () => [{ agentPrincipal: agent, label: '/Agents/T' }], store: { get: () => kept, set: keys => void (kept = keys) },
      artifactsRoot: s.artifacts })

    const first = await relay.scan()
    expect(first.offered.map(c => [c.path, c.agentPrincipal, c.label])).toEqual([
      ['brief_conflict-20261005-153000.md', agent, '/Agents/T'], ['reports/q3 (conflicted copy 2026-10-05 153000).md', agent, '/Agents/T']])
    expect(readFileSync(first.offered[0]!.artifact.path, 'utf8')).toBe('the Mac’s version')
    expect(first.tooLarge).toHaveLength(1)
    const again = await relay.scan()
    expect(again.offered.map(c => c.artifact.path), 'offered again until the controller confirms, from the same frozen file')
      .toEqual(first.offered.map(c => c.artifact.path))
    await relay.scan()
    expect(readdirSync(s.artifacts), 'an offline Mac does not freeze a copy again on every scan').toHaveLength(2)
    await relay.confirm(first.offered.map(c => c.key))
    expect(await relay.scan()).toEqual({ offered: [], tooLarge: [] })
    expect(readdirSync(s.artifacts), 'a confirmed copy’s frozen file goes').toHaveLength(0)
    write(path.join(s.folder, 'brief_conflict-20261005-153000.md'), 'the Mac’s version, edited again')
    expect((await relay.scan()).offered.map(c => c.path), 'a new version of the copy is a new offer').toEqual(['brief_conflict-20261005-153000.md'])
    write(path.join(s.folder, 'brief_conflict-20261005-153000.md'), 'and edited a third time before it was confirmed')
    await relay.scan()
    expect(readdirSync(s.artifacts), 'the superseded version’s frozen file goes').toHaveLength(1)
  })

  it('know the engine’s names, and the exclusion list matches the controller’s', () => {
    expect(CONFLICT_COPY.test('brief_conflict-20261005-153000.md')).toBe(true)
    expect(CONFLICT_COPY.test('brief (conflicted copy 2026-10-05 153000).md')).toBe(true)
    expect(CONFLICT_COPY.test('brief.md')).toBe(false)

    for (const p of ['.hermes/plugins/x.py', 'notes/.env', 'a/b/state.db', 'id_ed25519', 'keys/k.pem', '.git/config', '.atum/tasks/x.json'])
      {expect(excludedFromWorkspace(p), p).toBe(true)}

    for (const p of ['notes/a.md', 'reports/2026/brief (T 2026-10-04 00000000).md', 'db.md', '.github/workflows/ci.yml'])
      {expect(excludedFromWorkspace(p), p).toBe(false)}
  })
})

it('prunes frozen artifacts after a day, and only working copies whose files all reached Drive after thirty', async () => {
  const s = setup()
  write(path.join(s.folder, 'a.md'), 'alpha')
  const { cwd } = await s.copies.prepare(s.grant())
  const unsaved = (await s.copies.prepare(s.grant())).cwd
  write(path.join(unsaved, 'report.md'), 'reported as not saved: this copy is its only home')
  mkdirSync(s.artifacts, { recursive: true })
  write(path.join(s.artifacts, 'stale.artifact'), 'x')
  const later = Date.now() + 2 * 86_400_000
  expect(await pruneWorkspaceCopies({ tasksRoot: s.tasks, artifactsRoot: s.artifacts, now: later })).toBe(1)
  expect(existsSync(cwd)).toBe(true)
  const month = Date.now() + 31 * 86_400_000
  expect(await pruneWorkspaceCopies({ tasksRoot: s.tasks, artifactsRoot: s.artifacts, now: month }), 'nothing says they were saved').toBe(0)
  expect(await pruneWorkspaceCopies({ tasksRoot: s.tasks, artifactsRoot: s.artifacts, now: month, saved: copy => copy === cwd })).toBe(1)
  expect(existsSync(cwd)).toBe(false)
  expect(readFileSync(path.join(unsaved, 'report.md'), 'utf8')).toMatch(/only home/)
})

it('keeps the synced folder write-denied whatever Drive’s state is now', async () => {
  const s = setup()
  let state: 'bound' | 'gone' | 'other' = 'bound'
  const other = path.join(s.home, 'Other Drive')

  const copies = new DriveWorkspaceCopies({
    drive: {
      manifestFor: async () => state === 'bound' ? { root: s.drive, files: new Map() } : state === 'other' ? { root: other, files: new Map() } : null,
      savedRoot: () => state === 'gone' ? null : state === 'other' ? other : s.drive
    },
    workspaceLabel: async () => '/Agents/T', tasksRoot: s.tasks, artifactsRoot: s.artifacts
  })

  expect(copies.driveRoot(), 'nothing learned yet').toBeNull()
  expect(await copies.refresh()).toBe(s.drive)
  state = 'gone' // signed out, unenrolled or the engine stopped
  expect(await copies.refresh()).toBe(s.drive)
  expect(copies.driveRoot()).toBe(s.drive)
  state = 'other' // another account's Drive
  await copies.refresh()
  expect(copies.driveRoot()).toBe(other)
  expect(copies.driveRoots(), 'the first account’s folder stays denied too').toEqual([s.drive, other])

  // Bound but disconnected (not enrolled): the folder Drive is bound to still counts.
  const disconnected = new DriveWorkspaceCopies({ drive: { manifestFor: async () => null, savedRoot: () => s.drive },
    workspaceLabel: async () => '/Agents/T', tasksRoot: s.tasks, artifactsRoot: s.artifacts })

  expect(await disconnected.refresh()).toBe(s.drive)

  const failing = new DriveWorkspaceCopies({ drive: { manifestFor: async () => { throw new Error('engine') }, savedRoot: () => { throw new Error('store') } },
    workspaceLabel: async () => '/Agents/T', tasksRoot: s.tasks, artifactsRoot: s.artifacts })

  expect(await failing.refresh()).toBeNull()
})

it('keeps disconnected root history after restarting the app', async () => {
  const s = setup()
  let stored: string[] = []

  const options = { drive: { savedRoot: () => s.drive, manifestFor: async () => null },
    workspaceLabel: async () => '/Agents/T', tasksRoot: s.tasks, artifactsRoot: s.artifacts,
    rememberDriveRoots: (roots: string[]) => {stored = roots} }

  const first = new DriveWorkspaceCopies(options)
  await first.refresh()
  expect(stored).toEqual([s.drive])

  const restarted = new DriveWorkspaceCopies({ ...options, knownDriveRoots: stored,
    drive: { manifestFor: async () => null, savedRoot: () => null } })

  expect(await restarted.refresh()).toBe(s.drive)
  expect(restarted.driveRoots()).toEqual([s.drive])
})
