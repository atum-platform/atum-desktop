import type { MatrixCompanyAIRequest, MatrixCompanyAIValue, MatrixCompanyNativeErrorCode } from './matrix-company-ai'
import type { MatrixCompanyBoardRequest, MatrixCompanyBoardValue } from './matrix-company-board'
import type { MatrixCompanyFileRef } from './matrix-company-files'
import type { MatrixCompanyFundingRequest, MatrixCompanyFundingValue } from './matrix-company-funding'
import type { MatrixCompanyBrainRequest, MatrixCompanyBrainValue } from './matrix-company-project-brain'
import type { MatrixCompanyMessageSearchBridge } from './matrix-company-search'
import type {
  MatrixCompanyRefusalReason,
  TeamSpaceReadAction,
  TeamSpaceEphemeralAction,
  TeamSpaceRequest,
  TeamSpaceValue
} from './matrix-company-team-space'
import type { MatrixProfilePhotoType } from './matrix-profile'

/** C1 authority projection. Navigation never grants knowledge or spending access. */
export interface MatrixCompany {
  id: string
  displayName: string
  role: 'admin' | 'member'
  authorityGeneration: number
}

export interface MatrixCompanyInvitation {
  id: string
  companyId: string
  displayName: string
  role: 'admin' | 'member'
}

/** 1.1 invitation projection: the inviter's current handle and display name. */
export interface MatrixCompanyInvitation11 extends MatrixCompanyInvitation {
  inviter: { handle: string | null; displayName: string | null }
}

export interface MatrixCompanyDirectory {
  schemaVersion: 1
  companies: MatrixCompany[]
  invitations: MatrixCompanyInvitation[]
}

/** 1.1 directory: the same companies plus invitee-safe inviters and pilot admission. */
export interface MatrixCompanyDirectory11 {
  schemaVersion: 2
  companies: MatrixCompany[]
  invitations: MatrixCompanyInvitation11[]
  /** Advisory only; the server decides at create time. */
  canCreate: boolean
}

export type MatrixCompanyMemberState = 'invited' | 'active' | 'revoking' | 'removed'

/** 1.1 member projection. A removed row carries no profile fields. */
export interface MatrixCompanyMember11 {
  memberRef: string
  role: 'admin' | 'member'
  state: MatrixCompanyMemberState
  self: boolean
  handle: string | null
  displayName: string | null
  avatarUri?: string
}

export interface MatrixCompanySnapshot {
  schemaVersion: 1
  company: MatrixCompany
  members: Array<{ principal: string; role: 'admin' | 'member'; state: MatrixCompanyMemberState }>
  projects: Array<{ id: string; displayName: string; memberPrincipals: string[]; collaboration: 'not_provisioned' }>
}

export interface MatrixCompanyProject11 {
  id: string
  displayName: string
  memberRefs: string[]
  collaboration: 'not_provisioned'
}

/** 1.1 snapshot: opaque member refs, default channel, no principals. */
export interface MatrixCompanySnapshot11 {
  schemaVersion: 2
  company: MatrixCompany
  members: MatrixCompanyMember11[]
  projects: MatrixCompanyProject11[]
  defaultChannelId: string | null
}

export interface MatrixCompanyChannel {
  id: string
  companyId: string
  displayName: string
  visibility: 'company'
  state: 'provisioning' | 'active' | 'archived'
  projectId: string | null
  authorityGeneration: number
  channelGeneration: number
}

/** The seeded first channel; clients localize its label. */
export interface MatrixCompanyChannel11 extends MatrixCompanyChannel {
  systemKey?: 'default'
}

export type MatrixCompanyRoom =
  | { state: 'not_provisioned' | 'provisioning' | 'reconciling' | 'failed'; roomId: null }
  | { state: 'ready'; roomId: string }

/** A channel row's display state: the room's state, or archived once the channel is. */
export type MatrixCompanyChannelState = MatrixCompanyRoom['state'] | 'archived'

export interface MatrixCompanyChannelSnapshot {
  schemaVersion: 1
  channel: MatrixCompanyChannel
  memberPrincipals: string[]
  room: MatrixCompanyRoom
}

export interface MatrixCompanyChannelSnapshot11 {
  schemaVersion: 2
  channel: MatrixCompanyChannel11
  memberCount: number
  room: MatrixCompanyRoom
}

export type MatrixCompanyChannelItem = MatrixCompanyChannelSnapshot | MatrixCompanyChannelSnapshot11

export interface MatrixCompanyChannelDirectory {
  schemaVersion: 1
  channels: MatrixCompanyChannelSnapshot[]
}

