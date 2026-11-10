import { createHash } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { MATRIX_GOOGLE_ATTACHMENT_PATH } from './google-path'
import { canonicalJson } from '../../device-protocol/canonical'
import { bearer } from './opaque-token'

import type { GrantDenial, ModelGrant, ModelGrantRegistry } from './model-grants'
import type { ModelUpstream, UpstreamStreamResponse } from './gateway-upstream'

/**
 * The controller's model broker (atum.cloud-execution/1 §6.3, §6.4): the one model endpoint
 * a task sandbox can reach (`ATUM_MODEL_BASE_URL`). It admits a request only with a live
 * grant the controller holds for a running task, only for the grant's aliases, within the
 * grant's request count, concurrency and output cap, and only in the standard
 * chat-completions shape; then it hands the request to the upstream (the managed-model
 * gateway in production). A stop, a lost lease or the grant's expiry cuts the request in
 * flight. It logs IDs, timings and closed codes, never a prompt, an answer or a token.
 *
 * A sandbox stream is an upstream stream: the broker preserves the grant and one-call admission,
 * rewrites provider model names to the granted alias, retains only bounded usage evidence and
 * cuts the HTTP stream when the grant, task or client ends.
 */

/**
 * The most a task may send in one model request: 16 MiB of JSON (reliability program §6.1,
 * "Broker request body"; it was 400 KB). A turn that looks at images carries them as base64
 * inside the conversation, and a `video_analyze` call carries its clip the same way, so the
 * bound has to clear a few images or a short clip.
 *
 * It is also the memory bound. A body is read whole, parsed, and serialised again for the
 * gateway, so one request at the cap costs about five times its size at the peak (about 80 MiB;
 * six at once about 490 MiB; measured 2026-10-17, ),
 * and a grant allows `maxConcurrent` in flight. If the controller host shows memory pressure, the
 * next guard is a budget of body bytes in flight across all grants, answered 429, not a lower cap.
 *
 * The gateway admits only text and image parts today (`PRICED_PARTS`), so a video part is
 * refused there (`atum_unsupported_content`) until it prices and admits them.
 */
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024
export const CONTEXT_LENGTH = 75_000

/** What the broker forwards: standard chat-completion fields only (the gateway's rule too). */
const FORWARDED = [
  'messages',
  'tools',
  'tool_choice',
  'temperature',
  'top_p',
  'max_tokens',
  'stop',
  'parallel_tool_calls',
  'response_format',
  'reasoning_effort',
  'seed',
  'frequency_penalty',
  'presence_penalty'
] as const

export interface BrokerRequestRecord {
  grant: string
  taskId: string
  /** The request's number under its grant, from 1: a task's first model call is 1. */
  request?: number
  alias: string | null
  startedAt: number
  endedAt: number
  status: number
  code: string | null
  stream: boolean
  requestBytes: number
  promptTokens: number | null
  completionTokens: number | null
  /** The provider's cache-read share of `promptTokens` (`prompt_tokens_details.cached_tokens`), when reported. */
  cachedTokens?: number | null
  /**
   * Prompt-cache evidence (S1 build plan §3.5): digests of the request's tool list and system
   * message, never their content. A conversation's first request of each turn must repeat the
   * previous turn's, or its cached prefix is gone.
   */
  toolsDigest?: string
  systemDigest?: string
  /**
   * Why the provider ended the completion (`stop`, `length`, `tool_calls`, `content_filter`, ...),
   * normalised to a short closed token. A turn that ends without an answer is read against it: a
   * `length` is a truncated answer, not a failed run (R7). Absent while the provider has not said.
   */
  finishReason?: string | null
}

export interface ModelBrokerOptions {
  host: string
  port: number
  grants: ModelGrantRegistry
  upstream: ModelUpstream
  /**
   * The platform subscription edge (`opencode_go` grants only). Absent refuses a subscription
   * grant with `subscription_unavailable`: it can never fall through to the managed gateway.
   */
  subscription?: ModelUpstream
  /** ChatGPT-plan relay over the selected owner Mac. */
  chatgptRelay?: ModelUpstream
  maxRequestBytes?: number
  contextLength?: number
  /** Optional controller-side Google tool route. No Google credential enters the sandbox. */
  google?: {
    handle(request: IncomingMessage, response: ServerResponse): Promise<void>
    handleAttachment(request: IncomingMessage, response: ServerResponse): Promise<void>
  }
  log?: (line: string) => void
  onRecord?: (record: BrokerRequestRecord) => void
}

