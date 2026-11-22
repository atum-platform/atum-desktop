import { createHash } from 'node:crypto'

import { z } from 'zod'

// Client mirror of the Work route contract `atum.work-route/1`, with its additive 1.1 settlement amendment
// (atum-platform spec/work-route/v1, v1.1 and packages/protocol/src/work-route.ts).
// Lane G builds only on fields declared there; its fixtures are the oracle.
// Decision D20 (owner, 2026-11-21): one Atum service token at the edge, the
// Mac's grant tells agents apart. Values marked provisional in the contract
// may change by amendment: change them here and in the contract together.

export const WORK_GATE_PATH = '/agent/mcp'
export const WORK_TOOLS = ['launch', 'send', 'status', 'close', 'interrupt', 'read', 'wait', 'list', 'request'] as const
export type WorkTool = (typeof WORK_TOOLS)[number]
export const WORK_TERMINAL_THREAD_STATUSES = ['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back'] as const
export const WORK_WAIT_MAX_MS = 50_000
export const WORK_REQUEST_BODY_MAX_BYTES = 65_536
export const WORK_TASK_MAX_CODE_POINTS = 16_000
export const WORK_DERIVED_TITLE_MAX_CODE_POINTS = 60
export const WORK_CALL_MESSAGE_MAX_CODE_POINTS = 24_000
export const WORK_READ_PASSTHROUGH_MAX_ENCODED_BYTES = 262_144
export const WORK_LIST_MAX_THREADS = 100
export const WORK_GRANT_RANDOM_BYTES = 32
export const WORK_THREAD_ID_PREFIX = 'mcp:launch:'
export const WORK_SOCKET_PATH_MAX_BYTES = 100
// 1.1 settlement reports: at most 64 per call; the platform keeps a report 30 days.
export const WORK_SETTLEMENT_REPORTS_MAX = 64
export const WORK_SETTLEMENT_RETENTION_DAYS = 30

// atum.work-route/1.2: subscriptions (self-work slice B; atum-platform spec/work-route/v1.2 and packages/protocol/src/work-route.ts).
// Codex is the only plan a launch may name (gate 4b-1). No token, login, e-mail or plan name appears in any of these.
export const WORK_PLAN_PROVIDERS = ['codex'] as const
export type WorkPlanProvider = (typeof WORK_PLAN_PROVIDERS)[number]
export const WORK_PLAN_REFUSAL_REASONS = [
  'plan_consent_stale',
  'plan_consent_off',
  'plan_switch_off',
  'plan_not_scheduled'
] as const
export type WorkPlanRefusalReason = (typeof WORK_PLAN_REFUSAL_REASONS)[number]
export const WORK_CONSENT_AGENTS_MAX = 256
/** The Mac reports the plan fact on every change and at least this often; the platform reads an older one as stale. */
export const WORK_SUBSCRIPTION_FACT_REFRESH_SECONDS = 3_600
export const WORK_SUBSCRIPTION_FACT_MAX_AGE_SECONDS = 86_400
export const WORK_CONSENT_FRESHNESS_BOUND_SECONDS = 300

export const WORK_PROVISIONAL = {
  launchDeadlineSeconds: 120,
  clockSkewToleranceSeconds: 60,
  ownerEventMaxAgeSeconds: 900,
  entitlementFreshnessBoundSeconds: 300,
  entitlementSyncIntervalSeconds: 60,
  grantLifetimeSeconds: 2_592_000
} as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const safe = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const positive = safe.min(1)
const uuid = z.string().regex(UUID)
const idString = z.string().min(1).max(200).regex(/^[A-Za-z0-9:._-]{1,200}$/u)

const codePoints = (min: number, max: number) =>
  z.string().refine(value => {
    const size = [...value].length

    return size >= min && size <= max
  }, 'length in code points')

export const WorkRequestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/u)
export const WorkOwnerEventSchema = z.string().min(2).max(255).regex(/^[$][A-Za-z0-9_+/=-]{1,254}$/u)
export const WorkThreadIdSchema = idString
export const WorkRunIdSchema = idString

