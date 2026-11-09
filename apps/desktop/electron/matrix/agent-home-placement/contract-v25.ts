/**
 * The desktop/Mac portion of the frozen `atum.agent-home/2.5` placement +
 * connection contract. The complete pack is vendored under
 * `contracts/atum-agent-home-v2.5`; this module mirrors only messages S3 owns.
 *
 * Keep these schemas strict. `contract-v25.test.ts` runs every accepted and
 * rejected fixture for each mirrored message through the real codec.
 */
import { createHash } from 'node:crypto'

import { z } from 'zod'

import { canonicalJson } from '../device/canonical'

export const AGENT_HOME_V25_PREVIOUS_PROFILE = 'atum.agent-home/2.4' as const
export const AGENT_HOME_V25_PROFILE = 'atum.agent-home/2.5' as const
export const AGENT_HOME_V25_PROFILES = [AGENT_HOME_V25_PREVIOUS_PROFILE, AGENT_HOME_V25_PROFILE] as const
export const AgentHomePlacementConnectionProfileV25Schema = z.enum(AGENT_HOME_V25_PROFILES)
export const AGENT_HOME_V25_PIN = '2ed85610e7e866b40946a5a27f840998c78a88664ca3cf5a46b38a95d22eabb7' as const
export const AGENT_HOME_V25_WIRE_HEADER = 'Atum-Agent-Home-Wire' as const
export const AGENT_HOME_V25_WIRE_VERSION = '2.5' as const
export const AGENT_HOME_OFFLINE_POLICY = 'wait_for_home' as const
export const ATUM_MANAGED_CONNECTION_REF = 'conn_atummanaged000001' as const
export const MAC_CATALOG_CLOCK_SKEW_MS = 300_000
export const MAC_CATALOG_FRESHNESS_MAX_MS = 300_000

export const AGENT_HOME_FEATURE_LOSS_CODES = [
  'google_protected_route',
  'protected_private_skill',
  'cloud_browser_session',
  'cloud_computer',
  'drive_publication',
  'routine_execution',
  'push_delivery',
  'changes_since_last_checkpoint_lost',
  'model_source_changes_to_atum',
  'local_tools_unavailable',
  'local_files_unavailable',
  'local_browser_sessions_unavailable',
  'conversation_overrides_cleared'
] as const

export const AGENT_HOME_PREFLIGHT_BLOCK_REASONS = [
  'unknown_export_class',
  'target_unavailable',
  'connection_unavailable',
  'catalog_stale',
  'not_eligible',
  'cloud_controller_version_unsupported'
] as const

export const AGENT_HOME_OWNER_REFUSAL_REASONS = [
  'another_move_in_progress',
  'stale',
  'not_eligible',
  'preflight_required',
  'preflight_expired',
  'feature_losses_changed',
  'cloud_controller_version_unsupported',
  'catalog_stale',
  'idempotency_conflict',
  'committed_epoch_preserved',
  'surface_mismatch'
] as const

export const AGENT_HOME_MODEL_REFUSAL_REASONS = [
  'stale_home',
  'active_move_changed',
  'stale_choice_revision',
  'catalog_stale',
  'connection_unavailable',
  'model_unavailable',
  'idempotency_conflict',
  'destination_not_current',
  'surface_mismatch'
] as const

export const AGENT_HOME_MOVE_FAILURE_REASONS = [
  'preflight_stale',
  'target_unavailable',
  'source_unreachable',
  'drain_failed',
  'archive_export_failed',
  'archive_conversion_failed',
  'archive_import_failed',
  'integrity_check_failed',
  'placement_conflict',
  'model_unavailable',
  'owner_cancelled',
  'superseded',
  'sleep_budget_elapsed',
  'destination_unreachable'
] as const

export const MAC_CONNECTION_PROVIDER_LABELS = [
  'Atum',
  'ChatGPT',
  'OpenAI API',
  'Anthropic API',
  'Google API',
  'OpenRouter API',
  'Local model'
] as const

export const MODEL_APPLICATION_UNAVAILABLE_REASONS = [
  'sign_in_expired',
  'connection_unavailable',
  'connection_needs_attention',
  'model_unavailable',
  'effort_unavailable',
  'catalog_stale'
] as const

const forbiddenPrivateKey = /secret|token|api_key|authorization|password|credential|account.*id|workload.*key/iu
const safePrivateAssertions = new Set(['workloadKeysExposed', 'credentialMaterialIncluded'])

function sanitizedMessage<T extends z.ZodType>(schema: T) {
  return z
    .unknown()
    .superRefine((input, context) => {
      const walk = (value: unknown, path: (string | number)[]): void => {
        if (Array.isArray(value)) {
          value.forEach((child, index) => walk(child, [...path, index]))
        } else if (value !== null && typeof value === 'object') {
          for (const [key, child] of Object.entries(value)) {
            if (!safePrivateAssertions.has(key) && forbiddenPrivateKey.test(key)) {
              context.addIssue({ code: 'custom', message: 'forbidden_field', path: [...path, key] })
            }
            walk(child, [...path, key])
          }
        }
      }

      walk(input, [])
    })
    .pipe(schema)
}

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const nonnegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u)
const b64uSha256 = z.string().regex(/^[A-Za-z0-9_-]{43}$/u)
const signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/u)
const userId = z.string().min(4).max(1024).regex(/^@[!-9;-~]+:[!-~]+$/u)
const boundedText = (maximum: number) =>
  z.string().refine(value => [...value].length >= 1 && [...value].length <= maximum, 'bounded Unicode text')
const modelRef = boundedText(200).pipe(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u))
const effort = z.enum(['low', 'medium', 'high', 'max'])
const managedEffort = z.enum(['low', 'medium', 'high'])
const connectionRef = z.string().min(21).max(69).regex(/^conn_[A-Za-z0-9_-]{16,64}$/u)
const modelSource = z.union([
  z.literal('atum'),
  z.literal('chatgpt_plan'),
  z.string().min(9).max(80).regex(/^own_key:[a-z0-9][a-z0-9_-]*$/u)
])
const ownerSurface = z.enum(['phone', 'desktop'])

