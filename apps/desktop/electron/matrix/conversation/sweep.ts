import { conversationSweepCandidates } from '../../../shared/agent-conversation'
import type {
  ConversationMarker,
  ConversationResolution,
  ConversationWrite
} from '../../../shared/agent-conversation/types'

/** Sweep converges raced mains and old-client strays. It can never promote a room. */
export function conversationSweepWrites(input: {
  resolution: ConversationResolution
  markers: ReadonlyMap<string, ConversationMarker | null>
  transient: boolean
  at: number
}): ConversationWrite[] {
  const { resolution } = input
  if (input.transient || !resolution.main || resolution.source === 'legacy') {
    return []
  }
  return conversationSweepCandidates(resolution, input.at).filter(({ roomId }) => {
    const marker = input.markers.get(roomId)
    return marker?.role !== 'earlier' || marker.main !== resolution.main
  })
}
