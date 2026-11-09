import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { rejectUnsafePathSyntax, sensitiveFileBlockReason } from './hardening'
import type { WorkspaceTextFileLeaseDescriptor } from './workspace-text-file-lease'

/**
 * The consumer Files panel: a Finder/Explorer-style view of the person's own
 * home folder, driven by the trusted main-frame renderer only.
 *
 * Authority model. The panel never widens what the assistant can do: the
 * backend still reaches files only through the S2-C capability broker, and
 * these channels are not exported to it. What the renderer gets is confined
 * to the home folder (canonical realpath, so a symlink cannot walk out),
 * lists metadata, opens text through the same main-owned lease the native
 * picker uses, returns bounded image bytes, and hands everything else to the
 * OS. Mutations are rename and OS trash (recoverable) — never a hard delete.
 */

export const ATUM_CONSUMER_FILES_IPC_CHANNELS = {
  list: 'atum:files:list',
  mkdir: 'atum:files:mkdir',
  open: 'atum:files:open',
  capture: 'atum:files:capture',
  openNative: 'atum:files:open-native',
  releaseView: 'atum:files:release-view',
  rename: 'atum:files:rename',
  reveal: 'atum:files:reveal',
  roots: 'atum:files:roots',
  search: 'atum:files:search',
  thumbnail: 'atum:files:thumbnail',
  trash: 'atum:files:trash'
} as const

export { ATUM_FILE_VIEW_PARTITION } from './atum-file-view-constants'
export const CONSUMER_FILES_VIEW_TTL_MS = 12 * 60 * 60 * 1000
export const CONSUMER_FILES_VIEW_MAX_TOKENS = 64
export const CONSUMER_FILES_THUMBNAIL_MAX_SIZE = 256

export interface ConsumerFileEntry {
  extension: string
  isDirectory: boolean
  modifiedMs: number | null
  name: string
  path: string
  size: number | null
}

export interface ConsumerFileRoots {
  desktop: string
  documents: string
  downloads: string
  home: string
  workspace?: string
}

export type ConsumerFileOpenResult =
  | { kind: 'error'; code: string }
  | { kind: 'image'; dataUrl: string; mimeType: string; size: number }
  /** No account lease authority is installed (plain Hermes embedding); the
   * renderer may fall back to its legacy preview path. */
  | { kind: 'legacy' }
  | { kind: 'native' }
  | { kind: 'card'; token: string; size: number }
  /** Rendered in-panel by Chromium's viewer; `url` carries a one-tab token. */
  /** Rendered by a main-owned view; the renderer receives only the token. */
  | { kind: 'pdf'; token: string }
  | { kind: 'text'; descriptor: WorkspaceTextFileLeaseDescriptor; imported?: string }

export interface ConsumerFilesServiceDeps {
  fs?: typeof fs
  leases?: { openLocal(filePath: string, options: { ownerId: string }): WorkspaceTextFileLeaseDescriptor } | null
  /** Atum Office: a `.docx` opened from the panel is imported as a workspace document (owner decision, 2026-09-03). */
  importDocx?: (
    filePath: string,
    ownerId: string
  ) => Promise<{ descriptor: WorkspaceTextFileLeaseDescriptor; sourceDisplayName: string }>
  /** Told after a successful rename or trash so document metadata can follow the file. */
  onRenamed?: (from: string, to: string) => void
  onTrashed?: (target: string) => void
  roots: () => ConsumerFileRoots
  /** OS thumbnail (Quick Look / shell) as a data URL, or null when the
   * platform has none for this file. Bounded by the caller's `size`. */
  thumbnail?: (filePath: string, size: number) => Promise<null | string>
  shell: {
    openPath(target: string): Promise<string>
    showItemInFolder(target: string): void
    trashItem(target: string): Promise<void>
  }
}

export const CONSUMER_FILES_IMAGE_MAX_BYTES = 16 * 1024 * 1024
export const CONSUMER_FILES_SEARCH_MAX_RESULTS = 200
export const CONSUMER_FILES_SEARCH_MAX_VISITED = 25_000
export const CONSUMER_FILES_SEARCH_MAX_DEPTH = 8
export const CONSUMER_FILES_SEARCH_BUDGET_MS = 4000

const IMAGE_MIME: Record<string, string> = {
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
}

export function consumerFileImageMime(name: string): string | undefined {
  return IMAGE_MIME[consumerFileExtension(name)]
}

