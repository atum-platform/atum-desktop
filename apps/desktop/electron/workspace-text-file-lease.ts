import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

import type { DocumentRecoveryLease } from './atum-document-recovery'
import type { FilesystemAccountEnvelope } from './atum-filesystem-capability'

/** Both native surfaces derive this envelope from their existing account
 * authority. File leases do not need a broker, grant issuer or auth runtime. */
export interface DocumentAccountAuthority {
  currentAuthority(): { account: FilesystemAccountEnvelope } | null
}

const MAX_TEXT_BYTES = 1024 * 1024
const WATCH_INTERVAL_MS = 750

export interface WorkspaceTextFileLeaseDescriptor {
  fileRef: string
  displayName: string
  /** Present only for documents inside the account workspace (Atum Office Phase 0). */
  workspaceRelativePath?: string
}

export interface WorkspaceTextFileSnapshot {
  revision: string
  text: string
  truncated: boolean
}

export interface WorkspaceTextFileRemoteTransport {
  open(path: string): Promise<{ leaseId: string; displayName: string }>
  preserveSibling(leaseId: string, input: { expectedRevision: string; text: string }): Promise<{ displayName: string }>
  read(leaseId: string): Promise<WorkspaceTextFileSnapshot>
  release(leaseId: string): Promise<void>
  write(leaseId: string, input: { expectedRevision: string; text: string }): Promise<{ revision: string }>
}

interface LeaseBase {
  account: FilesystemAccountEnvelope
  displayName: string
  workspaceRelativePath?: string
  observedRevisions: Set<string>
  released: boolean
}

interface LocalLease extends LeaseBase {
  kind: 'local'
  /**
   * The renderer (webContents id) this lease was opened for, when it was
   * opened through IPC. Reads that carry an owner refuse a different one. A
   * lease opened by main on its own behalf carries no owner and stays open to
   * any trusted renderer, as before.
   */
  ownerId?: string
  canonicalPath: string
  canonicalParent: string
  parentIdentity: string
  targetIdentity: string
}

interface AnchoredLocalTarget {
  canonicalParent: string
  displayName: string
  parentIdentity: string
  /** Matrix editing requires lossless text and the originally selected inode. */
  strictText?: boolean
  targetIdentity?: string
}

export interface AnchoredTextWritePlan extends AnchoredLocalTarget {
  canonicalPath: string
  disposition: 'create' | 'overwrite'
  existingByteSize: number
  expectedIdentity: string | null
  expectedRevision: string | null
}

interface RemoteLease extends LeaseBase {
  kind: 'remote'
  remoteLeaseId: string
  transport: WorkspaceTextFileRemoteTransport
}

type LeaseRecord = LocalLease | RemoteLease

export function fileIdentity(stat: ReturnType<typeof statSync>): string {
  return `${stat.dev}:${stat.ino}:${Number(stat.mode) & fsConstants.S_IFMT}`
}

export interface LocalWorkspaceExportSource extends AnchoredLocalTarget {
  account: FilesystemAccountEnvelope
  canonicalPath: string
  canonicalParent: string
  workspaceRelativePath: string
}

export interface AnchoredBinaryPublishResult {
  byteSize: number
  canonicalPath: string
  displayName: string
  fileIdentity: string
  sha256: string
}

/**
 * Publish a new binary sibling without ever replacing a pre-existing entry.
 *
 * The bytes are written to an exclusive temporary entry in the anchored
 * parent, then *linked* into the target name. `link(2)` fails with EEXIST when
 * anything already occupies the name, so a foreign entry that appears between
 * validation and publication can never be overwritten (a check-then-rename
 * sequence could). The temporary link is removed afterwards; the inode lives on
 * under the target name.
 */
