import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  isMatrixFolderAccessRowId,
  MATRIX_FOLDER_ACCESS_IPC,
  MATRIX_STANDARD_FOLDERS,
  type MatrixFolderAccessChoices,
  type MatrixFolderAccessRow,
  type MatrixFolderAccessView,
  type MatrixFolderMacState,
  type MatrixStandardFolder
} from '../../shared/matrix-folder-access'

/**
 * The owner's folder choices for this account, and the one place that asks macOS for them.
 *
 * macOS facts this is built on (session log 2026-11-07-first-run-folder-access.md):
 * - Desktop, Documents, Downloads and iCloud Drive are each protected by their own TCC prompt,
 *   shown the first time the app (or a child it is responsible for, such as Hermes) lists them.
 * - Full Disk Access cannot be granted per folder or requested by an app; it stays on the
 *   Messages row of the first-run card, which opens System Settings once.
 * - A folder chosen in the Open panel carries implied consent, so "Add a folder…" never prompts.
 *
 * Nothing here touches a protected folder except `apply`, which runs only from the owner's own
 * Continue or switch, and then lists only the folders that call turns on. `read` never lists a
 * protected folder: even a probe can raise a prompt.
 *
 * Every operation is bound to the account that was current when it was asked for (not when it
 * reaches the front of the queue): its record, its policy file and its prompts. If the account
 * changes before or while it runs, it is dropped before anything is written.
 *
 * Fail closed. The stored record and the tools' policy file are written together. A record that
 * is missing or damaged is rebuilt from the policy file (what the tools enforce now). Only an
 * account with neither (a new or upgraded account) starts with everything shared. When the
 * record can't be trusted and the policy file is damaged too, the choices are unavailable: the
 * tools pause every file read (atum_source_policy.py), cloud commands keep the standard folders
 * closed, and the next choice the owner makes is saved as the new record.
 *
 * Enforcement model (session log, "Review r2 fixes"): macOS TCC is the real boundary. An unticked
 * standard folder is never asked for, so macOS refuses it to the whole app, terminal and Python
 * included, unless the owner grants Full Disk Access. These checks are defence in depth.
 */

const STORE_VERSION = 1
const STORE_PREFIX = 'matrix-folder-access.'
const ACCOUNT_KEY = /^[0-9a-f]{64}$/u
const MAX_ADDED = 64
/** Removed folders stay closed; this bounds the record, it never reopens one. */
const MAX_REMOVED = 1024

export interface FolderAccessStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface FolderAccessScope {
  accountKey: string
  generation: number
}

export interface FolderAccessDependencies {
  storage: FolderAccessStorage
  scope(): FolderAccessScope | null
  platform: NodeJS.Platform
  home: string
  /** Lists a folder's top level. On a protected folder this is what raises the macOS prompt. */
  list(directory: string): Promise<unknown>
  /** A lookup in an unprotected parent only (for example whether iCloud Drive is set up). */
  exists(file: string): boolean
  /** The macOS folder picker. Resolves null when the owner cancels. */
  pick(): Promise<string | null>
  /** The Hermes tool policy file beside this account's source policy. */
  policyFile(accountKey: string): string | null
}

interface StoredStandard {
  shared: boolean
  mac: MatrixFolderMacState
}

interface StoredAdded {
  n: number
  path: string
}

interface StoredRecord {
  version: typeof STORE_VERSION
  standard: Record<MatrixStandardFolder, StoredStandard>
  added: StoredAdded[]
  /** Added folders the owner removed: closed to the tools until picked again. */
  removed?: string[]
}

interface Loaded {
  record: StoredRecord
  /** Neither the record nor the policy file can be trusted: the tools pause file reads. */
  unavailable: boolean
}

/** Non-secret projection read by the Hermes file tools before every read (atum_source_policy.py). */
export interface FolderAccessPolicyFile {
  version: 1
  /** Folders the owner chose not to share, standard and removed. Tools refuse paths inside them. */
  blocked: string[]
  /**
   * Folders the owner shares, standard and added. The most specific folder decides, so a folder
   * added inside a closed one is shared, and a removed one inside a shared one is closed.
   */
  shared: string[]
  /** The owner's choices are unknown: the tools refuse every file read until rewritten. */
  unavailable?: true
}