const TEXT_EXTENSIONS = new Set([
  '.c', '.cfg', '.conf', '.cpp', '.cs', '.css', '.csv', '.env', '.go', '.h', '.html', '.htm', '.ini', '.java',
  '.js', '.json', '.jsx', '.kt', '.log', '.markdown', '.md', '.mjs', '.php', '.py', '.rb', '.rs', '.scss', '.sh',
  '.sql', '.swift', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml'
])

/** Folders Finder shows but nobody searches by hand; skipped by search only. */
const SEARCH_SKIPPED = new Set(['node_modules', 'Library', '.git', '.venv', 'venv', '__pycache__', '.cache'])

export function consumerFileExtension(name: string): string {
  return path.extname(name).toLowerCase()
}

export function consumerFileOpenKind(name: string): 'image' | 'native' | 'pdf' | 'text' {
  const extension = consumerFileExtension(name)

  if (IMAGE_MIME[extension]) {
    return 'image'
  }

  if (extension === '.pdf') {
    return 'pdf'
  }

  return TEXT_EXTENSIONS.has(extension) ? 'text' : 'native'
}

function isHidden(name: string): boolean {
  return name.startsWith('.')
}

function validRenameName(name: string): boolean {
  return Boolean(name) && name !== '.' && name !== '..' && !/[\\/]/u.test(name) && !name.includes('\0')
}

export class AtumConsumerFilesService {
  private readonly fs: typeof fs
  private readonly views = new Map<string, { expiresAt: number; identity: { dev: number; ino: number }; path: string }>()

  constructor(private readonly deps: ConsumerFilesServiceDeps) {
    this.fs = deps.fs ?? fs
  }

  roots(): ConsumerFileRoots {
    return this.deps.roots()
  }

  /** Canonical home folder. Everything the panel touches must live under it. */
  private homeRealpath(): string {
    return this.fs.realpathSync(this.deps.roots().home)
  }

  /**
   * Resolve a renderer-supplied path to its canonical form and prove it is
   * the home folder or inside it. Throws `CONSUMER_FILES_OUTSIDE_HOME` for
   * anything else, including a symlink that points out of home, and
   * `CONSUMER_FILES_SENSITIVE` for credential-bearing paths (the same
   * blocklist every legacy raw-path channel enforced).
   */
  confine(requested: unknown): string {
    const raw = this.requestedAbsolutePath(requested)
    let canonical: string

    try {
      canonical = this.fs.realpathSync(raw)
    } catch {
      throw new Error('CONSUMER_FILES_MISSING')
    }

    this.assertInsideHome(canonical)
    this.assertNotSensitive(canonical)

    return canonical
  }

  /**
   * Like `confine`, but for an entry the person acts on by name: the parent
   * is canonicalised and the final component is kept as written (a symlink
   * is renamed or trashed as the link, never its target). Hidden entries are
   * refused for open/reveal (`hiddenLeaf`) and anywhere below home for
   * mutations (`hiddenPath`), because the panel never shows them.
   */
  confineEntry(requested: unknown, hidden: 'leaf' | 'path'): string {
    const raw = this.requestedAbsolutePath(requested)
    const name = path.basename(raw)

    if (!name || name === '.' || name === '..') {
      throw new Error('CONSUMER_FILES_INVALID_PATH')
    }

    let parent: string

    try {
      parent = this.fs.realpathSync(path.dirname(raw))
    } catch {
      throw new Error('CONSUMER_FILES_MISSING')
    }

    this.assertInsideHome(parent)
    const target = path.join(parent, name)

    try {
      this.fs.lstatSync(target)
    } catch {
      throw new Error('CONSUMER_FILES_MISSING')
    }

    if (target === this.homeRealpath()) {
      throw new Error('CONSUMER_FILES_OUTSIDE_HOME')
    }

    this.assertNotSensitive(target)

    const home = this.homeRealpath()
    const components = path.relative(home, target).split(path.sep)
    const hiddenComponents = hidden === 'path' ? components : components.slice(-1)

    if (hiddenComponents.some(isHidden)) {
      throw new Error('CONSUMER_FILES_HIDDEN')
    }

    return target
  }

  private requestedAbsolutePath(requested: unknown): string {
    const raw = rejectUnsafePathSyntax(String(requested ?? ''), 'Consumer file')

    if (!path.isAbsolute(raw)) {
      throw new Error('CONSUMER_FILES_INVALID_PATH')
    }

    return raw
  }

  private assertInsideHome(canonical: string): void {
    const home = this.homeRealpath()

    if (canonical !== home && !canonical.startsWith(home + path.sep)) {
      throw new Error('CONSUMER_FILES_OUTSIDE_HOME')
    }
  }

