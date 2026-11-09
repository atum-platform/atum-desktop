import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { registry } from '@/contrib/registry'
import { $atumShellEnabled } from '@/store/atum-shell'
import { $workbenchTabs, clearWorkbenchTabs, closeWorkbenchTab, openPreviewWorkbenchTab } from '@/store/workbench-tabs'
import { $workspaceTextFileTabs, trackWorkspaceTextFileTarget, workspaceTextFileTarget } from '@/store/workspace-text-files'

vi.mock('@/app/chat/workspace-text-file-pane', () => ({
  WorkspaceTextFilePane: ({ tab }: { tab: { id: string } }) => <div data-testid="text-file-pane">{tab.id}</div>
}))

import { closeWorkbenchRegistration, watchWorkbenchResourceTabs, WorkbenchResourcePane } from './workbench-resource-pane'

describe('workbench resource pane registration', () => {
  afterEach(() => {
    $atumShellEnabled.set(true)
    clearWorkbenchTabs()
  })

  it('uses the unified Atum workbench and projects panes only for legacy Hermes', () => {
    $atumShellEnabled.set(true)
    watchWorkbenchResourceTabs()

    const id = openPreviewWorkbenchTab({
      kind: 'file', label: 'chart.png', previewKind: 'image', source: '/work/chart.png', url: 'file:///work/chart.png'
    }, { restore: 'persistent', scopeKey: 'session-1' })

    expect(registry.getArea('panes').some(pane => pane.id === id)).toBe(false)

    $atumShellEnabled.set(false)

    expect(registry.getArea('panes').find(pane => pane.id === id)).toMatchObject({
      id,
      title: 'chart.png',
      data: { dock: { pane: 'workspace', pos: 'center' }, placement: 'main' }
    })

    $atumShellEnabled.set(true)

    expect(registry.getArea('panes').some(pane => pane.id === id)).toBe(false)

    closeWorkbenchTab(id)
  })

  it('renders an opaque consumer-file lease with the text pane and releases it on close', async () => {
    const releaseTextFile = vi.fn(async () => undefined)
    Object.assign(window, { hermesDesktop: { filesystemCapability: { releaseTextFile } } })
    const target = workspaceTextFileTarget({ displayName: 'notes.md', fileRef: 'lease-9' })
    trackWorkspaceTextFileTarget(target)
    const id = openPreviewWorkbenchTab(target, { restore: 'session', scopeKey: 'session-1' })

    render(<WorkbenchResourcePane id={id} />)
    expect(screen.getByTestId('text-file-pane').textContent).toBe('workspace-file:lease-9')

    closeWorkbenchRegistration($workbenchTabs.get().find(tab => tab.id === id)!)

    await waitFor(() => {
      expect(releaseTextFile).toHaveBeenCalledWith('lease-9')
      expect($workspaceTextFileTabs.get()).toEqual([])
      expect($workbenchTabs.get().some(tab => tab.id === id)).toBe(false)
    })

    cleanup()
  })
})
