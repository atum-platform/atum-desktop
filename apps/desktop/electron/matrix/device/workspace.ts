import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import { type FileHandle, lstat, mkdir, open, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { DeviceArtifact, DeviceGrant, ProtectedRoots, WorkspaceCopies } from './contracts'
import { readRootIdentity, type RootIdentity, sameRoot, type StatFn } from './drive-root-identity'

/**
 * A cloud agent's Drive working copies on this Mac (S1 build plan §4 WS-5 device; the C0
 * `WorkspaceCopies` and the Drive half of `ProtectedRoots`).
 *
 * - `prepare(grant)`: on the agent's first device command of a turn, its Drive folder
 *   (`<Drive root>/Agents/<name>`) is cloned with APFS clonefile into
 *   `~/Atum Tasks/<name>/<task8>/`, which becomes the working directory of that agent's commands.
 *   Nothing is followed through a symlink: a symlinked folder, Drive root or copy path refuses the
 *   copy, and a symlink inside the folder is never copied. Excluded names (.hermes/, .atum/,
 *   .env*, keys, databases…) and hard-linked files are never copied. Each file's local state comes
 *   from the engine (`MatrixDrive.manifestFor`): a clean file is bound to its server version; any
 *   other file has none, so the controller never treats it as one.
 *   The synced folder is the owner's: a device command may read and write it like the owner (the
 *   engine syncs a local edit), so the copy is the agent's scratch area and its publish path, not
 *   the only way to change Drive. Only the CURRENT account's root is writable
 *   (`writableDriveRoots()`: identity-verified on every call); every other learned root stays
 *   deny-only, whatever Drive's state is now. The root is pinned in place and the engine's
 *   `.atum-drive*` state is write-denied.
 *   A direct edit and a later publish of the same file do NOT meet in the controller's version
 *   check by themselves: that check compares server ETags, and an unsynced local edit is not
 *   reflected there. So a copy file whose Drive twin changed on this Mac after the clone and is
 *   not clean in the engine's journal is withheld (see `racedAmong`), twice: in `changes()` when
 *   the turn is frozen, and again by the {@link DriveWorkspaceCopies.publicationGuard} just
 *   before each file's bytes are sent. The agent's version stays in its copy, listed in
 *   `.atum/DRIVE-CHANGED.txt`. What is left is the time between that last look and the
 *   controller's commit; there the clone-time server ETag decides (a synced edit makes a sibling,
 *   not an overwrite) and, for an edit the engine has not uploaded yet, the engine's own
 *   `If-Match` upload turns the overlap into a conflict copy (session log 2026-10-24).
 * - `changes(grant)` and `collect(paths)`: the files a turn produced in its copy, frozen as
 *   artifacts (a copy under userData no agent command can reach) with their SHA-256, for the
 *   controller to publish in the turn's transaction (the device protocol carries the bytes).
 * - {@link ConflictCopyRelay}: the engine's conflict copies inside agent folders, offered once
 *   each, so every version reaches Drive as a create-only sibling.
 *
 * The manifest a copy returns is the controller's `DeviceWorkspaceManifest`
 * (`packages/cloud-controller/src/workspace/device.ts`; keep the two identical).
 */

/** What the engine's journal says about one file (`MatrixDrive.manifestFor`). */
export interface DriveJournalFacts {
  resource: { storage: string; space: string; opaque: string }
  etag?: string
  size?: number
}
export interface DriveForCopies {
  manifestFor(relativePaths: readonly string[]): Promise<{ root: string; files: Map<string, DriveJournalFacts | null> } | null>
  /** The folder Drive is bound to, even disconnected or not enrolled (`MatrixDrive.savedRoot`). */
  savedRoot?(): string | null
}
export interface DeviceWorkspaceFile {
  path: string
  size: number
  sha256: string
  inode: number
  mtimeNs: string
  server: { resource: { storage: string; space: string; opaque: string }; etag: string } | null
}
export interface DeviceWorkspaceManifest {
  v: 1
  deviceServiceId: string
  taskId: string
  folder: string
  files: DeviceWorkspaceFile[]
  truncated: boolean
}

export interface WorkspaceCopiesOptions {
  drive: DriveForCopies
  /** The agent's workspace label ("/Agents/T"): the owner's `POST /cloud/workspaces` (create-or-get). */
  workspaceLabel(agentPrincipal: string): Promise<string | null>
  /** `~/Atum Tasks` (tests pass a temporary directory). */
  tasksRoot: string
  /** Where collected artifacts are frozen: under userData, which no agent command can reach. */
  artifactsRoot: string
  /** Main's sealed history: disconnected roots remain protected after an app restart. */
  knownDriveRoots?: string[]
  rememberDriveRoots?(roots: string[]): void
  /** Clones files into a folder (default: `/bin/cp -c -P`, APFS clonefile, links never followed). */
  clone?(sources: string[], destination: string): Promise<void>
  /** Test seam: how a Drive root is looked at (default: `lstatSync`). A test plays a filesystem that reuses inode numbers. */
  stat?: StatFn
}

/** The frozen bounds (spec/workspace-transactions/v1) plus the device protocol's artifact limits. */
export const COPY_LIMITS = {
  entries: 5000,
  depth: 16,
  listedFiles: 2000,
  listedBytes: 67_108_864,
  fileBytes: 33_554_432,
  /** A copy that cannot be an APFS clone is copied only up to this total. */
  copiedBytes: 268_435_456,
  /** device-service/1 `artifacts_max` and `artifact_max_bytes`. */
  artifacts: 16,
  artifactBytes: 8_388_608
} as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const LABEL = /^\/[!-~ ]{1,254}$/

// The engine's exclusion list, as the controller, the Drive broker and SQL apply it
// (spec/workspace-transactions/v1 `exclusions`). Case-insensitive.
const EXCLUDED_SEGMENTS = new Set(['.hermes', '.atum', '.git', '.ssh', '.gnupg', '.aws', '.kube', '.docker', 'node_modules', '__pycache__',
  '.venv', 'venv', '.tox', '.cache', '.pytest_cache', '.mypy_cache', '.trash', '.trashes', '.fseventsd', '.spotlight-v100',
  '.temporaryitems', '.documentrevisions-v100'])

const EXCLUDED_LEAF = new RegExp([
  '^\\.env', '^\\.(netrc|npmrc|pypirc|git-credentials)$', '^id_(rsa|dsa|ecdsa|ed25519)',
  '\\.(pem|key|p12|pfx|jks|keystore|kdbx)$', '\\.(db|sqlite|sqlite3)$', '\\.(db|sqlite|sqlite3)-', '-(wal|shm|journal)$',
  '^\\.ds_store$', '^\\._', '^~\\$', '^\\.~lock\\.', '\\.(part|filepart|crdownload|sock|socket)$', '~$', '^\\..*\\.sw[a-p]$',
  '^\\.atum-drive', '^\\._?sync_.*\\.db', '^\\.csync_journal\\.db', '^\\.owncloudsync\\.log', '^\\.sync-exclude\\.lst$'
].join('|'), 'u')

export function excludedFromWorkspace(relative: string): boolean {
  const segments = relative.toLowerCase().split('/')

  return segments.some(segment => EXCLUDED_SEGMENTS.has(segment)) || EXCLUDED_LEAF.test(segments[segments.length - 1] ?? '')
}

export function validWorkspacePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value, 'utf8') > 1024) {return false}

  if ([...value].some(character => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f || character === '\\')) {
    return false
  }

  if (value.startsWith('/') || value.endsWith('/')) {
    return false
  }

  const segments = value.split('/')

  return segments.length <= COPY_LIMITS.depth && segments.every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/** The engine's conflict copies: `name_conflict-yyyyMMdd-hhmmss.ext` or `name (conflicted copy …).ext`. */
