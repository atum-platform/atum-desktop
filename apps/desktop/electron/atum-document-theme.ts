import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { documentKeyIsWithin, normalizeDocumentKey, reparentDocumentKey } from '../shared/atum-office/document-identity'
import {
  DOCUMENT_THEME_SCHEMA_VERSION,
  type DocumentThemeSelection,
  parseDocumentThemeSelection,
  type ResolvedDocumentTheme,
  resolveDocumentTheme
} from '../shared/atum-office/document-theme'

import type { FilesystemAccountEnvelope } from './atum-filesystem-capability'
import type { AccountScopedPaths } from './atum-messaging/account-roots'

/**
 * Durable, account-private storage for each document's chosen theme.
 *
 * Three properties matter more than the feature itself.
 *
 * **It is cosmetic, so it fails soft.** A corrupt, truncated or hand-edited
 * store must never fail an export, block a sign-out, or throw into a render
 * path. Every read falls back to the inferred default and records a failure
 * code for diagnostics. This follows the house split: security-relevant state
 * (the account marker, the credential vault) throws a coded error, while
 * presentation state falls back the way window and zoom state already do.
 *
 * **Isolation is structural.** The file lives under the active account's
 * `accountKey` directory, so a different account reads a different file. Reads
 * additionally refuse an account id that is not the active one, so a stale
 * caller cannot pull another account's choices through a live store.
 *
 * **Account generation is deliberately not fenced here.** Generation is a
 * revocation epoch that increments on *every* sign-in, including signing back
 * into the same account. Folding it into identity or into the read fence would
 * silently discard a person's themes each time they signed in. The liveness
 * fence that genuinely matters already sits upstream in the lease provider,
 * which throws `CAPABILITY_STALE` before any of this is reached.
 */

interface StoredThemeEntry {
  themeId: string
  overrides?: unknown
  revision: number
}

interface StoredDocumentThemeFile {
  version: typeof DOCUMENT_THEME_SCHEMA_VERSION
  /**
   * Store-wide monotonic counter handing out per-document revisions.
   *
   * A per-row counter would restart at 1 after the row is cleared, so
   * `set book` → `clear` → `set note` would mint revision 1 twice for
   * different content and an export that pinned the first could not tell the
   * theme had changed underneath it. Because the counter only ever climbs, a
   * pinned revision is unique for the life of the store. Derived on read when
   * absent, so a file written before this field existed still loads.
   */
  nextRevision: number
  entries: Record<string, StoredThemeEntry>
}

/** Revisions are compared and incremented, so they must stay exact integers. */
function safeRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function emptyFile(): StoredDocumentThemeFile {
  // Null prototype: a document may legitimately be named `__proto__`, and on a
  // plain object that assignment hits the Object.prototype setter instead of
  // creating an own property, so the row would vanish on serialisation.
  // JSON.stringify treats a null-prototype object identically.
  return {
    entries: Object.create(null) as Record<string, StoredThemeEntry>,
    nextRevision: 1,
    version: DOCUMENT_THEME_SCHEMA_VERSION
  }
}

/**
 * Why a file could not be used. `corrupt` may be replaced by the next write —
 * that is how a damaged store repairs itself. `unsupported-version` may NOT:
 * it was written by a build that knows more than this one, and overwriting it
 * would destroy metadata this build cannot even read.
 */
export type DocumentThemeReadOutcome =
  | { kind: 'ok'; file: StoredDocumentThemeFile }
  | { kind: 'corrupt' }
  | { kind: 'unsupported-version' }

/**
 * The single place a future schema version slots in.
 *
 * Version 1 is the first shape, so there is nothing to migrate forward yet.
 * Anything else — an older version we have not written a migration for, a
 * newer version written by a future build, or a malformed body — returns null,
 * and the caller starts from empty rather than guessing at partial data. A
 * newer version is deliberately *not* an error: an older build must not corrupt
 * a store it does not understand, it must simply decline to use it.
 */
