import { beforeEach, describe, expect, it, test, vi } from 'vitest'

import { $actionPanelOwner, panelDraftKey } from './action-panel-owner'
import { $atumShellEnabled } from './atum-shell'
import {
  $activeWorkbenchTabId,
  $visibleWorkbenchTabs,
  $workbenchTabs,
  adoptDraftWorkbenchScope,
  aliasAssistantChatScope,
  assistantChatWorkbenchScopeKey,
  atumDmWorkbenchScopeKey,
  closeWorkbenchScope,
  closeWorkbenchTab,
  ensureWorkbenchAppMenu,
  markDraftWorkbenchBaseline,
  migrateWorkbenchScope,
  openPreviewWorkbenchTab,
  openWorkbenchAppView,
  openWorkbenchBrowser,
  openWorkbenchSingleton,
  registerWorkbenchTabDisposer,
  resetWorkbenchTabs,
  setWorkbenchScope,
  showWorkbenchStart
} from './workbench-tabs'

const preview = {
  kind: 'file' as const,
  label: 'first.html',
  previewKind: 'html' as const,
  source: '/work/first.html',
  url: 'file:///work/first.html'
}

describe('unified scoped workbench registry', () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetWorkbenchTabs()
  })

  it('owns utility, browser, preview, and pinned app surfaces in one scoped strip', () => {
    ensureWorkbenchAppMenu('conversation-moon', 'moon')
    setWorkbenchScope('conversation-moon')
    openWorkbenchSingleton('files')
    openWorkbenchBrowser({ id: 'browser-1', partition: 'atum-consumer-browser-browser-1', status: 'ready', title: 'Browser', url: 'https://example.com/' })
    openPreviewWorkbenchTab(preview, { restore: 'persistent', scopeKey: 'conversation-moon' })

    expect($visibleWorkbenchTabs.get().map(tab => tab.surface.kind)).toEqual(['app-menu', 'files', 'browser', 'preview'])
    expect($workbenchTabs.get().filter(tab => tab.scopeKey === 'conversation-moon')).toHaveLength(4)
  })

  it('opens app views from {app, route_id} only, restores them by identity, and drops legacy app browser tabs', async () => {
    setWorkbenchScope('conversation-moon')
    expect(openWorkbenchAppView('moon', 'readings', 'Lá số')).toBe('workspace:conversation-moon:app-view:moon:readings')
    expect(openWorkbenchAppView('moon', 'readings', 'Lá số')).toBe('workspace:conversation-moon:app-view:moon:readings')
    expect(openWorkbenchAppView('moon', '/readings', 'x')).toBeNull()
    expect(openWorkbenchAppView('Moon', 'readings', 'x')).toBeNull()
    const tabs = $workbenchTabs.get().filter(tab => tab.surface.kind === 'app-view')
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ restore: 'persistent', surface: { app: 'moon', kind: 'app-view', routeId: 'readings' }, title: 'Lá số' })
    expect($activeWorkbenchTabId.get()).toBe(tabs[0].id)

    // Persisted registrations restore by identity; a legacy app browser tab (URL-bearing) is dropped.
    const persisted = JSON.parse(window.localStorage.getItem('hermes.desktop.workbenchTabs.v3') ?? '[]') as unknown[]
    expect(JSON.stringify(persisted)).not.toContain('http')
    window.localStorage.setItem('hermes.desktop.workbenchTabs.v3', JSON.stringify([
      ...persisted,
      { id: 'workspace:conversation-moon:browser:legacy', restore: 'persistent', scopeKey: 'conversation-moon', title: 'Moon', surface: { kind: 'browser', browser: { app: 'moon', id: 'legacy', partition: 'persist:atum-app-moon', status: 'ready', title: 'Moon', url: 'https://moon.example/chart', webOrigin: 'https://moon.example' } } },
      { id: 'workspace:conversation-moon:app-view:moon:chat', restore: 'persistent', scopeKey: 'conversation-moon', title: 'Chat', surface: { kind: 'app-view', app: 'moon', routeId: 'chat' } },
      { id: 'workspace:conversation-moon:app-view:moon:bad', restore: 'persistent', scopeKey: 'conversation-moon', title: 'Bad', surface: { kind: 'app-view', app: 'moon', routeId: 'chat' } }
    ]))
    // A fresh module instance hydrates from storage the way a restarted renderer does.
    vi.resetModules()
    const fresh = await import('./workbench-tabs')
    const restored = fresh.$workbenchTabs.get().filter(tab => tab.scopeKey === 'conversation-moon')
    expect(restored.map(tab => tab.id)).toEqual(['workspace:conversation-moon:app-view:moon:readings', 'workspace:conversation-moon:app-view:moon:chat'])
    expect(JSON.stringify(restored)).not.toContain('http')
  })

  it('keeps active selection isolated per conversation scope', () => {
    setWorkbenchScope('conversation-a')
    openWorkbenchSingleton('files')
    const files = $activeWorkbenchTabId.get()

    setWorkbenchScope('conversation-b')
    expect($visibleWorkbenchTabs.get()).toEqual([])
    expect($activeWorkbenchTabId.get()).toBeNull()
    openWorkbenchSingleton('tools')

    setWorkbenchScope('conversation-a')
    expect($activeWorkbenchTabId.get()).toBe(files)
    expect($visibleWorkbenchTabs.get().map(tab => tab.surface.kind)).toEqual(['files'])
  })

  it('gives identical browser and preview resources distinct account-aware conversation identities', () => {
    const accountA = atumDmWorkbenchScopeKey('account-a', 'conversation')
    const accountB = atumDmWorkbenchScopeKey('account-b', 'conversation')
    const browser = { id: 'shared-browser', partition: 'atum-consumer-browser-shared-browser', status: 'ready' as const, title: 'Web', url: 'https://example.test' }

    setWorkbenchScope(accountA)
    openWorkbenchBrowser(browser)
    openPreviewWorkbenchTab(preview, { restore: 'session', scopeKey: accountA })
    setWorkbenchScope(accountB)
    openWorkbenchBrowser(browser)
    openPreviewWorkbenchTab(preview, { restore: 'session', scopeKey: accountB })

    expect($workbenchTabs.get()).toHaveLength(4)
    expect(new Set($workbenchTabs.get().map(tab => tab.id)).size).toBe(4)
    closeWorkbenchScope(accountA)
    expect($workbenchTabs.get().map(tab => tab.scopeKey)).toEqual([accountB, accountB])
  })

  it('deduplicates singletons, preserves siblings on close, and supports the start page', () => {
    openWorkbenchSingleton('files')
    openWorkbenchSingleton('tools')
    openWorkbenchSingleton('files')
    expect($visibleWorkbenchTabs.get().map(tab => tab.surface.kind)).toEqual(['files', 'tools'])

    const files = $activeWorkbenchTabId.get()
    closeWorkbenchTab(files!)
    expect($activeWorkbenchTabId.get()).toContain(':tools')

    showWorkbenchStart()
    expect($activeWorkbenchTabId.get()).toBeNull()
  })

  it('does not close a pinned app menu and removes only an owning scope', () => {
    ensureWorkbenchAppMenu('conversation-moon', 'moon')
    setWorkbenchScope('conversation-moon')
    const menu = $visibleWorkbenchTabs.get()[0]!
    closeWorkbenchTab(menu.id)
    expect($visibleWorkbenchTabs.get()).toHaveLength(1)

    setWorkbenchScope('conversation-andy')
    openWorkbenchSingleton('details')
    closeWorkbenchScope('conversation-moon')
    expect($workbenchTabs.get().map(tab => tab.scopeKey)).toEqual(['conversation-andy'])
  })
})

