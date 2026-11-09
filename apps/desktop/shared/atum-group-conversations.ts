/** Human-room client contract. Server membership is authoritative. */
export const GROUP_CONVERSATIONS_CONTRACT = 'atum.group-conversations/1' as const
export const GROUP_CONVERSATIONS_HEADER = 'x-atum-group-conversations' as const
export const GROUP_ADDRESSING_CONTRACT = 'atum.group-addressing/1' as const
export const GROUP_ADDRESSING_HEADER = 'x-atum-group-addressing' as const
export const PRIVATE_ADVISORY_CONTRACT = 'atum.private-advisory/1' as const
export const PRIVATE_ADVISORY_HEADER = 'x-atum-private-advisory' as const
export const GROUP_SHARED_AGENTS_CONTRACT = 'atum.group-shared-agents/1' as const
export const GROUP_SHARED_AGENTS_HEADER = 'x-atum-group-shared-agents' as const

export interface AdvisorTarget {
  type: 'specialist' | 'assistant'
  id: string
}

export interface AdvisoryAdvisor {
  target: AdvisorTarget
  displayName: string
  avatar: string
  availability: string
}

export interface AdvisoryRound {
  id: string
  status: 'running' | 'completed' | 'stopped' | 'failed'
  slots: { slot: number; target: AdvisorTarget; status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' }[]
}

export interface PrivateAdvisoryCapabilities {
  enabled: boolean
  advisorLimit: number
  advisorCatalog: AdvisoryAdvisor[]
}

export type GroupAssistantAvailability =
  | 'available'
  | 'assistant_not_owned'
  | 'assistant_offline'
  | 'assistant_not_approved'
  | 'assistant_requires_update'

/** A server-approved identity which may be present in a shared room. */
export interface GroupAssistant {
  assistantId: string
  displayName: string
  avatarUrl?: string
  avatar?: string
  ownerUserId: string
  ownerDisplayName?: string
  membershipEpoch: number
  availability: GroupAssistantAvailability
}

export interface GroupSharedAgentsCapabilities {
  enabled: boolean
  assistantMemberLimit: number
  ownAssistantOnly: true
  assistantCatalog: GroupAssistant[]
}

export interface GroupAddressingCapabilities {
  enabled: boolean
  mentionCardinality: number
  quoteLimit: number
  specialistMemberLimit: number
  specialistCatalog?: GroupSpecialistOption[]
}

export type GroupSpecialistAvailability = 'available' | 'specialist_not_linked' | 'specialist_room_unsupported'

/** Private-room discovery uses the existing owner-context availability vocabulary. */
export type GroupMentionAvailability =
  | GroupSpecialistAvailability
  | GroupAssistantAvailability
  | 'not_linked'
  | 'unsupported'
  | 'not_registered'
  | 'unavailable'

export interface GroupSpecialist {
  specialist: string
  displayName: string
  avatar: string
  membershipEpoch: number
  availability: GroupSpecialistAvailability
}

export interface GroupSpecialistOption {
  specialist: string
  displayName: string
  avatar: string
  roomSupported: boolean
}

export interface GroupQuotedMessage {
  messageId: string
  sourceVersion: number
}

export interface GroupCapabilities {
  available: boolean
  creationEnabled: boolean
  createDefaults?: boolean
  humanMemberLimit: number
  addressing?: GroupAddressingCapabilities
  advisory?: PrivateAdvisoryCapabilities
  sharedAgents?: GroupSharedAgentsCapabilities
}

export interface GroupMember {
  userId: string
  displayName: string
  handle: string
  role: 'owner' | 'member'
  membershipEpoch: number
}

export interface GroupRoom {
  conversationId: string
  title: string
  revision: number
  retiredAt: string | null
  membershipEpoch: number
  members: GroupMember[]
  specialists?: GroupSpecialist[]
  assistants?: GroupAssistant[]
  contextMode?: 'ordinary' | 'private_advisory' | 'shared_group'
  audienceRevision?: number
  advisors?: AdvisoryAdvisor[]
  latestRound?: AdvisoryRound | null
  updatedAt: string
}

export type GroupEventKind =
  | 'created'
  | 'member_added'
  | 'member_removed'
  | 'member_left'
  | 'owner_transferred'
  | 'renamed'
  | 'retired'
  | 'account_deleted'

export interface GroupMembershipEvent {
  id: string
  conversationId: string
  actorUserId: string | null
  subjectUserId: string | null
  specialist?: string | null
  kind: GroupEventKind
  createdAt: string
  identitySnapshot: { displayName?: string; handle?: string }
}

export interface GroupDetail {
  room: GroupRoom
  events: GroupMembershipEvent[]
  nextCursor: string | null
  hasMore: boolean
  specialistCatalog?: GroupSpecialistOption[]
}

export type GroupReportReason = 'harassment' | 'spam' | 'unsafe' | 'other'

interface GroupOperationIdentity {
  clientOperationId: string
}
interface GroupRoomOperationIdentity extends GroupOperationIdentity {
  conversationId: string
}

export type GroupOperationInput =
  | (GroupOperationIdentity & { action: 'create'; title: string; memberUserIds: string[]; reuseExisting?: true } & (
        | { contextMode?: 'ordinary'; specialistIds?: string[] }
        | { contextMode: 'private_advisory'; advisors: AdvisorTarget[] }
        | { contextMode: 'shared_group'; specialistIds?: string[]; assistantIds?: string[] }
      ))
  | (GroupRoomOperationIdentity & {
      action: 'stop_advisory' | 'continue_advisory'
      roundId: string
      audienceRevision: number
    })
  | (GroupRoomOperationIdentity & {
      action: 'add_advisor' | 'remove_advisor'
      target: AdvisorTarget
      audienceRevision: number
    })
  | (GroupRoomOperationIdentity & { action: 'add_member' | 'remove_member' | 'transfer_owner'; targetUserId: string })
  | (GroupRoomOperationIdentity & { action: 'add_specialist' | 'remove_specialist'; specialist: string })
  | (GroupRoomOperationIdentity & { action: 'add_assistant' | 'remove_assistant'; assistantId: string })
  | (GroupRoomOperationIdentity & { action: 'leave' | 'retire' })
  | (GroupRoomOperationIdentity & { action: 'rename'; title: string })
  | (GroupRoomOperationIdentity & { action: 'report'; reason: GroupReportReason; note?: string } & (
        | { memberUserId: string; messageId?: never; memberSpecialist?: never }
        | { messageId: string; memberUserId?: never; memberSpecialist?: never }
        | { memberSpecialist: string; memberUserId?: never; messageId?: never }
        | { memberAssistant: string; memberUserId?: never; messageId?: never; memberSpecialist?: never }
      ))

export interface GroupOperationResult {
  operationId: string
  state: 'queued' | 'sending' | 'sent' | 'failed_retryable' | 'failed_terminal' | 'conflicted'
  conversationId: string | null
  errorCode: string | null
}

/** Added to the existing typed messaging bridge; no general IPC escape hatch. */
export interface GroupMessagingClient {
  groupCapabilities(): Promise<GroupCapabilities>
  groupDetail(conversationId: string, cursor?: string | null): Promise<GroupDetail>
  groupOperate(input: GroupOperationInput): Promise<GroupOperationResult>
  groupOperations(): Promise<GroupOperationResult[]>
}
