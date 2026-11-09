import {
  type AgentSourceAdmissionSnapshot,
  type AgentSourceCursorBinding,
  type AgentSourceCursorBindings,
  type AgentSourceCursors,
  parseAgentSourceCursors
} from './agent-sources'
import {
  type AgentSweepActivity,
  type AgentSweepClaimRequest,
  type AgentSweepClaimResponse,
  type AgentSweepCloudCommitBinding,
  type AgentSweepDispatchResponse,
  type AgentSweepOwnerEventWatermark,
  type AgentSweepSettleRequest,
  type AgentSweepSettlementResponse,
  type AgentSweepSourceWatermarks
} from './agent-sweep'
import {
  type AgentSweepClaimRequestV11,
  type AgentSweepClaimResponseV11,
  type AgentSweepCloudAuthorizationV11,
  type AgentSweepDispatchResponseV11,
  type AgentSweepNativeAuthorizationV11,
  type AgentSweepPolicyV11,
  type AgentSweepReleaseReason,
  type AgentSweepSettleRequestV11,
  type AgentSweepSettlementResponseV11,
  type AgentSweepUsageV11,
  type AgentSweepWarmupNudgeIndex
} from './agent-sweep-v1.1'
import { AGENT_SWEEP_V2_PACK } from './contract-packs'
import { messageViolations } from './schema'

/** Mirrored from `@atum/protocol` 0.7.56 and the pinned `spec/agent-sweep/v2` pack. */
export const AGENT_SWEEP_PROFILE_V2 = 'atum.agent-sweep/2' as const
export const AGENT_SWEEP_PACK_V2_PIN = '2fe190c09d94145b8afe4d9baf54d8d7588e1363e96671e2add07dbc66f9ae8a' as const
export const AGENT_SWEEP_PROTOCOL_VERSION_V2 = '0.7.56' as const

export interface AgentSweepClaimRequestV2 {
  profile: typeof AGENT_SWEEP_PROFILE_V2
  operation: 'claim'
  requestId: string
  leaseToken: string
  activity: AgentSweepActivity
}

export interface AgentSweepDispatchRequestV2 {
  profile: typeof AGENT_SWEEP_PROFILE_V2
  operation: 'dispatch'
  occurrenceId: string
  leaseToken: string
  activity: AgentSweepActivity
}

export interface AgentSweepDeferResponseV2 {
  profile: typeof AGENT_SWEEP_PROFILE_V2
  decision: 'defer'
  reason: string
  notBefore: number
}

interface AgentSweepClaimedV2Common {
  profile: typeof AGENT_SWEEP_PROFILE_V2
  decision: 'claimed'
  occurrenceId: string
  occurrenceAt: number
  effectiveDueAt: number
  expiresAt: number
  settingsRevision: number
  ownerTimeZone: string
  policy: AgentSweepPolicyV11
  admittedSources: AgentSourceAdmissionSnapshot
  sourceCursors: AgentSourceCursors
  cursorBindings: AgentSourceCursorBindings
}

export type AgentSweepClaimedResponseV2 =
  | (AgentSweepClaimedV2Common & { occurrenceKind: 'followup_sweep'; warmupNudgeIndex?: undefined })
  | (AgentSweepClaimedV2Common & { occurrenceKind: 'warmup_nudge'; warmupNudgeIndex: AgentSweepWarmupNudgeIndex })

export type AgentSweepClaimResponseV2 = AgentSweepDeferResponseV2 | AgentSweepClaimedResponseV2

export interface AgentSweepDispatchedResponseV2 {
  profile: typeof AGENT_SWEEP_PROFILE_V2
  decision: 'dispatched'
  occurrenceId: string
  occurrenceKind: 'followup_sweep' | 'warmup_nudge'
  warmupNudgeIndex: AgentSweepWarmupNudgeIndex | null
  expiresAt: number
  settingsRevision: number
  sourceSnapshotRevision: number
  sourceSnapshotDigest: string
  authorization: AgentSweepCloudAuthorizationV11 | AgentSweepNativeAuthorizationV11
}

