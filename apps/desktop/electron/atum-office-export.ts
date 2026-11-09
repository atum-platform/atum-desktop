import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

import type { BrowserWindow, WebContents } from 'electron'

import {
  type DocumentThemeSelection,
  type ResolvedDocumentTheme,
  resolveDocumentTheme
} from '../shared/atum-office/document-theme'
import { pageMarginsInches, pagePaperInches } from '../shared/atum-office/units'
import { markdownToDocumentHtml, markdownToDocx } from '../src/lib/markdown-export'

import type { AtumDocumentThemeStore } from './atum-document-theme'
import type { AtumFilesystemCapabilityAuthority, FilesystemAccountEnvelope } from './atum-filesystem-capability'
import { AtumOfficePdfError, type AtumOfficePdfPrinter } from './atum-office-pdf'
import {
  commitAnchoredBinaryPublish,
  fileIdentity,
  type WorkspaceTextFileLeaseProvider
} from './workspace-text-file-lease'

const MAX_DOCX_BYTES = 32 * 1024 * 1024
const MAX_PDF_BYTES = 64 * 1024 * 1024

export type AtumOfficeExportFormat = 'docx' | 'pdf'
export interface AtumOfficeExportResult {
  exportRef: string
  displayName: string
  workspaceRelativePath: string
  format: AtumOfficeExportFormat
  byteSize: number
}

interface ExportRecord {
  account: FilesystemAccountEnvelope
  canonicalParent: string
  canonicalPath: string
  fileIdentity: string
  ownerId: string
  sha256: string
  operations: readonly ['reveal', 'share']
}

export class AtumOfficeExportService {
  private readonly refs = new Map<string, ExportRecord>()
  private readonly ownerHooks = new Set<string>()

  constructor(
    private readonly leases: WorkspaceTextFileLeaseProvider,
    private readonly authority: AtumFilesystemCapabilityAuthority,
    private readonly pdfPrinter: AtumOfficePdfPrinter,
    private readonly options: {
      showItemInFolder: (canonicalPath: string) => void
      shareFile: (canonicalPath: string, window?: BrowserWindow) => void
      ownerWindow?: (ownerId: string) => BrowserWindow | undefined
      ownerContents?: (ownerId: string) => Pick<WebContents, 'isDestroyed' | 'once'> | undefined
      beforePublish?: () => void
      now?: () => number
      /** Resolves the document's presentation theme. Absent in embeddings without an account. */
      documentThemes?: Pick<AtumDocumentThemeStore, 'clearFor' | 'lastMutationDurable' | 'resolveFor' | 'setFor'>
    }
  ) {}

