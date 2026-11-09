import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $actionPanelEpoch, $actionPanelOwner, panelOwnerKey } from './action-panel-owner'
import { $atumShellEnabled, $railDestination, setWorkspaceOpen } from './atum-shell'
import {
  $documentContext,
  documentContextBlocks,
  documentContextForScope,
  documentContextPathForTarget,
  documentFingerprint,
  resetDocumentContextForTests,
  restoreDocumentContext,
  setDocumentSelection,
  suppressDocumentContext,
  updateDocumentBuffer
} from './document-context'
import { associateNativeDocument, resetNativeDocumentForTests } from './native-document'
import type { PreviewTarget } from './preview'
import { $currentCwd } from './session'
import { $wordCompanion, resetWordCompanionForTests } from './word-companion'
import {
  $activeWorkbenchTabId,
  $workbenchScope,
  $workbenchTabs,
  openPreviewWorkbenchTab,
  revealWorkbenchTab,
  setWorkbenchScope
} from './workbench-tabs'

const owner = { version: 1 as const, backend_id: '00000000-0000-4000-8000-bd7662a5eeb4', agent_id: '00000000-0000-4000-8000-b454f82c5857', accountId: 'account-a', connectionId: 'connection-a', profile: 'default', submission_dedup: true }

const target = (path: string): PreviewTarget => ({
  kind: 'file',
  label: path.split('/').pop()!,
  path,
  previewKind: 'text',
  source: path,
  url: `file://${path}`
})

function show(scope: string, path: string) {
  setWorkbenchScope(scope)
  const id = openPreviewWorkbenchTab(target(path), { restore: 'session', scopeKey: scope })
  revealWorkbenchTab(id)

  return $documentContext.get()
}

const leaseTarget = (relativePath: string, fileRef = 'lease-1'): PreviewTarget => ({
  kind: 'file',
  label: relativePath,
  language: 'markdown',
  previewKind: 'text',
  source: `workspace-file:${fileRef}`,
  url: `workspace-file:${fileRef}`,
  workspaceTextFile: { displayName: relativePath, fileRef, workspaceRelativePath: relativePath }
})

describe('lease-backed workspace documents', () => {
  beforeEach(() => {
    resetDocumentContextForTests()
    resetNativeDocumentForTests()
    $workbenchTabs.set([])
    $activeWorkbenchTabId.set(null)
    $workbenchScope.set('atum-chat:one')
  })

  it('derives the chip from the workspace-relative path even before the session cwd is known', () => {
    $currentCwd.set('')

    const id = openPreviewWorkbenchTab(leaseTarget('Tài liệu 1.md'), {
      restore: 'persistent',
      scopeKey: 'atum-chat:one'
    })

    revealWorkbenchTab(id)

    const item = $documentContext.get()
    expect(item?.workspaceDocument).toBe(true)
    expect(item?.state).toBe('ready')
    expect(item?.identity).toEqual({
      inWorkspace: true,
      name: 'Tài liệu 1.md',
      path: 'Tài liệu 1.md',
      relativePath: 'Tài liệu 1.md'
    })

    $currentCwd.set('/home/example/atum/workspace')
    expect($documentContext.get()?.identity.path).toBe('/home/example/atum/workspace/Tài liệu 1.md')
    expect(documentContextPathForTarget(leaseTarget('Tài liệu 1.md'), '/home/example/atum/workspace')).toBe('Tài liệu 1.md')
  })

  it('keeps an explicit suppression and a selection when the fresh chat learns its cwd after the first send', () => {
    $currentCwd.set('')

    const id = openPreviewWorkbenchTab(leaseTarget('Tài liệu 3.md', 'lease-3'), {
      restore: 'persistent',
      scopeKey: 'atum-chat:one'
    })

    revealWorkbenchTab(id)
    const text = 'một\nhai'
    setDocumentSelection({ end: text.length, path: 'Tài liệu 3.md', start: 0, text })
    expect($documentContext.get()?.selection?.startLine).toBe(1)

    $currentCwd.set('/ws')
    expect($documentContext.get()?.selection?.startLine).toBe(1)
    // The chip suppresses with the absolute identity path once the cwd is known …
    suppressDocumentContext('atum-chat:one', $documentContext.get()!.identity.path)
    expect($documentContext.get()).toBeNull()
    // … and the suppression must not lift when the cwd is forgotten or re-learned.
    $currentCwd.set('')
    expect($documentContext.get()).toBeNull()
    $currentCwd.set('/ws')
    expect($documentContext.get()).toBeNull()
  })

  it('keeps selection and suppression keyed by the same path the pane uses', () => {
    $currentCwd.set('/ws')

    const id = openPreviewWorkbenchTab(leaseTarget('Tài liệu 2.md', 'lease-2'), {
      restore: 'persistent',
      scopeKey: 'atum-chat:one'
    })

    revealWorkbenchTab(id)
    const path = documentContextPathForTarget(leaseTarget('Tài liệu 2.md', 'lease-2'), '/ws')!
    const text = 'một\nhai\nba'

    setDocumentSelection({ end: text.length, path, start: text.indexOf('hai'), text })
    expect($documentContext.get()?.selection).toMatchObject({ endLine: 3, startLine: 2, text: 'hai\nba' })
    expect(documentContextBlocks($documentContext.get())[0]).toContain('document path="Tài liệu 2.md" lines=2-3')

    suppressDocumentContext('atum-chat:one', path)
    expect($documentContext.get()).toBeNull()
    restoreDocumentContext('atum-chat:one', path)
    expect($documentContext.get()?.identity.name).toBe('Tài liệu 2.md')
  })
})

