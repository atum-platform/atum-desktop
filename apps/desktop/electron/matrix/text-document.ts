import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

import type {
  AtumDocumentRecoveryDiscardResult,
  AtumDocumentRecoveryReadResult,
  AtumDocumentRecoveryWriteInput,
  AtumDocumentRecoveryWriteResult
} from '../../shared/atum-office/document-recovery'
import { AtumDocumentRecoveryJournal } from '../atum-document-recovery'
import { type FilesystemAccountEnvelope } from '../atum-filesystem-capability'
import { type DocumentAccountAuthority, WorkspaceTextFileLeaseProvider, type WorkspaceTextFileSnapshot } from '../workspace-text-file-lease'

/** Main-owned Matrix identity. The renderer receives neither this scope nor a path. */
export interface MatrixTextDocumentScope {
  account: FilesystemAccountEnvelope
  deviceId: string
  roomId: string
  userId: string
}

export interface MatrixTextDocumentDescriptor {
  /** Opaque, per-selection id for UI correlation only. It is not a file capability. */
  id: string
  name: string
  recovery: 'available' | 'unsupported'
}

export interface MatrixTextDocumentCapture {
  bytes: Buffer
  name: string
  revision: string
}

export interface MatrixTextDocumentDependencies {
  /** The active account authority used by the existing anchored lease provider. */
  authority: DocumentAccountAuthority
  /** Main derives this from the live Matrix account/device/room, never renderer input. */
  currentScope(): MatrixTextDocumentScope | null
  /** Temporary transport loss suspends IO without spending selection custody. */
  available?(): boolean
  /** Canonicalizes and confines the selected main-process path before a lease is opened. */
  confine(requested: string): string
  /** Account-private root, such as the active account root's document-recovery directory. */
  journalRootFor(account: FilesystemAccountEnvelope): string
}

function sameAccount(left: FilesystemAccountEnvelope, right: FilesystemAccountEnvelope): boolean {
  return left.accountId === right.accountId && left.accountGeneration === right.accountGeneration
}

function sameScope(left: MatrixTextDocumentScope, right: MatrixTextDocumentScope): boolean {
  return sameAccount(left.account, right.account) &&
    left.deviceId === right.deviceId && left.roomId === right.roomId && left.userId === right.userId
}

function validScope(scope: MatrixTextDocumentScope | null): scope is MatrixTextDocumentScope {
  return Boolean(
    scope &&
    scope.account.accountId &&
    Number.isSafeInteger(scope.account.accountGeneration) && scope.account.accountGeneration > 0 &&
    scope.userId.startsWith('@') && scope.roomId.startsWith('!') && scope.deviceId
  )
}

const PUBLIC_ERRORS = new Set([
  'MATRIX_TEXT_DOCUMENT_UNAVAILABLE', 'MATRIX_TEXT_DOCUMENT_UNSUPPORTED', 'MATRIX_TEXT_DOCUMENT_RECOVERY_UNSUPPORTED', 'MATRIX_TEXT_DOCUMENT_OFFLINE',
  'WORKSPACE_CONFLICT', 'WORKSPACE_FILE_TOO_LARGE', 'WORKSPACE_IO_FAILED', 'WORKSPACE_OPEN_FAILED',
  'CAPABILITY_DENIED', 'CAPABILITY_STALE', 'CAPABILITY_REVOKED', 'CAPABILITY_SCOPE_ESCAPE',
  'DOCUMENT_RECOVERY_ACCESS_REVOKED', 'DOCUMENT_RECOVERY_NOT_WORKSPACE_DOCUMENT', 'DOCUMENT_RECOVERY_INVALID_INPUT',
  'DOCUMENT_RECOVERY_CONFLICT', 'DOCUMENT_RECOVERY_CORRUPT', 'DOCUMENT_RECOVERY_RECORD_TOO_LARGE',
  'DOCUMENT_RECOVERY_QUOTA_EXCEEDED', 'DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE', 'DOCUMENT_RECOVERY_STORAGE_FULL'
])

function publicError(error: unknown): Error {
  return new Error(error instanceof Error && PUBLIC_ERRORS.has(error.message) ? error.message : 'WORKSPACE_IO_FAILED')
}

function lineEnding(text: string): '\n' | '\r\n' {
  // Mixed endings, lone CR, and a BOM remain on the lossless read-only path.
  // A textarea/projected Markdown editor cannot preserve those byte choices.
  const withoutCRLF = text.replace(/\r\n/gu, '')

  if (text.startsWith('\uFEFF') || withoutCRLF.includes('\r') || (text.includes('\r\n') && withoutCRLF.includes('\n'))) {
    throw new Error('MATRIX_TEXT_DOCUMENT_UNSUPPORTED')
  }

  return text.includes('\r\n') ? '\r\n' : '\n'
}

