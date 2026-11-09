import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { $actionPanelEpoch, $actionPanelOwner, panelOwnerKey } from './action-panel-owner'
import { $atumShellEnabled } from './atum-shell'
import { $nativeAppRecency } from './native-app-recency'
import { $wordCompanion, $wordCompanionOpening, endWordCompanion, openWordCompanion, resetWordCompanionForTests, startWordCompanionLifecycle } from './word-companion'
import { adoptDraftWorkbenchScope, assistantChatWorkbenchScopeKey, markDraftWorkbenchBaseline, resetWorkbenchTabs, setWorkbenchScope } from './workbench-tabs'

const owner = {
  version: 1 as const,
  backend_id: '00000000-0000-4000-8000-bd7662a5eeb4',
  agent_id: '00000000-0000-4000-8000-b454f82c5857',
  accountId: 'account-a',
  connectionId: 'connection-a',
  profile: 'default',
  submission_dedup: true
}

const cleanup: Array<() => void> = []

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no})

  return { promise, reject, resolve }
}

beforeEach(() => {
  resetWordCompanionForTests()
  resetWorkbenchTabs()
  $atumShellEnabled.set(true)
  $actionPanelOwner.set(owner)
  $nativeAppRecency.set({})
  setWorkbenchScope(assistantChatWorkbenchScopeKey('chat-a'))
})

afterEach(() => {
  cleanup.splice(0).forEach(stop => stop())
  vi.unstubAllGlobals()
  resetWordCompanionForTests()
})

it('detaches immediately when a different assistant scope or owner becomes active', async () => {
  const end = vi.fn(async () => undefined)
  const onEnded = vi.fn(() => () => undefined)
  vi.stubGlobal('hermesDesktop', { wordCompanion: { open: vi.fn(async (_path: string, id: string) => ({ id, path: '/work/a.docx', name: 'a.docx' })), end, capture: vi.fn(), onEnded } })
  cleanup.push(startWordCompanionLifecycle())

  await openWordCompanion('/work/a.docx')
  expect($wordCompanion.get()?.scopeKey).toBe(assistantChatWorkbenchScopeKey('chat-a'))
  expect($nativeAppRecency.get()[owner.accountId]?.['com.microsoft.Word']).toBeGreaterThan(0)

  setWorkbenchScope(assistantChatWorkbenchScopeKey('chat-b'))
  expect($wordCompanion.get()).toBeNull()
  expect(end).toHaveBeenCalledWith(expect.any(String))

  setWorkbenchScope(assistantChatWorkbenchScopeKey('chat-a'))
  await openWordCompanion('/work/a.docx')
  $actionPanelOwner.set({ ...owner, accountId: 'account-b' })
  expect($wordCompanion.get()).toBeNull()
  expect(end).toHaveBeenCalledTimes(2)
})

it('cancels an opening request immediately and never lets its late result replace a newer pair', async () => {
  const first = deferred<{ id: string; path: string; name: string }>()
  const second = deferred<{ id: string; path: string; name: string }>()
  const open = vi.fn((_path: string, id: string) => open.mock.calls.length === 1 ? first.promise : second.promise)
  const end = vi.fn(async () => undefined)
  vi.stubGlobal('hermesDesktop', { wordCompanion: { open, end, capture: vi.fn(), onEnded: vi.fn(() => () => undefined) } })
  cleanup.push(startWordCompanionLifecycle())

  const openingA = openWordCompanion('/work/a.docx')
  const openingB = openWordCompanion('/work/b.docx')
  const firstId = open.mock.calls[0]?.[1] as string
  const secondId = open.mock.calls[1]?.[1] as string

  expect(end).toHaveBeenCalledWith(firstId)
  first.resolve({ id: firstId, path: '/work/a.docx', name: 'a.docx' })
  second.resolve({ id: secondId, path: '/work/b.docx', name: 'b.docx' })
  await Promise.all([openingA, openingB])

  expect($wordCompanion.get()?.descriptor).toEqual({ id: secondId, path: '/work/b.docx', name: 'b.docx' })
  expect(end).toHaveBeenCalledWith(firstId)

  await endWordCompanion()
  expect($wordCompanion.get()).toBeNull()
  expect($wordCompanionOpening.get()).toBe(false)
  expect(end).toHaveBeenCalledWith(secondId)
})

it('lets only draft adoption carry a companion association into its created chat', async () => {
  const end = vi.fn(async () => undefined)
  vi.stubGlobal('hermesDesktop', { wordCompanion: { open: vi.fn(async (_path: string, id: string) => ({ id, path: '/work/draft.docx', name: 'draft.docx' })), end, capture: vi.fn(), onEnded: vi.fn(() => () => undefined) } })
  markDraftWorkbenchBaseline()
  cleanup.push(startWordCompanionLifecycle())

  await openWordCompanion('/work/draft.docx')
  const draftScope = $wordCompanion.get()!.scopeKey
  adoptDraftWorkbenchScope('created-chat')
  const createdScope = assistantChatWorkbenchScopeKey('created-chat')
  setWorkbenchScope(createdScope)

  expect($wordCompanion.get()).toMatchObject({ ownerKey: panelOwnerKey(), scopeKey: createdScope })
  expect($wordCompanion.get()?.scopeKey).not.toBe(draftScope)

  setWorkbenchScope(assistantChatWorkbenchScopeKey('other-chat'))
  expect($wordCompanion.get()).toBeNull()
  expect(end).toHaveBeenCalledTimes(1)
})

it('treats a native ended event as authoritative without clearing a different pair', async () => {
  let ended!: (id: string) => void
  vi.stubGlobal('hermesDesktop', { wordCompanion: {
    open: vi.fn(async (_path: string, id: string) => ({ id, path: '/work/a.docx', name: 'a.docx' })),
    end: vi.fn(async () => undefined), capture: vi.fn(), onEnded: vi.fn(callback => {ended = callback;

 return () => undefined})
  } })
  cleanup.push(startWordCompanionLifecycle())
  await openWordCompanion('/work/a.docx')
  const id = $wordCompanion.get()!.descriptor.id

  ended('another-pair')
  expect($wordCompanion.get()?.descriptor.id).toBe(id)
  ended(id)
  expect($wordCompanion.get()).toBeNull()
  expect($actionPanelEpoch.get()).toBeGreaterThanOrEqual(0)
})
