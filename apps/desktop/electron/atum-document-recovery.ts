import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

import type {
  AtumDocumentRecoveryDiscardResult,
  AtumDocumentRecoveryDraft,
  AtumDocumentRecoveryReadResult,
  AtumDocumentRecoveryWriteInput,
  AtumDocumentRecoveryWriteResult
} from '../shared/atum-office/document-recovery'

import type { FilesystemAccountEnvelope } from './atum-filesystem-capability'
import type { DocumentAccountAuthority } from './workspace-text-file-lease'

export type {
  AtumDocumentRecoveryDiscardResult as DocumentRecoveryDiscardResult,
  AtumDocumentRecoveryDraft as DocumentRecoveryDraft,
  AtumDocumentRecoveryReadResult as DocumentRecoveryReadResult,
  AtumDocumentRecoveryWriteResult as DocumentRecoveryWriteResult
} from '../shared/atum-office/document-recovery'

/** The journal is intentionally bounded; a full journal never evicts a draft. */
export const DOCUMENT_RECOVERY_MAX_RECORD_BYTES = 1024 * 1024
export const DOCUMENT_RECOVERY_MAX_TOTAL_BYTES = 16 * 1024 * 1024
export const DOCUMENT_RECOVERY_MAX_RECORDS = 128

const RECORD_VERSION = 1
const RECORD_NAME = /^[a-f0-9]{64}\.json$/u

/**
 * A main-owned, live document identity. `fileRef` is resolved before this type
 * reaches the journal; renderer paths and account claims are never accepted.
 */
export interface DocumentRecoveryLease {
  account: FilesystemAccountEnvelope
  /** Main-derived physical identity including birth time; independent of path. */
  fileIdentity: string
  /** Retained only as recovery context; it is never used to address the filesystem. */
  workspaceRelativePath: string
}

interface SerializedDraft extends AtumDocumentRecoveryDraft {
  accountId: string
  version: 1
  fileIdentities: string[]
}

export interface AtumDocumentRecoveryJournalOptions {
  /** Resolves only from main-owned account roots after authority is checked. */
  journalRootFor: (account: FilesystemAccountEnvelope) => string
  maxRecordBytes?: number
  maxRecords?: number
  maxTotalBytes?: number
}

/**
 * Atomic, account-private snapshots for unsaved workspace documents.
 *
 * The journal deliberately has no listing API. A renderer can recover only the
 * record for a currently authorized, lease-resolved document, which prevents
 * another account from learning filenames, excerpts, or draft counts.
 */
export class AtumDocumentRecoveryJournal {
  private readonly maxRecordBytes: number
  private readonly maxRecords: number
  private readonly maxTotalBytes: number

  constructor(
    private readonly authority: DocumentAccountAuthority,
    private readonly resolveLease: (fileRef: string) => DocumentRecoveryLease,
    private readonly options: AtumDocumentRecoveryJournalOptions
  ) {
    this.maxRecordBytes = positiveLimit(options.maxRecordBytes, DOCUMENT_RECOVERY_MAX_RECORD_BYTES)
    this.maxRecords = positiveLimit(options.maxRecords, DOCUMENT_RECOVERY_MAX_RECORDS)
    this.maxTotalBytes = positiveLimit(options.maxTotalBytes, DOCUMENT_RECOVERY_MAX_TOTAL_BYTES)
  }

  async read(fileRef: string): Promise<AtumDocumentRecoveryReadResult> {
    const lease = this.requireCurrentLease(fileRef)
    const found = this.findRecord(lease)
    const record = found ? publicRecord(found.record, lease.workspaceRelativePath) : null
    this.assertStillCurrent(lease)

    return record ? { outcome: 'present', record } : { outcome: 'absent', record: null }
  }

