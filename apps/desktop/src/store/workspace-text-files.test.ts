import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setPreviewDirty } from '@/store/preview-edit'
import { $workbenchTabs, closeWorkbenchScope, openPreviewWorkbenchTab, resetWorkbenchTabs } from '@/store/workbench-tabs'
import { $workspaceTextFileTabs, trackWorkspaceTextFileTarget, workspaceTextFileTarget } from '@/store/workspace-text-files'

describe('workspace text file leases in the unified workbench', () => {
  const releaseTextFile = vi.fn(async () => undefined)

  beforeEach(() => {
    resetWorkbenchTabs()
    $workspaceTextFileTabs.set([])
    releaseTextFile.mockClear()
    Object.assign(window, { hermesDesktop: { filesystemCapability: { releaseTextFile } } })
  })

  afterEach(() => resetWorkbenchTabs())

  function openLease(fileRef: string, scopeKey = 'scope-a') {
    const target = workspaceTextFileTarget({ displayName: `${fileRef}.md`, fileRef })
    trackWorkspaceTextFileTarget(target)

    return { id: openPreviewWorkbenchTab(target, { restore: 'session', scopeKey }), target }
  }

  it('releases the lease when the scope is torn down', async () => {
    openLease('lease-a')
    closeWorkbenchScope('scope-a')

    await vi.waitFor(() => {
      expect(releaseTextFile).toHaveBeenCalledWith('lease-a')
      expect($workspaceTextFileTabs.get()).toEqual([])
    })
  })

  it('releases a lease evicted by the per-scope tab limit, but never a dirty one', async () => {
    const clean = openLease('lease-clean')
    const dirty = openLease('lease-dirty')
    setPreviewDirty(dirty.target.url, true)

    for (let index = 0; index < 40; index += 1) {
      openPreviewWorkbenchTab(
        { kind: 'file', label: `f${index}.txt`, previewKind: 'text', source: `/w/f${index}.txt`, url: `file:///w/f${index}.txt` },
        { restore: 'session', scopeKey: 'scope-a' }
      )
    }

    const ids = new Set($workbenchTabs.get().map(tab => tab.id))
    expect(ids.has(clean.id)).toBe(false)
    expect(ids.has(dirty.id)).toBe(true)
    await vi.waitFor(() => {
      expect(releaseTextFile).toHaveBeenCalledWith('lease-clean')
      expect($workspaceTextFileTabs.get().map(tab => tab.target.workspaceTextFile.fileRef)).toEqual(['lease-dirty'])
    })
    expect(releaseTextFile).not.toHaveBeenCalledWith('lease-dirty')
  })
})