export function commitAnchoredBinaryPublish(
  parentRecord: Pick<LocalWorkspaceExportSource, 'canonicalParent' | 'parentIdentity'>,
  preferredName: string,
  bytes: Uint8Array,
  options: { maxBytes: number; maxOrdinal?: number; beforeCommit?: () => void }
): AnchoredBinaryPublishResult {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || bytes.byteLength > options.maxBytes) {
    throw new Error('EXPORT_TOO_LARGE')
  }

  const extension = path.extname(preferredName).toLocaleLowerCase('en-US')

  if (
    !['.docx', '.pdf'].includes(extension) ||
    path.basename(preferredName) !== preferredName ||
    preferredName.startsWith('.')
  ) {
    throw new Error('EXPORT_UNSUPPORTED')
  }

  const stem = preferredName.slice(0, -extension.length)
  const parent = openAnchoredParent({ ...parentRecord, displayName: preferredName })
  const maxOrdinal = options.maxOrdinal ?? 10_000

  try {
    for (let ordinal = 1; ordinal <= maxOrdinal; ordinal += 1) {
      const displayName = `${stem}${ordinal === 1 ? '' : ` (${ordinal})`}${extension}`
      const target = parent.child(displayName)
      const temporary = parent.child(`.${displayName}.atum-${process.pid}-${randomBytes(12).toString('hex')}`)
      let temporaryFd: number | null = null

      // A symlink or non-file at the target name is foreign and suspicious:
      // fail closed rather than silently numbering past it. link(2) below is
      // still the only authority against replacement between check and commit.
      try {
        const occupant = lstatSync(target)

        if (occupant.isSymbolicLink() || !occupant.isFile()) {
          throw new Error('CAPABILITY_SCOPE_ESCAPE')
        }

        continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }

      try {
        temporaryFd = openSync(
          temporary,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
          0o600
        )
        writeFileSync(temporaryFd, bytes)
        fsyncSync(temporaryFd)
        const identity = fileIdentity(fstatSync(temporaryFd))
        closeSync(temporaryFd)
        temporaryFd = null
        options.beforeCommit?.()

        if (fileIdentity(fstatSync(parent.fd)) !== parentRecord.parentIdentity) {
          throw new Error('EXPORT_PUBLISH_FAILED')
        }

        try {
          linkSync(temporary, target)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            continue
          }

          throw new Error('EXPORT_PUBLISH_FAILED')
        }

        // The link is the commit point: the file is published from here on. A
        // failed directory fsync only weakens durability of the name, so it must
        // not turn a published file into a reported failure.
        try {
          fsyncSync(parent.fd)
        } catch {
          // Best effort.
        }

        const published = lstatSync(target)

        if (!published.isFile() || published.isSymbolicLink() || fileIdentity(published) !== identity) {
          throw new Error('EXPORT_PUBLISH_FAILED')
        }

        return {
          byteSize: bytes.byteLength,
          canonicalPath: path.join(parentRecord.canonicalParent, displayName),
          displayName,
          fileIdentity: identity,
          sha256: createHash('sha256').update(bytes).digest('base64url')
        }
      } finally {
        try {
          if (temporaryFd !== null) {
            closeSync(temporaryFd)
          }
        } catch {
          // Closing failed; the unlink below still runs.
        } finally {
          try {
            // After a successful link the inode survives under the target name.
            unlinkSync(temporary)
          } catch {
            // Already gone.
          }
        }
      }
    }
  } finally {
    closeSync(parent.fd)
  }

  throw new Error('EXPORT_PUBLISH_FAILED')
}

function revisionFor(buffer: Buffer): string {
  return `sha256:${createHash('sha256').update(buffer).digest('base64url')}`
}

function assertTextSize(text: string): Buffer {
  const buffer = Buffer.from(text, 'utf8')

  if (buffer.length > MAX_TEXT_BYTES) {
    throw new Error('WORKSPACE_FILE_TOO_LARGE')
  }

  return buffer
}

// Threat model note (Atum Office Phase 2 review): child operations are
// descriptor-relative on Linux (/proc/self/fd) but pathname-based on macOS and
// Windows, so a parent directory swapped between anchoring and commit can
// redirect a path-based step there. The identity checks before and after the
// commit, and link(2)'s refusal to replace, bound what such a swap can do to
// "fail" or "publish elsewhere under the same account root" — never overwrite.
function openAnchoredParent(record: AnchoredLocalTarget): { child: (name: string) => string; fd: number } {
  const parent = realpathSync(record.canonicalParent)

  if (parent !== record.canonicalParent || fileIdentity(statSync(parent)) !== record.parentIdentity) {
    throw new Error('CAPABILITY_SCOPE_ESCAPE')
  }

  const fd = openSync(parent, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0))
  const opened = fstatSync(fd)

  if (!opened.isDirectory() || fileIdentity(opened) !== record.parentIdentity) {
    closeSync(fd)
    throw new Error('CAPABILITY_SCOPE_ESCAPE')
  }

  return {
    fd,
    child: name => path.join(process.platform === 'linux' ? `/proc/self/fd/${fd}` : parent, name)
  }
}

