import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { translateNow } from '@/i18n/runtime'

import { $actionPanelEpoch, $actionPanelOwner, invalidateActionPanelOwner, panelDraftKey, panelOwnerKey } from './action-panel-owner'
import { $atumShellEnabled, $railDestination, setWorkspaceOpen } from './atum-shell'
import { $queuedPromptsBySession, enqueueQueuedPrompt, getQueuedPrompts, recoverQueuedContext } from './composer-queue'
import { $documentContext, resetDocumentContextForTests, setDocumentSelection } from './document-context'
import { associateNativeDocument, resetNativeDocumentForTests } from './native-document'
import { $currentCwd } from './session'
import { freezeSurfaceCapture, registerSurfaceReader, utf8CapturePrefix } from './surface-capture'
import { $wordCompanion, resetWordCompanionForTests } from './word-companion'
import { adoptDraftWorkbenchScope, assistantChatWorkbenchScopeKey, closeWorkbenchScope, markDraftWorkbenchBaseline, openPreviewWorkbenchTab, resetWorkbenchTabs, resolveCaptureScope, revealWorkbenchTab, setWorkbenchScope } from './workbench-tabs'

const owner = { version: 1 as const, backend_id: '00000000-0000-4000-8000-bd7662a5eeb4', agent_id: '00000000-0000-4000-8000-b454f82c5857', accountId: 'account-a', connectionId: 'connection-a', profile: 'default', submission_dedup: true }
const cleanup: Array<() => void> = []

function show(session: string | null = 'chat-a', path = '/work/code.ts') {
  const scope = assistantChatWorkbenchScopeKey(session)
  setWorkbenchScope(scope)
  revealWorkbenchTab(openPreviewWorkbenchTab({ kind: 'file', previewKind: 'text', label: path.split('/').at(-1)!, path, source: path, url: `file://${path}` }, { scopeKey: scope, restore: 'session' }))

  return scope
}

beforeEach(() => {
  $atumShellEnabled.set(true); $railDestination.set('chat')
  $actionPanelOwner.set(owner); $currentCwd.set('/work')
  $queuedPromptsBySession.set({}); resetWorkbenchTabs(); resetDocumentContextForTests(); resetNativeDocumentForTests(); resetWordCompanionForTests(); localStorage.clear()
})
afterEach(() => {cleanup.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals()})

it('stops automatic capture while the retained panel is hidden without changing queued bytes', async () => {
  const scope = show()
  const read = vi.fn(() => ({ text: 'visible document' }))
  cleanup.push(registerSurfaceReader(scope, '/work/code.ts', read))
  const entry = await enqueueQueuedPrompt('chat-a', { text: 'review', attachments: [] })
  setWorkspaceOpen(false)
  expect($documentContext.get()).toBeNull()
  expect(await freezeSurfaceCapture(scope)).toBeNull()
  expect(read).toHaveBeenCalledTimes(1)
  expect(getQueuedPrompts('chat-a')[0].frozenContext).toEqual(entry?.frozenContext)
  setWorkspaceOpen(true)
  expect((await freezeSurfaceCapture(scope))?.payload.text).toBe('visible document')
  $railDestination.set('discover')
  expect($documentContext.get()).toBeNull()
  expect(await freezeSurfaceCapture(scope)).toBeNull()
  $railDestination.set('chat')
  expect((await freezeSurfaceCapture(scope))?.payload.text).toBe('visible document')
})

it('captures the code editor buffer once; later edits, tab close and another chat cannot change a queued payload', async () => {
  const scope = show()
  let text = 'unsaved @file:private.txt'
  const read = vi.fn(() => ({ text, dirty: true }))
  cleanup.push(registerSurfaceReader(scope, '/work/code.ts', read))
  const entry = await enqueueQueuedPrompt('chat-a', { text: 'review', attachments: [] })
  expect(read).toHaveBeenCalledTimes(1)
  text = 'later saved version'; closeWorkbenchScope(scope); show('chat-b')
  expect(entry?.frozenContext?.payload).toMatchObject({ text: 'unsaved @file:private.txt', provenance: 'unsaved-buffer', kind: 'text' })
  expect(getQueuedPrompts('chat-a')[0].frozenContext).toEqual(entry?.frozenContext)
  expect(read).toHaveBeenCalledTimes(1)
  const storage = localStorage.getItem('hermes.desktop.composerQueue.v2')!
  expect(storage).not.toContain('unsaved @file')
  expect(JSON.parse(storage)[panelOwnerKey()]['chat-a'][0].contextUnavailable).toBe(true)
})