export const CONFLICT_COPY = /(?:_conflict-\d{8}-\d{6}|\(conflicted copy[^)]*\))/u

const sha256File = async (file: string, maximum: number): Promise<{ sha256: string; size: number }> => {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)

  try {
    const before = await handle.stat()

    if (!before.isFile() || before.nlink !== 1 || before.size > maximum) {throw new Error('workspace_file_refused')}
    const digest = createHash('sha256')
    let size = 0

    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
      size += (chunk as Buffer).length

      if (size > maximum) {throw new Error('workspace_file_refused')}
      digest.update(chunk as Buffer)
    }

    return { sha256: digest.digest('hex'), size }
  } finally {
    await handle.close()
  }
}

const b64u = (hex: string) => Buffer.from(hex, 'hex').toString('base64url')

/** Exactly `size` bytes from an open file, refusing one that grew or shrank meanwhile. */
async function readExactly(handle: FileHandle, size: number): Promise<Buffer | null> {
  const bytes = Buffer.alloc(size)
  let offset = 0

  while (offset < size) {
    const { bytesRead } = await handle.read(bytes, offset, size - offset, offset)

    if (bytesRead === 0) {return null}
    offset += bytesRead
  }

  const { bytesRead } = await handle.read(Buffer.alloc(1), 0, 1, size)

  return bytesRead === 0 ? bytes : null
}

/** A directory under `parent`, made if missing, never reached through a symlink. */
async function ownDirectory(parent: string, name: string): Promise<string> {
  const directory = path.join(parent, name)

  try {
    await mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {throw error}
  }

  const facts = await lstat(directory)

  if (facts.isSymbolicLink() || !facts.isDirectory() || (await realpath(directory)) !== directory) {throw new Error('workspace_symlink')}

  return directory
}

/**
 * APFS clones of `sources` into `destination` with the system `cp -c` (clonefile(2)); `-P` keeps a
 * symlink operand a symlink, so a source swapped for a link is never followed (the caller refuses
 * it). A file it could not clone (another volume) is simply missing afterwards. Node's own
 * COPYFILE_FICLONE copies the bytes on this macOS build, and FICLONE_FORCE is ENOSYS.
 */
export async function cloneInto(sources: string[], destination: string): Promise<void> {
  for (let start = 0; start < sources.length; start += 200) {
    await new Promise<void>(resolve => {
      execFile('/bin/cp', ['-c', '-P', '-n', '--', ...sources.slice(start, start + 200), `${destination}/`], { timeout: 120_000 }, () => resolve())
    })
  }
}

/** A plain copy from a descriptor opened without following a link, still the walked file. */
async function copyChecked(from: string, to: string, ino: number): Promise<boolean> {
  const named = await lstat(from).catch(() => null)

  if (named?.isSymbolicLink()) {throw new Error('workspace_symlink')}
  const source = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)

  if (!source) {return false}

  try {
    const facts = await source.stat()

    if (!facts.isFile() || facts.nlink !== 1 || facts.ino !== ino) {return false}
    const bytes = await readExactly(source, facts.size)

    if (!bytes) {return false}
    await writeFile(to, bytes, { flag: 'wx', mode: 0o600 })

    return true
  } finally {
    await source.close()
  }
}

interface CopyState {
  grantId: string
  taskId: string
  agentPrincipal: string
  deviceServiceId: string
  label: string
  /** The working copy (the commands' working directory). */
  cwd: string
  manifest: DeviceWorkspaceManifest
  /** Every file copied, listed or not: what it was when the copy began. */
  copied: Map<string, { size: number; ino: number; mtimeNs: string; sha256: string | null }>
  /** The Drive file each copied file came from, as it was when copied. */
  sources: Map<string, { ino: number; size: number; mtimeNs: string }>
  /** The Drive folder the copy came from. */
  folder: string
  relativeFolder: string
  /** Files kept back because their Drive twin changed under the copy (named in `.atum/DRIVE-CHANGED.txt`). */
  withheld: Set<string>
}