export interface MatrixCompanyChannelDirectory11 {
  schemaVersion: 2
  channels: MatrixCompanyChannelSnapshot11[]
}

export type MatrixCompanyChannelDirectoryValue = MatrixCompanyChannelDirectory | MatrixCompanyChannelDirectory11

/** 1.1 remove-member acknowledgement. `revoking` is honest: cleanup is still running. */
export interface MatrixCompanyRemoval11 {
  schemaVersion: 2
  companyId: string
  memberRef: string
  state: 'revoking' | 'removed'
  authorityGeneration: number
}

/** 1.1 self-leave acknowledgement; the replay keeps answering until `removed`. */
export interface MatrixCompanyLeave11 {
  schemaVersion: 2
  companyId: string
  state: 'revoking' | 'removed'
  retired: boolean
  authorityGeneration: number
}

export interface MatrixCompanyProjectEligibleChannel {
  channelId: string
  displayName: string
  state: 'ready'
}

export interface MatrixCompanyProjectEligibleFile {
  file: MatrixCompanyFileRef
  channelId: string
  eventId: string
  publishedAt: string
}

export type MatrixCompanyProjectSource =
  | {
      id: string
      kind: 'channel'
      state: 'active' | 'withdrawn'
      channelId: string
      enrolledAt: string
      withdrawnAt: string | null
    }
  | {
      id: string
      kind: 'company_file'
      state: 'active' | 'withdrawn'
      channelId: string
      file: MatrixCompanyFileRef
      enrolledAt: string
      withdrawnAt: string | null
    }

export interface MatrixCompanyProjectSources {
  schemaVersion: 1
  companyId: string
  projectId: string
  authorityGeneration: number
  sourceGeneration: number
  eligibleChannels: MatrixCompanyProjectEligibleChannel[]
  eligibleFiles: MatrixCompanyProjectEligibleFile[]
  sources: MatrixCompanyProjectSource[]
  coverage: { state: 'empty' | 'pending' }
}

export type MatrixCompanyProjectReaderGapCode = 'assignment_unavailable' | 'lease_contention' |
  'roster_unresolved' | 'backfill_pending' | 'history_gap' | 'join_changed' | 'file_unavailable' |
  'receipt_pending' | 'reader_unavailable'

export type MatrixCompanyProjectReaderCoverage =
  | { state: 'empty' | 'pending' }
  | { state: 'live'; lastIngestedAt: string }
  | { state: 'paused' | 'attention'; gapCode: MatrixCompanyProjectReaderGapCode; lastIngestedAt?: string }

export type MatrixCompanyProjectReaderSource = {
  sourceId: string
  kind: 'channel' | 'company_file'
  state: 'active' | 'withdrawn'
  channelId: string
  receiptState: 'none' | 'live' | 'paused' | 'attention' | 'stale'
  file?: MatrixCompanyFileRef
  lastIngestedAt?: string
  gapCode?: MatrixCompanyProjectReaderGapCode
}

/** T3b2 receipt-derived coverage only. Evidence and generated briefs are deliberately absent. */
export interface MatrixCompanyProjectReaderStatus {
  schemaVersion: 2
  companyId: string
  projectId: string
  authorityGeneration: number
  sourceGeneration: number
  coverage: MatrixCompanyProjectReaderCoverage
  sources: MatrixCompanyProjectReaderSource[]
}

/** Admin-only aggregate balances; no private task or member billing history. */
export interface MatrixCompanyWallet {
  schemaVersion: 1
  companyId: string
  unit: 'micro_proton'
  balances: { paid: number; earned: number; promo: number; held: number; available: number }
  checkoutOpen: false
  funding: { enabled: boolean; taskLimit: number | null; revision: number }
}

export type MatrixCompanyValue = MatrixCompanyDirectory | MatrixCompanyDirectory11
  | MatrixCompanySnapshot | MatrixCompanySnapshot11 | MatrixCompanyWallet
  | MatrixCompanyChannelDirectory | MatrixCompanyChannelDirectory11
  | MatrixCompanyChannelSnapshot | MatrixCompanyChannelSnapshot11 | MatrixCompanyProjectSources
  | MatrixCompanyProjectReaderStatus | MatrixCompanyRemoval11 | MatrixCompanyLeave11 | TeamSpaceValue

