import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, expect, it, vi } from 'vitest'

import {
  MATRIX_DRIVE_AUTOMATIC_SIGN_IN_MS,
  MATRIX_DRIVE_OPEN_RECHECK_MS,
  MATRIX_DRIVE_RENEWAL_SETTLED_MS,
  MATRIX_DRIVE_SETUP_CLASSIFY_MS,
  MATRIX_DRIVE_SETUP_HOLD_MS,
  MATRIX_DRIVE_SETUP_RETRY_MS,
  MatrixDrive,
  matrixDriveFirstConnectProblem,
  matrixDriveOpen,
  matrixDriveReachable
} from './drive'
import { MATRIX_DRIVE_CHAIN_WAIT_MS } from './drive-chain'
import { MatrixDriveImport } from './drive-import'

// A path replaced by another directory between two of the checks on it is made real here: the hook
// runs just before the real `realpathSync` answers, on the path the test names.
const fsHooks = vi.hoisted(() => ({ beforeRealpath: undefined as ((target: unknown) => void) | undefined }))

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof NodeFs>()

  const realpathSync = Object.assign(
    (...args: unknown[]) => {
      fsHooks.beforeRealpath?.(args[0])

      return (actual.realpathSync as (...values: unknown[]) => unknown)(...args)
    },
    { native: actual.realpathSync.native }
  ) as typeof actual.realpathSync

  return { ...actual, realpathSync }
})

const fixtures: string[] = []
afterEach(() => {
  fsHooks.beforeRealpath = undefined

  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true })
  }
})

function fixture(
  extra: (home: string) => {
    defaultFolder?: string
    reachable?: () => Promise<boolean>
    open?: () => Promise<boolean>
    credential?: (
      refused: string | undefined,
      owner: { issuer: string; subject: string }
    ) => Promise<{ accessToken: string; expiresAt?: number } | null>
  } = () => ({})
) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'atum-drive-test-')))
  fixtures.push(home)
  const root = path.join(home, 'Files')
  mkdirSync(root)
  let owner = { issuer: 'https://auth.test/', subject: 'owner-a', generation: 1 }
  // Main's owner() once the app is quitting: null, as for a sign-out.
  let quitting = false
  const engine = { binary: '/unused', issuer: owner.issuer, origin: 'https://drive.test' }

  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      child.emit('close', 0)

      return true
    })
  })

  const store = new Map<string, string>()

  const options = {
    owner: () => (quitting ? null : owner),
    engine,
    userData: home,
    store: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value)
      }
    },
    chooseFolder: vi.fn(async () => root),
    // Turn on's own folder: the tests' `Files` unless a test names `~/Atum/Drive`.
    defaultFolder: root as string | undefined,
    openExternal: vi.fn(async () => {}),
    returned: vi.fn(),
    openPath: vi.fn(async () => ''),
    closeNativePreview: vi.fn(),
    changed: vi.fn(),
    spawn: vi.fn(() => child as unknown as ChildProcessWithoutNullStreams),
    log: vi.fn(),
    ...extra(home)
  }

  const drive = new MatrixDrive(options)
  const send = (message: unknown) => child.stdout.write(JSON.stringify(message) + '\n')

  // The engine's binding, as its first enrollment leaves it: a bound root may hold files.
  const bind = () =>
    writeFileSync(
      path.join(root, '.atum-drive-binding.json'),
      JSON.stringify({
        version: 1,
        canonicalRoot: root,
        issuer: owner.issuer,
        subject: owner.subject,
        origin: engine.origin,
        journal: '.atum-drive-journal.db',
        space: 'storage$personal'
      })
    )

  const enrolled = async (taskFiles = false) => {
    bind()
    await drive.connect()
    send({ kind: 'hello', protocol: 1, issuer: owner.issuer, origin: engine.origin, taskFiles })
    send({ kind: 'state', state: 'ready' })

    return drive.read()
  }

  /** The same owner's marker, saved as a person-chosen root (a non-default folder). */
  const bindSaved = () => {
    bind()
    const current = options.owner()!
    const key = createHash('sha256').update(JSON.stringify([current.issuer, current.subject])).digest('hex')
    const stat = lstatSync(root)
    store.set('drive-root:' + key, JSON.stringify({ root, dev: stat.dev, ino: stat.ino }))
    store.set('drive-enabled:' + key, 'yes')
  }

  return {
    drive,
    root,
    home,
    store,
    options,
    child,
    send,
    bind,
    bindSaved,
    enrolled,
    changeOwner: () => {
      owner = { ...owner, subject: 'owner-b', generation: 2 }
    },
    /** The same person's Atum sign-in moves to a new generation (a step cancelled, the Atum account
     * connected again). */
    newGeneration: () => {
      owner = { ...owner, generation: owner.generation + 1 }
    },
    quit: () => {
      quitting = true
    },
    /** The next launch's options: the same account signed in, a fresh engine to spawn. */
    relaunch: () => ({
      ...options,
      owner: () => owner,
      spawn: vi.fn(() => freshChild() as unknown as ChildProcessWithoutNullStreams)
    })
  }
}

function drainCommands(child: { stdin: PassThrough }): Record<string, unknown>[] {
  const bytes = child.stdin.read()

  return bytes
    ? bytes
        .toString()
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>)
    : []
}

it('search handles use the enrolled root and expire on cancellation, replacement and owner withdrawal', async () => {
  const f = fixture()
  await f.enrolled()
  mkdirSync(path.join(f.root, 'Docs'))
  writeFileSync(path.join(f.root, 'Docs', 'report.txt'), 'not searched')
  const result = await f.drive.search('report', 'drive', 'search-1')
  expect(result.rows).toMatchObject([{ name: 'report.txt', folders: ['Docs'] }])
  expect(JSON.stringify(result)).not.toContain(f.root)
  const id = result.rows[0]!.id
  await f.drive.open(id)
  f.drive.cancelSearch('search-1')
  await expect(f.drive.open(id)).rejects.toThrow()
  const next = await f.drive.search('report', 'drive', 'search-2')
  rmSync(path.join(f.root, 'Docs', 'report.txt'))
  symlinkSync(path.join(f.home, 'outside'), path.join(f.root, 'Docs', 'report.txt'))
  await expect(f.drive.open(next.rows[0]!.id)).rejects.toThrow()
  f.changeOwner()
  await expect(f.drive.search('report', 'drive', 'search-3')).rejects.toThrow()
})

it('marks local-only rows using engine import exclusions, including excluded ancestors', async () => {
  const f = fixture()
  await f.enrolled()
  mkdirSync(path.join(f.root, 'node_modules'))
  writeFileSync(path.join(f.root, 'node_modules', 'report.txt'), '')
  writeFileSync(path.join(f.root, 'normal.txt'), '')
  const view = await f.drive.read()
  expect(view.rows.find(row => row.name === 'node_modules')).toMatchObject({ localOnly: true })
  expect(view.rows.find(row => row.name === 'normal.txt')?.localOnly).toBeUndefined()
  expect((await f.drive.search('report', 'drive', 'local-only')).rows[0]).toMatchObject({ localOnly: true })
})

it('searches the requested current-folder subtree without moving the folder and cancels only its own lease', async () => {
  const f = fixture()
  await f.enrolled()
  mkdirSync(path.join(f.root, 'Docs'))
  mkdirSync(path.join(f.root, 'Elsewhere'))
  writeFileSync(path.join(f.root, 'Docs', 'report-here.txt'), '')
  writeFileSync(path.join(f.root, 'Elsewhere', 'report-there.txt'), '')
  const listing = await f.drive.read()
  await f.drive.enter(listing.rows.find(row => row.name === 'Docs')!.id)
  expect((await f.drive.search('report', 'folder', 'folder-search')).rows.map(row => row.name)).toEqual(['report-here.txt'])
  const all = await f.drive.search('report', 'drive', 'all-search')
  expect(all.rows).toHaveLength(2)
  f.drive.cancelSearch('folder-search')
  await f.drive.open(all.rows[0]!.id)
  expect((await f.drive.read()).folderLabel).toBe('Docs')
  await expect(f.drive.search('../outside', 'drive', 'invalid')).rejects.toThrow('invalid')
  const pending = f.drive.search('report', 'drive', 'cancel-me')
  f.drive.cancelSearch('cancel-me')
  await expect(pending).rejects.toThrow()
})

it('enters a folder found outside the current listing using its separately verified handle', async () => {
  const f = fixture()
  await f.enrolled()
  mkdirSync(path.join(f.root, 'Docs', 'Weekly'), { recursive: true })
  writeFileSync(path.join(f.root, 'Docs', 'Weekly', 'report.txt'), '')
  const found = await f.drive.search('Weekly', 'drive', 'found-folder')
  expect(found.rows[0]).toMatchObject({ kind: 'folder', folders: ['Docs'] })
  expect(await f.drive.enter(found.rows[0]!.id)).toMatchObject({ folderLabel: 'Weekly', rows: [{ name: 'report.txt' }] })
  await expect(f.drive.enter(found.rows[0]!.id)).rejects.toThrow()
})

it('withdraws search results when the enrolled root or marker is replaced', async () => {
  const f = fixture()
  await f.enrolled()
  writeFileSync(path.join(f.root, 'report'), '')
  const result = await f.drive.search('report', 'drive', 'root-test')
  // A person-chosen root, not the app-owned default's deliberate one-time auto-rebind.
  f.options.defaultFolder = undefined
  renameSync(f.root, f.root + '-old')
  mkdirSync(f.root)
  f.bind()
  await expect(f.drive.open(result.rows[0]!.id)).rejects.toThrow()
  await expect(f.drive.search('report', 'drive', 'root-test-2')).rejects.toThrow()
})

it('never consumes unsolicited per-file status on an engine without the capability', async () => {
  const f = fixture()
  await f.enrolled()
  writeFileSync(path.join(f.root, 'report.txt'), '')
  await f.drive.read()
  f.send({ kind: 'file_status', path: 'report.txt', state: 'conflict' })
  const view = f.options.changed.mock.lastCall?.[0]
  expect(view?.fileStatusAvailable).toBeUndefined()
  expect(view?.rows.every(row => row.syncStatus === undefined)).toBe(true)
})

it('consumes per-file facts only after negotiation and clears them when the engine stops', async () => {
  const f = fixture()
  f.bind()
  await f.drive.connect()
  f.send({ kind: 'hello', protocol: 1, issuer: f.options.engine.issuer, origin: f.options.engine.origin, features: ['file_status'] })
  f.send({ kind: 'state', state: 'ready' })
  writeFileSync(path.join(f.root, 'report.txt'), '')
  await f.drive.read()
  f.send({ kind: 'file_status', path: 'report.txt', state: 'uploading' })
  expect(f.options.changed.mock.lastCall?.[0].rows[0]).toMatchObject({ syncStatus: 'uploading' })
  f.send({ kind: 'file_status', path: 'report.txt', state: 'conflict' })
  expect(f.options.changed.mock.lastCall?.[0].rows[0]).toMatchObject({ syncStatus: 'conflict' })
  f.send({ kind: 'file_status', path: 'report.txt', state: 'clear' })
  expect(f.options.changed.mock.lastCall?.[0].rows[0]?.syncStatus).toBeUndefined()
  f.send({ kind: 'file_status', path: 'report.txt', state: 'error' })
  const search = await f.drive.search('report', 'drive', 'statuses')
  expect(search.rows[0]?.syncStatus).toBe('error')
  f.send({ kind: 'file_status', path: 'report.txt', state: 'uploading' })
  expect(f.options.changed.mock.lastCall?.[0].searchResult?.rows[0]?.syncStatus).toBe('uploading')
  f.send({ kind: 'state', state: 'offline' })
  f.send({ kind: 'state', state: 'ready' })
  expect(f.options.changed.mock.lastCall?.[0].rows[0]?.syncStatus).toBeUndefined()
  expect(f.options.changed.mock.lastCall?.[0].searchResult?.rows[0]?.syncStatus).toBeUndefined()
  f.send({ kind: 'file_status', path: 'report.txt', state: 'error' })
  f.child.emit('close', 1)
  expect(f.options.changed.mock.lastCall?.[0].rows[0]?.syncStatus).toBeUndefined()
})

it('replaces local-only rules with the engine’s complete exclusion snapshot', async () => {
  const f = fixture()
  f.bind()
  await f.drive.connect()
  f.send({ kind: 'hello', protocol: 1, issuer: f.options.engine.issuer, origin: f.options.engine.origin, features: ['exclusions'] })
  f.send({ kind: 'state', state: 'ready' })
  writeFileSync(path.join(f.root, 'report.draft'), '')
  expect((await f.drive.read()).rows[0]?.localOnly).toBeUndefined()
  f.send({ kind: 'exclusions', patterns: ['*.draft'] })
  expect(f.options.changed.mock.lastCall?.[0].rows[0]?.localOnly).toBe(true)
  expect((await f.drive.search('report', 'drive', 'excluded')).rows[0]?.localOnly).toBe(true)
})

async function metadataCommand(child: { stdin: PassThrough }): Promise<Record<string, unknown>> {
  let request: Record<string, unknown> | undefined

  await vi.waitFor(() => {
    request = drainCommands(child).find(message => message.kind === 'file_metadata')
    expect(request).toBeDefined()
  })

  return request!
}

it('never calls an existing folder Ready; waits for a matching engine and enrolled root', async () => {
  const f = fixture()
  expect((await f.drive.read()).state).toBe('disconnected')
  expect(await f.drive.connect()).toMatchObject({ state: 'connecting' })
  f.send({ kind: 'hello', protocol: 1, issuer: 'https://foreign.test/', origin: 'https://drive.test' })
  expect((await f.drive.read()).state).toBe('error')
  expect(f.child.kill).toHaveBeenCalled()
  expect(f.options.openExternal).not.toHaveBeenCalled()
})

it('import destinations use the actual enrolled binding and vanish on owner or inode change', async () => {
  const f = fixture()
  expect(f.drive.importTarget()).toBeUndefined()
  const view = await f.enrolled()
  const target = f.drive.importTarget()
  expect(target).toMatchObject({ root: f.root, dev: lstatSync(f.root).dev, ino: lstatSync(f.root).ino })
  expect(JSON.stringify(view)).not.toContain('ownerKey')
  expect(JSON.stringify(view)).not.toContain(f.root)
  f.send({ kind: 'state', state: 'offline' })
  expect(f.drive.importTarget()).toBeUndefined()
  f.send({ kind: 'state', state: 'paused' })
  expect(f.drive.importTarget()).toBeUndefined()
  f.send({ kind: 'state', state: 'ready' })
  expect(f.drive.importTarget()).toMatchObject({ root: f.root })
  f.changeOwner()
  expect(f.drive.importTarget()).toBeUndefined()

  const changed = fixture()
  await changed.enrolled()
  renameSync(changed.root, changed.root + '-old')
  mkdirSync(changed.root)
  expect(changed.drive.importTarget()).toBeUndefined()
})

it('only exposes local rows and opaque actions; hides journals and skips symlinks', async () => {
  const f = fixture()
  writeFileSync(path.join(f.root, 'notes.txt'), 'owner text')
  writeFileSync(path.join(f.root, '.atum-drive-journal.db'), 'private journal')
  const outside = path.join(f.home, 'outside.txt')
  writeFileSync(outside, 'foreign text')
  symlinkSync(outside, path.join(f.root, 'link.txt'))
  const view = await f.enrolled()
  expect(view.rows.map(row => row.name)).toEqual(['notes.txt'])
  expect(JSON.stringify(view)).not.toContain(f.home)
  expect(JSON.stringify(view)).not.toContain('subject')
  await f.drive.open(view.rows[0].id)
  expect(f.options.openPath).toHaveBeenCalledWith(path.join(f.root, 'notes.txt'))
  await expect(f.drive.open(outside)).rejects.toThrow()
})

it('opens and closes one bounded preview lease without exposing its native path', async () => {
  const f = fixture()
  const file = path.join(f.root, 'plan.pdf')
  writeFileSync(file, '%PDF-1.7\nfixture')
  const view = await f.enrolled()
  const row = view.rows.find(entry => entry.name === 'plan.pdf')!

  const preview = f.drive.preview(row.id)
  expect(preview).toMatchObject({ name: 'plan.pdf', kind: 'pdf', size: 16 })
  expect(JSON.stringify(preview)).not.toContain(f.root)
  expect(JSON.stringify(preview)).not.toContain('path')
  expect(f.drive.resolvePreview(preview.token)).toBe(file)

  const replacement = f.drive.preview(row.id)
  expect(f.drive.resolvePreview(preview.token)).toBeNull()
  expect(f.options.closeNativePreview).toHaveBeenCalledWith(preview.token)
  expect(f.drive.resolvePreview(replacement.token)).toBe(file)

  f.drive.closePreview(replacement.token)
  expect(f.drive.resolvePreview(replacement.token)).toBeNull()
  expect(f.options.closeNativePreview).toHaveBeenCalledWith(replacement.token)
})

it.each(['authorizing', 'connecting', 'reauthenticate', 'offline', 'paused', 'error'] as const)(
  'keeps the verified local listing and opaque handles while sync is %s',
  async state => {
    const f = fixture()
    writeFileSync(path.join(f.root, 'notes.txt'), 'owner text')
    const initial = await f.enrolled(true)
    const file = initial.rows[0]
    const listedAt = initial.listedAt

    f.send({ kind: 'state', state })
    await vi.waitFor(async () => {
      const view = await f.drive.read()
      expect(view).toMatchObject({ state: state === 'offline' ? 'connecting' : state, canBrowseLocally: true })
      expect(view.rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: file.id, name: 'notes.txt' })]))
    })

    const retained = await f.drive.read()
    expect(retained.listedAt).toBeGreaterThanOrEqual(listedAt!)
    await f.drive.open(file.id)
    expect(f.options.openPath).toHaveBeenLastCalledWith(path.join(f.root, 'notes.txt'))
    expect(f.drive.taskFilesReady(initial.revision)).toBe(false)
  }
)

it('keeps a prior folder listing stale when that folder disappears, without stopping the sync child', async () => {
  const f = fixture()
  const folder = path.join(f.root, 'reports')
  mkdirSync(folder)
  writeFileSync(path.join(folder, 'notes.txt'), 'owner text')
  const root = await f.enrolled()
  const entered = await f.drive.enter(root.rows[0].id)
  const listedAt = entered.listedAt
  const previousRows = entered.rows

  rmSync(folder, { recursive: true, force: true })
  const stale = await f.drive.read()

  expect(stale).toMatchObject({ state: 'ready', canBrowseLocally: true, listingStatus: 'stale', listedAt })
  expect(stale.rows).toEqual(previousRows)
  expect(f.child.kill).not.toHaveBeenCalled()
  await expect(f.drive.open(previousRows[0].id)).rejects.toThrow('matrix_drive_file_unavailable')
})