const MAC_STATES = new Set<MatrixFolderMacState>(['not-asked', 'granted', 'denied', 'absent'])

function fresh(): StoredRecord {
  return {
    version: STORE_VERSION,
    standard: {
      desktop: { shared: true, mac: 'not-asked' },
      documents: { shared: true, mac: 'not-asked' },
      downloads: { shared: true, mac: 'not-asked' },
      icloud: { shared: true, mac: 'not-asked' }
    },
    added: []
  }
}

/** The stored record, or null when it exists but can't be trusted. */
function parse(value: string): StoredRecord | null {
  try {
    const row = JSON.parse(value) as Partial<StoredRecord> | null

    if (!row || row.version !== STORE_VERSION || !row.standard || typeof row.standard !== 'object' || !Array.isArray(row.added)) {
      return null
    }

    const next = fresh()

    for (const kind of MATRIX_STANDARD_FOLDERS) {
      const saved = (row.standard as Record<string, Partial<StoredStandard> | undefined>)[kind]

      if (!saved || typeof saved.shared !== 'boolean' || !MAC_STATES.has(saved.mac as MatrixFolderMacState)) {
        return null
      }

      next.standard[kind] = { shared: saved.shared, mac: saved.mac as MatrixFolderMacState }
    }

    const added = row.added.filter(
      (item): item is StoredAdded =>
        Boolean(item) &&
        Number.isSafeInteger(item.n) &&
        item.n >= 0 &&
        item.n < 10_000 &&
        typeof item.path === 'string' &&
        path.isAbsolute(item.path)
    )

    const removed = row.removed ?? []

    if (
      added.length !== row.added.length ||
      added.length > MAX_ADDED ||
      !Array.isArray(removed) ||
      removed.length > MAX_REMOVED ||
      !removed.every(item => typeof item === 'string' && path.isAbsolute(item))
    ) {
      return null
    }

    next.added = added
    next.removed = removed

    return next
  } catch {
    return null
  }
}

function macState(error: unknown): MatrixFolderMacState {
  const code = String((error as { code?: unknown } | null)?.code ?? '')

  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return 'absent'
  }

  return code === 'EPERM' || code === 'EACCES' ? 'denied' : 'not-asked'
}

/** Absolute standard folder paths on this Mac. */
export function standardFolderPaths(home: string): Record<MatrixStandardFolder, string> {
  return {
    desktop: path.join(home, 'Desktop'),
    documents: path.join(home, 'Documents'),
    downloads: path.join(home, 'Downloads'),
    icloud: path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
  }
}

/** `~/…` for paths in the home folder: what the assistant is told, never sent to the renderer. */
export function displayFolderPath(home: string, file: string): string {
  const relative = path.relative(home, file)

  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? `~/${relative}` : file
}

