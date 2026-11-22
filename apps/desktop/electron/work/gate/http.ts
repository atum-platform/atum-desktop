import type { IncomingMessage, ServerResponse } from 'node:http'

import { z } from 'zod'

import { answerForRow, envelope, TOOL_DESCRIPTIONS } from './answers'
import type { AssertionResult } from './assertion'
import {
  admissionStatus,
  WORK_GATE_PATH,
  WORK_REQUEST_BODY_MAX_BYTES,
  WORK_TOOL_ARGUMENTS,
  WORK_TOOLS,
  type WorkAdmissionErrorType,
  type WorkGateId,
  type WorkLaunchArguments,
  type WorkTool
} from './contract'
import { type CallContext, GateAdmissionError, type WorkGate } from './gate'
import type { GateHandler } from './socket'

// The Work gate's HTTP face: the fifteen admission checks, in the contract's order, then MCP plain request and
// reply. The first failure answers. Checks 1 to 5 run without parsing any credential. Admission failures are HTTP
// errors with a typed body and are never receipts; every tool outcome, a refusal included, is HTTP 200 with a tool
// result. Logs carry ids and typed reasons only: never a header, an assertion, a grant, a prompt or a reply body.

export interface GateHttpOptions {
  gate: WorkGate
  verifier: { verify(token: string): Promise<AssertionResult> }
  /** The enrollment's Work hostname, or undefined while this Mac is not enrolled. */
  hostname(): string | undefined
  log?(event: string, fields?: Record<string, string | number | boolean | null>): void
}

const DRAIN_MAX_BYTES = 1_048_576
const DRAIN_MAX_MS = 2000

const JSON_RPC_METHODS = new Set(['initialize', 'ping', 'tools/list', 'tools/call'])

function send(response: ServerResponse, status: number, gateId: WorkGateId, body: unknown): void {
  const text = body === undefined ? '' : JSON.stringify(body)

  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-gate-id': `${gateId.deviceServiceId}.${gateId.accountId}.${gateId.routeEpoch}`
  })
  response.end(text)
}

/** Read and drop the rest of a request, up to a bound. Resolves true when the whole body was consumed. */
function drain(request: IncomingMessage, maxBytes: number, maxMs: number): Promise<boolean> {
  return new Promise(resolve => {
    if (request.complete) {
      request.resume()
      resolve(true)

      return
    }

    let size = 0

    const done = (finished: boolean) => {
      clearTimeout(timer)
      request.off('data', onData)
      resolve(finished)
    }

    const onData = (chunk: Buffer) => {
      size += chunk.length

      if (size > maxBytes) {
        done(false)
      }
    }

    const timer = setTimeout(() => done(false), maxMs)

    request.on('data', onData)
    request.once('end', () => done(true))
    request.once('error', () => done(false))
    request.resume()
  })
}

function readBounded(request: IncomingMessage, max: number): Promise<Buffer | undefined> {
  return new Promise(resolve => {
    const declared = Number(request.headers['content-length'] ?? 0)

    if (declared > max) {
      request.resume()
      resolve(undefined)

      return
    }

    const chunks: Buffer[] = []
    let size = 0
    let over = false

    request.on('data', (chunk: Buffer) => {
      size += chunk.length

      if (size > max) {
        over = true
        chunks.length = 0

        return
      }

      if (!over) {
        chunks.push(chunk)
      }
    })
    request.on('end', () => resolve(over ? undefined : Buffer.concat(chunks)))
    request.on('error', () => resolve(undefined))
  })
}

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name]

  return Array.isArray(value) ? value[0] : value
}

/** `CF_Authorization=<assertion>` and nothing else: Access adds that cookie itself when strict mode is off. */
function cookieAllowed(raw: string | undefined, assertion: string | undefined): boolean {
  if (raw === undefined) {
    return true
  }

  const match = /^CF_Authorization=([^;\s]+)$/u.exec(raw.trim())

  return Boolean(match && assertion !== undefined && match[1] === assertion)
}

type Answer = { class?: string }

export const TOOL_LIST = WORK_TOOLS.map(name => ({
  name,
  description: TOOL_DESCRIPTIONS[name],
  inputSchema: z.toJSONSchema(WORK_TOOL_ARGUMENTS[name], { target: 'draft-7' })
}))

