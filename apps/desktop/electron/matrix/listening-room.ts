import { EarlierConversationError } from '../../shared/agent-conversation'
import { isAssistantRoom } from '../../shared/matrix-assistant-room'
import { conversationMainInstead, type ConversationRoomProjection } from '../../src/matrix/conversation-marker'

/**
 * Where an agent's automatic listening belongs now, when not where it is: the agent's main
 * conversation, once `roomId` is one of its earlier ones. The main moves in many ways (this Mac's
 * move, another Mac's, the reconcile restoring a main after two moves crossed, a cloud move put
 * back), and a turn is admitted only in the main, so listening in an earlier room answers nothing.
 *
 * In order:
 * - `named`: the main a turn's server read just named (EarlierConversationError), when that room
 *   is already the agent's private room here (keep listening's own check would otherwise drop the
 *   preference). The server is fresher than any local view.
 * - `pending`: the main this Mac's own move just finished (main.ts `conversationHomes`), while its
 *   synced view of the markers has not caught up. That stale view still names the old main and
 *   shows the new room as a stray, so following it would flip listening back (assistantHomeRoom
 *   honours the same override for the same lag).
 * - this Mac's synced view of the markers.
 *
 * Undefined when listening is already in the main, or no main is known.
 */
export function matrixListeningFollow(input: {
  rooms: readonly ConversationRoomProjection[]
  ownerId: string | undefined
  agentId: string | undefined
  roomId: string
  named?: string
  pending?: string
}): string | undefined {
  const { rooms, ownerId, agentId, roomId, named, pending } = input

  if (named) {
    const room = named !== roomId ? rooms.find(each => each.id === named) : undefined

    return room && isAssistantRoom(room, ownerId, agentId) ? room.id : undefined
  }

  if (pending) {
    return pending !== roomId ? pending : undefined
  }

  return conversationMainInstead(rooms, ownerId, agentId, roomId)
}

/**
 * An arm failure every Mac would meet the same, so handing the agent to another Mac cannot help:
 * the room is an earlier conversation and the rooms name no main at all (two Macs' moves crossed,
 * until the reconcile restores one). Retried, but not counted toward the lease handover.
 *
 * A refusal that names a main is not one: listening follows that main (generation bump, so the
 * failure is never weighed), and when this Mac cannot follow it (the room has not synced here,
 * no binding) the fault is this Mac's, and it counts as before.
 */
export function matrixListeningRefusedEverywhere(error: unknown): boolean {
  return error instanceof EarlierConversationError && !error.main
}

/** An arm failure's code for the log: one of Atum's closed codes, never an error's own text. */
export function matrixListeningArmCode(error: unknown): string {
  return error instanceof Error && /^matrix_[a-z0-9_]+$/.test(error.message) ? error.message : 'unexpected'
}
