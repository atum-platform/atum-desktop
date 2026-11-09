import { z } from 'zod'

import {
  isCompanyPrivateCosClaim,
  isCompanyPrivateCosRoom,
  MATRIX_COMPANY_PRIVATE_COS_CLASSIFICATION,
  MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE,
  MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT,
  matrixCompanyPrivateCosPowerLevels,
  matrixCompanyPrivateCosRoomBinding
} from './matrix-company-private-cos-claim'
import type { MatrixCompanyPrivateCosPowerLevels, MatrixCompanyPrivateCosRoomBinding } from './matrix-company-private-cos-claim'

/** Frozen `atum.company-private-cos/1` native constants (`@atum/protocol` 0.7.78). */
export const MATRIX_COMPANY_PRIVATE_COS_SCHEMA_VERSION = 1 as const
export const MATRIX_COMPANY_PRIVATE_COS_PROFILE = 'atum.company-private-cos/1' as const
export const MATRIX_COMPANY_PRIVATE_COS_ASYNC_PROFILE = 'atum.company-private-cos/1.1' as const
export const MATRIX_COMPANY_PRIVATE_COS_INTEGRATION_PROFILE = 'atum.company-private-cos/1.2' as const
export const MATRIX_COMPANY_PRIVATE_COS_LOCALE_PROFILE = 'atum.company-private-cos/1.3' as const
export const MATRIX_COMPANY_PRIVATE_COS_CAPABILITY = 'company.private-cos' as const
export const MATRIX_COMPANY_PRIVATE_COS_DISPLAY_NAME = 'Chief of Staff' as const
export {
  isCompanyPrivateCosClaim,
  isCompanyPrivateCosRoom,
  MATRIX_COMPANY_PRIVATE_COS_CLASSIFICATION,
  MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE,
  MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT,
  matrixCompanyPrivateCosPowerLevels,
  matrixCompanyPrivateCosRoomBinding
}
export type { MatrixCompanyPrivateCosPowerLevels, MatrixCompanyPrivateCosRoomBinding }
export const MATRIX_COMPANY_PRIVATE_COS_WIRE_HEADER = 'Atum-Company-Wire' as const
export const MATRIX_COMPANY_PRIVATE_COS_WIRE_VALUE_V11 = '1.1' as const
export const MATRIX_COMPANY_PRIVATE_COS_WIRE_VALUE_V12 = '1.2' as const
export const MATRIX_COMPANY_PRIVATE_COS_WIRE_VALUE = '1.3' as const

/**
 * Matrix rooms need an immutable fail-closed marker in addition to the platform view. A type-only
 * claim is hidden from Personal; the platform's pair view is still required before Team Space may
 * draw or open it.
 */
export const MATRIX_COMPANY_PRIVATE_COS_PROTECTED_STATE = [
  'm.room.join_rules',
  'm.room.power_levels',
  'm.room.history_visibility',
  'm.room.encryption',
  'm.room.guest_access',
  'm.room.name',
  'm.room.avatar',
  'm.room.topic',
  MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT,
  'm.room.server_acl',
  'm.room.tombstone'
] as const

const uuid = z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u)
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const nonnegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[0-9a-f]{64}$/u)
const matrixUserId = z.string().min(4).max(512).regex(/^@[!-9;-~]{1,255}:[!-~]{1,255}$/u)
const roomId = z.string().min(4).max(512).regex(/^![!-9;-~]{1,255}:[!-~]{1,255}$/u)
const eventId = z.string().min(2).max(512).regex(/^\$[!-~]+$/u)

/** Effective Matrix policy: an event override wins, otherwise state_default. */
export function matrixCompanyPrivateCosPowerPolicy(
  value: unknown,
  activeUserIds: readonly string[]
): boolean {
  const levels = matrixCompanyPrivateCosPowerLevels(value)

  if (!levels || activeUserIds.length !== 2 || new Set(activeUserIds).size !== 2) {
    return false
  }

  const users = Object.entries(levels.users)
  const managers = users.filter(([userId, level]) => !activeUserIds.includes(userId) && level === 100)

  return levels.users_default === 0 &&
    levels.events_default === 0 &&
    levels.state_default === 100 &&
    levels.invite === 100 &&
    levels.kick === 100 &&
    levels.ban === 100 &&
    levels.redact === 100 &&
    users.length === 3 &&
    activeUserIds.every(userId => levels.users[userId] === 0) &&
    managers.length === 1 &&
    MATRIX_COMPANY_PRIVATE_COS_PROTECTED_STATE.every(type => (levels.events[type] ?? levels.state_default) === 100)
}

