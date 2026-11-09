import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { parseDocumentThemeSelectionStrict } from '../shared/atum-office/document-theme'

import type { AtumDocumentRecoveryJournal } from './atum-document-recovery'
import type { AtumFilesystemCapabilityAuthority } from './atum-filesystem-capability'
import { type FilesystemRendererIntent, type FilesystemRendererReadResult } from './atum-filesystem-capability'
import type { AtumOfficeExportService } from './atum-office-export'
import type { AtumOfficeImportService } from './atum-office-import'
import type { WorkspaceTextFileLeaseProvider } from './workspace-text-file-lease'

export const ATUM_FILESYSTEM_IPC_CHANNELS = {
  assistantLeaseAdopt: 'atum:filesystem:assistant-lease-adopt',
  assistantLeaseDismiss: 'atum:filesystem:assistant-lease-dismiss',
  leasePreserveSibling: 'atum:filesystem:lease-preserve-sibling',
  leaseRead: 'atum:filesystem:lease-read',
  leaseRelease: 'atum:filesystem:lease-release',
  leaseRevision: 'atum:filesystem:lease-revision',
  leaseUnwatch: 'atum:filesystem:lease-unwatch',
  leaseWatch: 'atum:filesystem:lease-watch',
  leaseWrite: 'atum:filesystem:lease-write',
  leaseCreateDocument: 'atum:filesystem:lease-create-document',
  leaseOpenWorkspace: 'atum:filesystem:lease-open-workspace',
  recoveryDiscard: 'atum:filesystem:lease-recovery-discard',
  recoveryRead: 'atum:filesystem:lease-recovery-read',
  recoveryWrite: 'atum:filesystem:lease-recovery-write',
  exportDocument: 'atum:filesystem:export-document',
  documentTheme: 'atum:filesystem:document-theme',
  documentThemeSet: 'atum:filesystem:document-theme-set',
  importDocx: 'atum:filesystem:import-docx',
  revealExport: 'atum:filesystem:reveal-export',
  shareExport: 'atum:filesystem:share-export',
  selectTextFile: 'atum:filesystem:select-text-file',
  readIntent: 'atum:filesystem:read-intent',
  selectReadRoot: 'atum:filesystem:select-read-root'
} as const

export interface AtumFilesystemIpcOptions {
  assistantLeases?: {
    adopt(fileRef: string, ownerId: string): { adopted: true }
    assertAccess(fileRef: string, ownerId: string): void
    dismiss(fileRef: string, ownerId: string): Promise<{ released: boolean }>
    release(fileRef: string, ownerId: string): Promise<void>
  }
  assertTrustedSender: (event: IpcMainInvokeEvent) => void
  selectReadRoot: () => Promise<string | null>
  selectTextFile?: () => Promise<string | null>
}

const SAFE_LEASE_ERRORS = new Set([
  'CAPABILITY_DENIED',
  'CAPABILITY_REPLAYED',
  'CAPABILITY_REVOKED',
  'CAPABILITY_SCOPE_ESCAPE',
  'CAPABILITY_STALE',
  'WORKSPACE_CONFLICT',
  'WORKSPACE_CREATE_FAILED',
  'WORKSPACE_FILE_TOO_LARGE',
  'WORKSPACE_OPEN_FAILED',
  'WORKSPACE_PRESERVE_EXHAUSTED',
  'EXPORT_TOO_LARGE',
  'EXPORT_UNSUPPORTED',
  'EXPORT_UNSUPPORTED_FORMAT',
  'EXPORT_SOURCE_CHANGED',
  'EXPORT_THEME_CHANGED',
  'EXPORT_THEME_UNAVAILABLE',
  'DOCUMENT_THEME_INVALID_SELECTION',
  'DOCUMENT_THEME_WRITE_FAILED',
  'DOCUMENT_RECOVERY_ACCESS_REVOKED',
  'DOCUMENT_RECOVERY_CONFLICT',
  'DOCUMENT_RECOVERY_CORRUPT',
  'DOCUMENT_RECOVERY_INVALID_INPUT',
  'DOCUMENT_RECOVERY_NOT_WORKSPACE_DOCUMENT',
  'DOCUMENT_RECOVERY_QUOTA_EXCEEDED',
  'DOCUMENT_RECOVERY_RECORD_TOO_LARGE',
  'DOCUMENT_RECOVERY_STORAGE_FULL',
  'DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE',
  'EXPORT_NOT_WORKSPACE_DOCUMENT',
  'EXPORT_REF_INVALID',
  'EXPORT_PUBLISH_FAILED',
  'DOCX_IMPORT_CANCELLED',
  'DOCX_IMPORT_TOO_LARGE',
  'DOCX_IMPORT_TRUNCATED',
  'DOCX_IMPORT_INVALID',
  'DOCX_IMPORT_FAILED'
])

