/** AW's native-only consumer of the centrally frozen atum.awareness/1 pack.
 * Contract: atum-platform/atum-platform@681aef96e916f8957b54881e3bef034fa1f3c9e9.
 * These are module ports, not new HTTP/IPC authority or a second brain schema. */
export interface AwarenessSource {
  kind:
    | 'assistant_chat'
    | 'human_dm'
    | 'human_group'
    | 'app_exchange'
    | 'drive_file'
    | 'native_memory'
    | 'owner_statement'
  id: string
  agentPrincipal?: string
}

export interface AwarenessObject {
  kind: 'message' | 'edit' | 'redaction' | 'file_version' | 'memory_revision'
  id: string
  revision: number
  replaces?: string
}

export interface AwarenessAuthor {
  kind: 'owner' | 'human' | 'agent' | 'app'
  id: string
}
export interface AwarenessAttachment {
  kind: 'file' | 'image' | 'audio'
  ref: string
  mime: string
  bytes: number
  parse: 'parsed' | 'pending' | 'unsupported'
}
export type AwarenessVisibility = 'joined' | 'invited' | 'shared' | 'world_readable' | 'not_applicable'

/** A source-of-record revision, never a renderer/display DTO. RT binds source,
 * logical revision and stable author from its authenticated SDK/authority read.
 * Content is untrusted data; only approved plain text/attachment references enter.
 * A present malformed provenance mark fails closed rather than becoming unmarked. */
export interface AwarenessRevision {
  source: AwarenessSource
  object: AwarenessObject
  author: AwarenessAuthor
  eventTime: number
  content: { text: string; attachments: AwarenessAttachment[] }
  provenance?: unknown
}

export interface AwarenessEnvelope extends Omit<AwarenessRevision, 'provenance'> {
  contract: 'atum.awareness/1'
  operationId: string
  observedTime: number
  policy: { epoch: number; visibility: AwarenessVisibility; googleDerived: boolean; accountFence: boolean }
  digest: string
}

export interface AwarenessEnvelopeContext {
  destination: 'managed' | 'local'
  operationId: string
  observedTime: number
  epoch: number
  visibility: AwarenessVisibility
  accountFence: boolean
}

export type AwarenessNormalized =
  | { kind: 'envelope'; envelope: AwarenessEnvelope }
  | { kind: 'blocked'; reason: 'google_fence' }
  | { kind: 'invalid' | 'unsupported' }

export type AwarenessRefusal =
  | 'google_derived'
  | 'fence_active'
  | 'excluded'
  | 'withdrawn'
  | 'stale_policy_epoch'
  | 'invalid'
  | 'unsupported'
export type AwarenessReceipt = {
  operationId: string
  source: AwarenessSource
  object: Omit<AwarenessObject, 'replaces'>
} & (
  | { state: 'accepted' | 'duplicate' | 'superseded'; acceptedRevision: number }
  | { state: 'refused'; reason: AwarenessRefusal }
)

export type AwarenessWithdrawalScope =
  | { kind: 'fact'; evidenceId: string }
  | { kind: 'object'; source: AwarenessSource; objectId: string }
  | { kind: 'source'; source: AwarenessSource }
  | { kind: 'account' }
export type AwarenessWithdrawal = {
  operationId: string
  withdrawalId: string
  scope: AwarenessWithdrawalScope
  requestedAt: number
} & (
  | { reason: 'forget' | 'delete' | 'account_deleted' }
  | { reason: 'exclude' | 'left_room' | 'revoked'; policyEpoch: number }
)
export interface AwarenessWithdrawalReceipt {
  withdrawalId: string
  state: 'recorded'
  recordedAt: number
  purgeBy: number
  suppressionIds: string[]
}
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
export interface AwarenessCoverage {
  source: AwarenessSource
  state: AwarenessCoverageState
  reasons: AwarenessCoverageReason[]
  asOf: number
  processedThrough?: number
  backfill: { priorityWindowDays: 30; complete: boolean }
}

/** Bound to one authenticated owner by RT/KS. No token, generic Matrix command,
 * send/publish, lease, invocation, model or task interface is exposed to AW.
 * prepare owns any serialized refresh. AW rechecks controls/access after it and
 * invokes the selected dispatch synchronously (no intervening await). */
export interface AwarenessTransport {
  prepare(signal: AbortSignal): Promise<void>
  ingest(envelope: AwarenessEnvelope, signal: AbortSignal): Promise<unknown>
  withdraw(withdrawal: AwarenessWithdrawal, signal: AbortSignal): Promise<unknown>
  fence(notice: { v: 1; since: number }, signal: AbortSignal): Promise<unknown>
  coverage(report: { entries: AwarenessCoverage[] }, signal: AbortSignal): Promise<void>
}

/** One RT-owned enrolled reader/device. readAccess must consult current native
 * authority and real key availability, not names, model args or UI projections.
 * readable proves this exact revision is owner-visible and not pre-join history.
 * Revocation/key loss must update here before returning SDK backlog to AW. */
export interface AwarenessReadAccess {
  active: boolean
  keysAvailable: boolean
  visibility: AwarenessVisibility
  readable(revision: AwarenessRevision): boolean
}

/** A trusted RT scan with no omitted events in this source interval; revisions
 * need not be sorted by timestamps (Matrix timestamps are not ordering proofs).
 * through is the SDK's verified no-gap watermark, NOT a sync token or max event
 * timestamp. complete says historical backfill is complete, not merely live sync. */
export interface AwarenessBatch {
  source: AwarenessSource
  revisions: AwarenessRevision[]
  /** Interval start, null for a full/source-first scan. Cannot be later than
   * the acknowledged watermark, especially after a restore or receipt gap. */
  after: number | null
  through: number
  complete: boolean
}

/** Only metadata/control receipts go here. This seam must be account-isolated,
 * single-writer and atomic; read failure/corruption must never reset tombstones. */
export interface AwarenessStore {
  read(): Promise<unknown>
  write(value: unknown): Promise<void>
}