function recoveryPath(scope: MatrixTextDocumentScope, canonicalPath: string): string {
  // This only gives the journal a private, stable display context. It is never
  // used to address the selected file and the renderer never receives it.
  const extension = path.extname(canonicalPath).toLocaleLowerCase('en-US')

  const identity = createHash('sha256')
    .update(JSON.stringify([scope.account, scope.userId, scope.deviceId, scope.roomId, canonicalPath]))
    .digest('hex')

  return `matrix/${identity}${extension}`
}

/**
 * One explicitly selected Matrix text document. It owns the provider's opaque
 * reference, binds every operation to the original Matrix scope, and gives no
 * renderer code a filesystem path or reusable capability.
 *
 * `.md` and `.markdown` use the existing recovery journal. `.txt` is still
 * revision-CAS editable, but intentionally reports recovery as unsupported.
 */
export class MatrixTextDocument {
  private readonly id = randomUUID()
  private readonly leases: WorkspaceTextFileLeaseProvider
  private readonly recoveryJournal: AtumDocumentRecoveryJournal
  private readonly scope: MatrixTextDocumentScope
  private fileRef: string | null = null
  private name: string | null = null
  private recoverable = false
  private released = false
  private newline: '\n' | '\r\n' = '\n'

  constructor(
    scope: MatrixTextDocumentScope,
    private readonly deps: MatrixTextDocumentDependencies
  ) {
    if (!validScope(scope)) {
      throw new Error('MATRIX_TEXT_DOCUMENT_UNAVAILABLE')
    }

    // The caller owns a live state object; selection custody owns an immutable
    // snapshot so later mutation cannot silently widen this document's scope.
    this.scope = {
      account: { ...scope.account },
      deviceId: scope.deviceId,
      roomId: scope.roomId,
      userId: scope.userId
    }

    // The provider calls prepare before its atomic replacement. Keeping both
    // services private here preserves that ordering without exposing file refs.
    let journal!: AtumDocumentRecoveryJournal
    this.leases = new WorkspaceTextFileLeaseProvider(deps.authority, {
      prepareFileReplacement: (fileRef, identity) => {
        try {journal.prepareFileReplacement(fileRef, identity)} catch (error) {
          // A conflicting private draft never widens the file's revision CAS.
          // Preserve that draft, but let an explicit save retain the live text.
          if (!(error instanceof Error) || error.message !== 'DOCUMENT_RECOVERY_CONFLICT') {throw error}
        }
      }
    })
    journal = new AtumDocumentRecoveryJournal(
      deps.authority,
      fileRef => this.leases.resolveDocumentRecoveryLease(fileRef),
      { journalRootFor: deps.journalRootFor }
    )
    this.recoveryJournal = journal
  }

  private current(): void {
    const authority = this.deps.authority.currentAuthority()
    const scope = this.deps.currentScope()

    if (this.released || !authority || !validScope(scope) || !sameAccount(authority.account, this.scope.account) || !sameScope(scope, this.scope)) {
      void this.release()
      throw new Error('MATRIX_TEXT_DOCUMENT_UNAVAILABLE')
    }

    if (this.deps.available?.() === false) {throw new Error('MATRIX_TEXT_DOCUMENT_OFFLINE')}
  }

  private requireRef(): string {
    this.current()

    if (!this.fileRef) {
      throw new Error('MATRIX_TEXT_DOCUMENT_UNAVAILABLE')
    }

    return this.fileRef
  }

  private async currentRawSnapshot(): Promise<WorkspaceTextFileSnapshot> {
    const fileRef = this.requireRef()
    const snapshot = await this.leases.read(fileRef)
    this.current()

    if (snapshot.truncated) {
      throw new Error('MATRIX_TEXT_DOCUMENT_UNAVAILABLE')
    }

    this.newline = lineEnding(snapshot.text)

    return snapshot
  }