export function migrateStoredDocumentThemeFile(parsed: unknown): DocumentThemeReadOutcome {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'corrupt' }
  }

  const candidate = parsed as { version?: unknown; entries?: unknown; nextRevision?: unknown }

  if (candidate.version !== DOCUMENT_THEME_SCHEMA_VERSION) {
    // A version we recognise as a version but cannot read is preserved, not
    // replaced; anything else is simply damaged.
    return typeof candidate.version === 'number' && Number.isInteger(candidate.version) && candidate.version > 0
      ? { kind: 'unsupported-version' }
      : { kind: 'corrupt' }
  }

  if (!candidate.entries || typeof candidate.entries !== 'object' || Array.isArray(candidate.entries)) {
    return { kind: 'corrupt' }
  }

  const entries: Record<string, StoredThemeEntry> = Object.create(null)
  let highest = 0

  for (const [key, value] of Object.entries(candidate.entries as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue
    }

    const entry = value as { themeId?: unknown; overrides?: unknown; revision?: unknown }
    // Re-normalise on read: a key written by an older build, by a different
    // platform, or by hand may not be in canonical form.
    const normalizedKey = normalizeDocumentKey(key)

    if (!normalizedKey || typeof entry.themeId !== 'string') {
      continue
    }

    const revision = safeRevision(entry.revision)
    highest = Math.max(highest, revision)
    entries[normalizedKey] = { overrides: entry.overrides, revision, themeId: entry.themeId }
  }

  // Repair a missing or under-run counter so a reissued revision can never
  // collide with one an export already pinned.
  const nextRevision = Math.max(safeRevision(candidate.nextRevision), highest + 1)

  return { file: { entries, nextRevision, version: DOCUMENT_THEME_SCHEMA_VERSION }, kind: 'ok' }
}

export interface DocumentThemeTarget {
  account: FilesystemAccountEnvelope
  workspaceRelativePath: string
}

export class AtumDocumentThemeStore {
  private active: { accountId: string; paths: AccountScopedPaths } | null = null

  private cache: StoredDocumentThemeFile | null = null

  private failureCode: string | null = null

  /** Set when the file on disk was written by a build that knows a newer schema. */
  private preserveOnDisk = false

  /** Whether the most recent mutation reached disk (or needed no write). */
  private mutationDurable = true

  /** Operation-scoped, unlike `lastFailureCode`, which remembers earlier failures. */
  get lastMutationDurable(): boolean {
    return this.mutationDurable
  }

  /** Last read/write failure, for diagnostics. Never thrown at a caller. */
  get lastFailureCode(): string | null {
    return this.failureCode
  }

  activateAccount(input: { accountId: string; generation: number; paths: AccountScopedPaths }): void {
    if (!input.accountId || !input.paths?.documentThemes) {
      throw new Error('DOCUMENT_THEME_INVALID_ACCOUNT')
    }

    this.active = { accountId: input.accountId, paths: input.paths }
    this.cache = null
    this.failureCode = null
    this.preserveOnDisk = false
  }

  /**
   * Idempotent by design: a store that threw on an unknown envelope could block
   * a sign-out, and no cosmetic cache is worth that.
   */
  revokeAccount(account: FilesystemAccountEnvelope): void {
    if (!this.active || this.active.accountId !== account.accountId) {
      return
    }

    this.active = null
    this.cache = null
  }

  /** Never throws. An unknown document, a foreign account or a broken store all yield the default. */
  resolveFor(target: DocumentThemeTarget): ResolvedDocumentTheme {
    const key = this.keyFor(target)

    if (!key) {
      return resolveDocumentTheme(null)
    }

    const entry = this.read().entries[key]

    if (!entry) {
      return resolveDocumentTheme(null)
    }

    // A stored id that has since left the catalogue parses to null, so a
    // removed theme degrades to the default instead of failing the export.
    const selection = parseDocumentThemeSelection(entry)

    return selection ? resolveDocumentTheme(selection, entry.revision) : resolveDocumentTheme(null)
  }

  /**
   * Persist an explicit choice.
   *
   * Throws on anything the caller can fix — no account, a foreign account, an
   * unusable path, an off-catalogue selection — because silently discarding a
   * person's choice is worse than surfacing an error. A *disk* failure is not
   * one of those: the choice still applies for this session and only durability
   * is lost, so it is reported through `lastFailureCode` rather than thrown,
   * keeping the promise that this store never fails a caller's real work.
   */
  setFor(target: DocumentThemeTarget, selection: DocumentThemeSelection): ResolvedDocumentTheme {
    this.mutationDurable = true
    const key = this.requireKey(target)
    const parsed = parseDocumentThemeSelection(selection)

    if (!parsed) {
      throw new Error('DOCUMENT_THEME_INVALID_SELECTION')
    }

    const file = this.read()
    const revision = file.nextRevision
    file.nextRevision = revision + 1

    file.entries[key] = parsed.overrides
      ? { overrides: parsed.overrides, revision, themeId: parsed.themeId }
      : { revision, themeId: parsed.themeId }

    this.write(file)

    return resolveDocumentTheme(parsed, revision)
  }

  /** Drop an explicit choice so the document goes back to the inferred default. */
  clearFor(target: DocumentThemeTarget): void {
    this.mutationDurable = true
    const key = this.requireKey(target)
    const file = this.read()

    if (!Object.hasOwn(file.entries, key)) {
      return
    }

    delete file.entries[key]
    this.write(file)
  }

