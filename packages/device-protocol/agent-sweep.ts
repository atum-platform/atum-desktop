import { AGENT_SWEEP_PACK } from './contract-packs'
import { messageViolations } from './schema'

/** Mirrored from @atum/protocol 0.7.47 at platform commit 05cd0d7d. */
export const AGENT_SWEEP_PROFILE = 'atum.agent-sweep/1' as const
export const AGENT_SWEEP_SETTING_PROFILE = 'atum.agent-sweep-setting/1' as const
export const FOLLOWUP_SWEEP_RESULT_PROFILE = 'atum.followup-sweep-result/1' as const
export const AGENT_SWEEP_SYSTEM_SCHEDULE_ID = 'sys_followup_sweep_v1' as const
export const AGENT_SWEEP_PACK_PIN = '0827f068dc2b8bfde9cdd6447f3daf186a208ff4f5fe1001d0efb554c9d12675' as const
export const AGENT_SWEEP_PROTOCOL_VERSION = '0.7.47' as const
export const AGENT_SWEEP_MIGRATION = '0316' as const

export const AGENT_SWEEP_LIMITS = Object.freeze({
  sourceIntervalMs: 7_200_000,
  quietMs: 600_000,
  claimLeaseMs: 120_000,
  activeComputeSeconds: 120,
  inputTokens: 8_000,
  outputTokens: 1_000,
  resultCharacters: 500,
  sourceChecksPerLocalDay: 12,
  modelAttemptsPerLocalDay: 8,
  nonurgentOffersPerLocalDay: 2,
  normalWindowStartHour: 8,
  normalWindowEndHour: 21,
  everydayModel: 'nguyet-thuc'
} as const)

export interface AgentSweepOwnerEventWatermark {
  eventId: string
  at: number
}

export interface AgentSweepActivity {
  lastOwnerEvent: AgentSweepOwnerEventWatermark | null
  lastDialogueAt: number | null
  busy: boolean
  pendingWork: boolean
  pendingApproval: boolean
  typing: boolean
}

export interface AgentSweepSourceWatermarks {
  googleMail: string | null
  googleCalendar: string | null
  atumChats: string | null
  conversation: string | null
  memory: string | null
}

export interface AgentSweepPolicy {
  version: 1
  definitionDigest: string
  policyDigest: string
  normalWindow: { startHour: 8; endHour: 21 }
  sourceIntervalMs: 7_200_000
  quietMs: 600_000
  claimLeaseMs: 120_000
  activeComputeSeconds: 120
  inputTokens: 8_000
  outputTokens: 1_000
  resultCharacters: 500
  sourceChecksPerLocalDay: 12
  modelAttemptsPerLocalDay: 8
  nonurgentOffersPerLocalDay: 2
  everydayModel: 'nguyet-thuc'
}

export interface AgentSweepClaimRequest {
  profile: typeof AGENT_SWEEP_PROFILE
  operation: 'claim'
  requestId: string
  leaseToken: string
  activity: AgentSweepActivity
}

export interface AgentSweepDispatchRequest {
  profile: typeof AGENT_SWEEP_PROFILE
  operation: 'dispatch'
  occurrenceId: string
  leaseToken: string
  activity: AgentSweepActivity
}

export type AgentSweepDeferReason =
  | 'disabled' | 'policy_off' | 'not_due' | 'outside_window' | 'missing_time_zone'
  | 'home_unavailable' | 'stale_lease' | 'busy' | 'owner_active' | 'pending_work'
  | 'cap_exhausted' | 'unfunded' | 'hire_paused' | 'entitlement_required'
  | 'judgment_backoff' | 'active_occurrence' | 'unavailable'

export interface AgentSweepDeferResponse {
  profile: typeof AGENT_SWEEP_PROFILE
  decision: 'defer'
  reason: AgentSweepDeferReason
  notBefore: number
}

export interface AgentSweepClaimedResponse {
  profile: typeof AGENT_SWEEP_PROFILE
  decision: 'claimed'
  occurrenceId: string
  occurrenceAt: number
  expiresAt: number
  settingsRevision: number
  ownerTimeZone: string
  policy: AgentSweepPolicy
  sourceWatermarks: AgentSweepSourceWatermarks
}

export type AgentSweepClaimResponse = AgentSweepDeferResponse | AgentSweepClaimedResponse