it('keeps metadata main-only and correlates bounded read and create helper replies', async () => {
  const f = fixture()
  writeFileSync(path.join(f.root, 'notes.txt'), 'owner text')
  mkdirSync(path.join(f.root, 'outputs'))
  const view = await f.enrolled(true)
  const file = view.rows.find(row => row.kind === 'file')!
  const folder = view.rows.find(row => row.kind === 'folder')!
  expect((f.drive as unknown as { taskFiles: boolean }).taskFiles).toBe(true)
  expect((f.drive as unknown as { state: string }).state).toBe('ready')
  expect((f.drive as unknown as { process?: unknown }).process).toBeDefined()
  expect(JSON.stringify(view)).not.toContain('storage')
  expect(JSON.stringify(view)).not.toContain('opaque')
  expect(JSON.stringify(view)).not.toContain('etag')
  drainCommands(f.child)
  await expect(f.drive.metadata(file.id, 'read', view.revision + 1)).rejects.toThrow('matrix_drive_file_unavailable')

  const read = f.drive.metadata(file.id, 'read', view.revision)
  const readRequest = await metadataCommand(f.child)
  expect(readRequest).toMatchObject({ kind: 'file_metadata', mode: 'read', relativePath: 'notes.txt' })
  f.send({
    kind: 'file_metadata',
    requestId: readRequest.requestId,
    state: 'ready',
    resource: { storage: 'storage', space: 'personal', opaque: 'file-id' },
    etag: 'etag-1',
    size: 10
  })
  await expect(read).resolves.toEqual({
    resource: { storage: 'storage', space: 'personal', opaque: 'file-id' },
    etag: 'etag-1',
    size: 10
  })

  const create = f.drive.metadata(folder.id, 'create', view.revision)
  const createRequest = await metadataCommand(f.child)
  expect(createRequest).toMatchObject({ kind: 'file_metadata', mode: 'create', relativePath: 'outputs' })
  f.send({
    kind: 'file_metadata',
    requestId: createRequest.requestId,
    state: 'ready',
    resource: { storage: 'storage', space: 'personal', opaque: 'parent-id' }
  })
  await expect(create).resolves.toEqual({ resource: { storage: 'storage', space: 'personal', opaque: 'parent-id' } })
  await expect(f.drive.metadata(file.id, 'create', view.revision)).rejects.toThrow('matrix_drive_file_unavailable')
  await expect(f.drive.metadata(folder.id, 'read', view.revision)).rejects.toThrow('matrix_drive_file_unavailable')
})

it('denies missing capability, foreign metadata space, and malformed helper replies', async () => {
  const f = fixture()
  writeFileSync(path.join(f.root, 'notes.txt'), 'owner text')
  const old = await f.enrolled()
  const row = old.rows[0]
  await expect(f.drive.metadata(row.id, 'read', old.revision)).rejects.toThrow('matrix_drive_file_unavailable')

  const g = fixture()
  writeFileSync(path.join(g.root, 'notes.txt'), 'owner text')
  const view = await g.enrolled(true)
  drainCommands(g.child)
  const foreign = g.drive.metadata(view.rows[0].id, 'read', view.revision)
  const request = await metadataCommand(g.child)
  g.send({
    kind: 'file_metadata',
    requestId: request.requestId,
    state: 'ready',
    resource: { storage: 'foreign', space: 'personal', opaque: 'file-id' },
    etag: 'etag-1',
    size: 10
  })
  await expect(foreign).rejects.toThrow('matrix_drive_file_unavailable')

  const malformed = g.drive.metadata(view.rows[0].id, 'read', view.revision)
  const malformedRequest = await metadataCommand(g.child)
  g.send({
    kind: 'file_metadata',
    requestId: malformedRequest.requestId,
    state: 'ready',
    resource: { storage: 'storage', space: 'personal', opaque: 'file-id' }
  })
  await expect(malformed).rejects.toThrow('matrix_drive_file_unavailable')
  expect(g.child.kill).toHaveBeenCalledWith('SIGTERM')
})

it('cancels pending metadata across owner, root, row, process, and timeout fences', async () => {
  const owner = fixture()
  writeFileSync(path.join(owner.root, 'notes.txt'), 'owner text')
  const ownerView = await owner.enrolled(true)
  drainCommands(owner.child)
  const ownerPending = owner.drive.metadata(ownerView.rows[0].id, 'read', ownerView.revision)
  await metadataCommand(owner.child)
  owner.changeOwner()
  owner.drive.activate()
  await expect(ownerPending).rejects.toThrow('matrix_drive_file_unavailable')

  const root = fixture()
  writeFileSync(path.join(root.root, 'notes.txt'), 'owner text')
  const rootView = await root.enrolled(true)
  drainCommands(root.child)
  const rootPending = root.drive.metadata(rootView.rows[0].id, 'read', rootView.revision)
  const rootRequest = await metadataCommand(root.child)
  writeFileSync(
    path.join(root.root, '.atum-drive-binding.json'),
    JSON.stringify({ version: 1, canonicalRoot: root.root, space: 'foreign$space' })
  )
  root.send({
    kind: 'file_metadata',
    requestId: rootRequest.requestId,
    state: 'ready',
    resource: { storage: 'storage', space: 'personal', opaque: 'file-id' },
    etag: 'etag-1',
    size: 10
  })
  await expect(rootPending).rejects.toThrow('matrix_drive_file_unavailable')

  const row = fixture()
  writeFileSync(path.join(row.root, 'notes.txt'), 'owner text')
  const rowView = await row.enrolled(true)
  drainCommands(row.child)
  const rowPending = row.drive.metadata(rowView.rows[0].id, 'read', rowView.revision)
  const rowRequest = await metadataCommand(row.child)
  renameSync(path.join(row.root, 'notes.txt'), path.join(row.root, 'changed.txt'))
  row.send({
    kind: 'file_metadata',
    requestId: rowRequest.requestId,
    state: 'ready',
    resource: { storage: 'storage', space: 'personal', opaque: 'file-id' },
    etag: 'etag-1',
    size: 10
  })
  await expect(rowPending).rejects.toThrow('matrix_drive_file_unavailable')

  const process = fixture()
  writeFileSync(path.join(process.root, 'notes.txt'), 'owner text')
  const processView = await process.enrolled(true)
  drainCommands(process.child)
  const processPending = process.drive.metadata(processView.rows[0].id, 'read', processView.revision)
  await metadataCommand(process.child)
  process.child.emit('close', 1)
  await expect(processPending).rejects.toThrow('matrix_drive_file_unavailable')

  const timeout = fixture()
  writeFileSync(path.join(timeout.root, 'notes.txt'), 'owner text')
  const timeoutView = await timeout.enrolled(true)
  drainCommands(timeout.child)
  vi.useFakeTimers()

  try {
    const timeoutPending = timeout.drive.metadata(timeoutView.rows[0].id, 'read', timeoutView.revision)
    const timedOut = expect(timeoutPending).rejects.toThrow('matrix_drive_file_unavailable')
    await vi.advanceTimersByTimeAsync(10_001)
    await timedOut
  } finally {
    vi.useRealTimers()
  }
})

it('bounds metadata requests to four in flight', async () => {
  const f = fixture()
  writeFileSync(path.join(f.root, 'notes.txt'), 'owner text')
  const view = await f.enrolled(true)
  drainCommands(f.child)
  const pending = Array.from({ length: 4 }, () => f.drive.metadata(view.rows[0].id, 'read', view.revision))
  const cancelled = pending.map(request => expect(request).rejects.toThrow('matrix_drive_file_unavailable'))
  await expect(f.drive.metadata(view.rows[0].id, 'read', view.revision)).rejects.toThrow(
    'matrix_drive_file_unavailable'
  )
  f.child.emit('close', 1)
  await Promise.all(cancelled)
})

it('rejects replacement files and roots and preserves the old files', async () => {
  const f = fixture(home => ({ defaultFolder: path.join(home, 'Atum', 'Drive') }))
  writeFileSync(path.join(f.root, 'notes.txt'), 'owner text')
  f.bindSaved()
  await f.drive.connect()
  f.send(engineHello)
  f.send({ kind: 'state', state: 'ready' })
  const view = await f.drive.read()
  renameSync(path.join(f.root, 'notes.txt'), path.join(f.root, 'kept.txt'))
  symlinkSync(path.join(f.home, 'outside.txt'), path.join(f.root, 'notes.txt'))
  await expect(f.drive.open(view.rows[0].id)).rejects.toThrow()
  expect(f.options.openPath).not.toHaveBeenCalled()
  renameSync(f.root, f.root + '-kept')
  mkdirSync(f.root)
  expect(await f.drive.read()).toMatchObject({
    state: 'disconnected',
    problem: 'folder_changed',
    canBrowseLocally: false,
    rows: []
  })
  expect(f.child.kill).toHaveBeenCalled()
})

it('fences late picker and engine results when the canonical owner changes', async () => {
  const f = fixture()
  let finish!: (root: string) => void
  f.options.chooseFolder.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const pending = f.drive.chooseFolder()
  await vi.waitFor(() => expect(f.options.chooseFolder).toHaveBeenCalled())
  const rejection = expect(pending).rejects.toThrow('matrix_drive_cancelled')
  f.changeOwner()
  f.drive.activate()
  finish(f.root)
  await rejection
  expect(f.options.spawn).not.toHaveBeenCalled()
  f.send({ kind: 'state', state: 'ready' })
  expect((await f.drive.read()).state).toBe('disconnected')
  expect((await f.drive.read()).rows).toEqual([])
})

it('stops the owner’s process on an account handoff and drops old rows', async () => {
  const f = fixture()
  writeFileSync(path.join(f.root, 'notes.txt'), 'owner text')
  await f.enrolled()
  f.changeOwner()
  f.drive.activate()
  expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
  f.send({ kind: 'state', state: 'ready' })
  const view = await f.drive.read()
  expect(view.state).toBe('disconnected')
  expect(view.rows).toEqual([])
  expect(view.canBrowseLocally).toBe(false)
  expect(view.rootLabel).toBeUndefined()
})

it('blocks reconnect until credential deletion is acknowledged and the child exits', async () => {
  const f = fixture()
  await f.enrolled()
  const disconnect = f.drive.disconnect()
  await vi.waitFor(() => expect(f.child.stdin.readableLength).toBeGreaterThan(0))
  await expect(f.drive.connect()).rejects.toThrow('matrix_drive_unavailable')
  f.send({ kind: 'state', state: 'disconnected' })
  f.child.emit('close', 0)
  expect(await disconnect).toMatchObject({ state: 'disconnected', canBrowseLocally: false, rows: [] })
  expect(await f.drive.read()).toMatchObject({ canBrowseLocally: false, rows: [] })
})

it.each([true, false])('allows slow credential cleanup but requires acknowledgment (ack=%s)', async acknowledged => {
  const f = fixture()
  await f.enrolled()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  try {
    const disconnect = f.drive.disconnect()
    await vi.waitFor(() => expect(drainCommands(f.child).some(command => command.kind === 'forget')).toBe(true))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.child.kill).not.toHaveBeenCalled()
    expect(stored(f, 'drive-cleanup:')).toBe('pending')

    if (acknowledged) {
      f.send({ kind: 'state', state: 'disconnected' })
    }

    f.child.emit('close', 0)

    if (!acknowledged) {
      // Missing acknowledgment triggers a separate stored-credential cleanup.
      // That helper also must fail closed when its deadline expires.
      await vi.waitFor(() => expect(f.options.spawn).toHaveBeenCalledTimes(2))
      await vi.advanceTimersByTimeAsync(45_000)
    }

    expect((await disconnect).state).toBe(acknowledged ? 'disconnected' : 'cleanup_failed')
    expect(stored(f, 'drive-cleanup:')).toBe(acknowledged ? '' : 'pending')
  } finally {
    vi.useRealTimers()
  }
})

