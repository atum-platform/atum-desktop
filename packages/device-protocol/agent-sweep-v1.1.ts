import { AGENT_SWEEP_V11_PACK } from './contract-packs'
import {
  parseAgentSweepClaimResponse as parseAgentSweepClaimResponseV1,
  parseAgentSweepDispatchResponse as parseAgentSweepDispatchResponseV1,
  parseAgentSweepSettleRequest as parseAgentSweepSettleRequestV1,
  parseAgentSweepSettlementResponse as parseAgentSweepSettlementResponseV1,
  type AgentSweepClaimRequest,
  type AgentSweepClaimResponse,
  type AgentSweepCloudCommitBinding,
  type AgentSweepCloudModelGrant,
  type AgentSweepDispatchResponse,
  type AgentSweepOwnerEventWatermark,
  type AgentSweepSettleRequest,
  type AgentSweepSettlementResponse,
  type AgentSweepSourceScan,
  type AgentSweepSourceWatermarks
} from './agent-sweep'
import type { AgentSweepActivity } from './agent-sweep'
import { messageViolations } from './schema'

/**
 * Mirrored from `@atum/protocol` 0.7.52 (platform `feat/sweep-warmup` 253859de) and the
 * vendored `spec/agent-sweep/v1.1` pack. The frozen `/1` module is untouched; this file adds the
 * negotiated warm-up profile the cloud controller and the Mac home claim with.
 */
export const AGENT_SWEEP_PROFILE_V11 = 'atum.agent-sweep/1.1' as const
export const AGENT_SWEEP_PACK_V11_PIN = '575c69f085532f68db104237a9a3c391aa0b2740c1227e846801e0cc50f7c7e7' as const
export const AGENT_SWEEP_PROTOCOL_VERSION_V11 = '0.7.52' as const
export const AGENT_SWEEP_MIGRATION_V11 = '0328' as const

export const AGENT_SWEEP_V11_LIMITS = Object.freeze({
  warmupOffsetsMs: [300_000, 900_000, 2_100_000, 3_600_000] as const,
  warmupActiveComputeSeconds: 1_800,
  peakSourceChecksPerLocalDay: 24,
  peakModelAttemptsPerLocalDay: 16,
  baselineSourceChecksPerLocalDay: 12,
  baselineModelAttemptsPerLocalDay: 8,
  warmupReleaseLimit: 2,
  warmupReleaseBackoffMs: 120_000
} as const)

export type AgentSweepOccurrenceKind = 'followup_sweep' | 'warmup_nudge'
export type AgentSweepWarmupNudgeIndex = 1 | 2 | 3 | 4
export type AgentSweepComputeSeconds = 120 | 1_800

export interface AgentSweepPolicyV11 {
  version: 2
  definitionDigest: string
  policyDigest: string
  normalWindow: { startHour: 8; endHour: 21 }
  sourceIntervalMs: 7_200_000
  effectiveSourceIntervalMs: number
  quietMs: 600_000
  claimLeaseMs: 120_000
  activeComputeSeconds: 120
  warmupActiveComputeSeconds: 1_800
  warmupOffsetsMs: [300_000, 900_000, 2_100_000, 3_600_000]
  inputTokens: 8_000
  outputTokens: 1_000
  resultCharacters: 500
  sourceChecksPerLocalDay: 12
  effectiveSourceChecksPerLocalDay: number
  modelAttemptsPerLocalDay: 8
  effectiveModelAttemptsPerLocalDay: number
  nonurgentOffersPerLocalDay: 2
  everydayModel: 'nguyet-thuc'
  warmupReleaseLimit: 2
  warmupReleaseBackoffMs: 120_000
}

export interface AgentSweepClaimRequestV11 {
  profile: typeof AGENT_SWEEP_PROFILE_V11
  operation: 'claim'
  requestId: string
  leaseToken: string
  activity: AgentSweepActivity
}

export interface AgentSweepDispatchRequestV11 {
  profile: typeof AGENT_SWEEP_PROFILE_V11
  operation: 'dispatch'
  occurrenceId: string
  leaseToken: string
  activity: AgentSweepActivity
}

export interface AgentSweepDeferResponseV11 {
  profile: typeof AGENT_SWEEP_PROFILE_V11
  decision: 'defer'
  reason: string
  notBefore: number
}