describe('assistant chat scopes', () => {
  const firstOwner = { version: 1 as const, backend_id: '00000000-0000-4000-8000-bd7662a5eeb4', agent_id: '00000000-0000-4000-8000-b454f82c5857', accountId: 'account-a', connectionId: 'connection-a', profile: 'default', submission_dedup: true }
  beforeEach(() => {resetWorkbenchTabs(); $atumShellEnabled.set(true); $actionPanelOwner.set(firstOwner)})

  it('separates equal conversation ids by account, backend, and stable agent identity', () => {
    const original = assistantChatWorkbenchScopeKey('same')
    setWorkbenchScope(original); openWorkbenchSingleton('files')

    for (const change of [{ accountId: 'account-b' }, { backend_id: crypto.randomUUID() }, { agent_id: crypto.randomUUID() }]) {
      $actionPanelOwner.set({ ...firstOwner, ...change })
      const foreign = assistantChatWorkbenchScopeKey('same')
      expect(foreign).not.toBe(original)
      setWorkbenchScope(foreign)
      expect($visibleWorkbenchTabs.get()).toEqual([])
    }

    $actionPanelOwner.set({ ...firstOwner, profile: 'renamed' })
    expect(assistantChatWorkbenchScopeKey('same')).toBe(original)
    setWorkbenchScope(original)
    expect($visibleWorkbenchTabs.get().map(tab => tab.surface.kind)).toEqual(['files'])
  })

  it('keeps compression aliases inside their owner', () => {
    const root = assistantChatWorkbenchScopeKey('root')
    aliasAssistantChatScope('tip', 'root'); aliasAssistantChatScope('tip-2', 'tip')
    expect(assistantChatWorkbenchScopeKey('tip-2')).toBe(root)
    $actionPanelOwner.set({ ...firstOwner, agent_id: crypto.randomUUID() })
    expect(assistantChatWorkbenchScopeKey('tip')).not.toBe(assistantChatWorkbenchScopeKey('root'))
  })

  it('adopts only the current owned draft and preserves its active tab', () => {
    setWorkbenchScope('session'); openWorkbenchSingleton('tools')
    markDraftWorkbenchBaseline()
    const draft = panelDraftKey()
    openWorkbenchSingleton('files')
    openPreviewWorkbenchTab(preview, { restore: 'persistent', scopeKey: draft })
    adoptDraftWorkbenchScope('root')
    const root = assistantChatWorkbenchScopeKey('root')
    expect($visibleWorkbenchTabs.get().map(tab => tab.scopeKey)).toEqual([root, root])
    expect($activeWorkbenchTabId.get()).toBe(`workspace:${root}:files`)
    expect($workbenchTabs.get().find(tab => tab.scopeKey === 'session')?.surface.kind).toBe('tools')
    markDraftWorkbenchBaseline()
    expect(panelDraftKey()).not.toBe(draft)
    expect($visibleWorkbenchTabs.get()).toEqual([])
  })

  it('persists resolved scopes and never provisional scopes or frozen bytes', () => {
    const root = assistantChatWorkbenchScopeKey('root')
    openPreviewWorkbenchTab(preview, { restore: 'persistent', scopeKey: root })
    $actionPanelOwner.set(null)
    const pending = assistantChatWorkbenchScopeKey('root')
    openPreviewWorkbenchTab({ ...preview, url: 'file:///temporary' }, { restore: 'persistent', scopeKey: pending })
    const stored = JSON.parse(window.localStorage.getItem('hermes.desktop.workbenchTabs.v3') || '[]')
    expect(stored.map((tab: { scopeKey: string }) => tab.scopeKey)).toEqual([root])
    expect(JSON.stringify(stored)).not.toContain('pending:')
  })

  it('closes one chat without touching another', () => {
    const first = assistantChatWorkbenchScopeKey('first'), second = assistantChatWorkbenchScopeKey('second')
    setWorkbenchScope(first); openWorkbenchSingleton('files')
    setWorkbenchScope(second); openWorkbenchSingleton('tools')
    closeWorkbenchScope(first)
    expect($workbenchTabs.get().map(tab => tab.scopeKey)).toEqual([second])
  })
})