function readLocalFromParent(record: AnchoredLocalTarget, child: (name: string) => string): WorkspaceTextFileSnapshot {
  const childPath = child(record.displayName)
  let target: ReturnType<typeof lstatSync>
  let fd: number

  try {
    target = lstatSync(childPath)

    if (!target.isFile() || target.isSymbolicLink()) {
      throw new Error('CAPABILITY_SCOPE_ESCAPE')
    }

    if (record.strictText && record.targetIdentity !== fileIdentity(target)) {
      throw new Error('WORKSPACE_CONFLICT')
    }

    fd = openSync(childPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if (error instanceof Error && ['CAPABILITY_SCOPE_ESCAPE', 'WORKSPACE_CONFLICT'].includes(error.message)) {
      throw error
    }

    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('CAPABILITY_SCOPE_ESCAPE')
    }

    throw new Error('WORKSPACE_IO_FAILED')
  }

  try {
    const opened = fstatSync(fd)

    if (!opened.isFile() || fileIdentity(opened) !== fileIdentity(target)) {
      throw new Error('CAPABILITY_SCOPE_ESCAPE')
    }

    if (opened.size > MAX_TEXT_BYTES) {
      throw new Error('WORKSPACE_FILE_TOO_LARGE')
    }

    const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1)
    let offset = 0

    while (offset < buffer.length) {
      const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, null)

      if (bytesRead === 0) {
        break
      }

      offset += bytesRead
    }

    if (offset > MAX_TEXT_BYTES) {
      throw new Error('WORKSPACE_FILE_TOO_LARGE')
    }

    const bytes = buffer.subarray(0, offset)
    let text: string

    if (record.strictText) {
      try {
        if (bytes.includes(0)) {throw new Error('unsupported')}
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      } catch {throw new Error('MATRIX_TEXT_DOCUMENT_UNSUPPORTED')}
    } else {
      text = bytes.toString('utf8')
    }

    return { revision: revisionFor(bytes), text, truncated: false }
  } finally {
    closeSync(fd)
  }
}

/** Main-only preparation for a disclosed, conflict-fenced local text write. */
export function prepareAnchoredTextWrite(canonicalPath: string): AnchoredTextWritePlan {
  const canonicalParent = realpathSync(path.dirname(canonicalPath))
  const displayName = path.basename(canonicalPath)

  const target: AnchoredLocalTarget = {
    canonicalParent,
    displayName,
    parentIdentity: fileIdentity(statSync(canonicalParent))
  }

  const parent = openAnchoredParent(target)

  try {
    try {
      const childPath = parent.child(displayName)
      const entry = lstatSync(childPath)

      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('CAPABILITY_SCOPE_ESCAPE')
      }

      const snapshot = readLocalFromParent(target, parent.child)

      return {
        ...target,
        canonicalPath,
        disposition: 'overwrite',
        existingByteSize: entry.size,
        expectedIdentity: fileIdentity(entry),
        expectedRevision: snapshot.revision
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }

      return {
        ...target,
        canonicalPath,
        disposition: 'create',
        existingByteSize: 0,
        expectedIdentity: null,
        expectedRevision: null
      }
    }
  } finally {
    closeSync(parent.fd)
  }
}

/**
 * Commit through the prepared parent identity. Creates use an exclusive hard
 * link and overwrites atomically replace the directory entry; neither path
 * follows a final-component symlink.
 */
