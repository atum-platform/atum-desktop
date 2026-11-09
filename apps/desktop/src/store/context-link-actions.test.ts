import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AtumConsumerFileOpenResult } from '@/global'
import { documentDisplayName } from '@/lib/document-path'

import { $actionPanelEpoch, $actionPanelOwner } from './action-panel-owner'
import { $atumShellEnabled } from './atum-shell'
import { captureLinkedSavedFile, linkSavedDocument, linkWordDocument, removeContextLink, useAutomaticContext } from './context-link-actions'
import { $contextLinkBinding, $contextLinkError, contextLinkForScope, resetConversationContextLinksForTests, startConversationContextLinks } from './conversation-context-links'
import { $wordCompanion, resetWordCompanionForTests } from './word-companion'
import { $workbenchTabs, openPreviewWorkbenchTab, resetWorkbenchTabs, setWorkbenchScope } from './workbench-tabs'

const owner = {
  version: 1 as const,
  backend_id: '00000000-0000-4000-8000-bd7662a5eeb4',
  agent_id: '00000000-0000-4000-8000-b454f82c5857',
  accountId: 'account-a',
  connectionId: 'connection-a',
  profile: 'default',
  submission_dedup: true
}

const scope = 'atum-chat:account-a:chat-a'
const original = window.hermesDesktop
let stopLifecycle: (() => void) | undefined

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {resolve = done})

  return { promise, resolve }
}

beforeEach(() => {
  window.localStorage.clear()
  resetConversationContextLinksForTests()
  resetWordCompanionForTests()
  resetWorkbenchTabs()
  $atumShellEnabled.set(true)
  $actionPanelEpoch.set(0)
  $actionPanelOwner.set(owner)
  setWorkbenchScope(scope)
})

afterEach(() => {
  stopLifecycle?.()
  stopLifecycle = undefined
  window.hermesDesktop = original
  resetConversationContextLinksForTests()
  resetWordCompanionForTests()
  window.localStorage.clear()
  vi.restoreAllMocks()
})

it('keeps a linked Word document after show-beside fails and only removes authority explicitly', async () => {
  const bind = vi.fn(async () => ({ id: 'word-a', name: 'a.docx', path: '/home/example/a.docx' }))
  const showBeside = vi.fn(async () => {throw new Error('WORD_SCREEN_TOO_SMALL')})
  const unbind = vi.fn(async () => undefined)
  window.hermesDesktop = { wordCompanion: { linkingVersion: 1, bind, showBeside, unbind } } as never

  await expect(linkWordDocument({ path: '/home/example/a.docx' })).resolves.toBe(true)
  expect(contextLinkForScope()).toMatchObject({ mode: 'linked', state: 'ready', target: { kind: 'word', path: '/home/example/a.docx' } })
  expect(showBeside).toHaveBeenCalledWith('word-a')
  expect($contextLinkError.get()).toBe('CONTEXT_LINK_SHOW_FAILED:WORD_SCREEN_TOO_SMALL')

  expect(removeContextLink()).toBe(true)
  expect(contextLinkForScope()).toMatchObject({ mode: 'removed', state: 'ready' })
  expect(unbind).toHaveBeenCalledWith('word-a')
})

it('publishes a returned Word geometry descriptor without replacing manual content authority', async () => {
  const bind = vi.fn(async () => ({ id: 'binding-a', name: 'a.docx', path: '/home/example/a.docx' }))
  const showBeside = vi.fn(async () => ({ id: 'geometry-a', name: 'a.docx', path: '/home/example/a.docx' }))
  window.hermesDesktop = { wordCompanion: { bind, end: vi.fn(async () => undefined), linkingVersion: 1, showBeside, unbind: vi.fn(async () => undefined) } } as never

  await expect(linkWordDocument({ path: '/home/example/a.docx' })).resolves.toBe(true)
  expect($wordCompanion.get()?.descriptor.id).toBe('geometry-a')
  expect(contextLinkForScope().binding?.word?.id).toBe('binding-a')
})

it('links a workspace-text panel by its stable relative reader identity', async () => {
  const id = openPreviewWorkbenchTab({
    kind: 'file', label: 'draft.md', source: 'atum-file:lease', url: 'atum-file:lease',
    workspaceTextFile: { displayName: 'draft.md', fileRef: 'lease', workspaceRelativePath: 'notes/draft.md' }
  }, { restore: 'session', scopeKey: scope })

  const tab = $workbenchTabs.get().find(item => item.id === id)!
  const { linkPanelDocument } = await import('./context-link-actions')

  await expect(linkPanelDocument(tab, { show: false })).resolves.toBe(true)
  expect(contextLinkForScope().target).toMatchObject({ kind: 'panel', path: 'notes/draft.md', viewKey: tab.viewKey ?? tab.id })
})

