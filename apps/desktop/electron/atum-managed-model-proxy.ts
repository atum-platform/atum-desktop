import crypto from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'

import {
  managedModelAccessFailure,
  type ManagedModelAccessSnapshot,
  type ManagedModelUsageSnapshot,
  parseManagedModelAccessAuthority,
  parseManagedModelUsageHistory
} from '../src/lib/atum-managed-model-access'

import {
  type ManagedRequestCancellationTarget,
  ManagedRequestJournal,
  ManagedRequestRecoveryError,
  type PendingManagedRequest
} from './atum-managed-request-journal'
import {
  MANAGED_RETRY_DEADLINE_MS,
  MANAGED_RETRY_MAX_ATTEMPTS,
  managedResponseCanRetry,
  managedRetryDelay,
  managedRetryError,
  managedTransportCanRecover,
  waitManagedRetry
} from './atum-managed-request-retry'
import type { MessagingAccountSession } from './atum-messaging/types'

const LOOPBACK_HOST = '127.0.0.1'
const MAX_REQUEST_BYTES = 400_000
const MANAGED_ALIASES = ['binh-minh', 'nguyet-thuc', 'nhat-thuc'] as const
type ManagedAlias = (typeof MANAGED_ALIASES)[number]
const MANAGED_ALIAS: ManagedAlias = 'binh-minh'
// The pet hatch's model, metered like a chat turn: accepted on a private
// completion, never advertised in /v1/models (it is not a chat model) and never
// a shared-job alias. The hosted plane maps it to the hatch model; until it
// does, the plane refuses it and the desktop reports the spec path unavailable.
export const HATCH_ALIAS = 'hatch'
// DeepSeek's native window is 1M tokens, but both proxy hops intentionally cap
// JSON bodies at 400 KB. Advertise the smaller effective window so Hermes
// compacts before it reaches a transport limit it cannot recover from.
const MANAGED_CONTEXT_LENGTH = 75_000
// The gateway's own per-alias output cap (atum-platform services/gateway/atum-models.yaml):
// Hermes may ask for the whole of it. A smaller cap here cut long single outputs (a big
// write_file, a long answer, a reasoning model's thinking) at finish_reason=length.
const MANAGED_MAX_OUTPUT_TOKENS = 16_384
// Reasoning depths the hosted edge advertises. It rejects anything else outright,
// so a value that would 400 the turn is dropped here instead of dispatched.
const MANAGED_REASONING_EFFORTS = ['low', 'high', 'max'] as const
const MANAGED_ACCESS_TIMEOUT_MS = 10_000
const UPSTREAM_TIMEOUT_MS = 125_000
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
/**
 * The closed provider error code Hermes sees for a daily-cap refusal. The platform's Mac
 * owner-managed edge (cloud-execution 1.11) refuses with `{error:'daily_cap_exhausted'}`;
 * the local agent must end the turn plainly, never retry or report a generic failure.
 */
export const ATUM_DAILY_CAP_CODE = 'atum_daily_cap_exhausted'

function managedLoopbackProxyBypassEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  loopbackHost = LOOPBACK_HOST
): Record<'NO_PROXY' | 'no_proxy', string> {
  const entries: string[] = []
  const seen = new Set<string>()
  const effectiveNoProxy = environment.no_proxy !== undefined ? environment.no_proxy : environment.NO_PROXY

  if (effectiveNoProxy?.trim() === '*') {
    return { NO_PROXY: '*', no_proxy: '*' }
  }

  for (const entry of String(effectiveNoProxy || '').split(',')) {
    const normalized = entry.trim()
    const key = normalized.toLowerCase()

    if (!normalized || seen.has(key)) {
      continue
    }

    seen.add(key)
    entries.push(normalized)
  }

  if (!seen.has(loopbackHost.toLowerCase())) {
    entries.push(loopbackHost)
  }

  const value = entries.join(',')

  return { NO_PROXY: value, no_proxy: value }
}

interface ManagedTokenSource {
  current(): MessagingAccountSession | null
  refresh(rejected: MessagingAccountSession): Promise<MessagingAccountSession | null>
}

export interface AtumManagedModelProxyOptions {
  fetchImpl: typeof fetch
  tokens: ManagedTokenSource
  log?: (message: string) => void
  /**
   * Called only after the hosted edge confirms the protected Workspace route
   * and its response contains tool calls. The Electron main process binds the
   * resulting short-lived permit to the real backend credential.
   */
  onWorkspaceSourceRead?: (sessionId: string, permits: number, backendToken: unknown) => void
  workspaceProtected?: () => boolean
  privateRequestLive?: (backendToken: unknown) => () => boolean
  /** Account-owned metadata path, supplied by main's account-root authority. */
  pendingRequestsPath?: (accountId: string) => string
}

interface ActiveReservation {
  accessAlias: ManagedAlias
  claimId: string | null
  expiresAt: number
  messages: unknown[]
  reservationId: string
  turnRequestId: string
  pendingRequestId?: string
  pendingRequestBody?: string
}

export interface SharedJobTokenInput {
  jobId: string
  leaseToken: string
  alias: ManagedAlias
  accountId: string
  baseUrl: string
  deviceCredential: () => string | null
  onReservation?: (reservationId: string) => Promise<void>
}

interface SharedJobState extends SharedJobTokenInput {
  completionRequests: number
  expiresAt: number
  reservation: ActiveReservation | null
  revoked: boolean
  terminal: boolean
}

interface CompletionScope {
  key: string
  journal?: ManagedRequestJournal
  active(): ActiveReservation | null
  clear(): void
  ensureLive(): boolean
  reserveBody(accessAlias: ManagedAlias): JsonRecord
  reserveHeaders(): Headers
  reservationRecorded(reservationId: string): Promise<boolean>
  sharedState?: SharedJobState
  store(reservation: ActiveReservation): void
  terminal(): void
}