export const WorkGateIdSchema = z.object({ deviceServiceId: uuid, accountId: uuid, routeEpoch: positive }).strict()
export type WorkGateId = z.infer<typeof WorkGateIdSchema>

export const WORK_THREAD_STATUSES = [
  'no_run_yet',
  'queued',
  'preparing',
  'starting',
  'running',
  'waiting',
  'idle',
  ...WORK_TERMINAL_THREAD_STATUSES
] as const
export type WorkThreadStatus = (typeof WORK_THREAD_STATUSES)[number]

export const WORK_REFUSAL_REASONS = [
  'unknown_field',
  'invalid_field',
  'expired',
  'deadline_too_long',
  'params_mismatch',
  'balance_empty',
  'event_already_used',
  'owner_event_not_found',
  'owner_event_redacted',
  'owner_event_not_owner',
  'owner_event_wrong_room',
  'owner_event_too_old',
  'owner_event_future',
  'owner_event_undecryptable',
  'owner_event_device_not_owner',
  ...WORK_PLAN_REFUSAL_REASONS
] as const
export type WorkRefusalReason = (typeof WORK_REFUSAL_REASONS)[number]

export const WORK_REJECTION_REASONS = [
  't3_invalid_request',
  't3_model_unavailable',
  't3_runtime_mode_escalation_denied',
  't3_invalid_mode_limit',
  't3_unauthorized',
  't3_schema_error'
] as const
export type WorkRejectionReason = (typeof WORK_REJECTION_REASONS)[number]

/** Admission failures are HTTP errors, never receipts. `agent_mismatch` is reserved (D20 does not produce it). */
export const WORK_ADMISSION_ERRORS = [
  { type: 'wrong_host', status: 404 },
  { type: 'no_route', status: 404 },
  { type: 'method_not_allowed', status: 405 },
  { type: 'origin_header', status: 403 },
  { type: 'cookie', status: 403 },
  { type: 'no_assertion', status: 401 },
  { type: 'bad_assertion', status: 401 },
  { type: 'no_grant', status: 401 },
  { type: 'unknown_grant', status: 401 },
  { type: 'agent_mismatch', status: 403 },
  { type: 'revoked', status: 403 },
  { type: 'stale_entitlements', status: 503 },
  { type: 'body_too_large', status: 413 },
  { type: 'bad_request', status: 400 },
  { type: 'tool_not_allowed', status: 403 },
  { type: 'internal', status: 500 }
] as const
export type WorkAdmissionErrorType = (typeof WORK_ADMISSION_ERRORS)[number]['type']

export function admissionStatus(type: WorkAdmissionErrorType): number {
  return WORK_ADMISSION_ERRORS.find(entry => entry.type === type)?.status ?? 500
}

// ----- agent -> gate (strict: an unknown field is refused, never trimmed)
export const WorkLaunchArgumentsSchema = z
  .object({
    requestId: WorkRequestIdSchema,
    projectId: idString,
    task: codePoints(1, WORK_TASK_MAX_CODE_POINTS),
    ownerEvent: WorkOwnerEventSchema,
    notAfter: safe,
    /** 1.2: "on my plan". The one new argument; the gate still sets the provider itself, never the caller. */
    plan: z.enum(WORK_PLAN_PROVIDERS).optional()
  })
  .strict()
export const WorkInterruptArgumentsSchema = z.object({ threadId: WorkThreadIdSchema }).strict()
export const WorkReadArgumentsSchema = z.object({ threadId: WorkThreadIdSchema }).strict()
export const WorkWaitArgumentsSchema = z
  .object({ threadId: WorkThreadIdSchema, timeoutMs: z.number().int().min(1000).max(WORK_WAIT_MAX_MS).optional() })
  .strict()
export const WorkListArgumentsSchema = z
  .object({
    limit: z.number().int().min(1).max(WORK_LIST_MAX_THREADS).optional(),
    cursor: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]{1,200}$/u).optional()
  })
  .strict()
export const WorkRequestArgumentsSchema = z
  .object({ requestId: WorkRequestIdSchema, action: z.enum(['status', 'void']) })
  .strict()

