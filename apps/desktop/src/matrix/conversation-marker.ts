import type { MatrixClient, Room } from 'matrix-js-sdk'

import {
  CONVERSATION_STATE_TYPE,
  parseConversationMarker,
  resolveConversationRoom
} from '../../shared/agent-conversation'
import { AGENT_ONE_CONVERSATION } from '../../shared/agent-conversation/enabled'
import type { ConversationMarker, ConversationResolution } from '../../shared/agent-conversation/types'
import type { MatrixRoom } from '../../shared/matrix'
import { isAssistantRoom, MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

/** Marker authority is the already-validated room owner, never a marker field. */
export function conversationMarkerFromState(
  state: Awaited<ReturnType<MatrixClient['roomState']>>,
  input: { roomId: string; ownerId: string }
): ConversationMarker | null {
  return parseConversationMarker({
    ...input,
    event: state.find(event => event.type === CONVERSATION_STATE_TYPE && event.state_key === '')
  })
}

/** Only explicit server denials are definitive. Unknown/network errors stay transient. */
export function conversationReadFailure(error: unknown): 'unreachable' | 'transient' {
  const code = typeof error === 'object' && error !== null && 'errcode' in error ? error.errcode : undefined

  return code === 'M_FORBIDDEN' || code === 'M_NOT_FOUND' ? 'unreachable' : 'transient'
}

/** SDK projection for display/home selection; turn admission re-reads server state. */
export interface ConversationRoomProjection extends MatrixRoom {
  conversation?: ConversationMarker | null
  conversationOwnerId?: string
}

/** A projection names whose SDK checked the sender, so an agent's snapshot cannot
 * masquerade as an owner-checked marker in a human or controller selection. */
export function projectedConversationMarker(room: Room, ownerId: string): ConversationMarker | null {
  return room.getType() === MATRIX_ASSISTANT_ROOM_TYPE
    ? parseConversationMarker({ roomId: room.roomId, ownerId, event: room.currentState.getStateEvents(CONVERSATION_STATE_TYPE, '')?.event })
    : null
}

export function resolveProjectedConversation(
  rooms: readonly ConversationRoomProjection[],
  ownerId: string | undefined,
  agentId: string | undefined
): ConversationResolution {
  return resolveConversationRoom(
    AGENT_ONE_CONVERSATION && ownerId && agentId
      ? rooms.filter(room => isAssistantRoom(room, ownerId, agentId)).map(room => ({
          roomId: room.id,
          read: 'readable',
          marker: room.conversationOwnerId === ownerId ? room.conversation : null
        }))
      : []
  )
}

/**
 * The agent's main conversation to open in place of `roomId`, when that room is one of the
 * agent's chats but no longer its main: 0.20's move to a plain room, or a change made on another
 * device. The agent answers only in its main, so a message left in the old chat never goes out.
 * Undefined for the main itself, for any other room, and before the agent's chats are marked.
 */
export function conversationMainInstead(
  rooms: readonly ConversationRoomProjection[],
  ownerId: string | undefined,
  agentId: string | undefined,
  roomId: string | null | undefined
): string | undefined {
  if (!roomId) {
    return undefined
  }

  const { main, earlier, stray } = resolveProjectedConversation(rooms, ownerId, agentId)

  return main && main !== roomId && (earlier.includes(roomId) || stray.includes(roomId)) ? main : undefined
}
