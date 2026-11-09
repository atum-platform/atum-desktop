export type ParticipationMode = 'off' | 'addressed' | 'joins'
export type RoomMode = 'meeting' | 'shared'
export type TriggerKind = 'named' | 'everyone' | 'none'
export type EventKind = 'text' | 'notice' | 'edit' | 'reaction' | 'redaction' | 'thread' | 'file'

export interface AgentPolicy {
  mode: ParticipationMode
  [key: string]: unknown
}

export interface RoomPolicy {
  v: 1
  agents: Record<string, AgentPolicy>
  dailyTurns?: number
  /** Owner has seen the current ambient-routing disclosure. */
  routingDisclosure?: 1
  [key: string]: unknown
}

export interface RoomUsage {
  v: 1
  day: string
  turns: number
  pausedNoticed?: boolean
  [key: string]: unknown
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; code: 'invalid_policy' | 'invalid_usage' }

export interface EffectiveModeFacts {
  roomMode: RoomMode
  stored?: ParticipationMode
  meetingDefault?: 'addressed' | 'joins'
}

/** All identity, membership and verification facts come from the authority reader. */
export interface GroupTriggerFacts {
  ownerUserId: string
  agentUserId: string
  senderUserId: string
  senderVerified: boolean
  roomMode: RoomMode
  mode: ParticipationMode
  ownAgentIds: readonly string[]
  mentions: readonly string[]
  eventKind: EventKind
  replySenderId?: string
}

export interface FloorFacts {
  eventId: string
  kind: TriggerKind
  /** Includes off/addressed assistants so explicit addressing never redirects a reply. */
  ownAgentIds: readonly string[]
  /** Joined and policy-eligible assistants, from the current authority read. */
  candidates: readonly string[]
  mentions: readonly string[]
  replySenderId?: string
}

export interface FloorPlan {
  order: string[]
}

export interface FreshnessFacts {
  timestamp: number
  now: number
  floor?: { acceptedAt: number; position: number }
}

export interface BudgetFacts {
  now: number
  dailyTurns: number
  usage: RoomUsage
}

export interface BudgetDecision {
  day: string
  turns: number
  cap: number
  remaining: number
  allowed: boolean
  notice: boolean
}

export interface ChainStamp {
  origin: string
  depth: number
  parent: string
}

export interface ChainEvent {
  roomId: string
  eventId: string
  senderUserId: string
  senderVerified: boolean
  at: number
  eventKind: EventKind
  mentions: readonly string[]
  /** Untrusted event content; the verifier walks it instead of trusting it. */
  chain?: ChainStamp
}

export interface ChainFacts {
  roomId: string
  ownerUserId: string
  agentUserId: string
  ownAgentIds: readonly string[]
  roomMode: RoomMode
  now: number
  eventId: string
  /** Authoritative origin-ledger summary; never supplied by message content. */
  spokenAgentIds: readonly string[]
  originTurns: number
  budgetAllowed: boolean
}

export type ChainRefusal =
  | 'shared_room'
  | 'untrusted_sender'
  | 'foreign_sender'
  | 'missing_event'
  | 'invalid_chain'
  | 'stale_origin'
  | 'repeat_agent'
  | 'origin_cap'
  | 'room_cap'
  | 'not_addressed'
export type ChainDecision = { allowed: true; origin: string; depth: number } | { allowed: false; code: ChainRefusal }

export interface ContextLimits {
  messages: number
  chars: number
  pages: number
  deadlineMs: number
}

export interface RoomContextInput {
  roomId: string
  viewerAgentId: string
  excludeEventId: string
  window: 'meeting' | 'shared_addressed' | 'shared_ambient'
  limits: ContextLimits
  /** Routing needs context before the current event, including an earlier reply by this agent. */
  purpose?: 'routing'
}

export type ContextTrust = 'owner' | 'own_assistant' | 'self'
export interface ContextLine {
  eventId: string
  senderRef: string
  displayName: string
  trust: ContextTrust
  text: string
  at: number
}

export interface ContextEvent extends Omit<ContextLine, 'trust'> {
  /** Derived from membership/verified sender by the SDK adapter, never event content. */
  trust?: ContextTrust | 'foreign'
  verified: boolean
  decrypted: boolean
  msgtype: 'm.text' | 'm.notice' | 'm.file'
}

export interface RecentContext {
  status: 'ok'
  lines: ContextLine[]
  gaps: number
  omitted: number
}

export type RoomContextResult =
  | RecentContext
  | { status: 'refused'; code: 'matrix_group_room_required' }
  | { status: 'error'; code: 'matrix_room_unreadable' | 'matrix_context_timeout' }

export interface RoomMember {
  userId: string
  displayName: string
  membership: 'join' | 'invite' | 'leave' | 'ban'
}

export interface SessionProfileFlags {
  shared_room: boolean
  reply_only: boolean
  pet_surface: boolean
}

export interface SessionProfile {
  key: string
  tools: 'standard' | 'shared_ceiling' | 'none'
  memory: boolean
  petTool: boolean
}