export const MatrixCompanyPrivateCosPairSchema = z.object({
  companyPrincipal: uuid,
  memberPrincipal: uuid,
  membershipIncarnation: uuid
}).strict()
export type MatrixCompanyPrivateCosPair = z.infer<typeof MatrixCompanyPrivateCosPairSchema>

export const MatrixCompanyPrivateCosScopeSchema = z.object({
  pair: MatrixCompanyPrivateCosPairSchema,
  authorityEpoch: positive,
  contextEpoch: positive,
  homeGeneration: positive
}).strict()

export const MatrixCompanyPrivateCosCapabilityV1Schema = z.object({
  schemaVersion: z.literal(MATRIX_COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  profile: z.literal(MATRIX_COMPANY_PRIVATE_COS_PROFILE),
  capability: z.literal(MATRIX_COMPANY_PRIVATE_COS_CAPABILITY),
  displayName: z.literal(MATRIX_COMPANY_PRIVATE_COS_DISPLAY_NAME),
  teamDmPosition: z.literal(2),
  lazyCreation: z.literal(true),
  fundingKind: z.literal('company_wallet'),
  separatePrice: z.literal(false),
  purgeAfterDays: z.literal(30),
  userExport: z.literal(false)
}).strict()
export type MatrixCompanyPrivateCosCapabilityV1 = z.infer<typeof MatrixCompanyPrivateCosCapabilityV1Schema>

export const MatrixCompanyPrivateCosCapabilityV11Schema = z.object({
  schemaVersion: z.literal(2),
  profile: z.literal(MATRIX_COMPANY_PRIVATE_COS_ASYNC_PROFILE),
  capability: z.literal(MATRIX_COMPANY_PRIVATE_COS_CAPABILITY),
  supportedProfiles: z.tuple([
    z.literal(MATRIX_COMPANY_PRIVATE_COS_PROFILE),
    z.literal(MATRIX_COMPANY_PRIVATE_COS_ASYNC_PROFILE)
  ]),
  wire: z.object({
    header: z.literal(MATRIX_COMPANY_PRIVATE_COS_WIRE_HEADER),
    value: z.literal(MATRIX_COMPANY_PRIVATE_COS_WIRE_VALUE_V11)
  }).strict(),
  displayName: z.literal(MATRIX_COMPANY_PRIVATE_COS_DISPLAY_NAME),
  teamDmPosition: z.literal(2),
  lazyCreation: z.literal(true),
  fundingKind: z.literal('company_wallet'),
  separatePrice: z.literal(false),
  purgeAfterDays: z.literal(30),
  userExport: z.literal(false)
}).strict()
export type MatrixCompanyPrivateCosCapabilityV11 = z.infer<typeof MatrixCompanyPrivateCosCapabilityV11Schema>

export const MatrixCompanyPrivateCosCapabilityV12Schema = z.object({
  schemaVersion: z.literal(3),
  profile: z.literal(MATRIX_COMPANY_PRIVATE_COS_INTEGRATION_PROFILE),
  capability: z.literal(MATRIX_COMPANY_PRIVATE_COS_CAPABILITY),
  supportedProfiles: z.tuple([
    z.literal(MATRIX_COMPANY_PRIVATE_COS_PROFILE),
    z.literal(MATRIX_COMPANY_PRIVATE_COS_ASYNC_PROFILE),
    z.literal(MATRIX_COMPANY_PRIVATE_COS_INTEGRATION_PROFILE)
  ]),
  wire: z.object({
    header: z.literal(MATRIX_COMPANY_PRIVATE_COS_WIRE_HEADER),
    value: z.literal(MATRIX_COMPANY_PRIVATE_COS_WIRE_VALUE_V12)
  }).strict(),
  displayName: z.literal(MATRIX_COMPANY_PRIVATE_COS_DISPLAY_NAME),
  teamDmPosition: z.literal(2),
  lazyCreation: z.literal(true),
  fundingKind: z.literal('company_wallet'),
  separatePrice: z.literal(false),
  purgeAfterDays: z.literal(30),
  userExport: z.literal(false),
  roomType: z.literal(MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE),
  roomName: z.literal(MATRIX_COMPANY_PRIVATE_COS_DISPLAY_NAME),
  roomEncrypted: z.literal(false),
  greetingVersion: z.literal(2)
}).strict()
export type MatrixCompanyPrivateCosCapabilityV12 = z.infer<typeof MatrixCompanyPrivateCosCapabilityV12Schema>

export const MatrixCompanyPrivateCosCapabilityV13Schema = z.object({
  ...MatrixCompanyPrivateCosCapabilityV12Schema.shape,
  schemaVersion: z.literal(4),
  profile: z.literal(MATRIX_COMPANY_PRIVATE_COS_LOCALE_PROFILE),
  supportedProfiles: z.tuple([
    z.literal(MATRIX_COMPANY_PRIVATE_COS_PROFILE),
    z.literal(MATRIX_COMPANY_PRIVATE_COS_ASYNC_PROFILE),
    z.literal(MATRIX_COMPANY_PRIVATE_COS_INTEGRATION_PROFILE),
    z.literal(MATRIX_COMPANY_PRIVATE_COS_LOCALE_PROFILE)
  ]),
  wire: z.object({
    header: z.literal(MATRIX_COMPANY_PRIVATE_COS_WIRE_HEADER),
    value: z.literal(MATRIX_COMPANY_PRIVATE_COS_WIRE_VALUE)
  }).strict(),
  ensureLocale: z.literal(true)
}).strict()
export type MatrixCompanyPrivateCosCapabilityV13 = z.infer<typeof MatrixCompanyPrivateCosCapabilityV13Schema>

export const MatrixCompanyPrivateCosCapabilitySchema = z.union([
  MatrixCompanyPrivateCosCapabilityV1Schema,
  MatrixCompanyPrivateCosCapabilityV11Schema,
  MatrixCompanyPrivateCosCapabilityV12Schema,
  MatrixCompanyPrivateCosCapabilityV13Schema
])
export type MatrixCompanyPrivateCosCapability = z.infer<typeof MatrixCompanyPrivateCosCapabilitySchema>

export function matrixCompanyPrivateCosSupportsV11(value: unknown): value is MatrixCompanyPrivateCosCapabilityV11 {
  return MatrixCompanyPrivateCosCapabilityV11Schema.safeParse(value).success
}

export function matrixCompanyPrivateCosSupportsV12(value: unknown): value is MatrixCompanyPrivateCosCapabilityV12 {
  return MatrixCompanyPrivateCosCapabilityV12Schema.safeParse(value).success
}

export function matrixCompanyPrivateCosSupportsV13(
  value: unknown
): value is MatrixCompanyPrivateCosCapabilityV13 {
  return MatrixCompanyPrivateCosCapabilityV13Schema.safeParse(value).success
}

export const MatrixCompanyPrivateCosBindingSchema = z.object({
  scope: MatrixCompanyPrivateCosScopeSchema,
  agentPrincipal: uuid,
  agentUserId: matrixUserId,
  executorId: uuid,
  homeId: uuid,
  roomId,
  storeGeneration: positive,
  profileDigest: digest
}).strict()
export type MatrixCompanyPrivateCosBinding = z.infer<typeof MatrixCompanyPrivateCosBindingSchema>

const uncreated = z.object({
  schemaVersion: z.literal(MATRIX_COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  state: z.literal('uncreated'),
  pair: MatrixCompanyPrivateCosPairSchema,
  greetingState: z.literal('pending')
}).strict()

const preparing = z.object({
  schemaVersion: z.literal(MATRIX_COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  state: z.literal('preparing'),
  pair: MatrixCompanyPrivateCosPairSchema,
  greetingState: z.enum(['pending', 'publishing']),
  binding: MatrixCompanyPrivateCosBindingSchema
}).strict()

const ready = z.object({
  schemaVersion: z.literal(MATRIX_COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  state: z.literal('ready'),
  pair: MatrixCompanyPrivateCosPairSchema,
  greetingState: z.enum(['pending', 'published']),
  binding: MatrixCompanyPrivateCosBindingSchema
}).strict()

const samePair = (left: MatrixCompanyPrivateCosPair, right: MatrixCompanyPrivateCosPair) =>
  left.companyPrincipal === right.companyPrincipal &&
  left.memberPrincipal === right.memberPrincipal &&
  left.membershipIncarnation === right.membershipIncarnation

export const MatrixCompanyPrivateCosV1ViewSchema = z.discriminatedUnion('state', [uncreated, preparing, ready])
  .superRefine((view, context) => {
    if (view.state !== 'uncreated' && !samePair(view.pair, view.binding.scope.pair)) {
      context.addIssue({ code: 'custom', path: ['binding', 'scope', 'pair'], message: 'view pair must match binding pair' })
    }
  })
export const MatrixCompanyPrivateCosPreparingV11Schema = z.object({
  schemaVersion: z.literal(2),
  profile: z.literal(MATRIX_COMPANY_PRIVATE_COS_ASYNC_PROFILE),
  state: z.literal('preparing'),
  pair: MatrixCompanyPrivateCosPairSchema,
  greetingState: z.literal('pending'),
  operationId: uuid
}).strict()
export type MatrixCompanyPrivateCosPreparingV11 = z.infer<typeof MatrixCompanyPrivateCosPreparingV11Schema>

export const MatrixCompanyPrivateCosViewSchema = z.union([
  MatrixCompanyPrivateCosV1ViewSchema,
  MatrixCompanyPrivateCosPreparingV11Schema
])
export type MatrixCompanyPrivateCosView = z.infer<typeof MatrixCompanyPrivateCosViewSchema>

export function matrixCompanyPrivateCosViewSupportsV11(
  view: MatrixCompanyPrivateCosView
): view is MatrixCompanyPrivateCosPreparingV11 {
  return view.schemaVersion === 2 && view.profile === MATRIX_COMPANY_PRIVATE_COS_ASYNC_PROFILE
}

export const MatrixCompanyPrivateCosEnsureRequestSchema = z.object({
  schemaVersion: z.literal(MATRIX_COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  requestId: uuid,
  action: z.literal('ensure'),
  trigger: z.enum(['dm_open', 'first_company_visit']),
  locale: z.enum(['en', 'vi', 'ja', 'zh', 'zh-hant']).optional()
}).strict()
export type MatrixCompanyPrivateCosEnsureRequest = z.infer<typeof MatrixCompanyPrivateCosEnsureRequestSchema>
export const MatrixCompanyPrivateCosEnsureLocaleSchema = z.enum(['en', 'vi', 'ja', 'zh', 'zh-hant'])
export type MatrixCompanyPrivateCosEnsureLocale = z.infer<typeof MatrixCompanyPrivateCosEnsureLocaleSchema>
export type MatrixCompanyPrivateCosEnsureClientRequest = MatrixCompanyPrivateCosEnsureRequest

export const MatrixCompanyPrivateCosStopRequestSchema = z.object({
  schemaVersion: z.literal(MATRIX_COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  requestId: uuid
}).strict()
export type MatrixCompanyPrivateCosStopRequest = z.infer<typeof MatrixCompanyPrivateCosStopRequestSchema>

export const MatrixCompanyPrivateCosOwnerReceiptSchema = z.object({
  schemaVersion: z.literal(MATRIX_COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  runId: uuid,
  taskId: uuid,
  pair: MatrixCompanyPrivateCosPairSchema,
  executorId: uuid,
  contextEpoch: positive,
  homeGeneration: positive,
  authorityEpoch: positive,
  reservationId: uuid,
  reservedMicroProtons: positive,
  settledMicroProtons: nonnegative,
  state: z.enum(['reserved', 'running', 'stopped', 'settled', 'uncertain']),
  verifiedEventId: eventId,
  homeCommitId: uuid.nullable(),
  outboxTransactionId: uuid.nullable(),
  publishedEventId: eventId.nullable(),
  sourceLinks: z.array(z.object({ sourceId: uuid, revisionDigest: digest }).strict()).max(40)
}).strict()
export type MatrixCompanyPrivateCosOwnerReceipt = z.infer<typeof MatrixCompanyPrivateCosOwnerReceiptSchema>

export const MatrixCompanyPrivateCosUnfundedStopReceiptSchema = z.object({
  schemaVersion: z.literal(2),
  profile: z.literal(MATRIX_COMPANY_PRIVATE_COS_ASYNC_PROFILE),
  runId: uuid,
  taskId: uuid,
  pair: MatrixCompanyPrivateCosPairSchema,
  executorId: uuid,
  contextEpoch: positive,
  homeGeneration: positive,
  authorityEpoch: positive,
  state: z.literal('stopped'),
  verifiedEventId: eventId,
  funding: z.object({
    state: z.literal('not_reserved'),
    reservationId: z.null(),
    reservedMicroProtons: z.literal(0),
    settledMicroProtons: z.literal(0)
  }).strict(),
  homeCommitId: uuid.nullable(),
  outboxTransactionId: uuid.nullable(),
  publishedEventId: eventId.nullable(),
  sourceLinks: z.tuple([])
}).strict()
export type MatrixCompanyPrivateCosUnfundedStopReceipt =
  z.infer<typeof MatrixCompanyPrivateCosUnfundedStopReceiptSchema>

export const MatrixCompanyPrivateCosStopReceiptSchema = z.union([
  MatrixCompanyPrivateCosOwnerReceiptSchema,
  MatrixCompanyPrivateCosUnfundedStopReceiptSchema
])
export type MatrixCompanyPrivateCosStopReceipt = z.infer<typeof MatrixCompanyPrivateCosStopReceiptSchema>

export const MatrixCompanyPrivateCosGreetingSchema = z.object({
  schemaVersion: z.literal(MATRIX_COMPANY_PRIVATE_COS_SCHEMA_VERSION),
  pair: MatrixCompanyPrivateCosPairSchema,
  intentId: uuid,
  welcomeVersion: z.literal(1),
  locale: z.enum(['en', 'vi', 'ja', 'zh', 'zh-hant']),
  outboxTransactionId: uuid,
  state: z.literal('published'),
  publicationCount: z.literal(1),
  publishedEventId: eventId,
  replayed: z.boolean()
}).strict()

const greetingLinkBase = {
  companyId: uuid,
  boardId: uuid,
  title: z.string().min(1).max(160),
  url: z.string().url()
}
export const MatrixCompanyPrivateCosGreetingLinkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('company_board'), ...greetingLinkBase }).strict(),
  z.object({ kind: z.literal('company_board_card'), ...greetingLinkBase, cardId: uuid }).strict()
]).superRefine((value, context) => {
  const expected = `https://atumplatform.com/#atum-board/${value.companyId}/${value.boardId}` +
    (value.kind === 'company_board_card' ? `/card/${value.cardId}` : '')

  if (value.url !== expected) {
    context.addIssue({ code: 'custom', path: ['url'], message: 'board link must match its exact target' })
  }
})
export const MatrixCompanyPrivateCosGreetingClaimSchema = z.object({
  schemaVersion: z.literal(1),
  resource: z.literal('greeting'),
  claimed: z.literal(true),
  locale: z.enum(['en', 'vi']),
  text: z.string().min(1).max(1_000),
  mention: z.object({ userId: matrixUserId }).strict(),
  agentPill: z.object({
    userId: matrixUserId,
    displayName: z.literal(MATRIX_COMPANY_PRIVATE_COS_DISPLAY_NAME),
    label: z.literal('@Chief of Staff'),
    href: z.string().url()
  }).strict(),
  link: MatrixCompanyPrivateCosGreetingLinkSchema
}).strict().superRefine((value, context) => {
  if (value.agentPill.href !== `https://matrix.to/#/${value.agentPill.userId}`) {
    context.addIssue({ code: 'custom', path: ['agentPill', 'href'], message: 'agent pill href must match its user' })
  }
})
export const MatrixCompanyPrivateCosGreetingContentSchema = z.object({
  msgtype: z.literal('m.text'),
  body: z.string().min(1).max(1_000),
  format: z.literal('org.matrix.custom.html'),
  formatted_body: z.string().min(1).max(4_000),
  'm.mentions': z.object({ user_ids: z.tuple([matrixUserId]) }).strict()
}).strict()

export type MatrixCompanyPrivateCosRequest =
  | { action: 'private-cos-capability'; companyId: string }
  | { action: 'private-cos-view'; companyId: string }
  | ({ action: 'private-cos-ensure'; companyId: string } &
      Omit<MatrixCompanyPrivateCosEnsureClientRequest, 'action'>)
  | { action: 'private-cos-receipt'; companyId: string; runId: string }
  | ({ action: 'private-cos-stop'; companyId: string; runId: string } & MatrixCompanyPrivateCosStopRequest)

export type MatrixCompanyPrivateCosValue =
  | MatrixCompanyPrivateCosView
  | MatrixCompanyPrivateCosCapabilityV12
  | MatrixCompanyPrivateCosCapabilityV13
  | MatrixCompanyPrivateCosOwnerReceipt
  | MatrixCompanyPrivateCosUnfundedStopReceipt

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('private-cos-capability'), companyId: uuid }).strict(),
  z.object({ action: z.literal('private-cos-view'), companyId: uuid }).strict(),
  z.object({ action: z.literal('private-cos-ensure'), companyId: uuid,
    schemaVersion: z.literal(1), requestId: uuid, trigger: z.enum(['dm_open', 'first_company_visit']),
    locale: MatrixCompanyPrivateCosEnsureLocaleSchema.optional() }).strict(),
  z.object({ action: z.literal('private-cos-receipt'), companyId: uuid, runId: uuid }).strict(),
  z.object({ action: z.literal('private-cos-stop'), companyId: uuid, runId: uuid,
    schemaVersion: z.literal(1), requestId: uuid }).strict()
])