it('caps UTF-8 without splitting a supplementary code point and sends only the selected buffer', async () => {
  const scope = show()
  const text = 'a'.repeat(4095) + '😀tail'
  cleanup.push(registerSurfaceReader(scope, '/work/code.ts', () => ({ text, dirty: true })))
  setDocumentSelection({ path: '/work/code.ts', start: 0, end: text.length, text }, scope)
  const capture = await freezeSurfaceCapture(scope)
  expect(capture?.payload.text).toBe('a'.repeat(4095))
  expect(capture?.payload.truncated).toBe(true)
  expect(utf8CapturePrefix('é'.repeat(20000)).text).toHaveLength(16384)
})

it('rejects a selection from an older buffer revision', async () => {
  const scope = show()
  setDocumentSelection({ path: '/work/code.ts', start: 0, end: 3, text: 'old' }, scope)
  cleanup.push(registerSurfaceReader(scope, '/work/code.ts', () => ({ text: 'new', dirty: true })))
  await expect(freezeSurfaceCapture(scope)).rejects.toThrow(translateNow('composer.contextSelectionChanged'))
})

it('separates equal queue ids across stable owners and restores only the current owner', async () => {
  const entry = await enqueueQueuedPrompt('same', { text: 'A only', attachments: [] })
  expect(entry).not.toBeNull()
  $actionPanelOwner.set({ ...owner, agent_id: crypto.randomUUID() })
  expect(getQueuedPrompts('same')).toEqual([])
  await enqueueQueuedPrompt('same', { text: 'B only', attachments: [] })
  $actionPanelOwner.set(owner)
  expect(getQueuedPrompts('same').map(item => item.text)).toEqual(['A only'])
})

it('does not enqueue when stable owner identity is missing', async () => {
  invalidateActionPanelOwner()
  expect(await enqueueQueuedPrompt('same', { text: 'draft', attachments: [] })).toBeNull()
})

it('captures native files at Send and rejects account change during file IO', async () => {
  const scope = assistantChatWorkbenchScopeKey('chat-a')
  setWorkbenchScope(scope)
  revealWorkbenchTab(openPreviewWorkbenchTab({ kind: 'file', previewKind: 'card', label: 'budget.xlsx', source: '/elsewhere/budget.xlsx', url: 'atum-card:token', contextFile: { token: 'token' } }, { scopeKey: scope, restore: 'session' }))
  let finish!: (value: { dataUrl: string; revision: string }) => void
  vi.stubGlobal('hermesDesktop', { consumerFiles: { capture: vi.fn(() => new Promise(resolve => {finish = resolve})) } })
  const pending = freezeSurfaceCapture()
  invalidateActionPanelOwner()
  finish({ dataUrl: 'data:application/octet-stream;base64,AAAA', revision: 'frozen' })
  await expect(pending).rejects.toThrow(translateNow('composer.contextOwnerChanged'))
})

it('captures the live Word buffer without a conflicting saved-file attachment', async () => {
  const scope = assistantChatWorkbenchScopeKey('chat-a')
  setWorkbenchScope(scope)
  $wordCompanion.set({
    descriptor: { id: 'word-pair', path: '/work/report.docx', name: 'report.docx' },
    ownerKey: panelOwnerKey(), epoch: $actionPanelEpoch.get(), scopeKey: scope
  })
  vi.stubGlobal('hermesDesktop', { wordCompanion: {
    capture: vi.fn(async () => ({ text: 'My unsaved Word text', revision: 'word-revision', saved: false }))
  } })

  const capture = await freezeSurfaceCapture()
  expect(capture?.payload).toMatchObject({
    kind: 'text', label: expect.stringContaining('report.docx'), text: 'My unsaved Word text', source_revision: 'word-revision',
    provenance: 'unsaved-buffer', truncated: false
  })
  expect(capture?.payload.resource_path).toBeUndefined()
  expect(capture?.payload.file_data_url).toBeUndefined()
})