it('gives Turn off cleanup the full 45 seconds before killing it', async () => {
  const f = fixture()
  await f.enrolled()
  drainCommands(f.child)
  const helper = freshChild()
  f.child.kill.mockImplementation(() => true)
  f.options.spawn.mockReturnValueOnce(helper as unknown as ChildProcessWithoutNullStreams)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  try {
    const off = f.drive.turnOff()
    await vi.advanceTimersByTimeAsync(0)
    expect(drainCommands(f.child)).toContainEqual({ kind: 'forget' })

    await vi.advanceTimersByTimeAsync(44_999)
    expect(f.child.kill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(f.child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(f.options.spawn).toHaveBeenCalledTimes(2)

    helper.stdout.write(JSON.stringify(engineHello) + '\n')
    expect(drainCommands(helper).map(command => command.kind)).toEqual(['cleanup'])
    helper.stdout.write(JSON.stringify({ kind: 'state', state: 'disconnected' }) + '\n')
    helper.emit('close', 0)

    await expect(off).resolves.toMatchObject({ state: 'disconnected' })
  } finally {
    vi.useRealTimers()
  }
})

it('keeps ordinary quit stop bounded at 12 seconds', async () => {
  const f = fixture()
  await f.enrolled()
  drainCommands(f.child)
  f.child.kill.mockImplementation(() => true)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  try {
    const disposed = f.drive.dispose()
    expect(drainCommands(f.child)).toContainEqual({ kind: 'stop' })

    await vi.advanceTimersByTimeAsync(11_999)
    expect(f.child.kill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(f.child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    await expect(disposed).resolves.toBeUndefined()
  } finally {
    vi.useRealTimers()
  }
})

it('does not accept a disconnected acknowledgment with a nonzero exit or clear its cleanup marker', async () => {
  const f = fixture()
  await f.enrolled()
  drainCommands(f.child)
  const helper = freshChild()
  f.options.spawn.mockReturnValueOnce(helper as unknown as ChildProcessWithoutNullStreams)

  const disconnect = f.drive.disconnect()
  await new Promise(resolve => setImmediate(resolve))
  expect(drainCommands(f.child)).toContainEqual({ kind: 'forget' })
  f.send({ kind: 'state', state: 'disconnected' })
  f.child.emit('close', 7)

  await vi.waitFor(() => expect(f.options.spawn).toHaveBeenCalledTimes(2))
  expect(stored(f, 'drive-cleanup:')).toBe('pending')
  helper.stdout.write(JSON.stringify(engineHello) + '\n')
  expect(drainCommands(helper).map(command => command.kind)).toEqual(['cleanup'])
  helper.stdout.write(JSON.stringify({ kind: 'state', state: 'disconnected' }) + '\n')
  helper.emit('close', 9)

  await expect(disconnect).resolves.toMatchObject({ state: 'cleanup_failed' })
  expect(stored(f, 'drive-cleanup:')).toBe('pending')
  await expect(f.drive.read()).resolves.toMatchObject({ state: 'cleanup_failed' })
  expect(stored(f, 'drive-cleanup:')).toBe('pending')
})

it('keeps reconnect blocked after cleanup timeout until a later helper completes valid cleanup', async () => {
  const f = fixture()
  const key = createHash('sha256').update(JSON.stringify(['https://auth.test/', 'owner-a'])).digest('hex')
  const configDir = path.join(f.home, 'drive-engine', key)
  mkdirSync(configDir, { recursive: true })
  writeFileSync(path.join(configDir, 'atum-drive.cfg'), 'kept account')
  f.store.set('drive-cleanup:' + key, 'pending')

  const timedOut = freshChild()
  timedOut.kill.mockImplementation(() => true)
  const valid = freshChild()
  f.options.spawn
    .mockReturnValueOnce(timedOut as unknown as ChildProcessWithoutNullStreams)
    .mockReturnValueOnce(valid as unknown as ChildProcessWithoutNullStreams)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  try {
    const refused = f.drive.connect()
    const refusal = expect(refused).rejects.toThrow('matrix_drive_cleanup_pending')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.options.spawn).toHaveBeenCalledTimes(1)
    timedOut.stdout.write(JSON.stringify(engineHello) + '\n')
    expect(drainCommands(timedOut).map(command => command.kind)).toEqual(['cleanup'])

    await vi.advanceTimersByTimeAsync(44_999)
    expect(timedOut.kill).not.toHaveBeenCalled()
    expect(stored(f, 'drive-cleanup:')).toBe('pending')

    await vi.advanceTimersByTimeAsync(1)
    expect(timedOut.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    await refusal
    expect(stored(f, 'drive-cleanup:')).toBe('pending')
    expect(f.options.spawn).toHaveBeenCalledTimes(1)

    const reconnect = f.drive.connect()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.options.spawn).toHaveBeenCalledTimes(2)
    valid.stdout.write(JSON.stringify(engineHello) + '\n')
    expect(drainCommands(valid).map(command => command.kind)).toEqual(['cleanup'])
    valid.stdout.write(JSON.stringify({ kind: 'state', state: 'disconnected' }) + '\n')
    valid.emit('close', 0)

    await expect(reconnect).resolves.toMatchObject({ state: 'connecting' })
    expect(stored(f, 'drive-cleanup:')).toBe('')
    expect(f.options.spawn).toHaveBeenCalledTimes(3)
  } finally {
    vi.useRealTimers()
  }
})

it('withdraws account authority immediately and cleans the retired owner once after child exit', async () => {
  const f = fixture()
  writeFileSync(path.join(f.root, 'notes.txt'), 'owner text')
  await f.enrolled()

  const helper = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })

  f.child.kill.mockImplementation(() => true)
  f.options.spawn.mockReturnValueOnce(helper as unknown as ChildProcessWithoutNullStreams)

  const disconnect = f.drive.disconnect()
  f.changeOwner()
  f.drive.activate()
  expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
  expect(await f.drive.read()).toMatchObject({ state: 'disconnected', rows: [] })
  await expect(f.drive.connect()).rejects.toThrow('matrix_drive_unavailable')
  await new Promise(resolve => setImmediate(resolve))
  expect(f.options.spawn).toHaveBeenCalledTimes(1)

  f.child.emit('close', 0)
  await vi.waitFor(() => expect(f.options.spawn).toHaveBeenCalledTimes(2))
  helper.stdout.write(
    JSON.stringify({ kind: 'hello', protocol: 1, issuer: 'https://auth.test/', origin: 'https://drive.test' }) + '\n'
  )
  const cleanup = JSON.parse(helper.stdin.read().toString())
  expect(cleanup).toMatchObject({ kind: 'cleanup', subject: 'owner-a' })
  helper.stdout.write(JSON.stringify({ kind: 'state', state: 'disconnected' }) + '\n')
  helper.emit('close', 0)
  expect((await disconnect).state).toBe('disconnected')
  expect(f.options.spawn).toHaveBeenCalledTimes(2)
})

it('bounds and rejects a directory masquerading as an enrollment marker', async () => {
  const f = fixture()
  await f.enrolled()
  rmSync(path.join(f.root, '.atum-drive-binding.json'))
  mkdirSync(path.join(f.root, '.atum-drive-binding.json'))
  expect(await f.drive.read()).toMatchObject({ state: 'disconnected', problem: 'folder_changed' })
  expect(f.child.kill).toHaveBeenCalled()
})

it('does not restart credential cleanup when account withdrawal follows a completed disconnect', async () => {
  const f = fixture()
  await f.enrolled()
  const disconnect = f.drive.disconnect()
  await new Promise(resolve => setImmediate(resolve))
  f.send({ kind: 'state', state: 'disconnected' })
  f.child.emit('close', 0)
  await disconnect
  const count = f.options.spawn.mock.calls.length
  f.drive.activate(false)
  await new Promise(resolve => setImmediate(resolve))
  expect(f.options.spawn).toHaveBeenCalledTimes(count)
  expect((await f.drive.read()).rows).toEqual([])
})

it('refuses a relative folder picker result before saving a root or starting an engine', async () => {
  const f = fixture()
  f.options.chooseFolder.mockResolvedValue('Files')
  await expect(f.drive.chooseFolder()).rejects.toThrow('matrix_drive_folder_invalid')
  expect(f.options.spawn).not.toHaveBeenCalled()
  expect([...f.store.keys()].some(key => key.startsWith('drive-root:'))).toBe(false)
})

function logged(f: { options: { log: ReturnType<typeof vi.fn> } }): string {
  return f.options.log.mock.calls.map(call => String(call[0])).join('\n')
}

it('never binds a Drive folder that already has other files, says why, opens no picker and starts nothing', async () => {
  const f = fixture()
  writeFileSync(path.join(f.root, 'report.docx'), 'owner text')
  writeFileSync(path.join(f.root, '.DS_Store'), '')
  const view = await f.drive.connect()
  expect(view).toMatchObject({ state: 'disconnected', problem: 'folder_not_empty' })
  expect(f.options.chooseFolder).not.toHaveBeenCalled()
  expect(f.options.spawn).not.toHaveBeenCalled()
  expect([...f.store.entries()].some(([key, value]) => key.startsWith('drive-root:') && value)).toBe(false)
  expect(logged(f)).toContain('drive folder refused problem=folder_not_empty source=default')
  // Emptied again, Turn on starts the engine there.
  rmSync(path.join(f.root, 'report.docx'))
  expect(await f.drive.connect()).toMatchObject({ state: 'connecting' })
  expect(f.options.spawn).toHaveBeenCalledTimes(1)
  expect((await f.drive.read()).problem).toBeUndefined()
})

it('keeps saying why when the folder picker is cancelled after a refusal', async () => {
  const f = fixture()
  writeFileSync(path.join(f.root, 'report.docx'), 'owner text')
  await f.drive.connect()
  f.options.chooseFolder.mockResolvedValueOnce(undefined as unknown as string)
  expect(await f.drive.chooseFolder()).toEqual({ cancelled: true })
  expect((await f.drive.read()).problem).toBe('folder_not_empty')
})

it('a chosen folder with files gets an “Atum Drive” folder inside it, said where, and Drive starts there', async () => {
  const f = fixture()
  const documents = path.join(f.home, 'Documents')
  mkdirSync(documents)
  writeFileSync(path.join(documents, 'taxes.pdf'), 'owner text')
  f.options.chooseFolder.mockResolvedValue(documents)
  const view = await f.drive.chooseFolder()
  const nested = path.join(documents, 'Atum Drive')
  expect(view).toMatchObject({ state: 'connecting', rootLabel: 'Atum Drive' })
  expect(lstatSync(nested).mode & 0o777).toBe(0o700)
  expect(readdirSync(documents).sort()).toEqual(['Atum Drive', 'taxes.pdf'])
  f.send({ kind: 'hello', protocol: 1, issuer: 'https://auth.test/', origin: 'https://drive.test' })
  await vi.waitFor(() =>
    expect(drainCommands(f.child).find(command => command.kind === 'start')).toMatchObject({ root: nested })
  )
  // The person's own choice reconnects at the next launch, like Turn on.
  expect(stored(f, 'drive-enabled:')).toBe('yes')
})

it('refuses a chosen folder whose “Atum Drive” already holds other files, keeping what was saved', async () => {
  const f = fixture()
  const documents = path.join(f.home, 'Documents')
  mkdirSync(path.join(documents, 'Atum Drive'), { recursive: true })
  writeFileSync(path.join(documents, 'taxes.pdf'), 'owner text')
  writeFileSync(path.join(documents, 'Atum Drive', 'old.txt'), 'someone else’s file')
  f.options.chooseFolder.mockResolvedValue(documents)
  expect(await f.drive.chooseFolder()).toMatchObject({ state: 'disconnected', problem: 'folder_nested_taken' })
  expect(readdirSync(documents).sort()).toEqual(['Atum Drive', 'taxes.pdf'])
  expect(f.options.spawn).not.toHaveBeenCalled()
  expect(logged(f)).toContain('drive folder refused problem=folder_nested_taken source=picker')
})

it('frees a saved folder the engine never enrolled once it cannot be used, without an engine', async () => {
  const f = fixture()
  // What 0.18.0 left behind: a folder saved before the engine refused it, set to reconnect.
  writeFileSync(path.join(f.root, 'existing.txt'), 'owner text')
  const { dev, ino } = lstatSync(f.root)
  const owner = f.options.owner()

  const key = createHash('sha256')
    .update(JSON.stringify([owner.issuer, owner.subject]))
    .digest('hex')

  f.store.set('drive-root:' + key, JSON.stringify({ root: f.root, dev, ino }))
  f.store.set('drive-enabled:' + key, 'yes')
  mkdirSync(path.join(f.home, 'drive-engine', key), { recursive: true })
  writeFileSync(path.join(f.home, 'drive-engine', key, 'opencloud.cfg'), '')
  f.drive.activate()
  await vi.waitFor(() =>
    expect(f.options.changed).toHaveBeenLastCalledWith(expect.objectContaining({ problem: 'folder_not_empty' }))
  )
  const view = await f.drive.read()
  expect(view).toMatchObject({ state: 'disconnected', problem: 'folder_not_empty' })
  expect(view.rootLabel).toBeUndefined()
  expect(f.options.spawn).not.toHaveBeenCalled()
  expect(f.store.get('drive-root:' + key)).toBe('')
  expect(f.store.get('drive-enabled:' + key)).toBe('')
  // An account the engine may have kept for that folder is deleted before another is bound.
  expect(f.store.get('drive-cleanup:' + key)).toBe('pending')
  expect(logged(f)).toContain('source=saved')
})

it('frees a never-enrolled folder the engine refused right after start, and logs the cause', async () => {
  const f = fixture()
  expect(await f.drive.connect()).toMatchObject({ state: 'connecting' })
  f.send({ kind: 'hello', protocol: 1, issuer: 'https://auth.test/', origin: 'https://drive.test' })
  await vi.waitFor(() => expect(drainCommands(f.child).some(command => command.kind === 'start')).toBe(true))
  f.send({ kind: 'state', state: 'error' })
  await vi.waitFor(() => expect(f.child.kill).toHaveBeenCalledWith('SIGTERM'))
  const view = await f.drive.read()
  // The folder passed our own rules, so the engine's further rule is reported plainly.
  expect(view).toMatchObject({ state: 'disconnected', problem: 'folder_refused' })
  expect(view.rootLabel).toBeUndefined()
  expect(logged(f)).toContain('drive connect failed stage=start reason=engine_error problem=folder_refused')
  expect(f.options.openExternal).not.toHaveBeenCalled()
})

it('names the folder problem when the folder changed after it was chosen', async () => {
  const f = fixture()
  await f.drive.connect()
  f.send({ kind: 'hello', protocol: 1, issuer: 'https://auth.test/', origin: 'https://drive.test' })
  writeFileSync(path.join(f.root, 'late.txt'), 'owner text')
  f.send({ kind: 'state', state: 'error' })
  await vi.waitFor(() =>
    expect(f.options.changed).toHaveBeenLastCalledWith(expect.objectContaining({ problem: 'folder_not_empty' }))
  )
})

it('keeps the folder and reports engine trouble when the helper exits before answering', async () => {
  const f = fixture()
  f.child.kill.mockImplementation(() => true)
  await f.drive.connect()
  f.child.emit('close', 134, null)
  const view = await f.drive.read()
  expect(view).toMatchObject({ state: 'error', problem: 'engine', rootLabel: 'Files' })
  expect(logged(f)).toContain('drive connect failed stage=hello reason=exit code=134 problem=engine')
  // Try again reuses the same folder: it was never the problem.
  f.child.kill.mockImplementation(() => {
    f.child.emit('close', 0)

    return true
  })
  await f.drive.connect()
  expect(f.options.spawn).toHaveBeenCalledTimes(2)
  expect(f.options.chooseFolder).not.toHaveBeenCalled()
})

it('tells a lookup failure from an unfinished browser sign-in', async () => {
  const lookup = fixture()
  await lookup.drive.connect()
  lookup.send({ kind: 'hello', protocol: 1, issuer: 'https://auth.test/', origin: 'https://drive.test' })
  lookup.send({ kind: 'state', state: 'authorizing' })
  lookup.send({ kind: 'state', state: 'error' })
  await vi.waitFor(() => expect(lookup.child.kill).toHaveBeenCalledWith('SIGTERM'))
  expect(await lookup.drive.read()).toMatchObject({ state: 'error', problem: 'network', rootLabel: 'Files' })
  expect(logged(lookup)).toContain('stage=authorizing reason=engine_error problem=network')

  const signIn = fixture()
  await signIn.drive.connect()
  signIn.send({ kind: 'hello', protocol: 1, issuer: 'https://auth.test/', origin: 'https://drive.test' })
  signIn.send({ kind: 'state', state: 'authorizing' })
  signIn.send({ kind: 'authorize', url: 'https://auth.test/authorize?client_id=engine&state=opaque' })
  await vi.waitFor(() => expect(signIn.options.openExternal).toHaveBeenCalled())
  signIn.send({ kind: 'state', state: 'error' })
  await vi.waitFor(() => expect(signIn.child.kill).toHaveBeenCalledWith('SIGTERM'))
  expect(await signIn.drive.read()).toMatchObject({ state: 'error', problem: 'sign_in' })
  // The sign-in link carries OAuth state: it is opened, never logged.
  expect(logged(signIn)).not.toContain('authorize?')
  expect(logged(signIn)).toContain('stage=authorize reason=engine_error problem=sign_in')
})

it('still calls it a sign-in problem when a kept, signed-out account asks to sign in again', async () => {
  const f = fixture()
  f.bind()
  await f.drive.connect()
  f.send({ kind: 'hello', protocol: 1, issuer: 'https://auth.test/', origin: 'https://drive.test' })
  f.send({ kind: 'state', state: 'authorizing' })
  f.send({ kind: 'state', state: 'reauthenticate' })
  f.send({ kind: 'authorize', url: 'https://auth.test/authorize?state=opaque' })
  f.send({ kind: 'state', state: 'reauthenticate' })
  f.send({ kind: 'state', state: 'error' })
  await vi.waitFor(() => expect(f.child.kill).toHaveBeenCalledWith('SIGTERM'))
  expect(await f.drive.read()).toMatchObject({ state: 'error', problem: 'sign_in', rootLabel: 'Files' })
})

it('starts with the app’s own Atum access token and opens no browser', async () => {
  const expiresAt = Date.now() + 300_000
  const credential = vi.fn(async () => ({ accessToken: 'app-access', expiresAt }))
  const f = fixture(() => ({ credential }))
  await f.drive.connect()
  f.send(engineHello)
  await vi.waitFor(() =>
    expect(drainCommands(f.child).find(command => command.kind === 'start')).toMatchObject({
      credential: { accessToken: 'app-access', expiresAt }
    })
  )
  f.send({ kind: 'state', state: 'connecting' })
  await vi.waitFor(async () => expect((await f.drive.read()).state).toBe('connecting'))
  expect(credential).toHaveBeenCalledWith(undefined)
  expect(f.options.openExternal).not.toHaveBeenCalled()
  expect([...f.store.values()].join('\n')).not.toContain('app-access')
})

it('renews the app token when the engine asks; a lost grant fails closed, never a browser', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  try {
    const credential = vi.fn(async (refused: string | undefined) => ({
      accessToken: refused === undefined ? 'app-access' : refused === 'app-access' ? 'app-access-2' : 'app-access-3',
      expiresAt: Date.now() + 300_000
    }))

    const f = fixture(() => ({ credential }))

    await f.drive.connect()
    f.send(engineHello)
    f.send({ kind: 'state', state: 'connecting' })
    await until(() => expect((f.drive as unknown as { credential?: unknown }).credential).toBeDefined())
    f.send({ kind: 'credential_request' })
    await until(() =>
      expect(drainCommands(f.child).find(command => command.kind === 'credential')).toEqual({
        kind: 'credential',
        accessToken: 'app-access-2',
        expiresAt: expect.any(Number)
      })
    )
    expect(credential).toHaveBeenLastCalledWith('app-access', { issuer: 'https://auth.test/', subject: 'owner-a' })
    expect(f.options.openExternal).not.toHaveBeenCalled()
    expect(logged(f)).toContain('credential renewed')

    // `offline` right after a handoff is the refused-token case, not a working account.
    f.bind()
    f.send({ kind: 'state', state: 'offline' })
    expect((await f.drive.read()).state).toBe('connecting')
    expect(logged(f)).not.toContain('credential renewal budget restored')

    // A held `ready` repays the two-attempt budget, so a later expiry renews again.
    f.send({ kind: 'state', state: 'ready' })
    await until(async () => expect((await f.drive.read()).state).toBe('ready'))
    await vi.advanceTimersByTimeAsync(MATRIX_DRIVE_RENEWAL_SETTLED_MS)
    expect(logged(f)).toContain('credential renewal budget restored')
    credential.mockResolvedValueOnce({ accessToken: 'app-access-3', expiresAt: Date.now() + 300_000 })
    f.send({ kind: 'credential_request' })
    await until(() =>
      expect(drainCommands(f.child).find(command => command.kind === 'credential')).toMatchObject({
        accessToken: 'app-access-3'
      })
    )
    expect(credential).toHaveBeenLastCalledWith('app-access-2', { issuer: 'https://auth.test/', subject: 'owner-a' })

    credential.mockResolvedValue(null)
    f.send({ kind: 'credential_request' })
    await until(() => expect(logged(f)).toContain('credential renewal unavailable; waiting for the next request'))
    expect(f.child.kill).not.toHaveBeenCalled()

    // A second failed request spends the bounded budget: the connect stops with Try again.
    f.send({ kind: 'credential_request' })
    await until(() => expect(f.child.kill).toHaveBeenCalledWith('SIGTERM'))
    expect(logged(f)).toContain('reason=credential_unavailable')
    expect(f.options.openExternal).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('keeps a working engine through one transient renewal failure, then renews on the next ask', async () => {
  const credential = vi.fn(async (refused: string | undefined) => ({
    accessToken: refused === undefined ? 'app-access' : 'app-access-2',
    expiresAt: Date.now() + 300_000
  }))

  const f = fixture(() => ({ credential }))

  await f.drive.connect()
  f.send(engineHello)
  f.bind()
  f.send({ kind: 'state', state: 'ready' })
  await until(() => expect((f.drive as unknown as { credential?: unknown }).credential).toBeDefined())
  drainCommands(f.child)

  credential.mockResolvedValueOnce(null)
  f.send({ kind: 'credential_request' })
  await until(() => expect(logged(f)).toContain('credential renewal unavailable; waiting for the next request'))
  expect(f.child.kill).not.toHaveBeenCalled()

  // The engine asks again after its cool-down; this time the platform answers.
  f.send({ kind: 'credential_request' })
  await until(() =>
    expect(drainCommands(f.child).find(command => command.kind === 'credential')).toMatchObject({
      accessToken: 'app-access-2'
    })
  )
  expect(f.child.kill).not.toHaveBeenCalled()
  expect(f.options.openExternal).not.toHaveBeenCalled()
})

it('caps a refused app token at two renewals, then stops on a Try again row instead of rotating forever', async () => {
  const credential = vi.fn(async (refused: string | undefined) => ({
    accessToken: refused ? 'app-access-2' : 'app-access',
    expiresAt: Date.now() + 300_000
  }))

  const f = fixture(() => ({ credential }))

  await f.drive.connect()
  f.send(engineHello)
  f.send({ kind: 'state', state: 'connecting' })
  await vi.waitFor(() => expect((f.drive as unknown as { credential?: unknown }).credential).toBeDefined())

  const rotations = () => credential.mock.calls.filter(([refused]) => refused !== undefined).length

  // The refused token is "adopted" and reported offline every 2 s. That must not repay the cap.
  f.bind()

  for (const expected of [1, 2]) {
    f.send({ kind: 'credential_request' })
    await vi.waitFor(() => expect(rotations()).toBe(expected))
    drainCommands(f.child)
    f.send({ kind: 'state', state: 'offline' })
    expect((await f.drive.read()).state).toBe('connecting')
  }

  // The third ask is past the cap: stop, and leave the status row the person can retry.
  f.send({ kind: 'credential_request' })
  await vi.waitFor(() => expect(f.child.kill).toHaveBeenCalledWith('SIGTERM'))
  expect(rotations()).toBe(2)
  expect(await f.drive.read()).toMatchObject({ state: 'error' })
  expect(logged(f)).toContain('credential renewal budget spent; stopping')
  expect(f.options.openExternal).not.toHaveBeenCalled()
})

it('shows a persisted refusal after relaunch as a status row, not an endless Getting ready', async () => {
  const f = fixture()
  f.store.set('drive-auto:' + ownerKey(f), 'refused')
  const options = f.relaunch()
  const launch = new MatrixDrive(options)
  expect(await launch.read()).toMatchObject({ state: 'disconnected', problem: 'not_allowed' })
  expect(logged(f)).toContain('automatic stop restored refused')
  // The stored stop still blocks the automatic path; Try again is the person's way out.
  launch.autoConnect()
  await new Promise(resolve => setImmediate(resolve))
  expect(options.spawn).not.toHaveBeenCalled()
})

it('restores a persisted folder stop with its reason and keeps it until Try again', async () => {
  const f = fixture()
  const blocker = path.join(f.root, 'someone-else.txt')
  writeFileSync(blocker, 'not Drive’s')
  f.drive.autoConnect()
  await vi.waitFor(() => expect(logged(f)).toContain('first connect waits for a folder'))
  expect(stored(f, 'drive-auto:')).toBe('folder')
  expect(stored(f, 'drive-stop:')).toBe('folder_not_empty')

  // The folder problem is the kind the page gives its quiet "Choose another folder…" link to.
  // Emptying the folder does not silently retry it: Try again is the person's way forward.
  rmSync(blocker)
  const options = f.relaunch()
  const later = new MatrixDrive(options)
  expect(await later.read()).toMatchObject({ state: 'disconnected', problem: 'folder_not_empty' })
  later.autoConnect()
  await new Promise(resolve => setImmediate(resolve))
  expect(options.spawn).not.toHaveBeenCalled()

  // The person's Try again does clear the stop and run the same automatic connect.
  await later.connect()
  expect(options.spawn).toHaveBeenCalledOnce()
  expect(stored(f, 'drive-auto:')).toBe('')
  expect(stored(f, 'drive-stop:')).toBe('')
})

it('fails closed without a token when the app owns the handoff, and never starts a browser', async () => {
  const credential = vi.fn(async () => null)
  const f = fixture(() => ({ credential }))
  await f.drive.connect()
  expect(f.options.spawn).not.toHaveBeenCalled()
  expect(f.options.openExternal).not.toHaveBeenCalled()
  expect(await f.drive.read()).toMatchObject({ state: 'error', problem: 'network' })
  expect(logged(f)).toContain('reason=matrix_drive_credential_unavailable')
})

it('an engine that asks for a browser despite the app token fails closed, opening nothing', async () => {
  const credential = vi.fn(async () => ({ accessToken: 'app-access', expiresAt: Date.now() + 300_000 }))
  const f = fixture(() => ({ credential }))
  await f.drive.connect()
  f.send(engineHello)
  await vi.waitFor(() => expect(drainCommands(f.child).some(command => command.kind === 'start')).toBe(true))
  f.send(signInPage)
  await vi.waitFor(() => expect(f.child.kill).toHaveBeenCalledWith('SIGTERM'))
  expect(f.options.openExternal).not.toHaveBeenCalled()
  expect(await f.drive.read()).toMatchObject({ state: 'error', problem: 'engine' })
  expect(logged(f)).toContain('reason=credential_refused')
})

it('rejects a credential request from an engine the app gave no token to', async () => {
  const f = fixture()
  await f.drive.connect()
  f.send(engineHello)
  f.send({ kind: 'credential_request' })
  await vi.waitFor(() => expect(f.child.kill).toHaveBeenCalledWith('SIGTERM'))
  expect(await f.drive.read()).toMatchObject({ state: 'error', problem: 'engine' })
  expect(f.options.openExternal).not.toHaveBeenCalled()
})

it('never drops an enrolled folder: a sync error stays a plain error with the folder kept', async () => {
  const f = fixture()
  writeFileSync(path.join(f.root, 'notes.txt'), 'owner text')
  await f.enrolled()
  f.send({ kind: 'state', state: 'error' })
  const view = await f.drive.read()
  expect(view.state).toBe('error')
  expect(view.problem).toBeUndefined()
  expect(view.rootLabel).toBe('Files')
  expect([...f.store.entries()].some(([key, value]) => key.startsWith('drive-root:') && value)).toBe(true)
})

it('logs every later engine state so a transient first offline is visible as online again', async () => {
  const f = fixture()
  f.bind()
  await f.drive.connect()
  f.send(engineHello)
  f.send({ kind: 'state', state: 'offline' })
  await until(() => expect(logged(f)).toContain('engine connected state=offline'))

  f.send({ kind: 'state', state: 'ready' })
  await until(() => expect(logged(f)).toContain('engine state=ready'))
  expect(logged(f)).not.toContain('engine connected state=ready')
})

it('logs closed codes only: no folder path, subject or engine output', async () => {
  const f = fixture()
  writeFileSync(path.join(f.root, 'private.txt'), 'owner text')
  await f.drive.connect()
  rmSync(path.join(f.root, 'private.txt'))
  await f.drive.connect()
  f.child.stderr.write('oauth refresh_token=secret-value\n')
  f.send({ kind: 'hello', protocol: 1, issuer: 'https://auth.test/', origin: 'https://drive.test' })
  f.send({ kind: 'state', state: 'error' })
  await vi.waitFor(() => expect(logged(f)).toContain('connect failed'))
  const lines = logged(f)
  expect(lines).not.toContain(f.home)
  expect(lines).not.toContain('Files')
  expect(lines).not.toContain('owner-a')
  expect(lines).not.toContain('secret-value')

  for (const line of lines.split('\n')) {
    expect(line).toMatch(/^\[Matrix\] drive [a-z -]+/)
  }
})

// ── First run (`~/Atum/Drive`) and a first connect's honest stop ─────────────────────────────

const atumDrive = (home: string) => ({ defaultFolder: path.join(home, 'Atum', 'Drive') })
const engineHello = { kind: 'hello', protocol: 1, issuer: 'https://auth.test/', origin: 'https://drive.test' }
const signInPage = { kind: 'authorize', url: 'https://auth.test/authorize?state=opaque' }

function stored(f: { store: Map<string, string> }, prefix: string): string | undefined {
  return [...f.store].find(([key]) => key.startsWith(prefix))?.[1]
}

function freshChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      child.emit('close', 0)

      return true
    })
  })

  return child
}