  /**
   * Compare-and-swap journal write. Callers must pass the previously observed
   * journal revision, or `null` after an absent read, so two document windows
   * cannot overwrite each other's recoverable draft.
   */
  async write(fileRef: string, input: AtumDocumentRecoveryWriteInput): Promise<AtumDocumentRecoveryWriteResult> {
    const lease = this.requireCurrentLease(fileRef)
    validateWriteInput(input)
    const found = this.findRecord(lease)
    const current = found?.record ?? null
    const documentId = current?.documentId ?? randomUUID()
    const entry = found?.entry ?? this.entryFor(lease, documentId)

    if ((current?.draftRevision ?? null) !== input.expectedDraftRevision) {
      // `null` can only be stale if a concurrent window has just created one.
      if (current) {
        return { outcome: 'stale', record: publicRecord(current, lease.workspaceRelativePath) }
      }

      throw new Error('DOCUMENT_RECOVERY_CONFLICT')
    }

    const record: AtumDocumentRecoveryDraft = {
      baseRevision: input.baseRevision,
      documentId,
      draftRevision: randomUUID(),
      editorRevision: input.editorRevision,
      text: input.text,
      updatedAt: new Date().toISOString(),
      workspaceRelativePath: lease.workspaceRelativePath
    }

    const bytes = Buffer.from(
      JSON.stringify({
        ...record,
        accountId: lease.account.accountId,
        version: RECORD_VERSION,
        fileIdentities: [lease.fileIdentity]
      }),
      'utf8'
    )

    if (bytes.byteLength + 256 > this.maxRecordBytes) {
      throw new Error('DOCUMENT_RECOVERY_RECORD_TOO_LARGE')
    }

    this.assertQuota(entry, bytes.byteLength + 256)
    this.assertStillCurrent(lease)
    this.atomicReplace(entry, bytes)
    this.assertStillCurrent(lease)

    return { outcome: 'saved', record }
  }

  /** A late saved acknowledgement cannot remove a newer draft. */
  async discard(fileRef: string, expectedDraftRevision: string): Promise<AtumDocumentRecoveryDiscardResult> {
    if (!isOpaqueRevision(expectedDraftRevision)) {
      throw new Error('DOCUMENT_RECOVERY_INVALID_INPUT')
    }

    const lease = this.requireCurrentLease(fileRef)
    const found = this.findRecord(lease)
    const current = found?.record ?? null

    if (!current) {
      return { outcome: 'absent', record: null }
    }

    if (current.draftRevision !== expectedDraftRevision) {
      return { outcome: 'stale', record: publicRecord(current, lease.workspaceRelativePath) }
    }

    this.assertStillCurrent(lease)
    this.unlinkRecord(found!.entry)
    this.assertStillCurrent(lease)

    return { outcome: 'discarded', record: null }
  }

  /** Called synchronously before the lease publishes an atomic replacement.
   * Both identities are durable before rename: either side of a crash can find
   * the same draft. Renames/trash need no path migration; reusing a pathname
   * creates a different physical identity and cannot inherit this draft.
   */
  prepareFileReplacement(fileRef: string, replacementIdentity: string): void {
    try {
      this.bindPreparedFile(fileRef, replacementIdentity)
    } catch (error) {
      // Rebinding recovery is best effort. A broken record remains untouched,
      // but cannot block an explicit revision-checked save of the live buffer.
      // Journal read/write/discard still reject corruption and never follow it.
      if (
        !(error instanceof Error) ||
        !/^DOCUMENT_RECOVERY_(?:RECORD_TOO_LARGE|QUOTA_EXCEEDED|STORAGE_UNAVAILABLE|STORAGE_FULL|CORRUPT)$/.test(
          error.message
        )
      ) {
        throw error
      }
    }
  }