interface JsonRecord {
  [key: string]: unknown
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export class BrokerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}

const DENIAL_STATUS: Record<GrantDenial, number> = {
  unknown_grant: 401,
  expired: 401,
  revoked: 401,
  exhausted: 429,
  busy: 429,
  wrong_source: 403
}

const STREAM_FAILURE_CODES = new Set([
  'gateway_upstream_timeout', 'gateway_stream_aborted', 'gateway_stream_idle_timeout',
  'gateway_stream_too_large', 'gateway_stream_invalid', 'gateway_stream_incomplete',
  'upstream_stream_invalid', 'upstream_stream_incomplete'
])

function send(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
    'content-type': 'application/json; charset=utf-8',
    ...headers
  })
  response.end(body)
}

function sendError(response: ServerResponse, status: number, code: string) {
  send(response, status, { error: { message: code, type: 'atum_broker_error', code } })
}

async function readBounded(request: IncomingMessage, limit: number): Promise<{ value: unknown; bytes: number }> {
  const declared = Number(request.headers['content-length'])

  if (Number.isFinite(declared) && declared > limit) {
    throw new BrokerError(413, 'request_too_large')
  }

  const chunks: Buffer[] = []
  let bytes = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length

    if (bytes > limit) {
      throw new BrokerError(413, 'request_too_large')
    }

    chunks.push(buffer)
  }

  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')), bytes }
  } catch {
    throw new BrokerError(400, 'request_invalid')
  }
}

/** A stable digest of a JSON value: canonical JSON, or sorted keys where it holds non-integers. */
function stableDigest(value: unknown): string {
  let text: string
  try {
    text = canonicalJson(value)
  } catch {
    const sorted = (item: unknown): unknown =>
      Array.isArray(item) ? item.map(sorted)
        : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted((item as JsonRecord)[key])]))
          : item
    text = JSON.stringify(sorted(value))
  }
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/** The digests of a forwarded body's tool list and system message. */
export function promptDigests(body: JsonRecord): { toolsDigest: string; systemDigest: string } {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const first = messages[0]
  const system = isRecord(first) && (first.role === 'system' || first.role === 'developer') ? first.content ?? '' : ''
  return {
    toolsDigest: stableDigest(Array.isArray(body.tools) ? body.tools : []),
    systemDigest: typeof system === 'string' ? `sha256:${createHash('sha256').update(system, 'utf8').digest('hex')}` : stableDigest(system)
  }
}

/** The body the broker forwards, or a refusal. Unknown fields are dropped, not forwarded. */
export function projectRequest(value: unknown, grant: ModelGrant): { body: JsonRecord; stream: boolean; includeUsage: boolean } {
  if (!isRecord(value) || !Array.isArray(value.messages) || value.messages.length === 0) {
    throw new BrokerError(400, 'request_invalid')
  }

  // Resumed Hermes conversations can retain the stable broker name `default`.
  // Subscription grants authorize one provider model, not a managed alias. Resolve this
  // transport name to that singleton without changing the grant or its funding source.
  const alias = grant.source !== 'atum' && value.model === 'default' && grant.aliases.length === 1
    ? grant.aliases[0] : value.model ?? grant.aliases[0]

  if (typeof alias !== 'string' || !grant.aliases.includes(alias)) {
    throw new BrokerError(403, 'model_alias_not_granted')
  }

  if (value.n !== undefined && value.n !== 1) {
    throw new BrokerError(400, 'request_invalid')
  }

  const body: JsonRecord = { model: alias }

  for (const key of FORWARDED) {
    if (value[key] !== undefined) {
      body[key] = value[key]
    }
  }

  const requested = [value.max_tokens, value.max_completion_tokens].find(
    candidate => typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
  ) as number | undefined

  body.max_tokens = Math.min(Math.floor(requested ?? grant.maxOutputTokens), grant.maxOutputTokens)
  if (grant.effort) body.reasoning_effort = grant.effort
  const stream = value.stream === true
  body.stream = stream
  const options = isRecord(value.stream_options) ? value.stream_options : {}
  if (stream) body.stream_options = { include_usage: true }

  return { body, stream, includeUsage: options.include_usage === true }
}