export const HomeLocationV25Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cloud') }).strict(),
  z.object({ kind: z.literal('mac'), deviceServiceId: uuid }).strict()
])
export type HomeLocationV25 = z.infer<typeof HomeLocationV25Schema>

const signedMetaBase = {
  requestId: uuid,
  commandId: uuid,
  signerKeyId: b64uSha256,
  sequence: positiveInteger,
  issuedAt: nonnegativeInteger,
  expiresAt: nonnegativeInteger,
  nonce: b64uSha256,
  signature
}

export const PlatformSignedMetaV25Schema = z
  .object({ ...signedMetaBase, signer: z.literal('platform_controller') })
  .strict()
export const OwnerClientSignedMetaV25Schema = z
  .object({
    ...signedMetaBase,
    signer: z.literal('owner_client'),
    surface: ownerSurface,
    authenticatedChannel: ownerSurface
  })
  .strict()
  .superRefine((value, context) => {
    if (value.surface !== value.authenticatedChannel) {
      context.addIssue({ code: 'custom', message: 'surface_mismatch', path: ['authenticatedChannel'] })
    }
  })
export const AgentHomeOwnerBearerMetaV25Schema = z
  .object({
    requestId: uuid,
    surface: ownerSurface,
    authenticatedChannel: ownerSurface
  })
  .strict()
  .superRefine((value, context) => {
    if (value.surface !== value.authenticatedChannel) {
      context.addIssue({ code: 'custom', message: 'surface_mismatch', path: ['authenticatedChannel'] })
    }
  })
export const AgentHomeOwnerWriteMetaV25Schema = z.union([
  OwnerClientSignedMetaV25Schema,
  AgentHomeOwnerBearerMetaV25Schema
])
export const MacExecutorSignedMetaV25Schema = z
  .object({ ...signedMetaBase, signer: z.literal('mac_executor'), deviceServiceId: uuid })
  .strict()
export const ExecutorSignedMetaV25Schema = z.discriminatedUnion('signer', [
  MacExecutorSignedMetaV25Schema,
  z.object({ ...signedMetaBase, signer: z.literal('cloud_workload'), deviceServiceId: uuid }).strict()
])

export type OwnerClientSignedMetaV25 = z.infer<typeof OwnerClientSignedMetaV25Schema>
export type AgentHomeOwnerWriteMetaV25 = z.infer<typeof AgentHomeOwnerWriteMetaV25Schema>
export type MacExecutorSignedMetaV25 = z.infer<typeof MacExecutorSignedMetaV25Schema>

function checkSignedLifetime(meta: { issuedAt: number; expiresAt: number }, context: z.RefinementCtx): void {
  if (meta.expiresAt <= meta.issuedAt || meta.expiresAt > meta.issuedAt + 7_200_000) {
    context.addIssue({ code: 'custom', message: 'signed_message_window', path: ['meta', 'expiresAt'] })
  }
}

function isOwnerClientSignedMetaV25(meta: AgentHomeOwnerWriteMetaV25): meta is OwnerClientSignedMetaV25 {
  return 'signature' in meta
}

export function sameLocationV25(left: HomeLocationV25, right: HomeLocationV25): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'cloud' || left.deviceServiceId === (right as Extract<HomeLocationV25, { kind: 'mac' }>).deviceServiceId)
  )
}

export function destinationForV25(location: HomeLocationV25): string {
  return location.kind === 'cloud' ? 'cloud' : `mac:${location.deviceServiceId}`
}

function sortedUnique<T extends string>(values: readonly T[]): boolean {
  if (new Set(values).size !== values.length) {return false}
  return values.every((value, index) => index === 0 || values[index - 1]! < value)
}

export const AgentHomeFeatureLossCodeV25Schema = z.enum(AGENT_HOME_FEATURE_LOSS_CODES)
const FeatureLossSetSchema = z
  .array(AgentHomeFeatureLossCodeV25Schema)
  .max(AGENT_HOME_FEATURE_LOSS_CODES.length)
  .refine(sortedUnique, 'sorted_unique_feature_losses')
const CheckpointLossDisclosureSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_required') }).strict(),
  z
    .object({
      state: z.literal('disclosed'),
      lossCode: z.literal('changes_since_last_checkpoint_lost'),
      lastCheckpointAtPlatform: nonnegativeInteger
    })
    .strict()
])

export const PlacementModelChoiceV25Schema = z
  .union([
    z
      .object({
        destination: z.literal('cloud'),
        source: z.literal('atum'),
        connectionRef: z.literal(ATUM_MANAGED_CONNECTION_REF),
        model: modelRef,
        effort: managedEffort
      })
      .strict(),
    z
      .object({
        destination: z.string().length(40).regex(/^mac:[0-9a-f-]{36}$/u),
        deviceServiceId: uuid,
        source: z.literal('atum'),
        connectionRef,
        model: modelRef,
        effort: managedEffort
      })
      .strict(),
    z
      .object({
        destination: z.string().length(40).regex(/^mac:[0-9a-f-]{36}$/u),
        deviceServiceId: uuid,
        source: z.literal('chatgpt_plan'),
        connectionRef,
        model: modelRef,
        effort
      })
      .strict(),
    z
      .object({
        destination: z.string().length(40).regex(/^mac:[0-9a-f-]{36}$/u),
        deviceServiceId: uuid,
        source: z.string().min(9).max(80).regex(/^own_key:[a-z0-9][a-z0-9_-]*$/u),
        connectionRef,
        model: modelRef,
        effort
      })
      .strict()
  ])
  .superRefine((value, context) => {
    if ('deviceServiceId' in value && value.destination !== `mac:${value.deviceServiceId}`) {
      context.addIssue({ code: 'custom', message: 'choice_destination_device_mismatch', path: ['destination'] })
    }
  })
export type PlacementModelChoiceV25 = z.infer<typeof PlacementModelChoiceV25Schema>

const OwnerActiveMoveSchema = z
  .object({
    moveId: uuid,
    status: z.enum(['requested', 'draining', 'ready_to_commit']),
    source: HomeLocationV25Schema,
    target: HomeLocationV25Schema
  })
  .strict()
