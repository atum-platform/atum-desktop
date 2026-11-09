/** Opaque draft snapshots returned through the lease capability boundary. */
export interface AtumDocumentRecoveryDraft {
  baseRevision: string
  documentId: string
  draftRevision: string
  editorRevision: string
  text: string
  updatedAt: string
  workspaceRelativePath: string
}

export interface AtumDocumentRecoveryWriteInput {
  baseRevision: string
  editorRevision: string
  /** `null` creates a record only when none exists; otherwise this is CAS. */
  expectedDraftRevision: string | null
  text: string
}

export type AtumDocumentRecoveryReadResult =
  | { outcome: 'absent'; record: null }
  | { outcome: 'present'; record: AtumDocumentRecoveryDraft }

export type AtumDocumentRecoveryWriteResult =
  | { outcome: 'saved'; record: AtumDocumentRecoveryDraft }
  | { outcome: 'stale'; record: AtumDocumentRecoveryDraft }

export type AtumDocumentRecoveryDiscardResult =
  | { outcome: 'absent' | 'discarded'; record: null }
  | { outcome: 'stale'; record: AtumDocumentRecoveryDraft }

/** Versioned optional capability: absent on old desktop mains/preloads. */
export interface AtumDocumentRecoveryCapabilityV1 {
  version: 1
  discard: (fileRef: string, expectedDraftRevision: string) => Promise<AtumDocumentRecoveryDiscardResult>
  read: (fileRef: string) => Promise<AtumDocumentRecoveryReadResult>
  write: (fileRef: string, input: AtumDocumentRecoveryWriteInput) => Promise<AtumDocumentRecoveryWriteResult>
}
