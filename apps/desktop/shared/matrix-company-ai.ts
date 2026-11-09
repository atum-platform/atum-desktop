import { z } from 'zod'

/**
 * D1 native consumer for `atum.company-ai/1`.
 *
 * This module mirrors only the frozen native subset the desktop is allowed to
 * see: the Chief of Staff view, the owner off-switch and Stop. Controller
 * leases, sessions, custody, intake, context, outbox and publication never
 * cross this boundary.
 *
 * Requests are closed: a renderer can name a company, a request UUID, an
 * expected revision and a task UUID. It cannot supply an actor, owner, payer,
 * room, principal, token or provider URL. Responses echo the company (and task
 * for Stop) so a late answer for another account or company cannot be adopted.
 */

export const MATRIX_COMPANY_AI_SCHEMA_VERSION = 1 as const
export const MATRIX_COMPANY_AI_DISPLAY_NAME = 'Chief of Staff' as const
export const MATRIX_COMPANY_AI_PROFILE = 'atum.company-ai/1' as const

export const MATRIX_COMPANY_AI_LIMITS = Object.freeze({
  assignmentWorkItems: 100,
  membershipWorkItems: 100,
  serviceUsersPerChannel: 100,
  contextEvidence: 40,
  citations: 40,
  excerptCharacters: 500,
  answerCharacters: 65_536
} as const)

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u)

const matrixUserId = z
  .string()
  .min(4)
  .max(512)
  .regex(/^@[!-9;-~]{1,255}:[!-~]{1,255}$/u)

const eventId = z
  .string()
  .min(2)
  .max(512)
  .regex(/^\$[!-~]+$/u)

const memberRef = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u)

const fileName = z.string().min(1).max(255)

const contentType = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,63}$/u)

const byteSize = z
  .number()
  .int()
  .min(0)
  .max(20 * 1024 * 1024)

const utcTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u)
  .refine(value => Number.isFinite(Date.parse(value)), 'timestamp must be valid UTC RFC3339')

export const MatrixCompanyAIFileRefV1Schema = z
  .object({
    v: z.literal(1),
    company_id: uuid,
    channel_id: uuid,
    file_id: uuid,
    revision: z.literal(1),
    name: fileName,
    content_type: contentType,
    size: byteSize,
    sha256
  })
  .strict()

export const MatrixCompanyAIFileRefV2Schema = z
  .object({
    v: z.literal(2),
    company_id: uuid,
    audience: z
      .object({
        kind: z.literal('channel'),
        channel_id: uuid,
        visibility: z.enum(['public', 'private'])
      })
      .strict(),
    file_id: uuid,
    revision: z.literal(1),
    name: fileName,
    content_type: contentType,
    size: byteSize,
    sha256
  })
  .strict()

export const MatrixCompanyAIFileRefSchema = z.discriminatedUnion('v', [
  MatrixCompanyAIFileRefV1Schema,
  MatrixCompanyAIFileRefV2Schema
])
export type MatrixCompanyAIFileRef = z.infer<typeof MatrixCompanyAIFileRefSchema>

export const MatrixCompanyAIChannelCitationSchema = z
  .object({
    kind: z.literal('channel'),
    sourceId: uuid,
    channelId: uuid,
    eventId,
    revisionEventId: eventId.optional(),
    at: utcTimestamp
  })
  .strict()

export const MatrixCompanyAIFileCitationSchema = z
  .object({
    kind: z.literal('company_file'),
    sourceId: uuid,
    channelId: uuid,
    file: MatrixCompanyAIFileRefSchema
  })
  .strict()
export type MatrixCompanyAIFileCitation = z.infer<typeof MatrixCompanyAIFileCitationSchema>

export const MatrixCompanyAICitationSchema = z.discriminatedUnion('kind', [
  MatrixCompanyAIChannelCitationSchema,
  MatrixCompanyAIFileCitationSchema
])
export type MatrixCompanyAICitation = z.infer<typeof MatrixCompanyAICitationSchema>

/** One file citation is only meaningful inside its own company and channel audience. */
export function matrixCompanyAIFileRefAuthority(
  file: MatrixCompanyAIFileRef,
  expected: { companyId: string; channelId?: string }
): boolean {
  if (file.company_id !== expected.companyId) {
    return false
  }

  if (file.v === 1) {
    return expected.channelId === undefined || file.channel_id === expected.channelId
  }

  return file.audience.channel_id === (expected.channelId ?? file.audience.channel_id)
}

