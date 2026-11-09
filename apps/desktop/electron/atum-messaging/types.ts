import type { AdvisorySearchRequest, AdvisorySearchResult } from '../../shared/atum-advisory-search'
import type { AtumAssistantDefinitionSnapshot, AtumAssistantDefinitionWrite } from '../../shared/atum-agent-portability'
import type {
  GroupMentionAvailability,
  GroupMessagingClient,
  GroupQuotedMessage,
  GroupRoom
} from '../../shared/atum-group-conversations'
import type { AtumAgentHire, AtumExecutionTask, AtumHireResult } from '../../shared/atum-hiring'
import type { ProtonRewardClaim, ProtonRewardKind, ProtonRewards } from '../../shared/atum-proton-rewards'

import type { GroupStoreBoundary } from './group-store'
import type { ClaimedPrivateAdvisoryJob, PrivateAdvisoryContext } from './private-advisory-runner'
import type { SocialMutationAction, SocialProjection } from './social'

export type ConnectivityState = 'loading' | 'online' | 'offline_cached' | 'reconnecting' | 'auth_expired' | 'error'

export type MutationState = 'queued' | 'sending' | 'sent' | 'failed_retryable' | 'failed_terminal' | 'conflicted'

export interface MessagingConversation {
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

export interface CanonicalMessage {
  id: string
  conversationId: string
  sender: { type: string; id: string }
  content: string
  kind: string
  attachments: unknown[]
  /**
   * Server-projected, content-free message metadata (specialist dispatch state,
   * Andy's memory outcome, agent session pointer). `null` on the old plane and
   * on any message the server sends without the field — every consumer must
   * tolerate its absence. `parseMessageMetadata` in `wire.ts` is the only writer
   * and it allowlists both the top-level keys and their scalar members.
   */
  metadata: Record<string, unknown> | null
  replyToMessageId: string | null
  forwardedFrom: unknown | null
  reactions: unknown[]
  version: number
  createdAt: string
  editedAt: string | null
  recalledAt: string | null
  delivery: string
}

export interface StoredMessage extends Omit<CanonicalMessage, 'id'> {
  localId: string
  id: string | null
  clientMessageId: string | null
  optimistic: boolean
}

export interface ConversationDraft {
  text: string
  replyToMessageId: string | null
  attachmentIds: string[]
  revision: number
  updatedAt: string
}

export interface SaveDraftInput {
  text: string
  replyToMessageId?: string | null
  attachmentIds?: string[]
}

export interface QueueSendInput {
  conversationId: string
  clientMessageId: string
  content: string
  locale: string
  replyToMessageId?: string | null
  attachmentIds?: string[]
  mention?: { agent: 'binh-minh'; revision: 0; startOffset: number; endOffset: number } | null
  mentions?: AddressedMentions | null
  quotedMessage?: GroupQuotedMessage | null
  now?: string
}

export const ADDRESSED_MENTIONS_CONTRACT = 'atum.addressed-mentions/1' as const

export interface AddressedMentionTarget {
  target: { type: 'assistant' | 'specialist'; id: string }
  revision: number
  startOffset: number
  endOffset: number
}

export interface AddressedMentions {
  contract: typeof ADDRESSED_MENTIONS_CONTRACT
  targets: AddressedMentionTarget[]
}

export interface MentionTargetCandidate {
  target: { type: 'assistant' | 'specialist'; id: string }
  revision: number
  displayName: string
  /** Server-projected public photo URL. The legacy avatar symbol stays separate. */
  avatarUrl?: string | null
  avatar: string
  availability?: GroupMentionAvailability
}

export interface MentionTargetsResponse {
  contract: typeof ADDRESSED_MENTIONS_CONTRACT
  mentionCardinality: number
  targets: MentionTargetCandidate[]
  /** Electron-only compatibility projection for a server that lacks this route. */
  legacy?: boolean
}

export interface PendingMutation {
  id: string
  kind: 'send_message'
  conversationId: string
  clientMessageId: string
  request: {
    client_message_id: string
    content: string
    locale: string
    reply_to_message_id: string | null
    attachment_ids: string[]
    mention?: { agent: 'binh-minh'; revision: 0; start_offset: number; end_offset: number } | null
    mentions?: {
      contract: typeof ADDRESSED_MENTIONS_CONTRACT
      targets: Array<{
        target: { type: 'assistant' | 'specialist'; id: string }
        revision: number
        start_offset: number
        end_offset: number
      }>
    } | null
    quoted_message?: { message_id: string; source_version: number } | null
  }
  state: MutationState
  attemptCount: number
  nextAttemptAt: string | null
  lastErrorCode: string | null
  createdAt: string
  updatedAt: string
}

export interface PendingReadReceipt {
  id: string
  conversationId: string
  throughMessageId: string
  clientOperationId: string
  state: 'queued' | 'sending' | 'failed_retryable'
  attemptCount: number
  nextAttemptAt: string | null
}

export interface MutationFailure {
  code: string
  retryable: boolean
  retryAt?: string | null
  conflicted?: boolean
  now?: string
}

export interface CanonicalizeMessageInput {
  clientMessageId?: string | null
  message: CanonicalMessage
  incrementUnread?: boolean
  now?: string
}

export interface SyncCursor {
  cursor: string | null
  updatedAt: string | null
}

export interface SocialReplicaState {
  accountEpoch: string | null
  cursor: string | null
}

/** Compare the exact outcome; every string member of this result is truthy. */
export type CanonicalMessageDeleteResult = 'deleted' | 'missing' | 'conversation_mismatch'

/**
 * S5-owned, account-scoped direct-message replica boundary.
 *
 * The legacy `MessagingStoreBoundary` alias below remains for callers that
 * have not yet adopted the ownership name. App/specialist state must never be
 * added here: S6 composes beside this boundary rather than through it.
 */
export interface DirectMessagingStoreBoundary {
  readonly accountId: string
  close(): void
  upsertConversation(conversation: Omit<MessagingConversation, 'unreadCount'>): void
  listConversations(limit?: number): MessagingConversation[]
  listMessages(conversationId: string, limit?: number): StoredMessage[]
  saveDraft(conversationId: string, draft: SaveDraftInput, now?: string): ConversationDraft
  getDraft(conversationId: string): ConversationDraft | null
  queueSend(input: QueueSendInput): PendingMutation
  markMutationSending(clientMessageId: string, now?: string): PendingMutation
  markMutationFailed(clientMessageId: string, failure: MutationFailure): PendingMutation
  retryMutation(clientMessageId: string, now?: string): PendingMutation
  listDueMutations(now?: string, limit?: number): PendingMutation[]
  canonicalizeMessage(input: CanonicalizeMessageInput): StoredMessage
  deleteCanonicalMessage(messageId: string, conversationId: string): CanonicalMessageDeleteResult
  markRead(conversationId: string, throughMessageId: string, now?: string): boolean
  queueReadReceipt(conversationId: string, throughMessageId: string, clientOperationId: string, now?: string): void
  listDueReadReceipts(now?: string, limit?: number): PendingReadReceipt[]
  markReadReceiptSending(id: string, now?: string): PendingReadReceipt
  markReadReceiptSent(id: string): void
  markReadReceiptFailed(id: string, failure: MutationFailure): void
  getSyncCursor(): SyncCursor
  commitSyncCursor(expectedCursor: string | null, nextCursor: string, now?: string): boolean
  recordSyncChange(changeId: string, now?: string): boolean
  applySocialProjection(accountEpoch: string, projection: SocialProjection, now?: string): void
  invalidateSocialProfile(profileId: string, now?: string): void
  listSocialRelationships(): SocialProjection[]
  socialRelationshipForThread(threadId: string): SocialProjection | null
  getSocialReplicaState(): SocialReplicaState
  commitSocialCursor(accountEpoch: string, expectedCursor: string | null, nextCursor: string): boolean
  resetProjection(): void
}

export interface MessagingStoreBoundary extends DirectMessagingStoreBoundary {
  readonly groups: GroupStoreBoundary
}

export interface MessagingUser {
  id: string
  displayName: string | null
  handle: string | null
  /** Hosted avatar URL when the plane projects one; absent on older planes. */
  avatarUrl?: string | null
  /** False until the person chose a username; `null` when the plane did not say. */
  handleCustomized?: boolean | null
  /** ISO time the next username change is allowed; `null` when unknown or allowed now. */
  nextHandleChangeAt?: string | null
}

/**
 * `atum.assistant-registry/1` — what a device tells the plane about one of the
 * person's assistants. Keyed by the identity the desktop minted (or, for the
 * default assistant, adopted from the plane), never by the profile name.
 */
export interface AssistantRegistration {
  identityId: string
  displayName: string
  avatar: string
  isDefault: boolean
  lifecycleRevision: number
}

export interface RegisteredAssistant {
  id: string
  /** Null only on a backfilled default no device has claimed yet. */
  identityId: string | null
  displayName: string
  /** Server-projected public photo URL. The legacy avatar symbol stays separate. */
  avatarUrl?: string | null
  avatar: string
  isDefault: boolean
  lifecycleRevision: number
  /** Server-owned CAS revision for identity metadata; never use lifecycleRevision for sync. */
  identityRevision: number
  /** Zero means this identity has not uploaded a portable definition. */
  definitionRevision: number
  status: 'active' | 'retired'
}

/**
 * `registered` — the row now reflects this device. `stale` — a newer revision
 * is stored; the returned row stands. `adopt` — the plane already holds a
 * different identity for the default assistant; the device must adopt it.
 */
export type AssistantRegistrationOutcome = 'registered' | 'stale' | 'adopt'

export interface AssistantRegistrationResult {
  outcome: AssistantRegistrationOutcome
  assistant: RegisteredAssistant
}

export interface IdentityProfileUpdate {
  displayName: string
}

export const ATUM_AVATAR_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export const ATUM_AVATAR_MAX_BYTES = 2_097_152

export interface AvatarUploadReservation {
  uploadId: string
  /** Short-lived signed URL the renderer PUTs the bytes to; never persisted. */
  uploadUrl: string
  uploadHeaders: Record<string, string>
  expiresAt: string
}

export type ArtifactState = 'ready' | 'missing' | 'denied' | 'offline' | 'unsupported' | 'error'

export interface ResolvedArtifact {
  artifactId: string
  type: string
  title: string
  url: string
  status: 'generating' | 'ready'
  embed?: {
    url: string
    kind: 'interactive_view' | 'document' | 'image' | 'file'
    expiresAt: string
  }
}

export type ArtifactResolution =
  | { state: 'ready'; artifact: ResolvedArtifact }
  | { state: Exclude<ArtifactState, 'ready'>; artifact: null }

export interface MessagingSyncStatus {
  accountId: string | null
  connectivity: ConnectivityState
  synchronized: boolean
  cursor: string | null
  lastSuccessfulSyncAt: string | null
  nextRetryAt: string | null
  errorCode: string | null
}

export interface MessagingRealtimeAdvertisement {
  transport: 'supabase_private_broadcast'
  topic: string
  event: string
}

export interface MessagingTransportStatus {
  accountId: string | null
  healthy: boolean
  state: 'disabled' | 'connecting' | 'healthy' | 'degraded'
}

export interface MessageHistoryPage {
  messages: StoredMessage[]
  nextCursor: string | null
  hasMore: boolean
}

export interface MessageSearchResult {
  message: CanonicalMessage
  conversationTitle: string | null
}

export interface MediaUploadResult {
  attachmentId: string
  uploadUrl: string
}

export interface MessagingSessionTokens {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
}

export interface MessagingAccountSession {
  baseUrl: string
  user: MessagingUser
  tokens: MessagingSessionTokens
}

export interface IdentityHandleAvailability {
  available: boolean
  reason: string | null
  retryAfterSeconds: number | null
}

export interface LinkedIdentityApp {
  app: string
  displayName: string
  state: 'never_linked' | 'linked' | 'unlinked'
  connectedAt: string | null
  lastActiveAt: string | null
}

/**
 * RETIRED legacy wallet (pre-Matrix app): the read-only Proton wallet. Its
 * desktop checkout was retired on 2026-10-05 (atum-platform
 * docs/archive/legacy-desktop-checkout); paused inference keeps its complete
 * wallet ledger.
 */
export interface ProtonWallet {
  balanceProtons: number
  funded: boolean
  spendingEnabled: boolean
  availableProtons: number
  heldProtons: number
  trialProtons: number
  aiProtonsPerUsd: number
}

/* Atum Store (plan 2026-09-10-atum-store.md, decisions 2, 4, 7, 8). The client
 * never names a price outside an offer; ownership is the entitlement row. */

export type StoreItemKind = 'skill' | 'pet' | 'agent'

export interface StoreSourceHermesOptional {
  type: 'hermes_optional'
  identifier: string
}

export interface StoreSourceCatalogBundle {
  type: 'catalog_bundle'
  sha256: string
}

export interface StoreSourceBundledPet {
  type: 'bundled'
  slug: string
}

export interface StoreSourceCatalogAsset {
  type: 'catalog_asset'
  sha256: string
}

export interface StoreSourceCloudSkill { type: 'cloud_skill' }

export type StoreItemSource =
  | { type: 'cloud_agent' }
  | StoreSourceCloudSkill
  | StoreSourceHermesOptional
  | StoreSourceCatalogBundle
  | StoreSourceBundledPet
  | StoreSourceCatalogAsset

export interface StoreItemDetail {
  description: Record<string, string>
  tryPrompt: Record<string, string>
  needs: string[]
}

export interface StoreCatalogOffer {
  billingInterval?: 'one_time' | 'month'
  id: string
  version: number
  priceProtons: number
}

export interface StoreCatalogItemHash {
  sha256: string
  hermesRelease: string | null
}

export interface StoreCatalogItem {
  kind: StoreItemKind
  id: string
  title: Record<string, string>
  summary: Record<string, string>
  detail: StoreItemDetail
  glyph: string
  accent: string
  source: StoreItemSource | null
  featured: boolean
  sortOrder: number
  offer: StoreCatalogOffer | null
  hashes: StoreCatalogItemHash[]
}

export interface StoreEntitlement {
  assistantId: string | null
  assistantIdentityId: string | null
  kind: StoreItemKind
  id: string
  state: 'active' | 'revoked'
  grantedAt: string
}

export interface StoreCatalog {
  items: StoreCatalogItem[]
  entitlements: StoreEntitlement[]
  availableProtons: number
  /** Items hidden because this build cannot fulfil their kind or source type
   * (plan decision 11): counted and reported, never fatal to the whole read. */
  skippedUnknownItems: number
}

export interface StorePurchase {
  assistantId: string | null
  id: string
  offerId: string
  offerVersion: number
  kind: StoreItemKind
  itemId: string
  amountProtons: number
  status: 'completed' | 'refunded'
  createdAt: string
  refundedAt: string | null
}

export interface StorePurchaseWallet {
  availableProtons: number
}

export interface StorePurchaseCompleted {
  outcome: 'completed'
  purchase: StorePurchase
  entitlement: StoreEntitlement
  wallet: StorePurchaseWallet | null
}

export interface StorePurchaseAlreadyOwned {
  outcome: 'already_owned'
  purchase: null
  entitlement: StoreEntitlement
}

/** The confirmed offer_version lost a race; the active offer is authoritative, nothing was charged. */
export interface StorePurchaseOfferChanged {
  outcome: 'offer_changed'
  offer: StoreCatalogOffer
}

/** Idempotent replay of a purchase that has since been refunded. */
export interface StorePurchaseRefunded {
  outcome: 'refunded'
  purchase: StorePurchase
  entitlement: StoreEntitlement | null
}

export type StorePurchaseResult =
  | StorePurchaseCompleted
  | StorePurchaseAlreadyOwned
  | StorePurchaseOfferChanged
  | StorePurchaseRefunded

export interface StoreTrainingTask {
  task_id: string
  assistant_id: string
  assistant_identity_id: string
  conversation_id: string
  skill_id: string
}

export interface StorePurchaseStatus {
  purchase: StorePurchase
  entitlement: StoreEntitlement | null
}

/**
 * A signed `catalog_owned` entry: what the gateway actually installs.
 * `kind` is deliberately NOT narrowed to StoreItemKind — an unknown future
 * kind still names paid content Hermes must gate, so it must survive the parse
 * and ride inside the verbatim envelope (plan decision 11, review B5).
 */
export interface StoreCatalogOwnedEntry {
  delivery: 'cloud' | 'local'
  kind: string
  id: string
  identifier: string
  hashes: string[]
}

/** The platform-signed envelope of decision 7, validated field by field. */
export interface StoreEntitlementEnvelope {
  v: 3
  accountId: string
  issuedAt: number
  expiresAt: number
  keyId: string
  entitlements: Array<{ kind: StoreItemKind; id: string; state: 'active' | 'revoked'; assistantId: string | null; assistantIdentityId: string | null }>
  catalogOwned: StoreCatalogOwnedEntry[]
  signature: string
}

/**
 * The envelope with its exact received bytes. `raw` is what main persists as
 * the gateway's offline proof (decision 8): re-serialising the parsed object
 * could reorder keys and break the Ed25519 signature Hermes verifies.
 */
export interface StoreEntitlementProof {
  envelope: StoreEntitlementEnvelope
  raw: string
}

/** S5-owned direct messaging surface. No app chat or artifact methods belong here. */
export interface DirectMessagingClientBoundary {
  status(): Promise<MessagingSyncStatus>
  roster(limit?: number): Promise<MessagingConversation[]>
  messages(conversationId: string, limit?: number): Promise<StoredMessage[]>
  loadOlderMessages(conversationId: string, limit?: number): Promise<MessageHistoryPage>
  transportStatus(): Promise<MessagingTransportStatus>
  mentionTargets(conversationId: string): Promise<MentionTargetsResponse>
  ensureContactConversation(contactUserId: string): Promise<{ conversationId: string }>
  handleAvailability(handle: string): Promise<IdentityHandleAvailability>
  renameHandle(handle: string): Promise<MessagingUser>
  updateProfile(input: IdentityProfileUpdate): Promise<MessagingUser>
  createAvatarUpload(input: { contentType: string }): Promise<AvatarUploadReservation>
  completeAvatarUpload(uploadId: string): Promise<MessagingUser>
  clearAvatar(): Promise<MessagingUser>
  socialLookup(query: string): Promise<SocialProjection>
  socialMutate(action: SocialMutationAction, targetProfileId: string): Promise<SocialProjection>
  socialRelationships(): Promise<SocialProjection[]>
  socialSync(): Promise<SocialProjection[]>
  draft(conversationId: string): Promise<ConversationDraft | null>
  saveDraft(conversationId: string, draft: SaveDraftInput): Promise<ConversationDraft>
  send(input: QueueSendInput): Promise<PendingMutation>
  retry(clientMessageId: string): Promise<PendingMutation>
  markRead(conversationId: string, throughMessageId: string): Promise<boolean>
  toggleReaction(messageId: string, emoji: string): Promise<void>
  editMessage(messageId: string, content: string): Promise<void>
  recallMessage(messageId: string): Promise<void>
  searchMessages(query: string, conversationId?: string): Promise<MessageSearchResult[]>
  createMediaUpload(input: { fileName: string; mimeType: string; sizeBytes: number }): Promise<MediaUploadResult>
  completeMediaUpload(attachmentId: string): Promise<void>
  downloadMedia(attachmentId: string): Promise<{ url: string }>
  sendTyping(conversationId: string, typing: boolean): Promise<boolean>
  drainMentionJobs(): Promise<{ claimed: number; completed: number }>
  sync(): Promise<MessagingSyncStatus>
}

/** Legacy composition surface; S6 methods remain outside the S5 direct contract. */
export interface MessagingClientBoundary extends DirectMessagingClientBoundary, GroupMessagingClient {
  artifact(conversationId: string, resourceId: string): Promise<ArtifactResolution>
  ensureSpecialistConversation(specialist: string): Promise<{ conversationId: string }>
  linkedApps(): Promise<LinkedIdentityApp[]>
  disconnectApp(app: string): Promise<{ localCleanup: 'complete' | 'unconfirmed' } | void>
  /** `atum.assistant-registry/1`: what this person has, keyed by identity. */
  registerAssistant(input: AssistantRegistration): Promise<AssistantRegistrationResult>
  retireAssistant(input: {
    identityId: string
    lifecycleRevision: number
    expectedIdentityRevision?: number
  }): Promise<{ outcome: string; lifecycleRevision: number }>
  listAssistants(): Promise<RegisteredAssistant[]>
  getAssistantDefinition(assistantId: string): Promise<AtumAssistantDefinitionSnapshot>
  putAssistantDefinition(
    assistantId: string,
    input: AtumAssistantDefinitionWrite
  ): Promise<AtumAssistantDefinitionSnapshot>
  protonWallet(): Promise<ProtonWallet>
  protonRewards(): Promise<ProtonRewards>
  claimProtonConnectionReward(kind: ProtonRewardKind, accessToken: string): Promise<ProtonRewardClaim>
  /** Atum Store. The entitlements read returns the envelope's raw bytes beside
   * the parsed fields because main persists them verbatim as the offline proof. */
  catalog(): Promise<StoreCatalog>
  purchase(offerId: string, offerVersion: number, idempotencyKey: string, assistantId?: string | null): Promise<StorePurchaseResult>
  agentHires(): Promise<AtumAgentHire[]>
  hireAgent(assistantId: string, offerId: string, offerVersion: number, idempotencyKey: string, consent: true): Promise<AtumHireResult>
  cancelAgentHire(hireId: string): Promise<AtumAgentHire>
  startAgentTask(assistantId: string, conversationId: string, skillId: string | null): Promise<AtumExecutionTask | null>
  startTrainingTask(assistantId: string, conversationId: string, skillId: string): Promise<StoreTrainingTask>
  purchaseStatus(purchaseId: string): Promise<StorePurchaseStatus>
  entitlements(): Promise<StoreEntitlementProof>
  advisoryClaim(clientOperationId: string): Promise<{ job: ClaimedPrivateAdvisoryJob | null; replayed: boolean }>
  advisoryComplete(conversationId: string, jobId: string, leaseToken: string, replyText: string): Promise<void>
  advisoryFail(
    conversationId: string,
    jobId: string,
    leaseToken: string,
    errorCode: string,
    retryable: boolean
  ): Promise<void>
  advisorySearch(input: AdvisorySearchRequest): Promise<AdvisorySearchResult>
  advisoryRefresh(input: {
    conversationId: string
    subjectId: string
    installationId: string
    linkEpoch: number
  }): Promise<{ context: PrivateAdvisoryContext }>
  createAssistantAvatarUpload(assistantId: string, input: { contentType: string }): Promise<AvatarUploadReservation>
  completeAssistantAvatarUpload(assistantId: string, uploadId: string): Promise<RegisteredAssistant>
  clearAssistantAvatar(assistantId: string): Promise<RegisteredAssistant>
}

export type MessagingSyncClientBoundary = Omit<
  DirectMessagingClientBoundary,
  | 'ensureContactConversation'
  | 'handleAvailability'
  | 'renameHandle'
  | 'updateProfile'
  | 'createAvatarUpload'
  | 'completeAvatarUpload'
  | 'clearAvatar'
  | 'transportStatus'
  | 'mentionTargets'
  // Direct hosted-HTTP operations owned by the runtime, not the sync engine.
  | 'toggleReaction'
  | 'editMessage'
  | 'recallMessage'
  | 'searchMessages'
  | 'createMediaUpload'
  | 'completeMediaUpload'
  | 'downloadMedia'
  | 'sendTyping'
  | 'drainMentionJobs'
>

export interface OpenMessagingStoreOptions {
  accountId: string
  databasePath: string
}