it('continues a safe Drive authorization in the existing sign-in tab', async () => {
  const open = vi.fn(async () => true)
  const f = fixture(home => ({ ...atumDrive(home), open }))
  const folder = path.join(f.home, 'Atum', 'Drive')
  const authorization = f.drive.prepareChainedAuthorization()

  await vi.waitFor(() => expect(f.options.spawn).toHaveBeenCalledOnce())
  expect(open).toHaveBeenCalledOnce()
  expect(f.options.chooseFolder).not.toHaveBeenCalled()
  f.send(engineHello)
  await vi.waitFor(() =>
    expect(drainCommands(f.child).find(command => command.kind === 'start')).toMatchObject({
      root: folder,
      chained: true
    })
  )
  f.send(signInPage)
  await expect(authorization).resolves.toBe(signInPage.url)
  expect(f.options.openExternal).not.toHaveBeenCalled()
  expect(stored(f, 'drive-enabled:')).toBeUndefined()

  f.send({ kind: 'state', state: 'connecting' })
  await vi.waitFor(() => expect(stored(f, 'drive-enabled:')).toBe('yes'))
})

it('never chains when Drive is closed or this account stopped automatic Drive', async () => {
  const closed = fixture(home => ({ ...atumDrive(home), open: vi.fn(async () => false) }))
  await expect(closed.drive.prepareChainedAuthorization()).resolves.toBeUndefined()
  expect(closed.options.open).toHaveBeenCalledOnce()
  expect(closed.options.spawn).not.toHaveBeenCalled()
  expect(existsSync(path.join(closed.home, 'Atum', 'Drive'))).toBe(false)

  const stopped = fixture(home => ({ ...atumDrive(home), open: vi.fn(async () => true) }))
  stopped.store.set('drive-auto:' + ownerKey(stopped), 'refused')
  await expect(stopped.drive.prepareChainedAuthorization()).resolves.toBeUndefined()
  expect(stopped.options.open).not.toHaveBeenCalled()
  expect(stopped.options.spawn).not.toHaveBeenCalled()
})

it('falls back to the normal browser opening when the sign-in-tab deadline passes', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })

  try {
    const f = fixture(home => ({ ...atumDrive(home), open: vi.fn(async () => true) }))
    const authorization = f.drive.prepareChainedAuthorization()
    await until(() => expect(f.options.spawn).toHaveBeenCalledOnce())
    f.send(engineHello)
    await until(() =>
      expect(drainCommands(f.child).find(command => command.kind === 'start')).toMatchObject({ chained: true })
    )

    await vi.advanceTimersByTimeAsync(MATRIX_DRIVE_CHAIN_WAIT_MS)
    await expect(authorization).resolves.toBeUndefined()
    expect(f.options.openExternal).not.toHaveBeenCalled()
    f.send(signInPage)
    await until(() => expect(f.options.openExternal).toHaveBeenCalledWith(signInPage.url))
    f.send({ kind: 'state', state: 'connecting' })
    await until(() => expect(stored(f, 'drive-enabled:')).toBe('yes'))
    expect(logged(f)).toContain('sign-in trip timed out; continuing automatically')
  } finally {
    vi.useRealTimers()
  }
})

it.each(['https://foreign.test/authorize', 'http://auth.test/authorize', 'https://user@auth.test/authorize'])(
  'refuses an unsafe chained authorization URL: %s',
  async url => {
    const f = fixture(home => ({ ...atumDrive(home), open: vi.fn(async () => true) }))
    const authorization = f.drive.prepareChainedAuthorization()
    await vi.waitFor(() => expect(f.options.spawn).toHaveBeenCalledOnce())
    f.send(engineHello)
    f.send({ kind: 'authorize', url })
    await expect(authorization).resolves.toBeUndefined()
    expect(f.options.openExternal).not.toHaveBeenCalled()
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
  }
)

it('cancels a delivered Drive hop without leaving its engine or unused default root', async () => {
  const f = fixture(home => ({ ...atumDrive(home), open: vi.fn(async () => true) }))
  const folder = path.join(f.home, 'Atum', 'Drive')
  const authorization = f.drive.prepareChainedAuthorization()
  await vi.waitFor(() => expect(f.options.spawn).toHaveBeenCalledOnce())
  f.send(engineHello)
  f.send(signInPage)
  await expect(authorization).resolves.toBe(signInPage.url)

  f.drive.cancelChainedAuthorization()
  await vi.waitFor(() => expect(drainCommands(f.child).some(command => command.kind === 'forget')).toBe(true))
  f.send({ kind: 'state', state: 'disconnected' })
  f.child.emit('close', 0)
  await vi.waitFor(() => expect(existsSync(folder)).toBe(false))
  expect(f.options.openExternal).not.toHaveBeenCalled()
  expect(stored(f, 'drive-enabled:')).toBe('')
})

it('first run: makes an empty, private ~/Atum/Drive and connects into it on its own, with no picker', async () => {
  const f = fixture(atumDrive)
  const folder = path.join(f.home, 'Atum', 'Drive')
  f.drive.autoConnect()
  await vi.waitFor(() => expect(f.options.spawn).toHaveBeenCalledOnce())
  expect(f.options.chooseFolder).not.toHaveBeenCalled()
  expect(lstatSync(folder).isDirectory()).toBe(true)
  expect(lstatSync(folder).mode & 0o777).toBe(0o700)
  expect(readdirSync(folder)).toEqual([])
  f.send(engineHello)
  f.send(signInPage)
  await vi.waitFor(() => expect(f.options.openExternal).toHaveBeenCalledOnce())
  expect(drainCommands(f.child).find(command => command.kind === 'start')).toMatchObject({ root: folder })
  expect((await f.drive.read()).rootLabel).toBe('Drive')
  expect(logged(f)).toContain('connect started automatically: Drive is open')
})

it('a ~/Atum/Drive that already has files: automatic setup shows a status row, never a picker', async () => {
  const f = fixture(atumDrive)
  const folder = path.join(f.home, 'Atum', 'Drive')
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'notes.txt'), 'someone else’s file')
  f.drive.autoConnect()
  await vi.waitFor(() => expect(logged(f)).toContain('first connect waits for a folder'))
  expect(logged(f)).toContain('default folder skipped problem=folder_not_empty')
  expect(f.options.chooseFolder).not.toHaveBeenCalled()
  expect(f.options.spawn).not.toHaveBeenCalled()
  expect(await f.drive.read()).toMatchObject({ state: 'disconnected', problem: 'folder_not_empty' })

  // Once per account on this Mac: even with the folder emptied, it doesn't start by itself again,
  // in this launch or the next.
  rmSync(path.join(folder, 'notes.txt'))
  f.drive.autoConnect()
  new MatrixDrive(f.options).autoConnect()
  await new Promise(resolve => setImmediate(resolve))
  expect(f.options.spawn).not.toHaveBeenCalled()

  // With files in it again, Try again says why; only the folder-conflict recovery asks.
  writeFileSync(path.join(folder, 'notes.txt'), 'back again')
  expect(await f.drive.connect()).toMatchObject({ state: 'disconnected', problem: 'folder_not_empty' })
  expect(f.options.chooseFolder).not.toHaveBeenCalled()
  await f.drive.chooseFolder()
  expect(f.options.chooseFolder).toHaveBeenCalledOnce()
  f.send(engineHello)
  await vi.waitFor(() =>
    expect(drainCommands(f.child).find(command => command.kind === 'start')).toMatchObject({ root: f.root })
  )
})

it('adopts this owner’s own enrolled ~/Atum/Drive (a reinstall) instead of asking for a folder', async () => {
  const f = fixture(atumDrive)
  const folder = path.join(f.home, 'Atum', 'Drive')
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'Plan.docx'), 'synced before')
  writeFileSync(
    path.join(folder, '.atum-drive-binding.json'),
    JSON.stringify({
      version: 1,
      canonicalRoot: folder,
      issuer: 'https://auth.test/',
      subject: 'owner-a',
      origin: 'https://drive.test',
      journal: '.atum-drive-journal.db',
      space: 'storage$personal'
    })
  )
  f.drive.autoConnect()
  await vi.waitFor(() => expect(f.options.spawn).toHaveBeenCalledOnce())
  f.send(engineHello)
  await vi.waitFor(() =>
    expect(drainCommands(f.child).find(command => command.kind === 'start')).toMatchObject({ root: folder })
  )
  expect(f.options.chooseFolder).not.toHaveBeenCalled()
})

it('never starts a second connect over the launch reconnect, nor without the engine', async () => {
  const saved = fixture(atumDrive)
  await saved.drive.connect()
  expect(saved.options.spawn).toHaveBeenCalledOnce()
  const options = saved.relaunch()
  const relaunch = new MatrixDrive(options)
  relaunch.autoConnect()
  relaunch.autoConnect()
  await new Promise(resolve => setImmediate(resolve))
  // The person's Turn on reconnects at launch; the automatic connect leaves it to that.
  expect(options.spawn).toHaveBeenCalledOnce()
  expect(logged(saved)).not.toContain('connect started automatically')

  const engineless = fixture(atumDrive)
  const drive = new MatrixDrive({ ...engineless.options, engine: undefined })
  drive.autoConnect()
  await new Promise(resolve => setImmediate(resolve))
  expect(engineless.options.spawn).not.toHaveBeenCalled()
  expect(readdirSync(engineless.home)).not.toContain('Atum')
})

it('after a folder problem, Turn on tries ~/Atum/Drive again and only Choose another folder opens the picker', async () => {
  const f = fixture(atumDrive)
  await f.drive.connect()
  expect(f.options.chooseFolder).not.toHaveBeenCalled()
  f.send(engineHello)
  f.send({ kind: 'state', state: 'error' })
  await vi.waitFor(async () =>
    expect(await f.drive.read()).toMatchObject({ state: 'disconnected', problem: 'folder_refused' })
  )
  const again = freshChild()
  f.options.spawn.mockImplementation(() => again as unknown as ChildProcessWithoutNullStreams)
  expect(await f.drive.connect()).toMatchObject({ state: 'connecting', rootLabel: 'Drive' })
  expect(f.options.chooseFolder).not.toHaveBeenCalled()
  // While an engine runs, its folder is kept: another folder is chosen only once Drive stopped.
  await expect(f.drive.chooseFolder()).rejects.toThrow('matrix_drive_unavailable')
  again.emit('close', 134, null)
  await vi.waitFor(async () => expect((await f.drive.read()).state).toBe('error'))
  await f.drive.chooseFolder()
  expect(f.options.chooseFolder).toHaveBeenCalledOnce()
})

it('names a first connect’s stop from whether Drive answers and how long after sign-in it came', () => {
  const hold = MATRIX_DRIVE_SETUP_HOLD_MS
  const split = MATRIX_DRIVE_SETUP_CLASSIFY_MS
  // Drive's server doesn't answer: a real network problem, whatever the stage.
  expect(matrixDriveFirstConnectProblem('authorize', false, 2_000)).toBe('network')
  expect(matrixDriveFirstConnectProblem('connected', false, hold * 2)).toBe('network')
  // Up, and turned the account away at once (403 not_allowed / not_provisioned / suspended).
  expect(matrixDriveFirstConnectProblem('authorize', true, 2_000)).toBe('not_allowed')
  expect(matrixDriveFirstConnectProblem('connected', true, split - 1)).toBe('not_allowed')
  // Up, and answered only after its hold: the server's 503 comes 43.75–44.5 s after the request
  // reached it, and a retry's sign-in can come straight back, so 44 s is still "being set up".
  expect(split).toBeLessThan(hold)
  expect(matrixDriveFirstConnectProblem('authorize', true, 44_000)).toBe('setting_up')
  expect(matrixDriveFirstConnectProblem('connected', true, 44_000)).toBe('setting_up')
  expect(matrixDriveFirstConnectProblem('authorize', true, hold + 1_000)).toBe('setting_up')
  expect(matrixDriveFirstConnectProblem('connected', true, hold * 10)).toBe('setting_up')
  expect(matrixDriveFirstConnectProblem('authorizing', true, hold)).toBe('setting_up')
  // Before sign-in only anonymous lookups ran; long after the page opened, nobody signed in.
  expect(matrixDriveFirstConnectProblem('authorizing', true, 2_000)).toBe('network')
  expect(matrixDriveFirstConnectProblem('authorize', true, hold * 10)).toBe('sign_in')
})