it('restores the old Word binding when a replacement cannot persist', async () => {
  let ended: (id: string) => void = () => undefined
  let nativeId: string | undefined

  const bind = vi.fn(async (request: { path: string }) => ({
    id: request.path.includes('old') ? `old-${bind.mock.calls.length}` : 'new',
    name: documentDisplayName(request.path),
    path: request.path
  }))

  const unbind = vi.fn(async () => undefined)

  const nativeBind = async (request: { path: string }) => {
    const next = await bind(request)

    if (nativeId) {ended(nativeId)}
    nativeId = next.id

    return next
  }

  window.hermesDesktop = { wordCompanion: { bind: nativeBind, linkingVersion: 1, unbind, onBindingEnded: (listener: typeof ended) => {ended = listener;

 return () => undefined} } } as never
  stopLifecycle = startConversationContextLinks()
  await expect(linkWordDocument({ path: '/home/example/old.docx' }, { show: false })).resolves.toBe(true)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {throw new Error('quota')})

  await expect(linkWordDocument({ path: '/home/example/new.docx' }, { show: false })).resolves.toBe(false)
  expect(contextLinkForScope()).toMatchObject({ mode: 'linked', state: 'ready', target: { path: '/home/example/old.docx' } })
  expect(bind).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/home/example/old.docx' }))
  expect($contextLinkBinding.get()?.word?.path).toBe('/home/example/old.docx')
})

it('revalidates the returning conversation after lifecycle cleanup without arranging', async () => {
  const bind = vi.fn(async () => ({ id: `binding-${bind.mock.calls.length}`, name: 'a.docx', path: '/home/example/a.docx' }))
  const showBeside = vi.fn()
  window.hermesDesktop = { wordCompanion: { bind, linkingVersion: 1, unbind: vi.fn(async () => undefined), showBeside } } as never
  stopLifecycle = startConversationContextLinks()
  await linkWordDocument({ path: '/home/example/a.docx' }, { show: false })
  setWorkbenchScope('atum-chat:account-a:chat-b')
  expect($contextLinkBinding.get()).toBeNull()
  setWorkbenchScope(scope)
  await vi.waitFor(() => expect(contextLinkForScope().state).toBe('ready'))
  expect(bind).toHaveBeenCalledTimes(2)
  expect(showBeside).not.toHaveBeenCalled()
  expect($contextLinkError.get()).toBeNull()
})

it('requires explicit Reconnect when entering a restored chat from the initial session scope', async () => {
  const bind = vi.fn(async () => ({ id: 'binding-a', name: 'a.docx', path: '/home/example/a.docx' }))
  window.hermesDesktop = { wordCompanion: { bind, linkingVersion: 1, unbind: vi.fn(async () => undefined) } } as never
  stopLifecycle = startConversationContextLinks()
  await linkWordDocument({ path: '/home/example/a.docx' }, { show: false })
  setWorkbenchScope('session')
  setWorkbenchScope(scope)
  await Promise.resolve()
  expect(contextLinkForScope()).toMatchObject({ mode: 'linked', state: 'unavailable' })
  expect(bind).toHaveBeenCalledTimes(1)
})

it('refreshes only the linked saved-file token after an inode-bound capture changes', async () => {
  const capture = vi.fn(async (token: string) => {
    if (token === 'old') {throw new Error('CONSUMER_FILES_MISSING')}

    return { dataUrl: 'data:text/plain;base64,bmV3', revision: 'new' }
  })

  const open = vi.fn(async (): Promise<AtumConsumerFileOpenResult> => open.mock.calls.length === 1
    ? { kind: 'card', size: 1, token: 'old' }
    : { kind: 'card', size: 1, token: 'fresh' })

  const releaseView = vi.fn(async () => true)
  window.hermesDesktop = { consumerFiles: { capture, open, releaseView } } as never

  await expect(linkSavedDocument({ office: 'excel', path: '/home/example/budget.xlsx' }, { show: false })).resolves.toBe(true)
  const linked = contextLinkForScope()
  const result = await captureLinkedSavedFile(linked.binding!, linked.target as Extract<typeof linked.target, { kind: 'saved-file' }>)

  expect(result).toEqual({ dataUrl: 'data:text/plain;base64,bmV3', revision: 'new' })
  expect($contextLinkBinding.get()?.fileToken).toBe('fresh')
  expect(releaseView).toHaveBeenCalledWith('old')
})

it('releases a late provisional grant without replacing the existing manual selection', async () => {
  const opening = deferred<AtumConsumerFileOpenResult>()
  const releaseView = vi.fn(async () => true)
  window.hermesDesktop = { consumerFiles: { open: vi.fn(() => opening.promise), releaseView } } as never

  const pending = linkSavedDocument({ office: 'powerpoint', path: '/home/example/roadmap.pptx' }, { show: false })
  setWorkbenchScope('atum-chat:account-a:chat-b')
  // A -> B -> A must not make the original stale request current again.
  setWorkbenchScope(scope)
  opening.resolve({ kind: 'card', size: 1, token: 'late' })

  await expect(pending).resolves.toBe(false)
  expect(releaseView).toHaveBeenCalledWith('late')
  expect(contextLinkForScope()).toMatchObject({ mode: 'automatic' })
})

it('returns to automatic only after its persisted intent is cleared and releases the manual token', async () => {
  const releaseView = vi.fn(async () => true)
  window.hermesDesktop = { consumerFiles: { open: vi.fn(async () => ({ kind: 'card', size: 1, token: 'manual' })), releaseView } } as never
  await linkSavedDocument({ office: 'excel', path: '/home/example/budget.xlsx' }, { show: false })

  expect(useAutomaticContext()).toBe(true)
  expect(contextLinkForScope()).toMatchObject({ mode: 'automatic' })
  expect(releaseView).toHaveBeenCalledWith('manual')
})