const OwnerPlacementSchema = z
  .object({
    ownerUserId: userId,
    agentPrincipal: uuid,
    homeId: uuid,
    location: HomeLocationV25Schema,
    homeEpoch: positiveInteger,
    activeMove: OwnerActiveMoveSchema.nullable()
  })
  .strict()
export const AgentHomeOwnerReachabilityV25Schema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('reachable'), lastSeenAtPlatform: nonnegativeInteger }).strict(),
  z.object({ state: z.literal('asleep'), lastSeenAtPlatform: nonnegativeInteger }).strict(),
  z.object({ state: z.literal('offline'), lastSeenAtPlatform: nonnegativeInteger.nullable() }).strict()
])
export const AgentHomeEligibleNamedDeviceV25Schema = z.discriminatedUnion('eligibility', [
  z.object({ deviceServiceId: uuid, displayName: boundedText(120), eligibility: z.literal('ready') }).strict(),
  z
    .object({
      deviceServiceId: uuid,
      displayName: boundedText(120),
      eligibility: z.literal('unavailable'),
      reason: z.enum(['offline', 'not_enrolled', 'version_unsupported', 'home_conflict', 'catalog_unavailable'])
    })
    .strict()
])
const MoveCapabilitySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('available'), profile: AgentHomePlacementConnectionProfileV25Schema }).strict(),
  z.object({ state: z.literal('unavailable'), reason: z.enum(['client_update_required', 'platform_not_ready']) }).strict()
])

export const AgentHomeOwnerPlacementSnapshotV25Schema = sanitizedMessage(
  z
    .object({
      meta: PlatformSignedMetaV25Schema,
      profile: AgentHomePlacementConnectionProfileV25Schema,
      ownerUserId: userId,
      agentPrincipal: uuid,
      placement: OwnerPlacementSchema,
      currentHomeReachability: AgentHomeOwnerReachabilityV25Schema,
      eligibleDevices: z.array(AgentHomeEligibleNamedDeviceV25Schema).max(64),
      moveCapability: MoveCapabilitySchema,
      observedAtPlatform: nonnegativeInteger
    })
    .strict()
    .superRefine((value, context) => {
      checkSignedLifetime(value.meta, context)
      if (value.ownerUserId !== value.placement.ownerUserId) {
        context.addIssue({ code: 'custom', message: 'owner_binding_mismatch', path: ['placement', 'ownerUserId'] })
      }
      if (value.agentPrincipal !== value.placement.agentPrincipal) {
        context.addIssue({ code: 'custom', message: 'agent_binding_mismatch', path: ['placement', 'agentPrincipal'] })
      }
      const devices = value.eligibleDevices.map(device => device.deviceServiceId)
      if (new Set(devices).size !== devices.length) {
        context.addIssue({ code: 'custom', message: 'duplicate_device', path: ['eligibleDevices'] })
      }
    })
)
export type AgentHomeOwnerPlacementSnapshotV25 = z.infer<typeof AgentHomeOwnerPlacementSnapshotV25Schema>

export const AgentHomeOwnerPreflightRequestV25Schema = sanitizedMessage(
  z
    .object({
      meta: AgentHomeOwnerWriteMetaV25Schema,
      idempotencyKey: uuid,
      agentPrincipal: uuid,
      target: HomeLocationV25Schema,
      chosenModel: PlacementModelChoiceV25Schema,
      catalogRevision: nonnegativeInteger,
      expectedHomeEpoch: positiveInteger,
      expectedActiveMoveId: uuid.nullable()
    })
    .strict()
    .superRefine((value, context) => {
      if (isOwnerClientSignedMetaV25(value.meta)) {checkSignedLifetime(value.meta, context)}
      if (value.chosenModel.destination !== destinationForV25(value.target)) {
        context.addIssue({ code: 'custom', message: 'model_target_mismatch', path: ['chosenModel', 'destination'] })
      }
      if (value.target.kind === 'cloud' && value.catalogRevision !== 0) {
        context.addIssue({ code: 'custom', message: 'cloud_catalog_revision_zero', path: ['catalogRevision'] })
      }
    })
)
export type AgentHomeOwnerPreflightRequestV25 = z.infer<typeof AgentHomeOwnerPreflightRequestV25Schema>

const PreflightCommonSchema = z
  .object({
    meta: PlatformSignedMetaV25Schema,
    requestId: uuid,
    preflightId: uuid,
    preflightRevision: positiveInteger,
    ownerUserId: userId,
    agentPrincipal: uuid,
    source: HomeLocationV25Schema,
    target: HomeLocationV25Schema,
    chosenModel: PlacementModelChoiceV25Schema,
    catalogRevision: nonnegativeInteger,
    expectedHomeEpoch: positiveInteger,
    expectedActiveMoveId: uuid.nullable(),
    featureInventoryRevision: positiveInteger,
    evaluatedAtPlatform: nonnegativeInteger,
    expiresAtPlatform: nonnegativeInteger,
    sourceReachability: AgentHomeOwnerReachabilityV25Schema,
    lastCheckpointAtPlatform: nonnegativeInteger.nullable(),
    checkpointLoss: CheckpointLossDisclosureSchema,
    conversationOverrideCount: nonnegativeInteger,
    featureLosses: FeatureLossSetSchema
  })
  .strict()
  .superRefine((value, context) => {
    checkSignedLifetime(value.meta, context)
    if (sameLocationV25(value.source, value.target)) {
      context.addIssue({ code: 'custom', message: 'move_target_matches_source', path: ['target'] })
    }
    if (value.expiresAtPlatform <= value.evaluatedAtPlatform) {
      context.addIssue({ code: 'custom', message: 'preflight_expiry', path: ['expiresAtPlatform'] })
    }
    if (value.chosenModel.destination !== destinationForV25(value.target)) {
      context.addIssue({ code: 'custom', message: 'model_target_mismatch', path: ['chosenModel', 'destination'] })
    }
    if (value.target.kind === 'cloud' && value.catalogRevision !== 0) {
      context.addIssue({ code: 'custom', message: 'cloud_catalog_revision_zero', path: ['catalogRevision'] })
    }
    const losses = new Set(value.featureLosses)
    if (value.source.kind === 'mac' && value.sourceReachability.state !== 'reachable') {
      if (
        !losses.has('changes_since_last_checkpoint_lost') ||
        value.lastCheckpointAtPlatform === null ||
        value.checkpointLoss.state !== 'disclosed' ||
        value.checkpointLoss.lastCheckpointAtPlatform !== value.lastCheckpointAtPlatform
      ) {
        context.addIssue({ code: 'custom', message: 'unreachable_checkpoint_loss_disclosure', path: ['featureLosses'] })
      }
    }
    if (value.target.kind === 'cloud') {
      for (const loss of [
        'model_source_changes_to_atum',
        'local_tools_unavailable',
        'local_files_unavailable',
        'local_browser_sessions_unavailable'
      ] as const) {
        if (!losses.has(loss)) {
          context.addIssue({ code: 'custom', message: 'mac_to_cloud_disclosure', path: ['featureLosses'] })
        }
      }
    }
    if ((value.conversationOverrideCount > 0) !== losses.has('conversation_overrides_cleared')) {
      context.addIssue({ code: 'custom', message: 'conversation_override_disclosure', path: ['featureLosses'] })
    }
  })

