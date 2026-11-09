import { statSync } from 'node:fs'
import path from 'node:path'

import { DocxConvertError } from '../src/lib/docx-markdown'

import type { AtumFilesystemCapabilityAuthority } from './atum-filesystem-capability'
import { extractDocxMarkdown } from './docx-extract'
import type { WorkspaceTextFileLeaseProvider } from './workspace-text-file-lease'

export const DOCX_IMPORT_MAX_FILE_BYTES = 64 * 1024 * 1024
export const DOCX_IMPORT_MAX_XML_BYTES = 32 * 1024 * 1024
export const DOCX_IMPORT_LIMITS = { maxBlocks: 20_000, maxChars: 200_000, maxElements: 400_000 } as const
export const DOCX_IMPORT_DIALOG_OPTIONS = {
  properties: ['openFile'] as const,
  filters: [{ name: 'Word document', extensions: ['docx'] }]
}

export type DocxImportErrorCode =
  | 'DOCX_IMPORT_CANCELLED'
  | 'DOCX_IMPORT_TOO_LARGE'
  | 'DOCX_IMPORT_TRUNCATED'
  | 'DOCX_IMPORT_INVALID'
  | 'DOCX_IMPORT_FAILED'

interface ImportDependencies {
  extract?: typeof extractDocxMarkdown
  selectDocx: () => Promise<string | null>
}

export class AtumOfficeImportService {
  constructor(
    private readonly leases: WorkspaceTextFileLeaseProvider,
    private readonly authority: AtumFilesystemCapabilityAuthority,
    private readonly dependencies: ImportDependencies
  ) {}

  /** Import a Word file chosen through the trusted picker, or — from the Files panel — an already-validated path. */
  async importDocx(input: { ownerId: string; sourcePath?: string }): Promise<{
    descriptor: { fileRef: string; displayName: string; workspaceRelativePath?: string }
    sourceDisplayName: string
  }> {
    const started = Date.now()
    let inputBytes = 0
    let outputBytes = 0
    let resultCode: DocxImportErrorCode | 'ok' = 'DOCX_IMPORT_FAILED'

    try {
      const selected = input.sourcePath ?? (await this.dependencies.selectDocx())

      if (!selected) {
        throw new Error('DOCX_IMPORT_CANCELLED')
      }

      if (path.extname(selected).toLocaleLowerCase('en-US') !== '.docx') {
        throw new Error('DOCX_IMPORT_INVALID')
      }

      inputBytes = statSync(selected).size

      if (inputBytes > DOCX_IMPORT_MAX_FILE_BYTES) {
        throw new Error('DOCX_IMPORT_TOO_LARGE')
      }

      // Import is a durable copy, so it uses preview's proven semantic caps but
      // accepts at most 64 MiB on disk and 32 MiB inflated XML. Tests exercise
      // the actual 64 MiB boundary; these ceilings keep peak main-process memory
      // bounded while still accommodating very large text-first Word files.
      const converted = await (this.dependencies.extract ?? extractDocxMarkdown)(selected, {
        limits: DOCX_IMPORT_LIMITS,
        maxFileBytes: DOCX_IMPORT_MAX_FILE_BYTES,
        maxXmlBytes: DOCX_IMPORT_MAX_XML_BYTES
      })

      if (converted.truncated) {
        throw new Error('DOCX_IMPORT_TRUNCATED')
      }

      outputBytes = Buffer.byteLength(converted.markdown, 'utf8')

      const created = this.authority.createWorkspaceTextDocument({
        preferredStem: path.basename(selected, path.extname(selected)),
        text: converted.markdown
      })

      const descriptor = this.leases.openLocal(created.canonicalPath, {
        ownerId: input.ownerId,
        workspaceRelativePath: created.workspaceRelativePath
      })

      resultCode = 'ok'

      return { descriptor, sourceDisplayName: path.basename(selected) }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''

      if (message.startsWith('DOCX_IMPORT_')) {
        resultCode = message as DocxImportErrorCode
      } else if (error instanceof DocxConvertError) {
        resultCode = /\blimit\b|too large|expands to/iu.test(error.message)
          ? 'DOCX_IMPORT_TOO_LARGE'
          : 'DOCX_IMPORT_INVALID'
      } else {
        resultCode = 'DOCX_IMPORT_FAILED'
      }

      throw new Error(resultCode)
    } finally {
      try {
        this.authority.auditOfficeImport({ durationMs: Date.now() - started, inputBytes, outputBytes, resultCode })
      } catch {
        // Audit is best-effort: a full disk must not turn a published file into a reported failure.
      }
    }
  }
}