it('asks Drive anonymously whether it answers: status.php, no credential, no redirect', async () => {
  const calls: [URL, RequestInit][] = []

  const answer = (status: number) =>
    vi.fn(async (url: URL, init: RequestInit) => {
      calls.push([url, init])

      return new Response('{"installed":true}', { status })
    }) as unknown as typeof fetch

  expect(await matrixDriveReachable('https://drive.test', answer(200))).toBe(true)
  expect(await matrixDriveReachable('https://drive.test', answer(503))).toBe(false)
  expect(
    await matrixDriveReachable(
      'https://drive.test',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch
    )
  ).toBe(false)
  expect(String(calls[0][0])).toBe('https://drive.test/status.php')
  expect(calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' })
  expect(new Headers(calls[0][1].headers).has('authorization')).toBe(false)
})

it('a first connect Drive turns away right after sign-in: “not open for this account”, and no browser at every launch', async () => {
  const reachable = vi.fn(async () => true)
  const f = fixture(home => ({ ...atumDrive(home), reachable }))
  await f.drive.connect()
  f.send(engineHello)
  f.send(signInPage)
  await vi.waitFor(() => expect(f.options.openExternal).toHaveBeenCalledOnce())
  f.send({ kind: 'state', state: 'error' })
  await vi.waitFor(async () => expect(await f.drive.read()).toMatchObject({ state: 'error', problem: 'not_allowed' }))
  expect(reachable).toHaveBeenCalledOnce()
  expect(logged(f)).toMatch(/connect failed stage=authorize reason=engine_error problem=checking/)
  expect(logged(f)).toMatch(/drive check reachable=yes after=\d+s problem=not_allowed$/m)
  expect(stored(f, 'drive-enabled:')).toBe('')
  // The empty ~/Atum/Drive it never set up goes and is unbound; Try again makes it again, no picker.
  expect(existsSync(path.join(f.home, 'Atum', 'Drive'))).toBe(false)
  expect(stored(f, 'drive-root:')).toBe('')
  expect(logged(f)).toContain('default folder released')
  // Nor does a later launch send the refused account to the browser by itself, even "open".
  expect(stored(f, 'drive-auto:')).toBe('refused')
  const options = f.relaunch()
  new MatrixDrive(options).autoConnect()
  await new Promise(resolve => setImmediate(resolve))
  expect(options.spawn).not.toHaveBeenCalled()
  f.options.spawn.mockImplementation(() => freshChild() as unknown as ChildProcessWithoutNullStreams)
  await f.drive.connect()
  expect(f.options.chooseFolder).not.toHaveBeenCalled()
  expect(lstatSync(path.join(f.home, 'Atum', 'Drive')).isDirectory()).toBe(true)
})

it('keeps a real network failure a network failure, even after the engine reported an account', async () => {
  const f = fixture(home => ({ ...atumDrive(home), reachable: async () => false }))
  await f.drive.connect()
  f.send(engineHello)
  f.send(signInPage)
  f.send({ kind: 'state', state: 'connecting' })
  // Not enrolled yet: an error here is a first connect that failed, not a sync error.
  f.send({ kind: 'state', state: 'error' })
  await vi.waitFor(async () => expect(await f.drive.read()).toMatchObject({ state: 'error', problem: 'network' }))
  expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
  expect(stored(f, 'drive-enabled:')).toBe('yes')
})

it('while Drive is being set up it says so and tries again by itself with backoff, then hands over to Try again', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })

  try {
    const f = fixture(home => ({ ...atumDrive(home), reachable: async () => true }))
    const children: ReturnType<typeof freshChild>[] = []
    f.options.spawn.mockImplementation(() => {
      const child = freshChild()
      children.push(child)

      return child as unknown as ChildProcessWithoutNullStreams
    })

    const flush = async () => {
      for (let turn = 0; turn < 5; turn++) {
        await new Promise(resolve => setImmediate(resolve))
      }
    }

    const say = (child: ReturnType<typeof freshChild>, message: unknown) =>
      child.stdout.write(JSON.stringify(message) + '\n')

    await f.drive.connect()

    for (let attempt = 0; attempt <= MATRIX_DRIVE_SETUP_RETRY_MS.length; attempt++) {
      expect(f.options.spawn).toHaveBeenCalledTimes(attempt + 1)
      const child = children[attempt]
      say(child, engineHello)
      say(child, signInPage)
      await flush()
      // Drive held the first request for its 45 s, then answered "still being set up".
      vi.setSystemTime(Date.now() + MATRIX_DRIVE_SETUP_HOLD_MS + 5_000)
      say(child, { kind: 'state', state: 'error' })
      await flush()

      if (attempt < MATRIX_DRIVE_SETUP_RETRY_MS.length) {
        expect(await f.drive.read()).toMatchObject({ state: 'connecting', problem: 'setting_up' })
        await vi.advanceTimersByTimeAsync(MATRIX_DRIVE_SETUP_RETRY_MS[attempt] - 1)
        expect(f.options.spawn).toHaveBeenCalledTimes(attempt + 1)
        await vi.advanceTimersByTimeAsync(1)
        await flush()
      }
    }

    // Retries spent: the reason stays, with Try again; nothing starts by itself any more.
    expect(await f.drive.read()).toMatchObject({ state: 'error', problem: 'setting_up' })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(f.options.spawn).toHaveBeenCalledTimes(MATRIX_DRIVE_SETUP_RETRY_MS.length + 1)
    expect(logged(f)).toMatch(/problem=setting_up retry_in=15s/)
    expect(f.options.openExternal).toHaveBeenCalledTimes(MATRIX_DRIVE_SETUP_RETRY_MS.length + 1)
  } finally {
    vi.useRealTimers()
  }
})

it('keeps local faults local: a browser that won’t open is still a sign-in problem, not a refusal', async () => {
  const reachable = vi.fn(async () => true)
  const f = fixture(home => ({ ...atumDrive(home), reachable }))
  f.options.openExternal.mockImplementation(async () => {
    throw new Error('no browser')
  })
  await f.drive.connect()
  f.send(engineHello)
  f.send(signInPage)
  await vi.waitFor(async () => expect(await f.drive.read()).toMatchObject({ state: 'error', problem: 'sign_in' }))
  expect(reachable).not.toHaveBeenCalled()
})

// ── A first run never reopens the browser behind the person's back, and waits for an open Drive ──

it('an automatic sign-in left unfinished is tried again at each next launch, once per launch', async () => {
  const f = fixture(atumDrive)
  const folder = path.join(f.home, 'Atum', 'Drive')
  f.drive.autoConnect()
  await vi.waitFor(() => expect(f.options.spawn).toHaveBeenCalledOnce())
  f.send(engineHello)
  f.send({ kind: 'state', state: 'authorizing' })
  f.send(signInPage)
  await vi.waitFor(() => expect(f.options.openExternal).toHaveBeenCalledOnce())
  // Nothing marks Drive to reconnect until it reports an account.
  expect(stored(f, 'drive-enabled:')).toBeUndefined()
  // The browser isn't finished and the person quits: the folder Drive never set up goes.
  const quit = f.drive.dispose()
  f.child.emit('close', 0, null)
  await quit
  expect(existsSync(folder)).toBe(false)
  expect(logged(f)).toContain('default folder released')

  for (let launch = 2; launch <= 3; launch++) {
    const options = f.relaunch()
    const next = new MatrixDrive(options)
    next.activate(true)
    // Snapshots keep coming: one try per launch.
    next.autoConnect()
    next.autoConnect()
    await vi.waitFor(() => expect(options.spawn).toHaveBeenCalledOnce())
    const child = options.spawn.mock.results[0].value as ReturnType<typeof freshChild>
    child.stdout.write(JSON.stringify(engineHello) + '\n')
    child.stdout.write(JSON.stringify(signInPage) + '\n')
    await vi.waitFor(async () => expect((await next.read()).waitingForBrowser).toBe(true))
    next.autoConnect()
    expect(options.spawn).toHaveBeenCalledOnce()

    const stopped = next.dispose()
    child.emit('close', 0, null)
    await stopped
  }

  expect(f.options.openExternal).toHaveBeenCalledTimes(3)
  // An unfinished sign-in never writes a stop: the next launch tries again by itself.
  expect(stored(f, 'drive-auto:')).toBeUndefined()
  expect(existsSync(folder)).toBe(false)
})

it('an automatic first run that reaches an account reconnects at the next launch, and an enrolled folder is never removed', async () => {
  const f = fixture(atumDrive)
  const folder = path.join(f.home, 'Atum', 'Drive')
  f.drive.autoConnect()
  await vi.waitFor(() => expect(f.options.spawn).toHaveBeenCalledOnce())
  f.send(engineHello)
  f.send(signInPage)
  f.send({ kind: 'state', state: 'connecting' })
  await vi.waitFor(() => expect(stored(f, 'drive-enabled:')).toBe('yes'))
  // The engine enrolls the folder; the person drops a file in and quits: nothing is removed.
  writeFileSync(
    path.join(folder, '.atum-drive-binding.json'),
    JSON.stringify({
      version: 1,
      canonicalRoot: realpathSync(folder),
      issuer: 'https://auth.test/',
      subject: 'owner-a',
      origin: 'https://drive.test',
      journal: '.atum-drive-journal.db',
      space: 'storage$personal'
    })
  )
  writeFileSync(path.join(folder, 'Plan.pdf'), 'mine')
  const quit = f.drive.dispose()
  f.child.emit('close', 0, null)
  await quit
  expect(readdirSync(folder).sort()).toEqual(['.atum-drive-binding.json', 'Plan.pdf'])
  const spawn = vi.fn(() => freshChild() as unknown as ChildProcessWithoutNullStreams)
  const next = new MatrixDrive({ ...f.options, spawn })
  next.activate(true)
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
})

// ── Drive stays on, and turns itself back on, without a Turn on to press ───────────────────

/** The store key Drive uses for the fixture's owner-a. */
const ownerA = createHash('sha256').update(JSON.stringify(['https://auth.test/', 'owner-a'])).digest('hex')

function enrollFolder(folder: string, subject = 'owner-a') {
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    path.join(folder, '.atum-drive-binding.json'),
    JSON.stringify({
      version: 1,
      canonicalRoot: folder,
      issuer: 'https://auth.test/',
      subject,
      origin: 'https://drive.test',
      journal: '.atum-drive-journal.db',
      space: 'storage$personal'
    })
  )
}

async function settle() {
  for (let turn = 0; turn < 5; turn++) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

/** Real turns (file system work included) until `check` passes, without moving fake timers. */
async function until(check: () => unknown | Promise<unknown>) {
  for (let turn = 0; ; turn++) {
    try {
      await check()

      return
    } catch (error) {
      if (turn >= 500) {
        throw error
      }

      await new Promise(resolve => setImmediate(resolve))
    }
  }
}

it('a quit is not a sign-out: Drive keeps its sign-in and folder, and the next launch reconnects with no browser', async () => {
  const f = fixture()
  writeFileSync(path.join(f.root, 'notes.txt'), 'owner text')
  await f.enrolled()
  expect(stored(f, 'drive-enabled:')).toBe('yes')
  const quit = f.drive.dispose()
  // From here main's owner() is null, as at a sign-out; late snapshots and Drive lookups still come.
  f.quit()
  f.drive.activate()
  f.drive.activate(false)
  f.drive.autoConnect()
  expect(f.drive.importTarget()).toBeUndefined()
  await expect(f.drive.connect()).rejects.toThrow('matrix_drive_unavailable')
  f.child.emit('close', 0, null)
  await quit
  await settle()
  // No credential cleanup was queued or run: one engine, told to stop, never to forget.
  expect(f.options.spawn).toHaveBeenCalledOnce()
  expect(drainCommands(f.child).map(command => command.kind)).toEqual(['start', 'stop'])
  expect(stored(f, 'drive-enabled:')).toBe('yes')
  expect(stored(f, 'drive-cleanup:')).toBeUndefined()
  expect(readdirSync(f.root)).toContain('notes.txt')

  const options = f.relaunch()
  const next = new MatrixDrive(options)
  next.activate(true)
  await vi.waitFor(() => expect(options.spawn).toHaveBeenCalledOnce())
  await vi.waitFor(async () =>
    expect(await next.read()).toMatchObject({
      state: 'connecting',
      canBrowseLocally: true,
      rows: [expect.objectContaining({ name: 'notes.txt' })]
    })
  )
  const child = options.spawn.mock.results[0].value as ReturnType<typeof freshChild>
  child.stdout.write(JSON.stringify(engineHello) + '\n')
  child.stdout.write(JSON.stringify({ kind: 'state', state: 'ready' }) + '\n')
  await vi.waitFor(async () => expect((await next.read()).state).toBe('ready'))
  expect(drainCommands(child).map(command => command.kind)).toEqual(['start'])
  // A sign-in that still works asks nothing of the person: no browser, no Sign in to press.
  const ready = await next.read()
  expect(ready.signInNeeded).toBeUndefined()
  expect(ready.waitingForBrowser).toBeUndefined()
  expect(f.options.openExternal).not.toHaveBeenCalled()
  expect(logged(f)).not.toContain('sign-in needed')
  // Nothing came back from a browser, so nothing is brought to the front.
  expect(f.options.returned).not.toHaveBeenCalled()
})

it('a launch reconnect whose saved sign-in can’t be reused opens no browser by itself; the person’s Sign in does', async () => {
  const f = fixture()
  writeFileSync(path.join(f.root, 'notes.txt'), 'owner text')
  await f.enrolled()
  const quit = f.drive.dispose()
  f.quit()
  f.child.emit('close', 0, null)
  await quit

  const options = f.relaunch()
  const next = new MatrixDrive(options)
  next.activate(true)
  await vi.waitFor(() => expect(options.spawn).toHaveBeenCalledOnce())
  const child = options.spawn.mock.results[0].value as ReturnType<typeof freshChild>
  const say = (message: unknown) => child.stdout.write(JSON.stringify(message) + '\n')
  // The engine's kept account is signed out (its Keychain item unreadable, or its refresh refused):
  // it asks for a fresh sign-in.
  say(engineHello)
  say({ kind: 'state', state: 'authorizing' })
  await vi.waitFor(() => expect(drainCommands(child).map(command => command.kind)).toEqual(['start']))
  await expect(next.reopenSignIn()).rejects.toThrow('matrix_drive_unavailable')
  say(signInPage)
  say({ kind: 'state', state: 'reauthenticate' })
  await vi.waitFor(async () => expect(await next.read()).toMatchObject({ state: 'reauthenticate', signInNeeded: true }))
  await settle()
  const held = await next.read()
  expect(held.waitingForBrowser).toBeUndefined()
  expect(JSON.stringify(held)).not.toContain('auth.test')
  expect(options.openExternal).not.toHaveBeenCalled()
  expect(child.kill).not.toHaveBeenCalled()
  expect(logged(f)).toContain('drive sign-in needed at launch; browser waits for the person account=kept')
  expect(logged(f)).not.toContain('authorize?')
  // There is no browser wait to cancel: Cancel never turns Drive off from here.
  expect(await next.cancelSignIn()).toMatchObject({ signInNeeded: true })
  expect(drainCommands(child)).toEqual([])

  // The person presses Sign in: the engine's page opens, and Drive waits for the browser.
  const opened = await next.reopenSignIn()
  expect(options.openExternal).toHaveBeenCalledOnce()
  expect(options.openExternal).toHaveBeenCalledWith(signInPage.url)
  expect(opened).toMatchObject({ state: 'reauthenticate', waitingForBrowser: true })
  expect(opened.signInNeeded).toBeUndefined()
  expect(logged(f)).toContain('drive sign-in opened in the browser by the person')

  // Back from the browser: Atum comes to the front and Drive syncs the same folder again.
  say({ kind: 'state', state: 'connecting' })
  await vi.waitFor(() => expect(options.returned).toHaveBeenCalledOnce())
  say({ kind: 'state', state: 'ready' })
  await vi.waitFor(async () => expect((await next.read()).rows.map(row => row.name)).toEqual(['notes.txt']))
  const ready = await next.read()
  expect(ready.signInNeeded).toBeUndefined()
  expect(ready.waitingForBrowser).toBeUndefined()
  expect(options.openExternal).toHaveBeenCalledOnce()
  expect(stored(f, 'drive-enabled:')).toBe('yes')
})

it('a held sign-in waits for the person: the automatic sign-in deadline never stops it', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })

  try {
    const f = fixture(atumDrive)
    enrollFolder(path.join(f.home, 'Atum', 'Drive'))
    f.drive.autoConnect()
    await until(() => expect(f.options.spawn).toHaveBeenCalledOnce())
    f.send(engineHello)
    f.send(signInPage)
    await until(async () => expect((await f.drive.read()).signInNeeded).toBe(true))
    await vi.advanceTimersByTimeAsync(MATRIX_DRIVE_AUTOMATIC_SIGN_IN_MS * 2)
    expect((await f.drive.read()).signInNeeded).toBe(true)
    expect(f.child.kill).not.toHaveBeenCalled()
    expect(f.options.openExternal).not.toHaveBeenCalled()
    expect(logged(f)).not.toContain('sign_in_timeout')
  } finally {
    vi.useRealTimers()
  }
})

it('a “being set up” retry that carries on a launch reconnect opens no browser by itself either', async () => {
  // A Turn on whose browser sign-in never finished: Drive reconnects at launch into a folder that
  // was never set up.
  const f = fixture(() => ({ reachable: async () => true }))
  await f.drive.connect()
  f.send(engineHello)
  f.send(signInPage)
  await vi.waitFor(() => expect(f.options.openExternal).toHaveBeenCalledOnce())
  const quit = f.drive.dispose()
  f.quit()
  f.child.emit('close', 0, null)
  await quit
  expect(stored(f, 'drive-enabled:')).toBe('yes')

  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })

  try {
    const children: ReturnType<typeof freshChild>[] = []

    const options = {
      ...f.relaunch(),
      openExternal: vi.fn(async () => {}),
      spawn: vi.fn(() => {
        const child = freshChild()
        children.push(child)

        return child as unknown as ChildProcessWithoutNullStreams
      })
    }

    const say = (child: ReturnType<typeof freshChild>, message: unknown) =>
      child.stdout.write(JSON.stringify(message) + '\n')

    const next = new MatrixDrive(options)
    next.activate(true)
    await until(() => expect(options.spawn).toHaveBeenCalledOnce())
    // Drive held the engine's first request past the classify window, then answered with an error:
    // "still being set up", so Drive tries again by itself.
    say(children[0], engineHello)
    say(children[0], { kind: 'state', state: 'authorizing' })
    await settle()
    vi.setSystemTime(Date.now() + MATRIX_DRIVE_SETUP_CLASSIFY_MS + 5_000)
    say(children[0], { kind: 'state', state: 'error' })
    await until(async () => expect(await next.read()).toMatchObject({ state: 'connecting', problem: 'setting_up' }))
    await vi.advanceTimersByTimeAsync(MATRIX_DRIVE_SETUP_RETRY_MS[0])
    await until(() => expect(options.spawn).toHaveBeenCalledTimes(2))

    // The retry's engine asks for a sign-in: it waits for the person, as the launch reconnect does.
    say(children[1], engineHello)
    say(children[1], signInPage)
    await until(async () => expect((await next.read()).signInNeeded).toBe(true))
    await vi.advanceTimersByTimeAsync(MATRIX_DRIVE_AUTOMATIC_SIGN_IN_MS * 2)
    expect((await next.read()).signInNeeded).toBe(true)
    expect(options.openExternal).not.toHaveBeenCalled()
    expect(children[1].kill).not.toHaveBeenCalled()
    expect(logged(f)).toContain('drive sign-in needed at launch; browser waits for the person account=none')

    await next.reopenSignIn()
    expect(options.openExternal).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})

