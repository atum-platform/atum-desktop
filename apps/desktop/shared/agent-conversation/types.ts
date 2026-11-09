export type ConversationRole = 'main' | 'earlier'

export interface ConversationMarker {
  role: ConversationRole
  main: string
  at: number
}

export interface ConversationState extends ConversationMarker {
  v: 1
}

export interface ConversationRoom {
  roomId: string
  read: 'readable' | 'unreachable' | 'transient'
  marker?: ConversationMarker | null
}

export interface ConversationResolution {
  main?: string
  earlier: string[]
  stray: string[]
  unreachable: string[]
  source: 'marked' | 'legacy'
}

export interface MigrationCandidate {
  roomId: string
  ownerAt?: number
  activityAt?: number
  createdAt?: number
}

export interface MigrationInput {
  rooms: string[]
  chosen: string
  ownerConfirmed: boolean
  noLiveTurn: boolean
  cloudMayAnswer: boolean
  cloudReady: boolean
  fleetReady: boolean
  writable: string[]
}

export interface ConversationWrite {
  roomId: string
  content: ConversationState | Record<string, never>
}

export type MigrationBlock =
  | 'owner_confirmation'
  | 'turn_live'
  | 'cloud_not_ready'
  | 'fleet_not_ready'
  | 'chosen_not_writable'