export class DriveWorkspaceCopies implements WorkspaceCopies, ProtectedRoots {
  private readonly copies = new Map<string, CopyState>()
  /** Every Drive root learned, latest last: a protection is never dropped because Drive went away. */
  private readonly roots: string[] = []
  /** The current account's root as last verified by the engine, with the directory identity it had (`drive-root-identity.ts`). */
  private current: { root: string; identity: RootIdentity } | null = null
  constructor(private readonly options: WorkspaceCopiesOptions) {
    for (const root of options.knownDriveRoots ?? []) {this.learn(root)}
  }

  private learn(root: string | null | undefined): void {
    if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0') || root === '/') {return}
    const at = this.roots.indexOf(root)

    if (at >= 0) {this.roots.splice(at, 1)}
    this.roots.push(root)
    this.options.rememberDriveRoots?.([...this.roots])
  }

  /**
   * Learn the Drive root (startup and every Drive state change) before `driveRoot()` is relied on.
   * The folder Drive is bound to counts even while it is disconnected, signed out or not enrolled;
   * a failure or an unbound Drive forgets nothing (an agent must not gain the synced folder because
   * the engine stopped, or the owner switched accounts).
   */
  async refresh(): Promise<string | null> {
    try {
      this.learn(this.options.drive.savedRoot?.())
    } catch {
      // Keep what is known.
    }

    // Only a root the engine currently vouches for (signed in, enrolled to THIS account, same
    // directory it bound) can be written. Anything else clears it: a failure fails closed.
    let verified: string | undefined

    try {
      verified = (await this.options.drive.manifestFor([]))?.root
      this.learn(verified)
    } catch {
      verified = undefined
    }

    // Not a directory, a link or unreadable: no identity, so nothing writable.
    const identity = verified ? readRootIdentity(verified, this.options.stat) : null

    this.current = verified && identity ? { root: verified, identity } : null

    return this.driveRoot()
  }

  /**
   * The roots a device command may write: the current account's Drive only, re-checked now. The
   * directory must be the one the engine vouched for (same device, inode AND creation time, or the
   * same binding marker where the filesystem keeps no creation time: an inode number is reused by the
   * next directory made at some filesystems; not a link, its own canonical path) and still carry the
   * engine's binding marker as a regular file. Anything else, including a root replaced by a
   * symlink or a recreated folder, returns nothing (fail closed). Learned roots that are not
   * returned here (past accounts) are deny-only in the profile.
   */
  writableDriveRoots(): string[] {
    const current = this.current

    if (!current) {return []}

    try {
      const now = readRootIdentity(current.root, this.options.stat)

      if (!now || !now.marker || !sameRoot(current.identity, now) || realpathSync.native(current.root) !== current.root) {return []}

      return [current.root]
    } catch {
      return []
    }
  }

  /** The latest Drive root learned (never cleared): the C0 `ProtectedRoots` value. */
  driveRoot(): string | null {
    return this.roots[this.roots.length - 1] ?? null
  }

  /** Every Drive root learned in this process, for a profile that denies them all. */
  driveRoots(): string[] {
    return [...this.roots]
  }

  /** Every working copy: agent commands may write only their own (`ownWorkingRoot`), never another's or the parents. */
  agentWorkingRoots(): string[] {
    return [this.options.tasksRoot]
  }

  /** The grant's working copy, if prepared and still not swapped for a symlink. */
  async ownWorkingRoot(grantId: string): Promise<string | null> {
    const copy = this.copies.get(grantId)

    if (!copy) {return null}

    try {
      const facts = await lstat(copy.cwd)

      return !facts.isSymbolicLink() && facts.isDirectory() && (await realpath(copy.cwd)) === copy.cwd ? copy.cwd : null
    } catch {
      return null
    }
  }

  async prepare(grant: DeviceGrant): Promise<{ cwd: string; manifest: string }> {
    const existing = this.copies.get(grant.grantId)

    if (existing) {
      if (!(await this.ownWorkingRoot(grant.grantId))) {throw new Error('workspace_symlink')}

      return { cwd: existing.cwd, manifest: JSON.stringify(existing.manifest) }
    }

    const taskId = grant.invocationId ?? grant.occurrenceId ?? grant.grantId

    if (![taskId, grant.agentPrincipal, grant.targetDeviceServiceId, grant.grantId].every(id => typeof id === 'string' && UUID.test(id)))
      {throw new Error('workspace_unavailable')}

    const label = await this.options.workspaceLabel(grant.agentPrincipal)
    const drive = await this.options.drive.manifestFor([])

    if (!label || !LABEL.test(label) || !drive) {throw new Error('workspace_unavailable')}
    this.learn(drive.root)
    const relativeFolder = label.slice(1)

    if (!validWorkspacePath(relativeFolder)) {throw new Error('workspace_unavailable')}
    const folder = path.join(drive.root, ...relativeFolder.split('/'))
    const folderFacts = await lstat(folder).catch(() => null)

    if (!folderFacts) {throw new Error('workspace_unavailable')}

    if (folderFacts.isSymbolicLink() || !folderFacts.isDirectory() || (await realpath(folder)) !== folder) {throw new Error('workspace_symlink')}

    // ~/Atum Tasks/<name>/<task8>[-n]: each level made here, none a symlink.
    const tasks = await this.tasksDirectory()
    const name = (path.posix.basename(relativeFolder).replace(/[^A-Za-z0-9 ._-]/g, '-').replace(/^[. ]+/, '').slice(0, 64)) || 'Agent'
    const agentDirectory = await ownDirectory(tasks, name)
    let cwd = ''

    for (let n = 1; !cwd; n++) {
      const candidate = path.join(agentDirectory, n === 1 ? taskId.slice(0, 8) : `${taskId.slice(0, 8)}-${n}`)

      try {
        await mkdir(candidate, { mode: 0o700 })
        cwd = candidate
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || n > 99) {throw error}
      }
    }