it('an earlier Turn off no longer leaves Drive with no way back: the next launch sets it up again', async () => {
  const f = fixture()
  await f.enrolled()
  const quit = f.drive.dispose()
  f.quit()
  f.child.emit('close', 0, null)
  await quit

  const options = f.relaunch()
  const next = new MatrixDrive(options)
  next.activate(true)
  await vi.waitFor(() => expect(options.spawn).toHaveBeenCalledOnce())
  const child = options.spawn.mock.results[0].value as ReturnType<typeof freshChild>
  child.stdout.write(JSON.stringify(engineHello) + '\n')
  child.stdout.write(JSON.stringify(signInPage) + '\n')
  await vi.waitFor(async () => expect((await next.read()).signInNeeded).toBe(true))

  const off = next.turnOff()
  await vi.waitFor(() => expect(drainCommands(child).some(command => command.kind === 'forget')).toBe(true))
  child.stdout.write(JSON.stringify({ kind: 'state', state: 'disconnected' }) + '\n')
  child.emit('close', 0)
  const view = await off
  expect(view.state).toBe('disconnected')
  expect(view.signInNeeded).toBeUndefined()
  expect(options.openExternal).not.toHaveBeenCalled()
  expect(stored(f, 'drive-enabled:')).toBe('')
  expect(stored(f, 'drive-auto:')).toBe('off')

  // `off` is an earlier build's control; Drive is automatic now, so the next launch sets it up.
  const later = f.relaunch()
  const third = new MatrixDrive(later)
  third.activate(true)
  third.autoConnect()
  await vi.waitFor(() => expect(later.spawn).toHaveBeenCalledOnce())
})

it('the same person on a new generation of their Atum sign-in keeps Drive running; another person does not', async () => {
  const f = fixture()
  writeFileSync(path.join(f.root, 'notes.txt'), 'owner text')
  const before = await f.enrolled()
  f.newGeneration()
  // Frames that arrive before any snapshot tells Drive about the new generation still count.
  f.send({ kind: 'state', state: 'offline' })
  await vi.waitFor(() => expect(f.options.changed).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'connecting' })))
  f.send({ kind: 'state', state: 'ready' })
  await vi.waitFor(() => expect(f.options.changed).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'ready' })))
  f.drive.activate()
  expect(f.child.kill).not.toHaveBeenCalled()
  const view = await f.drive.read()
  expect(view).toMatchObject({ state: 'ready', revision: before.revision })
  expect(view.rows.map(row => row.name)).toEqual(['notes.txt'])
  expect(stored(f, 'drive-enabled:')).toBe('yes')
  expect(stored(f, 'drive-cleanup:')).toBeUndefined()
  // The engine it already had still speaks for this account.
  f.send({ kind: 'state', state: 'syncing' })
  await vi.waitFor(async () => expect((await f.drive.read()).state).toBe('syncing'))
  expect(f.options.spawn).toHaveBeenCalledOnce()

  f.changeOwner()
  f.drive.activate()
  expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
  expect(stored(f, 'drive-cleanup:')).toBe('pending')
})

it('Drive set up on this Mac before turns itself back on, even while Drive is owner-only; its sign-in waits for the person, and Atum comes back from the browser', async () => {
  const open = vi.fn(async () => false)
  const f = fixture(home => ({ ...atumDrive(home), open }))
  const folder = path.join(f.home, 'Atum', 'Drive')
  enrollFolder(folder)
  writeFileSync(path.join(folder, 'Plan.docx'), 'synced before')
  const stat = lstatSync(folder)
  // What an earlier build's quit left: the folder still saved, Drive no longer set to reconnect,
  // its engine sign-in queued for deletion, and the first run marked as tried.
  f.store.set('drive-root:' + ownerA, JSON.stringify({ root: folder, dev: stat.dev, ino: stat.ino }))
  f.store.set('drive-enabled:' + ownerA, '')
  f.store.set('drive-cleanup:' + ownerA, 'pending')
  f.store.set('drive-auto:' + ownerA, 'yes')
  const configDir = path.join(f.home, 'drive-engine', ownerA)
  mkdirSync(configDir, { recursive: true })
  writeFileSync(path.join(configDir, 'atum-drive.cfg'), 'kept account')
  const helper = freshChild()
  f.options.spawn.mockReturnValueOnce(helper as unknown as ChildProcessWithoutNullStreams)

  f.drive.autoConnect()
  // The queued deletion runs first, in its own helper.
  await vi.waitFor(() => expect(f.options.spawn).toHaveBeenCalledOnce())
  helper.stdout.write(JSON.stringify(engineHello) + '\n')
  await vi.waitFor(() => expect(drainCommands(helper).map(command => command.kind)).toEqual(['cleanup']))
  helper.stdout.write(JSON.stringify({ kind: 'state', state: 'disconnected' }) + '\n')
  helper.emit('close', 0)

  // Then Drive itself, into the same folder, with no Turn on and no question to Drive's server.
  await vi.waitFor(() => expect(f.options.spawn).toHaveBeenCalledTimes(2))
  f.send(engineHello)
  await vi.waitFor(() =>
    expect(drainCommands(f.child).find(command => command.kind === 'start')).toMatchObject({ root: folder })
  )
  expect(open).not.toHaveBeenCalled()
  expect(logged(f)).toContain('connect started automatically: set up here before')
  f.send(signInPage)
  // Its saved sign-in is gone: nothing opens by itself; Sign in opens the engine's page.
  await vi.waitFor(async () => expect((await f.drive.read()).signInNeeded).toBe(true))
  expect(f.options.openExternal).not.toHaveBeenCalled()
  expect(logged(f)).toContain('drive sign-in needed at launch; browser waits for the person account=kept')
  await f.drive.reopenSignIn()
  expect(f.options.openExternal).toHaveBeenCalledOnce()
  expect(f.options.returned).not.toHaveBeenCalled()
  // The browser comes straight back (MAS skips its Continue page for Drive): Atum to the front.
  f.send({ kind: 'state', state: 'connecting' })
  await vi.waitFor(() => expect(f.options.returned).toHaveBeenCalledOnce())
  expect(stored(f, 'drive-enabled:')).toBe('yes')
  expect(stored(f, 'drive-cleanup:')).toBe('')
  f.send({ kind: 'state', state: 'ready' })
  await vi.waitFor(async () => expect((await f.drive.read()).rows.map(row => row.name)).toEqual(['Plan.docx']))
  expect(f.options.chooseFolder).not.toHaveBeenCalled()
})

it('a stored Turn off is cleared by automatic setup; a sign-out does not stay off either', async () => {
  const f = fixture()
  await f.enrolled()
  const off = f.drive.turnOff()
  await vi.waitFor(() => expect(drainCommands(f.child).some(command => command.kind === 'forget')).toBe(true))
  f.send({ kind: 'state', state: 'disconnected' })
  f.child.emit('close', 0)
  expect((await off).state).toBe('disconnected')
  expect(stored(f, 'drive-auto:')).toBe('off')
  // Still this account's Drive folder: the next launch sets it up again by itself.
  const options = f.relaunch()
  const next = new MatrixDrive(options)
  next.activate(true)
  next.autoConnect()
  await vi.waitFor(() => expect(options.spawn).toHaveBeenCalledOnce())

  // A sign-out turns Drive off (its sign-in deleted) without that no: signing in again as the same
  // person turns it back on by itself, right after the sign-in.
  const signedOut = fixture()
  await signedOut.enrolled()
  const disconnected = signedOut.drive.disconnect()
  await vi.waitFor(() => expect(drainCommands(signedOut.child).some(command => command.kind === 'forget')).toBe(true))
  signedOut.send({ kind: 'state', state: 'disconnected' })
  signedOut.child.emit('close', 0)
  await disconnected
  signedOut.drive.activate(false)
  const again = freshChild()
  signedOut.options.spawn.mockReturnValueOnce(again as unknown as ChildProcessWithoutNullStreams)
  signedOut.drive.autoConnect()
  await vi.waitFor(() => expect(signedOut.options.spawn).toHaveBeenCalledTimes(2))
  expect(stored(signedOut, 'drive-auto:')).not.toBe('off')
  expect(logged(signedOut)).toContain('connect started automatically: set up here before')
})

it('an automatic sign-in the browser doesn’t finish stops after a while and says so; the next launch tries again, and a Turn on keeps waiting', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })

  try {
    const f = fixture(atumDrive)
    const folder = path.join(f.home, 'Atum', 'Drive')
    f.drive.autoConnect()
    await until(() => expect(f.options.spawn).toHaveBeenCalledOnce())
    f.send(engineHello)
    f.send(signInPage)
    await until(async () => expect((await f.drive.read()).waitingForBrowser).toBe(true))
    await vi.advanceTimersByTimeAsync(MATRIX_DRIVE_AUTOMATIC_SIGN_IN_MS - 1)
    expect((await f.drive.read()).waitingForBrowser).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await until(async () => expect((await f.drive.read()).state).toBe('error'))
    const view = await f.drive.read()
    expect(view).toMatchObject({ state: 'error', problem: 'sign_in' })
    expect(view.waitingForBrowser).toBeUndefined()
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(logged(f)).toContain('connect failed stage=authorize reason=sign_in_timeout problem=sign_in')
    // Never half done: the empty ~/Atum/Drive it never set up goes, and nothing waits for the browser.
    expect(existsSync(folder)).toBe(false)
    f.drive.autoConnect()
    await settle()
    expect(f.options.spawn).toHaveBeenCalledOnce()

    const options = f.relaunch()
    const next = new MatrixDrive(options)
    next.autoConnect()
    await until(() => expect(options.spawn).toHaveBeenCalledOnce())

    // The person's own Turn on: they are at the browser, so Drive keeps waiting for them.
    const manual = fixture(atumDrive)
    await manual.drive.connect()
    manual.send(engineHello)
    manual.send(signInPage)
    await until(async () => expect((await manual.drive.read()).waitingForBrowser).toBe(true))
    await vi.advanceTimersByTimeAsync(MATRIX_DRIVE_AUTOMATIC_SIGN_IN_MS * 2)
    expect((await manual.drive.read()).waitingForBrowser).toBe(true)
    expect(manual.child.kill).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('while Drive is owner-only the first run does nothing: no consent, no folder, the first run kept for later (B2)', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })

  try {
    let open = false
    const asked = vi.fn(async () => open)
    const f = fixture(home => ({ ...atumDrive(home), open: asked }))
    f.drive.autoConnect()
    await vi.waitFor(() => expect(logged(f)).toContain("first connect waits: Drive's server has not answered yet"))
    // Snapshots keep coming: asked once, not on each.
    f.drive.autoConnect()
    f.drive.autoConnect()
    await new Promise(resolve => setImmediate(resolve))
    expect(asked).toHaveBeenCalledOnce()
    expect(f.options.spawn).not.toHaveBeenCalled()
    expect(f.options.openExternal).not.toHaveBeenCalled()
    expect(readdirSync(f.home)).not.toContain('Atum')

    // Drive opens for everyone (P6). An hour later in this launch, or at the next launch, the
    // first run happens.
    open = true
    vi.setSystemTime(Date.now() + MATRIX_DRIVE_OPEN_RECHECK_MS + 1)
    f.drive.autoConnect()
    await vi.waitFor(() => expect(f.options.spawn).toHaveBeenCalledOnce())
    expect(asked).toHaveBeenCalledTimes(2)

    const relaunch = fixture(home => ({ ...atumDrive(home), open: async () => true }))
    relaunch.drive.autoConnect()
    await vi.waitFor(() => expect(relaunch.options.spawn).toHaveBeenCalledOnce())
  } finally {
    vi.useRealTimers()
  }
})