export const AgentHomeOwnerMovePreflightV25Schema = sanitizedMessage(
  z.discriminatedUnion('outcome', [
    z.object({ common: PreflightCommonSchema, outcome: z.literal('ready'), reason: z.null() }).strict(),
    z
      .object({
        common: PreflightCommonSchema,
        outcome: z.literal('blocked'),
        reason: z.enum(AGENT_HOME_PREFLIGHT_BLOCK_REASONS)
      })
      .strict()
  ])
)
export type AgentHomeOwnerMovePreflightV25 = z.infer<typeof AgentHomeOwnerMovePreflightV25Schema>

const AcceptedPreflightSchema = z
  .object({
    preflightId: uuid,
    preflightRevision: positiveInteger,
    expiresAtPlatform: nonnegativeInteger,
    featureInventoryRevision: positiveInteger,
    catalogRevision: nonnegativeInteger,
    chosenModel: PlacementModelChoiceV25Schema,
    featureLosses: FeatureLossSetSchema,
    lastCheckpointAtPlatform: nonnegativeInteger.nullable(),
    conversationOverrideCount: nonnegativeInteger,
    checkpointLoss: CheckpointLossDisclosureSchema
  })
  .strict()

export const AgentHomeOwnerMoveRequestV25Schema = sanitizedMessage(
  z
    .object({
      meta: AgentHomeOwnerWriteMetaV25Schema,
      moveId: uuid,
      idempotencyKey: uuid,
      agentPrincipal: uuid,
      target: HomeLocationV25Schema,
      expectedHomeEpoch: positiveInteger,
      expectedActiveMoveId: uuid.nullable(),
      acceptedPreflight: AcceptedPreflightSchema,
      acceptCheckpointLoss: z.boolean()
    })
    .strict()
    .superRefine((value, context) => {
      if (isOwnerClientSignedMetaV25(value.meta)) {checkSignedLifetime(value.meta, context)}
      if (value.acceptedPreflight.chosenModel.destination !== destinationForV25(value.target)) {
        context.addIssue({ code: 'custom', message: 'model_target_mismatch', path: ['acceptedPreflight', 'chosenModel'] })
      }
      if (value.target.kind === 'cloud' && value.acceptedPreflight.catalogRevision !== 0) {
        context.addIssue({ code: 'custom', message: 'cloud_catalog_revision_zero', path: ['acceptedPreflight', 'catalogRevision'] })
      }
      const hasLoss = value.acceptedPreflight.featureLosses.includes('changes_since_last_checkpoint_lost')
      if (
        value.acceptCheckpointLoss &&
        (!hasLoss ||
          value.acceptedPreflight.lastCheckpointAtPlatform === null ||
          value.acceptedPreflight.checkpointLoss.state !== 'disclosed' ||
          value.acceptedPreflight.checkpointLoss.lastCheckpointAtPlatform !==
            value.acceptedPreflight.lastCheckpointAtPlatform)
      ) {
        context.addIssue({ code: 'custom', message: 'checkpoint_loss_acceptance_unbound', path: ['acceptCheckpointLoss'] })
      }
    })
)
export type AgentHomeOwnerMoveRequestV25 = z.infer<typeof AgentHomeOwnerMoveRequestV25Schema>

export const AgentHomeOwnerMoveCancelV25Schema = sanitizedMessage(
  z
    .object({
      meta: AgentHomeOwnerWriteMetaV25Schema,
      cancelId: uuid,
      idempotencyKey: uuid,
      agentPrincipal: uuid,
      moveId: uuid,
      expectedHomeEpoch: positiveInteger,
      expectedActiveMoveId: uuid
    })
    .strict()
    .superRefine((value, context) => {
      if (isOwnerClientSignedMetaV25(value.meta)) {checkSignedLifetime(value.meta, context)}
      if (value.expectedActiveMoveId !== value.moveId) {
        context.addIssue({ code: 'custom', message: 'cancel_active_move_mismatch', path: ['expectedActiveMoveId'] })
      }
    })
)
export type AgentHomeOwnerMoveCancelV25 = z.infer<typeof AgentHomeOwnerMoveCancelV25Schema>

export const AgentHomeOwnerMoveRefusalV25Schema = sanitizedMessage(
  z
    .object({
      meta: PlatformSignedMetaV25Schema,
      operation: z.enum(['request', 'cancel']),
      requestId: uuid,
      moveId: uuid.nullable(),
      outcome: z.literal('refused'),
      reason: z.enum(AGENT_HOME_OWNER_REFUSAL_REASONS),
      currentHomeEpoch: positiveInteger,
      currentActiveMoveId: uuid.nullable()
    })
    .strict()
)