    if ((await realpath(cwd)) !== cwd) {throw new Error('workspace_symlink')}

    const copied = new Map<string, { size: number; ino: number; mtimeNs: string; sha256: string | null }>()
    const sources = new Map<string, { ino: number; size: number; mtimeNs: string }>()
    const skipped: string[] = []
    let entries = 0, truncated = false
    // One pass over the folder (never following a link), then the copy, one clone batch per folder.
    const directories: string[] = []
    const byFolder = new Map<string, string[]>()

    const walk = async (relative: string, depth: number): Promise<void> => {
      const source = relative ? path.join(folder, ...relative.split('/')) : folder

      // The folder is the owner's and the engine's (agent commands cannot write it); a directory
      // swapped for a link while it is read still refuses the copy.
      if ((await realpath(source)) !== source) {throw new Error('workspace_symlink')}

      for (const entry of (await readdir(source)).sort()) {
        const child = relative ? `${relative}/${entry}` : entry

        if (!validWorkspacePath(child) || excludedFromWorkspace(child)) {continue}

        if (++entries > COPY_LIMITS.entries) {
          truncated = true

          return
        }

        const facts = await lstat(path.join(source, entry), { bigint: true })

        if (facts.isSymbolicLink()) {
          skipped.push(`${child}\tlink`)
        } else if (facts.isDirectory()) {
          if (depth + 1 >= COPY_LIMITS.depth) {
            truncated = true

            continue
          }

          directories.push(child)
          await walk(child, depth + 1)
        } else if (!facts.isFile() || facts.nlink !== 1n) {
          skipped.push(`${child}\t${facts.isFile() ? 'hard link' : 'not a file'}`)
        } else {
          sources.set(child, { ino: Number(facts.ino), size: Number(facts.size), mtimeNs: String(facts.mtimeNs) })
          byFolder.set(relative, [...(byFolder.get(relative) ?? []), entry])
        }
      }
    }

    await walk('', 0)

    for (const directory of directories) {
      const slash = directory.lastIndexOf('/')
      await ownDirectory(slash < 0 ? cwd : path.join(cwd, ...directory.slice(0, slash).split('/')), directory.slice(slash + 1))
    }

    let copiedBytes = 0

    for (const [relative, names] of byFolder) {
      const source = relative ? path.join(folder, ...relative.split('/')) : folder
      const target = relative ? path.join(cwd, ...relative.split('/')) : cwd
      await (this.options.clone ?? cloneInto)(names.map(name => path.join(source, name)), target)

      for (const name of names) {
        const child = relative ? `${relative}/${name}` : name
        const to = path.join(target, name)
        let made = await lstat(to, { bigint: true }).catch(() => null)

        if (!made) {
          // Not an APFS clone (another volume): a plain copy from the checked descriptor, within a bound.
          const size = sources.get(child)!.size

          if (size > COPY_LIMITS.fileBytes || copiedBytes + size > COPY_LIMITS.copiedBytes
            || !(await copyChecked(path.join(source, name), to, sources.get(child)!.ino))) {
            skipped.push(`${child}\ttoo large to copy`)
            sources.delete(child)

            continue
          }

          copiedBytes += size
          made = await lstat(to, { bigint: true })
        }

        // `cp -P` never follows a source symlink: a swap shows up here as one, and refuses the copy.
        if (made.isSymbolicLink() || !made.isFile()) {
          await rm(to, { force: true })
          throw new Error('workspace_symlink')
        }

        copied.set(child, { size: Number(made.size), ino: Number(made.ino), mtimeNs: String(made.mtimeNs), sha256: null })
      }
    }

    // The listed files: hashed from the copy, bound to a server version only when the engine
    // says the Drive file is that version and it did not change while it was copied.
    const listed: string[] = []
    let listedBytes = 0

    for (const [child, facts] of copied) {
      if (listed.length >= COPY_LIMITS.listedFiles || facts.size > COPY_LIMITS.fileBytes || listedBytes + facts.size > COPY_LIMITS.listedBytes) {
        truncated = true

        continue
      }

      listed.push(child)
      listedBytes += facts.size
    }

    const journal = await this.options.drive.manifestFor(listed.map(child => `${relativeFolder}/${child}`))
    const files: DeviceWorkspaceFile[] = []

    for (const child of listed) {
      const facts = copied.get(child)!
      let hashed: { sha256: string; size: number }

      try {
        hashed = await sha256File(path.join(cwd, ...child.split('/')), COPY_LIMITS.fileBytes)
      } catch {
        truncated = true

        continue
      }

      facts.sha256 = hashed.sha256
      const source = sources.get(child)!
      const now = await lstat(path.join(folder, ...child.split('/')), { bigint: true }).catch(() => null)
      const engine = journal?.files.get(`${relativeFolder}/${child}`) ?? null
      const unchanged = !!now && Number(now.ino) === source.ino && Number(now.size) === source.size && String(now.mtimeNs) === source.mtimeNs

      const server = engine && unchanged && typeof engine.etag === 'string' && engine.size === hashed.size && hashed.size === source.size
        ? { resource: { ...engine.resource }, etag: engine.etag } : null

      files.push({ path: child, size: hashed.size, sha256: hashed.sha256, inode: source.ino, mtimeNs: source.mtimeNs, server })
    }