test('one conversation owns one app menu, and a foreign one is given up', () => {
  const scope = 'atum-dm:acct:conversation-a'

  ensureWorkbenchAppMenu(scope, 'moon')
  expect($workbenchTabs.get().filter(tab => tab.scopeKey === scope && tab.surface.kind === 'app-menu')).toHaveLength(1)

  // What a cross-pin used to leave behind: a second app's menu in the same
  // conversation, pinned and persisted, which nothing could close.
  ensureWorkbenchAppMenu(scope, 'andy')

  const menus = $workbenchTabs.get().filter(tab => tab.scopeKey === scope && tab.surface.kind === 'app-menu')

  expect(menus).toHaveLength(1)
  expect(menus[0]?.surface).toMatchObject({ app: 'andy', kind: 'app-menu' })

  // Another conversation keeps its own, untouched.
  ensureWorkbenchAppMenu('atum-dm:acct:conversation-b', 'moon')
  expect($workbenchTabs.get().filter(tab => tab.surface.kind === 'app-menu').map(tab => tab.surface.kind === 'app-menu' && tab.surface.app).sort()).toEqual(['andy', 'moon'])
})

it('draft adoption keeps native grants alive until the rehomed view actually closes', () => {
  resetWorkbenchTabs()
  setWorkbenchScope('draft-scope')
  const dispose = vi.fn()
  const remove = registerWorkbenchTabDisposer(dispose)

  try {
    const id = openPreviewWorkbenchTab({ kind: 'file', label: 'file.xlsx', source: '/work/file.xlsx', url: 'atum-file:grant', previewKind: 'card', contextFile: { token: 'grant' } }, { scopeKey: 'draft-scope', restore: 'session' })
    const viewKey = $workbenchTabs.get().find(tab => tab.id === id)?.viewKey
    migrateWorkbenchScope('draft-scope', 'owned-chat')
    expect(dispose).not.toHaveBeenCalled()
    expect($workbenchTabs.get()).toEqual(expect.arrayContaining([expect.objectContaining({ scopeKey: 'owned-chat', viewKey })]))
    closeWorkbenchScope('owned-chat')
    expect(dispose).toHaveBeenCalledTimes(1)
  } finally {remove()}
})