interface AgentSweepClaimedV11Common {
  profile: typeof AGENT_SWEEP_PROFILE_V11
  decision: 'claimed'
  occurrenceId: string
  occurrenceAt: number
  effectiveDueAt: number
  expiresAt: number
  settingsRevision: number
  ownerTimeZone: string
  policy: AgentSweepPolicyV11
  sourceWatermarks: AgentSweepSourceWatermarks
}

export type AgentSweepClaimedResponseV11 =
  | (AgentSweepClaimedV11Common & { occurrenceKind: 'followup_sweep'; warmupNudgeIndex?: undefined })
  | (AgentSweepClaimedV11Common & { occurrenceKind: 'warmup_nudge'; warmupNudgeIndex: AgentSweepWarmupNudgeIndex })

export type AgentSweepClaimResponseV11 = AgentSweepDeferResponseV11 | AgentSweepClaimedResponseV11

interface AgentSweepBudgetV11 {
  reservationId: string
  funding: 'trial' | 'wallet'
  ceilingMicroProtons: number
  computeSeconds: AgentSweepComputeSeconds
  firstAdmission: boolean
}

export interface AgentSweepCloudAuthorizationV11 {
  kind: 'cloud'
  budget: AgentSweepBudgetV11
  grant: AgentSweepCloudModelGrant
}

export interface AgentSweepNativeAuthorizationV11 {
  kind: 'native'
  authorizationId: string
  expiresAt: number
  destination: { destination: string; source: string; model: string; effort: 'low' | 'medium' | 'high' }
  protection:
    | { kind: 'standard' }
    | { kind: 'google_protected'; googlePolicy: 'limited_use_v1'; latchState: 'eligible' | 'latched' }
  attribution: { id: string; lane: 'atum_managed' | 'connected_provider' }
  limits: {
    activeComputeSeconds: AgentSweepComputeSeconds
    calls: 1
    inputTokens: 8_000
    outputTokens: 1_000
    maxModelMicroProtons: number | null
  }
}

export interface AgentSweepDispatchedResponseV11 {
  profile: typeof AGENT_SWEEP_PROFILE_V11
  decision: 'dispatched'
  occurrenceId: string
  occurrenceKind: AgentSweepOccurrenceKind
  warmupNudgeIndex: AgentSweepWarmupNudgeIndex | null
  expiresAt: number
  settingsRevision: number
  authorization: AgentSweepCloudAuthorizationV11 | AgentSweepNativeAuthorizationV11
}

export type AgentSweepDispatchResponseV11 = AgentSweepDeferResponseV11 | AgentSweepDispatchedResponseV11

export interface AgentSweepUsageV11 {
  computeSeconds: number
  modelAttempts: 0 | 1
  inputTokens: number
  outputTokens: number
  modelMicroProtons: number
}

interface AgentSweepSettleCommonV11 {
  profile: typeof AGENT_SWEEP_PROFILE_V11
  operation: 'settle'
  occurrenceId: string
  leaseToken: string
  resultFingerprint: string
  usage: AgentSweepUsageV11
  scan: AgentSweepSourceScan
  ownerEventWatermark: AgentSweepOwnerEventWatermark | null
  commit: AgentSweepCloudCommitBinding
}

export type AgentSweepSettleRequestV11 =
  | (AgentSweepSettleCommonV11 & {
      outcome: 'answered'
      disposition: 'silent'
      findingHashes: []
      outbox: null
    })
  | (AgentSweepSettleCommonV11 & {
      outcome: 'answered'
      disposition: 'offer'
      urgency: 'normal' | 'harm_before_morning'
      findingHashes: string[]
      outbox: { outboxId: string; bodySha256: string }
    })
  | (AgentSweepSettleCommonV11 & {
      outcome: 'failed' | 'stopped' | 'uncertain'
      disposition: 'none'
      findingHashes: []
      outbox: null
    })