export function commitAnchoredTextWrite(
  plan: AnchoredTextWritePlan,
  text: string,
  options: { link?: typeof linkSync } = {}
): void {
  const buffer = assertTextSize(text)
  const publishCreate = options.link ?? linkSync
  const parent = openAnchoredParent(plan)
  const target = parent.child(plan.displayName)
  const temporaryName = `.${plan.displayName}.atum-${process.pid}-${randomBytes(12).toString('hex')}`
  const temporary = parent.child(temporaryName)
  let fd: number | null = null

  const verifyExpectedTarget = (): void => {
    try {
      const entry = lstatSync(target)

      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('CAPABILITY_SCOPE_ESCAPE')
      }

      if (
        plan.expectedIdentity === null ||
        fileIdentity(entry) !== plan.expectedIdentity ||
        readLocalFromParent(plan, parent.child).revision !== plan.expectedRevision
      ) {
        throw new Error('WORKSPACE_CONFLICT')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && plan.expectedIdentity === null) {
        return
      }

      throw error
    }
  }

  try {
    verifyExpectedTarget()
    fd = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600
    )
    writeFileSync(fd, buffer)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    verifyExpectedTarget()

    if (plan.disposition === 'create') {
      publishCreate(temporary, target)
      unlinkSync(temporary)
    } else {
      renameSync(temporary, target)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('WORKSPACE_CONFLICT')
    }

    throw error
  } finally {
    if (fd !== null) {
      closeSync(fd)
    }

    try {
      unlinkSync(temporary)
    } catch {
      // Successful publish consumed the temporary entry.
    }

    closeSync(parent.fd)
  }
}

function readLocal(record: LocalLease): WorkspaceTextFileSnapshot {
  const parent = openAnchoredParent(record)

  try {
    return readLocalFromParent(record, parent.child)
  } finally {
    closeSync(parent.fd)
  }
}

/** Main-process custody for stable, account-bound text file leases. */
export class WorkspaceTextFileLeaseProvider {
  private readonly inFlight = new Map<string, Set<Promise<unknown>>>()
  private readonly leases = new Map<string, LeaseRecord>()
  private readonly watchers = new Map<string, Set<() => void>>()

  constructor(
    private readonly authority: DocumentAccountAuthority,
    private readonly recovery?: { prepareFileReplacement: (fileRef: string, identity: string) => void }
  ) {}

  openLocal(
    filePath: string,
    options: { workspaceRelativePath?: string; ownerId?: string; strictText?: boolean } = {}
  ): WorkspaceTextFileLeaseDescriptor {
    const account = this.requireCurrentAccount()

    if (!['.md', '.markdown', '.txt'].includes(path.extname(filePath).toLocaleLowerCase('en-US'))) {
      throw new Error('CAPABILITY_DENIED')
    }

    let canonicalPath: string
    let file: ReturnType<typeof lstatSync>

    try {
      canonicalPath = realpathSync(filePath)
      file = lstatSync(canonicalPath)
    } catch {
      throw new Error('WORKSPACE_OPEN_FAILED')
    }

    if (!file.isFile() || file.isSymbolicLink()) {
      throw new Error('CAPABILITY_DENIED')
    }

    const canonicalParent = realpathSync(path.dirname(canonicalPath))

    const record: LocalLease = {
      account,
      canonicalParent,
      canonicalPath,
      displayName: path.basename(canonicalPath),
      kind: 'local',
      observedRevisions: new Set(),
      parentIdentity: fileIdentity(statSync(canonicalParent)),
      targetIdentity: fileIdentity(file),
      released: false,
      workspaceRelativePath: options.workspaceRelativePath,
      ...(options.strictText ? { strictText: true } : {}),
      ...(options.ownerId ? { ownerId: options.ownerId } : {})
    }

    return this.retain(record)
  }

  async openRemote(
    remotePath: string,
    transport: WorkspaceTextFileRemoteTransport
  ): Promise<WorkspaceTextFileLeaseDescriptor> {
    const account = this.requireCurrentAccount()
    const remote = await transport.open(remotePath)

    if (!['.md', '.markdown', '.txt'].includes(path.extname(remote.displayName).toLocaleLowerCase('en-US'))) {
      await transport.release(remote.leaseId).catch(() => undefined)
      throw new Error('CAPABILITY_DENIED')
    }

    const current = this.requireCurrentAccount()

    if (current.accountId !== account.accountId || current.accountGeneration !== account.accountGeneration) {
      await transport.release(remote.leaseId).catch(() => undefined)
      throw new Error('CAPABILITY_STALE')
    }

    const record: RemoteLease = {
      account,
      displayName: remote.displayName,
      kind: 'remote',
      observedRevisions: new Set(),
      released: false,
      remoteLeaseId: remote.leaseId,
      transport
    }

    return this.retain(record)
  }