function streamAnswer(response: ServerResponse, value: JsonRecord, includeUsage: boolean) {
  response.writeHead(200, {
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8'
  })

  const event = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`)
  const choices = Array.isArray(value.choices) ? value.choices.filter(isRecord) : []

  for (const choice of choices) {
    const message = isRecord(choice.message) ? choice.message : {}
    const delta: JsonRecord = { role: typeof message.role === 'string' ? message.role : 'assistant' }

    for (const key of ['content', 'reasoning_content', 'reasoning', 'refusal']) {
      if (typeof message[key] === 'string') {
        delta[key] = message[key]
      }
    }

    if (Array.isArray(message.tool_calls)) {
      delta.tool_calls = message.tool_calls.map((call, index) => ({ ...(isRecord(call) ? call : {}), index }))
    }

    const base = { id: value.id, object: 'chat.completion.chunk', created: value.created, model: value.model }
    event({ ...base, choices: [{ index: choice.index ?? 0, delta, finish_reason: null }] })
    event({ ...base, choices: [{ index: choice.index ?? 0, delta: {}, finish_reason: choice.finish_reason ?? 'stop' }] })
  }

  if (includeUsage && isRecord(value.usage)) {
    event({ id: value.id, object: 'chat.completion.chunk', created: value.created, model: value.model, choices: [], usage: value.usage })
  }

  response.end('data: [DONE]\n\n')
}

/** A provider's `finish_reason` as a short closed token: lower-case letters and `_`, 32 at most. */
export function finishReasonOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  const token = value.slice(0, 32).toLowerCase().replace(/[^a-z_]/g, '_')

  return token || null
}

/** The first choice's `finish_reason` of a completion or a stream chunk. */
function choiceFinish(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.choices)) return null
  const choice = value.choices.find(isRecord)

  return choice ? finishReasonOf(choice.finish_reason) : null
}

/** Closed tokens the subscription edge returns; each one is terminal (no fallback, no retry). */
export const SUBSCRIPTION_TERMINAL_CODES = new Set([
  'subscription_unavailable', 'subscription_rejected', 'subscription_revoked',
  'subscription_rate_limited', 'subscription_grant_exhausted', 'subscription_timeout',
  'subscription_response_invalid', 'subscription_unauthenticated', 'subscription_relay_offline',
  'subscription_relay_unavailable', 'subscription_relay_expired', 'subscription_relay_failed',
  'subscription_response_too_large', 'subscription_request_too_large'
])

function upstreamCode(value: unknown): string {
  if (isRecord(value) && typeof value.error === 'string') {
    // The edge's 403 keeps its closed code and, for the per-token cap, names `grant_exhausted`
    // in `details`; surface that one as its own terminal code.
    if (value.error === 'subscription_unavailable' && isRecord(value.details) && value.details.reason === 'grant_exhausted') {
      return 'subscription_grant_exhausted'
    }
    return value.error.slice(0, 64).replace(/[^A-Za-z0-9_.:-]/g, '_')
  }
  return isRecord(value) && isRecord(value.error) && typeof value.error.code === 'string'
    ? value.error.code.slice(0, 64).replace(/[^A-Za-z0-9_.:-]/g, '_')
    : 'upstream_error'
}

/** A libuv error's code as a short closed token (an accept `EMFILE`, say); never its message. */
function errorCode(error: unknown): string {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined

  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,32}$/.test(code) ? code : 'unknown'
}

async function writeStream(response: ServerResponse, value: string): Promise<void> {
  if (response.write(value)) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', drained)
      response.off('close', closed)
      response.off('error', failed)
    }
    const drained = () => { cleanup(); resolve() }
    const closed = () => { cleanup(); reject(new Error('client_gone')) }
    const failed = () => { cleanup(); reject(new Error('client_gone')) }
    response.once('drain', drained)
    response.once('close', closed)
    response.once('error', failed)
  })
}

/** A prompt digest's first 12 hex digits, enough to match it to the `[agent]` line's full digest. */
function shortDigest(digest: string | undefined): string {
  return digest ? digest.replace(/^sha256:/, '').slice(0, 12) : 'none'
}

/**
 * The one line per admitted request (S1 demo step 1, SP-1): the task (the turn's invocation or
 * occurrence ID), the request's number in it, the alias, the outcome and the provider's token
 * counts, so a conversation's cache-read share is `cached` of turn 2's `call=1` over `prompt` of
 * turn 1's last call. Only IDs, a closed code, counts and digest prefixes: never content or a token.
 */
function logLine(record: BrokerRequestRecord): string {
  const tokens = record.promptTokens !== null
    ? ` prompt=${record.promptTokens} cached=${record.cachedTokens ?? 'none'} completion=${record.completionTokens ?? 'none'}`
    : ''
  const digests = record.systemDigest ? ` system=${shortDigest(record.systemDigest)} tools=${shortDigest(record.toolsDigest)}` : ''

  return `[broker] task=${record.taskId} grant=${record.grant} call=${record.request ?? 'none'} alias=${record.alias ?? 'none'} ` +
    `status=${record.status}${record.code ? ` code=${record.code}` : ''} ms=${record.endedAt - record.startedAt}` +
    `${record.finishReason ? ` finish=${record.finishReason}` : ''}${tokens}${digests}`
}

function usage(value: unknown): { prompt: number | null; completion: number | null; cached: number | null } {
  const record = isRecord(value) && isRecord(value.usage) ? value.usage : {}
  const details = isRecord(record.prompt_tokens_details) ? record.prompt_tokens_details : {}

  return {
    prompt: typeof record.prompt_tokens === 'number' ? record.prompt_tokens : null,
    completion: typeof record.completion_tokens === 'number' ? record.completion_tokens : null,
    cached: typeof details.cached_tokens === 'number' ? details.cached_tokens : null
  }
}

export class ModelBroker {
  private server: http.Server | null = null
  private readonly maxRequestBytes: number
  private readonly contextLength: number

  constructor(private readonly options: ModelBrokerOptions) {
    this.maxRequestBytes = options.maxRequestBytes ?? MAX_REQUEST_BYTES
    this.contextLength = options.contextLength ?? CONTEXT_LENGTH
  }

  async start(): Promise<AddressInfo> {
    if (this.server) {
      return this.server.address() as AddressInfo
    }

    const server = http.createServer((request, response) => {
      // Every response owns its transport errors for its whole lifetime, before admission too: a
      // denied response's small write can finish the route and still fail asynchronously while the
      // kernel flushes it after the client resets, and with no listener Node promotes the transport
      // error to an uncaught process error (#570's CI saw one such `write ECONNRESET`). An admitted
      // request adds its own listener in route that also aborts the upstream call.
      response.on('error', () => {})

      void this.route(request, response).catch(() => {
        if (!response.headersSent) {
          sendError(response, 500, 'broker_failed')
        } else {
          response.destroy()
        }
      })
    })

    server.headersTimeout = 30_000
    server.requestTimeout = 60_000

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.port, this.options.host, () => {
        server.off('error', reject)
        resolve()
      })
    })

    // The listening server keeps an 'error' listener of its own: an accept failure (EMFILE, say)
    // is not a peer reset, so the process guard would exit on it. Log one closed code and keep
    // serving; the accept backoff resumes by itself. Never a message or an address.
    server.on('error', error => {
      this.options.log?.(`[broker] server_error code=${errorCode(error)}`)
    })

    this.server = server

    return server.address() as AddressInfo
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null

    if (server) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = bearer(request.headers.authorization)
    const path = (request.url ?? '').split('?')[0]

    if (request.method === 'POST' && path === '/v1/google' && this.options.google) {
      await this.options.google.handle(request, response)
      return
    }

    // One attachment as raw bytes: tool JSON never carries file contents.
    if (request.method === 'POST' && path === MATRIX_GOOGLE_ATTACHMENT_PATH && this.options.google) {
      await this.options.google.handleAttachment(request, response)
      return
    }

    if (request.method === 'GET' && path === '/v1/models') {
      const checked = this.options.grants.check(token, request.socket.remoteAddress)

      if (checked.ok === false) {
        sendError(response, DENIAL_STATUS[checked.reason], `model_grant_${checked.reason}`)

        return
      }

      send(response, 200, {
        object: 'list',
        data: checked.grant.aliases.map(id => ({
          id,
          object: 'model',
          created: 0,
          owned_by: 'atum',
          context_length: checked.grant.contextLength ?? this.contextLength,
          max_output_tokens: checked.grant.maxOutputTokens
        }))
      })

      return
    }

    if (request.method !== 'POST' || path !== '/v1/chat/completions') {
      sendError(response, 404, 'route_not_found')

      return
    }

    const startedAt = Date.now()
    // This admission intentionally precedes body reading and projection: it bounds concurrent
    // slow/oversized request bodies. `maxRequests` is a local admission-attempt limit, not a
    // wallet debit, so a rejected projection never reaches an upstream provider or charge.
    const began = this.options.grants.begin(token, request.socket.remoteAddress)

    if (began.ok === false) {
      request.resume()
      sendError(response, DENIAL_STATUS[began.reason], `model_grant_${began.reason}`)
      this.options.log?.(`[broker] refused code=model_grant_${began.reason}`)

      return
    }

    const { admission } = began
    const record: BrokerRequestRecord = {
      grant: admission.grant.handle,
      taskId: admission.grant.taskId,
      request: admission.request,
      alias: null,
      startedAt,
      endedAt: startedAt,
      status: 0,
      code: null,
      stream: false,
      requestBytes: 0,
      promptTokens: null,
      completionTokens: null
    }

    let tokenReservation: ReturnType<ModelGrantRegistry['reserveTokens']> = null

    // A sandbox that hangs up has abandoned its request: stop the upstream call too.
    const hungUp = new AbortController()
    // A small write can return true and still fail later while the kernel flushes it.
    // Keep this listener for the response's whole lifetime: removing it when the
    // route promise settles turns a late ECONNRESET/EPIPE into an uncaught process
    // exception. The close path below remains the authoritative upstream abort.
    response.on('error', () => {
      if (!response.writableFinished) {
        hungUp.abort(new Error('client_gone'))
      }
    })
    response.once('close', () => {
      if (!response.writableFinished) {
        hungUp.abort(new Error('client_gone'))
      }
    })

    let upstreamAccepted = false
    let refundUnused = false
    try {
      const { value, bytes } = await readBounded(request, this.maxRequestBytes)
      record.requestBytes = bytes

      const subscription = admission.grant.source !== 'atum'
      const upstream = admission.grant.source === 'opencode_go'
        ? this.options.subscription
        : admission.grant.source === 'chatgpt_plan' ? this.options.chatgptRelay : this.options.upstream
      let localRefusal: string | undefined
      let projected: ReturnType<typeof projectRequest>
      try {
        projected = projectRequest(value, admission.grant)
      } catch (error) {
        if (!subscription || !admission.grant.subscriptionFallback || !upstream?.fallback ||
            !(error instanceof BrokerError) || error.code !== 'model_alias_not_granted') throw error
        // Validate the rest of the envelope with the granted model. Never pass an
        // ungranted alias to the subscription, nor relabel its token as managed funding.
        projected = projectRequest({ ...(value as JsonRecord), model: admission.grant.aliases[0] }, admission.grant)
        localRefusal = error.code
      }
      record.alias = projected.body.model as string
      record.stream = projected.stream
      Object.assign(record, promptDigests(projected.body))
      if (admission.grant.runTokenBudget) {
        // Estimate a fresh uncached request; settle against provider usage with cache reads
        // weighted at 1/10. Small framing avoids charging tool schemas once per message.
        // Strip media payloads (including base64) and reserve a per-image allowance.
        let images = 0
        const serialized = JSON.stringify({ messages: projected.body.messages, tools: projected.body.tools }, (key, value) => {
          if (value && typeof value === 'object' && value.type === 'image_url') {
            images++
            return { type: 'image_url' }
          }
          return value
        })
        const messages = projected.body.messages as unknown[]
        const tools = Array.isArray(projected.body.tools) ? projected.body.tools : []
        const inputBound = Math.min(admission.grant.contextLength ?? Number.MAX_SAFE_INTEGER,
          Math.ceil(serialized.length / 3) + 16 * messages.length + 64 * tools.length + 1024 + 4096 * images)
        try { tokenReservation = this.options.grants.reserveTokens(token!, inputBound, Number(projected.body.max_tokens)) }
        catch { throw new BrokerError(403, 'roundup_budget_unavailable') }
        if (!tokenReservation) throw new BrokerError(403, 'roundup_token_ceiling')
        projected.body.max_tokens = tokenReservation.output
      }

      const signal = AbortSignal.any([admission.signal, hungUp.signal])
      if (!upstream) throw new BrokerError(admission.grant.source === 'chatgpt_plan' ? 403 : 502, admission.grant.source === 'chatgpt_plan'
        ? 'subscription_relay_offline' : 'subscription_unavailable')
      let result: UpstreamStreamResponse
      if (projected.stream && !subscription && upstream.stream) {
        result = await upstream.stream({ body: projected.body, grant: admission.grant, token: token!, signal })
        if ('events' in result) {
          if (result.status < 200 || result.status >= 300) throw new Error('upstream_stream_invalid')
          response.writeHead(200, {
            'cache-control': 'no-store', connection: 'keep-alive',
            'content-type': 'text/event-stream; charset=utf-8'
          })
          let done = false
          for await (const event of result.events) {
            upstreamAccepted = true
            if ('done' in event) {
              done = true
              await writeStream(response, 'data: [DONE]\n\n')
              continue
            }
            if (done || !isRecord(event.data)) throw new Error('upstream_stream_invalid')
            if (isRecord(event.data.error)) {
              const code = upstreamCode(event.data)
              record.status = 502
              record.code = code
              await writeStream(response, `data: ${JSON.stringify({ error: { message: code, type: 'atum_broker_error', code } })}\n\n`)
              response.end()
              return
            }
            const finish = choiceFinish(event.data)
            if (finish) record.finishReason = finish
            const counted = usage(event.data)
            if (counted.prompt !== null) record.promptTokens = counted.prompt
            if (counted.completion !== null) record.completionTokens = counted.completion
            if (counted.cached !== null) record.cachedTokens = counted.cached
            const value: JsonRecord = { ...event.data, model: projected.body.model }
            const usageOnly = Array.isArray(value.choices) && value.choices.length === 0 && isRecord(value.usage)
            if (!projected.includeUsage) delete value.usage
            if (!usageOnly || projected.includeUsage) await writeStream(response, `data: ${JSON.stringify(value)}\n\n`)
          }
          if (!done) throw new Error('upstream_stream_incomplete')
          record.status = 200
          response.end()
          return
        }
      } else {
        const { stream_options: _streamOptions, ...completionBody } = projected.body
        // The subscription edge is non-streaming: ask it for one completion and let the broker
        // synthesize the sandbox's SSE from it. Managed recovery requires the controller's
        // explicit authority exchange, including local alias refusals.
        const call = { body: { ...completionBody, stream: false }, grant: admission.grant, token: token!, signal }
        result = localRefusal ? await upstream.fallback!(call, localRefusal) : await upstream.complete(call)
      }

      upstreamAccepted = true
      refundUnused = result.status < 200 || result.status >= 300
      const counted = usage(result.json)
      record.promptTokens = counted.prompt
      record.completionTokens = counted.completion
      record.cachedTokens = counted.cached
      record.finishReason = choiceFinish(result.json)

      if (admission.signal.aborted) {
        throw new BrokerError(503, 'model_grant_revoked')
      }

      if (result.status >= 200 && result.status < 300 && isRecord(result.json) && Array.isArray(result.json.choices)) {
        record.status = 200
        const answer = { ...result.json, model: projected.body.model }

        if (projected.stream) {
          streamAnswer(response, answer, projected.includeUsage)
        } else {
          send(response, 200, answer)
        }

        return
      }

      // An upstream refusal keeps its closed code; its text is not relayed.
      const code = upstreamCode(result.json)

      // A terminal subscription refusal is 403 to the sandbox whatever the edge's status was.
      // Hermes retries 409/429/5xx; one subscription token can already have spent a call, so a
      // retry could double-charge the owner's plan. 403 ends the turn with the closed code, and
      // the controller publishes its one short failure line.
      const status = subscription && SUBSCRIPTION_TERMINAL_CODES.has(code)
        ? 403
        : result.status >= 400 && result.status < 600 ? result.status : 502
      record.status = status
      record.code = code
      sendError(response, status, code)
    } catch (error) {
      const failure =
        error instanceof BrokerError
          ? error
          : admission.signal.aborted
            ? new BrokerError(503, 'model_grant_revoked')
            : error instanceof Error && STREAM_FAILURE_CODES.has(error.message)
              ? new BrokerError(502, error.message)
            : new BrokerError(502, 'upstream_unavailable')

      record.status = failure.status
      record.code = failure.code

      if (!response.headersSent && !response.destroyed) {
        sendError(response, failure.status, failure.code)
      } else if (!response.writableEnded && !response.destroyed) {
        response.destroy()
      }
    } finally {
      const prompt = record.promptTokens
      const cached = Math.min(prompt ?? 0, Math.max(0, record.cachedTokens ?? 0))
      const weighted = prompt === null ? null : Math.ceil(prompt - cached + cached / 10)
      const refund = !upstreamAccepted || refundUnused
      try { tokenReservation?.settle(weighted ?? (refund ? 0 : null), record.completionTokens ?? (refund ? 0 : null)) }
      catch { this.options.log?.('[broker] roundup_budget_persist_failed') }
      finally { admission.end() }
      record.endedAt = Date.now()
      this.options.onRecord?.(record)
      this.options.log?.(logLine(record))
    }
  }
}