  private bindPreparedFile(fileRef: string, replacementIdentity: string): void {
    const lease = this.requireCurrentLease(fileRef)
    const found = this.findRecord(lease)

    if (!found) {
      return
    }

    const bytes = Buffer.from(
      JSON.stringify({
        ...found.record,
        fileIdentities: [lease.fileIdentity, replacementIdentity]
      }),
      'utf8'
    )

    if (bytes.byteLength > this.maxRecordBytes) {
      throw new Error('DOCUMENT_RECOVERY_RECORD_TOO_LARGE')
    }

    this.assertQuota(found.entry, bytes.byteLength)
    this.assertStillCurrent(lease)
    this.atomicReplace(found.entry, bytes)
  }

  private findRecord(lease: DocumentRecoveryLease): { entry: JournalEntry; record: SerializedDraft } | null {
    const { root } = this.entryFor(lease, 'unused')
    let names: string[]

    try {
      names = readdirSync(root).filter(name => RECORD_NAME.test(name))
    } catch {
      throw new Error('DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE')
    }

    if (names.length > this.maxRecords) {
      throw new Error('DOCUMENT_RECOVERY_QUOTA_EXCEEDED')
    }

    let found: { entry: JournalEntry; record: SerializedDraft } | null = null

    for (const name of names) {
      const entry = { root, path: path.join(root, name) }
      const record = this.readRecord(entry, lease)

      if (record?.fileIdentities.includes(lease.fileIdentity)) {
        if (found) {
          throw new Error('DOCUMENT_RECOVERY_CONFLICT')
        }

        found = { entry, record }
      }
    }

    return found
  }

  private requireCurrentLease(fileRef: string): DocumentRecoveryLease {
    if (typeof fileRef !== 'string' || !fileRef) {
      throw new Error('DOCUMENT_RECOVERY_ACCESS_REVOKED')
    }

    const current = this.authority.currentAuthority()

    if (!current) {
      throw new Error('DOCUMENT_RECOVERY_ACCESS_REVOKED')
    }

    let lease: DocumentRecoveryLease

    try {
      lease = this.resolveLease(fileRef)
    } catch (error) {
      if (error instanceof Error && error.message === 'DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE') {
        throw error
      }

      throw new Error('DOCUMENT_RECOVERY_ACCESS_REVOKED')
    }

    if (
      !validLease(lease) ||
      lease.account.accountId !== current.account.accountId ||
      lease.account.accountGeneration !== current.account.accountGeneration
    ) {
      throw new Error('DOCUMENT_RECOVERY_ACCESS_REVOKED')
    }

    return lease
  }

  private assertStillCurrent(lease: DocumentRecoveryLease): void {
    const current = this.authority.currentAuthority()

    if (
      !current ||
      current.account.accountId !== lease.account.accountId ||
      current.account.accountGeneration !== lease.account.accountGeneration
    ) {
      throw new Error('DOCUMENT_RECOVERY_ACCESS_REVOKED')
    }
  }

  private entryFor(lease: DocumentRecoveryLease, documentId: string): JournalEntry {
    const configuredRoot = this.options.journalRootFor(lease.account)

    if (typeof configuredRoot !== 'string' || !path.isAbsolute(configuredRoot)) {
      throw new Error('DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE')
    }

    const root = ensurePrivateDirectory(configuredRoot)

    const name = createHash('sha256')
      .update('atum-document-recovery-v1\0', 'utf8')
      .update(documentId, 'utf8')
      .digest('hex')

    return { path: path.join(root, `${name}.json`), root }
  }

  private readRecord(entry: JournalEntry, lease: DocumentRecoveryLease): SerializedDraft | null {
    let bytes: Buffer

    try {
      const listed = lstatSync(entry.path)

      if (!listed.isFile() || listed.isSymbolicLink()) {
        throw new Error('DOCUMENT_RECOVERY_CORRUPT')
      }

      if (listed.size > this.maxRecordBytes) {
        throw new Error('DOCUMENT_RECOVERY_CORRUPT')
      }

      bytes = readPrivateFile(entry.path, listed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }

      if (error instanceof Error && error.message.startsWith('DOCUMENT_RECOVERY_')) {throw error}
      throw new Error('DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE')
    }

    let parsed: unknown

    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw new Error('DOCUMENT_RECOVERY_CORRUPT')
    }