it('captures only the associated native saved file with no source path fallback', async () => {
  const scope = assistantChatWorkbenchScopeKey('chat-a')
  setWorkbenchScope(scope)
  vi.stubGlobal('hermesDesktop', { consumerFiles: {
    open: vi.fn(async () => ({ kind: 'card', size: 12, token: 'native-grant' })),
    capture: vi.fn(async () => ({ dataUrl: 'data:application/octet-stream;base64,SAVED', revision: 'saved-revision' })),
    releaseView: vi.fn(async () => true)
  } })
  await associateNativeDocument('native-pair', '/home/example/Documents/Budget.xlsx', scope)
  setWorkspaceOpen(false)

  const capture = await freezeSurfaceCapture(scope)
  expect(capture?.payload).toMatchObject({
    kind: 'file', label: 'Budget.xlsx', file_data_url: 'data:application/octet-stream;base64,SAVED', source_revision: 'saved-revision',
    provenance: 'saved-file', truncated: false
  })
  expect(capture?.payload.resource_path).toBeUndefined()
  expect(capture?.payload.text).toBeUndefined()
})

it('reports failed native saved-file context and never captures an unrelated preview', async () => {
  const scope = assistantChatWorkbenchScopeKey('chat-a')
  setWorkbenchScope(scope)
  const read = vi.fn(() => ({ text: 'unrelated preview bytes' }))
  revealWorkbenchTab(openPreviewWorkbenchTab({ kind: 'file', previewKind: 'text', label: 'unrelated.md', path: '/work/unrelated.md', source: '/work/unrelated.md', url: 'file:///work/unrelated.md' }, { scopeKey: scope, restore: 'session' }))
  cleanup.push(registerSurfaceReader(scope, '/work/unrelated.md', read))
  vi.stubGlobal('hermesDesktop', { consumerFiles: {
    open: vi.fn(async () => ({ kind: 'card', size: 12, token: 'native-grant' })),
    capture: vi.fn(async () => {throw new Error('CONSUMER_FILES_MISSING')}),
    releaseView: vi.fn(async () => true)
  } })
  await associateNativeDocument('native-pair', '/home/example/Documents/Budget.xlsx', scope)

  const failure = await freezeSurfaceCapture(scope).catch(error => error as Error & { detail?: string })
  expect(failure).toMatchObject({ detail: 'CONSUMER_FILES_MISSING' })

  if (!(failure instanceof Error)) {throw new Error('Expected unavailable file error')}
  expect(failure.message).not.toContain('CONSUMER_FILES_')
  await expect(freezeSurfaceCapture(scope)).rejects.toThrow(failure.message)
  expect(read).not.toHaveBeenCalled()
})

it('freezes newly saved Office bytes after the real IPC missing-token error replaces the association', async () => {
  const scope = assistantChatWorkbenchScopeKey('chat-a')
  setWorkbenchScope(scope)
  const open = vi.fn().mockResolvedValueOnce({ kind: 'card', token: 'old', size: 12 }).mockResolvedValueOnce({ kind: 'card', token: 'new', size: 14 })

  const capture = vi.fn().mockRejectedValueOnce(new Error("Error invoking remote method 'atum:files:capture': Error: CONSUMER_FILES_MISSING"))
    .mockResolvedValueOnce({ dataUrl: 'data:application/octet-stream;base64,UPDATED', revision: 'after-save' })

  const releaseView = vi.fn(async () => true)
  vi.stubGlobal('hermesDesktop', { consumerFiles: { open, capture, releaseView } })
  await associateNativeDocument('pair', '/work/Deck.pptx', scope)
  expect((await freezeSurfaceCapture(scope))?.payload).toMatchObject({ source_revision: 'after-save', file_data_url: 'data:application/octet-stream;base64,UPDATED', provenance: 'saved-file' })
  expect(open).toHaveBeenCalledTimes(2)
  expect(capture).toHaveBeenLastCalledWith('new')
  expect(releaseView).toHaveBeenCalledWith('old')
})

it('rejects a paired Word capture when its owner or scope changes while native bytes are loading', async () => {
  const scope = assistantChatWorkbenchScopeKey('chat-a')
  setWorkbenchScope(scope)
  $wordCompanion.set({
    descriptor: { id: 'word-pair', path: '/work/report.docx', name: 'report.docx' },
    ownerKey: panelOwnerKey(), epoch: $actionPanelEpoch.get(), scopeKey: scope
  })
  let finish!: (value: { text: string; revision: string; saved: boolean }) => void
  vi.stubGlobal('hermesDesktop', { wordCompanion: { capture: vi.fn(() => new Promise(resolve => {finish = resolve})) } })

  const pending = freezeSurfaceCapture()
  $actionPanelOwner.set({ ...owner, accountId: 'account-b' })
  finish({ text: 'Late private text', revision: 'word-revision', saved: true })
  await expect(pending).rejects.toThrow(translateNow('composer.contextOwnerChanged'))
})