  private assertNotSensitive(target: string): void {
    // Checked as a file and as a folder, so listing `~/.ssh` is refused just
    // like reading `~/.ssh/id_rsa`.
    if (sensitiveFileBlockReason(target) || sensitiveFileBlockReason(`${target}${path.sep}`)) {
      throw new Error('CONSUMER_FILES_SENSITIVE')
    }
  }

  private async entryFor(directory: string, name: string, dirent?: fs.Dirent): Promise<ConsumerFileEntry | null> {
    const fullPath = path.join(directory, name)

    try {
      const stat = await this.fs.promises.stat(fullPath)
      const isDirectory = stat.isDirectory()

      if (!isDirectory && !stat.isFile()) {
        return null
      }

      return {
        extension: isDirectory ? '' : consumerFileExtension(name),
        isDirectory,
        modifiedMs: Number.isFinite(stat.mtimeMs) ? Math.round(stat.mtimeMs) : null,
        name,
        path: fullPath,
        size: isDirectory ? null : stat.size
      }
    } catch {
      // A dangling symlink or a vanished entry: Finder hides these too.
      if (dirent?.isDirectory()) {
        return { extension: '', isDirectory: true, modifiedMs: null, name, path: fullPath, size: null }
      }

      return null
    }
  }

  async list(requested: unknown): Promise<{ entries: ConsumerFileEntry[]; error?: string }> {
    let directory: string

    try {
      directory = this.confine(requested)
    } catch (error) {
      return { entries: [], error: error instanceof Error ? error.message : 'CONSUMER_FILES_INVALID_PATH' }
    }

    let dirents: fs.Dirent[]

    try {
      dirents = await this.fs.promises.readdir(directory, { withFileTypes: true })
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'read-error'

      return { entries: [], error: code }
    }

    const entries = await Promise.all(
      dirents.filter(dirent => !isHidden(dirent.name)).map(dirent => this.entryFor(directory, dirent.name, dirent))
    )

    return { entries: sortEntries(entries.filter((entry): entry is ConsumerFileEntry => entry !== null)) }
  }

  /**
   * Recursive name search below one folder, bounded in results, visited
   * entries, depth and time so a home folder with a million files still
   * answers promptly. `truncated` tells the renderer a bound was hit.
   */
  async search(requested: unknown, rawQuery: unknown): Promise<{ entries: ConsumerFileEntry[]; truncated: boolean }> {
    const query = String(rawQuery ?? '').trim().toLocaleLowerCase()

    if (!query) {
      return { entries: [], truncated: false }
    }

    const root = this.confine(requested)
    const deadline = Date.now() + CONSUMER_FILES_SEARCH_BUDGET_MS
    const matches: ConsumerFileEntry[] = []
    const queue: Array<{ depth: number; directory: string }> = [{ depth: 0, directory: root }]
    let visited = 0
    let truncated = false

    while (queue.length > 0) {
      const { depth, directory } = queue.shift()!
      let dirents: fs.Dirent[]

      try {
        // A queued folder may have been swapped for a symlink since it was
        // enumerated; re-prove it still lives under home before reading it.
        this.assertInsideHome(this.fs.realpathSync(directory))
        dirents = await this.fs.promises.readdir(directory, { withFileTypes: true })
      } catch {
        continue
      }

      for (const dirent of dirents) {
        if (isHidden(dirent.name)) {
          continue
        }

        visited += 1

        if (dirent.name.toLocaleLowerCase().includes(query)) {
          const entry = await this.entryFor(directory, dirent.name, dirent)

          if (entry) {
            matches.push(entry)
          }
        }

        if (dirent.isDirectory() && depth < CONSUMER_FILES_SEARCH_MAX_DEPTH && !SEARCH_SKIPPED.has(dirent.name)) {
          queue.push({ depth: depth + 1, directory: path.join(directory, dirent.name) })
        }

        if (
          matches.length >= CONSUMER_FILES_SEARCH_MAX_RESULTS ||
          visited >= CONSUMER_FILES_SEARCH_MAX_VISITED ||
          Date.now() > deadline
        ) {
          truncated = true
          queue.length = 0

          break
        }
      }
    }

    return { entries: sortEntries(matches), truncated }
  }