export function matrixCompanyAIFileCitationAuthority(citation: MatrixCompanyAICitation, companyId: string): boolean {
  return (
    citation.kind === 'channel' ||
    matrixCompanyAIFileRefAuthority(citation.file, { companyId, channelId: citation.channelId })
  )
}

export const MatrixCompanyAIAgentSchema = z
  .object({
    principal: uuid,
    userId: matrixUserId,
    displayName: z.literal(MATRIX_COMPANY_AI_DISPLAY_NAME)
  })
  .strict()
export type MatrixCompanyAIAgent = z.infer<typeof MatrixCompanyAIAgentSchema>

export const MatrixCompanyAIViewSchema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_AI_SCHEMA_VERSION),
    companyId: uuid,
    agent: MatrixCompanyAIAgentSchema,
    enabled: z.boolean(),
    revision: generation,
    state: z.enum(['preparing', 'ready', 'paused', 'attention']),
    canManage: z.boolean()
  })
  .strict()
export type MatrixCompanyAIView = z.infer<typeof MatrixCompanyAIViewSchema>

export const MatrixCompanyAIConfigureSchema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_AI_SCHEMA_VERSION),
    requestId: uuid,
    expectedRevision: generation,
    enabled: z.boolean()
  })
  .strict()
export type MatrixCompanyAIConfigure = z.infer<typeof MatrixCompanyAIConfigureSchema>

export const MatrixCompanyAITaskStopRequestSchema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_AI_SCHEMA_VERSION),
    requestId: uuid
  })
  .strict()
export type MatrixCompanyAITaskStopRequest = z.infer<typeof MatrixCompanyAITaskStopRequestSchema>

export const MatrixCompanyAITaskStopResponseSchema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_AI_SCHEMA_VERSION),
    taskId: uuid,
    state: z.enum(['cancelled', 'stopped'])
  })
  .strict()
export type MatrixCompanyAITaskStopResponse = z.infer<typeof MatrixCompanyAITaskStopResponseSchema>

export const MatrixCompanyAIErrorCodeSchema = z.enum([
  'invalid',
  'denied',
  'not_found',
  'conflict',
  'update_required',
  'unavailable',
  'budget_exhausted',
  'ai_disabled',
  'source_stale',
  'stopped'
])

/** The native refusal envelope frozen by the pack. */
export const MatrixCompanyAIErrorSchema = z
  .object({
    schemaVersion: z.literal(MATRIX_COMPANY_AI_SCHEMA_VERSION),
    error: z.object({ code: MatrixCompanyAIErrorCodeSchema }).strict()
  })
  .strict()

/* ------------------------------------------------------------------ IPC vocabulary */

export const MatrixCompanyAIRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('company-ai-view'), companyId: uuid }).strict(),
  z
    .object({
      action: z.literal('company-ai-configure'),
      companyId: uuid,
      requestId: uuid,
      expectedRevision: generation,
      enabled: z.boolean()
    })
    .strict(),
  z
    .object({
      action: z.literal('company-ai-stop'),
      companyId: uuid,
      taskId: uuid,
      requestId: uuid
    })
    .strict()
])

export type MatrixCompanyAIRequest = z.infer<typeof MatrixCompanyAIRequestSchema>
export type MatrixCompanyAIMutation = Extract<
  MatrixCompanyAIRequest,
  { action: 'company-ai-configure' | 'company-ai-stop' }
>
export type MatrixCompanyAIValue = MatrixCompanyAIView | MatrixCompanyAITaskStopResponse

export function parseMatrixCompanyAIRequest(value: unknown): MatrixCompanyAIRequest {
  const parsed = MatrixCompanyAIRequestSchema.safeParse(value)

  if (!parsed.success) {
    throw new MatrixCompanyNativeError('invalid')
  }

  return parsed.data
}

export function isMatrixCompanyAIMutation(input: MatrixCompanyAIRequest): input is MatrixCompanyAIMutation {
  return input.action === 'company-ai-configure' || input.action === 'company-ai-stop'
}

/** The server answers the same shape a configure returns; echo the company before adopting it. */
export function parseMatrixCompanyAIResponse(value: unknown, input: MatrixCompanyAIRequest): MatrixCompanyAIValue {
  if (input.action === 'company-ai-stop') {
    const parsed = MatrixCompanyAITaskStopResponseSchema.safeParse(value)

    if (!parsed.success || parsed.data.taskId !== input.taskId) {
      throw new MatrixCompanyNativeError('invalid')
    }

    return parsed.data
  }

  const parsed = MatrixCompanyAIViewSchema.safeParse(value)

  if (!parsed.success || parsed.data.companyId !== input.companyId) {
    throw new MatrixCompanyNativeError('invalid')
  }

  return parsed.data
}

