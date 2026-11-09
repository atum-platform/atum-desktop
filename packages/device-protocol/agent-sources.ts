import { AGENT_SOURCES_PACK } from './contract-packs'
import { messageViolations } from './schema'

/** Mirrored from `@atum/protocol` 0.7.56 and the pinned `spec/agent-sources/v1` pack. */
export const AGENT_SOURCES_PROFILE = 'atum.agent-sources/1' as const
export const FOLLOWUP_SWEEP_EVIDENCE_PROFILE_V2 = 'atum.followup-sweep-evidence/2' as const
export const AGENT_SOURCES_PACK_PIN = '677365750031f1ccd908710541222605b36dea9cb40ea8dc03b8820635b61902' as const
export const AGENT_SOURCES_PROTOCOL_VERSION = '0.7.56' as const

export const AGENT_SOURCE_LIMITS = Object.freeze({
  sources: 64,
  sourceIdCharacters: 160,
  cursorBytes: 2_048,
  cursorMapBytes: 65_536,
  descriptorBytes: 65_536,
  tagsPerList: 16,
  tagBytes: 64,
  completeRouteBytes: 262_144
} as const)

export type AgentSourceId = string
export type AgentSourceTag = string

export interface AgentSourceReadCapability {
  operationRef: string
  backgroundSafe: boolean
}

export interface AgentSourceScanRecipe {
  operationRef: string
  cursorSemantics: string
}

export interface AgentSourceDescriptor {
  id: AgentSourceId
  kind: string
  connectionRef: string
  optOutGate: string | null
  revision: number
  scopeRef: string
  readCapabilities: AgentSourceReadCapability[]
  scan: AgentSourceScanRecipe | null
  provenanceTags: AgentSourceTag[]
  policyTags: AgentSourceTag[]
}

export interface AgentSourceIntegrationRegistration {
  profile: typeof AGENT_SOURCES_PROFILE
  integrationRef: string
  integrationRevision: number
  sources: AgentSourceDescriptor[]
}

export type AgentSourceCursors = Record<AgentSourceId, string>

export interface AgentSourceCursorBinding {
  connectionRef: string
  scopeRef: string
  descriptorRevision: number
  authorityRevision: number
}

export type AgentSourceCursorBindings = Record<AgentSourceId, AgentSourceCursorBinding>

export interface AgentSourceCursorBindingDecision {
  profile: typeof AGENT_SOURCES_PROFILE
  sourceId: AgentSourceId
  storedCursor: string
  storedBinding: AgentSourceCursorBinding
  currentBinding: AgentSourceCursorBinding
  decision: 'reuse' | 'reset'
}

export type AgentSourceAvailability = 'available' | 'not_configured' | 'not_authorized' | 'unavailable'
export type AgentSourceBackgroundEligibility =
  | 'eligible' | 'no_scan_recipe' | 'operation_not_background_safe' | 'operation_unresolved' | 'policy_unsupported'

export interface AgentSourceAccessEntry {
  descriptor: AgentSourceDescriptor
  availability: AgentSourceAvailability
  backgroundEligibility: AgentSourceBackgroundEligibility
  binding: AgentSourceCursorBinding | null
}

export interface AgentSourceAccessSnapshot {
  profile: typeof AGENT_SOURCES_PROFILE
  snapshotRevision: number
  snapshotDigest: string
  generatedAt: number
  sources: AgentSourceAccessEntry[]
}

export interface AgentSourceAdmission {
  descriptor: AgentSourceDescriptor
  binding: AgentSourceCursorBinding
}

export interface AgentSourceAdmissionSnapshot {
  profile: typeof AGENT_SOURCES_PROFILE
  snapshotRevision: number
  snapshotDigest: string
  sources: AgentSourceAdmission[]
}

export interface AgentSourceReadRequest {
  profile: typeof AGENT_SOURCES_PROFILE
  requestId: string
  sourceId: AgentSourceId
  operationRef: string
  mode: 'interactive' | 'background'
  binding: AgentSourceCursorBinding
  cursor?: string
}

export interface FollowupSweepEvidenceV2 {
  profile: typeof FOLLOWUP_SWEEP_EVIDENCE_PROFILE_V2
  evidenceId: string
  sourceId: AgentSourceId
  observedAt: number
  objectRef: string
  anchor: string
  dueAt: number | null
  content: string
  provenanceTags: AgentSourceTag[]
  policyTags: AgentSourceTag[]
}