export type AgentSweepDispatchResponseV2 = AgentSweepDeferResponseV2 | AgentSweepDispatchedResponseV2

export type AgentSweepSourceStatusV2 =
  | 'ok' | 'partial' | 'not_configured' | 'not_authorized' | 'unavailable' | 'failed'
  | 'budget_skipped' | 'policy_unsupported'

interface AgentSweepSourceOutcomeV2Common {
  sourceId: string
  binding: AgentSourceCursorBinding
  provenanceTags: string[]
  policyTags: string[]
}

export type AgentSweepSourceOutcomeV2 =
  | (AgentSweepSourceOutcomeV2Common & { status: 'ok' | 'partial'; evidenceIds: string[] })
  | (AgentSweepSourceOutcomeV2Common & {
      status: 'not_configured' | 'not_authorized' | 'unavailable' | 'failed' | 'budget_skipped'
      evidenceIds: []
    })
  | (AgentSweepSourceOutcomeV2Common & {
      status: 'policy_unsupported'
      evidenceIds: []
      unsupportedPolicyTags: string[]
    })

export interface AgentSweepSourceScanV2 {
  digest: string
  sourceSnapshotDigest: string
  cursorDeltas: AgentSourceCursors
  sources: AgentSweepSourceOutcomeV2[]
}

export interface AgentSweepNativeCommitBinding {
  kind: 'native'
  homeId: string
  homeEpoch: number
  executorTerm: number
  leaseId: string
}

export type AgentSweepCommitBindingV2 = AgentSweepCloudCommitBinding | AgentSweepNativeCommitBinding

interface AgentSweepSettleCommonV2 {
  profile: typeof AGENT_SWEEP_PROFILE_V2
  operation: 'settle'
  occurrenceId: string
  leaseToken: string
  resultFingerprint: string
  usage: AgentSweepUsageV11
  scan: AgentSweepSourceScanV2
  ownerEventWatermark: AgentSweepOwnerEventWatermark | null
  commit: AgentSweepCommitBindingV2
}

export type AgentSweepSettleRequestV2 =
  | (AgentSweepSettleCommonV2 & {
      outcome: 'answered'
      disposition: 'silent'
      findingHashes: []
      outbox: null
    })
  | (AgentSweepSettleCommonV2 & {
      outcome: 'answered'
      disposition: 'offer'
      urgency: 'normal' | 'harm_before_morning'
      findingHashes: string[]
      outbox: { outboxId: string; bodySha256: string }
    })
  | (AgentSweepSettleCommonV2 & {
      outcome: 'failed' | 'stopped' | 'uncertain'
      disposition: 'none'
      findingHashes: []
      outbox: null
    })

export interface AgentSweepSettlementResponseV2 {
  profile: typeof AGENT_SWEEP_PROFILE_V2
  state: 'settled'
  occurrenceId: string
  occurrenceKind: 'followup_sweep' | 'warmup_nudge'
  warmupNudgeIndex?: AgentSweepWarmupNudgeIndex
  outcome: 'answered' | 'failed' | 'stopped' | 'uncertain'
  disposition: 'silent' | 'offer' | 'none'
  receiptId: string
  settingsRevision: number
  nextDueAt: number
  publication:
    | { state: 'none' }
    | { state: 'suppressed'; reason: 'disabled' | 'owner_active' | 'duplicate' | 'stale_authority' }
    | { state: 'admitted'; outboxId: string }
}

export interface AgentSweepReleaseRequestV2 {
  profile: typeof AGENT_SWEEP_PROFILE_V2
  operation: 'release'
  occurrenceId: string
  leaseToken: string
  reason: AgentSweepReleaseReason
  usage?: AgentSweepUsageV11
}

