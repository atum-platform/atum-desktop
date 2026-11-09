import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { routesToNativeOffice } from '@/lib/native-office-routing'

import { $actionPanelEpoch, $actionPanelOwner } from './action-panel-owner'
import { $atumShellEnabled } from './atum-shell'
import {
  $previewServerRestart,
  $previewServerRestartStatus,
  $previewTarget,
  $sessionPreviewRegistry,
  beginPreviewServerRestart,
  clearSessionPreviewRegistry,
  dismissPreviewTarget,
  getSessionPreviewRecord,
  type PreviewTarget,
  progressPreviewServerRestart,
  setCurrentSessionPreviewTarget,
  setPreviewTarget
} from './preview'
import { $activeSessionId, $selectedStoredSessionId } from './session'
import { $workbenchTabs, assistantChatWorkbenchScopeKey, clearWorkbenchTabs, previewWorkbenchTabId, setWorkbenchScope } from './workbench-tabs'
import { $workspaceTextFileTabs } from './workspace-text-files'

function htmlTarget(path: string): PreviewTarget {
  return { kind: 'file', label: path, path, previewKind: 'html', source: path, url: `file://${path}` }
}

describe('preview registration projection', () => {
  beforeEach(() => {
    $previewServerRestart.set(null)
    $activeSessionId.set('session-1')
    $selectedStoredSessionId.set(null)
    window.localStorage.clear()
    clearSessionPreviewRegistry()
    clearWorkbenchTabs()
    $workspaceTextFileTabs.set([])
  })

  afterEach(() => {
    $activeSessionId.set(null)
    $selectedStoredSessionId.set(null)
    $actionPanelOwner.set(null)
    clearSessionPreviewRegistry()
    clearWorkbenchTabs()
    $workspaceTextFileTabs.set([])
    vi.restoreAllMocks()
  })

  it('does not notify status subscribers for restart progress text', () => {
    const statuses: string[] = []
    const unsubscribe = $previewServerRestartStatus.subscribe(status => statuses.push(status))

    beginPreviewServerRestart('task-1', 'http://localhost:5174')
    progressPreviewServerRestart('task-1', 'first line')
    progressPreviewServerRestart('task-1', 'second line')
    unsubscribe()

    expect(statuses).toEqual(['idle', 'running'])
  })

  it('projects a live preview into one typed pane and persists dismissal per session', () => {
    const target = htmlTarget('/work/demo.html')

    setCurrentSessionPreviewTarget(target, 'tool-result')

    expect($previewTarget.get()?.renderMode).toBe('preview')
    expect($workbenchTabs.get()).toHaveLength(1)
    expect($workbenchTabs.get()[0]).toMatchObject({ id: previewWorkbenchTabId(target, 'session'), restore: 'session' })
    expect(getSessionPreviewRecord('session-1')?.normalized.renderMode).toBe('preview')

    dismissPreviewTarget()

    expect($previewTarget.get()).toBeNull()
    expect($workbenchTabs.get()).toEqual([])
    expect(getSessionPreviewRecord('session-1')).toBeNull()
    expect($sessionPreviewRegistry.get()['session-1']?.[0]?.dismissedAt).toEqual(expect.any(Number))
  })

  it('keeps source and rendered modes as separate resources without nested selection state', () => {
    setCurrentSessionPreviewTarget(htmlTarget('/work/file.html'), 'manual')
    setCurrentSessionPreviewTarget(htmlTarget('/work/live.html'), 'tool-result')

    expect($workbenchTabs.get().map(tab => tab.surface.kind === 'preview' ? tab.surface.target.renderMode : null)).toEqual(['source', 'preview'])
    expect($workbenchTabs.get().map(tab => tab.restore)).toEqual(['persistent', 'session'])
  })

  it('deduplicates adversarial dual-open by canonical PreviewTarget URL', () => {
    const first = htmlTarget('/work/same.html')
    const second = { ...first, label: 'renamed.html' }

    setCurrentSessionPreviewTarget(first, 'manual')
    setCurrentSessionPreviewTarget(second, 'file-browser')

    expect($workbenchTabs.get()).toHaveLength(1)
    expect($workbenchTabs.get()[0]?.title).toBe('renamed.html')
  })

  it('re-registers an unchanged target after the visible workbench scope changes', () => {
    const target = htmlTarget('/work/scoped.html')

    setWorkbenchScope('scope-a')
    setPreviewTarget(target)
    setWorkbenchScope('scope-b')
    setPreviewTarget(target)

    expect($workbenchTabs.get().map(tab => tab.scopeKey)).toEqual(['scope-a', 'scope-b'])
  })

  it('routes local text through the opaque lease and never registers a preview resource', async () => {
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        filesystemCapability: {
          openTextFile: vi.fn(async () => ({ fileRef: 'opaque-picked', displayName: 'note.md' })),
          preserveTextFileSibling: vi.fn(), readTextFile: vi.fn(), releaseTextFile: vi.fn(), watchTextFile: vi.fn(), writeTextFile: vi.fn()
        }
      }
    })

    setCurrentSessionPreviewTarget({
      kind: 'file', label: 'note.md', previewKind: 'text', source: '/work/note.md', url: 'file:///work/note.md'
    }, 'file-browser')

    await vi.waitFor(() => expect($workspaceTextFileTabs.get()).toHaveLength(1))
    expect($workbenchTabs.get()).toEqual([])
    expect($previewTarget.get()).toBeNull()
  })

  it('falls back once to an honest preview when an explicit current Excel target has no installed local app', async () => {
    $atumShellEnabled.set(true)
    $actionPanelEpoch.set(1)
    $actionPanelOwner.set({ accountId: 'account', connectionId: 'connection', backend_id: 'backend', agent_id: 'agent', profile: 'default', version: 1, submission_dedup: true })
    setWorkbenchScope(assistantChatWorkbenchScopeKey('chat-a'))
    const list = vi.fn(async () => [])
    vi.stubGlobal('hermesDesktop', { nativeApps: { list } })

    const target: PreviewTarget = {
      kind: 'file', label: 'budget.xlsx', path: '/work/budget.xlsx', previewKind: 'binary',
      source: '/work/budget.xlsx', url: 'file:///work/budget.xlsx'
    }

    expect(routesToNativeOffice(target.path!, true)).toBe(true)
    expect(setCurrentSessionPreviewTarget(target, 'file-browser')).toBeNull()
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect($workbenchTabs.get().some(tab => tab.surface.kind === 'preview' && tab.surface.target.url === target.url)).toBe(true))
    expect(getSessionPreviewRecord('session-1')).toBeNull()
  })
})
