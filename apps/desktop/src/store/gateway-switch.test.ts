import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $actionPanelOwner } from '@/store/action-panel-owner'
import { $sessionsLimit, resetSessionsLimit, SIDEBAR_SESSIONS_PAGE_SIZE } from '@/store/layout'
import {
  $cronSessions,
  $freshDraftReady,
  $messagingSessions,
  $sessions,
  $sessionsLoading,
  $sessionsTotal,
  setCronSessions,
  setFreshDraftReady,
  setMessagingSessions,
  setSessions,
  setSessionsLoading,
  setSessionsTotal
} from '@/store/session'
import { $stalledSessionIds } from '@/store/session-states'
import { $workbenchTabs, assistantChatWorkbenchScopeKey, openWorkbenchSingleton, resetWorkbenchTabs, setWorkbenchScope } from '@/store/workbench-tabs'

import { $queuedPromptsBySession, enqueueQueuedPrompt, QUEUE_RECOVERY_KEY } from './composer-queue'
import { $documentContext, documentContextForScope, setDocumentSelection, suppressDocumentContext } from './document-context'
import { $gatewaySwitching, wipeSessionListsForGatewaySwitch } from './gateway-switch'
import { $currentCwd } from './session'
import { openPreviewWorkbenchTab, revealWorkbenchTab } from './workbench-tabs'

vi.mock('@/lib/query-client', () => ({
  invalidateProfileScopedQueries: vi.fn()
}))

describe('wipeSessionListsForGatewaySwitch', () => {
  beforeEach(() => {
    $actionPanelOwner.set({ version: 1, backend_id: '00000000-0000-4000-8000-bd7662a5eeb4', agent_id: '00000000-0000-4000-8000-b454f82c5857', accountId: 'test', connectionId: 'local', profile: 'default', submission_dedup: true })
    $gatewaySwitching.set(false)
    setSessions([{ id: 's1', title: 'old', profile: 'default' } as never])
    setSessionsTotal(1)
    setCronSessions([{ id: 'c1', title: 'cron', profile: 'default' } as never])
    setMessagingSessions([{ id: 'm1', title: 'tg', profile: 'default' } as never])
    $stalledSessionIds.set(['s1'])
    setSessionsLoading(false)
    setFreshDraftReady(false)
    $sessionsLimit.set(SIDEBAR_SESSIONS_PAGE_SIZE * 3)
  })

  afterEach(() => {
    resetSessionsLimit()
    setSessions([])
    setCronSessions([])
    setMessagingSessions([])
    $stalledSessionIds.set([])
    setSessionsLoading(true)
    $gatewaySwitching.set(false)
  })

  it('closes assistant-chat panels keyed by the old backend but keeps DM and generic scopes', async () => {
    resetWorkbenchTabs()
    setWorkbenchScope(assistantChatWorkbenchScopeKey('s1'))
    openWorkbenchSingleton('files')
    setWorkbenchScope('atum-dm:account-a:moon')
    openWorkbenchSingleton('tools')
    setWorkbenchScope(null)
    openWorkbenchSingleton('details')

    wipeSessionListsForGatewaySwitch()

    expect($workbenchTabs.get().map(tab => tab.scopeKey)).toEqual(['atum-dm:account-a:moon', 'session'])
    resetWorkbenchTabs()
  })

  it('clears lists and arms loading so sidebar skeletons retrigger', async () => {
    wipeSessionListsForGatewaySwitch()

    expect($sessions.get()).toEqual([])
    expect($sessionsTotal.get()).toBe(0)
    expect($cronSessions.get()).toEqual([])
    expect($messagingSessions.get()).toEqual([])
    expect($stalledSessionIds.get()).toEqual([])
    expect($sessionsLoading.get()).toBe(true)
    expect($sessionsLimit.get()).toBe(SIDEBAR_SESSIONS_PAGE_SIZE)
    expect($freshDraftReady.get()).toBe(true)
  })

  it('detaches queued text and document memory before another backend reuses the session id', async () => {
    resetWorkbenchTabs()
    localStorage.removeItem(QUEUE_RECOVERY_KEY)
    $currentCwd.set('/workspace')
    const scope = assistantChatWorkbenchScopeKey('same-id')
    setWorkbenchScope(scope)
    const target = { kind: 'file' as const, path: '/workspace/a.md', source: '/workspace/a.md', url: 'file:///workspace/a.md', label: 'a.md' }
    revealWorkbenchTab(openPreviewWorkbenchTab(target, { scopeKey: scope, restore: 'session' }))
    setDocumentSelection({ path: target.path, start: 0, end: 3, text: 'old text' })
    suppressDocumentContext(scope, target.path)
    await enqueueQueuedPrompt('same-id', { text: 'keep this draft', attachments: [] })

    wipeSessionListsForGatewaySwitch()

    expect($queuedPromptsBySession.get()).toEqual({})
    expect(localStorage.getItem('hermes.desktop.composerQueue.v1')).toBeNull()
    expect(JSON.parse(localStorage.getItem(QUEUE_RECOVERY_KEY)!)).toEqual([expect.objectContaining({ text: 'keep this draft' })])
    expect(documentContextForScope(scope)).toBeNull()
    setWorkbenchScope(scope)
    revealWorkbenchTab(openPreviewWorkbenchTab(target, { scopeKey: scope, restore: 'session' }))
    expect($documentContext.get()?.selection).toBeNull()
    expect($documentContext.get()?.state).toBe('ready')
    localStorage.removeItem(QUEUE_RECOVERY_KEY)
    resetWorkbenchTabs()
  })
})