    if (skipped.length || truncated) {await this.note(cwd, skipped, truncated)}
    const manifest: DeviceWorkspaceManifest = { v: 1, deviceServiceId: grant.targetDeviceServiceId, taskId, folder: label, files, truncated }
    this.copies.set(grant.grantId, { grantId: grant.grantId, taskId, agentPrincipal: grant.agentPrincipal, deviceServiceId: grant.targetDeviceServiceId,
      label, cwd, manifest, copied, sources, folder, relativeFolder, withheld: new Set() })

    return { cwd, manifest: JSON.stringify(manifest) }
  }

  private async tasksDirectory(): Promise<string> {
    const tasks = this.options.tasksRoot
    await mkdir(path.dirname(tasks), { recursive: true })

    try {
      await mkdir(tasks, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {throw error}
    }

    const facts = await lstat(tasks)

    if (facts.isSymbolicLink() || !facts.isDirectory() || (await realpath(tasks)) !== tasks) {throw new Error('workspace_symlink')}

    return tasks
  }

  /** What was not copied, where the agent reads it first (the cloud sandbox's note, same name). */
  private async note(cwd: string, skipped: string[], truncated: boolean): Promise<void> {
    const atum = await ownDirectory(cwd, '.atum')

    const body = 'These files of the Atum Drive folder were not copied here (a link, a hard link, too large, or beyond the folder bounds). '
      + 'Writing a file of the same name saves it beside the original as a copy.\n'
      + (truncated ? 'The folder was larger than one working copy holds; not every file is listed below.\n' : '')
      + skipped.slice(0, 1000).map(line => `${line}\n`).join('')

    await writeFile(path.join(atum, 'UNHYDRATED.txt'), body, { flag: 'wx', mode: 0o600 })
  }

  /** The grant's copy's changes since it began: new and changed files, and files gone (proposed deletions). */
  async changes(grantId: string): Promise<{ changed: string[]; deleted: string[]; withheld?: string[] }> {
    const copy = this.copies.get(grantId)

    if (!copy || !(await this.ownWorkingRoot(grantId))) {throw new Error('workspace_unavailable')}
    const present = new Set<string>(), changed: string[] = []
    let entries = 0

    const walk = async (relative: string, depth: number): Promise<void> => {
      const directory = relative ? path.join(copy.cwd, ...relative.split('/')) : copy.cwd

      for (const entry of (await readdir(directory)).sort()) {
        const child = relative ? `${relative}/${entry}` : entry

        if (!validWorkspacePath(child) || excludedFromWorkspace(child) || ++entries > COPY_LIMITS.entries) {continue}
        const facts = await lstat(path.join(directory, entry), { bigint: true })

        if (facts.isSymbolicLink()) {continue}

        if (facts.isDirectory()) {
          if (depth + 1 < COPY_LIMITS.depth) {await walk(child, depth + 1)}

          continue
        }

        if (!facts.isFile()) {continue}
        present.add(child)
        const before = copy.copied.get(child)

        if (!before) {
          changed.push(child)

          continue
        }

        if (Number(facts.size) === before.size && Number(facts.ino) === before.ino && String(facts.mtimeNs) === before.mtimeNs) {continue}
        const now = await sha256File(path.join(directory, entry), COPY_LIMITS.fileBytes).catch(() => null)

        if (!now || now.sha256 !== before.sha256) {changed.push(child)}
      }
    }

    await walk('', 0)
    const raced = await this.racedAmong(copy, changed)
    copy.withheld = new Set()
    await this.withhold(copy, raced)

    return {
      changed: changed.filter(child => !raced.has(child)),
      deleted: [...copy.copied.keys()].filter(child => !present.has(child)).sort(),
      ...(raced.size ? { withheld: [...raced].sort() } : {})
    }
  }

  /**
   * The race a direct Drive edit opens: the controller publishes a copy file against the SERVER
   * version the copy was cloned from, and cannot see a local Drive edit the engine has not uploaded
   * yet. Of `paths` (copy files about to be published), these are the ones whose Drive twin now
   * differs from what was cloned (or did not exist then) AND is not clean in the engine's journal
   * (`manifestFor` gives null for a local edit not yet synced): the owner's (or another command's)
   * unsynced edit must not be overwritten. A twin that is clean, gone, or unchanged since the clone
   * is the controller's ordinary version check. Looked at twice, at freeze and just before sending.
   */
  private async racedAmong(copy: CopyState, paths: string[]): Promise<Set<string>> {
    const suspects: string[] = []

    for (const child of paths) {
      const twin = await lstat(path.join(copy.folder, ...child.split('/')), { bigint: true }).catch(() => null)
      const cloned = copy.sources.get(child)

      if (!twin || !twin.isFile()) {continue}

      if (!cloned || Number(twin.ino) !== cloned.ino || Number(twin.size) !== cloned.size || String(twin.mtimeNs) !== cloned.mtimeNs) {suspects.push(child)}
    }

    if (!suspects.length) {return new Set()}
    let journal: Awaited<ReturnType<DriveForCopies['manifestFor']>> = null

    try {
      journal = await this.options.drive.manifestFor(suspects.map(child => `${copy.relativeFolder}/${child}`))
    } catch {
      journal = null
    }

    // No answer from the engine is not a clean answer: hold the file.
    return new Set(suspects.filter(child => !journal || !journal.files.get(`${copy.relativeFolder}/${child}`)))
  }

  /** Remember what is kept back and say so where the agent reads first: the copy's own `.atum/DRIVE-CHANGED.txt`. */
  private async withhold(copy: CopyState, raced: Set<string>): Promise<void> {
    const before = copy.withheld.size

    for (const child of raced) {copy.withheld.add(child)}

    if (copy.withheld.size === before) {return}
    const atum = await ownDirectory(copy.cwd, '.atum').catch(() => null)

    if (atum) {
      const body = 'These files were changed in the Drive folder on this Mac while this task worked, and that change had not finished syncing, '
        + 'so this copy was not published over it. Your version is still here.\n' + [...copy.withheld].sort().map(line => `${line}\n`).join('')
      await writeFile(path.join(atum, 'DRIVE-CHANGED.txt'), body, { mode: 0o600 }).catch(() => {})
    }
  }

  /**
   * The last look before a copy file leaves the Mac (`workspace-lifecycle.ts` calls it for each
   * output just before its bytes are sent): of `paths`, the ones to keep back now, already noted in
   * the copy. It outlives `end(grantId)`; null when the grant has no copy.
   */
  publicationGuard(grantId: string): ((paths: string[]) => Promise<string[]>) | null {
    const copy = this.copies.get(grantId)

    if (!copy) {return null}

    return async paths => {
      const raced = await this.racedAmong(copy, paths)
      await this.withhold(copy, raced)

      return [...raced]
    }
  }

  /**
   * The named files of a working copy, frozen as artifacts: each a regular, singly linked file
   * inside a prepared copy (absolute, or relative to the only copy), copied to userData from the
   * descriptor that was checked, and hashed there. At most 16, 8 MiB each (the device protocol's
   * artifact bounds); anything else is left out.
   */
  async collect(paths: string[]): Promise<DeviceArtifact[]> {
    const artifacts: DeviceArtifact[] = []
    await mkdir(this.options.artifactsRoot, { recursive: true, mode: 0o700 })

    for (const requested of paths) {
      if (artifacts.length >= COPY_LIMITS.artifacts) {break}
      const located = this.locate(requested)

      if (!located || !validWorkspacePath(located.relative) || excludedFromWorkspace(located.relative)) {continue}

      if (!(await this.ownWorkingRoot(located.copy.grantId))) {continue}
      const file = path.join(located.copy.cwd, ...located.relative.split('/'))
      const frozen = path.join(this.options.artifactsRoot, `${randomUUID()}.artifact`)

      try {
        if ((await realpath(path.dirname(file))) !== path.dirname(file)) {continue}
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)

        try {
          const facts = await handle.stat()
          const named = await lstat(file)

          if (!facts.isFile() || facts.nlink !== 1 || facts.size > COPY_LIMITS.artifactBytes || named.ino !== facts.ino || named.dev !== facts.dev) {continue}
          const bytes = await readExactly(handle, facts.size)

          if (!bytes) {continue}
          // O_NOFOLLOW guards only the last segment: a folder swapped for a link while the file was
          // opened would make this a file outside the copy. Checked again after the read; a moved
          // path is dropped. (A-2 also stops the grant's processes before collecting.)
          const after = await lstat(file).catch(() => null)

          if ((await realpath(path.dirname(file)).catch(() => null)) !== path.dirname(file) || !after
            || after.ino !== facts.ino || after.dev !== facts.dev || !(await this.ownWorkingRoot(located.copy.grantId))) {continue}

          await writeFile(frozen, bytes, { flag: 'wx', mode: 0o600 })
          const sha256 = createHash('sha256').update(bytes).digest('hex')
          artifacts.push({ name: located.relative, size: bytes.length, sha256: b64u(sha256), path: frozen })
        } finally {
          await handle.close()
        }
      } catch {
        await rm(frozen, { force: true })
      }
    }

    return artifacts
  }

  private locate(requested: string): { copy: CopyState; relative: string } | null {
    if (typeof requested !== 'string' || !requested) {return null}

    if (!path.isAbsolute(requested)) {
      const only = [...this.copies.values()]

      return only.length === 1 ? { copy: only[0]!, relative: requested } : null
    }

    for (const copy of this.copies.values()) {
      if (requested.startsWith(copy.cwd + path.sep)) {return { copy, relative: path.relative(copy.cwd, requested).split(path.sep).join('/') }}
    }

    return null
  }

  /** The copy's manifest (what it started from), for the controller beside the artifacts. */
  manifest(grantId: string): DeviceWorkspaceManifest | null {
    const copy = this.copies.get(grantId)

    return copy ? JSON.parse(JSON.stringify(copy.manifest)) as DeviceWorkspaceManifest : null
  }

  /** The grant ended: its copy stays on disk (the agent's files, the owner's to keep) but is no longer used. */
  end(grantId: string): void {
    this.copies.delete(grantId)
  }

  /** Frozen artifacts the connection has sent (or given up on). */
  async release(artifacts: DeviceArtifact[]): Promise<void> {
    for (const artifact of artifacts)
      {if (path.dirname(artifact.path) === this.options.artifactsRoot) {await rm(artifact.path, { force: true })}}
  }
}