export const AgentHomeOwnerModelChoiceWriteV25Schema = sanitizedMessage(
  z
    .object({
      meta: AgentHomeOwnerWriteMetaV25Schema,
      idempotencyKey: uuid,
      agentPrincipal: uuid,
      currentHome: HomeLocationV25Schema,
      expectedHomeId: uuid,
      expectedHomeEpoch: positiveInteger,
      expectedActiveMoveId: uuid.nullable(),
      expectedChoiceRevision: nonnegativeInteger,
      choice: PlacementModelChoiceV25Schema
    })
    .strict()
    .superRefine((value, context) => {
      if (isOwnerClientSignedMetaV25(value.meta)) {checkSignedLifetime(value.meta, context)}
      if (value.choice.destination !== destinationForV25(value.currentHome)) {
        context.addIssue({ code: 'custom', message: 'model_choice_not_current_home', path: ['choice', 'destination'] })
      }
    })
)
export type AgentHomeOwnerModelChoiceWriteV25 = z.infer<typeof AgentHomeOwnerModelChoiceWriteV25Schema>

export const AgentHomeOwnerModelChoiceReceiptV25Schema = sanitizedMessage(
  z
    .object({
      meta: PlatformSignedMetaV25Schema,
      requestId: uuid,
      idempotencyKey: uuid,
      choiceRevision: positiveInteger,
      choice: PlacementModelChoiceV25Schema,
      outcome: z.enum(['applied', 'replay']),
      applicationBoundary: z.literal('next_turn_boundary')
    })
    .strict()
)
export type AgentHomeOwnerModelChoiceReceiptV25 = z.infer<typeof AgentHomeOwnerModelChoiceReceiptV25Schema>

export const AgentHomeOwnerModelChoiceRefusalV25Schema = sanitizedMessage(
  z
    .object({
      meta: PlatformSignedMetaV25Schema,
      requestId: uuid,
      idempotencyKey: uuid,
      outcome: z.literal('refused'),
      reason: z.enum(AGENT_HOME_MODEL_REFUSAL_REASONS),
      currentHome: HomeLocationV25Schema,
      currentHomeEpoch: positiveInteger,
      currentActiveMoveId: uuid.nullable(),
      currentChoiceRevision: nonnegativeInteger
    })
    .strict()
)

const progressBase = {
  profile: AgentHomePlacementConnectionProfileV25Schema,
  ownerUserId: userId,
  agentPrincipal: uuid,
  moveId: uuid,
  sequence: positiveInteger,
  source: HomeLocationV25Schema,
  target: HomeLocationV25Schema,
  updatedAtPlatform: nonnegativeInteger
}

export const AgentHomeOwnerMoveProgressV25Schema = sanitizedMessage(
  z
    .discriminatedUnion('state', [
      z
        .object({
          ...progressBase,
          state: z.literal('finishing_current_work'),
          baseMoveStatus: z.enum(['requested', 'draining']),
          reason: z.null(),
          authoritativeHome: HomeLocationV25Schema
        })
        .strict(),
      z
        .object({
          ...progressBase,
          state: z.literal('moving'),
          baseMoveStatus: z.literal('ready_to_commit'),
          reason: z.null(),
          authoritativeHome: HomeLocationV25Schema
        })
        .strict(),
      z
        .object({
          ...progressBase,
          state: z.literal('waiting_for_destination'),
          baseMoveStatus: z.literal('committed'),
          reason: z.literal('destination_not_serving'),
          authoritativeHome: HomeLocationV25Schema
        })
        .strict(),
      z
        .object({
          ...progressBase,
          state: z.literal('reconciling'),
          baseMoveStatus: z.enum(['requested', 'draining', 'ready_to_commit', 'committed']),
          reason: z.literal('effect_unknown'),
          authoritativeHome: HomeLocationV25Schema
        })
        .strict(),
      z
        .object({
          ...progressBase,
          state: z.literal('ready'),
          baseMoveStatus: z.literal('committed'),
          reason: z.null(),
          authoritativeHome: HomeLocationV25Schema,
          servingSigner: z.enum(['cloud_workload', 'mac_executor']),
          modelApplication: z.enum(['not_selected', 'pending_next_turn', 'applied', 'unavailable']),
          conversationOverridesCleared: z.boolean()
        })
        .strict(),
      z
        .object({
          ...progressBase,
          state: z.literal('failed'),
          baseMoveStatus: z.enum(['aborted', 'superseded', 'committed']),
          reason: z.enum(AGENT_HOME_MOVE_FAILURE_REASONS),
          currentAuthoritativeHome: HomeLocationV25Schema,
          oldHomeResumed: z.boolean()
        })
        .strict()
    ])
    .superRefine((value, context) => {
      if (sameLocationV25(value.source, value.target)) {
        context.addIssue({ code: 'custom', message: 'progress_source_matches_target', path: ['target'] })
      }
      if (
        (value.state === 'finishing_current_work' || value.state === 'moving') &&
        !sameLocationV25(value.authoritativeHome, value.source)
      ) {
        context.addIssue({ code: 'custom', message: 'precommit_authority_must_be_source', path: ['authoritativeHome'] })
      }
      if (
        value.state === 'waiting_for_destination' &&
        !sameLocationV25(value.authoritativeHome, value.target)
      ) {
        context.addIssue({ code: 'custom', message: 'postcommit_authority_must_be_target', path: ['authoritativeHome'] })
      }
      if (value.state === 'reconciling') {
        const expected = value.baseMoveStatus === 'committed' ? value.target : value.source
        if (!sameLocationV25(value.authoritativeHome, expected)) {
          context.addIssue({ code: 'custom', message: 'reconciling_authority_mismatch', path: ['authoritativeHome'] })
        }
      }
      if (value.state === 'ready') {
        if (!sameLocationV25(value.authoritativeHome, value.target)) {
          context.addIssue({ code: 'custom', message: 'ready_target_not_authoritative', path: ['authoritativeHome'] })
        }
        if (value.target.kind === 'cloud' && value.servingSigner !== 'cloud_workload') {
          context.addIssue({ code: 'custom', message: 'cloud_ready_requires_cloud_signer', path: ['servingSigner'] })
        }
        if (value.target.kind === 'mac' && value.servingSigner !== 'mac_executor') {
          context.addIssue({ code: 'custom', message: 'mac_ready_requires_mac_signer', path: ['servingSigner'] })
        }
      }
      if (value.state === 'failed') {
        const precommit = new Set([
          'preflight_stale',
          'target_unavailable',
          'source_unreachable',
          'drain_failed',
          'archive_export_failed',
          'archive_conversion_failed',
          'archive_import_failed',
          'integrity_check_failed',
          'placement_conflict',
          'model_unavailable',
          'owner_cancelled',
          'sleep_budget_elapsed'
        ])
        const coherent =
          value.reason === 'superseded'
            ? value.baseMoveStatus === 'superseded'
            : value.reason === 'destination_unreachable'
              ? value.baseMoveStatus === 'committed'
              : precommit.has(value.reason) && value.baseMoveStatus === 'aborted'
        if (!coherent) {
          context.addIssue({ code: 'custom', message: 'failed_reason_base_status_mismatch', path: ['baseMoveStatus'] })
        }
        const source = sameLocationV25(value.currentAuthoritativeHome, value.source)
        const target = sameLocationV25(value.currentAuthoritativeHome, value.target)
        if (value.oldHomeResumed !== source || (!value.oldHomeResumed && !target)) {
          context.addIssue({ code: 'custom', message: 'failed_authority_resume_mismatch', path: ['currentAuthoritativeHome'] })
        }
      }
    })
)
export type AgentHomeOwnerMoveProgressV25 = z.infer<typeof AgentHomeOwnerMoveProgressV25Schema>