/* ------------------------------------------------------------------ native transport */

export type MatrixCompanyNativeErrorCode =
  | 'authentication'
  | 'denied'
  | 'missing'
  | 'conflict'
  | 'update_required'
  | 'unavailable'
  | 'limit'
  | 'budget_exhausted'
  /** company-funding/2.1: the caller's own wallet cannot cover a transfer to the company. */
  | 'insufficient_protons'
  | 'ai_disabled'
  | 'source_stale'
  | 'stopped'
  | 'invalid'
  | 'cancelled'

export class MatrixCompanyNativeError extends Error {
  constructor(
    readonly code: MatrixCompanyNativeErrorCode,
    readonly retryAfterSeconds?: number,
    readonly errorCode?: string
  ) {
    super(`matrix_company_${code}`)
  }
}

/**
 * Account-owned durable intent journal. The main process supplies the
 * encrypted account-scoped implementation; tests use the in-memory variant.
 * Storing the exact bytes is what makes an identical retry replay and a
 * changed intent under the same UUID conflict before any I/O.
 */
export interface MatrixCompanyIntentJournal {
  read(scope: string): string | null
  write(scope: string, value: string): void
  clear(scope: string, value: string): void
}

/** The narrow native seam a main-process client needs: no renderer URL, token or grant. */
export interface MatrixCompanyNativeContext {
  resource: string
  accessToken: string
  signal: AbortSignal
  /** Account + company scope. Two companies never share a journal entry. */
  scope: string
  /** Main-owned guard: throws when the account/domain/session generation moved. */
  assertCurrent: () => void
  journal: MatrixCompanyIntentJournal
}

export function matrixCompanyScope(accountKey: string, companyId: string): string {
  return `${accountKey}\u0000${companyId}`
}

/** Key-ordered JSON so a retry compares intent, not object insertion order. */
export function matrixCompanyIntentBytes(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson)
  }

  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}

    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJson(record[key])
    }

    return sorted
  }

  return value
}

export function admitMatrixCompanyIntent(context: MatrixCompanyNativeContext, intent: unknown): string {
  const bytes = matrixCompanyIntentBytes(intent)
  const pending = context.journal.read(context.scope)

  if (pending !== null && pending !== bytes) {
    throw new MatrixCompanyNativeError('conflict')
  }

  if (pending === null) {
    context.journal.write(context.scope, bytes)
  }

  return bytes
}

export function settleMatrixCompanyIntent(context: MatrixCompanyNativeContext, bytes: string): void {
  if (context.journal.read(context.scope) === bytes) {
    context.journal.clear(context.scope, bytes)
  }
}

/** Codes that prove the server refused the intent itself, so its journal may close. */
export function isDefinitiveMatrixCompanyRefusal(error: MatrixCompanyNativeError): boolean {
  return ['invalid', 'denied', 'missing', 'conflict', 'update_required', 'insufficient_protons'].includes(error.code)
}

const STATUS_CODE: Readonly<Record<number, MatrixCompanyNativeErrorCode>> = {
  400: 'invalid',
  401: 'authentication',
  402: 'budget_exhausted',
  403: 'denied',
  404: 'missing',
  409: 'conflict',
  426: 'update_required',
  429: 'limit',
  503: 'unavailable'
}

const COMPANY_AI_ERROR_STATUS: Readonly<Record<string, number>> = {
  invalid: 400,
  denied: 403,
  not_found: 404,
  conflict: 409,
  update_required: 426,
  unavailable: 503,
  budget_exhausted: 402,
  ai_disabled: 403,
  source_stale: 409,
  stopped: 409
}

const NATIVE_STATUS_CODE: Readonly<Record<string, MatrixCompanyNativeErrorCode>> = {
  invalid: 'invalid',
  denied: 'denied',
  not_found: 'missing',
  conflict: 'conflict',
  update_required: 'update_required',
  unavailable: 'unavailable',
  budget_exhausted: 'budget_exhausted',
  ai_disabled: 'ai_disabled',
  source_stale: 'source_stale',
  stopped: 'stopped'
}

