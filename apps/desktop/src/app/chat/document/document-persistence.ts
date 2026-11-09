import type { WorkspaceTextFileLease } from '@/lib/workspace-text-file-lease'

export interface DocumentWriteSnapshot {
  text: string
  baseRevision: string
  editorRevision: string
  expectedDraftRevision: string | null
}

/** One immutable snapshot crosses both persistence boundaries. The caller
 * serializes calls and only marks this captured revision acknowledged. */
export async function persistDocumentSnapshot(
  lease: WorkspaceTextFileLease,
  input: DocumentWriteSnapshot,
  onJournaled: (revision: string) => void,
  onRecoveryUnavailable: () => void = () => undefined
): Promise<{ revision: string; draftRevision: string | null }> {
  let draftRevision: string | null = null

  if (lease.recovery) {
    try {
      const journal = await lease.recovery.write(input)

      if (journal.outcome !== 'saved') {
        throw new Error('DOCUMENT_RECOVERY_CONFLICT')
      }

      draftRevision = journal.record.draftRevision
      // Publish before the file write: a retry must compare against this revision.
      onJournaled(draftRevision)
    } catch (error) {
      if (!isRecoveryUnavailable(error)) {throw error}
      // The user can still save the captured buffer when recovery storage is
      // unavailable. Never weaken the file's own expected-revision fence.
      onRecoveryUnavailable()
      draftRevision = input.expectedDraftRevision
    }
  }

  const result = await lease.write({ expectedRevision: input.baseRevision, text: input.text })

  return { revision: result.revision, draftRevision }
}

export function isRecoveryUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)

  return /(?:^|[\s:])(DOCUMENT_RECOVERY_(?:RECORD_TOO_LARGE|QUOTA_EXCEEDED|STORAGE_UNAVAILABLE|STORAGE_FULL))(?:$|[\s.])/.test(
    message
  )
}