interface JsonRecord {
  [key: string]: unknown
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isTerminalCancellationState(value: unknown): boolean {
  return value === 'released' || value === 'cancelled' || value === 'settled' || value === 'corrected'
}

function isManagedAlias(value: unknown): value is ManagedAlias {
  return typeof value === 'string' && MANAGED_ALIASES.includes(value as ManagedAlias)
}

/** What a private completion may name: a chat alias, or the hatch alias. */
function isCompletionAlias(value: unknown): value is ManagedAlias | typeof HATCH_ALIAS {
  return isManagedAlias(value) || value === HATCH_ALIAS
}

function safeBearerMatches(header: string | undefined, expected: string): boolean {
  const supplied = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '')
  const wanted = Buffer.from(expected)

  return supplied.length === wanted.length && crypto.timingSafeEqual(supplied, wanted)
}

async function readBoundedJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length

    if (bytes > MAX_REQUEST_BYTES) {
      throw new Error('managed_request_too_large')
    }

    chunks.push(buffer)
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('invalid_managed_request')
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'cache-control': 'no-store, max-age=0',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8'
  })
  response.end(body)
}

function errorPayload(code: string, message = code, details?: JsonRecord): JsonRecord {
  return { error: { message, type: 'atum_managed_model_error', code, ...(details ? { details } : {}) } }
}

function isDailyCapRefusal(value: unknown): boolean {
  if (!isRecord(value)) {
    return false
  }

  if (value.error === ATUM_DAILY_CAP_CODE || value.error === 'daily_cap_exhausted') {
    return true
  }

  return isRecord(value.error)
    && (value.error.code === ATUM_DAILY_CAP_CODE || value.error.code === 'daily_cap_exhausted')
}

/**
 * The platform's Mac edge refusal carries cap/spend facts for diagnostics only. The app never
 * renders them (no meter, no balance), so they stay beside the closed code and never in its text.
 */
function dailyCapRefusalDetails(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  if (isRecord(value.details)) {
    return value.details
  }

  return isRecord(value.error) && isRecord(value.error.details) ? value.error.details : undefined
}

function jsonError(response: ServerResponse, status: number, code: string, message = code): void {
  json(response, status, errorPayload(code, message))
}

function normalizeErrorPayload(value: unknown, fallbackCode: string): unknown {
  if (isDailyCapRefusal(value)) {
    return errorPayload(ATUM_DAILY_CAP_CODE, ATUM_DAILY_CAP_CODE, dailyCapRefusalDetails(value))
  }

  if (isRecord(value) && isRecord(value.error) && typeof value.error.message === 'string') {
    return value
  }

  const code = isRecord(value) && typeof value.error === 'string'
    ? value.error
    : isRecord(value) && isRecord(value.error) && typeof value.error.code === 'string'
      ? value.error.code
      : fallbackCode

  return errorPayload(code)
}

function managedRequestBody(value: unknown): JsonRecord | null {
  if (!isRecord(value)
      || !Array.isArray(value.messages)
      || !isCompletionAlias(value.model ?? MANAGED_ALIAS)
      || (typeof value.max_tokens === 'number' && value.max_tokens > MANAGED_MAX_OUTPUT_TOKENS)) {
    return null
  }

  const projected: JsonRecord = {
    model: value.model ?? MANAGED_ALIAS,
    messages: value.messages,
    stream: false
  }

  for (const key of ['tools', 'tool_choice', 'temperature', 'top_p', 'max_tokens', 'stop'] as const) {
    if (value[key] !== undefined) {
      projected[key] = value[key]
    }
  }

  if (typeof value.reasoning_effort === 'string'
      && MANAGED_REASONING_EFFORTS.includes(value.reasoning_effort as (typeof MANAGED_REASONING_EFFORTS)[number])) {
    projected.reasoning_effort = value.reasoning_effort
  }

  if (isRecord(value.thinking)
      && Object.keys(value.thinking).length === 1
      && (value.thinking.type === 'enabled' || value.thinking.type === 'disabled')) {
    projected.thinking = { type: value.thinking.type }
  }

  return projected
}

function sharedManagedRequestBody(value: unknown, alias: ManagedAlias): JsonRecord | null {
  if (!isRecord(value) || value.model !== alias) {
    return null
  }

  const allowed = new Set([
    'max_tokens',
    'messages',
    'model',
    'parallel_tool_calls',
    'reasoning_effort',
    'response_format',
    'stop',
    'stream',
    'stream_options',
    'temperature',
    'thinking',
    'top_p'
  ])

  if (Object.keys(value).some(key => !allowed.has(key))
      || value.tools !== undefined
      || value.tool_choice !== undefined
      || value.function_call !== undefined) {
    return null
  }

  return managedRequestBody(value)
}

function messagesContinue(previous: unknown[], current: unknown[]): boolean {
  if (current.length <= previous.length) {
    return false
  }

  return previous.every((message, index) => JSON.stringify(message) === JSON.stringify(current[index]))
}

function terminalResponse(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length === 0) {
    return false
  }

  return value.choices.every(choice => isRecord(choice) && choice.finish_reason !== 'tool_calls')
}