export interface AgentSweepSettlementResponseV11 {
  profile: typeof AGENT_SWEEP_PROFILE_V11
  state: 'settled'
  occurrenceId: string
  occurrenceKind: AgentSweepOccurrenceKind
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

export type AgentSweepReleaseReason = 'invalid_result' | 'ambiguous_submission' | 'unusable_claim'

export interface AgentSweepReleaseRequestV11 {
  profile: typeof AGENT_SWEEP_PROFILE_V11
  operation: 'release'
  occurrenceId: string
  leaseToken: string
  reason: AgentSweepReleaseReason
  usage?: AgentSweepUsageV11
}

export interface AgentSweepReleaseReleasedResponseV11 {
  profile: typeof AGENT_SWEEP_PROFILE_V11
  decision: 'released'
  occurrenceId: string
  occurrenceKind: 'warmup_nudge'
  warmupNudgeIndex: AgentSweepWarmupNudgeIndex
  releaseCount: 1 | 2
  retryAt: number
}

export interface AgentSweepReleaseRetiredResponseV11 {
  profile: typeof AGENT_SWEEP_PROFILE_V11
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

export type AgentSweepReleaseResponseV11 = AgentSweepReleaseReleasedResponseV11 | AgentSweepReleaseRetiredResponseV11

export type AnyAgentSweepClaimRequest = AgentSweepClaimRequestV11 | AgentSweepClaimRequest
export type AnyAgentSweepClaimResponse = AgentSweepClaimResponseV11 | AgentSweepClaimResponse
export type AnyAgentSweepDispatchResponse = AgentSweepDispatchResponseV11 | AgentSweepDispatchResponse
export type AnyAgentSweepSettleRequest = AgentSweepSettleRequestV11 | AgentSweepSettleRequest
export type AnyAgentSweepSettlementResponse = AgentSweepSettlementResponseV11 | AgentSweepSettlementResponse

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function profileOf(value: unknown): string | undefined {
  return record(value) && typeof value.profile === 'string' ? value.profile : undefined
}

/** Validate one mirrored message against the vendored 1.1 pack, shape and invariants alike. */
export function validAgentSweepMessageV11(message: string, value: unknown): boolean {
  return messageViolations(AGENT_SWEEP_V11_PACK, message, value).length === 0
}

function parse<T>(message: string, value: unknown): T {
  if (!validAgentSweepMessageV11(message, value)) throw new Error('agent_sweep_v11_invalid')
  return value as T
}

export const parseAgentSweepClaimRequestV11 = (value: unknown) => parse<AgentSweepClaimRequestV11>('claim', value)
export const parseAgentSweepClaimResponseV11 = (value: unknown) => parse<AgentSweepClaimResponseV11>('claim.response', value)
export const parseAgentSweepDispatchRequestV11 = (value: unknown) => parse<AgentSweepDispatchRequestV11>('dispatch', value)
export const parseAgentSweepDispatchResponseV11 = (value: unknown) => parse<AgentSweepDispatchResponseV11>('dispatch.response', value)
export const parseAgentSweepSettleRequestV11 = (value: unknown) => parse<AgentSweepSettleRequestV11>('settle', value)
export const parseAgentSweepSettlementResponseV11 = (value: unknown) => parse<AgentSweepSettlementResponseV11>('settlement', value)
export const parseAgentSweepReleaseRequestV11 = (value: unknown) => parse<AgentSweepReleaseRequestV11>('release', value)
export const parseAgentSweepReleaseResponseV11 = (value: unknown) => parse<AgentSweepReleaseResponseV11>('release.response', value)

/** Accept a response from whichever profile the platform honoured for this connection. */
export function parseAnyAgentSweepClaimResponse(value: unknown): AnyAgentSweepClaimResponse {
  if (profileOf(value) === AGENT_SWEEP_PROFILE_V11) return parseAgentSweepClaimResponseV11(value)
  return parseAgentSweepClaimResponseV1(value)
}

export function parseAnyAgentSweepDispatchResponse(value: unknown): AnyAgentSweepDispatchResponse {
  if (profileOf(value) === AGENT_SWEEP_PROFILE_V11) return parseAgentSweepDispatchResponseV11(value)
  return parseAgentSweepDispatchResponseV1(value)
}

export function parseAnyAgentSweepSettleRequest(value: unknown): AnyAgentSweepSettleRequest {
  if (profileOf(value) === AGENT_SWEEP_PROFILE_V11) return parseAgentSweepSettleRequestV11(value)
  return parseAgentSweepSettleRequestV1(value)
}

export function parseAnyAgentSweepSettlementResponse(value: unknown): AnyAgentSweepSettlementResponse {
  if (profileOf(value) === AGENT_SWEEP_PROFILE_V11) return parseAgentSweepSettlementResponseV11(value)
  return parseAgentSweepSettlementResponseV1(value)
}