export const WorkSendArgumentsSchema = z.object({
  request_id: WorkRequestIdSchema,
  event_id: WorkOwnerEventSchema,
  room_id: z.string().min(3).max(255).regex(/^![^\s:]+:[^\s]+$/u),
  selection_rev: positive
}).strict()
export type WorkSendArguments = z.infer<typeof WorkSendArgumentsSchema>
export const WorkRelayStatusSchema = z.object({room_id: z.string().min(3).max(255).regex(/^![^\s:]+:[^\s]+$/u)}).strict()
export const WorkRelayRequestSchema = z.object({request_id: WorkRequestIdSchema}).strict()
export const WORK_TOOL_ARGUMENTS = {
  send: WorkSendArgumentsSchema,
  status: WorkRelayStatusSchema,
  close: WorkRelayRequestSchema,
  launch: WorkLaunchArgumentsSchema,
  interrupt: WorkInterruptArgumentsSchema,
  read: z.union([WorkReadArgumentsSchema, WorkRelayRequestSchema]),
  wait: z.union([WorkWaitArgumentsSchema, WorkRelayRequestSchema.extend({timeoutMs: z.number().int().min(1000).max(WORK_WAIT_MAX_MS).optional()}).strict()]),
  list: WorkListArgumentsSchema,
  request: z.union([WorkRequestArgumentsSchema, WorkRelayRequestSchema])
} as const

export type WorkLaunchArguments = z.infer<typeof WorkLaunchArgumentsSchema>

/** What the gate builds for T3. The caller's arguments and headers are never forwarded. */
export const WorkT3LaunchCallSchema = z
  .object({
    projectId: idString,
    workspaceStrategy: z.object({ type: z.literal('root') }).strict(),
    modelSelection: z
      .object({
        instanceId: z.string().min(1).max(200).regex(/^[A-Za-z0-9:._/-]{1,200}$/u),
        model: z.string().min(1).max(200).regex(/^[A-Za-z0-9:._/-]{1,200}$/u)
      })
      .strict(),
    message: codePoints(1, WORK_CALL_MESSAGE_MAX_CODE_POINTS),
    title: codePoints(1, WORK_DERIVED_TITLE_MAX_CODE_POINTS),
    clientRequestId: WorkRequestIdSchema
  })
  .strict()
export type WorkT3LaunchCall = z.infer<typeof WorkT3LaunchCallSchema>

// ----- answers (one variant per class)
export type WorkScope = 'route' | 'agent'

export interface WorkAnswerHead {
  gateId: WorkGateId
  requestId: string
}

export type WorkRequestAnswer =
  | (WorkAnswerHead & { class: 'none'; receipt: 'none' })
  | (WorkAnswerHead & { class: 'pending'; receipt: 'admitted'; forwarded: boolean })
  | (WorkAnswerHead & {
      class: 'accepted'
      receipt: 'launched'
      threadId: string
      runId?: string
      threadStatus?: WorkThreadStatus
    })
  | (WorkAnswerHead & { class: 'refused'; receipt: 'refused'; reason: WorkRefusalReason })
  | (WorkAnswerHead & { class: 'refused'; receipt: 'rejected'; reason: WorkRejectionReason })
  | (WorkAnswerHead & { class: 'refused'; receipt: 'void'; reason: 'void_by_agent' })
  | (WorkAnswerHead & {
      class: 'ambiguous'
      receipt: 'admitted'
      forwarded: boolean
      cause: 'session_replaced' | 'deadline_passed' | 'setting_changed' | 'not_found'
    })
  | (WorkAnswerHead & { class: 'revoked'; receipt: 'revoked'; scope: WorkScope })
  | (WorkAnswerHead & {
      class: 'unavailable'
      receipt: 'none'
      reason: 'provider_not_ready' | 'owner_event_unverifiable'
    })
  | (WorkAnswerHead & { class: 'revocation_pending'; receipt: 'none' })

export type WorkOutcomeClass = WorkRequestAnswer['class']

