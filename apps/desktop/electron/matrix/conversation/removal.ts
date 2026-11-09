import { resolveConversationRoom } from '../../../shared/agent-conversation'
import type { ConversationCandidateRead } from '../../../shared/agent-conversation/view'

/** Preserve legacy removal until migration; protect marked mains and unswept strays. */
export function conversationRemovalAllowed(rooms: readonly ConversationCandidateRead[], roomId: string): boolean {
  if (rooms.some(room => room.read === 'transient')) {
    return false
  }
  const selected = rooms.find(room => room.roomId === roomId)
  if (!selected || selected.read !== 'readable') {
    return false
  }
  if (selected.marker?.role === 'earlier') {
    return true
  }
  return !resolveConversationRoom(rooms).main
}
