import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { $actionPanelEpoch, $actionPanelOwner, panelOwnerKey } from './action-panel-owner'
import { $atumShellEnabled, $railDestination, setWorkspaceOpen } from './atum-shell'
import { $contextLinkBinding, resetConversationContextLinksForTests, setContextLinkIntent } from './conversation-context-links'
import { $documentContext, resetDocumentContextForTests } from './document-context'
import { resetNativeDocumentForTests } from './native-document'
import { $currentCwd } from './session'
import { captureIntentForScope, freezeSurfaceCapture, registerSurfaceReader } from './surface-capture'
import { $wordCompanion, resetWordCompanionForTests } from './word-companion'
import { $workbenchTabs, assistantChatWorkbenchScopeKey, closeWorkbenchTab, openPreviewWorkbenchTab, resetWorkbenchTabs, revealWorkbenchTab, setWorkbenchScope } from './workbench-tabs'

const owner = { version: 1 as const, backend_id: 'backend', agent_id: 'agent', accountId: 'account', connectionId: 'connection', profile: 'default', submission_dedup: true }
const disposers: Array<() => void> = []
let scope: string

function panel(name: string, text: string, token?: string) {
  const id = openPreviewWorkbenchTab({ kind: 'file', previewKind: token ? 'card' : 'text', path: `/work/${name}`, source: `/work/${name}`, label: name,
    url: `file:///work/${name}`, ...(token ? { contextFile: { token } } : {}) }, { scopeKey: scope, restore: 'session' })

  const tab = $workbenchTabs.get().find(value => value.id === id)!

  if (!token) {disposers.push(registerSurfaceReader(scope, `/work/${name}`, () => ({ text, dirty: true })))}
  revealWorkbenchTab(id)

  return tab
}

function linkPanel(tab: ReturnType<typeof panel>) {
  const target = { kind: 'panel' as const, path: `/work/${tab.title}`, name: tab.title, viewKey: tab.viewKey ?? tab.id }
  setContextLinkIntent({ revision: crypto.randomUUID(), mode: 'linked', target })
}

function linkWord(path = '/work/A.docx') {
  const revision = crypto.randomUUID()
  setContextLinkIntent({ revision, mode: 'linked', target: { kind: 'word', path, name: 'A.docx' } })
  $contextLinkBinding.set({ revision, ownerKey: panelOwnerKey(), profile: owner.profile, epoch: $actionPanelEpoch.get(), scopeKey: scope,
    word: { id: 'binding-A', path, name: 'A.docx' } })
}

beforeEach(() => {
  localStorage.clear(); resetConversationContextLinksForTests(); resetWorkbenchTabs(); resetDocumentContextForTests(); resetNativeDocumentForTests(); resetWordCompanionForTests()
  $actionPanelOwner.set(owner); $atumShellEnabled.set(true); $railDestination.set('chat'); $currentCwd.set('/work')
  scope = assistantChatWorkbenchScopeKey('chat'); setWorkbenchScope(scope); setWorkspaceOpen(true)
})
afterEach(() => {disposers.splice(0).forEach(stop => stop()); vi.unstubAllGlobals()})

it('captures linked A while B is active and the action panel is collapsed', async () => {
  const a = panel('A.md', 'unsaved A'); linkPanel(a); panel('B.md', 'B'); setWorkspaceOpen(false)
  expect($documentContext.get()?.identity.name).toBe('A.md')
  expect((await freezeSurfaceCapture())?.payload).toMatchObject({ text: 'unsaved A', provenance: 'unsaved-buffer' })
})

it('uses linked A file grant rather than active B grant', async () => {
  const a = panel('A.pdf', '', 'grant-A'); linkPanel(a); panel('B.pdf', '', 'grant-B')
  const capture = vi.fn(async (token: string) => ({ dataUrl: `data:application/pdf;base64,${token}`, revision: 'saved' }))
  vi.stubGlobal('hermesDesktop', { consumerFiles: { capture } })
  expect((await freezeSurfaceCapture())?.payload.file_data_url).toContain('grant-A')
  expect(capture).toHaveBeenCalledExactlyOnceWith('grant-A')
})

it('keeps a closed manual target unavailable instead of falling back to B', async () => {
  const a = panel('A.md', 'A'); linkPanel(a); panel('B.md', 'B'); closeWorkbenchTab(a.id)
  expect($documentContext.get()?.state).toBe('unavailable')
  await expect(freezeSurfaceCapture()).rejects.toThrow()
})

it('Removed stops all primary capture even if a new document opens', async () => {
  setContextLinkIntent({ revision: 'removed', mode: 'removed' }); panel('B.md', 'B')
  expect($documentContext.get()).toBeNull()
  expect(await freezeSurfaceCapture()).toBeNull()
  expect(captureIntentForScope().mode).toBe('removed')
})

it('captures manual Word binding A while arrangement B is displayed', async () => {
  linkWord()
  $wordCompanion.set({ descriptor: { id: 'layout-B', name: 'B.docx', path: '/work/B.docx' }, ownerKey: panelOwnerKey(), epoch: $actionPanelEpoch.get(), scopeKey: scope })
  const capture = vi.fn(async () => ({ text: 'live A', revision: 'native-revision', saved: false }))
  vi.stubGlobal('hermesDesktop', { wordCompanion: { capture } })
  const frozen = await freezeSurfaceCapture()
  expect(capture).toHaveBeenCalledExactlyOnceWith('binding-A')
  expect(frozen?.intent?.wordBindingId).toBe('binding-A')
  expect(frozen?.payload.text).toBe('live A')
})

it('rejects a Word capture completed after the manual target changes', async () => {
  linkWord()
  let finish!: (value: { text: string; revision: string; saved: boolean }) => void
  vi.stubGlobal('hermesDesktop', { wordCompanion: { capture: vi.fn(() => new Promise(resolve => {finish = resolve})) } })
  const pending = freezeSurfaceCapture()
  setContextLinkIntent({ mode: 'removed', revision: 'next' })
  finish({ text: 'late A', revision: 'native', saved: false })
  await expect(pending).rejects.toThrow()
})

it('queue recovery reads original panel A even after B becomes the manual target', async () => {
  const a = panel('A.md', 'A'); linkPanel(a)
  const original = captureIntentForScope()
  const b = panel('B.md', 'B'); linkPanel(b)
  expect((await freezeSurfaceCapture(scope, original))?.payload.text).toBe('A')
  expect($documentContext.get()?.identity.name).toBe('B.md')
})

it('queue recovery cannot replace original Word A with currently linked B', async () => {
  linkWord(); const original = captureIntentForScope(); linkWord('/work/B.docx')
  const capture = vi.fn()
  vi.stubGlobal('hermesDesktop', { wordCompanion: { capture } })
  await expect(freezeSurfaceCapture(scope, original)).rejects.toThrow()
  expect(capture).not.toHaveBeenCalled()
})