/** Map an HTTP refusal, accepting a body code only when the frozen status matches it. */
export function matrixCompanyRefusalError(status: number, body: unknown): MatrixCompanyNativeError {
  const fallback = STATUS_CODE[status] ?? 'unavailable'
  const parsed = MatrixCompanyAIErrorSchema.safeParse(body)

  if (parsed.success && COMPANY_AI_ERROR_STATUS[parsed.data.error.code] === status) {
    const code = NATIVE_STATUS_CODE[parsed.data.error.code]!

    return new MatrixCompanyNativeError(code === 'missing' ? 'missing' : code, undefined, parsed.data.error.code)
  }

  return new MatrixCompanyNativeError(fallback)
}

/** Map a generic platform refusal with no Company AI envelope. */
export function matrixCompanyStatusError(status: number): MatrixCompanyNativeError {
  return new MatrixCompanyNativeError(STATUS_CODE[status] ?? 'unavailable')
}

export function matrixCompanyRetryAfter(response: Response): number | undefined {
  const value = response.headers.get('Retry-After')

  return value !== null && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 86_400
    ? Number(value)
    : undefined
}

const MAX_ERROR_BYTES = 4_096
const MAX_BODY_BYTES = 2 * 1024 * 1024

export interface MatrixCompanyNativeHttpResult {
  status: number
  body: unknown
  retryAfterSeconds?: number
}

/**
 * One bounded native call. The account/company fence runs before the request,
 * after the response headers and again before the body is handed to a parser,
 * so a late answer for another account or company can never be adopted.
 */
export async function matrixCompanyNativeFetch(
  context: MatrixCompanyNativeContext,
  init: {
    method: 'GET' | 'POST'
    path: string
    body?: unknown
    headers?: Readonly<Record<string, string>>
  }
): Promise<MatrixCompanyNativeHttpResult> {
  context.assertCurrent()
  context.signal.throwIfAborted()

  const response = await fetch(`${context.resource}${init.path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${context.accessToken}`,
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    signal: context.signal
  })

  context.assertCurrent()
  context.signal.throwIfAborted()

  const retryAfterSeconds = matrixCompanyRetryAfter(response)

  if (response.status !== 200) {
    const text = await readBoundedText(response, MAX_ERROR_BYTES)
    context.assertCurrent()

    let body: unknown = null

    try {
      body = text === '' ? null : JSON.parse(text)
    } catch {
      body = null
    }

    return { status: response.status, body, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) }
  }

  if (!response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()
    throw new MatrixCompanyNativeError('unavailable')
  }

  const text = await readBoundedText(response, MAX_BODY_BYTES)
  context.assertCurrent()
  context.signal.throwIfAborted()

  try {
    return { status: 200, body: JSON.parse(text) }
  } catch {
    throw new MatrixCompanyNativeError('unavailable')
  }
}

async function readBoundedText(response: Response, maximum: number): Promise<string> {
  const size = Number(response.headers.get('content-length'))

  if (Number.isFinite(size) && size > maximum) {
    await response.body?.cancel()
    throw new MatrixCompanyNativeError('unavailable')
  }

  const reader = response.body?.getReader()

  if (!reader) {
    throw new MatrixCompanyNativeError('unavailable')
  }

  let length = 0
  const chunks: Uint8Array[] = []

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      length += value.byteLength

      if (length > maximum) {
        throw new MatrixCompanyNativeError('unavailable')
      }

      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }

  const bytes = new Uint8Array(length)
  let offset = 0

  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new TextDecoder().decode(bytes)
}

/* ------------------------------------------------------------------ native routes */

export interface MatrixCompanyAIRoute {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
}

export function matrixCompanyAIRoute(input: MatrixCompanyAIRequest): MatrixCompanyAIRoute {
  const base = `/companies/${input.companyId}`

  if (input.action === 'company-ai-view') {
    return { method: 'GET', path: `${base}/ai` }
  }

  if (input.action === 'company-ai-configure') {
    return {
      method: 'POST',
      path: `${base}/ai`,
      body: {
        schemaVersion: MATRIX_COMPANY_AI_SCHEMA_VERSION,
        requestId: input.requestId,
        expectedRevision: input.expectedRevision,
        enabled: input.enabled
      }
    }
  }

  return {
    method: 'POST',
    path: `${base}/ai/tasks/${input.taskId}/stop`,
    body: { schemaVersion: MATRIX_COMPANY_AI_SCHEMA_VERSION, requestId: input.requestId }
  }
}

export function matrixCompanyAIEmptyJournal(): MatrixCompanyIntentJournal {
  const entries = new Map<string, string>()

  return {
    read: scope => entries.get(scope) ?? null,
    write: (scope, value) => {
      entries.set(scope, value)
    },
    clear: (scope, value) => {
      if (entries.get(scope) === value) {
        entries.delete(scope)
      }
    }
  }
}