export const AgentHomePortablePlacementLineageV25Schema = z
  .object({
    ownerUserId: userId,
    agentPrincipal: uuid,
    homeId: uuid,
    source: HomeLocationV25Schema,
    homeEpoch: positiveInteger,
    placementRevision: positiveInteger,
    generation: positiveInteger,
    parentGeneration: positiveInteger,
    manifestSha256: sha256
  })
  .strict()
  .superRefine((value, context) => {
    if (value.parentGeneration >= value.generation) {
      context.addIssue({ code: 'custom', message: 'generation_parent_must_precede', path: ['parentGeneration'] })
    }
  })

export const AgentHomePortableArchiveImportV25Schema = sanitizedMessage(
  z
    .object({
      meta: PlatformSignedMetaV25Schema,
      moveId: uuid,
      lineage: AgentHomePortablePlacementLineageV25Schema,
      target: HomeLocationV25Schema,
      importAdapter: z.literal('portable_home_import_v1'),
      portableArchiveSha256: sha256,
      portableManifestSha256: sha256,
      outputSealing: z.enum(['owner_agent_home', 'cloud_home_store_controller_workload']),
      credentialMaterialIncluded: z.literal(false)
    })
    .strict()
    .superRefine((value, context) => {
      checkSignedLifetime(value.meta, context)
      if (value.lineage.manifestSha256 !== value.portableManifestSha256) {
        context.addIssue({ code: 'custom', message: 'portable_manifest_lineage_mismatch', path: ['portableManifestSha256'] })
      }
      if (sameLocationV25(value.lineage.source, value.target)) {
        context.addIssue({ code: 'custom', message: 'archive_import_target_matches_source', path: ['target'] })
      }
      const expected = value.target.kind === 'cloud' ? 'cloud_home_store_controller_workload' : 'owner_agent_home'
      if (value.outputSealing !== expected) {
        context.addIssue({ code: 'custom', message: 'import_output_sealing', path: ['outputSealing'] })
      }
    })
)
export type AgentHomePortableArchiveImportV25 = z.infer<typeof AgentHomePortableArchiveImportV25Schema>

export const AgentHomeArchiveImportReceiptV25Schema = sanitizedMessage(
  z
    .object({
      meta: ExecutorSignedMetaV25Schema,
      moveId: uuid,
      target: HomeLocationV25Schema,
      lineage: AgentHomePortablePlacementLineageV25Schema,
      portableArchiveSha256: sha256,
      portableManifestSha256: sha256,
      outcome: z.enum(['imported', 'replay', 'refused']),
      reason: z.enum(['stale_home', 'active_move_changed', 'integrity_check_failed', 'idempotency_conflict']).nullable()
    })
    .strict()
    .superRefine((value, context) => {
      if (value.target.kind === 'cloud' && value.meta.signer !== 'cloud_workload') {
        context.addIssue({ code: 'custom', message: 'cloud_import_receipt_signer', path: ['meta', 'signer'] })
      }
      if (
        value.target.kind === 'mac' &&
        (value.meta.signer !== 'mac_executor' || value.meta.deviceServiceId !== value.target.deviceServiceId)
      ) {
        context.addIssue({ code: 'custom', message: 'mac_import_receipt_signer', path: ['meta'] })
      }
    })
)
export type AgentHomeArchiveImportReceiptV25 = z.infer<typeof AgentHomeArchiveImportReceiptV25Schema>

export const SanitizedMacModelV25Schema = z
  .object({
    model: modelRef,
    modelLabel: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9 ._+/-]{0,119}$/u),
    efforts: z.array(effort).min(1).max(4),
    defaultEffort: effort
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.efforts).size !== value.efforts.length) {
      context.addIssue({ code: 'custom', message: 'duplicate_effort', path: ['efforts'] })
    }
    if (!value.efforts.includes(value.defaultEffort)) {
      context.addIssue({ code: 'custom', message: 'default_effort_not_offered', path: ['defaultEffort'] })
    }
  })
export type SanitizedMacModelV25 = z.infer<typeof SanitizedMacModelV25Schema>

export const SanitizedMacConnectionV25Schema = z
  .object({
    connectionRef,
    source: modelSource,
    providerLabel: z.enum(MAC_CONNECTION_PROVIDER_LABELS),
    state: z.enum(['available', 'needs_attention']),
    models: z.array(SanitizedMacModelV25Schema).min(1).max(256)
  })
  .strict()
  .superRefine((value, context) => {
    const models = value.models.map(model => model.model)
    if (new Set(models).size !== models.length) {
      context.addIssue({ code: 'custom', message: 'duplicate_model', path: ['models'] })
    }
  })
export type SanitizedMacConnectionV25 = z.infer<typeof SanitizedMacConnectionV25Schema>

