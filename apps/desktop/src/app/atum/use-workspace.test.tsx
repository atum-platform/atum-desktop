import { act, cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $actionPanelEpoch, $actionPanelOwner, panelDraftKey, panelOwnerKey } from '@/store/action-panel-owner'
import * as AtumDmWorkspaceStore from '@/store/atum-dm-workspace'
import { $atumDmArtifactByConversation, clearAtumDmWorkspace } from '@/store/atum-dm-workspace'
import { $atumAccountStatus } from '@/store/atum-messaging'
import { $gateway } from '@/store/gateway'
import { $connection, $gatewayState, $sessions } from '@/store/session'
import { $workbenchScope, aliasAssistantChatScope, assistantChatWorkbenchScopeKey, resetWorkbenchTabs } from '@/store/workbench-tabs'
import type { SessionInfo } from '@/types/hermes'

import { useAtumWorkspace } from './use-workspace'

function Probe({ foreground = true }: { foreground?: boolean }) {
  const workspace = useAtumWorkspace(foreground)

  return <output data-testid="workspace-probe">{JSON.stringify({
    artifactId: workspace.artifact?.ref.resourceId ?? null,
    dmConversationId: workspace.dmConversationId,
    showLauncher: workspace.showLauncher
  })}</output>
}

function renderAt(path: string) {
  const view = render(<MemoryRouter initialEntries={[path]}><Probe /></MemoryRouter>)

  return JSON.parse(view.container.querySelector('[data-testid="workspace-probe"]')?.textContent || '{}') as Record<string, unknown>
}

beforeEach(() => {
  clearAtumDmWorkspace()
  resetWorkbenchTabs()
  $sessions.set([])
  $atumAccountStatus.set({
    state: 'signed_in',
    configured: true,
    account: { id: 'account-a', displayName: 'Minh' },
    errorCode: null,
    providers: { google: true, password: true }
  })
})
afterEach(() => cleanup())

describe('useAtumWorkspace conversation ownership', () => {
  it('owns foreground conversation wiring and suppresses it while the shell is gated', () => {
    const setForeground = vi.spyOn(AtumDmWorkspaceStore, 'setAtumDmForegroundConversation')
    const view = render(<MemoryRouter initialEntries={['/dm/moon']}><Probe /></MemoryRouter>)

    expect(setForeground).toHaveBeenCalledWith('moon')
    view.rerender(<MemoryRouter initialEntries={['/dm/moon']}><Probe foreground={false} /></MemoryRouter>)
    expect(setForeground).toHaveBeenLastCalledWith(null)
  })

  it('projects only the current conversation artifact state', () => {
    $atumDmArtifactByConversation.set({
      moon: {
        activeResourceId: 'moon.laso:ready', activeSurface: 'artifact', closedRefs: [], tabs: [{
          ref: { kind: 'artifact', resourceId: 'moon.laso:ready', status: 'ready', title: 'Lá số', type: 'reading' },
          state: 'ready', target: null, targetExpiresAt: null
        }]
      }
    })

    expect(renderAt('/dm/moon')).toMatchObject({ artifactId: 'moon.laso:ready', dmConversationId: 'moon', showLauncher: false })
    expect(renderAt('/dm/andy')).toMatchObject({ artifactId: null, dmConversationId: 'andy', showLauncher: true })
  })

  it('selects the account-aware DM scope, a per-chat scope on a session route, and the draft scope on the new-chat route', () => {
    const dm = render(<MemoryRouter initialEntries={['/dm/moon']}><Probe /></MemoryRouter>)
    expect($workbenchScope.get()).toBe('atum-dm:account-a:moon')
    dm.unmount()

    const chat = render(<MemoryRouter initialEntries={['/sess-1']}><Probe /></MemoryRouter>)
    expect($workbenchScope.get()).toBe(assistantChatWorkbenchScopeKey('sess-1'))
    chat.unmount()

    render(<MemoryRouter initialEntries={['/']}><Probe /></MemoryRouter>)
    expect($workbenchScope.get()).toBe(panelDraftKey())
  })

  it('keys a chat scope by its lineage root so auto-compression cannot strand the panel', () => {
    $sessions.set([{ id: 'tip-9', _lineage_root_id: 'root-1' } as SessionInfo])

    render(<MemoryRouter initialEntries={['/tip-9']}><Probe /></MemoryRouter>)
    expect($workbenchScope.get()).toBe(assistantChatWorkbenchScopeKey('root-1'))
  })

  it('stays on the root scope during the refresh gap after a rotation, before the tip row exists', () => {
    // The rotation handler records tip -> root before navigating; $sessions
    // still carries only the root row (or nothing) until the next refresh.
    aliasAssistantChatScope('tip-9', 'root-1')
    $sessions.set([{ id: 'root-1' } as SessionInfo])

    render(<MemoryRouter initialEntries={['/tip-9']}><Probe /></MemoryRouter>)
    expect($workbenchScope.get()).toBe(assistantChatWorkbenchScopeKey('root-1'))
  })
})

it('keeps the established owner and queue namespace through a transport reconnect', async () => {
  const caps = { version: 1, backend_id: crypto.randomUUID(), agent_id: crypto.randomUUID(), submission_dedup: true }
  $connection.set({ connectionId: 'reconnect' } as never)
  $gateway.set({ request: vi.fn(async () => caps) } as never)
  $gatewayState.set('open')
  const view = render(<MemoryRouter><Probe /></MemoryRouter>)
  await waitFor(() => expect($actionPanelOwner.get()?.agent_id).toBe(caps.agent_id))
  const key = panelOwnerKey()
  const epoch = $actionPanelEpoch.get()
  act(() => $gatewayState.set('closed'))
  expect(panelOwnerKey()).toBe(key)
  expect($actionPanelEpoch.get()).toBe(epoch)
  act(() => $gatewayState.set('open'))
  await waitFor(() => expect($actionPanelOwner.get()?.agent_id).toBe(caps.agent_id))
  expect($actionPanelEpoch.get()).toBe(epoch)
  view.unmount(); $gateway.set(null); $connection.set(null); $actionPanelOwner.set(null)
})