export function parseMatrixCompanyPrivateCosRequest(value: unknown): MatrixCompanyPrivateCosRequest {
  return requestSchema.parse(value)
}

export function parseMatrixCompanyPrivateCosResponse(
  value: unknown,
  request: MatrixCompanyPrivateCosRequest
): MatrixCompanyPrivateCosValue {
  if (request.action === 'private-cos-capability') {
    return z.union([
      MatrixCompanyPrivateCosCapabilityV12Schema,
      MatrixCompanyPrivateCosCapabilityV13Schema
    ]).parse(value)
  }
  if (request.action === 'private-cos-receipt') {
    const receipt = MatrixCompanyPrivateCosOwnerReceiptSchema.parse(value)

    if (receipt.runId !== request.runId || receipt.pair.companyPrincipal !== request.companyId) {
      throw new Error('matrix_company_private_cos_invalid')
    }

    return receipt
  }
  if (request.action === 'private-cos-stop') {
    const receipt = MatrixCompanyPrivateCosStopReceiptSchema.parse(value)

    if (receipt.runId !== request.runId || receipt.pair.companyPrincipal !== request.companyId ||
      receipt.state !== 'stopped') {
      throw new Error('matrix_company_private_cos_invalid')
    }

    return receipt
  }

  const view = MatrixCompanyPrivateCosViewSchema.parse(value)

  if (view.pair.companyPrincipal !== request.companyId) {
    throw new Error('matrix_company_private_cos_invalid')
  }

  return view
}