function workspaceSourceUtilityCalls(value: unknown): number {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    return 0
  }

  let calls = 0

  for (const choice of value.choices) {
    if (!isRecord(choice) || !isRecord(choice.message) || !Array.isArray(choice.message.tool_calls)) {
      continue
    }

    for (const call of choice.message.tool_calls) {
      if (!isRecord(call) || !isRecord(call.function)) {
        continue
      }

      const name = call.function.name
      const argumentsText = call.function.arguments

      if (name === 'atum_utilities.py'
          || (typeof argumentsText === 'string' && argumentsText.includes('atum_utilities.py'))) {
        calls += 1
      }
    }
  }

  return Math.min(calls, 5)
}

function trustedWorkspaceSessionId(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value) ? value : null
}

function trainingRequestHeaders(request: IncomingMessage): Record<string, string> | null {
  const headers: Record<string, string> = {}

  for (const name of ['x-atum-assistant-identity-id', 'x-atum-conversation-id', 'x-atum-training-task-id']) {
    const value = request.headers[name]

    if (value === undefined) { continue }
    const pattern = name === 'x-atum-conversation-id' ? SESSION_ID_PATTERN : REQUEST_ID_PATTERN

    if (typeof value !== 'string' || !pattern.test(value)) { return null }
    headers[name] = value
  }

  if (Object.keys(headers).length > 0 && (!headers['x-atum-assistant-identity-id'] || !headers['x-atum-conversation-id'])) {
    return null
  }

  return headers
}

function streamChunk(value: JsonRecord, choice: JsonRecord, accessAlias: ManagedAlias): JsonRecord {
  const message = isRecord(choice.message) ? choice.message : {}
  const delta: JsonRecord = { role: typeof message.role === 'string' ? message.role : 'assistant' }

  if (typeof message.reasoning_content === 'string') {
    delta.reasoning_content = message.reasoning_content
  }

  if (typeof message.content === 'string') {
    delta.content = message.content
  }

  if (Array.isArray(message.tool_calls)) {
    delta.tool_calls = message.tool_calls.map((toolCall, index) => ({
      ...(isRecord(toolCall) ? toolCall : {}),
      index
    }))
  }

  return {
    id: value.id,
    object: 'chat.completion.chunk',
    created: value.created,
    model: accessAlias,
    choices: [{ index: choice.index ?? 0, delta, finish_reason: null }]
  }
}