export interface ConflictCopy {
  /** Stable for one version of one conflict copy: offered until confirmed, then never again. */
  key: string
  agentPrincipal: string
  label: string
  /** Relative to the agent's folder (the workspace path the controller publishes it at). */
  path: string
  artifact: DeviceArtifact
}
export interface ConflictCopyRelayOptions {
  /** Account/enrollment generation partition; a changed one discards old offers. */
  authority?(): string
  drive: DriveForCopies
  /** The cloud-mode agents with a Drive workspace on this account: principal and label. */
  folders(): Promise<Array<{ agentPrincipal: string; label: string }>>
  /** Persisted keys already relayed (or refused as too large): JSON-safe, bounded here. */
  store: { get(): string[]; set(keys: string[]): void }
  artifactsRoot: string
}

/**
 * The engine keeps a conflict copy only on this Mac (`<name>_conflict-<date>-<time>.<ext>`). On
 * reconnect and every 5 minutes the composition calls `scan()`; each copy inside an agent's
 * folder that was never relayed is frozen as an artifact and offered to the controller, which
 * publishes it create-only (`CloudWorkspaceFiles.publishConflictCopies`), so both versions live
 * in Drive. `confirm` records what the controller published; a copy over 8 MiB is recorded as
 * refused (S1 sends no Drive link for it). An unconfirmed copy is frozen once and the same
 * artifact offered again on the next scan (offline for a day must not fill the disk); its frozen
 * file goes when it is confirmed or the copy itself is gone. The controller publishes each copy
 * under a task ID derived from its `key`, so a confirm that was lost never makes a second copy.
 */
