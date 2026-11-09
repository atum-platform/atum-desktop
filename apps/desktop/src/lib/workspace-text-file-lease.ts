import type {
  AtumDocumentRecoveryDiscardResult,
  AtumDocumentRecoveryReadResult,
  AtumDocumentRecoveryWriteInput,
  AtumDocumentRecoveryWriteResult
} from '../../shared/atum-office/document-recovery'

export interface WorkspaceTextFileRecovery {
  discard: (expectedDraftRevision: string) => Promise<AtumDocumentRecoveryDiscardResult>
  read: () => Promise<AtumDocumentRecoveryReadResult>
  write: (input: AtumDocumentRecoveryWriteInput) => Promise<AtumDocumentRecoveryWriteResult>
}

export interface WorkspaceTextFileLease {
  fileRef: string
  displayName: string
  workspaceRelativePath?: string
  read: () => Promise<{ revision: string; text: string; truncated: boolean }>
  watch: (onRevision: (revision: string) => void) => () => void
  write: (input: { expectedRevision: string; text: string }) => Promise<{ revision: string }>
  preserveSibling: (input: { expectedRevision: string; text: string }) => Promise<{ displayName: string }>
  /** Omitted when connected to an older desktop capability boundary. */
  recovery?: WorkspaceTextFileRecovery
  release: () => Promise<void>
}

export interface WorkspaceTextFileLeaseDescriptor {
  fileRef: string
  displayName: string
  /** Present only for documents inside the chat workspace (Atum Office Phase 0). */
  workspaceRelativePath?: string
}

/** Rebind a persisted opaque descriptor after a renderer reload. The main
 * process remains the authority and rejects descriptors that are stale after
 * release, account rotation, or a full process restart. */
export function workspaceTextFileLeaseFromDescriptor(
  descriptor: WorkspaceTextFileLeaseDescriptor
): WorkspaceTextFileLease {
  const bridge = window.hermesDesktop?.filesystemCapability

  if (!bridge) {
    throw new Error('CAPABILITY_REVOKED')
  }

  const recoveryBridge = bridge.recovery

  const recovery: WorkspaceTextFileRecovery | undefined =
    recoveryBridge?.version === 1
      ? {
          discard: expectedDraftRevision => recoveryBridge.discard(descriptor.fileRef, expectedDraftRevision),
          read: () => recoveryBridge.read(descriptor.fileRef),
          write: input => recoveryBridge.write(descriptor.fileRef, input)
        }
      : undefined

  return {
    ...descriptor,
    read: () => bridge.readTextFile(descriptor.fileRef),
    watch: onRevision => bridge.watchTextFile(descriptor.fileRef, onRevision),
    write: input => bridge.writeTextFile(descriptor.fileRef, input),
    preserveSibling: input => bridge.preserveTextFileSibling(descriptor.fileRef, input),
    ...(recovery ? { recovery } : {}),
    release: () => bridge.releaseTextFile(descriptor.fileRef)
  }
}

/** Renderer shape adapter only; all authority and resources remain in main. */
export async function openWorkspaceTextFileLease(): Promise<WorkspaceTextFileLease | null> {
  const bridge = window.hermesDesktop?.filesystemCapability

  if (!bridge) {
    throw new Error('CAPABILITY_REVOKED')
  }

  const descriptor = await bridge.openTextFile()

  if (!descriptor) {
    return null
  }

  return workspaceTextFileLeaseFromDescriptor(descriptor)
}

/** Atum Office Phase 0: main creates `<baseName> N.md` inside the chat workspace and leases it. */
export async function createWorkspaceDocumentLease(baseName: string): Promise<WorkspaceTextFileLease> {
  const bridge = window.hermesDesktop?.filesystemCapability

  if (!bridge?.createWorkspaceDocument) {
    throw new Error('CAPABILITY_REVOKED')
  }

  return workspaceTextFileLeaseFromDescriptor(await bridge.createWorkspaceDocument({ baseName, extension: '.md' }))
}

export async function importWordDocumentLease(): Promise<{
  lease: WorkspaceTextFileLease
  sourceDisplayName: string
}> {
  const bridge = window.hermesDesktop?.filesystemCapability

  if (!bridge?.importWordDocument) {
    throw new Error('CAPABILITY_REVOKED')
  }

  const result = await bridge.importWordDocument()

  return { lease: workspaceTextFileLeaseFromDescriptor(result.descriptor), sourceDisplayName: result.sourceDisplayName }
}

/** Re-lease a workspace document by its workspace-relative path (after a relaunch or account rotation). */
export async function openWorkspaceTextFileLeaseByPath(relativePath: string): Promise<WorkspaceTextFileLease> {
  const bridge = window.hermesDesktop?.filesystemCapability

  if (!bridge?.openWorkspaceTextFile) {
    throw new Error('CAPABILITY_REVOKED')
  }

  return workspaceTextFileLeaseFromDescriptor(await bridge.openWorkspaceTextFile(relativePath))
}