export type WorkThreadAnswer =
  | { gateId: WorkGateId; class: 'ok'; [key: string]: unknown }
  | { gateId: WorkGateId; class: 'refused'; reason: 'not_in_ledger' | 'thread_from_earlier_session' | 'invalid_arguments'; threadId?: string }
  | { gateId: WorkGateId; class: 'revoked'; scope: WorkScope; threadId?: string }
  | { gateId: WorkGateId; class: 't3_error'; code: string; threadId?: string }

/** `isError` is true unless the class is ok, accepted, none or pending. */
export function workResultIsError(answerClass: string): boolean {
  return !['ok', 'accepted', 'completed', 'terminal', 'closed', 'none', 'pending'].includes(answerClass)
}

// ----- the platform's enrollment facts and account sync (device-services operations)
export const WorkAccessClientIdSchema = z.string().regex(/^[A-Za-z0-9]{16,64}[.]access$/u)

export const WorkEnrollmentFactsSchema = z
  .object({
    surface: z.literal('work'),
    workHostname: z.string().min(3).max(253),
    workUrl: z.string().min(20).max(270),
    accessTeamDomain: z.string().min(20).max(160).regex(/^[a-z0-9][a-z0-9.-]{1,120}[.]cloudflareaccess[.]com$/u),
    accessAudienceTag: z.string().regex(/^[0-9a-f]{64}$/u),
    accessClientIds: z
      .array(WorkAccessClientIdSchema)
      .min(1)
      .max(2)
      .refine(ids => new Set(ids).size === ids.length, 'unique'),
    sessionDurationSeconds: z.number().int().min(60).max(86_400),
    socketPath: z.string().min(2).max(WORK_SOCKET_PATH_MAX_BYTES),
    gateId: WorkGateIdSchema,
    workGrant: z.object({ acceptedAt: safe, routeEpoch: positive }).strict().optional()
  })
  .strict()
export type WorkEnrollmentFacts = z.infer<typeof WorkEnrollmentFactsSchema>

export const WorkSyncChangeSchema = z.union([
  z.object({ seq: positive, kind: z.literal('agent_added'), agentPrincipal: uuid, at: safe }).strict(),
  z
    .object({ seq: positive, kind: z.literal('agent_removed'), agentPrincipal: uuid, scope: z.enum(['owner', 'this_mac']), at: safe })
    .strict(),
  z.object({ seq: positive, kind: z.literal('device_revoked'), at: safe }).strict()
])
export type WorkSyncChange = z.infer<typeof WorkSyncChangeSchema>

/** This Mac's slice of the account's consent record, carried by a 1.2 page. State, not a log: no sequence, no gap rule. */
export const WorkConsentSnapshotSchema = z
  .object({
    provider: z.enum(WORK_PLAN_PROVIDERS),
    state: z.enum(['on', 'off']),
    revision: safe,
    agents: z
      .array(uuid)
      .max(WORK_CONSENT_AGENTS_MAX)
      .refine(items => new Set(items).size === items.length, 'unique'),
    alsoWhenScheduled: z.boolean(),
    grantedAt: safe.optional()
  })
  .strict()
export type WorkConsentSnapshot = z.infer<typeof WorkConsentSnapshotSchema>

export const WorkSyncPageSchema = z
  .object({
    deviceServiceId: uuid,
    accountId: uuid,
    issuedAt: safe,
    fromSeq: safe,
    headSeq: safe,
    entitled: z
      .array(uuid)
      .max(256)
      .refine(items => new Set(items).size === items.length, 'unique'),
    changes: z.array(WorkSyncChangeSchema).max(256),
    hasMore: z.boolean(),
    consent: WorkConsentSnapshotSchema.optional()
  })
  .strict()
  .refine(page => page.fromSeq <= page.headSeq, 'a page never starts after the head')