export class ConflictCopyRelay {
  /** Frozen artifacts already offered, by key: reused while their copy is unchanged. */
  private readonly frozen = new Map<string, ConflictCopy>()
  private authority: string | undefined
  private scanning?: Promise<{ offered: ConflictCopy[]; tooLarge: string[] }>
  constructor(private readonly options: ConflictCopyRelayOptions) {}

  private async drop(key: string): Promise<void> {
    const offered = this.frozen.get(key)
    this.frozen.delete(key)

    if (offered && path.dirname(offered.artifact.path) === this.options.artifactsRoot) {await rm(offered.artifact.path, { force: true })}
  }

  /** A frozen artifact still on disk as it was frozen (the composition may have released it). */
  private async reusable(key: string): Promise<ConflictCopy | null> {
    const offered = this.frozen.get(key)

    if (!offered) {return null}
    const facts = await lstat(offered.artifact.path).catch(() => null)

    if (facts && !facts.isSymbolicLink() && facts.isFile() && facts.size === offered.artifact.size) {return { ...offered, artifact: { ...offered.artifact } }}
    this.frozen.delete(key)

    return null
  }

  async scan(): Promise<{ offered: ConflictCopy[]; tooLarge: string[] }> {
    if (this.scanning) {return this.scanning}
    const run = this.scanNow().finally(() => {if (this.scanning === run) {this.scanning = undefined}})
    this.scanning = run

    return run
  }
  private async scanNow(): Promise<{ offered: ConflictCopy[]; tooLarge: string[] }> {
    const authority = this.options.authority?.()

    if (authority !== this.authority) {
      for (const key of [...this.frozen.keys()]) {await this.drop(key)}
      this.authority = authority
    }

    const done = new Set(this.options.store.get())
    const drive = await this.options.drive.manifestFor([])

    if (!drive) {return { offered: [], tooLarge: [] }}
    await mkdir(this.options.artifactsRoot, { recursive: true, mode: 0o700 })
    const offered: ConflictCopy[] = [], tooLarge: string[] = []
    const present = new Set<string>()

    for (const { agentPrincipal, label } of await this.options.folders()) {
      if (!LABEL.test(label) || !validWorkspacePath(label.slice(1))) {continue}
      const folder = path.join(drive.root, ...label.slice(1).split('/'))
      const facts = await lstat(folder).catch(() => null)

      if (!facts || facts.isSymbolicLink() || !facts.isDirectory() || (await realpath(folder)) !== folder) {continue}
      let entries = 0

      const walk = async (relative: string, depth: number): Promise<void> => {
        const directory = relative ? path.join(folder, ...relative.split('/')) : folder
        const directoryFacts = await lstat(directory).catch(() => null)

        if (!directoryFacts?.isDirectory() || directoryFacts.isSymbolicLink() || await realpath(directory) !== directory) {return}

        for (const entry of (await readdir(directory)).sort()) {
          const child = relative ? `${relative}/${entry}` : entry

          if (!validWorkspacePath(child) || excludedFromWorkspace(child) || ++entries > COPY_LIMITS.entries) {continue}
          const file = path.join(directory, entry)
          const item = await lstat(file, { bigint: true })

          if (item.isSymbolicLink()) {continue}

          if (item.isDirectory()) {
            if (depth + 1 < COPY_LIMITS.depth) {await walk(child, depth + 1)}

            continue
          }

          if (!item.isFile() || Number(item.nlink) !== 1 || !CONFLICT_COPY.test(entry)) {continue}
          const key = createHash('sha256').update(`${agentPrincipal}\0${label}\0${child}\0${item.dev}\0${item.ino}\0${item.mtimeNs}\0${item.ctimeNs}\0${item.size}`).digest('hex')

          present.add(key)

          if (done.has(key) || offered.length >= COPY_LIMITS.artifacts) {continue}
          const again = await this.reusable(key)

          if (again) {
            offered.push(again)

            continue
          }

          if (Number(item.size) > COPY_LIMITS.artifactBytes) {
            tooLarge.push(key)

            continue
          }

          const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)

          if (!handle) {continue}

          try {
            const opened = await handle.stat({ bigint: true })

            if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== item.dev || opened.ino !== item.ino
              || opened.size !== item.size || opened.mtimeNs !== item.mtimeNs || opened.ctimeNs !== item.ctimeNs
              || opened.size > BigInt(COPY_LIMITS.artifactBytes)) {continue}

            const bytes = await readExactly(handle, Number(opened.size))
            const after = await lstat(file, { bigint: true }).catch(() => null)
            const folderAfter = await lstat(folder).catch(() => null)
            const directoryAfter = await lstat(directory).catch(() => null)

            if (!bytes || !after?.isFile() || after.nlink !== 1n || after.dev !== item.dev || after.ino !== item.ino
              || after.size !== item.size || after.mtimeNs !== item.mtimeNs || after.ctimeNs !== item.ctimeNs
              || !folderAfter?.isDirectory() || folderAfter.dev !== facts.dev || folderAfter.ino !== facts.ino
              || !directoryAfter?.isDirectory() || directoryAfter.dev !== directoryFacts.dev || directoryAfter.ino !== directoryFacts.ino
              || await realpath(directory) !== directory || await realpath(folder) !== folder) {continue}

            const frozen = path.join(this.options.artifactsRoot, `${randomUUID()}.artifact`)
            await writeFile(frozen, bytes, { flag: 'wx', mode: 0o600 })

            const copy: ConflictCopy = { key, agentPrincipal, label, path: child,
              artifact: { name: child, size: bytes.length, sha256: b64u(createHash('sha256').update(bytes).digest('hex')), path: frozen } }

            this.frozen.set(key, copy)
            offered.push({ ...copy, artifact: { ...copy.artifact } })
          } finally {
            await handle.close()
          }
        }
      }

