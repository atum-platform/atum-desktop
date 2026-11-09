import type {
  GroupMentionAvailability,
  GroupMessagingClient,
  GroupQuotedMessage,
  GroupRoom
} from '../../shared/atum-group-conversations'

import type { AtumAccountIdentity } from './atum-account-facts'

export interface AtumMessagingConversation {
  id: string
  title: string | null
  kind: string
  group?: GroupRoom
  participantIds: string[]
  updatedAt: string
  lastMessageAt: string | null
  unreadCount: number
  payload: Record<string, unknown>
}

export interface AtumMessagingMessage {
  localId: string
  id: string | null
  clientMessageId: string | null
  conversationId: string
  sender: { type: string; id: string }
  content: string
  kind: string
  attachments: unknown[]
  /** Content-free server projection (specialist dispatch, memory outcome).
   *  `null` whenever the plane does not send it — every reader tolerates that. */
  metadata: Record<string, unknown> | null
  replyToMessageId: string | null
  forwardedFrom: unknown | null
  reactions: unknown[]
  version: number
  createdAt: string
  editedAt: string | null
  recalledAt: string | null
  delivery: string
  optimistic: boolean
}

export interface AtumMessagingDraft {
  text: string
  replyToMessageId: string | null
  attachmentIds: string[]
  revision: number
  updatedAt: string
}

export interface AtumMessagingSyncStatus {
  accountId: string | null
  connectivity: 'loading' | 'online' | 'offline_cached' | 'reconnecting' | 'auth_expired' | 'error'
  synchronized: boolean
  cursor: string | null
  lastSuccessfulSyncAt: string | null
  nextRetryAt: string | null
  errorCode: string | null
}

export interface AtumMessagingTransportStatus {
  accountId: string | null
  healthy: boolean
  state: 'disabled' | 'connecting' | 'healthy' | 'degraded'
}

export interface AtumSocialProfile {
  profileId: string
  displayName: string
  handle: string
  verified: boolean
  avatar: string | null
}

export type AtumSocialProjection =
  | {
      availability: 'available'
      profile: AtumSocialProfile
      state: 'none' | 'outgoing_pending' | 'incoming_pending' | 'connected' | 'blocked_by_me'
      version: number
      canMessage: boolean
      directThreadId: string | null
    }
  | {
      availability: 'unavailable'
      profile: null
      state: 'unavailable'
      version: 0
      canMessage: false
      directThreadId: null
    }

export interface AtumMessageHistoryPage {
  messages: AtumMessagingMessage[]
  nextCursor: string | null
  hasMore: boolean
}
export interface AtumMessageSearchResult {
  message: AtumMessagingMessage
  conversationTitle: string | null
}

export type AtumArtifactResolution =
  | {
      state: 'ready'
      artifact: {
        artifactId: string
        type: string
        title: string
        url: string
        status: 'generating' | 'ready'
        embed?: { url: string; kind: 'interactive_view' | 'document' | 'image' | 'file'; expiresAt: string }
      }
    }
  | { state: 'missing' | 'denied' | 'offline' | 'unsupported' | 'error'; artifact: null }

