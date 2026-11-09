import {
  type DocumentThemeSelection,
  type ResolvedDocumentTheme,
  resolveDocumentTheme
} from '../../shared/atum-office/document-theme'

export type WorkspaceDocumentExportFormat = 'docx' | 'pdf'

export interface WorkspaceDocumentExportResult<Format extends WorkspaceDocumentExportFormat = 'docx'> {
  exportRef: string
  displayName: string
  workspaceRelativePath: string
  format: Format
  byteSize: number
}

function bridge() {
  const capability = window.hermesDesktop.filesystemCapability

  if (!capability) {
    throw new Error('CAPABILITY_DENIED')
  }

  return capability
}

export function exportWorkspaceDocument<Format extends WorkspaceDocumentExportFormat>(
  fileRef: string,
  format: Format,
  expectedRevision?: string
): Promise<WorkspaceDocumentExportResult<Format>> {
  return bridge().exportDocument({ expectedRevision, fileRef, format }) as Promise<
    WorkspaceDocumentExportResult<Format>
  >
}

export function revealWorkspaceDocumentExport(exportRef: string): Promise<{ revealed: true }> {
  return bridge().revealExport(exportRef)
}

export function shareWorkspaceDocumentExport(exportRef: string): Promise<{ shared: true }> {
  return bridge().shareExport(exportRef)
}

/**
 * The theme the canvas should render for a lease. Never rejects: a canvas has
 * to draw something, so an unconfigured bridge, a revoked account or a broken
 * store all fall back to the inferred default, exactly as the export pin does.
 */
export async function resolveWorkspaceDocumentTheme(fileRef: string): Promise<ResolvedDocumentTheme> {
  try {
    const snapshot = await bridge().documentTheme({ fileRef })

    return Object.freeze({
      ...snapshot,
      headingSizesPt: Object.freeze([...snapshot.headingSizesPt])
    }) as ResolvedDocumentTheme
  } catch {
    return resolveDocumentTheme(null)
  }
}

/** Choose or clear a document's theme. Rejects with a safe code the pane can show. */
export async function setWorkspaceDocumentTheme(
  fileRef: string,
  selection: DocumentThemeSelection | null
): Promise<{ theme: ResolvedDocumentTheme; persisted: boolean }> {
  const result = await bridge().documentThemeSet({ fileRef, selection })

  return {
    persisted: result.persisted,
    theme: Object.freeze({
      ...result.theme,
      headingSizesPt: Object.freeze([...result.theme.headingSizesPt])
    }) as ResolvedDocumentTheme
  }
}