  async read(fileRef: string): Promise<WorkspaceTextFileSnapshot> {
    const record = this.requireLease(fileRef)

    const snapshot =
      record.kind === 'local'
        ? readLocal(record)
        : await this.trackRemote(fileRef, record.transport.read(record.remoteLeaseId))

    if (record.kind === 'remote' && this.requireLease(fileRef) !== record) {
      throw new Error('CAPABILITY_STALE')
    }

    record.observedRevisions.add(snapshot.revision)

    return snapshot
  }

  resolveLocalWorkspaceExportSource(fileRef: string, ownerId?: string): LocalWorkspaceExportSource {
    const record = this.requireLease(fileRef)

    if (record.kind !== 'local' || !record.workspaceRelativePath) {
      throw new Error('EXPORT_NOT_WORKSPACE_DOCUMENT')
    }

    // A lease opened for one renderer is not readable by another, even one
    // that has somehow learned its opaque reference.
    if (record.ownerId && ownerId && record.ownerId !== ownerId) {
      throw new Error('CAPABILITY_DENIED')
    }

    if (!['.md', '.markdown'].includes(path.extname(record.displayName).toLocaleLowerCase('en-US'))) {
      throw new Error('EXPORT_NOT_WORKSPACE_DOCUMENT')
    }

    const parent = openAnchoredParent(record)

    try {
      const entry = lstatSync(parent.child(record.displayName))

      if (!entry.isFile() || entry.isSymbolicLink() || fileIdentity(entry) !== record.targetIdentity) {
        throw new Error('CAPABILITY_SCOPE_ESCAPE')
      }
    } finally {
      closeSync(parent.fd)
    }

    return {
      account: record.account,
      canonicalPath: record.canonicalPath,
      canonicalParent: record.canonicalParent,
      displayName: record.displayName,
      parentIdentity: record.parentIdentity,
      workspaceRelativePath: record.workspaceRelativePath
    }
  }