it('asks Drive anonymously whether it is open to every account: /atum/open, no credential, only an explicit true', async () => {
  const calls: [URL, RequestInit][] = []

  const answer = (status: number, body: string) =>
    vi.fn(async (url: URL, init: RequestInit) => {
      calls.push([url, init])

      return new Response(body, { status, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

  expect(await matrixDriveOpen('https://drive.test', answer(200, '{"open":true}'))).toBe(true)
  expect(await matrixDriveOpen('https://drive.test', answer(200, '{"open":false}'))).toBe(false)
  expect(await matrixDriveOpen('https://drive.test', answer(200, '{"open":"yes"}'))).toBe(false)
  expect(await matrixDriveOpen('https://drive.test', answer(200, 'not json'))).toBe(false)
  // An older server without the route: 401 missing_token.
  expect(await matrixDriveOpen('https://drive.test', answer(401, ''))).toBe(false)
  expect(
    await matrixDriveOpen(
      'https://drive.test',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch
    )
  ).toBe(false)
  expect(String(calls[0][0])).toBe('https://drive.test/atum/open')
  expect(calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' })
  expect(new Headers(calls[0][1].headers).has('authorization')).toBe(false)
})

it('an engine that is turned away and just exits (code 0) after sign-in is checked like one that reports an error', async () => {
  const reachable = vi.fn(async () => true)
  const f = fixture(home => ({ ...atumDrive(home), reachable }))
  await f.drive.connect()
  f.send(engineHello)
  f.send(signInPage)
  await vi.waitFor(() => expect(f.options.openExternal).toHaveBeenCalledOnce())
  f.child.emit('close', 0, null)
  await vi.waitFor(async () => expect(await f.drive.read()).toMatchObject({ state: 'error', problem: 'not_allowed' }))
  expect(reachable).toHaveBeenCalledOnce()
  expect(logged(f)).toMatch(/connect failed stage=authorize reason=exit code=0 problem=checking/)
})

// ── 0.18.3: no picker on Turn on, waiting for the browser, "Up to date · 14:32" ───────────────

function ownerKey(f: { options: { owner(): { issuer: string; subject: string } } }): string {
  const owner = f.options.owner()

  return createHash('sha256')
    .update(JSON.stringify([owner.issuer, owner.subject]))
    .digest('hex')
}

it('stops launch retries when a person-chosen path has a new inode, then rebinds only after an explicit choice', async () => {
  const f = fixture(home => ({ defaultFolder: path.join(home, 'Atum', 'Drive') }))
  const key = ownerKey(f)
  f.bind()
  writeFileSync(path.join(f.root, 'original.txt'), 'original files stay put')
  const original = lstatSync(f.root)
  f.store.set('drive-root:' + key, JSON.stringify({ root: f.root, dev: original.dev, ino: original.ino }))
  f.store.set('drive-enabled:' + key, 'yes')

  const oldRoot = f.root + '-old'
  renameSync(f.root, oldRoot)
  mkdirSync(f.root)
  f.bind() // A copied, otherwise valid owner marker must not make the replacement trusted.
  writeFileSync(path.join(f.root, 'replacement.txt'), 'replacement files stay put')
  const replacement = lstatSync(f.root)

  const options = f.relaunch()
  const next = new MatrixDrive(options)
  next.activate(true)
  await settle()

  expect(await next.read()).toMatchObject({
    state: 'disconnected',
    problem: 'folder_changed',
    rootLabel: 'Files',
    canBrowseLocally: false,
    rows: []
  })
  expect(options.spawn).not.toHaveBeenCalled()
  next.autoConnect()
  next.autoConnect()
  await settle()
  expect(options.spawn).not.toHaveBeenCalled()
  expect(await next.connect()).toMatchObject({ state: 'disconnected', problem: 'folder_changed' })
  expect(options.spawn).not.toHaveBeenCalled()

  const laterOptions = f.relaunch()
  const later = new MatrixDrive(laterOptions)
  later.activate(true)
  await settle()
  expect(await later.read()).toMatchObject({ state: 'disconnected', problem: 'folder_changed' })
  expect(laterOptions.spawn).not.toHaveBeenCalled()

  expect(await next.chooseFolder()).toMatchObject({ state: 'connecting', rootLabel: 'Files' })
  expect(options.chooseFolder).toHaveBeenCalledOnce()
  expect(options.spawn).toHaveBeenCalledOnce()
  expect(JSON.parse(f.store.get('drive-root:' + key)!)).toEqual({
    root: f.root,
    dev: replacement.dev,
    ino: replacement.ino
  })
  expect(replacement.ino).not.toBe(original.ino)
  expect(readdirSync(oldRoot)).toContain('original.txt')
  expect(readdirSync(f.root)).toContain('replacement.txt')

  const child = options.spawn.mock.results[0].value as ReturnType<typeof freshChild>
  child.stdout.write(JSON.stringify(engineHello) + '\n')
  await vi.waitFor(() =>
    expect(drainCommands(child).find(command => command.kind === 'start')).toMatchObject({ root: f.root })
  )
  expect(logged(f)).toContain('drive saved folder changed source=launch; waiting for the person')
  expect(logged(f)).toContain('drive changed saved folder explicitly rebound by the person')
  expect(logged(f)).not.toContain('matrix_drive_root_changed')
})

it('forgets a changed saved binding only when the person turns it off, without changing either folder', async () => {
  const f = fixture(home => ({ defaultFolder: path.join(home, 'Atum', 'Drive') }))
  const key = ownerKey(f)
  f.bind()
  writeFileSync(path.join(f.root, 'original.txt'), 'original files stay put')
  const original = lstatSync(f.root)
  f.store.set('drive-root:' + key, JSON.stringify({ root: f.root, dev: original.dev, ino: original.ino }))
  f.store.set('drive-enabled:' + key, 'yes')

  const oldRoot = f.root + '-old'
  renameSync(f.root, oldRoot)
  mkdirSync(f.root)
  f.bind()
  writeFileSync(path.join(f.root, 'replacement.txt'), 'replacement files stay put')

  f.drive.activate(true)
  expect(await f.drive.read()).toMatchObject({ state: 'disconnected', problem: 'folder_changed' })
  const view = await f.drive.turnOff()

  expect(view).toMatchObject({ state: 'disconnected', canBrowseLocally: false, rows: [] })
  expect(view.problem).toBeUndefined()
  expect(view.rootLabel).toBeUndefined()
  expect(f.store.get('drive-root:' + key)).toBe('')
  expect(f.store.get('drive-enabled:' + key)).toBe('')
  expect(stored(f, 'drive-auto:')).toBe('off')
  expect(f.options.spawn).not.toHaveBeenCalled()
  expect(readdirSync(oldRoot)).toContain('original.txt')
  expect(readdirSync(f.root)).toContain('replacement.txt')
  expect(logged(f)).toContain('drive changed saved folder forgotten by the person')
})

it('a sign-out disconnect keeps a changed saved binding so the next sign-in asks about it again', async () => {
  const f = fixture(home => ({ defaultFolder: path.join(home, 'Atum', 'Drive') }))
  const key = ownerKey(f)
  f.bind()
  writeFileSync(path.join(f.root, 'original.txt'), 'original files stay put')
  const original = lstatSync(f.root)
  const binding = JSON.stringify({ root: f.root, dev: original.dev, ino: original.ino })
  f.store.set('drive-root:' + key, binding)
  f.store.set('drive-enabled:' + key, 'yes')
  renameSync(f.root, f.root + '-old')
  mkdirSync(f.root)
  f.bind()

  f.drive.activate(true)
  expect(await f.drive.read()).toMatchObject({ state: 'disconnected', problem: 'folder_changed' })
  // Sign-out, cancel sign-in and cancel chained authorization all call disconnect() with no flag.
  await f.drive.disconnect()

  expect(f.store.get('drive-root:' + key)).toBe(binding)
  expect(f.store.get('drive-enabled:' + key)).toBe('')
  expect(logged(f)).not.toContain('changed saved folder forgotten by the person')
  expect(readdirSync(f.root + '-old')).toContain('original.txt')

  const options = f.relaunch()
  const next = new MatrixDrive(options)
  next.activate(true)
  await settle()
  expect(await next.read()).toMatchObject({ state: 'disconnected', problem: 'folder_changed' })
  expect(options.spawn).not.toHaveBeenCalled()
})

it('a Turn off that arrives while a sign-out disconnect is running still releases the changed folder', async () => {
  const f = fixture(home => ({ defaultFolder: path.join(home, 'Atum', 'Drive') }))
  const key = ownerKey(f)
  f.bind()
  const original = lstatSync(f.root)
  f.store.set('drive-root:' + key, JSON.stringify({ root: f.root, dev: original.dev, ino: original.ino }))
  f.store.set('drive-enabled:' + key, 'yes')
  renameSync(f.root, f.root + '-old')
  mkdirSync(f.root)
  f.bind()

  f.drive.activate(true)
  expect(await f.drive.read()).toMatchObject({ state: 'disconnected', problem: 'folder_changed' })
  const signOut = f.drive.disconnect()
  const off = f.drive.turnOff()
  await Promise.all([signOut, off])

  expect(f.store.get('drive-root:' + key)).toBe('')
  expect(stored(f, 'drive-auto:')).toBe('off')
})

it('a removed owner marker is a plain error, not a moved folder, and re-choosing it never nests', async () => {
  const f = fixture()
  const key = ownerKey(f)
  writeFileSync(path.join(f.root, 'notes.txt'), 'owner text')
  await f.enrolled(true)
  const saved = f.store.get('drive-root:' + key)
  rmSync(path.join(f.root, '.atum-drive-binding.json'))

  const view = await f.drive.read()
  expect(view.problem).toBeUndefined()
  expect(view).toMatchObject({ state: 'error', canBrowseLocally: false, rows: [] })
  expect(f.child.kill).toHaveBeenCalled()
  expect(f.store.get('drive-root:' + key)).toBe(saved)

  // Choosing the same folder again is refused, never nested into a new empty "Atum Drive" folder,
  // and the saved folder stays as it was.
  const chosen = await f.drive.chooseFolder()
  expect(chosen).toMatchObject({ state: 'disconnected', problem: 'folder_not_empty' })
  expect(f.store.get('drive-root:' + key)).toBe(saved)
  expect(readdirSync(f.root)).not.toContain('Atum Drive')
  expect(readdirSync(f.root)).toContain('notes.txt')
})

it('after a removed owner marker the next connect is refused as not empty; the same folder is never re-enrolled', async () => {
  const f = fixture()
  const key = ownerKey(f)
  writeFileSync(path.join(f.root, 'notes.txt'), 'owner text')
  await f.enrolled(true)
  rmSync(path.join(f.root, '.atum-drive-binding.json'))
  expect(await f.drive.read()).toMatchObject({ state: 'error' })
  f.options.spawn.mockClear()

  // Retry cannot adopt the folder: the engine takes only an empty one. It says so, starts nothing,
  // and releases the saved folder so nothing keeps retrying it. The files stay where they are.
  const view = await f.drive.connect()
  expect(view).toMatchObject({ state: 'disconnected', problem: 'folder_not_empty' })
  expect(f.options.spawn).not.toHaveBeenCalled()
  expect(f.store.get('drive-root:' + key)).toBe('')
  expect(readdirSync(f.root)).toContain('notes.txt')
  expect(readdirSync(f.root)).not.toContain('.atum-drive-binding.json')
})

// ── R9 review: root changes during sync, FIFO markers, folders swapped while checked ──────────

/** A FIFO at `file`; false where `mkfifo` does not exist, and the caller skips with that reason. */
function makeFifo(file: string): boolean {
  try {
    execFileSync('mkfifo', [file])

    return true
  } catch {
    return false
  }
}

/**
 * If the code under test blocks opening a FIFO for reading (the bug), this opens its other end
 * after `seconds`, so a regression is a failed assertion on the time taken instead of a hung run.
 * The returned function stops the helper.
 */
function releaseFifoAfter(file: string, seconds: number): () => void {
  const helper = spawn('sh', ['-c', 'sleep "$1"; exec 3>"$2"; sleep 30', 'sh', String(seconds), file], {
    stdio: 'ignore'
  })

  return () => void helper.kill('SIGKILL')
}

it('a root replaced while the engine syncs, before any listing, waits for the person instead of stopping', async () => {
  const f = fixture(home => ({ defaultFolder: path.join(home, 'Atum', 'Drive') }))
  const key = ownerKey(f)
  // A person's chosen root (not the app's default): its replacement is never adopted silently.
  f.bindSaved()
  await f.drive.connect()
  f.send(engineHello)
  writeFileSync(path.join(f.root, 'original.txt'), 'original files stay put')
  const saved = f.store.get('drive-root:' + key)
  expect(f.drive.importTarget()).toBeUndefined()

  // The whole folder is replaced by a new, empty one before the engine's first state frame lands.
  renameSync(f.root, f.root + '-old')
  mkdirSync(f.root)
  f.send({ kind: 'state', state: 'syncing' })

  const view = await f.drive.read()
  expect(view).toMatchObject({ state: 'disconnected', problem: 'folder_changed', canBrowseLocally: false, rows: [] })
  expect(view.folderLabel).toBeUndefined()
  expect(view.canGoBack).toBe(false)
  expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
  // Nothing was released or reset: the person decides, and no file moved.
  expect(f.store.get('drive-root:' + key)).toBe(saved)
  expect(readdirSync(f.root + '-old')).toContain('original.txt')
  expect(readdirSync(f.root)).toEqual([])
  expect(logged(f)).toContain('drive connect failed stage=connected reason=root_changed problem=folder_changed')
  expect(logged(f)).toContain('drive saved folder changed source=runtime; waiting for the person')
  expect(logged(f)).not.toContain('matrix_drive_root_changed')

  // A plain retry never adopts the new folder; only an explicit choice does.
  f.options.spawn.mockClear()
  expect(await f.drive.connect()).toMatchObject({ state: 'disconnected', problem: 'folder_changed' })
  expect(f.options.spawn).not.toHaveBeenCalled()
})

it('rebinds the app’s own default folder by itself when an update replaces its directory', async () => {
  const f = fixture()
  const key = ownerKey(f)
  await f.drive.connect()
  f.send(engineHello)
  f.bind()
  f.send({ kind: 'state', state: 'ready' })
  await until(async () => expect((await f.drive.read()).state).toBe('ready'))

  const second = freshChild()
  f.options.spawn.mockReturnValueOnce(second as unknown as ChildProcessWithoutNullStreams)

  // The update replaces the app's own `~/Atum/Drive` with an otherwise identical directory. No
  // person ever chose this path, so its new identity is adopted without asking.
  renameSync(f.root, f.root + '-old')
  mkdirSync(f.root)
  f.bind()
  const replacement = lstatSync(f.root)

  f.send({ kind: 'state', state: 'syncing' })

  await until(() => expect(f.options.spawn).toHaveBeenCalledTimes(2))
  expect(logged(f)).toContain('drive saved default folder rebound automatically source=runtime reason=identity')
  expect(logged(f)).not.toContain('waiting for the person')
  expect((await f.drive.read()).problem).toBeUndefined()
  expect(JSON.parse(f.store.get('drive-root:' + key)!)).toEqual({
    root: f.root,
    dev: replacement.dev,
    ino: replacement.ino
  })
  expect(readdirSync(f.root + '-old')).toContain('.atum-drive-binding.json')
  expect(f.store.get('drive-enabled:' + key)).toBe('yes')

  second.stdout.write(JSON.stringify(engineHello) + '\n')
  await until(() =>
    expect(drainCommands(second).find(command => command.kind === 'start')).toMatchObject({ root: f.root })
  )
  expect(f.options.openExternal).not.toHaveBeenCalled()
})

it('a root replaced while the engine starts, carrying a copied owner marker, also waits for the person', async () => {
  const f = fixture(home => ({ defaultFolder: path.join(home, 'Atum', 'Drive') }))
  const key = ownerKey(f)
  f.bindSaved()
  writeFileSync(path.join(f.root, 'original.txt'), 'original files stay put')

  f.options.spawn.mockImplementationOnce(() => {
    // Between the checks before the spawn and the engine's hello, the folder is swapped for one
    // that carries a copy of the marker.
    renameSync(f.root, f.root + '-old')
    mkdirSync(f.root)
    f.bind()

    return f.child as unknown as ChildProcessWithoutNullStreams
  })
  await f.drive.connect()
  const saved = f.store.get('drive-root:' + key)
  f.send(engineHello)

  const view = await f.drive.read()
  expect(view).toMatchObject({ state: 'disconnected', problem: 'folder_changed', canBrowseLocally: false })
  expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
  expect(f.store.get('drive-root:' + key)).toBe(saved)
  expect(readdirSync(f.root + '-old')).toContain('original.txt')
  expect(logged(f)).not.toContain('problem=engine')
})

it('a root replaced between two progress updates waits for the person, whether or not it was ever listed', async () => {
  const f = fixture(home => ({ defaultFolder: path.join(home, 'Atum', 'Drive') }))
  f.bindSaved()
  await f.drive.connect()
  f.send({ ...engineHello, features: factFeatures })
  vi.useFakeTimers()

  try {
    // The first update is shown at once; the second is held back by the 500 ms coalescing timer.
    f.send(progressFrame(1))
    f.send(progressFrame(2))
    renameSync(f.root, f.root + '-old')
    mkdirSync(f.root)
    await vi.advanceTimersByTimeAsync(500)
  } finally {
    vi.useRealTimers()
  }

  expect(await f.drive.read()).toMatchObject({
    state: 'disconnected',
    problem: 'folder_changed',
    canBrowseLocally: false
  })
  expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
  expect(logged(f)).toContain('drive saved folder changed source=runtime; waiting for the person')
})

it('a marker that went missing during sync stays the plain error even when nothing was listed', async () => {
  const f = fixture()
  const key = ownerKey(f)
  await f.drive.connect()
  f.send(engineHello)
  f.bind()
  const saved = f.store.get('drive-root:' + key)
  f.send({ kind: 'state', state: 'syncing' })
  expect(await f.drive.read()).toMatchObject({ state: 'syncing' })
  rmSync(path.join(f.root, '.atum-drive-binding.json'))
  f.send({ kind: 'state', state: 'ready' })

  const view = await f.drive.read()
  expect(view.problem).toBeUndefined()
  expect(view).toMatchObject({ state: 'error' })
  expect(f.store.get('drive-root:' + key)).toBe(saved)
  // A marker that simply vanished is a closed root condition, never a protocol slip.
  expect(logged(f)).toContain('reason=root_changed')
  expect(logged(f)).not.toContain('reason=protocol')
})

it('a folder Atum stepped into does not outlive a root that stopped validating before it was listed', async () => {
  const f = fixture()
  await f.drive.connect()
  f.send(engineHello)
  // A leftover step into a sub-folder, from before the root stopped validating.
  ;(f.drive as unknown as { folder: string }).folder = 'Projects'
  f.send({ kind: 'state', state: 'authorizing' })

  const view = await f.drive.read()
  expect(view.folderLabel).toBeUndefined()
  expect(view.canGoBack).toBe(false)
})

it('a FIFO in place of the owner marker is a changed folder at once: nothing blocks, nothing is opened', async ctx => {
  const f = fixture()
  const key = ownerKey(f)
  writeFileSync(path.join(f.root, 'notes.txt'), 'owner text')
  await f.enrolled(true)
  const saved = f.store.get('drive-root:' + key)
  const marker = path.join(f.root, '.atum-drive-binding.json')
  rmSync(marker)

  if (!makeFifo(marker)) {
    ctx.skip('mkfifo is not available on this platform')
  }

  const stop = releaseFifoAfter(marker, 2)

  try {
    const started = Date.now()
    const view = await f.drive.read()
    // A reader that blocked on the FIFO would only return after 2 s.
    expect(Date.now() - started).toBeLessThan(1500)
    expect(view).toMatchObject({ state: 'disconnected', problem: 'folder_changed', canBrowseLocally: false, rows: [] })
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(f.drive.importTarget()).toBeUndefined()
    await expect(f.drive.manifestFor(['notes.txt'])).resolves.toBeNull()
  } finally {
    stop()
  }

  expect(f.store.get('drive-root:' + key)).toBe(saved)
  expect(lstatSync(marker).isFIFO()).toBe(true)
  expect(readdirSync(f.root)).toContain('notes.txt')
})

it('a folder swapped for another while it is checked is refused at Turn on: nothing bound, nothing started', async () => {
  const f = fixture()
  const key = ownerKey(f)
  let swaps = 0

  fsHooks.beforeRealpath = target => {
    if (target === f.root) {
      // Every look at the folder finds it replaced by a new one, the old one kept beside it.
      renameSync(f.root, `${f.root}-moved-${swaps++}`)
      mkdirSync(f.root)
    }
  }

  const view = await f.drive.connect()
  fsHooks.beforeRealpath = undefined
  expect(swaps).toBeGreaterThan(0)
  expect(view).toMatchObject({ state: 'disconnected', problem: 'folder_unavailable' })
  expect(f.options.spawn).not.toHaveBeenCalled()
  expect(f.store.get('drive-root:' + key) ?? '').toBe('')
})

it('a saved folder that is gone: the launch reconnect makes ~/Atum/Drive and connects there, with no picker', async () => {
  const f = fixture(atumDrive)
  // The Mac mini's case: a folder saved earlier that no longer exists, set to reconnect.
  const gone = path.join(f.home, 'Old Drive')
  mkdirSync(gone)
  const { dev, ino } = lstatSync(gone)
  rmSync(gone, { recursive: true })
  const key = ownerKey(f)
  f.store.set('drive-root:' + key, JSON.stringify({ root: gone, dev, ino }))
  f.store.set('drive-enabled:' + key, 'yes')
  f.drive.activate()
  await vi.waitFor(() => expect(f.options.spawn).toHaveBeenCalledOnce())
  const folder = path.join(f.home, 'Atum', 'Drive')
  expect(f.options.chooseFolder).not.toHaveBeenCalled()
  expect(lstatSync(folder).mode & 0o777).toBe(0o700)
  expect(await f.drive.read()).toMatchObject({ state: 'connecting', rootLabel: 'Drive' })
  expect(JSON.parse(f.store.get('drive-root:' + key)!)).toMatchObject({ root: folder })
  f.send(engineHello)
  await vi.waitFor(() =>
    expect(drainCommands(f.child).find(command => command.kind === 'start')).toMatchObject({ root: folder })
  )
  expect(logged(f)).toContain('drive saved folder unavailable; using the default folder')
  expect(logged(f)).toContain('drive default folder made')
  expect(logged(f)).not.toContain('folder refused')
})

it('Turn on with ~/Atum/Drive missing (Atum’s folder too) makes both, private, and never asks for a folder', async () => {
  const f = fixture(atumDrive)
  expect(readdirSync(f.home)).not.toContain('Atum')
  expect(await f.drive.connect()).toMatchObject({ state: 'connecting', rootLabel: 'Drive' })
  expect(lstatSync(path.join(f.home, 'Atum')).mode & 0o777).toBe(0o700)
  expect(lstatSync(path.join(f.home, 'Atum', 'Drive')).mode & 0o777).toBe(0o700)
  expect(f.options.chooseFolder).not.toHaveBeenCalled()
  expect(f.options.spawn).toHaveBeenCalledOnce()
})

it('never follows a ~/Atum/Drive that is a link: Turn on says why and starts nothing', async () => {
  const f = fixture(atumDrive)
  mkdirSync(path.join(f.home, 'Atum'))
  symlinkSync(f.root, path.join(f.home, 'Atum', 'Drive'))
  expect(await f.drive.connect()).toMatchObject({ state: 'disconnected', problem: 'folder_unavailable' })
  expect(f.options.chooseFolder).not.toHaveBeenCalled()
  expect(f.options.spawn).not.toHaveBeenCalled()
})

it('choosing ~/Atum in the picker means ~/Atum/Drive', async () => {
  const f = fixture(atumDrive)
  const atum = path.join(f.home, 'Atum')
  mkdirSync(atum)
  writeFileSync(path.join(atum, 'notes from the assistant.md'), 'assistant work')
  f.options.chooseFolder.mockResolvedValue(atum)
  expect(await f.drive.chooseFolder()).toMatchObject({ state: 'connecting', rootLabel: 'Drive' })
  f.send(engineHello)
  await vi.waitFor(() =>
    expect(drainCommands(f.child).find(command => command.kind === 'start')).toMatchObject({
      root: path.join(atum, 'Drive')
    })
  )
})

it('says where Drive lives without a user name or an absolute path', async () => {
  const { matrixDriveFolderLocation } = await import('./drive')
  expect(matrixDriveFolderLocation('/home/example/Atum/Drive', '/home/example')).toBe('~/Atum/Drive')
  expect(matrixDriveFolderLocation('/home/example/Documents/Atum Drive', '/home/example')).toBe('~/Documents/Atum Drive')
  expect(matrixDriveFolderLocation('/Volumes/Backup/Atum Drive', '/home/example')).toBe('Atum Drive')
  expect(matrixDriveFolderLocation('/home/another/Atum Drive', '/home/example')).toBe('Atum Drive')
})

it('waits for the browser: says so, reopens the same sign-in page on Open again, and keeps the page in main', async () => {
  const f = fixture(atumDrive)
  await f.drive.connect()
  f.send(engineHello)
  f.send({ kind: 'state', state: 'authorizing' })
  await expect(f.drive.reopenSignIn()).rejects.toThrow('matrix_drive_unavailable')
  f.send(signInPage)
  await vi.waitFor(async () => expect((await f.drive.read()).waitingForBrowser).toBe(true))
  const view = await f.drive.read()
  expect(JSON.stringify(view)).not.toContain('auth.test')
  await f.drive.reopenSignIn()
  expect(f.options.openExternal).toHaveBeenCalledTimes(2)
  expect(f.options.openExternal).toHaveBeenLastCalledWith(signInPage.url)
  // Signed in: the wait is over, and Open again has nothing to open.
  f.send({ kind: 'state', state: 'connecting' })
  await vi.waitFor(async () => expect((await f.drive.read()).waitingForBrowser).toBeUndefined())
  await expect(f.drive.reopenSignIn()).rejects.toThrow('matrix_drive_unavailable')
  expect(f.options.openExternal).toHaveBeenCalledTimes(2)
})

it('a helper that stops while waiting for the browser ends the wait', async () => {
  const f = fixture(atumDrive)
  f.child.kill.mockImplementation(() => true)
  await f.drive.connect()
  f.send(engineHello)
  f.send(signInPage)
  await vi.waitFor(async () => expect((await f.drive.read()).waitingForBrowser).toBe(true))
  f.child.emit('close', 1, null)
  await vi.waitFor(async () => expect((await f.drive.read()).state).toBe('error'))
  expect((await f.drive.read()).waitingForBrowser).toBeUndefined()
})

it('Cancel while waiting for the browser turns Drive off like Disconnect and removes the ~/Atum/Drive it never used', async () => {
  const f = fixture(atumDrive)
  const folder = path.join(f.home, 'Atum', 'Drive')
  await f.drive.connect()
  f.send(engineHello)
  f.send(signInPage)
  await vi.waitFor(async () => expect((await f.drive.read()).waitingForBrowser).toBe(true))
  const cancelled = f.drive.cancelSignIn()
  await vi.waitFor(() => expect(f.child.stdin.readableLength).toBeGreaterThan(0))
  expect(drainCommands(f.child).at(-1)).toEqual({ kind: 'forget' })
  f.send({ kind: 'state', state: 'disconnected' })
  f.child.emit('close', 0)
  const view = await cancelled
  expect(view).toMatchObject({ state: 'disconnected' })
  expect(view.waitingForBrowser).toBeUndefined()
  expect(view.rootLabel).toBeUndefined()
  expect(existsSync(folder)).toBe(false)
  expect(stored(f, 'drive-enabled:')).toBe('')
  expect(logged(f)).toContain('drive sign-in cancelled')
  // Nothing to cancel any more: a second Cancel changes nothing.
  expect(await f.drive.cancelSignIn()).toMatchObject({ state: 'disconnected' })
  expect(f.options.spawn).toHaveBeenCalledOnce()
})

it('Cancel does nothing unless Drive is waiting for the browser', async () => {
  const f = fixture()
  await f.enrolled()
  drainCommands(f.child)
  expect(await f.drive.cancelSignIn()).toMatchObject({ state: 'ready' })
  expect(f.child.stdin.readableLength).toBe(0)
  expect(stored(f, 'drive-enabled:')).toBe('yes')
})

it('remembers when a sync finished (syncing → ready) for this account only', async () => {
  const f = fixture()
  await f.enrolled()
  expect((await f.drive.read()).lastSyncAt).toBeUndefined()
  const before = Date.now()
  f.send({ kind: 'state', state: 'syncing' })
  f.send({ kind: 'state', state: 'ready' })
  await vi.waitFor(async () => expect((await f.drive.read()).lastSyncAt).toBeGreaterThanOrEqual(before))
  const finished = (await f.drive.read()).lastSyncAt
  // Going offline and back keeps the last finished sync; only a finished sync moves it.
  f.send({ kind: 'state', state: 'offline' })
  expect((await f.drive.read()).state).toBe('connecting')
  expect((await f.drive.read()).lastSyncAt).toBe(finished)
  f.changeOwner()
  f.drive.activate()
  expect((await f.drive.read()).lastSyncAt).toBeUndefined()
})

const factFeatures = ['progress', 'sync', 'quota', 'exclusions']

const progressFrame = (done: number, active = true) => ({
  kind: 'progress',
  active,
  files: { done, total: 40 },
  bytes: { done, total: 400 },
  etaSeconds: null,
  direction: 'mixed'
})

const quotaFrame = { kind: 'quota', total: 100, used: 30, remaining: 70, state: 'normal' }
const syncFrame = { kind: 'sync', lastSyncAt: 1791281400000, conflicts: 1, errors: 2, excluded: 3 }

async function factsFixture(features = factFeatures) {
  const f = fixture()
  f.bind()
  await f.drive.connect()
  f.send({ ...engineHello, features })
  f.send({ kind: 'state', state: 'ready' })
  await f.drive.read()

  return f
}

it('accepts only implemented offered facts; omits start.features for legacy engines', async () => {
  const legacy = fixture()
  await legacy.enrolled()
  expect(drainCommands(legacy.child)).toEqual([
    {
      kind: 'start',
      issuer: 'https://auth.test/',
      subject: 'owner-a',
      root: legacy.root,
      configDir: path.join(
        legacy.home,
        'drive-engine',
        createHash('sha256')
          .update(JSON.stringify(['https://auth.test/', 'owner-a']))
          .digest('hex')
      )
    }
  ])
  expect((await legacy.drive.read()).issues).toBeUndefined()
  const partial = await factsFixture(['quota', 'trash'])
  expect(drainCommands(partial.child)[0].features).toEqual(['quota'])
  expect(partial.drive.importQuota()).toBeUndefined()
  partial.send(quotaFrame)
  expect(partial.drive.importQuota()).toEqual({ total: 100, used: 30, remaining: 70, state: 'normal' })
  partial.send({ kind: 'trash', requestId: 'unaccepted', items: [] })
  expect(partial.child.kill).toHaveBeenCalledWith('SIGTERM')
  expect(partial.options.log).toHaveBeenCalledWith(expect.stringContaining('reason=protocol'))
})

it('uses engine sync time and closed issues, without treating generic errors as quota failure', async () => {
  const f = await factsFixture()
  f.send(syncFrame)
  f.send(quotaFrame)
  f.send({ kind: 'exclusions', patterns: ['token', '.env', '.git', 'node_modules', 'custom/*'] })
  const view = await f.drive.read()
  expect(view.lastSyncAt).toBe(syncFrame.lastSyncAt)
  expect(view.quota).toEqual({ total: 100, used: 30, remaining: 70, state: 'normal' })
  expect(view.issues?.map(issue => issue.code)).toEqual(['conflicts', 'errors', 'excluded'])
  expect(view.issues?.find(issue => issue.code === 'excluded')?.count).toBe(3)
  expect(view.issues?.every(issue => /^[0-9a-f-]{36}$/.test(issue.id))).toBe(true)
  const issueIds = view.issues?.map(issue => issue.id)
  f.send(syncFrame)
  expect((await f.drive.read()).issues?.map(issue => issue.id)).toEqual(issueIds)
  expect(f.drive.importExclusions()).toContain('custom/*')
  expect(JSON.stringify(view)).not.toContain('custom/*')
  f.send({ ...quotaFrame, used: 100, remaining: 0, state: 'exceeded' })
  expect((await f.drive.read()).issues?.map(issue => issue.code)).toContain('drive_full')
  f.send({ ...syncFrame, lastSyncAt: syncFrame.lastSyncAt, conflicts: 0, errors: 0, excluded: 0 })
  expect((await f.drive.read()).issues?.map(issue => issue.code)).toEqual(['drive_full'])
  f.send({ kind: 'state', state: 'syncing' })
  f.send({ kind: 'state', state: 'ready' })
  expect((await f.drive.read()).lastSyncAt).toBe(syncFrame.lastSyncAt)
})

it('omits never-synced dates and suppresses the interim clock as soon as sync is negotiated', async () => {
  const f = await factsFixture()
  f.send({ ...syncFrame, lastSyncAt: 0, conflicts: 0, errors: 0, excluded: 0 })
  f.send({ kind: 'state', state: 'syncing' })
  f.send({ kind: 'state', state: 'ready' })
  expect((await f.drive.read()).lastSyncAt).toBeUndefined()
})

it('coalesces progress bursts at 500 ms while retaining directory capability handles', async () => {
  const f = await factsFixture()
  writeFileSync(path.join(f.root, 'report.txt'), 'hello')
  const initial = await f.drive.read()
  const id = initial.rows[0].id
  vi.useFakeTimers()

  try {
    f.options.changed.mockClear()
    f.send(progressFrame(1))
    f.send(progressFrame(2))
    f.send(progressFrame(3, false))
    expect(f.options.changed).toHaveBeenCalledTimes(1)
    expect(f.options.changed.mock.calls[0][0].rows[0].id).toBe(id)
    expect(f.options.changed.mock.calls[0][0].progress.files.done).toBe(1)
    await vi.advanceTimersByTimeAsync(499)
    expect(f.options.changed).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.options.changed).toHaveBeenCalledTimes(2)
    expect(f.options.changed.mock.calls[1][0].progress).toMatchObject({ active: false, files: { done: 3 } })
    f.send(progressFrame(0)) // new active run may reset
    await vi.advanceTimersByTimeAsync(500)
    expect(f.options.changed.mock.calls[2][0].progress.files.done).toBe(0)
  } finally {
    vi.useRealTimers()
  }

  await f.drive.open(id)
  expect(f.options.openPath).toHaveBeenCalledWith(path.join(f.root, 'report.txt'))
})

it.each([
  {
    kind: 'progress',
    active: true,
    files: { done: -1, total: 2 },
    bytes: { done: 0, total: 1 },
    etaSeconds: null,
    direction: 'up'
  },
  { ...quotaFrame, path: '/synthetic/private' },
  { ...syncFrame, errors: true },
  { kind: 'issues', errors: 1 },
  { ...engineHello, features: ['quota'] }
])('fails closed without payload diagnostics: $kind', async message => {
  const f = await factsFixture()
  f.send(message)
  expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
  expect(f.options.log).toHaveBeenCalledWith(expect.stringContaining('reason=protocol'))
  expect(JSON.stringify(f.options.log.mock.calls)).not.toContain('/synthetic/private')
})

it('rejects unaccepted facts, decreasing run counters and sync timestamp regression', async () => {
  const unaccepted = await factsFixture(['quota'])
  unaccepted.send(syncFrame)
  expect(unaccepted.child.kill).toHaveBeenCalledWith('SIGTERM')
  const progress = await factsFixture()
  progress.send(progressFrame(12))
  progress.send(progressFrame(11))
  expect(progress.child.kill).toHaveBeenCalledWith('SIGTERM')
  const sync = await factsFixture()
  sync.send(syncFrame)
  sync.send({ ...syncFrame, lastSyncAt: syncFrame.lastSyncAt - 1 })
  expect(sync.child.kill).toHaveBeenCalledWith('SIGTERM')
})

it('marks presentation stale on offline/auth loss; native imports cannot consume stale facts', async () => {
  const f = await factsFixture()
  f.send(quotaFrame)
  f.send(syncFrame)
  f.send({ kind: 'state', state: 'offline' })
  expect((await f.drive.read()).factsStale).toBe(true)
  expect((await f.drive.read()).quota?.used).toBe(30)
  expect(f.drive.importQuota()).toBeUndefined()
  f.send({ kind: 'state', state: 'reauthenticate' })
  expect((await f.drive.read()).issues?.map(issue => issue.code)).toContain('signed_out')
  expect(f.drive.importExclusions()).toBeUndefined()
  f.changeOwner()
  f.drive.activate()
  f.send({ ...quotaFrame, used: 90, remaining: 10 }) // retired child's event is discarded
  const next = await f.drive.read()
  expect(next.quota).toBeUndefined()
  expect(next.issues).toBeUndefined()
  expect(next.lastSyncAt).toBeUndefined()
})

it('drops facts and delayed progress when the enrolled root is replaced', async () => {
  const f = await factsFixture()
  f.send(quotaFrame)
  vi.useFakeTimers()

  try {
    f.send(progressFrame(1))
    f.send(progressFrame(2))
    renameSync(f.root, f.root + '-retired')
    mkdirSync(f.root)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.drive.importQuota()).toBeUndefined()
    const last = f.options.changed.mock.calls.at(-1)![0]
    expect(last.quota).toBeUndefined()
    expect(last.progress).toBeUndefined()
  } finally {
    vi.useRealTimers()
  }
})

it('receives facts over a real spawned fake-engine pipe with a temporary root', async () => {
  const { spawn } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const f = fixture()
  const children: ChildProcessWithoutNullStreams[] = []
  f.options.spawn.mockImplementation(() => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('./__fixtures__/drive-engine-1.1-fake.mjs', import.meta.url)),
        'https://auth.test/',
        'https://drive.test'
      ],
      { stdio: 'pipe' }
    )

    children.push(child)

    return child
  })

  try {
    await f.drive.connect()
    await vi.waitFor(async () => {
      const view = await f.drive.read()
      expect(view.state).toBe('ready')
      expect(view.lastSyncAt).toBe(syncFrame.lastSyncAt)
      expect(view.progress?.files.done).toBe(12)
      expect(view.quota?.total).toBe(1073741824)
      expect(f.drive.importExclusions()).toContain('*.synthetic')
    })
    expect((await f.drive.disconnect()).state).toBe('disconnected')
    expect((await f.drive.read()).quota).toBeUndefined()
  } finally {
    await f.drive.dispose()

    for (const child of children) {
      if (child.exitCode === null) {
        child.kill('SIGKILL')
      }
    }
  }
})