export function matrixCompanyPrivateCosRoute(request: MatrixCompanyPrivateCosRequest) {
  if (request.action === 'private-cos-capability') {
    return { method: 'GET' as const, path: '/cloud/controller/company-private-cos' }
  }

  const base = `/companies/${request.companyId}/private-cos`
  const headers = { [MATRIX_COMPANY_PRIVATE_COS_WIRE_HEADER]: MATRIX_COMPANY_PRIVATE_COS_WIRE_VALUE }

  if (request.action === 'private-cos-view') {return { method: 'GET' as const, path: base, headers }}

  if (request.action === 'private-cos-ensure') {return { method: 'POST' as const, path: base,
    body: {
      schemaVersion: 1,
      requestId: request.requestId,
      action: 'ensure',
      trigger: request.trigger,
      ...(request.locale ? { locale: request.locale } : {})
    },
    headers }}

  if (request.action === 'private-cos-receipt') {return { method: 'GET' as const, path: `${base}/runs/${request.runId}/receipt` }}

  return { method: 'POST' as const, path: `${base}/runs/${request.runId}/stop`,
    body: { schemaVersion: 1, requestId: request.requestId } }
}

const roomBindingV12 = z.object({
  v: z.literal(1),
  classification: z.literal(MATRIX_COMPANY_PRIVATE_COS_CLASSIFICATION),
  companyId: uuid,
  membershipIncarnation: uuid,
  executorId: uuid
}).strict()
const roomBindingV13 = roomBindingV12.extend({ attemptId: uuid }).strict()

export const MatrixCompanyPrivateCosRoomAttemptSchema = z.object({
  attemptId: uuid,
  state: z.literal('create'),
  roomId: z.null(),
  marker: z.object({
    type: z.literal(MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT),
    stateKey: z.literal(''),
    content: roomBindingV13
  }).strict()
}).strict()

/** An assistant room is company-private only with the exact frozen state marker. */