  /**
   * Main-only recovery identity for a live local workspace lease. This is
   * intentionally narrower than the export source: it exposes no filesystem
   * path, and callers with a renderer owner must match the originating lease.
   */
  resolveDocumentRecoveryLease(fileRef: string, ownerId?: string): DocumentRecoveryLease {
    const record = this.requireLease(fileRef)

    if (
      record.kind !== 'local' ||
      !record.workspaceRelativePath ||
      !['.md', '.markdown'].includes(path.extname(record.displayName).toLocaleLowerCase('en-US'))
    ) {
      throw new Error('DOCUMENT_RECOVERY_NOT_WORKSPACE_DOCUMENT')
    }

    if (ownerId !== undefined && record.ownerId !== ownerId) {
      throw new Error('CAPABILITY_DENIED')
    }

    const parent = openAnchoredParent(record)

    try {
      const stat = lstatSync(parent.child(record.displayName))

      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('CAPABILITY_DENIED')
      }

      return {
        account: record.account,
        fileIdentity: documentFileIdentity(stat),
        workspaceRelativePath: record.workspaceRelativePath
      }
    } finally {
      closeSync(parent.fd)
    }
  }

  assertLocalWorkspaceExportRevision(fileRef: string, revision: string): void {
    const record = this.requireLease(fileRef)

    if (record.kind !== 'local' || readLocal(record).revision !== revision) {
      throw new Error('EXPORT_SOURCE_CHANGED')
    }
  }

  readForLocalWorkspaceExport(fileRef: string): WorkspaceTextFileSnapshot {
    const record = this.requireLease(fileRef)

    if (record.kind !== 'local') {
      throw new Error('EXPORT_NOT_WORKSPACE_DOCUMENT')
    }

    const snapshot = readLocal(record)
    record.observedRevisions.add(snapshot.revision)

    return snapshot
  }

  async write(fileRef: string, input: { expectedRevision: string; text: string }): Promise<{ revision: string }> {
    const record = this.requireLease(fileRef)

    if (!record.observedRevisions.has(input.expectedRevision)) {
      throw new Error('WORKSPACE_CONFLICT')
    }

    if (record.kind === 'remote') {
      const result = await this.trackRemote(fileRef, record.transport.write(record.remoteLeaseId, input))

      if (this.requireLease(fileRef) !== record) {
        throw new Error('CAPABILITY_STALE')
      }

      record.observedRevisions.add(result.revision)

      return result
    }

    const buffer = assertTextSize(input.text)
    const parent = openAnchoredParent(record)

    const temporaryName = `.${record.displayName}.atum-${process.pid}-${randomBytes(12).toString('hex')}`
    const temporary = parent.child(temporaryName)
    const canonicalTarget = parent.child(record.displayName)

    let fd: number | null = null

    try {
      if (readLocalFromParent(record, parent.child).revision !== input.expectedRevision) {
        throw new Error('WORKSPACE_CONFLICT')
      }

      fd = openSync(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
        0o600
      )
      writeFileSync(fd, buffer)
      fsyncSync(fd)
      closeSync(fd)
      fd = null

      if (readLocalFromParent(record, parent.child).revision !== input.expectedRevision) {
        throw new Error('WORKSPACE_CONFLICT')
      }

      if (record.workspaceRelativePath && /\.(?:md|markdown)$/i.test(record.displayName)) {
        try {
          this.recovery?.prepareFileReplacement(fileRef, documentFileIdentity(lstatSync(temporary)))
        } catch (error) {
          // Missing birth time disables recovery identity, not revision-checked
          // explicit saving. Never swallow authority or filesystem failures.
          if (!(error instanceof Error) || error.message !== 'DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE') {
            throw error
          }
        }
      }

      // Strong for cooperative lease writers and an immediate best-effort
      // fence for noncooperating writers. Portable filesystems expose no
      // compare-and-swap rename; watch + preserveSibling cover that residual.
      const publishedIdentity = fileIdentity(lstatSync(temporary))
      renameSync(temporary, canonicalTarget)
      record.targetIdentity = publishedIdentity
      const result = readLocalFromParent(record, parent.child)
      record.observedRevisions.add(result.revision)

      return { revision: result.revision }
    } finally {
      if (fd !== null) {
        closeSync(fd)
      }

      try {
        unlinkSync(temporary)
      } catch {
        // The successful rename consumed the temp; cleanup is best effort.
      }

      closeSync(parent.fd)
    }
  }

  async preserveSibling(
    fileRef: string,
    input: { expectedRevision: string; text: string }
  ): Promise<{ displayName: string }> {
    const record = this.requireLease(fileRef)

    if (!record.observedRevisions.has(input.expectedRevision)) {
      throw new Error('WORKSPACE_CONFLICT')
    }

    if (record.kind === 'remote') {
      const result = await this.trackRemote(fileRef, record.transport.preserveSibling(record.remoteLeaseId, input))

      if (this.requireLease(fileRef) !== record) {
        throw new Error('CAPABILITY_STALE')
      }

      return result
    }

    const buffer = assertTextSize(input.text)
    const extension = path.extname(record.displayName)
    const stem = record.displayName.slice(0, record.displayName.length - extension.length)
    const parent = openAnchoredParent(record)

    try {
      for (let ordinal = 1; ordinal <= 10_000; ordinal += 1) {
        const displayName = `${stem} (preserved${ordinal === 1 ? '' : ` ${ordinal}`})${extension}`
        const candidate = parent.child(displayName)
        let fd: number | null = null

        try {
          fd = openSync(
            candidate,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
            0o600
          )
          writeFileSync(fd, buffer)
          fsyncSync(fd)
          closeSync(fd)

          return { displayName }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error
          }
        } finally {
          if (fd !== null) {
            try {
              closeSync(fd)
            } catch {
              // Already closed on success.
            }
          }
        }
      }
    } finally {
      closeSync(parent.fd)
    }

    throw new Error('WORKSPACE_PRESERVE_EXHAUSTED')
  }

  watch(fileRef: string, onRevision: (revision: string) => void): () => void {
    this.requireLease(fileRef)
    let previous: string | null = null
    let stopped = false
    let timer: ReturnType<typeof setInterval>

    const stop = () => {
      if (stopped) {
        return
      }

      stopped = true
      clearInterval(timer)
      const watchers = this.watchers.get(fileRef)
      watchers?.delete(stop)

      if (watchers?.size === 0) {
        this.watchers.delete(fileRef)
      }
    }

    const poll = async () => {
      try {
        const snapshot = await this.read(fileRef)

        if (previous !== null && previous !== snapshot.revision) {
          onRevision(snapshot.revision)
        }

        previous = snapshot.revision
      } catch {
        if (!stopped) {
          stop()
          onRevision('revoked')
        }
      }
    }

    timer = setInterval(() => void poll(), WATCH_INTERVAL_MS)
    const watchers = this.watchers.get(fileRef) ?? new Set<() => void>()
    watchers.add(stop)
    this.watchers.set(fileRef, watchers)
    void poll()

    return stop
  }

  async release(fileRef: string): Promise<void> {
    const record = this.leases.get(fileRef)

    if (!record || record.released) {
      return
    }

    record.released = true
    this.leases.delete(fileRef)
    this.stopWatchers(fileRef)
    await Promise.allSettled([...(this.inFlight.get(fileRef) ?? [])])

    if (record.kind === 'remote') {
      await record.transport.release(record.remoteLeaseId)
    }
  }

  async revokeAccount(account: FilesystemAccountEnvelope): Promise<void> {
    const releases: Promise<void>[] = []

    for (const [fileRef, record] of this.leases) {
      if (
        record.account.accountId !== account.accountId ||
        record.account.accountGeneration !== account.accountGeneration
      ) {
        continue
      }

      record.released = true
      this.leases.delete(fileRef)
      this.stopWatchers(fileRef)

      if (record.kind === 'remote') {
        releases.push(
          Promise.allSettled([...(this.inFlight.get(fileRef) ?? [])]).then(() =>
            record.transport.release(record.remoteLeaseId)
          )
        )
      }
    }

    // Account quiescence is authoritative even when a remote backend is
    // unreachable. Local custody disappears first; remote cleanup is bounded
    // best effort and its opaque id never becomes valid for another account.
    await Promise.allSettled(releases)
  }

  private requireCurrentAccount(): FilesystemAccountEnvelope {
    const current = this.authority.currentAuthority()

    if (!current) {
      throw new Error('CAPABILITY_REVOKED')
    }

    return current.account
  }

  private requireLease(fileRef: string): LeaseRecord {
    const record = this.leases.get(fileRef)
    const current = this.authority.currentAuthority()

    if (!record || record.released) {
      throw new Error('CAPABILITY_REVOKED')
    }

    if (
      !current ||
      current.account.accountId !== record.account.accountId ||
      current.account.accountGeneration !== record.account.accountGeneration
    ) {
      throw new Error('CAPABILITY_STALE')
    }

    return record
  }

  private retain(record: LeaseRecord): WorkspaceTextFileLeaseDescriptor {
    const fileRef = randomBytes(32).toString('base64url')
    this.leases.set(fileRef, record)

    return record.workspaceRelativePath
      ? { fileRef, displayName: record.displayName, workspaceRelativePath: record.workspaceRelativePath }
      : { fileRef, displayName: record.displayName }
  }

  private stopWatchers(fileRef: string): void {
    for (const stop of [...(this.watchers.get(fileRef) ?? [])]) {
      stop()
    }
  }

  private async trackRemote<T>(fileRef: string, operation: Promise<T>): Promise<T> {
    const operations = this.inFlight.get(fileRef) ?? new Set<Promise<unknown>>()
    operations.add(operation)
    this.inFlight.set(fileRef, operations)

    try {
      return await operation
    } finally {
      operations.delete(operation)

      if (operations.size === 0) {
        this.inFlight.delete(fileRef)
      }
    }
  }
}

/** Birth time distinguishes a later file even when the filesystem reuses an inode. */
export function documentFileIdentity(stat: ReturnType<typeof statSync>): string {
  if (!Number.isFinite(stat.birthtimeMs) || stat.birthtimeMs <= 0) {
    throw new Error('DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE')
  }

  return createHash('sha256').update(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`).digest('hex')
}