      await walk('', 0)
    }

    if (authority !== this.options.authority?.()) {
      for (const key of [...this.frozen.keys()]) {await this.drop(key)}

      return { offered: [], tooLarge: [] }
    }

    if (tooLarge.length) {this.remember(tooLarge)}

    // A copy that changed or went away: its earlier version's frozen file is not offered again.
    for (const key of [...this.frozen.keys()]) {if (!present.has(key) || done.has(key)) {await this.drop(key)}}

    return { offered, tooLarge }
  }

  /** The controller published these (or refused them for good): never offered again. */
  async confirm(keys: string[]): Promise<void> {
    if (this.authority !== this.options.authority?.()) {return}
    this.remember(keys)

    for (const key of keys) {await this.drop(key)}
  }

  private remember(keys: string[]): void {
    const all = [...new Set([...this.options.store.get(), ...keys.filter(key => /^[0-9a-f]{64}$/.test(key))])]
    this.options.store.set(all.slice(-4000))
  }
}

/** A whole-copy fingerprint for sealed saved receipts; links, churn and excess bounds refuse. */
export async function workspaceCopyDigest(cwd: string): Promise<string | null> {
  try {
    const root = await lstat(cwd, { bigint: true })

    if (!root.isDirectory() || root.isSymbolicLink() || await realpath(cwd) !== cwd) {return null}
    const rows: string[] = []
    let entries = 0, total = 0

    const walk = async (directory: string, depth: number): Promise<void> => {
      const named = await lstat(directory, { bigint: true })

      if (!named.isDirectory() || named.isSymbolicLink() || await realpath(directory) !== directory || depth > COPY_LIMITS.depth) {throw Error('workspace_changed')}

      for (const name of (await readdir(directory)).sort()) {
        if (++entries > COPY_LIMITS.entries) {throw Error('workspace_too_large')}
        const file = path.join(directory, name)
        const before = await lstat(file, { bigint: true })

        if (before.isSymbolicLink()) {throw Error('workspace_symlink')}

        if (before.isDirectory()) {await walk(file, depth + 1)}
        else {
          if (!before.isFile() || before.nlink !== 1n) {throw Error('workspace_special_file')}
          total += Number(before.size)

          if (total > COPY_LIMITS.copiedBytes) {throw Error('workspace_too_large')}
          const hashed = await sha256File(file, COPY_LIMITS.fileBytes)
          const after = await lstat(file, { bigint: true })

          if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size
            || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || await realpath(path.dirname(file)) !== path.dirname(file)) {throw Error('workspace_changed')}

          rows.push(JSON.stringify([path.relative(cwd, file), String(before.dev), String(before.ino), hashed.size, hashed.sha256]))
        }
      }

      const after = await lstat(directory, { bigint: true })

      if (named.ino !== after.ino || named.dev !== after.dev || named.mtimeNs !== after.mtimeNs || named.ctimeNs !== after.ctimeNs) {throw Error('workspace_changed')}
    }

    await walk(cwd, 0)
    const after = await lstat(cwd, { bigint: true })

    if (root.ino !== after.ino || root.dev !== after.dev || await realpath(cwd) !== cwd) {return null}

    return createHash('sha256').update(JSON.stringify([String(root.dev), String(root.ino), rows])).digest('hex')
  } catch {return null}
}

/**
 * Remove frozen artifacts left by a crash (older than a day) and working copies older than `days`
 * whose turn's files all reached Drive (`saved(copy)`, from the transaction results the
 * composition keeps). A copy that holds an output reported as not saved, unknown or a conflict is
 * the only place that file exists: without `saved`, no working copy is ever removed.
 */
export async function pruneWorkspaceCopies(options: { tasksRoot: string; artifactsRoot: string; now?: number; days?: number;
  saved?(copy: string): boolean | Promise<boolean>
  /** Production retires a saved copy by atomic rename to a recoverable archive. */
  retire?(copy: string): Promise<void> }): Promise<number> {
  const now = options.now ?? Date.now()
  let removed = 0

  for (const [root, age, depth] of [[options.artifactsRoot, 86_400_000, 1], [options.tasksRoot, (options.days ?? 30) * 86_400_000, 2]] as const) {
    const facts = await lstat(root).catch(() => null)

    if (!facts || facts.isSymbolicLink() || !facts.isDirectory()) {continue}
    const level = depth === 1 ? [root] : (await readdir(root)).map(name => path.join(root, name))

    for (const parent of level) {
      const parentFacts = await lstat(parent).catch(() => null)

      if (!parentFacts || parentFacts.isSymbolicLink() || !parentFacts.isDirectory()) {continue}

      for (const name of await readdir(parent)) {
        const item = path.join(parent, name)
        const itemFacts = await lstat(item).catch(() => null)

        if (!itemFacts || itemFacts.isSymbolicLink() || now - itemFacts.mtimeMs <= age) {continue}

        if (depth === 2 && !await options.saved?.(item)) {continue}

        if (depth === 2 && options.retire) {await options.retire(item)}
        else {await rm(item, { recursive: true, force: true })}

        removed++
      }
    }
  }

  return removed
}