export type AgentSweepReleaseResponseV2 =
  | {
      profile: typeof AGENT_SWEEP_PROFILE_V2
      decision: 'released'
      occurrenceId: string
      occurrenceKind: 'warmup_nudge'
      warmupNudgeIndex: AgentSweepWarmupNudgeIndex
      releaseCount: 1 | 2
      retryAt: number
    }
  | {
      profile: typeof AGENT_SWEEP_PROFILE_V2
      decision: 'retired'
      occurrenceId: string
      occurrenceKind: 'warmup_nudge'
      warmupNudgeIndex: AgentSweepWarmupNudgeIndex
      releaseCount: 2
      outcome: 'uncertain'
      disposition: 'none'
      receiptId: string
      settingsRevision: number
      nextDueAt: number
      publication: { state: 'none' }
    }

export type AgentSweepCloudExecutorRequestV2 =
  | AgentSweepClaimRequestV2 | AgentSweepDispatchRequestV2 | AgentSweepSettleRequestV2 | AgentSweepReleaseRequestV2

export interface AgentSweepNativeSignedMetaV2 {
  requestId: string
  commandId: string
  signer: 'mac_executor'
  signerKeyId: string
  deviceServiceId: string
  sequence: number
  issuedAt: number
  expiresAt: number
  nonce: string
  signature: string
}

export interface AgentSweepNativeHomeFenceV2 {
  ownerUserId: string
  agentPrincipal: string
  homeId: string
  homeEpoch: number
  executorTerm: number
  leaseId: string
  leaseExpiresAtPlatform: number
}

export interface AgentSweepNativeAuthorityFenceV2 extends AgentSweepNativeHomeFenceV2 {
  operation: { kind: 'job'; id: string }
}

export interface AgentSweepNativeClaimEnvelopeV2 {
  meta: AgentSweepNativeSignedMetaV2
  home: AgentSweepNativeHomeFenceV2
  request: AgentSweepClaimRequestV2
}

export interface AgentSweepNativeActiveEnvelopeV2 {
  meta: AgentSweepNativeSignedMetaV2
  fence: AgentSweepNativeAuthorityFenceV2
  request: AgentSweepDispatchRequestV2 | AgentSweepSettleRequestV2
}

export interface AgentSweepNativeReleaseEnvelopeV2 {
  meta: AgentSweepNativeSignedMetaV2
  home: AgentSweepNativeHomeFenceV2
  request: AgentSweepReleaseRequestV2
}

export type AgentSweepNativeExecutorEnvelopeV2 =
  | AgentSweepNativeClaimEnvelopeV2 | AgentSweepNativeActiveEnvelopeV2 | AgentSweepNativeReleaseEnvelopeV2

export interface AgentSweepSettlementAdmissionCheckV2 {
  profile: typeof AGENT_SWEEP_PROFILE_V2
  admittedSources: AgentSourceAdmissionSnapshot
  settlement: AgentSweepSettleRequestV2
}

export interface AgentSweepLegacyProjectionV2 {
  profile: typeof AGENT_SWEEP_PROFILE_V2
  sourceCursors: AgentSourceCursors
  legacySourceWatermarks: AgentSweepSourceWatermarks
}

export type AgentSweepClaimRequestAny = AgentSweepClaimRequest | AgentSweepClaimRequestV11 | AgentSweepClaimRequestV2
export type AgentSweepClaimResponseAny = AgentSweepClaimResponse | AgentSweepClaimResponseV11 | AgentSweepClaimResponseV2
export type AgentSweepDispatchResponseAny = AgentSweepDispatchResponse | AgentSweepDispatchResponseV11 | AgentSweepDispatchResponseV2
export type AgentSweepSettleRequestAny = AgentSweepSettleRequest | AgentSweepSettleRequestV11 | AgentSweepSettleRequestV2
export type AgentSweepSettlementResponseAny =
  AgentSweepSettlementResponse | AgentSweepSettlementResponseV11 | AgentSweepSettlementResponseV2

