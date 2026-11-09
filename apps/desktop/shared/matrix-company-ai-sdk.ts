/**
 * Controller-only Company AI SDK commands.
 *
 * These are trusted main → SDK commands (never renderer vocabulary). They exist
 * so the controller's headless CoS session can read exactly one company event or
 * question, watch its company rooms for addressed messages, and publish one
 * answer or reminder under the platform's deterministic transaction ID.
 *
 * Every command re-derives company/channel authority from immutable room state;
 * nothing from an event body becomes an actor, room, payer or scope.
 */

export interface MatrixCompanyAIWatchRequest {
  companyId: string
  agentUserId: string
  /** Durable room pagination positions acknowledged by controller intake. */
  checkpoint: MatrixCompanyAIWatchCheckpoint
  /** First attachment catches up only this bounded historical window. */
  catchupAfterMs: number
}

export interface MatrixCompanyAIWatchPosition {
  roomId: string
  token: string
  /** Last SDK-visible room/thread event when this position was examined. */
  liveEventId?: string | null
  /** True while forward pagination has not yet proven the server tail reached. */
  draining?: boolean
}

export interface MatrixCompanyAIWatchCheckpoint {
  positions: MatrixCompanyAIWatchPosition[]
  /** Lexicographic room id after the last room batch; absent/null starts at the first room. */
  nextRoomId?: string | null
}

/** Platform-authorized destination for accepting one Company CoS invitation. */
export interface MatrixCompanyAIJoinRequest {
  companyId: string
  channelId: string
  roomId: string
}

/**
 * Closed outcome of one join attempt. `join_pending`: the homeserver accepted the join but this
 * client's sync has not delivered it yet; the next attempt confirms it as `already_joined`.
 */
export type MatrixCompanyAIJoinResult = 'joined' | 'join_pending' | 'already_joined' | 'not_invited'

export const MATRIX_COMPANY_AI_JOIN_RESULTS: readonly MatrixCompanyAIJoinResult[] =
  ['joined', 'join_pending', 'already_joined', 'not_invited']

export type MatrixCompanyPrivateCosJoinResult = MatrixCompanyAIJoinResult | 'quarantined' | 'manager_pending'
export const MATRIX_COMPANY_PRIVATE_COS_JOIN_RESULTS: readonly MatrixCompanyPrivateCosJoinResult[] =
  [...MATRIX_COMPANY_AI_JOIN_RESULTS, 'quarantined', 'manager_pending']

export interface MatrixCompanyAIWatchHint {
  roomId: string
  eventId: string
  atMs: number
}

/** Aggregate counters only: no room/event/user ids, tokens, or message content. */
export const COMPANY_AI_WATCH_COUNTERS = [
  'rooms', 'joined', 'unbound', 'otherCompany', 'bound', 'seeded', 'seedPages', 'pages', 'unchanged',
  'scanned', 'invalid', 'self', 'nonText', 'notMentioned', 'relation', 'matched', 'checkpointMoved'
] as const
export type MatrixCompanyAIWatchDiagnostics = Record<typeof COMPANY_AI_WATCH_COUNTERS[number], number>

export interface MatrixCompanyAIWatchValue {
  schemaVersion: 2
  diagnostics?: MatrixCompanyAIWatchDiagnostics
  hints: MatrixCompanyAIWatchHint[]
  /** Candidate position; the controller persists it only after every hint is terminal. */
  checkpoint: MatrixCompanyAIWatchCheckpoint
}

export interface MatrixCompanyAIReadEventRequest {
  companyId: string
  roomId: string
  eventId: string
}

export interface MatrixCompanyAIQuestionRequest {
  companyId: string
  channelId: string
  threadRootEventId: string
  triggerEventId: string
}

export interface MatrixCompanyAIPublishRequest {
  companyId: string
  roomId: string
  threadRootEventId: string
  triggerEventId: string
  /** The platform's deterministic Matrix transaction ID; a retry reuses it. */
  transactionId: string
  text: string
}

/**
 * Recovery read-back for one committed answer: the publication cannot predate
 * `sinceMs`, so a bounded newest-first thread scan that reaches that instant
 * proves the event absent. Matrix dedupes a transaction ID only per access
 * token, and the controller rotates the CoS token on every attach; the event
 * itself is the durable identity, not the retry.
 */