function writeEvent(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`)
}

function streamJsonResponse(
  response: ServerResponse,
  value: JsonRecord,
  settlementState: string | null,
  accessAlias: ManagedAlias
): void {
  response.writeHead(200, {
    'cache-control': 'no-store, max-age=0',
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8',
    ...(settlementState ? { 'x-atum-settlement-state': settlementState } : {})
  })

  const choices = Array.isArray(value.choices) ? value.choices.filter(isRecord) : []

  for (const choice of choices) {
    writeEvent(response, streamChunk(value, choice, accessAlias))
    writeEvent(response, {
      id: value.id,
      object: 'chat.completion.chunk',
      created: value.created,
      model: accessAlias,
      choices: [{ index: choice.index ?? 0, delta: {}, finish_reason: choice.finish_reason ?? 'stop' }]
    })
  }

  if (isRecord(value.usage)) {
    writeEvent(response, {
      id: value.id,
      object: 'chat.completion.chunk',
      created: value.created,
      model: accessAlias,
      choices: [],
      usage: value.usage
    })
  }

  response.end('data: [DONE]\n\n')
}

export class AtumManagedModelProxy {
  private readonly activeReservations = new Map<string, ActiveReservation>()
  private baseUrl: string | null = null
  private readonly operations = new Map<string, Promise<void>>()
  private readonly requests = new Set<AbortController>()
  private readonly server: http.Server
  private readonly sharedJobs = new Map<string, SharedJobState>()
  private readonly token = crypto.randomBytes(32).toString('base64url')

  constructor(private readonly options: AtumManagedModelProxyOptions) {
    this.server = http.createServer((request, response) => {
      void this.route(request, response).catch(error => {
        const recovery = error instanceof ManagedRequestRecoveryError ? error : null
        const detail = recovery && recovery.requestIds.length > 0 ? ` request_ids=${recovery.requestIds.join(',')}` : ''
        this.options.log?.(`[atum-managed-model] request failed: ${recovery?.code ?? (error instanceof Error ? error.message : String(error))}${detail}`)

        if (!response.headersSent) {
          if (recovery) {
            const base = errorPayload(recovery.code).error as JsonRecord
            json(response, 503, {
              // IDs are written to the account-private main-process log for
              // support. Do not reveal other conversations' recovery IDs to
              // the model process that happened to encounter damaged storage.
              error: base
            })
          } else {
            jsonError(response, 502, 'managed_model_transport_failed')
          }
        } else {
          response.destroy()
        }
      })
    })
  }

  async start(): Promise<void> {
    if (this.baseUrl) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      this.server.once('error', onError)
      this.server.listen(0, LOOPBACK_HOST, () => {
        this.server.off('error', onError)
        resolve()
      })
    })

    const address = this.server.address()

    if (!address || typeof address === 'string') {
      await this.stop()
      throw new Error('atum_managed_proxy_address_unavailable')
    }

    this.baseUrl = `http://${LOOPBACK_HOST}:${address.port}/v1`
    this.options.log?.(`[atum-managed-model] loopback proxy ready on ${LOOPBACK_HOST}:${address.port}`)
  }

  async stop(): Promise<void> {
    this.baseUrl = null

    for (const request of this.requests) { request.abort(new Error('managed_request_cancelled')) }
    this.activeReservations.clear()
    this.sharedJobs.clear()

    if (!this.server.listening) {
      return
    }

    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }

  backendEnvironment(environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
    if (!this.baseUrl) {
      return {}
    }

    const proxyBypassEnvironment = managedLoopbackProxyBypassEnvironment(environment)
    this.options.log?.(`[atum-managed-model] Hermes child proxy bypass configured for ${LOOPBACK_HOST}`)

    return {
      ...proxyBypassEnvironment,
      ATUM_MANAGED_MODEL_BASE_URL: this.baseUrl,
      ATUM_MANAGED_MODEL_DEFAULT: MANAGED_ALIAS,
      ATUM_MANAGED_MODEL_PROXY_TOKEN: this.token,
    }
  }

  issueSharedJobToken(input: SharedJobTokenInput): { baseUrl: string, token: string, revoke: () => void } {
    const current = this.options.tokens.current()

    if (!this.baseUrl
        || !input.jobId
        || !input.leaseToken
        || !isManagedAlias(input.alias)
        || !input.accountId
        || !input.baseUrl
        || typeof input.deviceCredential !== 'function' || !input.deviceCredential()
        || !current
        || current.baseUrl !== input.baseUrl
        || current.user.id !== input.accountId) {
      throw new Error('invalid_shared_managed_job')
    }

    const token = crypto.randomBytes(32).toString('base64url')

    const state: SharedJobState = {
      ...input,
      completionRequests: 0,
      expiresAt: Date.now() + 5 * 60_000,
      reservation: null,
      revoked: false,
      terminal: false
    }

    this.sharedJobs.set(token, state)

    return {
      baseUrl: this.baseUrl,
      token,
      revoke: () => {
        state.revoked = true
        state.reservation = null
        this.sharedJobs.delete(token)
      }
    }
  }

  async accessState(accessAlias: ManagedAlias = MANAGED_ALIAS): Promise<ManagedModelAccessSnapshot> {
    try {
      const response = await this.authenticatedFetch(
        `/api/managed-model/access?model=${encodeURIComponent(accessAlias)}`,
        { method: 'GET' },
        MANAGED_ACCESS_TIMEOUT_MS
      )

      const value = await response.json().catch(() => null)

      if (!response.ok) {
        return managedModelAccessFailure(response.status, value)
      }

      return parseManagedModelAccessAuthority(value) ?? { state: 'unavailable' }
    } catch (error) {
      this.options.log?.(
        `[atum-managed-model] access state unavailable: ${error instanceof Error ? error.message : String(error)}`
      )

      return { state: 'unavailable' }
    }
  }

  async usageHistory(limit = 20): Promise<ManagedModelUsageSnapshot> {
    const bounded = Number.isSafeInteger(limit) ? Math.min(50, Math.max(1, limit)) : 20

    try {
      const response = await this.authenticatedFetch(
        `/api/managed-model/usage?limit=${bounded}`,
        { method: 'GET' },
        MANAGED_ACCESS_TIMEOUT_MS
      )

      const value = await response.json().catch(() => null)

      if (!response.ok) {
        return managedModelAccessFailure(response.status, value).state === 'authentication_expired'
          ? { state: 'authentication_expired' }
          : { state: 'unavailable' }
      }

      const turns = parseManagedModelUsageHistory(value)

      return turns ? { state: 'resolved', turns } : { state: 'unavailable' }
    } catch (error) {
      this.options.log?.(
        `[atum-managed-model] usage history unavailable: ${error instanceof Error ? error.message : String(error)}`
      )

      return { state: 'unavailable' }
    }
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('cache-control', 'no-store, max-age=0')

    const shared = this.sharedJobFor(request.headers.authorization)
    const masterToken = safeBearerMatches(request.headers.authorization, this.token)

    if (!masterToken && !shared) {
      jsonError(response, 401, 'managed_proxy_authentication_required')

      return
    }

    if (shared && !this.accountMatches(shared)) {
      shared.revoked = true
      shared.reservation = null
      jsonError(response, 401, 'managed_shared_job_account_changed')

      return
    }

    if (request.method === 'GET' && request.url === '/v1/models') {
      json(response, 200, {
        object: 'list',
        data: (shared ? [shared.alias] : MANAGED_ALIASES).map(id => ({
          id,
          object: 'model',
          created: 0,
          owned_by: 'atum',
          context_length: MANAGED_CONTEXT_LENGTH,
          max_output_tokens: MANAGED_MAX_OUTPUT_TOKENS
        }))
      })

      return
    }

    if (!['POST', 'DELETE'].includes(request.method ?? '') || request.url !== '/v1/chat/completions') {
      jsonError(response, 404, 'managed_proxy_route_not_found')

      return
    }

    let body: unknown

    try {
      body = await readBoundedJson(request)
    } catch (error) {
      const code = error instanceof Error ? error.message : 'invalid_managed_request'
      jsonError(response, code === 'managed_request_too_large' ? 413 : 400, code)

      return
    }

    if (request.method === 'DELETE') {
      const suppliedId = isRecord(body) ? body.request_id : null

      if (!isRecord(body) || (suppliedId !== undefined && (typeof suppliedId !== 'string' || !REQUEST_ID_PATTERN.test(suppliedId)))) {
        jsonError(response, 400, 'invalid_managed_request_id')

        return
      }

      const live = shared ? undefined : this.options.privateRequestLive?.(request.headers['x-atum-backend-token'])
      const training = trainingRequestHeaders(request)

      if (!training) {
        jsonError(response, 400, 'invalid_managed_request')

        return
      }

      const scope = shared ? this.sharedScope(shared) : this.privateScope(
        training['x-atum-conversation-id'] ?? trustedWorkspaceSessionId(request.headers['x-atum-session-id']), live, training['x-atum-assistant-identity-id']
      )

      let pending: PendingManagedRequest | undefined
      let cancellationTarget: ManagedRequestCancellationTarget | undefined

      try {
        pending = scope.journal?.get(scope.key)
        cancellationTarget = scope.journal?.cancellationTarget(scope.key)
      } catch {
        // Recover only identities retained for this scope. A caller-supplied
        // different ID must not clear malformed evidence for an older request.
        cancellationTarget = scope.journal?.cancellationTarget(scope.key)
      }

      const requestId = suppliedId ?? pending?.requestId ?? cancellationTarget?.requestId ?? scope.active()?.pendingRequestId

      if (requestId === undefined) {
        json(response, 200, { state: 'cancelled' })

        return
      }

      if ((pending && pending.requestId !== requestId)
          || (!pending && suppliedId && cancellationTarget
            && suppliedId !== cancellationTarget.requestId && suppliedId !== cancellationTarget.modelRequestId)) {
        jsonError(response, 409, 'managed_request_outcome_unknown')

        return
      }

      const cancelled = await this.cancelReservation(scope, String(requestId), pending, cancellationTarget)
      json(response, cancelled ? 200 : 503, cancelled ? { state: 'cancelled' } : errorPayload('managed_request_outcome_unknown'))

      return
    }

    // Hermes sends stream_options and parallel_tool_calls as transport hints;
    // the hosted non-streaming edge deliberately projects those away.
    // response_format changes response semantics, so a non-null request must
    // fail explicitly instead of appearing to honor constrained decoding.
    if (isRecord(body) && body.response_format !== undefined && body.response_format !== null) {
      jsonError(response, 400, 'unsupported_managed_parameter', 'response_format is not supported by Atum managed models')

      return
    }

    const projected = shared ? sharedManagedRequestBody(body, shared.alias) : managedRequestBody(body)

    if (!projected) {
      jsonError(response, 400, 'invalid_managed_request')

      return
    }

    const wantsStream = isRecord(body) && body.stream === true
    const suppliedRequestId = request.headers['x-atum-request-id']

    if (suppliedRequestId !== undefined && (typeof suppliedRequestId !== 'string' || !REQUEST_ID_PATTERN.test(suppliedRequestId))) {
      jsonError(response, 400, 'invalid_managed_request_id')

      return
    }

    const requestId = typeof suppliedRequestId === 'string' ? suppliedRequestId : crypto.randomUUID()
    const training = trainingRequestHeaders(request)

    if (!training) {
      jsonError(response, 400, 'invalid_managed_request')

      return
    }

    const privateLive = shared ? undefined : this.options.privateRequestLive?.(request.headers['x-atum-backend-token'])

    const scope = shared ? this.sharedScope(shared) : this.privateScope(
      training['x-atum-conversation-id'] ?? trustedWorkspaceSessionId(request.headers['x-atum-session-id']), privateLive, training['x-atum-assistant-identity-id']
    )

    const controller = new AbortController()

    const onClose = () => {
      if (!response.writableEnded) { controller.abort(new Error('managed_request_cancelled')) }
    }

    response.once('close', onClose)
    this.requests.add(controller)
    // Keep one conversation ordered without holding unrelated employees behind
    // a slow model, tool continuation, or capacity wait. Server slots are the
    // cross-device authority; this map is only local conversation ordering.
    const previous = this.operations.get(scope.key) ?? Promise.resolve()
    let release!: () => void

    const operation = new Promise<void>(resolve => {
      release = resolve
    })

    this.operations.set(scope.key, operation)

    try {
      await Promise.race([
        previous,
        new Promise<void>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
        })
      ])
      controller.signal.throwIfAborted()

      try {
        await this.complete(
          projected,
          wantsStream,
          response,
          scope,
          masterToken && !shared ? trustedWorkspaceSessionId(request.headers['x-atum-session-id']) : null,
          masterToken && !shared ? request.headers['x-atum-backend-token'] : null,
          requestId,
          controller.signal,
          training
        )
      } catch (error) {
        if (controller.signal.aborted) {
          await this.cancelReservation(scope, requestId)

          return
        }

        if (shared) {
          shared.reservation = null
          shared.terminal = true

          if (error instanceof Error && error.message === 'managed_shared_job_account_changed') {
            jsonError(response, 401, 'managed_shared_job_account_changed')
          } else {
            jsonError(response, 502, 'managed_model_transport_failed')
          }

          return
        }

        throw error
      }
    } finally {
      response.off('close', onClose)
      this.requests.delete(controller)
      // An aborted queued request must not let its successor overtake the
      // request it was waiting behind.
      void previous.finally(() => {
        release()

        if (this.operations.get(scope.key) === operation) { this.operations.delete(scope.key) }
      })
    }
  }

  private sharedJobFor(header: string | undefined): SharedJobState | null {
    const supplied = header?.startsWith('Bearer ') ? header.slice(7) : ''
    const state = this.sharedJobs.get(supplied)

    if (!state || state.revoked || state.terminal || state.expiresAt <= Date.now()) {
      if (state && state.expiresAt <= Date.now()) {
        state.revoked = true
        state.reservation = null
        this.sharedJobs.delete(supplied)
      }

      return null
    }

    return state
  }

  private accountMatches(state: SharedJobState): boolean {
    const current = this.options.tokens.current()

    return Boolean(current
      && current.baseUrl === state.baseUrl
      && current.user.id === state.accountId
      && !state.revoked
      && !state.terminal
      && state.expiresAt > Date.now())
  }

  private privateScope(sessionId: string | null, backendLive?: () => boolean, assistantId?: string): CompletionScope {
    const session = this.options.tokens.current()
    const account = session?.user.id
    const key = `${session?.baseUrl ?? ''}:${account ?? ''}:${assistantId ?? ''}:${sessionId ?? 'legacy'}`
    const journalPath = account && this.options.pendingRequestsPath?.(account)

    for (const [id, reservation] of this.activeReservations) {
      if (reservation.expiresAt <= Date.now()) { this.activeReservations.delete(id) }
    }

    return {
      key: `private:${key}`,
      ...(journalPath ? { journal: new ManagedRequestJournal(journalPath) } : {}),
      active: () => this.activeReservations.get(key) ?? null,
      clear: () => { this.activeReservations.delete(key) },
      ensureLive: () => this.options.tokens.current()?.user.id === account
        && this.options.tokens.current()?.baseUrl === session?.baseUrl && (!backendLive || backendLive()),
      reserveBody: accessAlias => ({ model: accessAlias }),
      reserveHeaders: () => new Headers(),
      reservationRecorded: async () => true,
      store: reservation => { this.activeReservations.set(key, reservation) },
      terminal: () => { this.activeReservations.delete(key) }
    }
  }

  private sharedScope(state: SharedJobState): CompletionScope {
    return {
      key: `shared:${state.accountId}:${state.jobId}`,
      active: () => state.reservation,
      clear: () => { state.reservation = null },
      ensureLive: () => this.accountMatches(state),
      reserveBody: accessAlias => ({
        model: accessAlias,
        shared_job_id: state.jobId,
        lease_token: state.leaseToken
      }),
      reserveHeaders: () => {
        const credential = state.deviceCredential()

        if (!credential) {throw new Error('managed_shared_job_credential_unavailable')}

        return new Headers({ 'x-atum-device-credential': credential })
      },
      reservationRecorded: async reservationId => {
        if (!state.onReservation) {
          return this.accountMatches(state)
        }

        await state.onReservation(reservationId)

        return this.accountMatches(state)
      },
      sharedState: state,
      store: reservation => { state.reservation = reservation },
      terminal: () => {
        state.reservation = null
        state.terminal = true
      }
    }
  }

  private async authenticatedFetch(
    path: string,
    init: RequestInit,
    timeoutMs = UPSTREAM_TIMEOUT_MS,
    shared: SharedJobState | null = null
  ): Promise<Response> {
    const session = this.options.tokens.current()

    if (!session || (shared && !this.accountMatches(shared))) {
      return new Response(JSON.stringify(errorPayload('authentication_expired')), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })
    }

    const matches = (candidate: MessagingAccountSession | null): boolean => Boolean(candidate
      && candidate.baseUrl === session.baseUrl && candidate.user.id === session.user.id
      && (!shared || this.accountMatches(shared)))

    const send = (candidate: MessagingAccountSession) => {
      if (!matches(candidate)) {
        throw new Error('managed_shared_job_account_changed')
      }

      const headers = new Headers(init.headers)
      headers.set('accept', 'application/json')
      headers.set('authorization', `Bearer ${candidate.tokens.accessToken}`)

      return this.options.fetchImpl(`${candidate.baseUrl}${path}`, {
        ...init,
        cache: 'no-store',
        headers,
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
      })
    }

    const first = await send(session)

    if (!matches(session)) {
      throw new Error('managed_shared_job_account_changed')
    }

    if (first.status !== 401) {
      return first
    }

    const refreshed = await this.options.tokens.refresh(session)

    if (!refreshed) { return first }

    if (!matches(refreshed)) {
      throw new Error('managed_shared_job_account_changed')
    }

    const retried = refreshed ? await send(refreshed) : first

    if (!matches(refreshed)) {
      throw new Error('managed_shared_job_account_changed')
    }

    return retried
  }

  private async cancelReservation(
    scope: CompletionScope,
    requestId: string,
    knownPending?: PendingManagedRequest,
    knownTarget?: ManagedRequestCancellationTarget
  ): Promise<boolean> {
    if (!scope.ensureLive()) { return false }
    const reservation = scope.active()
    // A recovered cancellation target can be sufficient when the same entry
    // is malformed. Do not re-read it and turn a confirmed Stop into a local
    // recovery failure.
    const pending = knownPending ?? (knownTarget ? undefined : scope.journal?.get(scope.key))
    const cancellationTarget = knownTarget ?? scope.journal?.cancellationTarget(scope.key)
    const reservationId = reservation?.reservationId ?? pending?.reservationId ?? cancellationTarget?.reservationId

    try {
      const headers = scope.reserveHeaders()
      headers.set('content-type', 'application/json')

      const result = await this.authenticatedFetch('/api/managed-model/reservations', {
        method: 'DELETE',
        headers,
        body: JSON.stringify(reservationId ? { reservation_id: reservationId } : { request_id: pending?.turnRequestId ?? cancellationTarget?.requestId ?? requestId })
      }, MANAGED_ACCESS_TIMEOUT_MS, scope.sharedState ?? null)

      const value = await result.json().catch(() => null)

      if (result.ok && isRecord(value) && isTerminalCancellationState(value.state)) {
        scope.journal?.clearAfterTerminal(scope.key)
        scope.clear()

        return true
      }

      this.options.log?.(`[atum-managed-model] cancellation outcome unknown request=${requestId}`)
    } catch {
      // The server still fences expired/unknown work. Do not turn an uncertain
      // cancellation into a fresh reservation or claim that charged work undid.
      this.options.log?.(`[atum-managed-model] cancellation pending request=${requestId}`)
    }

    return false
  }

  private async recoverableFetch(path: string, init: RequestInit, scope: CompletionScope, requestId: string): Promise<Response> {
    const queuedAt = Date.now()
    let started = queuedAt
    const signal = init.signal as AbortSignal
    let transportAttempts = 0
    let capacityAttempts = 0

    for (let attempt = 1; attempt <= MANAGED_RETRY_MAX_ATTEMPTS; attempt += 1) {
      signal.throwIfAborted()

      if (!scope.ensureLive()) { throw new Error('managed_shared_job_account_changed') }
      let response: Response

      try {
        const remaining = Math.max(1, MANAGED_RETRY_DEADLINE_MS - (Date.now() - started))
        response = await this.authenticatedFetch(path, init, Math.min(UPSTREAM_TIMEOUT_MS, remaining), scope.sharedState ?? null)
      } catch {
        signal.throwIfAborted()

        if (!scope.ensureLive()) { throw new Error('managed_shared_job_account_changed') }
        transportAttempts += 1

        if (!managedTransportCanRecover(transportAttempts) || Date.now() - started >= MANAGED_RETRY_DEADLINE_MS) {
          const code = path.endsWith('/chat/completions') ? 'managed_request_outcome_unknown' : 'managed_model_transport_failed'

          return new Response(JSON.stringify(errorPayload(code)), {
            status: code === 'managed_request_outcome_unknown' ? 409 : 503,
            headers: { 'content-type': 'application/json' }
          })
        }

        // Same request identity is a server status/replay operation: an
        // authorized or uncertain provider attempt is never dispatched twice.
        this.options.log?.(`[atum-managed-model] recovering response request=${requestId} attempt=${attempt}`)
        await waitManagedRetry(managedRetryDelay(attempt, null), signal)

        continue
      }

      const value = await response.clone().json().catch(() => null)

      if (!managedResponseCanRetry(response.status, value)) { return response }
      const capacityWait = response.status === 429 && managedRetryError(value).code === 'managed_capacity_wait'
      const delay = managedRetryDelay(capacityWait ? ++capacityAttempts : attempt, response.headers.get('retry-after'))

      if (!capacityWait && (attempt === MANAGED_RETRY_MAX_ATTEMPTS || Date.now() - started + delay >= MANAGED_RETRY_DEADLINE_MS)) {
        return response
      }

      this.options.log?.(`[atum-managed-model] waiting request=${requestId} attempt=${attempt} age_ms=${Date.now() - queuedAt} reason=${managedRetryError(value).code}`)
      await waitManagedRetry(delay, signal)

      if (capacityWait) {
        // Waiting for a slot is queued work, not a failed provider attempt.
        // Keep it cancellable and live without exhausting the bounded network
        // or provider retry budget before any model has been dispatched.
        started = Date.now()
        transportAttempts = 0
        attempt = 0
      }
    }

    throw new Error('managed_request_retry_exhausted')
  }

  private async complete(
    body: JsonRecord,
    wantsStream: boolean,
    response: ServerResponse,
    scope: CompletionScope,
    workspaceSessionId: string | null,
    workspaceBackendToken: unknown,
    requestId: string,
    signal: AbortSignal,
    training: Record<string, string>
  ): Promise<void> {
    if (!scope.ensureLive()) {
      jsonError(response, 401, 'managed_shared_job_account_changed')

      return
    }

    let reservation = scope.active()
    const workspaceProtected = this.options.workspaceProtected?.() === true

    if (workspaceProtected) {
      if (scope.sharedState && body.model !== 'binh-minh') {
        jsonError(response, 403, 'workspace_route_required')

        return
      }

      body = { ...body, model: 'binh-minh' }
    }

    let reservationResponse: Response | null = null
    const messages = body.messages as unknown[]
    const accessAlias = body.model as ManagedAlias

    if (reservation && reservation.expiresAt <= Date.now()) {
      scope.clear()
      reservation = null
    }

    const requestBody = JSON.stringify(body)
    const bodyHash = crypto.createHash('sha256').update(requestBody).digest('hex')
    const pending = scope.journal?.get(scope.key)

    if (pending && (pending.requestId !== requestId || pending.bodyHash !== bodyHash)) {
      // A newly submitted prompt is not evidence that an interrupted model
      // request (or its local tool effects) can be replayed safely. Recover the
      // exact checkpoint or explicitly cancel it, never deduplicate by content.
      jsonError(response, 409, 'managed_request_outcome_unknown')

      return
    }

    const recovering = reservation?.pendingRequestId === requestId && reservation.pendingRequestBody === requestBody
    const turnRequestId = reservation?.turnRequestId ?? pending?.turnRequestId ?? requestId

    if (reservation && !recovering && (reservation.pendingRequestId
        || reservation.accessAlias !== accessAlias || !messagesContinue(reservation.messages, messages))) {
      jsonError(response, 409, 'managed_turn_in_progress')

      return
    }

    if (!reservation) {
      scope.journal?.set(scope.key, pending ?? { requestId, turnRequestId, bodyHash, reservationId: null, createdAt: Date.now() })
      const headers = scope.reserveHeaders()

      for (const [name, value] of Object.entries(training)) { headers.set(name, value) }
      if (workspaceProtected) { headers.set('x-atum-workspace-protected', '1') }
      headers.set('content-type', 'application/json; charset=utf-8')

      reservationResponse = await this.recoverableFetch('/api/managed-model/reservations', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...scope.reserveBody(accessAlias), request_id: turnRequestId }),
        signal
      }, scope, requestId)
      const value = await reservationResponse.clone().json().catch(() => null)

      if (!scope.ensureLive()) {
        scope.clear()
        jsonError(response, 401, 'managed_shared_job_account_changed')

        return
      }

      if (reservationResponse.ok && isRecord(value) && typeof value.reservation_id === 'string'
          && (typeof value.claim_id === 'string' || value.claim_id === null)) {
        const parsedExpiry = typeof value.expires_at === 'string' ? Date.parse(value.expires_at) : Number.NaN
        reservation = {
          accessAlias,
          reservationId: value.reservation_id,
          turnRequestId,
          claimId: typeof value.claim_id === 'string' ? value.claim_id : null,
          expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + 4 * 60_000,
          messages
        }
        scope.store(reservation)

        try {
          if (!await scope.reservationRecorded(reservation.reservationId)) {
            scope.clear()
            jsonError(response, 401, 'managed_shared_job_account_changed')

            return
          }
        } catch {
          scope.clear()

          if (scope.sharedState) {
            scope.sharedState.terminal = true
          }

          jsonError(response, 503, 'managed_shared_reservation_record_failed')

          return
        }
      }
    }

    if (!reservation) {
      if (scope.sharedState && (reservationResponse?.status === undefined
          || reservationResponse.status >= 500
          || reservationResponse.ok)) {
        scope.sharedState.terminal = true
      }

      const status = reservationResponse?.status ?? 503
      const value = reservationResponse ? await reservationResponse.json().catch(() => null) : null

      if (status >= 400 && status < 500 && status !== 409 && status !== 429) { scope.journal?.set(scope.key, null) }
      json(response, status, normalizeErrorPayload(value, 'managed_model_unavailable'))

      return
    }

    const headers = new Headers({
      'content-type': 'application/json; charset=utf-8',
      'x-atum-reservation-id': reservation.reservationId,
      'x-atum-request-id': requestId,
      ...training
    })

    if (reservation.claimId) {
      headers.set('x-atum-claim-id', reservation.claimId)
    }

    if (workspaceProtected) { headers.set('x-atum-workspace-protected', '1') }

    if (!recovering && scope.sharedState && scope.sharedState.completionRequests >= 3) {
      scope.clear()
      scope.sharedState.terminal = true
      jsonError(response, 429, 'managed_shared_job_request_limit')

      return
    }

    if (!recovering && scope.sharedState) {
      scope.sharedState.completionRequests += 1
    }

    reservation.pendingRequestId = requestId
    reservation.pendingRequestBody = requestBody
    scope.journal?.set(scope.key, { requestId, turnRequestId, bodyHash, reservationId: reservation.reservationId, createdAt: pending?.createdAt ?? Date.now() })

    const upstream = await this.recoverableFetch('/api/managed-model/chat/completions', {
      method: 'POST',
      headers,
      body: requestBody,
      signal
    }, scope, requestId)

    const value = await upstream.json().catch(() => null)

    if (!scope.ensureLive()) {
      scope.clear()
      jsonError(response, 401, 'managed_shared_job_account_changed')

      return
    }

    if (!upstream.ok || !isRecord(value)) {
      const code = managedRetryError(value).code

      const keepPending = code === 'managed_capacity_wait' || code === 'managed_request_in_progress'
        || code === 'managed_request_outcome_unknown'

      if (!keepPending) { scope.clear() }

      if (!keepPending && upstream.status >= 400 && upstream.status < 500) { scope.journal?.set(scope.key, null) }

      if (scope.sharedState && (upstream.status >= 500 || upstream.ok)) {
        scope.sharedState.terminal = true
      }

      const retryAfter = upstream.headers.get('retry-after')

      if (retryAfter) { response.setHeader('retry-after', retryAfter) }
      json(response, upstream.ok ? 502 : upstream.status, normalizeErrorPayload(value, 'managed_model_invalid_response'))

      return
    }

    if (workspaceProtected && upstream.headers.get('x-atum-workspace-source-route') !== '1') {
      scope.clear()
      jsonError(response, 502, 'workspace_route_unconfirmed')

      return
    }

    if (reservation.claimId) {
      reservation.claimId = null
    }

    delete reservation.pendingRequestId
    delete reservation.pendingRequestBody
    scope.journal?.set(scope.key, null)

    // Every authorized provider call slides the hosted reservation expiry
    // forward. Track it so a long tool turn keeps its reservation instead of
    // abandoning it locally while the platform still holds it.
    const slidExpiry = Date.parse(upstream.headers.get('x-atum-reservation-expires-at') ?? '')

    if (Number.isFinite(slidExpiry)) {
      reservation.expiresAt = slidExpiry
    }

    const workspaceToolCalls = workspaceSourceUtilityCalls(value)

    if (workspaceSessionId
        && workspaceToolCalls > 0
        && upstream.headers.get('x-atum-workspace-source-route') === '1') {
      this.options.onWorkspaceSourceRead?.(workspaceSessionId, workspaceToolCalls, workspaceBackendToken)
    }

    if (terminalResponse(value)) {
      scope.terminal()
    } else {
      reservation.messages = messages
    }

    const settlementState = upstream.headers.get('x-atum-settlement-state')

    if (wantsStream) {
      streamJsonResponse(response, value, settlementState, accessAlias)

      return
    }

    const headersOut: Record<string, string> = {}

    if (settlementState) {
      headersOut['x-atum-settlement-state'] = settlementState
    }

    const payload = JSON.stringify(value)
    response.writeHead(200, {
      'cache-control': 'no-store, max-age=0',
      'content-length': Buffer.byteLength(payload),
      'content-type': 'application/json; charset=utf-8',
      ...headersOut
    })
    response.end(payload)
  }
}

export {
  MANAGED_ACCESS_TIMEOUT_MS,
  MANAGED_ALIAS,
  MANAGED_ALIASES,
  MANAGED_CONTEXT_LENGTH,
  MANAGED_MAX_OUTPUT_TOKENS,
  managedLoopbackProxyBypassEnvironment,
  managedRequestBody,
  MAX_REQUEST_BYTES,
  messagesContinue,
  safeBearerMatches,
  terminalResponse,
  trustedWorkspaceSessionId,
  UPSTREAM_TIMEOUT_MS
}
