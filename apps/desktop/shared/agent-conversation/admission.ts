import type { ConversationResolution } from './types'

export interface EarlierConversationRefusal {
  admit: false
  code: 'matrix_earlier_conversation'
  main?: string
}

/** This augments admission after existing room, membership and device checks.
 * Display/history readers and groups retain their original admission behavior. */
export function decideConversationTurn(input: {
  roomId: string
  privateAssistant: boolean
  forTurn: boolean
  resolution: ConversationResolution
}): { admit: true } | EarlierConversationRefusal {
  const { resolution, roomId } = input

  if (
    input.privateAssistant &&
    input.forTurn &&
    (resolution.earlier.includes(roomId) || resolution.stray.includes(roomId))
  ) {
    return {
      admit: false,
      code: 'matrix_earlier_conversation',
      ...(resolution.main ? { main: resolution.main } : {})
    }
  }

  return { admit: true }
}

export class EarlierConversationError extends Error {
  readonly code = 'matrix_earlier_conversation'

  constructor(
    readonly roomId: string,
    readonly main?: string
  ) {
    super('matrix_earlier_conversation')
  }
}

/** Calendar day is UTC for a consistent per-room key on every answering host.
 * Caller persists lastDay only after successful static notice publication. */
export function shouldPostEarlierNotice(input: { leaseHolder: boolean; day: string; lastDay?: string }): boolean {
  return input.leaseHolder && (!input.lastDay || input.day > input.lastDay)
}
