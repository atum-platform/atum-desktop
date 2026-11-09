import { buildConversationMarker } from './marker'
import type { ConversationResolution, ConversationRoom, ConversationWrite } from './types'

export class ConversationUnavailableError extends Error {
  readonly code = 'matrix_conversation_unavailable'

  constructor() {
    super('matrix_conversation_unavailable')
  }
}

/** Rooms are already restricted to this agent's authorized private assistant rooms. */
export function resolveConversationRoom(
  rooms: readonly ConversationRoom[],
  previous?: ConversationResolution
): ConversationResolution {
  if (rooms.some(room => room.read === 'transient')) {
    if (!previous) {
      throw new ConversationUnavailableError()
    }

    return {
      ...previous,
      earlier: [...previous.earlier],
      stray: [...previous.stray],
      unreachable: [...previous.unreachable]
    }
  }

  const readable = rooms.filter(room => room.read === 'readable')
  const mains = readable.filter(room => room.marker?.role === 'main')
  mains.sort((a, b) => {
    const time = b.marker!.at - a.marker!.at

    return time || compareIds(a.roomId, b.roomId)
  })
  const main = mains[0]?.roomId

  return {
    ...(main ? { main } : {}),
    earlier: readable
      .filter(room => room.marker?.role === 'earlier' || (room.marker?.role === 'main' && room.roomId !== main))
      .map(room => room.roomId)
      .sort(compareIds),
    stray: main
      ? readable
          .filter(room => !room.marker)
          .map(room => room.roomId)
          .sort(compareIds)
      : [],
    unreachable: rooms
      .filter(room => room.read === 'unreachable')
      .map(room => room.roomId)
      .sort(compareIds),
    source: main ? 'marked' : 'legacy'
  }
}

/** Candidate list only. Adapter skips matching pointers and must not run during
 * a transient read. No owner-confirmed main write is ever produced by a sweep. */
export function conversationSweepCandidates(resolution: ConversationResolution, at: number): ConversationWrite[] {
  if (!resolution.main) {
    return []
  }

  return [...resolution.earlier, ...resolution.stray].sort(compareIds).map(roomId => ({
    roomId,
    content: buildConversationMarker({ roomId, role: 'earlier', main: resolution.main!, at })
  }))
}

export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