  /**
   * Follow a rename or move. Handles a whole subtree so renaming a folder keeps
   * the themes of every document inside it. A destination that already has a
   * choice keeps its own — an explicit choice at the destination outranks one
   * inherited from the source path.
   */
  noteRename(input: { account: FilesystemAccountEnvelope; from: string; to: string }): void {
    this.mutationDurable = true
    const from = this.keyFor({ account: input.account, workspaceRelativePath: input.from })
    const to = this.keyFor({ account: input.account, workspaceRelativePath: input.to })

    if (!from || !to || from === to) {
      return
    }

    const file = this.read()
    let changed = false

    for (const key of Object.keys(file.entries)) {
      if (!documentKeyIsWithin(from, key)) {
        continue
      }

      const moved = reparentDocumentKey(key, from, to)
      const entry = file.entries[key]!
      delete file.entries[key]

      if (!Object.hasOwn(file.entries, moved)) {
        file.entries[moved] = entry
      }

      changed = true
    }

    if (changed) {
      this.write(file)
    }
  }

  /** Forget a deleted document's choice, subtree included. */
  noteDelete(target: DocumentThemeTarget): void {
    this.mutationDurable = true
    const key = this.keyFor(target)

    if (!key) {
      return
    }

    const file = this.read()
    let changed = false

    for (const existing of Object.keys(file.entries)) {
      if (documentKeyIsWithin(key, existing)) {
        delete file.entries[existing]
        changed = true
      }
    }

    if (changed) {
      this.write(file)
    }
  }

  private keyFor(target: DocumentThemeTarget): string | null {
    if (!this.active || this.active.accountId !== target.account?.accountId) {
      return null
    }

    return normalizeDocumentKey(target.workspaceRelativePath)
  }

  private requireKey(target: DocumentThemeTarget): string {
    if (!this.active) {
      throw new Error('DOCUMENT_THEME_NO_ACCOUNT')
    }

    if (this.active.accountId !== target.account?.accountId) {
      throw new Error('DOCUMENT_THEME_FOREIGN_ACCOUNT')
    }

    const key = normalizeDocumentKey(target.workspaceRelativePath)

    if (!key) {
      throw new Error('DOCUMENT_THEME_NO_IDENTITY')
    }

    return key
  }

  private read(): StoredDocumentThemeFile {
    if (this.cache) {
      return this.cache
    }

    if (!this.active) {
      return emptyFile()
    }

    let raw: string

    try {
      raw = readFileSync(this.active.paths.documentThemes, 'utf8')
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''

      if (code !== 'ENOENT') {
        this.failureCode = 'DOCUMENT_THEME_READ_FAILED'
      }

      this.cache = emptyFile()

      return this.cache
    }

    let outcome: DocumentThemeReadOutcome

    try {
      outcome = migrateStoredDocumentThemeFile(JSON.parse(raw))
    } catch {
      outcome = { kind: 'corrupt' }
    }

    if (outcome.kind === 'ok') {
      this.failureCode = null
      this.preserveOnDisk = false
      this.cache = outcome.file

      return this.cache
    }

    // Both cases resolve to the default, but they differ on what a later write
    // may do: a damaged current-version file is replaced (that is how the store
    // repairs itself), while a newer build's file is never overwritten, because
    // this build cannot read what it would be destroying.
    this.preserveOnDisk = outcome.kind === 'unsupported-version'
    this.failureCode =
      outcome.kind === 'unsupported-version' ? 'DOCUMENT_THEME_UNSUPPORTED_VERSION' : 'DOCUMENT_THEME_CORRUPT'
    this.cache = emptyFile()

    return this.cache
  }

  private write(file: StoredDocumentThemeFile): void {
    if (!this.active) {
      throw new Error('DOCUMENT_THEME_NO_ACCOUNT')
    }

    this.cache = file
    const target = this.active.paths.documentThemes

    if (this.preserveOnDisk) {
      // The choice still applies for this session; only durability is refused,
      // and refusing is the point — the file belongs to a newer build.
      this.failureCode = 'DOCUMENT_THEME_UNSUPPORTED_VERSION'
      this.mutationDurable = false

      return
    }

    // A unique name per attempt, so a crashed writer's leftover cannot be
    // picked up by the next one and two writers cannot collide on one path.
    const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`

    try {
      mkdirSync(dirname(target), { mode: 0o700, recursive: true })
      chmodSync(dirname(target), 0o700)
      writeFileSync(temporary, JSON.stringify(file), { mode: 0o600 })
      chmodSync(temporary, 0o600)
      renameSync(temporary, target)
      chmodSync(target, 0o600)
      this.failureCode = null
    } catch {
      // The in-memory choice still applies for this session; only durability is
      // lost, and a cosmetic preference is not worth failing a caller over.
      this.failureCode = 'DOCUMENT_THEME_WRITE_FAILED'
      this.mutationDurable = false

      try {
        unlinkSync(temporary)
      } catch {
        // Best effort: a leftover temp is inert because the name is unique.
      }
    }
  }
}