export interface AtumMessagingClient extends GroupMessagingClient {
  status(): Promise<AtumMessagingSyncStatus>
  roster(limit?: number): Promise<AtumMessagingConversation[]>
  messages(conversationId: string, limit?: number): Promise<AtumMessagingMessage[]>
  loadOlderMessages(conversationId: string, limit?: number): Promise<AtumMessageHistoryPage>
  transportStatus(): Promise<AtumMessagingTransportStatus>
  mentionTargets?(conversationId: string): Promise<AtumMentionTargetsResponse>
  artifact(conversationId: string, resourceId: string): Promise<AtumArtifactResolution>
  ensureSpecialistConversation(specialist: string): Promise<{ conversationId: string }>
  ensureContactConversation(userId: string): Promise<{ conversationId: string }>
  handleAvailability(
    handle: string
  ): Promise<{ available: boolean; reason: string | null; retryAfterSeconds: number | null }>
  /** Both resolve to the whole refreshed identity; main adopts it into the session first. */
  renameHandle(handle: string): Promise<AtumAccountIdentity>
  updateProfile(input: { displayName: string }): Promise<AtumAccountIdentity>
  /** Reserve a server-chosen object; the renderer PUTs the bytes to `uploadUrl`, then completes. */
  createAvatarUpload(input: {
    contentType: string
  }): Promise<{ uploadId: string; uploadUrl: string; uploadHeaders: Record<string, string>; expiresAt: string }>
  completeAvatarUpload(uploadId: string): Promise<AtumAccountIdentity>
  clearAvatar(): Promise<AtumAccountIdentity>
  /**
   * `atum.assistant-registry/1`. Registration is keyed by the identity the
   * backend minted for the profile; the plane answers `registered`, `stale`
   * (a newer revision is stored) or `adopt` (the default assistant already has
   * an identity on the plane, which this machine must take).
   */
  registerAssistant(input: {
    identityId: string
    displayName: string
    avatar: string
    isDefault: boolean
    lifecycleRevision: number
  }): Promise<{
    outcome: 'registered' | 'stale' | 'adopt'
    assistant: {
      id: string
      identityId: string | null
      displayName: string
      avatarUrl?: string | null
      avatar: string
      isDefault: boolean
      lifecycleRevision: number
      identityRevision: number
      definitionRevision: number
      status: 'active' | 'retired'
    }
  }>
  retireAssistant(input: {
    identityId: string
    lifecycleRevision: number
    expectedIdentityRevision?: number
  }): Promise<{ outcome: string; lifecycleRevision: number }>
  listAssistants(): Promise<
    Array<{
      id: string
      identityId: string | null
      displayName: string
      avatarUrl?: string | null
      avatar: string
      isDefault: boolean
      lifecycleRevision: number
      identityRevision: number
      definitionRevision: number
      status: 'active' | 'retired'
    }>
  >
  getAssistantDefinition?(assistantId: string): Promise<{
    assistant: {
      id: string
      identityId: string
      displayName: string
      avatar: string
      avatarUrl: string | null
      isDefault: boolean
      lifecycleRevision: number
      status: 'active' | 'retired'
      identityRevision: number
      definitionRevision: number
    }
    definition: unknown
    definitionRevision: number
    identityRevision: number
  }>
  putAssistantDefinition?(
    assistantId: string,
    input: {
      expectedDefinitionRevision: number
      expectedIdentityRevision: number
      displayName: string
      avatar: string
      definition: unknown
    }
  ): Promise<{
    assistant: {
      id: string
      identityId: string
      displayName: string
      avatar: string
      avatarUrl: string | null
      isDefault: boolean
      lifecycleRevision: number
      status: 'active' | 'retired'
      identityRevision: number
      definitionRevision: number
    }
    definition: unknown
    definitionRevision: number
    identityRevision: number
  }>
  materializeAssistant?(assistantId: string): Promise<
    | {
        ok: true
        status: 'materialized' | 'reused' | 'applied'
        profile: {
          name: string
          identityId: string
          displayName: string
          avatar: string
          managedBy: 'atum'
          definitionRevision?: number
          identityRevision?: number
        }
      }
    | { ok: false; status: 'missing_skills'; missingSkills: Array<{ name: string; sha256: string }> }
  >
  /** Explicit cloud-to-existing-profile apply; main owns the snapshot and ticket. */
  applyAssistantDefinition?(assistantId: string): Promise<
    | {
        ok: true
        status: 'materialized' | 'reused' | 'applied'
        profile: {
          name: string
          identityId: string
          displayName: string
          avatar: string
          managedBy: 'atum'
          definitionRevision?: number
          identityRevision?: number
        }
      }
    | { ok: false; status: 'missing_skills'; missingSkills: Array<{ name: string; sha256: string }> }
  >
  /** Explicit upgrade bridge for a matching managed profile on this computer. */
  importLegacyAssistant?(assistantId: string): Promise<
    | {
        ok: true
        status: 'imported'
        profile: {
          name: string
          identityId: string
          displayName: string
          avatar: string
          managedBy: 'atum'
          definitionRevision?: number
          identityRevision?: number
        }
      }
    | { ok: false; status: 'legacy_source_absent' | 'definition_exists' }
    | { ok: false; status: 'missing_skills'; missingSkills: Array<{ name: string; sha256: string }> }
  >
  createAssistantAvatarUpload(
    assistantId: string,
    input: { contentType: string }
  ): Promise<{ uploadId: string; uploadUrl: string; uploadHeaders: Record<string, string>; expiresAt: string }>
  completeAssistantAvatarUpload(
    assistantId: string,
    uploadId: string
  ): Promise<{
    id: string
    identityId: string | null
    displayName: string
    avatarUrl?: string | null
    avatar: string
    isDefault: boolean
    lifecycleRevision: number
    identityRevision: number
    definitionRevision: number
    status: 'active' | 'retired'
  }>
  clearAssistantAvatar(assistantId: string): Promise<{
    id: string
    identityId: string | null
    displayName: string
    avatarUrl?: string | null
    avatar: string
    isDefault: boolean
    lifecycleRevision: number
    identityRevision: number
    definitionRevision: number
    status: 'active' | 'retired'
  }>
  socialLookup(query: string): Promise<AtumSocialProjection>
  socialMutate(
    action: 'request' | 'accept' | 'decline' | 'block' | 'unblock',
    targetProfileId: string
  ): Promise<AtumSocialProjection>
  socialRelationships(): Promise<AtumSocialProjection[]>
  socialSync(): Promise<AtumSocialProjection[]>
  linkedApps(): Promise<
    Array<{
      app: string
      displayName: string
      state: 'never_linked' | 'linked' | 'unlinked'
      connectedAt: string | null
      lastActiveAt: string | null
    }>
  >
  disconnectApp(app: string): Promise<{ localCleanup: 'complete' | 'unconfirmed' } | void>
  draft(conversationId: string): Promise<AtumMessagingDraft | null>
  saveDraft(
    conversationId: string,
    draft: { text: string; replyToMessageId?: string | null; attachmentIds?: string[] }
  ): Promise<AtumMessagingDraft>
  send(input: {
    conversationId: string
    clientMessageId: string
    content: string
    locale: string
    replyToMessageId?: string | null
    attachmentIds?: string[]
    mention?: { agent: 'binh-minh'; revision: 0; startOffset: number; endOffset: number } | null
    mentions?: AtumAddressedMentions | null
    quotedMessage?: GroupQuotedMessage | null
  }): Promise<unknown>
  retry(clientMessageId: string): Promise<unknown>
  markRead(conversationId: string, throughMessageId: string): Promise<boolean>
  toggleReaction(messageId: string, emoji: string): Promise<void>
  editMessage(messageId: string, content: string): Promise<void>
  recallMessage(messageId: string): Promise<void>
  searchMessages(query: string, conversationId?: string): Promise<AtumMessageSearchResult[]>
  createMediaUpload(input: {
    fileName: string
    mimeType: string
    sizeBytes: number
  }): Promise<{ attachmentId: string; uploadUrl: string }>
  completeMediaUpload(attachmentId: string): Promise<void>
  downloadMedia(attachmentId: string): Promise<{ url: string }>
  sendTyping(conversationId: string, typing: boolean): Promise<boolean>
  /** Runs this account's pending assistant-mention jobs; safe to call when there are none. */
  drainMentionJobs(): Promise<{ claimed: number; completed: number }>
  sync(): Promise<AtumMessagingSyncStatus>
}

export const ATUM_ADDRESSED_MENTIONS_CONTRACT = 'atum.addressed-mentions/1' as const

export interface AtumMentionTarget {
  target: { type: 'assistant' | 'specialist'; id: string }
  revision: number
  startOffset: number
  endOffset: number
}

export interface AtumAddressedMentions {
  contract: typeof ATUM_ADDRESSED_MENTIONS_CONTRACT
  targets: AtumMentionTarget[]
}

export interface AtumMentionTargetCandidate {
  target: { type: 'assistant' | 'specialist'; id: string }
  revision: number
  displayName: string
  avatarUrl?: string | null
  avatar: string
  availability?: GroupMentionAvailability
}

export interface AtumMentionTargetsResponse {
  contract: typeof ATUM_ADDRESSED_MENTIONS_CONTRACT
  mentionCardinality: number
  targets: AtumMentionTargetCandidate[]
  legacy?: boolean
}

/** Typed renderer model seam for WS4; all authority remains in Electron main. */
export function atumMessagingClient(): AtumMessagingClient {
  if (!window.hermesDesktop?.messaging) {
    throw new Error('Atum messaging is unavailable in this desktop runtime')
  }

  return window.hermesDesktop.messaging
}