  async exportDocument(input: {
    fileRef: string
    format: 'docx' | 'pdf'
    ownerId: string
    expectedRevision?: string
  }): Promise<AtumOfficeExportResult> {
    const started = (this.options.now ?? Date.now)()
    let inputBytes = 0
    let outputBytes = 0
    let resultCode = 'EXPORT_PUBLISH_FAILED'
    let pdfPublishing = false
    let theme: ResolvedDocumentTheme = resolveDocumentTheme(null)

    try {
      if (input.format !== 'docx' && input.format !== 'pdf') {
        throw new Error('EXPORT_UNSUPPORTED_FORMAT')
      }

      // Bind the owner first so a window destroyed mid-render cancels its own jobs.
      this.bindOwner(input.ownerId)

      if (this.ownerGone(input.ownerId)) {
        throw new Error('EXPORT_OWNER_DESTROYED')
      }

      const source = this.leases.resolveLocalWorkspaceExportSource(input.fileRef, input.ownerId)
      // Pin the theme once, beside the document revision, so a theme changed
      // mid-export cannot land half-applied. The writers consume it from A1;
      // today it is recorded so the resolution is observable end to end.
      theme = this.resolveTheme(source)
      const snapshot = this.leases.readForLocalWorkspaceExport(input.fileRef)

      // The pane may pin the revision it showed when the person chose
      // "export the saved version"; anything newer is a conflict, not a surprise.
      if (input.expectedRevision && snapshot.revision !== input.expectedRevision) {
        throw new Error('EXPORT_SOURCE_CHANGED')
      }

      inputBytes = Buffer.byteLength(snapshot.text, 'utf8')
      const stem = source.displayName.slice(0, -path.extname(source.displayName).length)
      let bytes: Uint8Array

      if (input.format === 'pdf') {
        const html = markdownToDocumentHtml(snapshot.text, { locale: 'vi', theme, title: stem })
        const paper = pagePaperInches(theme.pageSize)
        bytes = await this.pdfPrinter.render({
          html,
          ownerId: input.ownerId,
          page: { height: paper.height, margins: pageMarginsInches(theme.marginMm), width: paper.width },
          title: stem
        })
      } else {
        bytes = markdownToDocx(snapshot.text, { theme, title: stem })
      }

      this.leases.assertLocalWorkspaceExportRevision(input.fileRef, snapshot.revision)
      this.assertThemeUnchanged(source, theme)

      if (this.ownerGone(input.ownerId)) {
        throw new Error('EXPORT_OWNER_DESTROYED')
      }

      pdfPublishing = input.format === 'pdf'

      const published = commitAnchoredBinaryPublish(source, `${stem}.${input.format}`, bytes, {
        maxBytes: input.format === 'pdf' ? MAX_PDF_BYTES : MAX_DOCX_BYTES,
        beforeCommit: () => {
          this.options.beforePublish?.()
          this.leases.assertLocalWorkspaceExportRevision(input.fileRef, snapshot.revision)
          this.assertThemeUnchanged(source, theme)
        }
      })

      outputBytes = published.byteSize
      const exportRef = randomBytes(32).toString('base64url')
      this.refs.set(exportRef, {
        account: source.account,
        canonicalParent: source.canonicalParent,
        canonicalPath: published.canonicalPath,
        fileIdentity: published.fileIdentity,
        ownerId: input.ownerId,
        sha256: published.sha256,
        operations: ['reveal', 'share']
      })
      this.bindOwner(input.ownerId)
      resultCode = 'ok'

      return {
        exportRef,
        displayName: published.displayName,
        workspaceRelativePath: path
          .join(path.dirname(source.workspaceRelativePath), published.displayName)
          .split(path.sep)
          .join('/'),
        format: input.format,
        byteSize: published.byteSize
      }
    } catch (error) {
      // A fence conflict is the same event whatever the format; without this the
      // PDF branch would relabel it PDF_PUBLISH_FAILED and hide the real cause.
      const fenceCode =
        error instanceof Error &&
        ['EXPORT_SOURCE_CHANGED', 'EXPORT_THEME_CHANGED', 'EXPORT_THEME_UNAVAILABLE'].includes(error.message)
          ? error.message
          : null

      resultCode =
        fenceCode ??
        (error instanceof AtumOfficePdfError
          ? `PDF_${error.stage.toUpperCase()}_FAILED`
          : input.format === 'pdf' && pdfPublishing
            ? 'PDF_PUBLISH_FAILED'
            : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
              ? error.code
              : error instanceof Error
                ? error.message
                : resultCode)
      throw error
    } finally {
      try {
        this.authority.auditOfficeExport({
          durationMs: Math.max(0, (this.options.now ?? Date.now)() - started),
          format: input.format,
          inputBytes,
          operation: 'export-document',
          outputBytes,
          resultCode,
          themeId: theme.id,
          themeRevision: theme.revision,
          themeSchemaVersion: theme.schemaVersion
        })
      } catch {
        // Audit is best-effort: a full disk must not turn a published file into a reported failure.
      }
    }
  }

  /**
   * A theme is presentation, so a store that is missing, corrupt or throwing
   * degrades to the default rather than failing an export the person asked for.
   */
  private resolveTheme(source: {
    account: FilesystemAccountEnvelope
    workspaceRelativePath: string
  }): ResolvedDocumentTheme {
    try {
      return (
        this.options.documentThemes?.resolveFor({
          account: source.account,
          workspaceRelativePath: source.workspaceRelativePath
        }) ?? resolveDocumentTheme(null)
      )
    } catch {
      return resolveDocumentTheme(null)
    }
  }

  /**
   * The theme fence, deliberately separate from the document revision fence.
   *
   * A theme edited between the pin and the commit would land half-applied, so
   * it is re-resolved and compared at the same two points the document revision
   * is, and always *after* the document assert: the lease assert throws
   * CAPABILITY_STALE on revocation, and checking the theme first would turn a
   * sign-out mid-export into a spurious theme conflict.
   *
   * `(id, revision)` is a total discriminator because the store mints every
   * revision from one monotonic counter and a cleared document resolves to
   * revision 0. Unlike `resolveTheme` this does NOT fall back on failure in
   * either direction: comparing against the default would manufacture a
   * conflict, and treating a throw as "unchanged" would publish without having
   * established anything. A configured store that throws fails the export
   * closed; only an embedding with no store at all skips the check.
   */
  private assertThemeUnchanged(
    source: { account: FilesystemAccountEnvelope; workspaceRelativePath: string },
    pinned: ResolvedDocumentTheme
  ): void {
    const store = this.options.documentThemes

    if (!store) {
      return
    }

    let current: ResolvedDocumentTheme

    try {
      current = store.resolveFor({ account: source.account, workspaceRelativePath: source.workspaceRelativePath })
    } catch {
      throw new Error('EXPORT_THEME_UNAVAILABLE')
    }

    if (current.id !== pinned.id || current.revision !== pinned.revision) {
      throw new Error('EXPORT_THEME_CHANGED')
    }
  }