interface AgentSourceReadResultCommon {
  profile: typeof AGENT_SOURCES_PROFILE
  requestId: string
  sourceId: AgentSourceId
  binding: AgentSourceCursorBinding
}

export type AgentSourceReadResult =
  | (AgentSourceReadResultCommon & { status: 'ok'; evidence: FollowupSweepEvidenceV2[]; cursor?: string })
  | (AgentSourceReadResultCommon & { status: 'partial'; evidence: FollowupSweepEvidenceV2[]; cursor?: string })
  | (AgentSourceReadResultCommon & {
      status: 'not_configured' | 'not_authorized' | 'unavailable' | 'failed' | 'budget_skipped'
      evidence: []
    })
  | (AgentSourceReadResultCommon & {
      status: 'policy_unsupported'
      evidence: []
      unsupportedPolicyTags: AgentSourceTag[]
    })

export interface AgentSourceTaggedDerivation {
  profile: typeof FOLLOWUP_SWEEP_EVIDENCE_PROFILE_V2
  evidenceIds: string[]
  sourceIds: AgentSourceId[]
  provenanceTags: AgentSourceTag[]
  policyTags: AgentSourceTag[]
}

export type AgentSourcesMessage =
  | 'integration.registration' | 'access.snapshot' | 'read.request' | 'read.result'
  | 'cursor.map' | 'cursor.binding-decision' | 'derived.output'

export function validAgentSourcesMessage(message: AgentSourcesMessage, value: unknown): boolean {
  return messageViolations(AGENT_SOURCES_PACK, message, value).length === 0
}

function parse<T>(message: AgentSourcesMessage, value: unknown): T {
  if (!validAgentSourcesMessage(message, value)) throw new Error('agent_sources_invalid')
  return value as T
}

export const parseAgentSourceRegistration = (value: unknown) =>
  parse<AgentSourceIntegrationRegistration>('integration.registration', value)
export const parseAgentSourceAccessSnapshot = (value: unknown) =>
  parse<AgentSourceAccessSnapshot>('access.snapshot', value)
export const parseAgentSourceReadRequest = (value: unknown) =>
  parse<AgentSourceReadRequest>('read.request', value)
export const parseAgentSourceReadResult = (value: unknown) =>
  parse<AgentSourceReadResult>('read.result', value)
export const parseAgentSourceCursors = (value: unknown) =>
  parse<AgentSourceCursors>('cursor.map', value)
export const parseAgentSourceCursorBindingDecision = (value: unknown) =>
  parse<AgentSourceCursorBindingDecision>('cursor.binding-decision', value)
export const parseAgentSourceTaggedDerivation = (value: unknown) =>
  parse<AgentSourceTaggedDerivation>('derived.output', value)

export function sameAgentSourceBinding(left: AgentSourceCursorBinding, right: AgentSourceCursorBinding): boolean {
  return left.connectionRef === right.connectionRef && left.scopeRef === right.scopeRef &&
    left.descriptorRevision === right.descriptorRevision && left.authorityRevision === right.authorityRevision
}

export function decideAgentSourceCursorBinding(
  sourceId: AgentSourceId,
  storedCursor: string,
  storedBinding: AgentSourceCursorBinding,
  currentBinding: AgentSourceCursorBinding
): AgentSourceCursorBindingDecision {
  return parseAgentSourceCursorBindingDecision({
    profile: AGENT_SOURCES_PROFILE,
    sourceId,
    storedCursor,
    storedBinding,
    currentBinding,
    decision: sameAgentSourceBinding(storedBinding, currentBinding) ? 'reuse' : 'reset'
  })
}

/** Patch-only cursor settlement: unmentioned and unknown keys survive. */
export function applyAgentSourceCursorDeltas(
  current: AgentSourceCursors,
  deltas: AgentSourceCursors
): AgentSourceCursors {
  return parseAgentSourceCursors({ ...current, ...deltas })
}

const SOURCE_ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/u
const RESERVED_SOURCE_IDS = new Set(['__proto__', 'constructor', 'prototype'])

export function validAgentSourceId(value: unknown): value is AgentSourceId {
  return typeof value === 'string' && SOURCE_ID.test(value) && !RESERVED_SOURCE_IDS.has(value)
}

/** Capabilities, never source names, decide which provider operations a background scan may invoke. */
export function backgroundSafeAgentSourceOperations(descriptor: AgentSourceDescriptor): ReadonlySet<string> {
  return new Set(descriptor.readCapabilities
    .filter(capability => capability.backgroundSafe)
    .map(capability => capability.operationRef))
}