export type MatrixCompanyRequest =
  | { action: 'list' }
  | { action: 'read'; companyId: string }
  | { action: 'wallet'; companyId: string }
  | { action: 'create'; requestId: string; displayName: string }
  | { action: 'accept'; companyId: string; requestId: string; invitationId: string }
  /** 1.1 only: the native layer refuses this before a v1 server sees it. */
  | { action: 'invite'; companyId: string; requestId: string; memberHandle: string; role: 'admin' | 'member' }
  | { action: 'remove-member'; companyId: string; requestId: string; memberRef: string }
  | { action: 'leave'; companyId: string; requestId: string }
  | { action: 'create-project'; companyId: string; requestId: string; displayName: string }
  | { action: 'list-channels'; companyId: string }
  | { action: 'read-channel'; companyId: string; channelId: string }
  | { action: 'project-sources'; companyId: string; projectId: string }
  | { action: 'project-reader'; companyId: string; projectId: string }
  | { action: 'create-channel'; companyId: string; requestId: string; displayName: string; projectId?: string }
  | { action: 'archive-channel' | 'restore-channel'; companyId: string; channelId: string; requestId: string }
  | { action: 'include-project-channel-source'; companyId: string; projectId: string; requestId: string;
      channelId: string; expectedSourceGeneration: number }
  | { action: 'include-project-file-source'; companyId: string; projectId: string; requestId: string;
      fileId: string; revision: 1; expectedSourceGeneration: number }
  | { action: 'withdraw-project-source'; companyId: string; projectId: string; requestId: string;
      sourceId: string; expectedSourceGeneration: number }
  | { action: 'funding'; companyId: string; requestId: string; enabled: boolean; taskLimit: number }
  /** Team Space: the closed 1.2–1.7 vocabulary (`matrix-company-team-space.ts`). */
  | TeamSpaceRequest

export type MatrixCompanyMutation = Exclude<MatrixCompanyRequest,
  { action: 'list' | 'read' | 'wallet' | 'list-channels' | 'read-channel' | 'project-sources' | 'project-reader'
    | TeamSpaceReadAction | TeamSpaceEphemeralAction }>

export type MatrixCompanyErrorCode = 'authentication' | 'denied' | 'missing' | 'conflict' | 'limit' | 'invalid' | 'unavailable' | 'cancelled'
export type MatrixCompanyResult =
  | { ok: true; value: MatrixCompanyValue }
  /**
   * `reason` is the one typed refusal the platform named (owner_transfer_required, channel_name_conflict, ...),
   * only when the body was a closed refusal that belongs to the status; otherwise the code stands alone.
   */
  | { ok: false; error: MatrixCompanyErrorCode; retryAfterSeconds?: number; reason?: MatrixCompanyRefusalReason }

export type MatrixCompanyPendingResult =
  | { ok: true; request: MatrixCompanyMutation | null }
  | { ok: false; error: MatrixCompanyErrorCode }

export interface MatrixCompanyAvatarPhoto {
  type: MatrixProfilePhotoType
  bytes: Uint8Array
}

export interface MatrixCompanyAvatarMedia {
  roomId: string
  avatarMxc: string | null
  /** Authenticated, bounded image bytes safe for the renderer's CSP. */
  avatarUrl: string | null
}

export type MatrixCompanyNativeFamily = 'ai' | 'funding' | 'board' | 'project-brain'

export type MatrixCompanyNativeResult =
  | {
      ok: true
      value: MatrixCompanyAIValue | MatrixCompanyFundingValue | MatrixCompanyBoardValue | MatrixCompanyBrainValue
    }
  | { ok: false; error: MatrixCompanyNativeErrorCode; retryAfterSeconds?: number; member?: true }

/**
 * Release B native seam: one closed family per call. The main process parses the
 * family and the request again before any I/O, so a renderer can never widen it.
 */
export type MatrixCompanyNativeBridge = (
  family: MatrixCompanyNativeFamily,
  request: MatrixCompanyAIRequest | MatrixCompanyFundingRequest | MatrixCompanyBoardRequest | MatrixCompanyBrainRequest
) => Promise<MatrixCompanyNativeResult>

export interface MatrixCompanyBridge extends MatrixCompanyMessageSearchBridge {
  pending(): Promise<MatrixCompanyPendingResult>
  request(input: MatrixCompanyRequest): Promise<MatrixCompanyResult>
  /** Trusted renderer → own Matrix SDK upload; it never changes the human profile. */
  uploadAvatar?(photo: MatrixCompanyAvatarPhoto): Promise<string>
  /** A joined company channel's manager-written room avatar, downloaded with this Matrix session. */
  avatar?(roomId: string): Promise<MatrixCompanyAvatarMedia | null>
  /** Release B Company AI, funding, board and project-brain native calls. */
  native?: MatrixCompanyNativeBridge
}
