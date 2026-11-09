/** Visible dialogue only. Not a memory, tool, authority or session-sync protocol. */
export const MATRIX_CONTINUITY = {
  pages: 4,
  pageSize: 50,
  messages: 40,
  chars: 32_000,
  deadlineMs: 8_000,
  /** A bounded read stops paging this long before its deadline: the time left re-checks the room. */
  settleMs: 2_500,
  ours: 16
} as const

export interface MatrixContinuityEntry {
  eventId: string
  role: 'user' | 'assistant'
  text: string
  /** Authenticated answer correlation, never permission to execute. */
  invocationId?: string
}

export interface MatrixContinuityRead {
  roomId: string
  ownerId: string
  agentId: string
  /** Newest first, in server pagination order. */
  entries: MatrixContinuityEntry[]
  /** Reached the requested anchor, or room beginning when there is no anchor. */
  reachedStop: boolean
  gaps: number
  /** An unreadable agent answer could hide work done on another host. */
  uncertainAgent: boolean
  /** A bounded read ran out of time and stopped paging: its entries are the newest dialogue only. */
  clipped?: true
}

export interface MatrixContinuityTarget {
  roomId: string
  ownerId: string
  agentId: string
  before?: string
  excludeTurn?: string
  stopAt?: string
  /**
   * The read only seeds a new session: once its first page is in, it stops paging when the
   * deadline nears and keeps the newest dialogue it read (`clipped`), under the same checks,
   * rather than failing the turn. Never used to decide whether a stored session may resume.
   */
  bounded?: boolean
}

export interface MatrixConversationWitness {
  anchor?: string
  ours: string[]
}

export type MatrixHistorySeed = Array<{ role: 'user' | 'assistant'; content: string }>
