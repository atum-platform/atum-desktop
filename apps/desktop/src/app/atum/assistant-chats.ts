/**
 * The one sanctioned crossing from Hermes sessions into the Atum roster.
 *
 * Atum shows the local assistant as many CHATS — one per Hermes session — the
 * way every consumer assistant does, so a document can be worked on in one
 * chat while another runs. What Atum still does not show is the Hermes
 * ORGANISATION around those sessions: profiles, projects, worktrees, branches,
 * pins, cron runs and messaging-platform threads. This module therefore reads
 * exactly one store (`store/session`) and projects rows the roster can render
 * without a single Hermes noun. `assistant-chats.test.ts` fences its import
 * graph the way `roster.test.ts` fences the roster's.
 */

import { computed } from 'nanostores'

import { $sessions, $unreadFinishedSessionIds, sessionPinId } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import { sessionRoute } from '../routes'

import { agentIdForSession } from './agents'

export interface AtumAssistantChat {
  /** Durable id (the lineage root) — also the chat's action-panel scope id. */
  id: string
  /**
   * The agent that owns this chat. The session list spans every agent, and a
   * session id is only unique within one backend, so the agent is what makes
   * a chat's panel scope and its roster group unambiguous.
   */
  agentId: string
  /** Every id that resolves to this chat: the live id and the lineage root. */
  sessionIds: string[]
  /** Server title when one exists; empty until the auto-titler has run. */
  title: string
  /** First-message preview the server keeps for the row. */
  preview: string
  /** ISO timestamp of the last activity, for ordering and the trailing time. */
  activityAt: string
  /** A turn finished while the user was elsewhere and hasn't been seen since. */
  unread: boolean
  route: string
}

function isoFromSeconds(seconds: number | null | undefined): string {
  const value = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 0

  return new Date(value * 1000).toISOString()
}

/** Pure projection so the ordering and unread rules are testable without stores. */
export function projectAssistantChats(
  sessions: readonly SessionInfo[],
  unreadIds: readonly string[]
): AtumAssistantChat[] {
  const unread = new Set(unreadIds)

  return sessions
    .filter(session => !session.archived && session.source !== 'atum-private-advisory')
    .map<AtumAssistantChat>(session => {
      const id = sessionPinId(session)
      const sessionIds = [...new Set([session.id, id])]

      return {
        id,
        agentId: agentIdForSession(session.profile),
        sessionIds,
        title: session.title?.trim() ?? '',
        preview: session.preview?.trim() ?? '',
        activityAt: isoFromSeconds(session.last_active || session.started_at),
        unread: sessionIds.some(candidate => unread.has(candidate)),
        route: sessionRoute(id)
      }
    })
    .sort((left, right) => right.activityAt.localeCompare(left.activityAt))
}

export const $atumAssistantChats = computed([$sessions, $unreadFinishedSessionIds], projectAssistantChats)

/**
 * The durable chat id behind a session route, resolved against the projected
 * chats so callers never touch sessions directly. Falls back to the route id
 * itself while the list has not loaded that row yet, so a freshly created chat
 * gets a stable scope before its first refresh.
 */
export function resolveAssistantChatId(
  routeSessionId: null | string,
  chats: readonly Pick<AtumAssistantChat, 'id' | 'sessionIds'>[]
): null | string {
  if (!routeSessionId) {
    return null
  }

  return chats.find(chat => chat.sessionIds.includes(routeSessionId))?.id ?? routeSessionId
}