/** Additive 1.3 page; the legacy reader stays strict. Reset remains in the Mac binding ledger. */
export const WorkRelaySelectionSchema = z.object({
  provider: z.literal('atum-work'), plan: z.enum(['codex', 'claude', 'antigravity']),
  model: z.string().min(1).max(200), revision: positive
}).strict()
export const WorkRelaySyncPageSchema = WorkSyncPageSchema.safeExtend({
  consent: WorkConsentSnapshotSchema,
  selections: z.array(z.object({ agentPrincipal: uuid, selection: WorkRelaySelectionSchema }).strict()).max(256)
}).superRefine((page, ctx) => {
  if (new Set(page.selections.map(row => row.agentPrincipal)).size !== page.selections.length ||
      page.selections.some(row => !page.entitled.includes(row.agentPrincipal))) {
    ctx.addIssue({ code: 'custom', message: 'selection entitlement invariant' })
  }
})
export type WorkSyncPage = z.infer<typeof WorkSyncPageSchema>

export interface WorkSyncAck {
  deviceServiceId: string
  accountId: string
  appliedSeq: number
  settledSeq: number
  routeEpoch: number
  appliedAt: number
  /** 1.2: the consent revision this Mac durably applied. Omitted until a snapshot was applied. */
  consentRevision?: number
}

export const WorkSubscriptionReportReplySchema = z
  .object({
    deviceServiceId: uuid,
    provider: z.enum(WORK_PLAN_PROVIDERS),
    state: z.enum(['connected', 'disconnected']),
    observedAt: safe,
    recordedAt: safe
  })
  .strict()

/** 4b-2, `work.consent.record`: the account's one consent for a plan, as `work_consent_set` / `_revoke` answer it. Default off. */
export const WorkConsentRecordSchema = z
  .object({
    provider: z.enum(WORK_PLAN_PROVIDERS),
    state: z.enum(['on', 'off']),
    agents: z.array(uuid).max(WORK_CONSENT_AGENTS_MAX),
    devices: z.array(uuid).max(32),
    alsoWhenScheduled: z.boolean(),
    revision: safe,
    grantedAt: safe.optional(),
    revokedAt: safe.optional()
  })
  .strict()
export type WorkConsentRecord = z.infer<typeof WorkConsentRecordSchema>

/** `work.subscription.state` (`work_subscription_read`): the consent record and each Mac's plan fact. */
export const WorkSubscriptionStateSchema = z
  .object({
    issuedAt: safe,
    consent: WorkConsentRecordSchema,
    facts: z
      .array(
        z
          .object({
            deviceServiceId: uuid,
            provider: z.enum(WORK_PLAN_PROVIDERS),
            status: z.enum(['connected', 'disconnected', 'stale']),
            observedAt: safe.optional(),
            // The owner's own label for the Mac (the device registry's display name): shown beside its checkbox, nothing else.
            displayName: z.string().min(1).max(64).optional()
          })
          .strict()
      )
      .max(64)
  })
  .strict()
export type WorkSubscriptionState = z.infer<typeof WorkSubscriptionStateSchema>

/** G9, `work_subscription_report`: a boolean and a time. `stale` is never reported, only read by the platform. */
export interface WorkSubscriptionReport {
  deviceServiceId: string
  accountId: string
  routeEpoch: number
  provider: WorkPlanProvider
  state: 'connected' | 'disconnected'
  observedAt: number
}

export interface WorkMacEvent {
  deviceServiceId: string
  accountId: string
  kind: 'route_closed' | 'route_opened' | 'agent_closed' | 'agent_opened'
  routeEpoch: number
  at: number
  agentPrincipal?: string
  agentGeneration?: number
}

export interface WorkGrantCarry {
  gateId: WorkGateId
  agentPrincipal: string
  grant: string
  agentGeneration: number
  mintedAt: number
  expiresAt: number
}

// ----- reference rules (the contract's vectors pin these)
export function workEntitlementsFresh(
  ageSeconds: number,
  headRegressed: boolean,
  boundSeconds: number = WORK_PROVISIONAL.entitlementFreshnessBoundSeconds
): boolean {
  return !headRegressed && ageSeconds <= boundSeconds
}