  async open(requested: unknown, ownerId: string): Promise<ConsumerFileOpenResult> {
    let target: string

    try {
      target = this.confine(this.confineEntry(requested, 'leaf'))
    } catch (error) {
      return { code: error instanceof Error ? error.message : 'CONSUMER_FILES_INVALID_PATH', kind: 'error' }
    }

    let stat: fs.Stats

    try {
      stat = await this.fs.promises.stat(target)
    } catch {
      return { code: 'CONSUMER_FILES_MISSING', kind: 'error' }
    }

    if (!stat.isFile()) {
      return { code: 'CONSUMER_FILES_NOT_A_FILE', kind: 'error' }
    }

    const kind = consumerFileOpenKind(target)

    if (kind === 'image') {
      if (stat.size > CONSUMER_FILES_IMAGE_MAX_BYTES) {
        return this.openFileCard(target, stat)
      }

      const mimeType = IMAGE_MIME[consumerFileExtension(target)]!

      try {
        const data = await this.fs.promises.readFile(target)

        return { dataUrl: `data:${mimeType};base64,${data.toString('base64')}`, kind: 'image', mimeType, size: stat.size }
      } catch {
        return { code: 'CONSUMER_FILES_READ_FAILED', kind: 'error' }
      }
    }

    if (kind === 'pdf') {
      this.pruneViews()
      const token = randomBytes(18).toString('base64url')
      // The token is bound to the file's identity, not just its path, so a
      // later swap of the path (or an ancestor) for something else cannot be
      // served through it.
      this.views.set(token, {
        expiresAt: Date.now() + CONSUMER_FILES_VIEW_TTL_MS,
        identity: { dev: stat.dev, ino: stat.ino },
        path: target
      })

      return { kind: 'pdf', token }
    }

    if (consumerFileExtension(target) === '.docx' && this.deps.importDocx) {
      try {
        const imported = await this.deps.importDocx(target, ownerId)

        return { descriptor: imported.descriptor, imported: imported.sourceDisplayName, kind: 'text' }
      } catch (error) {
        return { code: error instanceof Error ? error.message : 'DOCX_IMPORT_FAILED', kind: 'error' }
      }
    }

    if (kind === 'text') {
      if (!this.deps.leases) {
        return { kind: 'legacy' }
      }

      try {
        return { descriptor: this.deps.leases.openLocal(target, { ownerId }), kind: 'text' }
      } catch (error) {
        // A configured-but-signed-out account surfaces CAPABILITY_REVOKED here
        // and stays denied; only an unconfigured embedding gets `legacy`.
        return { code: error instanceof Error ? error.message : 'WORKSPACE_OPEN_FAILED', kind: 'error' }
      }
    }

    return this.openFileCard(target, stat)
  }

  private openFileCard(target: string, stat: fs.Stats): ConsumerFileOpenResult {
    this.pruneViews()
    const token = randomBytes(18).toString('base64url')
    this.views.set(token, { expiresAt: Date.now() + CONSUMER_FILES_VIEW_TTL_MS,
      identity: { dev: stat.dev, ino: stat.ino }, path: target })

    return { kind: 'card', token, size: stat.size }
  }

  /** Read-only grant for a native-picked document, without opening a viewer or
   * reading its body. Reuses the Files confinement and capture authority. */
  async grantCapture(requested: string, maxBytes = 20 * 1024 * 1024): Promise<{ token: string; name: string }> {
    const target = this.confine(this.confineEntry(requested, 'leaf'))
    const stat = await this.fs.promises.stat(target)

    if (!stat.isFile() || stat.size > maxBytes) {throw new Error('CONSUMER_FILES_CAPTURE_LIMIT_OR_CHANGED')}
    const grant = this.openFileCard(target, stat)

    if (grant.kind !== 'card') {throw new Error('CONSUMER_FILES_READ_FAILED')}

    return { token: grant.token, name: path.basename(target) }
  }

  /** Freeze exactly one confined, identity-bound file at Send. No write lease. */
  async capture(token: unknown, maxBytes = 20 * 1024 * 1024): Promise<{ dataUrl: string; revision: string }> {
    const target = this.resolveResource(token)

    if (!target) {throw new Error('CONSUMER_FILES_MISSING')}
    const expected = this.views.get(String(token))!
    const file = await this.fs.promises.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)

