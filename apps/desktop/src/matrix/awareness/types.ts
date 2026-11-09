/**
 * Presentation projection, NOT an IPC protocol or an authorization decision.
 * RT validates the frozen awareness v1 response and resolves human labels before
 * supplying this private-owner view. No backend, SDK or provider dependency.
 */
export type AwarenessSourceKind =
  | 'assistant_chat'
  | 'human_dm'
  | 'human_group'
  | 'app_exchange'
  | 'drive_file'
  | 'native_memory'
  | 'owner_statement'

export type AwarenessCoverageState =
  | 'ready'
  | 'catching_up'
  | 'partial'
  | 'offline'
  | 'excluded'
  | 'needs_keys'
  | 'paused'
  | 'error'

export type AwarenessCoverageReason =
  | 'google_fence'
  | 'cloud_access_ended'
  | 'owner_paused'
  | 'keys_missing'
  | 'backfill_pending'
  | 'unsupported_media'
  | 'service_unavailable'
  | 'device_offline'
  | 'excluded_by_owner'
  | 'temporary_conversation'

export type AwarenessEpistemic =
  | 'statement'
  | 'question'
  | 'quotation'
  | 'proposal'
  | 'decision'
  | 'commitment'
  | 'correction'
  | 'unknown'

export type AwarenessCitation =
  | { kind: 'matrix_event'; roomId: string; eventId: string }
  | { kind: 'drive_file'; fileId: string; version: string }
  | { kind: 'memory'; agentPrincipal: string; revision: number }

export interface AwarenessSource {
  /** Stable opaque presentation key, never shown as a human label. */
  key: string
  kind: AwarenessSourceKind
  label?: string
  state: AwarenessCoverageState
  reasons: readonly AwarenessCoverageReason[]
  asOf: number
  processedThrough?: number
}

export interface AwarenessEvidence {
  evidenceId: string
  sourceKind: AwarenessSourceKind
  sourceLabel?: string
  content: string
  epistemic: AwarenessEpistemic
  eventTime: number
  expiresAt?: number
  citation: AwarenessCitation
}

export interface AwarenessSnapshot {
  /** Account + profile + private audience + native policy/lifecycle generation. */
  scopeKey: string
  /** Changes on every replacement/withdrawal; old actions are discarded. */
  snapshotId: string
  audience: 'private_owner'
  status: 'ok' | 'degraded' | 'unavailable'
  /** RT supplies freshness. Stale is NOT another wire coverage state. */
  freshness: 'current' | 'stale'
  sources: readonly AwarenessSource[]
  evidence: readonly AwarenessEvidence[]
}

export type AwarenessData = { state: 'loading' | 'unavailable' } | { state: 'ready'; snapshot: AwarenessSnapshot }

export interface AwarenessCitationRequest {
  scopeKey: string
  snapshotId: string
  evidenceId: string
  citation: AwarenessCitation
}

export interface AwarenessPanelProps {
  currentScopeKey: string | null
  data: AwarenessData
  /** Native verifies current identity, policy, source access and exact revision. */
  onOpenCitation?: (request: AwarenessCitationRequest) => Promise<void>
}