export class MatrixFolderAccess {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: FolderAccessDependencies) {}

  read(): MatrixFolderAccessView {
    const scope = this.validScope()

    if (this.deps.platform !== 'darwin' || !scope) {
      return { platform: 'unsupported', folders: [] }
    }

    return this.view(this.load(scope).record)
  }

  /**
   * Saves the choices, then lets macOS ask for each standard folder this call turns on (`true`),
   * one at a time. Folders the call leaves out are never listed, so one Settings switch asks only
   * for its own folder; first run's Continue names every row.
   */
  apply(choices: MatrixFolderAccessChoices): Promise<MatrixFolderAccessView> {
    return this.bound(async scope => {
      const { record } = this.load(scope)
      const paths = standardFolderPaths(this.deps.home)

      for (const kind of MATRIX_STANDARD_FOLDERS) {
        if (typeof choices[kind] === 'boolean') {
          record.standard[kind].shared = choices[kind]
        }
      }

      for (const item of record.added.filter(each => choices[`added:${each.n}`] === false)) {
        this.revoke(record, item)
      }

      // Close before asking: a skipped folder is blocked for the tools even if a prompt hangs.
      this.save(scope, record)

      for (const kind of MATRIX_STANDARD_FOLDERS) {
        const folder = record.standard[kind]

        if (choices[kind] !== true || !folder.shared || folder.mac === 'granted' || !this.offered(kind)) {
          continue
        }

        // One at a time: macOS shows one prompt per folder and this waits for its answer.
        try {
          await this.deps.list(paths[kind])
          folder.mac = 'granted'
        } catch (error) {
          folder.mac = macState(error)
        }

        // The owner may have switched accounts while macOS was asking: drop the answer.
        this.save(scope, record)
      }

      return this.view(record)
    })
  }

  add(): Promise<MatrixFolderAccessView> {
    return this.bound(async scope => {
      const picked = await this.deps.pick()

      // A picker opened for one account never saves into another.
      this.assertCurrent(scope)
      const { record } = this.load(scope)

      if (picked && path.isAbsolute(picked) && !record.added.some(item => item.path === picked)) {
        if (record.added.length >= MAX_ADDED) {
          throw new Error('matrix_folder_access_full')
        }

        const n = record.added.reduce((max, item) => Math.max(max, item.n + 1), 0)
        record.added.push({ n, path: picked })
        record.removed = (record.removed ?? []).filter(file => file !== picked)
        this.save(scope, record)
      }

      return this.view(record)
    })
  }

  remove(id: string): Promise<MatrixFolderAccessView> {
    return this.bound(async scope => {
      const { record } = this.load(scope)

      // Removing revokes: the folder is closed to the tools, not merely forgotten. (No
      // security-scoped bookmark is kept for an added folder, so there is none to drop.)
      for (const item of record.added.filter(each => `added:${each.n}` === id)) {
        this.revoke(record, item)
      }

      this.save(scope, record)

      return this.view(record)
    })
  }

  /** What the assistant is told at first learning; display paths only. */
  awareness(): { shared: string[]; skipped: string[] } {
    const scope = this.validScope()

    if (this.deps.platform !== 'darwin' || !scope) {
      return { shared: [], skipped: [] }
    }

    const policy = this.policy(this.load(scope).record)

    return {
      shared: policy.shared.map(file => displayFolderPath(this.deps.home, file)),
      skipped: policy.blocked.map(file => displayFolderPath(this.deps.home, file))
    }
  }

  /** Refreshes the tools' file at launch; a failure leaves the previous file in place. */
  writePolicy(): void {
    const scope = this.validScope()

    if (this.deps.platform === 'darwin' && scope) {
      const { record, unavailable } = this.load(scope)
      this.writePolicyFile(scope.accountKey, record, unavailable)
    }
  }

  /**
   * The folders closed for the current account, for the device sandbox (cloud-to-Mac commands run
   * under Seatbelt, which denies them at the kernel: `device/protected-paths.ts`). iCloud Drive
   * covers every app's iCloud folder beside it. A folder added inside a closed one stays closed on
   * that route only through `sharedInsideClosedFolders`, which the sandbox carves out.
   */
  closedFolders(): string[] {
    const scope = this.validScope()

    if (this.deps.platform !== 'darwin' || !scope) {
      return []
    }

    const icloud = standardFolderPaths(this.deps.home).icloud

    return this.policy(this.load(scope).record).blocked.flatMap(file => (file === icloud ? [file, path.dirname(file)] : [file]))
  }

  /** Folders the owner shared inside a closed one: the device sandbox lets commands reach them too. */
  sharedInsideClosedFolders(): string[] {
    const scope = this.validScope()

    if (this.deps.platform !== 'darwin' || !scope) {
      return []
    }

    const { record, unavailable } = this.load(scope)

    if (unavailable) {
      return []
    }

    const closed = this.closedFolders()

    return this.policy(record).shared.filter(file => closed.some(folder => file.startsWith(`${folder}${path.sep}`)))
  }

  private offered(kind: MatrixStandardFolder): boolean {
    // iCloud Drive is offered only when it is set up. Its parent lookup is in ~/Library, which
    // is not protected, so checking it raises no prompt.
    return kind !== 'icloud' || this.deps.exists(path.join(this.deps.home, 'Library', 'Mobile Documents'))
  }

  private view(record: StoredRecord): MatrixFolderAccessView {
    const folders: MatrixFolderAccessRow[] = MATRIX_STANDARD_FOLDERS.filter(
      kind => this.offered(kind) && record.standard[kind].mac !== 'absent'
    ).map(kind => ({ id: kind, kind, shared: record.standard[kind].shared, mac: record.standard[kind].mac }))

    for (const item of record.added) {
      folders.push({
        id: `added:${item.n}`,
        kind: 'added',
        name: path.basename(item.path) || item.path,
        shared: true,
        mac: 'granted'
      })
    }

    return { platform: 'macos', folders }
  }

  private policy(record: StoredRecord): FolderAccessPolicyFile {
    const paths = standardFolderPaths(this.deps.home)
    const blocked: string[] = []
    const shared: string[] = []

    for (const kind of MATRIX_STANDARD_FOLDERS) {
      if (record.standard[kind].mac === 'absent' || !this.offered(kind)) {
        continue
      }

      if (record.standard[kind].shared) {
        shared.push(paths[kind])
      } else {
        blocked.push(paths[kind])
      }
    }

    shared.push(...record.added.map(item => item.path))
    blocked.push(...(record.removed ?? []).filter(file => !shared.includes(file)))

    return { version: 1, blocked, shared }
  }

  private revoke(record: StoredRecord, item: StoredAdded): void {
    const removed = (record.removed ?? []).filter(file => file !== item.path)

    if (removed.length >= MAX_REMOVED) {
      throw new Error('matrix_folder_access_full')
    }

    record.added = record.added.filter(each => each.n !== item.n)
    record.removed = [...removed, item.path]
  }

  /** Nothing is written unless the account the operation started for is still the current one. */
  private save(scope: FolderAccessScope, record: StoredRecord): void {
    this.assertCurrent(scope)
    this.deps.storage.setItem(`${STORE_PREFIX}${scope.accountKey}`, JSON.stringify(record))

    try {
      this.writePolicyFile(scope.accountKey, record)
    } catch (error) {
      // An older, possibly more open, file must not outlive this choice: without one the tools
      // pause every file read until the next write lands.
      try {
        const file = this.deps.policyFile(scope.accountKey)

        if (file) {
          unlinkSync(file)
        }
      } catch {
        // Nothing to remove.
      }

      throw error
    }
  }

  private assertCurrent(scope: FolderAccessScope): void {
    const current = this.validScope()

    if (!current || current.accountKey !== scope.accountKey || current.generation !== scope.generation) {
      throw new Error('matrix_folder_access_stale')
    }
  }

  private writePolicyFile(accountKey: string, record: StoredRecord, unavailable = false): void {
    const file = this.deps.policyFile(accountKey)

    if (!file || !path.isAbsolute(file)) {
      return
    }

    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomUUID()}.tmp`
    const projection: FolderAccessPolicyFile = unavailable ? { ...this.policy(record), unavailable: true } : this.policy(record)
    writeFileSync(temporary, `${JSON.stringify(projection)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  }

  private load(scope: FolderAccessScope): Loaded {
    let stored: string | null | undefined

    try {
      stored = this.deps.storage.getItem(`${STORE_PREFIX}${scope.accountKey}`)
    } catch {
      stored = undefined
    }

    const record = typeof stored === 'string' ? parse(stored) : null

    if (record) {
      return { record, unavailable: false }
    }

    const enforced = this.enforced(scope.accountKey)

    if (enforced !== 'missing' && enforced !== 'damaged') {
      return { record: enforced, unavailable: false }
    }

    // No record and no policy file: a new or upgraded account, everything shared.
    if (stored === null && enforced === 'missing') {
      return { record: fresh(), unavailable: false }
    }

    return { record: this.allClosed(), unavailable: true }
  }

  private allClosed(): StoredRecord {
    const record = fresh()

    for (const kind of MATRIX_STANDARD_FOLDERS) {
      record.standard[kind].shared = false
    }

    return record
  }

  /**
   * The choices the tools enforce now, rebuilt from this account's policy file: `missing` when
   * there is none, `damaged` when it can't be read or says the choices are unavailable.
   */
  private enforced(accountKey: string): StoredRecord | 'missing' | 'damaged' {
    const paths = standardFolderPaths(this.deps.home)
    let policy: Partial<FolderAccessPolicyFile> | null

    try {
      const file = this.deps.policyFile(accountKey)

      if (!file) {
        return 'missing'
      }

      policy = JSON.parse(readFileSync(file, 'utf8')) as Partial<FolderAccessPolicyFile> | null
    } catch (error) {
      return (error as { code?: unknown } | null)?.code === 'ENOENT' ? 'missing' : 'damaged'
    }

    const list = (value: unknown) =>
      Array.isArray(value) && value.every(item => typeof item === 'string' && path.isAbsolute(item)) ? (value as string[]) : null

    const blocked = policy?.version === 1 && !policy.unavailable ? list(policy.blocked) : null
    const shared = policy?.version === 1 && !policy.unavailable ? list(policy.shared ?? []) : null

    if (!blocked || !shared) {
      return 'damaged'
    }

    const record = fresh()
    const standard = new Set<string>(Object.values(paths))

    for (const kind of MATRIX_STANDARD_FOLDERS) {
      record.standard[kind].shared = !blocked.includes(paths[kind])
    }

    record.added = shared.filter(file => !standard.has(file)).slice(0, MAX_ADDED).map((file, n) => ({ n, path: file }))
    record.removed = blocked.filter(file => !standard.has(file)).slice(0, MAX_REMOVED)

    return record
  }

  private requireScope(): FolderAccessScope {
    const scope = this.validScope()

    if (!scope || this.deps.platform !== 'darwin') {
      throw new Error('matrix_folder_access_unavailable')
    }

    return scope
  }

  private validScope(): FolderAccessScope | null {
    try {
      const scope = this.deps.scope()

      return scope && ACCOUNT_KEY.test(scope.accountKey) && Number.isSafeInteger(scope.generation) ? scope : null
    } catch {
      return null
    }
  }

  /**
   * Runs `work` after the operations queued before it, bound to the account current NOW: a call
   * made for one account never runs against another that became current while it waited.
   */
  private bound<T>(work: (scope: FolderAccessScope) => Promise<T>): Promise<T> {
    let scope: FolderAccessScope

    try {
      scope = this.requireScope()
    } catch (error) {
      return Promise.reject(error)
    }

    const run = () => {
      this.assertCurrent(scope)

      return work(scope)
    }

    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)

    return next
  }
}