describe('document context', () => {
  beforeEach(() => {
    resetDocumentContextForTests()
    resetNativeDocumentForTests()
    $workbenchTabs.set([])
    $activeWorkbenchTabId.set(null)
    $workbenchScope.set('session')
    $currentCwd.set('/workspace')
    resetWordCompanionForTests()
    $actionPanelOwner.set(owner)
    $atumShellEnabled.set(true)
    $railDestination.set('chat')
    setWorkspaceOpen(true)
  })

  afterEach(() => {vi.unstubAllGlobals()})

  it('derives the active text document per scope and remembers suppression', () => {
    expect(show('chat-a', '/workspace/one.md')?.identity.relativePath).toBe('one.md')
    suppressDocumentContext('chat-a', '/workspace/one.md')
    expect($documentContext.get()).toBeNull()

    expect(show('chat-b', '/workspace/two.txt')?.identity.name).toBe('two.txt')
    expect(documentContextForScope('chat-a')).toBeNull()
    expect(show('chat-a', '/workspace/other.markdown')?.identity.name).toBe('other.markdown')
    expect(show('chat-a', '/workspace/one.md')).toBeNull()
  })

  it('marks outside files unavailable', () => {
    expect(show('chat-a', '/elsewhere/note.md')?.state).toBe('unavailable')
  })

  it('captures CRLF line numbers, Vietnamese text, truncation, and later edits', () => {
    show('chat-a', '/workspace/note.md')
    const text = 'một\r\nhai dòng\r\nba'
    const start = text.indexOf('hai')
    setDocumentSelection({ end: text.length, path: '/workspace/note.md', start, text })
    const selected = $documentContext.get()
    expect(selected?.selection).toMatchObject({ startLine: 2, endLine: 3, text: 'hai dòng\r\nba' })
    expect(documentContextBlocks(selected)[0]).toBe(
      `\`\`\`document path="note.md" lines=2-3 fingerprint=${documentFingerprint(text)}\nhai dòng\nba\n\`\`\``
    )

    updateDocumentBuffer('/workspace/note.md', `${text}!`)
    expect($documentContext.get()?.state).toBe('changed')

    const long = 'ữ'.repeat(3_000)
    setDocumentSelection({ end: long.length, path: '/workspace/note.md', start: 0, text: long })
    expect(new TextEncoder().encode($documentContext.get()!.selection!.text).byteLength).toBeLessThanOrEqual(4_096)
    expect($documentContext.get()?.state).toBe('truncated')
  })

  it('uses a fence longer than any backtick run and clears collapsed selections', () => {
    show('chat-a', '/workspace/note.md')
    const text = 'đầu ````` cuối'
    setDocumentSelection({ end: text.length, path: '/workspace/note.md', start: 0, text })
    expect(documentContextBlocks($documentContext.get())[0]).toMatch(/^``````document /u)
    setDocumentSelection(null)
    expect($documentContext.get()?.selection).toBeNull()
  })

  it('keeps the paired Word file as foreground context while the workspace is hidden', () => {
    const scope = 'atum-chat:account-a:chat-a'
    $workbenchScope.set(scope)
    $wordCompanion.set({
      descriptor: { id: 'pair-a', path: '/elsewhere/report.docx', name: 'Quarterly Report.docx' },
      ownerKey: panelOwnerKey(),
      epoch: $actionPanelEpoch.get(),
      scopeKey: scope
    })
    setWorkspaceOpen(false)

    expect($documentContext.get()).toMatchObject({
      identity: { name: 'Quarterly Report.docx', path: '/elsewhere/report.docx' },
      scopeKey: scope,
      selection: null,
      state: 'ready',
      workspaceDocument: false
    })
  })

  it('does not leak a paired Word file to another owner or conversation', () => {
    const scope = 'atum-chat:account-a:chat-a'
    $workbenchScope.set(scope)
    $wordCompanion.set({
      descriptor: { id: 'pair-a', path: '/elsewhere/report.docx', name: 'Quarterly Report.docx' },
      ownerKey: panelOwnerKey(), epoch: $actionPanelEpoch.get(), scopeKey: scope
    })
    expect($documentContext.get()?.identity.name).toBe('Quarterly Report.docx')

    $workbenchScope.set('atum-chat:account-a:chat-b')
    expect($documentContext.get()).toBeNull()
    $workbenchScope.set(scope)
    $actionPanelOwner.set({ ...owner, accountId: 'account-b' })
    expect($documentContext.get()).toBeNull()
  })

  it('keeps an associated native saved file foreground while the workspace is hidden and honors suppression', async () => {
    const scope = 'atum-chat:account-a:chat-a'
    $workbenchScope.set(scope)
    vi.stubGlobal('hermesDesktop', { consumerFiles: {
      open: vi.fn(async () => ({ kind: 'card', size: 12, token: 'grant-a' })), releaseView: vi.fn(async () => true)
    } })
    await associateNativeDocument('native-pair', '/home/example/Documents/Budget.xlsx', scope)
    setWorkspaceOpen(false)

    expect($documentContext.get()).toMatchObject({
      identity: { name: 'Budget.xlsx', path: '/home/example/Documents/Budget.xlsx' }, scopeKey: scope,
      selection: null, state: 'ready', workspaceDocument: false
    })
    suppressDocumentContext(scope, '/home/example/Documents/Budget.xlsx')
    expect($documentContext.get()).toBeNull()
  })

  it('keeps a failed native saved-file association unavailable instead of falling back to an active preview', async () => {
    const scope = 'atum-chat:account-a:chat-a'
    $workbenchScope.set(scope)
    show(scope, '/workspace/unrelated.md')
    vi.stubGlobal('hermesDesktop', { consumerFiles: { open: vi.fn(async () => ({ kind: 'error', code: 'CONSUMER_FILES_OUTSIDE_HOME' })) } })

    await expect(associateNativeDocument('native-pair', '/home/example/Documents/Budget.xlsx', scope)).rejects.toThrow('CONSUMER_FILES_OUTSIDE_HOME')
    expect($documentContext.get()).toMatchObject({ identity: { name: 'Budget.xlsx' }, state: 'unavailable', workspaceDocument: false })
  })
})
