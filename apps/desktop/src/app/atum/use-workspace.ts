import { useStore } from '@nanostores/react'
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

import { routeDmConversationId, routeSessionId } from '@/app/routes'
import { $actionPanelEpoch, $actionPanelOwner, $panelDraftRevision, adoptActionPanelOwner, beginPanelOwnerResolution, panelOwnerKey, validPanelCapabilities } from '@/store/action-panel-owner'
import {
  $atumDmArtifactByConversation,
  type AtumDmArtifactTab,
  type AtumDmArtifactWorkspace,
  resolveAtumDmArtifact,
  setAtumDmForegroundConversation
} from '@/store/atum-dm-workspace'
import { $atumAccountScopeId } from '@/store/atum-messaging'
import { $gateway } from '@/store/gateway'
import { $activeProfile } from '@/store/profile'
import { $connection, $gatewayState } from '@/store/session'
import { ownsActionPanel } from '@/store/windows'
import { adoptProvisionalPanelOwner, assistantChatWorkbenchScopeKey, atumDmWorkbenchScopeKey, setWorkbenchScope } from '@/store/workbench-tabs'

import { $atumAssistantChats, resolveAssistantChatId } from './assistant-chats'

export interface AtumWorkspaceState {
  /** @deprecated Fixture compatibility; the unified strip owns selection. */
  activeTab?: 'details' | 'files' | 'view'
  /** @deprecated Fixture compatibility; surfaces now open on demand. */
  available?: Array<'details' | 'files' | 'view'>
  /** The DM conversation id when the foreground conversation is a hosted DM. */
  dmConversationId: null | string
  /** The workbench scope this surface owns; resources opened from the
   * panel land here even if the global scope has already moved on. */
  scopeKey: string
  artifact: AtumDmArtifactTab | null
  artifactWorkspace: AtumDmArtifactWorkspace | null
  /** The current surface has no artifact or preview, so View explains the
   *  workspace without manufacturing conversation-scoped tab state. */
  showLauncher: boolean
}

/**
 * Live workspace capability for the foreground conversation. Reading the
 * preview atoms here is a capability check, not a trigger — nothing in this
 * hook opens the workspace. `$workspaceOpen` is only ever set by an explicit
 * user gesture (the rim toggle), which is what keeps a background tool result
 * from stealing the layout.
 */
export function useAtumWorkspace(foreground = true): AtumWorkspaceState {
  const dmArtifacts = useStore($atumDmArtifactByConversation)
  const accountId = useStore($atumAccountScopeId)
  const owner = useStore($actionPanelOwner)
  useStore($panelDraftRevision)
  useStore($actionPanelEpoch)
  const gateway = useStore($gateway)
  const gatewayState = useStore($gatewayState)
  const profile = useStore($activeProfile)
  const connection = useStore($connection)
  const chats = useStore($atumAssistantChats)

  useEffect(() => {
    if (!foreground || !ownsActionPanel()) {return}
    let cancelled = false
    beginPanelOwnerResolution([accountId, connection?.connectionId, profile].join(':'))
    const epoch = $actionPanelEpoch.get()

    if (gateway && gatewayState === 'open' && accountId && connection?.connectionId) {
      void gateway.request<unknown>('context.capabilities', { profile }).then(capabilities => {
        if (cancelled || epoch !== $actionPanelEpoch.get() || !validPanelCapabilities(capabilities)) {return}
        const previous = adoptActionPanelOwner({ ...capabilities, accountId, profile, connectionId: connection?.connectionId ?? 'local' })
        adoptProvisionalPanelOwner(previous, panelOwnerKey())
      }).catch(() => { /* old gateway: panel remains ephemeral, automatic context unavailable */ })
    }

    return () => {cancelled = true}
  }, [accountId, connection?.connectionId, foreground, gateway, gatewayState, profile])
  void owner
  const location = useLocation()
  const dmConversationId = routeDmConversationId(location.pathname)
  // The assistant chat behind the route, resolved to its durable id so the
  // scope survives auto-compression. Null on the new-chat draft and on DMs.
  const chatId = dmConversationId ? null : resolveAssistantChatId(routeSessionId(location.pathname), chats.filter(chat => chat.agentId === profile))
  const artifactWorkspace = dmConversationId ? (dmArtifacts[dmConversationId] ?? null) : null

  const artifact =
    artifactWorkspace?.activeSurface === 'launcher'
      ? null
      : (artifactWorkspace?.tabs.find(tab => tab.ref.resourceId === artifactWorkspace.activeResourceId) ?? null)

  useEffect(() => {
    setAtumDmForegroundConversation(foreground ? dmConversationId : null)

    return () => setAtumDmForegroundConversation(null)
  }, [dmConversationId, foreground])

  // One scope owns every artifact, preview, app, browser, and utility surface:
  // an account-aware conversation scope for DMs, a per-chat scope for the
  // assistant, and the generic session scope for a draft that has no id yet.
  // This prevents identical resource identifiers from colliding across
  // accounts, conversations, or chats.
  const scopeKey = dmConversationId ? atumDmWorkbenchScopeKey(accountId, dmConversationId) : assistantChatWorkbenchScopeKey(chatId)

  useEffect(() => {
    if (!foreground) {return}
    setWorkbenchScope(scopeKey)
  }, [foreground, scopeKey])

  useEffect(() => {
    if (dmConversationId && artifact?.state === 'idle') {
      void resolveAtumDmArtifact(dmConversationId)
    }
  }, [artifact?.state, dmConversationId])

  const showLauncher = !artifact

  return {
    artifact,
    artifactWorkspace,
    dmConversationId,
    scopeKey,
    showLauncher
  }
}