  /**
   * The theme the canvas should show for an open lease: the same resolution
   * the export pins, so the person reads what the file will carry. Fail-soft
   * like the pin — a canvas must always be able to render.
   */
  resolveDocumentTheme(fileRef: string, ownerId: string): ResolvedDocumentTheme {
    const source = this.leases.resolveLocalWorkspaceExportSource(fileRef, ownerId)

    return this.resolveTheme(source)
  }

  /**
   * Choose (or clear) a document's theme on behalf of the renderer that owns
   * the lease. Owner-bound through the same source resolution the export uses.
   * Returns the newly resolved snapshot so the pane restyles without a refetch,
   * and whether it was made durable: the store keeps a choice for the session
   * even when the disk write fails, and the person deserves to know which.
   */
  setDocumentTheme(
    fileRef: string,
    ownerId: string,
    selection: DocumentThemeSelection | null
  ): { theme: ResolvedDocumentTheme; persisted: boolean } {
    const source = this.leases.resolveLocalWorkspaceExportSource(fileRef, ownerId)
    const store = this.options.documentThemes

    if (!store) {
      throw new Error('CAPABILITY_REVOKED')
    }

    const target = { account: source.account, workspaceRelativePath: source.workspaceRelativePath }

    try {
      if (selection === null) {
        store.clearFor(target)
      } else {
        store.setFor(target, selection)
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : ''

      throw new Error(code === 'DOCUMENT_THEME_INVALID_SELECTION' ? code : 'DOCUMENT_THEME_WRITE_FAILED')
    }

    // Operation-scoped: an earlier, unrelated failure must not mark this one lost.
    return { persisted: store.lastMutationDurable, theme: store.resolveFor(target) }
  }

  revealExport(exportRef: string, ownerId: string): { revealed: true } {
    const record = this.requireRef(exportRef, ownerId)
    this.options.showItemInFolder(record.canonicalPath)

    return { revealed: true }
  }

  shareExport(exportRef: string, ownerId: string): { shared: true } {
    const record = this.requireRef(exportRef, ownerId)
    this.options.shareFile(record.canonicalPath, this.options.ownerWindow?.(ownerId))

    return { shared: true }
  }

  revokeAccount(account: FilesystemAccountEnvelope): void {
    this.pdfPrinter.cancelAll('CAPABILITY_REVOKED')

    for (const [key, record] of this.refs) {
      if (
        record.account.accountId === account.accountId &&
        record.account.accountGeneration === account.accountGeneration
      ) {
        this.refs.delete(key)
      }
    }
  }

  revokeOwner(ownerId: string): void {
    this.pdfPrinter.cancelOwner(ownerId, 'EXPORT_OWNER_DESTROYED')

    for (const [key, record] of this.refs) {
      if (record.ownerId === ownerId) {
        this.refs.delete(key)
      }
    }

    this.ownerHooks.delete(ownerId)
  }

  /** With an owner lookup configured, an owner that cannot be found is gone (fail closed). */
  private ownerGone(ownerId: string): boolean {
    if (!this.options.ownerContents) {
      return false
    }

    const contents = this.options.ownerContents(ownerId)

    return !contents || contents.isDestroyed()
  }

  private bindOwner(ownerId: string): void {
    if (this.ownerHooks.has(ownerId)) {
      return
    }

    const contents = this.options.ownerContents?.(ownerId)

    if (!contents || contents.isDestroyed()) {
      return
    }

    this.ownerHooks.add(ownerId)
    contents.once('destroyed', () => this.revokeOwner(ownerId))
  }

  private requireRef(exportRef: string, ownerId: string): ExportRecord {
    const record = this.refs.get(exportRef)
    const current = this.authority.currentAuthority()

    if (
      !record ||
      record.ownerId !== ownerId ||
      !current ||
      current.account.accountId !== record.account.accountId ||
      current.account.accountGeneration !== record.account.accountGeneration
    ) {
      throw new Error('EXPORT_REF_INVALID')
    }

    let stat: ReturnType<typeof lstatSync>

    try {
      stat = lstatSync(record.canonicalPath)
    } catch {
      throw new Error('EXPORT_REF_INVALID')
    }

    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      fileIdentity(stat) !== record.fileIdentity ||
      createHash('sha256').update(readFileSync(record.canonicalPath)).digest('base64url') !== record.sha256
    ) {
      throw new Error('EXPORT_REF_INVALID')
    }

    return record
  }
}