async function rendererSafeLeaseCall<T>(operation: () => Promise<T> | T): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    const code = error instanceof Error ? error.message : ''

    throw new Error(SAFE_LEASE_ERRORS.has(code) ? code : 'WORKSPACE_IO_FAILED')
  }
}

/** Legacy raw-path channels remain available for ordinary Hermes sessions,
 * but are never an alternate path around an active Atum account authority. */
export function denyLegacyFilesystemIpcWhenAuthorityInstalled(
  event: IpcMainInvokeEvent,
  authority: AtumFilesystemCapabilityAuthority | null,
  assertTrustedSender: (event: IpcMainInvokeEvent) => void
): void {
  if (!authority) {
    return
  }

  assertTrustedSender(event)
  throw new Error('CAPABILITY_DENIED: use an opaque filesystem intent')
}

/**
 * Narrow renderer seam for S2-C. The native picker returns no path: main turns
 * the selection into a one-shot opaque intent and the renderer can only ask to
 * read a relative file through that intent. S4 owns any eventual pane UX.
 */
export function registerAtumFilesystemIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  authority: AtumFilesystemCapabilityAuthority,
  options: AtumFilesystemIpcOptions,
  leases?: WorkspaceTextFileLeaseProvider,
  exports?: AtumOfficeExportService,
  imports?: AtumOfficeImportService,
  recovery?: AtumDocumentRecoveryJournal
): void {
  ipcMain.handle(ATUM_FILESYSTEM_IPC_CHANNELS.selectReadRoot, async event => {
    options.assertTrustedSender(event)
    const account = authority.currentAuthority()

    if (!account) {
      throw new Error('CAPABILITY_REVOKED')
    }

    const selected = await options.selectReadRoot()

    if (!selected) {
      return null
    }

    return authority.issueRendererIntent({ account: account.account, rootPath: selected })
  })
  ipcMain.handle(
    ATUM_FILESYSTEM_IPC_CHANNELS.readIntent,
    async (event, intentId: string, relativePath: string): Promise<FilesystemRendererReadResult> => {
      options.assertTrustedSender(event)

      return authority.readRendererIntent(String(intentId || ''), String(relativePath || ''))
    }
  )

  if (!leases || !options.selectTextFile) {
    return
  }

  const watchers = new Map<string, { fileRef: string; owner: IpcMainInvokeEvent['sender']; stop: () => void }>()

  if (imports) {
    ipcMain.handle(ATUM_FILESYSTEM_IPC_CHANNELS.importDocx, event => {
      options.assertTrustedSender(event)

      return rendererSafeLeaseCall(() => imports.importDocx({ ownerId: String(event.sender.id) }))
    })
  }

  if (exports) {
    ipcMain.handle(ATUM_FILESYSTEM_IPC_CHANNELS.documentTheme, (event, input: unknown) => {
      options.assertTrustedSender(event)
      const fileRef = String((input as { fileRef?: unknown } | null)?.fileRef ?? '')
      const ownerId = String(event.sender.id)
      options.assistantLeases?.assertAccess(fileRef, ownerId)

      // Bounded catalogue values plus a revision; never a path.
      return rendererSafeLeaseCall(() => exports.resolveDocumentTheme(fileRef, ownerId))
    })

    ipcMain.handle(ATUM_FILESYSTEM_IPC_CHANNELS.documentThemeSet, (event, input: unknown) => {
      options.assertTrustedSender(event)
      const request = (input ?? {}) as { fileRef?: unknown; selection?: unknown }
      const fileRef = String(request.fileRef ?? '')
      const ownerId = String(event.sender.id)
      options.assistantLeases?.assertAccess(fileRef, ownerId)
      // Parsed at the boundary: anything off the closed catalogue is refused
      // here, before it can reach the store.
      const selection = request.selection === null ? null : parseDocumentThemeSelectionStrict(request.selection)

      if (request.selection !== null && selection === null) {
        return Promise.reject(new Error('DOCUMENT_THEME_INVALID_SELECTION'))
      }

      return rendererSafeLeaseCall(() => exports.setDocumentTheme(fileRef, ownerId, selection))
    })

    ipcMain.handle(ATUM_FILESYSTEM_IPC_CHANNELS.exportDocument, (event, input: unknown) => {
      options.assertTrustedSender(event)
      const request = (input ?? {}) as { expectedRevision?: unknown; fileRef?: unknown; format?: unknown }
      const fileRef = String(request.fileRef ?? '')
      const ownerId = String(event.sender.id)
      options.assistantLeases?.assertAccess(fileRef, ownerId)

      return rendererSafeLeaseCall(() =>
        exports.exportDocument({
          expectedRevision: typeof request.expectedRevision === 'string' ? request.expectedRevision : undefined,
          fileRef,
          format: String(request.format ?? '') as 'docx' | 'pdf',
          ownerId
        })
      )
    })
    ipcMain.handle(ATUM_FILESYSTEM_IPC_CHANNELS.revealExport, (event, exportRef: unknown) => {
      options.assertTrustedSender(event)

      return rendererSafeLeaseCall(() => exports.revealExport(String(exportRef ?? ''), String(event.sender.id)))
    })
    ipcMain.handle(ATUM_FILESYSTEM_IPC_CHANNELS.shareExport, (event, exportRef: unknown) => {
      options.assertTrustedSender(event)

      return rendererSafeLeaseCall(() => exports.shareExport(String(exportRef ?? ''), String(event.sender.id)))
    })
  }

  ipcMain.handle(ATUM_FILESYSTEM_IPC_CHANNELS.selectTextFile, async event => {
    options.assertTrustedSender(event)
    const selected = await options.selectTextFile!()

    return selected
      ? rendererSafeLeaseCall(() => leases.openLocal(selected, { ownerId: String(event.sender.id) }))
      : null
  })
  // Atum Office Phase 0: the only way a chat creates a document. Main picks the
  // collision-free name inside the account workspace and hands back an opaque
  // lease plus the workspace-relative path; no absolute path crosses to the renderer.
  ipcMain.handle(ATUM_FILESYSTEM_IPC_CHANNELS.leaseCreateDocument, (event, input: unknown) => {
    options.assertTrustedSender(event)
    const request = (input ?? {}) as { baseName?: unknown; extension?: unknown }

    return rendererSafeLeaseCall(() => {
      const created = authority.createWorkspaceTextFile({
        baseName: String(request.baseName ?? ''),
        extension: request.extension === '.txt' ? '.txt' : '.md'
      })

      return leases.openLocal(created.canonicalPath, {
        ownerId: String(event.sender.id),
        workspaceRelativePath: created.workspaceRelativePath
      })
    })
  })
  ipcMain.handle(ATUM_FILESYSTEM_IPC_CHANNELS.leaseOpenWorkspace, (event, relativePath: unknown) => {
    options.assertTrustedSender(event)

    return rendererSafeLeaseCall(() => {
      const resolved = authority.resolveWorkspaceTextFile(String(relativePath ?? ''))

      return leases.openLocal(resolved.canonicalPath, {
        ownerId: String(event.sender.id),
        workspaceRelativePath: resolved.workspaceRelativePath
      })
    })
  })
  ipcMain.handle(ATUM_FILESYSTEM_IPC_CHANNELS.assistantLeaseAdopt, (event, fileRef: string) => {
    options.assertTrustedSender(event)

    if (!options.assistantLeases) {
      throw new Error('CAPABILITY_DENIED')
    }

    return rendererSafeLeaseCall(() => options.assistantLeases!.adopt(String(fileRef || ''), String(event.sender.id)))
  })
  ipcMain.handle(ATUM_FILESYSTEM_IPC_CHANNELS.assistantLeaseDismiss, (event, fileRef: string) => {
    options.assertTrustedSender(event)

    if (!options.assistantLeases) {
      throw new Error('CAPABILITY_DENIED')
    }

    return rendererSafeLeaseCall(() => options.assistantLeases!.dismiss(String(fileRef || ''), String(event.sender.id)))
  })
  ipcMain.handle(ATUM_FILESYSTEM_IPC_CHANNELS.leaseRead, (event, fileRef: string) => {
    options.assertTrustedSender(event)
    options.assistantLeases?.assertAccess(String(fileRef || ''), String(event.sender.id))

    return rendererSafeLeaseCall(() => leases.read(String(fileRef || '')))
  })
  ipcMain.handle(ATUM_FILESYSTEM_IPC_CHANNELS.leaseWrite, (event, fileRef: string, input: unknown) => {
    options.assertTrustedSender(event)
    options.assistantLeases?.assertAccess(String(fileRef || ''), String(event.sender.id))

    return rendererSafeLeaseCall(() =>
      leases.write(String(fileRef || ''), input as { expectedRevision: string; text: string })
    )
  })
  ipcMain.handle(ATUM_FILESYSTEM_IPC_CHANNELS.leasePreserveSibling, (event, fileRef: string, input: unknown) => {
    options.assertTrustedSender(event)
    options.assistantLeases?.assertAccess(String(fileRef || ''), String(event.sender.id))

    return rendererSafeLeaseCall(() =>
      leases.preserveSibling(String(fileRef || ''), input as { expectedRevision: string; text: string })
    )
  })

  if (recovery) {
    const assertRecoveryOwner = (event: IpcMainInvokeEvent, fileRef: string) => {
      const ownerId = String(event.sender.id)

      // Resolves main-owned account/workspace/document identity and refuses a
      // foreign renderer before the journal sees an opaque file reference.
      leases.resolveDocumentRecoveryLease(fileRef, ownerId)
    }

    ipcMain.handle(ATUM_FILESYSTEM_IPC_CHANNELS.recoveryRead, (event, fileRef: unknown) => {
      options.assertTrustedSender(event)
      const normalizedFileRef = String(fileRef ?? '')

      return rendererSafeLeaseCall(() => {
        assertRecoveryOwner(event, normalizedFileRef)

        return recovery.read(normalizedFileRef)
      })
    })
    ipcMain.handle(ATUM_FILESYSTEM_IPC_CHANNELS.recoveryWrite, (event, fileRef: unknown, input: unknown) => {
      options.assertTrustedSender(event)
      const normalizedFileRef = String(fileRef ?? '')

      const request = (input ?? {}) as {
        baseRevision?: unknown
        editorRevision?: unknown
        expectedDraftRevision?: unknown
        text?: unknown
      }

      let expectedDraftRevision: string | null = ''

      if (request.expectedDraftRevision === null) {
        expectedDraftRevision = null
      } else if (typeof request.expectedDraftRevision === 'string') {
        expectedDraftRevision = request.expectedDraftRevision
      }

      return rendererSafeLeaseCall(() => {
        assertRecoveryOwner(event, normalizedFileRef)

        return recovery.write(normalizedFileRef, {
          baseRevision: typeof request.baseRevision === 'string' ? request.baseRevision : '',
          editorRevision: typeof request.editorRevision === 'string' ? request.editorRevision : '',
          expectedDraftRevision,
          text: typeof request.text === 'string' ? request.text : ''
        })
      })
    })
    ipcMain.handle(
      ATUM_FILESYSTEM_IPC_CHANNELS.recoveryDiscard,
      (event, fileRef: unknown, expectedDraftRevision: unknown) => {
        options.assertTrustedSender(event)
        const normalizedFileRef = String(fileRef ?? '')

        return rendererSafeLeaseCall(() => {
          assertRecoveryOwner(event, normalizedFileRef)

          return recovery.discard(normalizedFileRef, typeof expectedDraftRevision === 'string' ? expectedDraftRevision : '')
        })
      }
    )
  }

  ipcMain.handle(ATUM_FILESYSTEM_IPC_CHANNELS.leaseWatch, (event, fileRef: string, subscriptionId: string) => {
    options.assertTrustedSender(event)
    const key = String(subscriptionId || '')

    if (!key || watchers.has(key)) {
      throw new Error('CAPABILITY_REPLAYED')
    }

    const normalizedFileRef = String(fileRef || '')
    options.assistantLeases?.assertAccess(normalizedFileRef, String(event.sender.id))

    const stopLeaseWatch = leases.watch(normalizedFileRef, revision => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(ATUM_FILESYSTEM_IPC_CHANNELS.leaseRevision, { revision, subscriptionId: key })
      }
    })

    const stop = () => {
      stopLeaseWatch()
      event.sender.off('destroyed', stop)
      watchers.delete(key)
    }

    event.sender.once('destroyed', stop)
    watchers.set(key, { fileRef: normalizedFileRef, owner: event.sender, stop })

    return { watching: true }
  })
  ipcMain.handle(ATUM_FILESYSTEM_IPC_CHANNELS.leaseUnwatch, (event, subscriptionId: string) => {
    options.assertTrustedSender(event)
    const key = String(subscriptionId || '')
    const watcher = watchers.get(key)

    if (watcher && watcher.owner !== event.sender) {
      throw new Error('CAPABILITY_DENIED')
    }

    watcher?.stop()

    return { watching: false }
  })
  ipcMain.handle(ATUM_FILESYSTEM_IPC_CHANNELS.leaseRelease, async (event, fileRef: string) => {
    options.assertTrustedSender(event)
    const normalizedFileRef = String(fileRef || '')

    for (const watcher of [...watchers.values()]) {
      if (watcher.fileRef === normalizedFileRef && watcher.owner === event.sender) {
        watcher.stop()
      }
    }

    await rendererSafeLeaseCall(() =>
      options.assistantLeases
        ? options.assistantLeases.release(normalizedFileRef, String(event.sender.id))
        : leases.release(normalizedFileRef)
    )

    return { released: true }
  })
}

export type AtumFilesystemRendererBridge = {
  readText: (intentId: string, relativePath: string) => Promise<FilesystemRendererReadResult>
  selectReadRoot: () => Promise<FilesystemRendererIntent | null>
}