it.skipIf(!['darwin', 'linux'].includes(process.platform))(
  'real native import uses the negotiated quota/exclusions through the owner ports',
  async () => {
    const f = await factsFixture()
    const source = path.join(f.home, 'work.txt')
    const secret = path.join(f.home, 'credential.synthetic')
    writeFileSync(source, 'work')
    writeFileSync(secret, 'private')
    f.send(quotaFrame)
    f.send({ kind: 'exclusions', patterns: ['token', '.env', '.git', 'node_modules', '*.synthetic'] })

    const python = execFileSync('python3', ['-I', '-B', '-S', '-c', 'import sys;print(sys.executable)'], {
      encoding: 'utf8'
    }).trim()

    const operations = new MatrixDriveImport({
      home: f.home,
      python,
      target: () => f.drive.importTarget(),
      quota: () => f.drive.importQuota(),
      exclusions: () => f.drive.importExclusions(),
      protectedRoots: () => [],
      choose: async () => [source, secret]
    })

    const plan = await operations.importPlan()
    expect(plan).toMatchObject({
      state: 'warning',
      files: 1,
      bytes: 4,
      space: { total: 100, used: 30, remainingAfter: 66, estimated: false }
    })
    expect(JSON.stringify(plan)).not.toContain(f.home)

    if (!('planId' in plan)) {
      throw new Error('expected native plan')
    }

    expect(await operations.importRun(plan.planId)).toEqual({ state: 'completed', added: 1 })
    expect(existsSync(path.join(f.root, 'work.txt'))).toBe(true)
    expect(existsSync(path.join(f.root, 'credential.synthetic'))).toBe(false)
    expect(existsSync(source)).toBe(true)
    expect(existsSync(secret)).toBe(true)
  }
)


it('retries an enrolled Drive after a credential outage immediately on connectivity return, coalescing a live connect', async () => {
  const credential = vi.fn<() => Promise<{ accessToken: string } | null>>(async () => null)
  const f = fixture(() => ({ credential }))
  f.bindSaved()
  await f.drive.connect()
  expect(await f.drive.read()).toMatchObject({ state: 'error', problem: 'network' })
  expect(f.options.spawn).not.toHaveBeenCalled()
  credential.mockResolvedValue({ accessToken: 'recovered-token' })
  const started = Date.now()
  f.drive.recoverConnectivity(true)
  f.drive.recoverConnectivity(true)
  await until(() => expect(f.options.spawn).toHaveBeenCalledOnce())
  f.send(engineHello)
  f.send({ kind: 'state', state: 'ready' })
  await until(async () => expect(await f.drive.read()).toMatchObject({ state: 'ready' }))
  expect(Date.now() - started).toBeLessThan(1000)
  f.drive.recoverConnectivity(true)
  expect(f.options.spawn).toHaveBeenCalledOnce()
  await f.drive.dispose()
})


it('debounces launch and route-switch offline frames, publishes sustained failure, then recovers itself', async () => {
  const f = fixture()
  await f.drive.connect()
  f.send(engineHello)
  f.bind()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })

  try {
    f.send({ kind: 'state', state: 'offline' })
    expect((await f.drive.read()).state).toBe('connecting')
    expect(f.drive.importTarget()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2_000)
    f.send({ kind: 'state', state: 'ready' })
    expect((await f.drive.read()).state).toBe('ready')
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await f.drive.read()).state).toBe('ready')
    f.send({ kind: 'state', state: 'offline' })
    await vi.advanceTimersByTimeAsync(9_999)
    f.send({ kind: 'state', state: 'offline' })
    expect((await f.drive.read()).state).toBe('connecting')
    await vi.advanceTimersByTimeAsync(1)
    expect(f.options.changed).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'offline' }))
    expect(f.drive.importTarget()).toBeUndefined()
    f.send({ kind: 'state', state: 'syncing' })
    expect((await f.drive.read()).state).toBe('syncing')
    expect(f.options.spawn).toHaveBeenCalledTimes(1)
  } finally {vi.useRealTimers()}
})