export interface AgentSweepCloudBudget {
  reservationId: string
  funding: 'trial' | 'wallet'
  ceilingMicroProtons: number
  computeSeconds: 120
  firstAdmission: boolean
}

interface AgentSweepCloudGrantCommon {
  token: string
  expiresAt: number
  contextBudget: 8_000
  outputBudget: 1_000
  maxTurnMicroProtons: number
  ceilingMicroProtons: number
  funding: 'trial' | 'wallet'
}

export type AgentSweepCloudModelGrant =
  | (AgentSweepCloudGrantCommon & {
      kind: 'managed'
      alias: 'nguyet-thuc'
      model: 'nguyet-thuc'
      effort: 'medium'
      policyDigest: string
    })
  | (AgentSweepCloudGrantCommon & {
      kind: 'google_protected'
      alias: 'google-protected'
      model: 'google-protected'
      googlePolicy: 'limited_use_v1'
      latchState: 'eligible' | 'latched'
    })

export interface AgentSweepCloudAuthorization {
  kind: 'cloud'
  budget: AgentSweepCloudBudget
  grant: AgentSweepCloudModelGrant
}

export interface AgentSweepNativeAuthorization {
  kind: 'native'
  authorizationId: string
  expiresAt: number
  destination: { destination: string; source: string; model: string; effort: 'low' | 'medium' | 'high' }
  protection:
    | { kind: 'standard' }
    | { kind: 'google_protected'; googlePolicy: 'limited_use_v1'; latchState: 'eligible' | 'latched' }
  attribution: { id: string; lane: 'atum_managed' | 'connected_provider' }
  limits: { activeComputeSeconds: 120; calls: 1; inputTokens: 8_000; outputTokens: 1_000;
    maxModelMicroProtons: number | null }
}

export interface AgentSweepDispatchedResponse {
  profile: typeof AGENT_SWEEP_PROFILE
  decision: 'dispatched'
  occurrenceId: string
  expiresAt: number
  settingsRevision: number
  authorization: AgentSweepCloudAuthorization | AgentSweepNativeAuthorization
}

export type AgentSweepDispatchResponse = AgentSweepDeferResponse | AgentSweepDispatchedResponse
export type AgentSweepSourceId = 'google_mail' | 'google_calendar' | 'atum_chats' | 'conversation' | 'memory'
export type AgentSweepSourceStatus = 'ok' | 'not_configured' | 'not_authorized' | 'unavailable' | 'failed'

export interface AgentSweepSourceScan {
  digest: string
  watermarks: AgentSweepSourceWatermarks
  sources: Array<{ source: AgentSweepSourceId; status: AgentSweepSourceStatus }>
}

export interface AgentSweepUsage {
  computeSeconds: number
  modelAttempts: 0 | 1
  inputTokens: number
  outputTokens: number
  modelMicroProtons: number
}

export interface AgentSweepCloudCommitBinding {
  kind: 'cloud'
  queueSeq: number
  expectedHomeGeneration: number
}

interface AgentSweepSettleCommon {
  profile: typeof AGENT_SWEEP_PROFILE
  operation: 'settle'
  occurrenceId: string
  leaseToken: string
  resultFingerprint: string
  usage: AgentSweepUsage
  scan: AgentSweepSourceScan
  ownerEventWatermark: AgentSweepOwnerEventWatermark | null
  commit: AgentSweepCloudCommitBinding
}

export type AgentSweepSettleRequest =
  | (AgentSweepSettleCommon & {
      outcome: 'answered'
      disposition: 'silent'
      findingHashes: []
      outbox: null
    })
  | (AgentSweepSettleCommon & {
      outcome: 'answered'
      disposition: 'offer'
      urgency: 'normal' | 'harm_before_morning'
      findingHashes: string[]
      outbox: { outboxId: string; bodySha256: string }
    })
  | (AgentSweepSettleCommon & {
      outcome: 'failed' | 'stopped' | 'uncertain'
      disposition: 'none'
      findingHashes: []
      outbox: null
    })