    try {
      const before = await file.stat()

      if (!before.isFile() || before.dev !== expected.identity.dev || before.ino !== expected.identity.ino || before.size > maxBytes) {
        throw new Error('CONSUMER_FILES_CAPTURE_LIMIT_OR_CHANGED')
      }

      // Bounded read even if another process grows the file after fstat.
      const bytes = Buffer.alloc(before.size + 1)
      let used = 0

      while (used < bytes.length) {
        const read = await file.read(bytes, used, bytes.length - used, used)

        if (!read.bytesRead) {break}
        used += read.bytesRead
      }

      const after = await file.stat()

      if (used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || this.resolveResource(token) !== target) {
        throw new Error('CONSUMER_FILES_CAPTURE_CHANGED')
      }

      return { dataUrl: `data:application/octet-stream;base64,${bytes.subarray(0, used).toString('base64')}`,
        revision: `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}` }
    } finally {await file.close()}
  }

  private async openNativeResult(target: string): Promise<ConsumerFileOpenResult> {
    const error = await this.deps.shell.openPath(target)

    return error ? { code: 'CONSUMER_FILES_NATIVE_OPEN_FAILED', kind: 'error' } : { kind: 'native' }
  }

  async openNative(requested: unknown): Promise<{ ok: boolean; error?: string }> {
    try {
      const result = await this.openNativeResult(this.confine(this.confineEntry(requested, 'leaf')))

      return result.kind === 'native' ? { ok: true } : { error: result.kind === 'error' ? result.code : 'unknown', ok: false }
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'CONSUMER_FILES_INVALID_PATH', ok: false }
    }
  }

  private pruneViews(): void {
    const now = Date.now()

    for (const [token, view] of this.views) {
      if (view.expiresAt <= now) {
        this.views.delete(token)
      }
    }

    while (this.views.size >= CONSUMER_FILES_VIEW_MAX_TOKENS) {
      const oldest = this.views.keys().next().value

      if (oldest === undefined) {
        break
      }

      this.views.delete(oldest)
    }
  }

  /** Resolve a viewer token to its file, re-proving confinement each time
   * because the file may have moved or been swapped since the tab opened. */
  resolveView(token: unknown): null | string {
    const target = this.resolveResource(token)

    return target && consumerFileOpenKind(target) === 'pdf' ? target : null
  }

  /** Main-only capture custody. PDF view resolution stays PDF-only; a Word
   * consumer independently proves the same picked file before Apple Events. */
  resolveCapture(token: unknown): null | string {
    return this.resolveResource(token)
  }

  private resolveResource(token: unknown): null | string {
    const key = String(token ?? '')
    const view = this.views.get(key)

    if (!view) {
      return null
    }

    if (view.expiresAt <= Date.now()) {
      this.views.delete(key)

      return null
    }

    try {
      const canonical = this.confine(view.path)
      // Same path is not enough: the token is bound to the file's identity,
      // so a replacement at the same name (or a leaf swapped for a symlink,
      // which lstat does not follow) stops resolving.
      const current = this.fs.lstatSync(canonical)

      if (
        canonical === view.path &&
        current.isFile() &&
        current.dev === view.identity.dev &&
        current.ino === view.identity.ino
      ) {
        // An open document keeps its token alive; the TTL bounds idle tokens.
        view.expiresAt = Date.now() + CONSUMER_FILES_VIEW_TTL_MS

        return canonical
      }
    } catch {
      // The file moved, was replaced, or is no longer allowed: fall through.
    }

    // A token whose file is gone is dead; forget it rather than keep it alive
    // for a file that might reappear at that path.
    this.views.delete(key)

    return null
  }

  releaseView(token: unknown): boolean {
    return this.views.delete(String(token ?? ''))
  }

  /** Viewer tokens are renderer-only capability handles. Account transitions
   * invalidate every outstanding handle before the next account can paint a
   * stale PDF tab. */
  clearViews(): void {
    this.views.clear()
  }


  async thumbnail(requested: unknown, rawSize: unknown): Promise<null | string> {
    if (!this.deps.thumbnail) {
      return null
    }

    const size = Math.max(16, Math.min(CONSUMER_FILES_THUMBNAIL_MAX_SIZE, Math.round(Number(rawSize) || 0)))

    let target: string

    try {
      target = this.confine(this.confineEntry(requested, 'leaf'))
    } catch {
      return null
    }

    try {
      return await this.deps.thumbnail(target, size)
    } catch {
      return null
    }
  }

  async mkdir(requested: unknown, rawName: unknown): Promise<{ path: string }> {
    const parent = this.confine(requested)
    const name = String(rawName ?? '').trim()

    if (!validRenameName(name) || isHidden(name)) {
      throw new Error('CONSUMER_FILES_INVALID_NAME')
    }

    const target = path.join(parent, name)
    this.assertNotSensitive(target)

    try {
      await this.fs.promises.mkdir(target)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''

      throw new Error(code === 'EEXIST' ? 'CONSUMER_FILES_EXISTS' : 'CONSUMER_FILES_WRITE_FAILED')
    }

    return { path: target }
  }

  reveal(requested: unknown): boolean {
    try {
      this.deps.shell.showItemInFolder(this.confineEntry(requested, 'leaf'))

      return true
    } catch {
      return false
    }
  }

  async rename(requested: unknown, rawName: unknown): Promise<{ path: string }> {
    const source = this.confineEntry(requested, 'path')
    const name = String(rawName ?? '').trim()

    if (!validRenameName(name) || isHidden(name)) {
      throw new Error('CONSUMER_FILES_INVALID_NAME')
    }

    const destination = path.join(path.dirname(source), name)

    if (destination === source) {
      return { path: source }
    }

    this.assertNotSensitive(destination)

    // The parent is already canonical, so the destination stays inside home
    // by construction; only an existing sibling can block the rename. A
    // case-only rename on a case-insensitive volume is the same entry, not a
    // collision.
    const caseOnly = destination.toLowerCase() === source.toLowerCase()

    if (!caseOnly) {
      let exists = true

      try {
        await this.fs.promises.lstat(destination)
      } catch {
        exists = false
      }

      if (exists) {
        throw new Error('CONSUMER_FILES_EXISTS')
      }
    }

    await this.fs.promises.rename(source, destination)
    this.deps.onRenamed?.(source, destination)

    return { path: destination }
  }

  async trash(requested: unknown): Promise<boolean> {
    const target = this.confineEntry(requested, 'path')

    await this.deps.shell.trashItem(target)
    this.deps.onTrashed?.(target)

    return true
  }
}