    if (!isSerializedDraft(parsed, lease)) {
      throw new Error('DOCUMENT_RECOVERY_CORRUPT')
    }

    return parsed
  }

  private assertQuota(entry: JournalEntry, nextBytes: number): void {
    let entries: string[]

    try {
      entries = readdirSync(entry.root)
    } catch {
      throw new Error('DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE')
    }

    let count = 0
    let total = 0

    for (const name of entries) {
      if (!RECORD_NAME.test(name)) {
        continue
      }

      const candidate = path.join(entry.root, name)
      let stat: ReturnType<typeof lstatSync>

      try {
        stat = lstatSync(candidate)
      } catch {
        throw new Error('DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE')
      }

      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxRecordBytes) {
        throw new Error('DOCUMENT_RECOVERY_CORRUPT')
      }

      count += 1
      total += stat.size

      if (total > this.maxTotalBytes) {
        throw new Error('DOCUMENT_RECOVERY_QUOTA_EXCEEDED')
      }
    }

    const existingBytes = tryFileSize(entry.path)
    const prospectiveCount = count + (existingBytes === null ? 1 : 0)
    const prospectiveTotal = total - (existingBytes ?? 0) + nextBytes

    if (prospectiveCount > this.maxRecords || prospectiveTotal > this.maxTotalBytes) {
      throw new Error('DOCUMENT_RECOVERY_QUOTA_EXCEEDED')
    }
  }

  private atomicReplace(entry: JournalEntry, bytes: Buffer): void {
    const temporary = path.join(
      entry.root,
      `.${path.basename(entry.path)}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`
    )

    let fd: number | null = null

    try {
      assertAnchoredDirectory(entry.root)
      assertSafeExistingRecord(entry.path)
      fd = openSync(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
        0o600
      )
      writeFileSync(fd, bytes)
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      assertAnchoredDirectory(entry.root)
      renameSync(temporary, entry.path)
      chmodSync(entry.path, 0o600)
      fsyncDirectory(entry.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOSPC') {
        throw new Error('DOCUMENT_RECOVERY_STORAGE_FULL')
      }

      if (error instanceof Error && error.message.startsWith('DOCUMENT_RECOVERY_')) {
        throw error
      }

      throw new Error('DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE')
    } finally {
      if (fd !== null) {
        closeSync(fd)
      }

      try {
        unlinkSync(temporary)
      } catch {
        // rename consumed the temporary file, or a failed write left nothing.
      }
    }
  }

  private unlinkRecord(entry: JournalEntry): void {
    try {
      assertAnchoredDirectory(entry.root)
      assertSafeExistingRecord(entry.path)
      unlinkSync(entry.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }

      if (error instanceof Error && error.message.startsWith('DOCUMENT_RECOVERY_')) {throw error}
      throw new Error('DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE')
    }

    fsyncDirectory(entry.root)
  }
}

interface JournalEntry {
  path: string
  root: string
}

function positiveLimit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback

  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error('DOCUMENT_RECOVERY_INVALID_LIMIT')
  }

  return result
}

function validLease(value: DocumentRecoveryLease): boolean {
  return (
    !!value &&
    !!value.account &&
    typeof value.account.accountId === 'string' &&
    !!value.account.accountId &&
    Number.isSafeInteger(value.account.accountGeneration) &&
    value.account.accountGeneration > 0 &&
    typeof value.fileIdentity === 'string' &&
    value.fileIdentity.length > 0 &&
    value.fileIdentity.length <= 4096 &&
    typeof value.workspaceRelativePath === 'string' &&
    value.workspaceRelativePath.length > 0 &&
    value.workspaceRelativePath.length <= 4096
  )
}