it('captures Word selection with bounded UTF-8 and document line coordinates', async () => {
  const scope = assistantChatWorkbenchScopeKey('chat-a')
  setWorkbenchScope(scope)
  $wordCompanion.set({ descriptor: { id: 'word-pair', path: '/work/report.docx', name: 'report.docx' },
    ownerKey: panelOwnerKey(), epoch: $actionPanelEpoch.get(), scopeKey: scope })
  const selected = 'Tiếng Việt 🌿 '.repeat(500)
  vi.stubGlobal('hermesDesktop', { wordCompanion: { capture: vi.fn(async () => ({
    text: `Heading\r${selected}\rEnd`, revision: 'live', saved: false,
    selection: { text: selected, start: 8, end: 8 + selected.length }
  })) } })
  const result = (await freezeSurfaceCapture())!.payload
  expect(result.selection).toEqual({ start_line: 2, end_line: 2 })
  expect(result.truncated).toBe(true)
  expect(new TextEncoder().encode(result.text).length).toBeLessThanOrEqual(4096)
  expect(selected.startsWith(result.text!)).toBe(true)
  expect(result.text).not.toContain('\ufffd')
})

it('never captures a hosted DM or a human conversation implicitly', async () => {
  const scope = 'atum-dm:account-a:human'
  setWorkbenchScope(scope)
  const read = vi.fn(() => ({ text: 'private' }))
  cleanup.push(registerSurfaceReader(scope, '/work/code.ts', read))
  expect(await freezeSurfaceCapture(scope)).toBeNull()
  expect(read).not.toHaveBeenCalled()
})

it('labels a visible viewport excerpt even when it is below the byte limit', async () => {
  const scope = show()
  cleanup.push(registerSurfaceReader(scope, '/work/code.ts', () => ({ text: 'before\nvisible\nafter', excerpt: 'visible' })))
  expect((await freezeSurfaceCapture())?.payload).toMatchObject({ text: 'visible', truncated: true })
})

it('lets a frozen draft capture follow only the chat created from that draft', async () => {
  markDraftWorkbenchBaseline()
  const scope = show(null)
  cleanup.push(registerSurfaceReader(scope, '/work/code.ts', () => ({ text: 'draft bytes', dirty: true })))
  const capture = await freezeSurfaceCapture()
  expect(capture?.scopeKey).toBe(panelDraftKey())
  adoptDraftWorkbenchScope('created-chat')
  expect(resolveCaptureScope(capture!.scopeKey)).toBe(assistantChatWorkbenchScopeKey('created-chat'))
  expect(capture?.payload.text).toBe('draft bytes')
  expect(resolveCaptureScope(capture!.scopeKey)).not.toBe(assistantChatWorkbenchScopeKey('other-chat'))
})

it('cannot update a queued chat with the foreground context of another chat', async () => {
  const original = show('chat-a')
  cleanup.push(registerSurfaceReader(original, '/work/code.ts', () => ({ text: 'A', dirty: true })))
  const entry = await enqueueQueuedPrompt('chat-a', { text: 'review', attachments: [] })
  const other = show('chat-b')
  cleanup.push(registerSurfaceReader(other, '/work/code.ts', () => ({ text: 'B', dirty: true })))
  await recoverQueuedContext(entry!.id, false)
  expect(getQueuedPrompts('chat-a')[0].frozenContext?.payload.text).toBe('A')
})

it('keeps the original capture when explicit recovery has no current surface', async () => {
  const scope = show('chat-a')
  cleanup.push(registerSurfaceReader(scope, '/work/code.ts', () => ({ text: 'original capture' })))
  const entry = await enqueueQueuedPrompt('chat-a', { text: 'review', attachments: [] })
  closeWorkbenchScope(scope)
  setWorkbenchScope(scope)
  await recoverQueuedContext(entry!.id, false)
  expect(getQueuedPrompts('chat-a')[0].frozenContext?.payload.text).toBe('original capture')
  await recoverQueuedContext(entry!.id, true)
  expect(getQueuedPrompts('chat-a')[0].frozenContext).toBeNull()
})