export interface AgentSweepSettlementResponse {
  profile: typeof AGENT_SWEEP_PROFILE
  state: 'settled'
  occurrenceId: string
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

export type FollowupSweepResult =
  | { profile: typeof FOLLOWUP_SWEEP_RESULT_PROFILE; decision: 'silent' }
  | { profile: typeof FOLLOWUP_SWEEP_RESULT_PROFILE; decision: 'offer'; evidenceIds: string[];
      urgency: 'normal' | 'harm_before_morning'; text: string }

export type AgentSweepMessage =
  | 'claim' | 'claim.response' | 'dispatch' | 'dispatch.response' | 'settle' | 'settlement' | 'classifier.result'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function closedAgentSweepMessage(message: AgentSweepMessage, value: unknown): boolean {
  if (!record(value)) return false
  if (message === 'dispatch.response' && value.decision === 'dispatched') {
    const authorization = value.authorization
    if (!record(authorization)) return false
    if (authorization.kind === 'native') return authorization.expiresAt === value.expiresAt
    if (authorization.kind !== 'cloud' || !record(authorization.budget) || !record(authorization.grant)) return false
    const budget = authorization.budget, grant = authorization.grant
    return grant.expiresAt === value.expiresAt && grant.funding === budget.funding &&
      grant.ceilingMicroProtons === budget.ceilingMicroProtons &&
      typeof grant.maxTurnMicroProtons === 'number' && typeof budget.ceilingMicroProtons === 'number' &&
      grant.maxTurnMicroProtons <= budget.ceilingMicroProtons
  }
  if (message === 'settle') {
    if (!record(value.usage) || !record(value.scan) || !Array.isArray(value.scan.sources) ||
        new Set(value.scan.sources.map(item => record(item) ? item.source : undefined)).size !== value.scan.sources.length ||
        !Array.isArray(value.findingHashes) || new Set(value.findingHashes).size !== value.findingHashes.length) return false
    const usage = value.usage
    if (usage.modelAttempts === 0 && (usage.inputTokens !== 0 || usage.outputTokens !== 0 || usage.modelMicroProtons !== 0)) return false
    if (value.disposition === 'silent') return value.outcome === 'answered' && value.findingHashes.length === 0 && value.outbox === null
    if (value.disposition === 'offer') return value.outcome === 'answered' &&
      ['normal', 'harm_before_morning'].includes(String(value.urgency)) && value.findingHashes.length >= 1 &&
      value.findingHashes.length <= 3 && record(value.outbox)
    return value.disposition === 'none' && ['failed', 'stopped', 'uncertain'].includes(String(value.outcome)) &&
      value.findingHashes.length === 0 && value.outbox === null
  }
  if (message === 'settlement') {
    if (!record(value.publication)) return false
    return value.disposition === 'offer' ? ['admitted', 'suppressed'].includes(String(value.publication.state)) :
      value.publication.state === 'none'
  }
  if (message === 'classifier.result' && value.decision === 'offer') {
    if (!Array.isArray(value.evidenceIds) || new Set(value.evidenceIds).size !== value.evidenceIds.length ||
        !value.evidenceIds.every(id => typeof id === 'string' && /^[a-z][a-z0-9_-]*:[A-Za-z0-9._~-]+$/u.test(id)) ||
        typeof value.text !== 'string') return false
    let count = 0
    for (const character of value.text) {
      const point = character.codePointAt(0)!
      if (point >= 0xd800 && point <= 0xdfff || ++count > AGENT_SWEEP_LIMITS.resultCharacters) return false
    }
  }
  return true
}

export function validAgentSweepMessage(message: AgentSweepMessage, value: unknown): boolean {
  return messageViolations(AGENT_SWEEP_PACK, message, value).length === 0 && closedAgentSweepMessage(message, value)
}

function parse<T>(message: AgentSweepMessage, value: unknown): T {
  if (!validAgentSweepMessage(message, value)) throw new Error('agent_sweep_invalid')
  return value as T
}

export const parseAgentSweepClaimRequest = (value: unknown) => parse<AgentSweepClaimRequest>('claim', value)
export const parseAgentSweepClaimResponse = (value: unknown) => parse<AgentSweepClaimResponse>('claim.response', value)
export const parseAgentSweepDispatchRequest = (value: unknown) => parse<AgentSweepDispatchRequest>('dispatch', value)
export const parseAgentSweepDispatchResponse = (value: unknown) => parse<AgentSweepDispatchResponse>('dispatch.response', value)
export const parseAgentSweepSettleRequest = (value: unknown) => parse<AgentSweepSettleRequest>('settle', value)
export const parseAgentSweepSettlementResponse = (value: unknown) => parse<AgentSweepSettlementResponse>('settlement', value)
export const parseFollowupSweepResult = (value: unknown) => parse<FollowupSweepResult>('classifier.result', value)
