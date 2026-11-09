import {
  importWordDocumentLease,
  openWorkspaceTextFileLeaseByPath,
  type WorkspaceTextFileLease,
  type WorkspaceTextFileLeaseDescriptor
} from '@/lib/workspace-text-file-lease'
import type { PreviewTarget } from '@/store/preview'
import {
  $workbenchScope,
  closeWorkbenchTab,
  openPreviewWorkbenchTab,
  previewWorkbenchTabId,
  revealWorkbenchTab
} from '@/store/workbench-tabs'
import { workspaceTextFileTarget } from '@/store/workspace-text-files'

/**
 * Atum Office Phase 0 — documents in a chat's action panel.
 *
 * A document is a leased text file inside the account workspace, shown as a
 * `preview` workbench tab whose target carries the opaque lease descriptor.
 * Creation and re-leasing happen in main; this module only turns the returned
 * descriptor into a tab in the chat's scope.
 */

function descriptorOf(lease: WorkspaceTextFileLease): WorkspaceTextFileLeaseDescriptor {
  return lease.workspaceRelativePath
    ? { displayName: lease.displayName, fileRef: lease.fileRef, workspaceRelativePath: lease.workspaceRelativePath }
    : { displayName: lease.displayName, fileRef: lease.fileRef }
}

export type ChatDocumentTarget = PreviewTarget & { workspaceTextFile: WorkspaceTextFileLeaseDescriptor }

export function isChatDocumentTarget(target: PreviewTarget | null | undefined): target is ChatDocumentTarget {
  return Boolean(target?.workspaceTextFile?.workspaceRelativePath)
}

/** Import Word through main, then open the resulting Markdown lease exactly like a new document. */
export async function importChatDocument(scopeKey = $workbenchScope.get()): Promise<string> {
  const { lease } = await importWordDocumentLease()
  const target = workspaceTextFileTarget(descriptorOf(lease))
  const id = openPreviewWorkbenchTab(target, { restore: 'persistent', scopeKey, title: target.label })
  revealWorkbenchTab(id)

  return id
}

/** Replace a stale lease tab (after relaunch) with a fresh lease on the same workspace document. */
export async function reopenChatDocument(scopeKey: string, stale: ChatDocumentTarget): Promise<string> {
  const lease = await openWorkspaceTextFileLeaseByPath(stale.workspaceTextFile.workspaceRelativePath!)
  const target = workspaceTextFileTarget(descriptorOf(lease))

  closeWorkbenchTab(previewWorkbenchTabId(stale, scopeKey))
  const id = openPreviewWorkbenchTab(target, { restore: 'persistent', scopeKey, title: target.label })

  revealWorkbenchTab(id)

  return id
}