export function sortEntries(entries: ConsumerFileEntry[]): ConsumerFileEntry[] {
  return entries.toSorted(
    (a, b) =>
      Number(b.isDirectory) - Number(a.isDirectory) ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  )
}

export function registerAtumConsumerFilesIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  service: AtumConsumerFilesService,
  assertTrustedSender: (event: IpcMainInvokeEvent) => void
): void {
  const guarded = <TArgs extends unknown[], TResult>(handler: (...args: TArgs) => TResult) =>
    (event: IpcMainInvokeEvent, ...args: TArgs) => {
      assertTrustedSender(event)

      return handler(...args)
    }

  ipcMain.handle(ATUM_CONSUMER_FILES_IPC_CHANNELS.roots, guarded(() => service.roots()))
  ipcMain.handle(ATUM_CONSUMER_FILES_IPC_CHANNELS.list, guarded((directory: unknown) => service.list(directory)))
  ipcMain.handle(
    ATUM_CONSUMER_FILES_IPC_CHANNELS.search,
    guarded((directory: unknown, query: unknown) => service.search(directory, query))
  )
  ipcMain.handle(ATUM_CONSUMER_FILES_IPC_CHANNELS.open, (event, target: unknown) => {
    assertTrustedSender(event)

    // Ownership comes from Electron, never a renderer-supplied argument.
    return service.open(target, String(event.sender.id))
  })
  ipcMain.handle(ATUM_CONSUMER_FILES_IPC_CHANNELS.capture, guarded((token: unknown) => service.capture(token)))
  ipcMain.handle(ATUM_CONSUMER_FILES_IPC_CHANNELS.openNative, guarded((target: unknown) => service.openNative(target)))
  ipcMain.handle(ATUM_CONSUMER_FILES_IPC_CHANNELS.reveal, guarded((target: unknown) => service.reveal(target)))
  ipcMain.handle(
    ATUM_CONSUMER_FILES_IPC_CHANNELS.rename,
    guarded((target: unknown, name: unknown) => service.rename(target, name))
  )
  ipcMain.handle(ATUM_CONSUMER_FILES_IPC_CHANNELS.trash, guarded((target: unknown) => service.trash(target)))
  ipcMain.handle(
    ATUM_CONSUMER_FILES_IPC_CHANNELS.mkdir,
    guarded((directory: unknown, name: unknown) => service.mkdir(directory, name))
  )
  ipcMain.handle(
    ATUM_CONSUMER_FILES_IPC_CHANNELS.thumbnail,
    guarded((target: unknown, size: unknown) => service.thumbnail(target, size))
  )
  ipcMain.handle(ATUM_CONSUMER_FILES_IPC_CHANNELS.releaseView, guarded((token: unknown) => service.releaseView(token)))
}
