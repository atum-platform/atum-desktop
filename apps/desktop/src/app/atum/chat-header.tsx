import { useStore } from '@nanostores/react'
import { useLocation } from 'react-router-dom'

import { routeDmConversationId, routeSessionId } from '@/app/routes'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { $atumAppCatalog } from '@/lib/atum-app-catalog'
import { LayoutSidebarRight } from '@/lib/icons'
import { $atumAccountScopeId, $atumSocialRelationships, $atumSortedRoster } from '@/store/atum-messaging'
import { $workspaceOpen, setWorkspaceOpen } from '@/store/atum-shell'

import { $atumAgents, $atumNewChatAgent, ATUM_AGENT_ID } from './agents'
import { AtumAssistantAvatar } from './assistant-avatar'
import { $atumAssistantChats } from './assistant-chats'
import { presentAtumConversation } from './roster'

/**
 * The conversation's identity, centred on the chat column's top row
 * (`main-header.tsx`): avatar 22 r6, then the name 14/600 and its one-line
 * description 13 faint on one baseline. The row is the header's; this owns
 * only what goes in the middle of it.
 */
export function AtumChatIdentity() {
  const { locale, t } = useI18n()
  const location = useLocation()
  const agents = useStore($atumAgents)
  const newChatAgent = useStore($atumNewChatAgent)
  const chats = useStore($atumAssistantChats)
  const conversations = useStore($atumSortedRoster)
  const accountId = useStore($atumAccountScopeId)
  const catalogState = useStore($atumAppCatalog)
  const catalog = catalogState.accountId === accountId ? catalogState.apps : []
  const people = useStore($atumSocialRelationships)

  const dmId = routeDmConversationId(location.pathname)
  const sessionId = routeSessionId(location.pathname)
  const conversation = dmId ? conversations.find(row => row.id === dmId) : undefined
  const dm = conversation ? presentAtumConversation(conversation, locale, { accountId, people }, catalog) : null

  const ownerId = sessionId ? (chats.find(chat => chat.sessionIds.includes(sessionId))?.agentId ?? newChatAgent) : newChatAgent
  const agent = agents.find(candidate => candidate.id === ownerId) ?? agents[0]
  const master = !agent || agent.isDefault
  const name = dm ? dm.title : agent?.title || t.atum.roster.assistant
  const description = dm ? dm.role : master ? t.atum.chat.assistantTagline : agent.description

  return (
    <div className="flex min-w-0 max-w-full items-center gap-2.5" data-atum-chat-header>
      {dm ? (
        dm.avatarUrl ? (
          <img alt="" className="atum-avatar size-[1.375rem] shrink-0 object-cover" src={dm.avatarUrl} />
        ) : (
          <span
            aria-hidden
            className="ak-avatar atum-avatar grid size-[1.375rem] shrink-0 place-items-center bg-(--ak-fill-quiet) text-[0.6875rem] font-semibold text-(--ak-ink-2)"
          >
            {dm.title.slice(0, 1).toUpperCase()}
          </span>
        )
      ) : (
        <AtumAssistantAvatar
          avatarUrl={agent?.avatarUrl}
          brand={master}
          className="size-[1.375rem] shrink-0 rounded-[var(--atum-r-avatar-sm)] text-[0.6875rem]"
          id={agent?.id ?? ATUM_AGENT_ID}
          name={name}
        />
      )}
      {/* Name and description share one baseline: two sizes and two weights
          centred separately drift apart by a pixel or two, and that is the
          "misaligned" the eye catches on a row this quiet. */}
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-[0.875rem] leading-[1.3] font-semibold text-(--atum-ink)" data-atum-chat-title>
          {name}
        </span>
        {description && (
          <span className="truncate text-[0.8125rem] leading-[1.3] font-normal text-(--atum-ink-faint)" data-atum-chat-subtitle>
            {description}
          </span>
        )}
      </span>
    </div>
  )
}

/**
 * The chat row's right-hand actions: only the open-workspace control, and
 * only while the panel is closed. The ⋯ menu that used to sit here held one
 * item, a duplicate of the sidebar's compose control, and is gone.
 */
export function AtumChatActions() {
  const { t } = useI18n()
  const workspaceOpen = useStore($workspaceOpen)

  if (workspaceOpen) {
    return null
  }

  return (
    <Tip label={t.atum.workspace.open}>
      <button
        aria-label={t.atum.workspace.open}
        className="atum-icon-btn relative size-[1.875rem] after:absolute after:-inset-1"
        data-atum-open-workspace
        data-icon-only
        onClick={() => setWorkspaceOpen(true)}
        type="button"
      >
        <LayoutSidebarRight aria-hidden className="size-[1.125rem]" />
      </button>
    </Tip>
  )
}