export function createGateHandler(options: GateHttpOptions): GateHandler {
  const { gate } = options

  return async (request, response) => {
    const gateId = gate.gateId()

    const fail = async (type: WorkAdmissionErrorType, detail?: string): Promise<void> => {
      // an early refusal does not parse the body, but a small one is read out first so the reply is never lost to a reset
      const finished = await drain(request, DRAIN_MAX_BYTES, DRAIN_MAX_MS)

      options.log?.('admission_refused', { type, ...(detail ? { detail } : {}) })
      send(response, admissionStatus(type), gate.gateId(), { gateId: gate.gateId(), error: { type } })

      if (!finished) {
        response.once('finish', () => request.socket?.destroy())
      }
    }

    // 1-3: host, path, method (no credential parsed yet)
    const hostname = options.hostname()
    const host = (header(request, 'host') ?? '').replace(/:\d+$/u, '').toLowerCase()

    if (!hostname || host !== hostname.toLowerCase()) {
      return fail('wrong_host')
    }

    if (request.url !== WORK_GATE_PATH) {
      return fail('no_route')
    }

    if (request.method !== 'POST') {
      return fail('method_not_allowed')
    }

    // 4: a browser sends Origin; the agent's runtime does not
    if (request.headers.origin !== undefined) {
      return fail('origin_header')
    }

    // 5-7: the cookie rule, then the signed assertion
    const assertion = header(request, 'cf-access-jwt-assertion')

    if (!cookieAllowed(header(request, 'cookie'), assertion)) {
      return fail('cookie')
    }

    if (!assertion) {
      return fail('no_assertion')
    }

    const verified = await options.verifier.verify(assertion)

    if (verified.ok === false) {
      return fail('bad_assertion', verified.detail)
    }

    // 8-11: the grant, the counters, the list
    const bearer = /^Bearer (\S+)$/u.exec(header(request, 'authorization') ?? '')?.[1]

    if (!bearer) {
      return fail('no_grant')
    }

    const grant = gate.checkGrant(bearer)

    if (grant.ok === false) {
      return fail(grant.error)
    }

    const ctx = grant.ctx

    // 12-15: the body
    const raw = await readBounded(request, WORK_REQUEST_BODY_MAX_BYTES)

    if (!raw) {
      return fail('body_too_large')
    }

    let body: unknown

    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      return fail('bad_request')
    }

    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      (body as { jsonrpc?: unknown }).jsonrpc !== '2.0' ||
      typeof (body as { method?: unknown }).method !== 'string'
    ) {
      return fail('bad_request')
    }

    const rpc = body as { id?: unknown; method: string; params?: unknown }

    if (rpc.id === undefined && rpc.method.startsWith('notifications/')) {
      response.writeHead(202, {
        'cache-control': 'no-store',
        'x-gate-id': `${gateId.deviceServiceId}.${gateId.accountId}.${gateId.routeEpoch}`
      })
      response.end()

      return
    }

    const idOk =
      typeof rpc.id === 'string'
        ? rpc.id.length >= 1 && rpc.id.length <= 64
        : Number.isSafeInteger(rpc.id) && (rpc.id as number) >= 0

    if (!JSON_RPC_METHODS.has(rpc.method) || !idOk) {
      return fail('bad_request')
    }

    const reply = (result: unknown) => send(response, 200, gate.gateId(), { jsonrpc: '2.0', id: rpc.id, result })

    if (rpc.method === 'initialize') {
      return reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'atum-work-gate', version: '1' },
        gateId: gate.gateId()
      })
    }

    if (rpc.method === 'ping') {
      return reply({})
    }

    if (rpc.method === 'tools/list') {
      return reply({ tools: TOOL_LIST, gateId: gate.gateId() })
    }

    const params = rpc.params as { name?: unknown; arguments?: unknown } | undefined

    if (!params || typeof params !== 'object' || typeof params.name !== 'string') {
      return fail('bad_request')
    }

    if (!(WORK_TOOLS as readonly string[]).includes(params.name)) {
      return fail('tool_not_allowed')
    }

    const tool = params.name as WorkTool
    const parsed = WORK_TOOL_ARGUMENTS[tool].safeParse(params.arguments ?? {})

    try {
      const answer = parsed.success
        ? await run(gate, ctx, tool, parsed.data)
        : tool === 'send'
          ? await gate.relay.send(ctx, params.arguments)
          : shapeAnswer(gate, ctx, tool, params.arguments, parsed.error)

      // Step 2, at the moment of release: the check and the write below are one synchronous section.
      const released = gate.silence(ctx, answer, () => revokedAnswer(gate, ctx, tool, params.arguments))

      send(response, 200, gate.gateId(), { jsonrpc: '2.0', id: rpc.id, result: envelope(released) })
      options.log?.('tool', { tool, outcome: released.class ?? 'ok' })
    } catch (error) {
      if (error instanceof GateAdmissionError) {
        return fail(error.type)
      }

      options.log?.('tool_failed', { tool })

      return fail('internal')
    }
  }
}