export interface MatrixCompanyAIFindPublishedRequest extends MatrixCompanyAIPublishRequest {
  sinceMs: number
}

export interface MatrixCompanyAIThreadMessageRequest {
  companyId: string
  channelId: string
  threadRootEventId: string
  transactionId: string
  text: string
  mentions: string[]
}

export interface MatrixCompanyAIOnboardingWelcomeRequest {
  companyId: string
  roomId: string
  transactionId: string
  body: string
  /** Identifier-only first-party link rendered as Matrix's optional formatted body. */
  boardLink: string
}

/** Controller-bound private-CoS scope. The room id is never discovered from Matrix. */
export interface MatrixCompanyPrivateCosScope {
  roomId: string
  companyId: string
  memberPrincipal: string
  membershipIncarnation: string
  executorId: string
  attemptId:string
  memberUserId: string
  agentUserId: string
  managerUserId:string
  roomName: 'Chief of Staff'
  historyVisibility: 'joined'
  joinRule: 'invite'
  guestAccess: 'forbidden'
  powerLevels: {
    users: Record<string, 0 | 100>
    users_default: 0
    events_default: 0
    state_default: 100
    invite: 100
    kick: 100
    ban: 100
    redact: 100
    events: Record<string, 100>
  }
}

export interface MatrixCompanyPrivateCosWatchRequest extends MatrixCompanyPrivateCosScope {
  checkpoint: MatrixCompanyAIWatchCheckpoint
  catchupAfterMs: number
}

export interface MatrixCompanyPrivateCosVerifiedEvent {
  roomId: string
  eventId: string
  senderUserId: string
  mentionedAgentUserId: string
  original: true
  eventType: 'm.room.message'
  messageType: 'm.text'
  atMs: number
}

export interface MatrixCompanyPrivateCosQuestionRequest extends MatrixCompanyPrivateCosScope {
  eventId: string
}

export interface MatrixCompanyPrivateCosPublishRequest extends MatrixCompanyPrivateCosScope {
  eventId: string
  transactionId: string
  text: string
}

export interface MatrixCompanyPrivateCosGreetingRequest extends MatrixCompanyPrivateCosScope {
  transactionId: string
  locale: 'en' | 'vi'
  text: string
  mention: { userId: string }
  agentPill:{userId:string;displayName:'Chief of Staff';label:'@Chief of Staff';href:string}
  link: { kind: 'company_board_card'; companyId: string; boardId: string; cardId: string; title: string;url:string }|
    {kind:'company_board';companyId:string;boardId:string;title:string;url:string}
}

export interface MatrixCompanyAIPublishValue {
  eventId: string
}

export type MatrixCompanyAISdkCommand =
  | ({ kind: 'companyAIJoin' } & MatrixCompanyAIJoinRequest)
  | ({ kind: 'companyAIWatch' } & MatrixCompanyAIWatchRequest)
  | ({ kind: 'companyAIReadEvent' } & MatrixCompanyAIReadEventRequest)
  | { kind: 'companyAIJoinedMembers'; companyId: string; channelId: string }
  | ({ kind: 'companyAIQuestion' } & MatrixCompanyAIQuestionRequest)
  | ({ kind: 'companyAIPublish' } & MatrixCompanyAIPublishRequest)
  | ({ kind: 'companyAIFindPublished' } & MatrixCompanyAIFindPublishedRequest)
  | ({ kind: 'companyAIThreadMessage' } & MatrixCompanyAIThreadMessageRequest)
  | ({ kind: 'companyAIOnboardingWelcome' } & MatrixCompanyAIOnboardingWelcomeRequest)
  | ({ kind: 'companyPrivateCosJoin' } & MatrixCompanyPrivateCosScope)
  | ({ kind: 'companyPrivateCosWatch' } & MatrixCompanyPrivateCosWatchRequest)
  | ({ kind: 'companyPrivateCosQuestion' } & MatrixCompanyPrivateCosQuestionRequest)
  | ({ kind: 'companyPrivateCosPublish' } & MatrixCompanyPrivateCosPublishRequest)
  | ({ kind: 'companyPrivateCosGreeting' } & MatrixCompanyPrivateCosGreetingRequest)
  | ({ kind: 'companyPrivateCosLeave' } & MatrixCompanyPrivateCosScope)