  private async currentSnapshot(): Promise<WorkspaceTextFileSnapshot> {
    const snapshot = await this.currentRawSnapshot()

    return { ...snapshot, text: snapshot.text.replace(/\r\n/gu, '\n') }
  }

  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {return await operation()} catch (error) {throw publicError(error)}
  }

  open(requested: string): MatrixTextDocumentDescriptor {
    this.current()

    if (this.fileRef) {
      throw new Error('MATRIX_TEXT_DOCUMENT_UNAVAILABLE')
    }

    let canonicalPath: string

    try {
      canonicalPath = this.deps.confine(requested)
    } catch {
      throw new Error('MATRIX_TEXT_DOCUMENT_UNAVAILABLE')
    }

    this.current()
    const extension = path.extname(canonicalPath).toLocaleLowerCase('en-US')

    if (!['.md', '.markdown', '.txt'].includes(extension)) {
      throw new Error('MATRIX_TEXT_DOCUMENT_UNSUPPORTED')
    }

    try {
      const descriptor = this.leases.openLocal(canonicalPath, {
        strictText: true,
        ...(extension === '.md' || extension === '.markdown' ? { workspaceRelativePath: recoveryPath(this.scope, canonicalPath) } : {})
      })

      this.fileRef = descriptor.fileRef
      this.name = descriptor.displayName
      this.recoverable = extension === '.md' || extension === '.markdown'
      this.current()

      return { id: this.id, name: descriptor.displayName, recovery: this.recoverable ? 'available' : 'unsupported' }
    } catch (error) {
      void this.release()
      throw publicError(error)
    }
  }

  describe(): MatrixTextDocumentDescriptor {
    this.requireRef()

    return { id: this.id, name: this.name!, recovery: this.recoverable ? 'available' : 'unsupported' }
  }

  read(): Promise<WorkspaceTextFileSnapshot> {
    return this.guarded(() => this.currentSnapshot())
  }

  /** Saves atomically through the anchored lease, then re-reads the canonical target. */
  async write(input: { expectedRevision: string; text: string }): Promise<WorkspaceTextFileSnapshot> {
    return this.guarded(async () => {
      const fileRef = this.requireRef()
      const text = input.text.replace(/\r\n/gu, '\n')

      if (text.includes('\0') || text.includes('\r') || Buffer.from(text, 'utf8').toString('utf8') !== text) {
        throw new Error('MATRIX_TEXT_DOCUMENT_UNSUPPORTED')
      }

      const saved = await this.leases.write(fileRef, {
        expectedRevision: input.expectedRevision,
        text: this.newline === '\r\n' ? text.replace(/\n/gu, '\r\n') : text
      })

      const snapshot = await this.currentSnapshot()

      // A foreign writer between publish and read is a conflict, never a silent
      // retarget or a stale acknowledgement to the renderer.
      if (snapshot.revision !== saved.revision) {
        throw new Error('WORKSPACE_CONFLICT')
      }

      return snapshot
    })
  }

  /** Exact current canonical text for an explicitly confirmed Matrix invocation. */
  async capture(): Promise<MatrixTextDocumentCapture> {
    return this.guarded(async () => {
      const snapshot = await this.currentRawSnapshot()

      return { bytes: Buffer.from(snapshot.text, 'utf8'), name: this.name!, revision: snapshot.revision }
    })
  }

  async recoveryRead(): Promise<AtumDocumentRecoveryReadResult> {
    if (!this.recoverable) {
      throw new Error('MATRIX_TEXT_DOCUMENT_RECOVERY_UNSUPPORTED')
    }

    return this.guarded(async () => {
      const result = await this.recoveryJournal.read(this.requireRef())
      this.current()

      return result
    })
  }

  async recoveryWrite(input: AtumDocumentRecoveryWriteInput): Promise<AtumDocumentRecoveryWriteResult> {
    if (!this.recoverable) {
      throw new Error('MATRIX_TEXT_DOCUMENT_RECOVERY_UNSUPPORTED')
    }

    return this.guarded(async () => {
      const result = await this.recoveryJournal.write(this.requireRef(), input)
      this.current()

      return result
    })
  }

  async recoveryDiscard(expectedDraftRevision: string): Promise<AtumDocumentRecoveryDiscardResult> {
    if (!this.recoverable) {
      throw new Error('MATRIX_TEXT_DOCUMENT_RECOVERY_UNSUPPORTED')
    }

    return this.guarded(async () => {
      const result = await this.recoveryJournal.discard(this.requireRef(), expectedDraftRevision)
      this.current()

      return result
    })
  }

  /** Scope loss and reset both spend the selection's opaque lease permanently. */
  async release(): Promise<void> {
    if (this.released) {
      return
    }

    this.released = true
    const fileRef = this.fileRef
    this.fileRef = null
    this.name = null

    if (fileRef) {
      await this.leases.release(fileRef)
    }
  }

  reset(): Promise<void> {
    return this.release()
  }
}