function validateWriteInput(input: AtumDocumentRecoveryWriteInput): void {
  if (
    typeof input.text !== 'string' ||
    !isOpaqueRevision(input.baseRevision) ||
    !isOpaqueRevision(input.editorRevision) ||
    (input.expectedDraftRevision !== null && !isOpaqueRevision(input.expectedDraftRevision))
  ) {
    throw new Error('DOCUMENT_RECOVERY_INVALID_INPUT')
  }
}

function isOpaqueRevision(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
}

function isSerializedDraft(value: unknown, lease: DocumentRecoveryLease): value is SerializedDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const record = value as Partial<SerializedDraft>

  return (
    record.version === RECORD_VERSION &&
    record.accountId === lease.account.accountId &&
    isOpaqueRevision(record.documentId) &&
    isOpaqueRevision(record.workspaceRelativePath) &&
    Array.isArray(record.fileIdentities) &&
    record.fileIdentities.length >= 1 &&
    record.fileIdentities.length <= 2 &&
    record.fileIdentities.every(isOpaqueRevision) &&
    isOpaqueRevision(record.baseRevision) &&
    isOpaqueRevision(record.editorRevision) &&
    isOpaqueRevision(record.draftRevision) &&
    typeof record.text === 'string' &&
    typeof record.updatedAt === 'string' &&
    Number.isFinite(Date.parse(record.updatedAt))
  )
}

function ensurePrivateDirectory(configuredRoot: string): string {
  const parent = path.dirname(configuredRoot)

  try {
    const parentStat = lstatSync(parent)

    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new Error('DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE')
    }

    mkdirSync(configuredRoot, { recursive: true, mode: 0o700 })
    chmodSync(configuredRoot, 0o700)
    const listed = lstatSync(configuredRoot)

    if (!listed.isDirectory() || listed.isSymbolicLink()) {
      throw new Error('DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE')
    }

    const canonical = realpathSync(configuredRoot)
    assertAnchoredDirectory(canonical)

    return canonical
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('DOCUMENT_RECOVERY_')) {
      throw error
    }

    throw new Error('DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE')
  }
}

function assertAnchoredDirectory(root: string): void {
  const listed = lstatSync(root)

  if (!listed.isDirectory() || listed.isSymbolicLink() || realpathSync(root) !== root) {
    throw new Error('DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE')
  }
}

function readPrivateFile(filePath: string, listed: ReturnType<typeof lstatSync>): Buffer {
  const fd = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))

  try {
    const opened = fstatSync(fd)

    if (!opened.isFile() || opened.dev !== listed.dev || opened.ino !== listed.ino) {
      throw new Error('DOCUMENT_RECOVERY_CORRUPT')
    }

    return readFileSync(fd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('DOCUMENT_RECOVERY_CORRUPT')
    }

    throw error
  } finally {
    closeSync(fd)
  }
}

function tryFileSize(filePath: string): number | null {
  try {
    const entry = lstatSync(filePath)

    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('DOCUMENT_RECOVERY_CORRUPT')
    }

    return entry.size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    if (error instanceof Error && error.message.startsWith('DOCUMENT_RECOVERY_')) {throw error}
    throw new Error('DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE')
  }
}

function assertSafeExistingRecord(filePath: string): void {
  try {
    const entry = lstatSync(filePath)

    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('DOCUMENT_RECOVERY_CORRUPT')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}

function fsyncDirectory(directory: string): void {
  let fd: number | null = null

  try {
    fd = openSync(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0))
    fsyncSync(fd)
  } catch {
    // The content file was already fsync'd and rename is atomic. Directory
    // fsync is a best-effort durability improvement on platforms that support it.
  } finally {
    if (fd !== null) {
      closeSync(fd)
    }
  }
}

function publicRecord(record: SerializedDraft, workspaceRelativePath: string): AtumDocumentRecoveryDraft {
  const { accountId: _accountId, version: _version, fileIdentities: _identities, ...draft } = record

  return { ...draft, workspaceRelativePath }
}