export function workOwnerEventAge(
  ageSeconds: number,
  maxAgeSeconds: number = WORK_PROVISIONAL.ownerEventMaxAgeSeconds,
  skewSeconds: number = WORK_PROVISIONAL.clockSkewToleranceSeconds
): 'ok' | 'owner_event_too_old' | 'owner_event_future' {
  if (ageSeconds < -skewSeconds) {
    return 'owner_event_future'
  }

  return ageSeconds > maxAgeSeconds ? 'owner_event_too_old' : 'ok'
}

export function workDeadline(
  notAfterMinusNowSeconds: number,
  launchDeadlineSeconds: number = WORK_PROVISIONAL.launchDeadlineSeconds,
  skewSeconds: number = WORK_PROVISIONAL.clockSkewToleranceSeconds
): 'ok' | 'expired' | 'deadline_too_long' {
  if (notAfterMinusNowSeconds < 0) {
    return 'expired'
  }

  return notAfterMinusNowSeconds > launchDeadlineSeconds + skewSeconds ? 'deadline_too_long' : 'ok'
}

export const sha256Hex = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

/**
 * SHA-256 of the immutable launch parameters. A retry must match; the deadline is compared separately. `plan` joins the
 * hash only when present, so a 1.1 launch keeps its hash and a retry cannot turn an Atum launch into a plan one.
 */
export function workParamsHash(projectId: string, task: string, ownerEvent: string, plan?: WorkPlanProvider): string {
  return sha256Hex(JSON.stringify(plan ? [projectId, task, ownerEvent, plan] : [projectId, task, ownerEvent]))
}

export interface WorkPlanLaunchInput {
  consent: 'on' | 'off'
  agentNamed: boolean
  macNamed: boolean
  snapshotAgeSeconds: number
  boundSeconds?: number
  headRegressed: boolean
  localSwitch: boolean
  /** The launch is NOT backed by a fresh, verified, unclaimed owner message (see `WorkGate` and docs/work-subscriptions.md). */
  scheduled: boolean
  alsoWhenScheduled: boolean
}

/**
 * Gate 4b-3, the Mac's rule; the first failing check answers (the platform's `workPlanLaunchDecision`, 12 vectors):
 * a snapshot the Mac cannot call fresh refuses everything (fail closed); then consent off, or this assistant or Mac not
 * named; then the Mac's own switch; then a launch with no fresh owner message that the consent did not allow.
 */
export function workPlanLaunchDecision(input: WorkPlanLaunchInput): 'allowed' | WorkPlanRefusalReason {
  const bound = input.boundSeconds ?? WORK_CONSENT_FRESHNESS_BOUND_SECONDS

  if (input.headRegressed || input.snapshotAgeSeconds > bound) {
    return 'plan_consent_stale'
  }

  if (input.consent !== 'on' || !input.agentNamed || !input.macNamed) {
    return 'plan_consent_off'
  }

  if (!input.localSwitch) {
    return 'plan_switch_off'
  }

  if (input.scheduled && !input.alsoWhenScheduled) {
    return 'plan_not_scheduled'
  }

  return 'allowed'
}

/** T3 derives the launch's thread id from the session and the request id; the gate stores it before it forwards. */
export function workExpectedThreadId(t3SessionId: string, requestId: string): string {
  return `${WORK_THREAD_ID_PREFIX}${sha256Hex(JSON.stringify([`client:${t3SessionId}`, requestId]))}`
}

// ----- atum.work-route/1.1: settlement reports. Content-free: no thread, text, owner event or call; the request id is
// the one correlation the platform learns.
export const WorkStopReportSchema = z
  .object({
    agentPrincipal: uuid,
    requestId: WorkRequestIdSchema,
    routeEpochAtAdmit: positive,
    agentGenerationAtAdmit: positive,
    scope: z.enum(['route', 'agent']),
    outcome: z.enum(['stopped', 'never_sent', 'nothing_started']),
    revocationId: positive,
    settledAt: safe
  })
  .strict()

export const WorkSettlementsReplySchema = z
  .object({
    deviceServiceId: uuid,
    accepted: z.number().int().min(0).max(WORK_SETTLEMENT_REPORTS_MAX),
    ignored: z.number().int().min(0).max(WORK_SETTLEMENT_REPORTS_MAX)
  })
  .strict()