export type AgentSweepV2Message =
  | 'claim' | 'claim.response' | 'dispatch' | 'dispatch.response' | 'settle' | 'settlement'
  | 'release' | 'release.response' | 'settlement.admission-check' | 'legacy.projection'
  | 'classifier.result' | 'native.claim-envelope' | 'native.active-envelope' | 'native.release-envelope'

export function validAgentSweepMessageV2(message: AgentSweepV2Message, value: unknown): boolean {
  return messageViolations(AGENT_SWEEP_V2_PACK, message, value).length === 0
}

function parse<T>(message: AgentSweepV2Message, value: unknown): T {
  if (!validAgentSweepMessageV2(message, value)) throw new Error('agent_sweep_v2_invalid')
  return value as T
}

export const parseAgentSweepClaimRequestV2 = (value: unknown) => parse<AgentSweepClaimRequestV2>('claim', value)
export const parseAgentSweepClaimResponseV2 = (value: unknown) => parse<AgentSweepClaimResponseV2>('claim.response', value)
export const parseAgentSweepDispatchRequestV2 = (value: unknown) => parse<AgentSweepDispatchRequestV2>('dispatch', value)
export const parseAgentSweepDispatchResponseV2 = (value: unknown) => parse<AgentSweepDispatchResponseV2>('dispatch.response', value)
export const parseAgentSweepSettleRequestV2 = (value: unknown) => parse<AgentSweepSettleRequestV2>('settle', value)
export const parseAgentSweepSettlementResponseV2 = (value: unknown) =>
  parse<AgentSweepSettlementResponseV2>('settlement', value)
export const parseAgentSweepReleaseRequestV2 = (value: unknown) => parse<AgentSweepReleaseRequestV2>('release', value)
export const parseAgentSweepReleaseResponseV2 = (value: unknown) =>
  parse<AgentSweepReleaseResponseV2>('release.response', value)
export const parseAgentSweepSettlementAdmissionCheckV2 = (value: unknown) =>
  parse<AgentSweepSettlementAdmissionCheckV2>('settlement.admission-check', value)
export const parseAgentSweepLegacyProjectionV2 = (value: unknown) =>
  parse<AgentSweepLegacyProjectionV2>('legacy.projection', value)
export const parseAgentSweepNativeClaimEnvelopeV2 = (value: unknown) =>
  parse<AgentSweepNativeClaimEnvelopeV2>('native.claim-envelope', value)
export const parseAgentSweepNativeActiveEnvelopeV2 = (value: unknown) =>
  parse<AgentSweepNativeActiveEnvelopeV2>('native.active-envelope', value)
export const parseAgentSweepNativeReleaseEnvelopeV2 = (value: unknown) =>
  parse<AgentSweepNativeReleaseEnvelopeV2>('native.release-envelope', value)

export function migrateLegacySourceWatermarks(watermarks: AgentSweepSourceWatermarks): AgentSourceCursors {
  const cursors: AgentSourceCursors = {}
  if (watermarks.googleMail !== null) cursors.google_mail = watermarks.googleMail
  if (watermarks.googleCalendar !== null) cursors.google_calendar = watermarks.googleCalendar
  if (watermarks.atumChats !== null) cursors.atum_chats = watermarks.atumChats
  if (watermarks.conversation !== null) cursors.conversation = watermarks.conversation
  if (watermarks.memory !== null) cursors.memory = watermarks.memory
  return parseAgentSourceCursors(cursors)
}

/** Frozen legacy projection: Drive and unknown source cursors never widen `/1` or `/1.1`. */
export function projectLegacySourceWatermarks(cursors: AgentSourceCursors): AgentSweepSourceWatermarks {
  return {
    googleMail: cursors.google_mail ?? null,
    googleCalendar: cursors.google_calendar ?? null,
    atumChats: cursors.atum_chats ?? null,
    conversation: cursors.conversation ?? null,
    memory: cursors.memory ?? null
  }
}
