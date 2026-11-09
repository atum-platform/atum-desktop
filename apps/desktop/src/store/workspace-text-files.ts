import { revealTreePane } from '@/components/pane-shell/tree/store'
import { persistentAtom } from '@/lib/persisted'
import {
  openWorkspaceTextFileLease,
  type WorkspaceTextFileLease,
  type WorkspaceTextFileLeaseDescriptor
} from '@/lib/workspace-text-file-lease'

import { notifyError } from './notifications'
import type { PreviewTarget } from './preview'
import { $dirtyPreviewUrls } from './preview-edit'
import { registerWorkbenchTabDisposer, registerWorkbenchTabEvictionGuard } from './workbench-tabs'

export interface WorkspaceTextFileTab {
  id: `workspace-file:${string}`
  target: PreviewTarget & { workspaceTextFile: WorkspaceTextFileLeaseDescriptor }
}

type CloseGuard = () => boolean | Promise<boolean>

const STORAGE_KEY = 'hermes.desktop.workspaceTextFileTabs.v1'
const closeGuards = new Map<string, CloseGuard>()

function extension(name: string): string {
  const index = name.lastIndexOf('.')

  return index === -1 ? '' : name.slice(index).toLowerCase()
}

function isDescriptor(value: unknown): value is WorkspaceTextFileLeaseDescriptor {
  if (!value || typeof value !== 'object') {
    return false
  }

  const row = value as Record<string, unknown>

  return typeof row.fileRef === 'string' && row.fileRef.length > 0 && typeof row.displayName === 'string'
}

function isWorkspaceTextFileTab(value: unknown): value is WorkspaceTextFileTab {
  if (!value || typeof value !== 'object') {
    return false
  }

  const row = value as Record<string, unknown>
  const target = row.target as Record<string, unknown> | undefined

  return (
    typeof row.id === 'string' &&
    row.id.startsWith('workspace-file:') &&
    target?.kind === 'file' &&
    target.previewKind === 'text' &&
    typeof target.url === 'string' &&
    isDescriptor(target.workspaceTextFile)
  )
}

export const $workspaceTextFileTabs = persistentAtom<WorkspaceTextFileTab[]>(STORAGE_KEY, [], {
  decode: raw => {
    const parsed = JSON.parse(raw) as unknown

    return Array.isArray(parsed) ? parsed.filter(isWorkspaceTextFileTab) : []
  },
  encode: tabs => JSON.stringify(tabs)
})

export function workspaceTextFilePaneId(fileRef: string): `workspace-file:${string}` {
  return `workspace-file:${fileRef}`
}

export function workspaceTextFileTarget(
  descriptor: WorkspaceTextFileLeaseDescriptor
): PreviewTarget & { workspaceTextFile: WorkspaceTextFileLeaseDescriptor } {
  const ext = extension(descriptor.displayName)

  return {
    kind: 'file',
    label: descriptor.displayName,
    language: ext === '.md' || ext === '.markdown' ? 'markdown' : 'text',
    previewKind: 'text',
    source: `workspace-file:${descriptor.fileRef}`,
    url: `workspace-file:${descriptor.fileRef}`,
    workspaceTextFile: descriptor
  }
}

export function isWorkspaceTextFileTarget(
  target: PreviewTarget | null | undefined
): target is PreviewTarget & { workspaceTextFile: WorkspaceTextFileLeaseDescriptor } {
  return Boolean(target?.workspaceTextFile && isDescriptor(target.workspaceTextFile))
}

export function registerWorkspaceTextFileTarget(target: PreviewTarget): WorkspaceTextFileTab | null {
  if (!isWorkspaceTextFileTarget(target)) {
    return null
  }

  const id = workspaceTextFilePaneId(target.workspaceTextFile.fileRef)
  const tab: WorkspaceTextFileTab = { id, target }
  const current = $workspaceTextFileTabs.get()
  const index = current.findIndex(item => item.id === id)

  $workspaceTextFileTabs.set(index === -1 ? [...current, tab] : current.map((item, i) => (i === index ? tab : item)))
  revealTreePane(id)

  return tab
}

/** Track a lease the unified Atum workbench renders itself (no tree pane to
 * reveal), so the pane's dirty-close guard and release lifecycle still apply. */
export function trackWorkspaceTextFileTarget(
  target: PreviewTarget & { workspaceTextFile: WorkspaceTextFileLeaseDescriptor }
): WorkspaceTextFileTab {
  const id = workspaceTextFilePaneId(target.workspaceTextFile.fileRef)
  const tab: WorkspaceTextFileTab = { id, target }
  const current = $workspaceTextFileTabs.get()
  const index = current.findIndex(item => item.id === id)

  $workspaceTextFileTabs.set(index === -1 ? [...current, tab] : current.map((item, i) => (i === index ? tab : item)))

  return tab
}

export async function openWorkspaceTextFileTab(): Promise<WorkspaceTextFileTab | null> {
  const existing = $workspaceTextFileTabs.get()[0]

  if (existing) {
    revealTreePane(existing.id)

    return existing
  }

  let lease: WorkspaceTextFileLease | null

  try {
    lease = await openWorkspaceTextFileLease()
  } catch (error) {
    notifyError(error, 'Could not open the text file')

    return null
  }

  return lease ? registerWorkspaceTextFileTarget(workspaceTextFileTarget(lease)) : null
}

export function registerWorkspaceTextFileCloseGuard(fileRef: string, guard: CloseGuard): () => void {
  closeGuards.set(fileRef, guard)

  return () => {
    if (closeGuards.get(fileRef) === guard) {
      closeGuards.delete(fileRef)
    }
  }
}

export async function requestCloseWorkspaceTextFileTab(fileRef: string): Promise<boolean> {
  const guard = closeGuards.get(fileRef)

  if (guard && !(await guard())) {
    return false
  }

  await removeWorkspaceTextFileTab(fileRef, true)

  return true
}

export async function removeWorkspaceTextFileTab(fileRef: string, release: boolean): Promise<void> {
  const current = $workspaceTextFileTabs.get()
  const tab = current.find(item => item.target.workspaceTextFile.fileRef === fileRef)

  if (!tab) {
    return
  }

  if (release) {
    const descriptor = tab.target.workspaceTextFile
    const bridge = window.hermesDesktop?.filesystemCapability

    await bridge?.releaseTextFile(descriptor.fileRef).catch(() => undefined)
  }

  closeGuards.delete(fileRef)
  $workspaceTextFileTabs.set(current.filter(item => item.id !== tab.id))
}

export async function replaceWorkspaceTextFileTab(
  staleFileRef: string,
  lease: WorkspaceTextFileLease
): Promise<WorkspaceTextFileTab> {
  await removeWorkspaceTextFileTab(staleFileRef, true)

  return registerWorkspaceTextFileTarget(workspaceTextFileTarget(lease))!
}

// The unified Atum workbench renders leases as preview tabs. Whatever removes
// such a tab — close, scope teardown, eviction, reset — must release the
// main-owned lease, and a tab holding unsaved edits is never evicted quietly.
registerWorkbenchTabDisposer(tab => {
  if (tab.surface.kind === 'preview' && isWorkspaceTextFileTarget(tab.surface.target)) {
    void removeWorkspaceTextFileTab(tab.surface.target.workspaceTextFile.fileRef, true)
  }
})

registerWorkbenchTabEvictionGuard(tab =>
  !(tab.surface.kind === 'preview' && isWorkspaceTextFileTarget(tab.surface.target) && $dirtyPreviewUrls.get()[tab.surface.target.url])
)