/** The tools' folder file sits beside the source policy so Hermes needs no new setting. */
export function folderAccessPolicyFile(sourcePolicyFile: string): string {
  return sourcePolicyFile.replace(/\.json$/u, '') + '.folders.json'
}

export interface MatrixFolderAccessIpcDependencies {
  assertTrusted(event: IpcMainInvokeEvent): void
  access: Pick<MatrixFolderAccess, 'read' | 'apply' | 'add' | 'remove'>
}

function validChoices(value: unknown): value is MatrixFolderAccessChoices {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const entries = Object.entries(value as Record<string, unknown>)

  return (
    entries.length <= MAX_ADDED + MATRIX_STANDARD_FOLDERS.length &&
    entries.every(([id, enabled]) => isMatrixFolderAccessRowId(id) && typeof enabled === 'boolean')
  )
}

/** Trusted Settings and first-run UI only; apps and SDK hosts never see folder choices. */
export function registerMatrixFolderAccessIpc(
  ipc: Pick<IpcMain, 'handle'>,
  deps: MatrixFolderAccessIpcDependencies
): void {
  ipc.handle(MATRIX_FOLDER_ACCESS_IPC.read, (event, ...args: unknown[]) => {
    deps.assertTrusted(event)

    if (args.length !== 0) {
      throw new Error('matrix_folder_access_invalid_request')
    }

    return deps.access.read()
  })
  ipc.handle(MATRIX_FOLDER_ACCESS_IPC.apply, (event, choices: unknown, ...args: unknown[]) => {
    deps.assertTrusted(event)

    if (args.length !== 0 || !validChoices(choices)) {
      throw new Error('matrix_folder_access_invalid_request')
    }

    return deps.access.apply(choices)
  })
  ipc.handle(MATRIX_FOLDER_ACCESS_IPC.add, (event, ...args: unknown[]) => {
    deps.assertTrusted(event)

    if (args.length !== 0) {
      throw new Error('matrix_folder_access_invalid_request')
    }

    return deps.access.add()
  })
  ipc.handle(MATRIX_FOLDER_ACCESS_IPC.remove, (event, id: unknown, ...args: unknown[]) => {
    deps.assertTrusted(event)

    if (args.length !== 0 || !isMatrixFolderAccessRowId(id) || !id.startsWith('added:')) {
      throw new Error('matrix_folder_access_invalid_request')
    }

    return deps.access.remove(id)
  })
}
