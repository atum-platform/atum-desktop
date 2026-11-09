import type { ConversationRoom, MigrationCandidate } from './types'

export interface ConversationCandidateRead extends ConversationRoom, MigrationCandidate {
  writable: boolean
  /** The room has end-to-end encryption (`m.room.encryption` state): a room made before 0.20.
   * The one fact the plain replacement decides on. Absent when the room's state was not read. */
  encrypted?: boolean
}

/** Native-owned migration facts. This projection grants no write authority. */
export interface MatrixConversationView {
  state: 'legacy' | 'marked' | 'blocked' | 'working' | 'retry'
  main?: string
  proposed?: string
  /** Only a definitively unreadable, previously owner-checked main is replaceable. */
  replaceable?: boolean
  candidates: string[]
  earlier: string[]
  skipped: string[]
  jobs: number | null
  reason?:
    | 'cloud_not_ready'
    | 'fleet_not_ready'
    | 'turn_live'
    | 'chosen_not_writable'
    | 'read_unavailable'
    | 'rollback_pending'
    | 'effects_pending'
    | 'failed'
}