const connections = z
  .array(SanitizedMacConnectionV25Schema)
  .max(64)
  .superRefine((value, context) => {
    const refs = value.map(connection => connection.connectionRef)
    if (new Set(refs).size !== refs.length) {
      context.addIssue({ code: 'custom', message: 'duplicate_connection', path: [] })
    }
  })

export const MacConnectionCatalogIngestV25Schema = sanitizedMessage(
  z
    .object({
      meta: MacExecutorSignedMetaV25Schema,
      publishId: uuid,
      idempotencyKey: uuid,
      deviceServiceId: uuid,
      ownerUserId: userId,
      agentPrincipal: uuid,
      homeId: uuid,
      homeEpoch: positiveInteger,
      activeMoveId: uuid.nullable(),
      clientCatalogRevision: positiveInteger,
      contentSha256: sha256,
      generatedAtPlatformEstimate: nonnegativeInteger,
      freshUntilPlatform: nonnegativeInteger,
      connections
    })
    .strict()
    .superRefine((value, context) => {
      checkSignedLifetime(value.meta, context)
      if (value.meta.deviceServiceId !== value.deviceServiceId) {
        context.addIssue({ code: 'custom', message: 'catalog_device_mismatch', path: ['deviceServiceId'] })
      }
      if (value.freshUntilPlatform <= value.generatedAtPlatformEstimate) {
        context.addIssue({ code: 'custom', message: 'catalog_freshness_window', path: ['freshUntilPlatform'] })
      }
    })
)
export type MacConnectionCatalogIngestV25 = z.infer<typeof MacConnectionCatalogIngestV25Schema>

export const MacConnectionCatalogReceiptV25Schema = sanitizedMessage(
  z
    .object({
      meta: PlatformSignedMetaV25Schema,
      publishId: uuid,
      deviceServiceId: uuid,
      previousCatalogRevision: positiveInteger,
      catalogRevision: positiveInteger,
      contentSha256: sha256,
      contentChanged: z.boolean(),
      receivedAtPlatform: nonnegativeInteger,
      effectiveGeneratedAtPlatform: nonnegativeInteger,
      effectiveFreshUntilPlatform: nonnegativeInteger,
      outcome: z.enum(['accepted', 'replay', 'refused']),
      reason: z.enum(['stale_home', 'active_move_changed', 'stale_catalog_revision', 'idempotency_conflict']).nullable()
    })
    .strict()
    .superRefine((value, context) => {
      if (value.catalogRevision !== value.previousCatalogRevision + (value.contentChanged ? 1 : 0)) {
        context.addIssue({ code: 'custom', message: 'catalog_content_revision_mismatch', path: ['catalogRevision'] })
      }
      if (Math.abs(value.effectiveGeneratedAtPlatform - value.receivedAtPlatform) > MAC_CATALOG_CLOCK_SKEW_MS) {
        context.addIssue({ code: 'custom', message: 'catalog_generated_time_not_clamped', path: ['effectiveGeneratedAtPlatform'] })
      }
      if (value.effectiveFreshUntilPlatform > value.receivedAtPlatform + MAC_CATALOG_FRESHNESS_MAX_MS) {
        context.addIssue({ code: 'custom', message: 'catalog_freshness_not_clamped', path: ['effectiveFreshUntilPlatform'] })
      }
    })
)
export type MacConnectionCatalogReceiptV25 = z.infer<typeof MacConnectionCatalogReceiptV25Schema>

const catalogBase = {
  profile: AgentHomePlacementConnectionProfileV25Schema,
  ownerUserId: userId,
  agentPrincipal: uuid,
  deviceServiceId: uuid,
  homeId: uuid,
  homeEpoch: positiveInteger,
  catalogRevision: positiveInteger,
  receivedAtPlatform: nonnegativeInteger,
  freshUntilPlatform: nonnegativeInteger
}

export const MacConnectionCatalogV25Schema = sanitizedMessage(
  z
    .discriminatedUnion('freshness', [
      z.object({ ...catalogBase, freshness: z.literal('fresh'), connections: connections.min(1) }).strict(),
      z.object({ ...catalogBase, freshness: z.literal('stale'), connections }).strict(),
      z
        .object({
          ...catalogBase,
          freshness: z.literal('unavailable'),
          connections: z.tuple([]),
          reason: z.enum(['home_offline', 'catalog_unreachable', 'catalog_not_published'])
        })
        .strict()
    ])
    .superRefine((value, context) => {
      if (value.freshness === 'fresh' && value.freshUntilPlatform <= value.receivedAtPlatform) {
        context.addIssue({ code: 'custom', message: 'fresh_catalog_expired', path: ['freshUntilPlatform'] })
      }
    })
)
export type MacConnectionCatalogV25 = z.infer<typeof MacConnectionCatalogV25Schema>

const projectionBase = {
  profile: AgentHomePlacementConnectionProfileV25Schema,
  ownerUserId: userId,
  agentPrincipal: uuid,
  deviceServiceId: uuid,
  homeId: uuid,
  homeEpoch: positiveInteger,
  activeMoveId: uuid.nullable(),
  placementRevision: positiveInteger,
  choiceRevision: nonnegativeInteger,
  catalogRevision: positiveInteger,
  choice: PlacementModelChoiceV25Schema,
  applicationBoundary: z.literal('next_turn_boundary'),
  preferencePersistence: z.literal('persisted')
}