async function run(gate: WorkGate, ctx: CallContext, tool: WorkTool, args: unknown): Promise<Answer> {
  switch (tool) {
    case 'send':
      return gate.relay.send(ctx, args)

    case 'close':
      return gate.relay.closeReceipt(ctx, (args as { request_id: string }).request_id)
    case 'status': {
      return gate.relay.status(ctx, (args as { room_id: string }).room_id)
    }

    case 'launch':
      return gate.launch(ctx, args as WorkLaunchArguments)

    case 'interrupt':
      return gate.interrupt(ctx, args as { threadId: string })

    case 'read':
      return 'request_id' in (args as object)
        ? gate.relay.read(ctx, (args as { request_id: string }).request_id)
        : gate.read(ctx, args as { threadId: string })

    case 'wait':
      return 'request_id' in (args as object)
        ? gate.relay.read(ctx, (args as { request_id: string }).request_id, (args as { timeoutMs?: number }).timeoutMs)
        : gate.wait(ctx, args as { threadId: string; timeoutMs?: number })

    case 'list':
      return gate.list(ctx, args as { limit?: number; cursor?: string })

    case 'request':
      return 'request_id' in (args as object)
        ? gate.relay.request(ctx, (args as { request_id: string }).request_id)
        : gate.request(ctx, args as { requestId: string; action: 'status' | 'void' })
  }
}

/** A body that fails the schema: refused, not trimmed. Only a launch with a usable request id gets a receipt. */
function shapeAnswer(gate: WorkGate, ctx: CallContext, tool: WorkTool, rawArgs: unknown, error: z.ZodError): Answer {
  const requestId = (rawArgs as { requestId?: unknown } | undefined)?.requestId
  const idOk = typeof requestId === 'string' && /^[A-Za-z0-9_-]{22,64}$/u.test(requestId)

  if (tool === 'launch' && idOk) {
    const unknown = error.issues.some(issue => issue.code === 'unrecognized_keys')

    return gate.shapeRefusal(ctx, requestId as string, unknown ? 'unknown_field' : 'invalid_field')
  }

  if (tool === 'request' || tool === 'launch') {
    throw new GateAdmissionError('bad_request')
  }

  return { gateId: gate.gateId(), class: 'refused', reason: 'invalid_arguments' } as Answer
}

function revokedAnswer(gate: WorkGate, ctx: CallContext, tool: WorkTool, rawArgs: unknown): Answer {
  const gateId = gate.gateId()
  const scope = gate.revokedScope(ctx)
  const args = rawArgs as { requestId?: string; request_id?: string; threadId?: string } | undefined

  if (typeof args?.request_id === 'string') return {gateId, requestId: args.request_id, class: 'revoked', receipt: 'revoked', stopConfirmed: false} as Answer

  if ((tool === 'launch' || tool === 'request') && typeof args?.requestId === 'string') {
    return { gateId, requestId: args.requestId, class: 'revoked', receipt: 'revoked', scope } as Answer
  }

  return {
    gateId,
    class: 'revoked',
    scope,
    ...(typeof args?.threadId === 'string' ? { threadId: args.threadId } : {})
  } as Answer
}

export { answerForRow }