export const ModelApplicationProjectionV25Schema = sanitizedMessage(
  z
    .discriminatedUnion('status', [
      z
        .object({
          ...projectionBase,
          status: z.literal('pending'),
          reason: z.enum(['waiting_for_home', 'turn_in_progress', 'catalog_refresh_required']),
          turnDisposition: z.literal('held'),
          billingSourceChange: z.literal('forbidden'),
          appliedAtPlatform: z.null(),
          appliedTurnSequence: z.null()
        })
        .strict(),
      z
        .object({
          ...projectionBase,
          activeMoveId: z.null(),
          status: z.literal('applied'),
          reason: z.null(),
          turnDisposition: z.literal('ready'),
          billingSourceChange: z.literal('none'),
          appliedAtPlatform: nonnegativeInteger,
          appliedTurnSequence: positiveInteger
        })
        .strict(),
      z
        .object({
          ...projectionBase,
          status: z.literal('unavailable'),
          reason: z.enum(MODEL_APPLICATION_UNAVAILABLE_REASONS),
          turnDisposition: z.literal('held'),
          billingSourceChange: z.literal('forbidden'),
          appliedAtPlatform: z.null(),
          appliedTurnSequence: z.null()
        })
        .strict()
    ])
    .superRefine((value, context) => {
      if (value.choice.destination !== `mac:${value.deviceServiceId}`) {
        context.addIssue({ code: 'custom', message: 'choice_destination_device_mismatch', path: ['choice', 'destination'] })
      }
    })
)
export type ModelApplicationProjectionV25 = z.infer<typeof ModelApplicationProjectionV25Schema>

const MacReportedApplicationStatusV25Schema = z.union([
  z
    .object({ status: z.literal('applied'), appliedAtPlatform: nonnegativeInteger, appliedTurnSequence: positiveInteger })
    .strict(),
  z.object({ status: z.literal('unavailable'), reason: z.enum(MODEL_APPLICATION_UNAVAILABLE_REASONS) }).strict()
])

export const HomeLeaseFenceV25Schema = z
  .object({
    ownerUserId: userId,
    agentPrincipal: uuid,
    homeId: uuid,
    homeEpoch: positiveInteger,
    executorTerm: positiveInteger,
    leaseId: uuid,
    leaseExpiresAtPlatform: nonnegativeInteger
  })
  .strict()

export const HomeModelApplicationReportV25Schema = sanitizedMessage(
  z
    .object({
      meta: MacExecutorSignedMetaV25Schema,
      applicationId: uuid,
      idempotencyKey: uuid,
      fence: HomeLeaseFenceV25Schema,
      expectedHomeId: uuid,
      expectedHomeEpoch: positiveInteger,
      expectedActiveMoveId: uuid.nullable(),
      choiceRevision: nonnegativeInteger,
      catalogRevision: positiveInteger,
      storedChoice: PlacementModelChoiceV25Schema,
      reportedStatus: MacReportedApplicationStatusV25Schema
    })
    .strict()
    .superRefine((value, context) => {
      checkSignedLifetime(value.meta, context)
      if (value.fence.homeId !== value.expectedHomeId) {
        context.addIssue({ code: 'custom', message: 'application_home_mismatch', path: ['expectedHomeId'] })
      }
      if (value.fence.homeEpoch !== value.expectedHomeEpoch) {
        context.addIssue({ code: 'custom', message: 'application_epoch_mismatch', path: ['expectedHomeEpoch'] })
      }
      if (value.storedChoice.destination !== `mac:${value.meta.deviceServiceId}`) {
        context.addIssue({ code: 'custom', message: 'application_device_mismatch', path: ['storedChoice', 'destination'] })
      }
    })
)
export type HomeModelApplicationReportV25 = z.infer<typeof HomeModelApplicationReportV25Schema>

export const S3_V25_MESSAGE_SCHEMAS = {
  'owner.home.snapshot': AgentHomeOwnerPlacementSnapshotV25Schema,
  'owner.home.move.preflight-request': AgentHomeOwnerPreflightRequestV25Schema,
  'owner.home.move.preflight': AgentHomeOwnerMovePreflightV25Schema,
  'owner.home.move.request': AgentHomeOwnerMoveRequestV25Schema,
  'owner.home.move.cancel': AgentHomeOwnerMoveCancelV25Schema,
  'owner.home.move.refusal': AgentHomeOwnerMoveRefusalV25Schema,
  'owner.home.move.progress': AgentHomeOwnerMoveProgressV25Schema,
  'owner.home.model-choice.write': AgentHomeOwnerModelChoiceWriteV25Schema,
  'owner.home.model-choice.receipt': AgentHomeOwnerModelChoiceReceiptV25Schema,
  'owner.home.model-choice.refusal': AgentHomeOwnerModelChoiceRefusalV25Schema,
  'home.connection-catalog.ingest': MacConnectionCatalogIngestV25Schema,
  'home.connection-catalog.receipt': MacConnectionCatalogReceiptV25Schema,
  'home.connection-catalog': MacConnectionCatalogV25Schema,
  'home.archive.import': AgentHomePortableArchiveImportV25Schema,
  'home.archive.import-receipt': AgentHomeArchiveImportReceiptV25Schema,
  'home.model-choice.projection': ModelApplicationProjectionV25Schema,
  'home.model-choice.application': HomeModelApplicationReportV25Schema
} as const

/** `device-service/3` framing: domain + message + NUL + canonical unsigned body. */
export function placementConnectionSignedBytes(
  message: string,
  value: Record<string, unknown>
): Uint8Array {
  if (value.meta && typeof value.meta === 'object' && !Array.isArray(value.meta)) {
    const { signature: _signature, ...meta } = value.meta as Record<string, unknown>
    return Buffer.from(`atum.device-service.v3\0${message}\0${canonicalJson({ ...value, meta })}`, 'utf8')
  }

  if (value.common && typeof value.common === 'object' && !Array.isArray(value.common)) {
    const common = value.common as Record<string, unknown>
    if (common.meta && typeof common.meta === 'object' && !Array.isArray(common.meta)) {
      const { signature: _signature, ...meta } = common.meta as Record<string, unknown>
      return Buffer.from(
        `atum.device-service.v3\0${message}\0${canonicalJson({ ...value, common: { ...common, meta } })}`,
        'utf8'
      )
    }
  }

  throw new Error('signed_meta_missing')
}

/** Content-only catalog digest. Home/move binding and publication ids are deliberately excluded. */
export function macConnectionCatalogContentSha256(connectionsValue: readonly SanitizedMacConnectionV25[]): string {
  return createHash('sha256').update(canonicalJson(connectionsValue), 'utf8').digest('hex')
}

export function isMacCatalogFreshAtV25(catalog: MacConnectionCatalogV25, nowPlatform: number): boolean {
  return catalog.freshness === 'fresh' && nowPlatform < catalog.freshUntilPlatform
}
