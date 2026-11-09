import { timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { MATRIX_GOOGLE_PROTECTED_MODEL } from '../../shared/matrix-google-tools'
import {
  MATRIX_CHECK_IN_MODEL_ALIAS,
  MATRIX_DEFAULT_EFFORT,
  MATRIX_MODEL_EFFORTS,
  type MatrixEffort,
  type MatrixModelId,
  matrixRequestEffort,
  matrixRequestModel
} from '../../shared/matrix-models'
import { type MatrixStoreRunJob, matrixStoreRunJob } from '../../shared/matrix-store-schedules'

import {
  MATRIX_BACKGROUND_SWEEP_MODEL_ALIAS,
  type MatrixBackgroundSweepManagedCall
} from './background-sweep-model'

// The managed context is the line-up's 1M tokens (LB9), roughly 4 MB of prompt text before Hermes
// compacts, so a 4 MiB cap could refuse a long conversation outright. Aligned with the cloud broker's
// 16 MiB request ceiling; the gateway itself has no general body cap. A loopback memory guard, not a
// pricing rule (the gateway prices and holds every call).
const MAX_REQUEST_BYTES = 16 * 1024 * 1024
const AGENT_PRINCIPAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
/**
 * Output caps to try when the gateway refuses a completion's hold for the balance (FR13). The
 * gateway reserves the prompt plus the full output cap (16,384 tokens) with a margin, so the
 * last few hundred Protons could never pay for an answer. A refused hold spends nothing, so
 * the proxy asks again with a smaller cap, down to a floor that still leaves room for an
 * answer after a model's reasoning tokens. The gateway still holds the worst case of each.
 */
export const MATRIX_MANAGED_OUTPUT_STEPS = [8192, 4096, 2048, 1024] as const
/** The readiness probe's whole budget: through this proxy, the gateway and back. */
export const MATRIX_MANAGED_PROBE_TIMEOUT_MS = 10_000

/** Closed codes for the readiness step; the loading screen and banner map them to copy. */
export type MatrixManagedProbe =
  | { ok: true; code?: undefined }
  | { ok: false; code: 'setup_required' | 'sign_in_required' | 'out_of_protons' | 'ai_unavailable' }

const ROUTES = new Map([
  ['GET /v1/models', '/v1/models'],
  ['POST /v1/chat/completions', '/v1/chat/completions']
])

export interface MatrixManagedModelOptions {
  /** Gateway origin, e.g. https://gateway.atumplatform.com (no trailing slash). */
  gateway: string
  /** Fixed loopback port, so Hermes's saved endpoint stays valid across launches. 0 picks one (tests). */
  port: number
  /** The local keys Hermes may present, one per ready agent executor, each with the agent
   * it belongs to ( §2.5). None while no
   * executor is ready. */
  keys: () => Iterable<readonly [key: string, agent: string]>
  /** The person's current domain token; `refresh` forces a refresh. Null means sign in again. */
  bearer: (refresh: boolean) => Promise<string | null>
  /** The agent principal the gateway attributes this key's model calls to (daily cap,
   * `X-Atum-Agent`). Main derives it from the enrollment, never from a request: Hermes
   * headers are not forwarded, and the gateway still checks the principal belongs to the
   * person whose bearer authenticates the call. Undefined (not yet enrolled, or not a
   * UUID) sends no header, which the gateway admits unattributed, never a guess. A pet
   * hatch is a subsidy and carries none. */
  agentPrincipal?: (agent: string) => string | undefined
  /** The model the agent's running turn was sent with (its conversation's choice), else the
   * default. */
  model: (agent: string) => MatrixModelId
  /** The thinking level the running turn was sent with, if the person chose one. Sent as
   * `reasoning_effort` on the turn's own calls, never on check-ins, Store runs or hatches. */
  effort?: (agent: string) => MatrixEffort | undefined
  /** Native derives this from the running turn and a server-minted opaque task.
   * Incoming Hermes headers never supply execution or Store authority. */
  training?: (
    agent: string,
    signal: AbortSignal
  ) => Promise<{
    taskId: string
    assistantId: string
    executorId: string
    conversationId: string
    leaseToken?: string
    invocationId?: string
  } | null>
  /** A short-lived, main-owned pet hatch. The gateway supplies only an opaque
   * operation header; main proves it is the current account/agent operation.
   * Ordinary Hermes requests cannot opt into this branch. */
  hatch?: (agent: string, operationId: string, key: string, signal: AbortSignal) => boolean | Promise<boolean>
  /** Classifies an active main-owned hatch key before any ordinary model or
   * Store-training path is considered. A hatch key has no general model
   * authority: it must carry a separately validated operation header. */
  hatchKey?: (agent: string, key: string) => boolean
  /** A paid assistant's scheduled run (a Store job: its calls name the job's own model,
   * `matrixStoreRunModel`, store-schedules.ts). Main binds it to the Store for the
   * assistant's home room, only on the Mac holding its answering lease and once per household
   * for the job's scheduled slot. Null: the call is answered here with silence, never
   * forwarded and never charged, so only one Mac's run reaches the model and nothing posts
   * twice. A throw refuses it (the Store refused the task): it is never sent unbound. */
  scheduledRun?: (
    agent: string,
    job: MatrixStoreRunJob,
    signal: AbortSignal
  ) => Promise<{
    taskId: string
    assistantId: string
    executorId: string
    conversationId: string
    leaseToken?: string
    invocationId?: string
  } | null>
  /** Takes the one model call a check-in this Mac just claimed may make (check-ins.ts), for
   * this agent. False: the request is answered here with silence, never forwarded and never
   * charged, so a check costs at most one call whatever Hermes retries or continues. */
  checkInCall?: (agent: string) => boolean
  /** Consumes the one platform-authorized Atum call of a native background sweep. */
  sweepCall?: (agent: string) => MatrixBackgroundSweepManagedCall | null
  /** The Google fence (G2-19) for this agent's model calls: `open` leaves them alone;
   * `protected` sends every one, whatever model it names, to the protected alias; `refused`
   * answers 503 without reaching the gateway, because the agent may hold Google data and
   * the protected route isn't served. Main derives it from the agent's Google latch. A pet
   * hatch is exempt: its prompt is the person's own pet description, never chat or memory.
   * A check-in is not: the call it may make goes the same way as the agent's turns. */
  route?: (agent: string) => 'open' | 'protected' | 'refused'
}

/**
 * Loopback bridge from Hermes to Atum's gateway, like the old app's managed-model
 * proxy. Hermes stores only a local key for this port. The person's domain token is
 * added here per request and never written to the Hermes profile. Only the model
 * list and chat completions are forwarded; the gateway holds and settles Protons.
 *
 * The conversation's model is applied here too. Hermes restores each conversation's stored
 * model name when it resumes it, so a completion names whatever Atum model that
 * conversation started on (even the retired `binh-minh`); this proxy sends it to the model
 * the running turn was sent with. Each agent's Hermes has its own key, so the key names the
 * agent, and each agent serves one turn at a time (its turn lock), so "the agent's running
 * turn" is unambiguous even while several agents answer at once.
 */
export class MatrixManagedModel {
  private server: Server | undefined
  private port: number

  constructor(private readonly options: MatrixManagedModelOptions) {
    this.port = options.port
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`
  }

  async start(): Promise<void> {
    if (this.server) {
      return
    }

    const server = createServer((request, response) => void this.handle(request, response))
    const listening = once(server, 'listening')
    server.listen(this.options.port, '127.0.0.1')
    await Promise.race([listening, once(server, 'error').then(([error]) => Promise.reject(error))])
    this.port = (server.address() as AddressInfo).port
    this.server = server
  }

  /**
   * The readiness gate's and watch's AI check (plan 2026-09-26-reliable-local-first-chat
   * §4.5): `GET /v1/models` through this very proxy with Hermes's local key, so the local
   * key, the person's token, the gateway and the platform identity are all exercised. It
   * costs nothing. A 200 is the only success. (Accepted false positive: the provider
   * behind the gateway is down; the per-turn watchdog turns that into a plain state.)
   */
  async probe(agent: string, signal?: AbortSignal): Promise<MatrixManagedProbe> {
    const key = Array.from(this.options.keys()).find(entry => entry[1] === agent)?.[0]

    if (!this.server || !key) {
      return { ok: false, code: 'setup_required' }
    }

    const bound = AbortSignal.timeout(MATRIX_MANAGED_PROBE_TIMEOUT_MS)

    // node:http, not fetch: this is a loopback call, independent of the upstream client.
    const answer = await new Promise<{ status: number; body: string }>(resolve => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: this.port,
          method: 'GET',
          path: '/v1/models',
          headers: { Authorization: `Bearer ${key}` },
          signal: signal ? AbortSignal.any([signal, bound]) : bound
        },
        response => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', chunk => {
            // The code is all that matters; never hold a large body.
            body = (body + chunk).slice(0, 4096)
          })
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
          response.on('error', () => resolve({ status: 0, body: '' }))
        }
      )

      request.on('error', () => resolve({ status: 0, body: '' }))
      request.end()
    })

    if (answer.status === 200) {
      return { ok: true }
    }

    if (answer.status === 402) {
      return { ok: false, code: 'out_of_protons' }
    }

    if (answer.status === 401) {
      return { ok: false, code: answer.body.includes('atum_sign_in_required') ? 'sign_in_required' : 'setup_required' }
    }

    return { ok: false, code: 'ai_unavailable' }
  }

  /**
   * Whether the gateway serves `model` for this person: its `/v1/models` list, read with their
   * own token, straight from the gateway (no agent key needed). Null when it couldn't tell
   * (offline, signed out, a gateway error): callers treat that as "not served".
   */
  async servesModel(model: string, signal?: AbortSignal): Promise<boolean | null> {
    const bound = AbortSignal.timeout(MATRIX_MANAGED_PROBE_TIMEOUT_MS)

    for (const refresh of [false, true]) {
      const bearer = await this.options.bearer(refresh).catch(() => null)

      if (!bearer) {
        return null
      }

      let response: Response

      try {
        response = await fetch(`${this.options.gateway}/v1/models`, {
          redirect: 'error',
          headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
          signal: signal ? AbortSignal.any([signal, bound]) : bound
        })
      } catch {
        return null
      }

      if (response.status === 401 && !refresh) {
        await response.body?.cancel().catch(() => {})

        continue
      }

      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {})

        return null
      }

      try {
        const text = await response.text()

        if (text.length > 1024 * 1024) {
          return null
        }

        const list = (JSON.parse(text) as { data?: unknown }).data

        return Array.isArray(list) && list.some(entry => (entry as { id?: unknown } | null)?.id === model)
      } catch {
        return null
      }
    }

    return null
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined

    if (server) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const fail = (status: number, code: string) => {
      if (!response.headersSent) {
        response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      }

      response.end(JSON.stringify({ error: { message: code, type: code, code } }))
    }

    // Browsers cannot use this: no CORS answers, an exact Host (no DNS rebinding), a key.
    if (request.headers.origin !== undefined || request.headers.host !== `127.0.0.1:${this.port}`) {
      return fail(403, 'atum_forbidden')
    }

    const supplied = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
    let agent: string | undefined

    // Every key of the same length is compared in full, so the time taken never tells
    // which one matched.
    for (const [key, owner] of this.options.keys()) {
      if (key && supplied.length === key.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(key))) {
        agent ??= owner
      }
    }

    if (agent === undefined) {
      return fail(401, 'atum_unauthorized')
    }

    const route = ROUTES.get(`${request.method} ${(request.url ?? '').split('?')[0]}`)

    if (!route) {
      return fail(404, 'atum_not_found')
    }

    let isHatchKey = false

    try {
      isHatchKey = Boolean(this.options.hatchKey?.(agent, supplied))
    } catch {
      // Key classification is an authority boundary. An unavailable main
      // state must not turn an ephemeral hatch credential into a normal one.
      return fail(403, 'atum_pet_hatch_denied')
    }

    if (isHatchKey && (request.method !== 'POST' || request.headers['x-atum-pet-operation'] === undefined)) {
      return fail(403, 'atum_pet_hatch_denied')
    }

    let body: Buffer | undefined

    let hatchOperation: string | undefined
    // A check-in (cron/check_ins.py) names its own model: the everyday one, whatever turn is
    // running, and never billed to that turn's Store task.
    let checkIn = false
    let sweep: MatrixBackgroundSweepManagedCall | null = null
    // A paid assistant's scheduled run, bound here to the Store or answered with silence.
    let scheduled: Awaited<ReturnType<NonNullable<MatrixManagedModelOptions['scheduledRun']>>> = null

    if (request.method === 'POST') {
      body = await readBody(request, MAX_REQUEST_BYTES)

      if (!body) {
        return fail(413, 'atum_request_too_large')
      }

      checkIn = requestField(body, 'model') === MATRIX_CHECK_IN_MODEL_ALIAS

      if (requestField(body, 'model') === MATRIX_BACKGROUND_SWEEP_MODEL_ALIAS) {
        try {
          sweep = this.options.sweepCall?.(agent) ?? null
        } catch {
          sweep = null
        }

        if (!sweep) {
          return fail(403, 'atum_background_sweep_denied')
        }
      }

      const requestedOperation = request.headers['x-atum-pet-operation']

      if (requestedOperation !== undefined) {
        const operationId = typeof requestedOperation === 'string' ? requestedOperation : ''
        let active = false

        try {
          active = Boolean(
            operationId && (await this.options.hatch?.(agent, operationId, supplied, new AbortController().signal))
          )
        } catch {
          active = false
        }

        if (!active) {
          return fail(403, 'atum_pet_hatch_denied')
        }

        hatchOperation = operationId
        body = withHatchModel(body)
      } else if (sweep) {
        let currentRoute: ReturnType<NonNullable<MatrixManagedModelOptions['route']>> = 'open'

        try {
          currentRoute = this.options.route?.(agent) ?? 'open'
        } catch {
          currentRoute = 'refused'
        }

        if (currentRoute === 'refused' || (currentRoute === 'protected' && sweep.protection !== 'google_protected')) {
          return fail(503, 'atum_google_route_unavailable')
        }

        body = sweep.protection === 'google_protected'
          ? withProtectedModel(body)
          : withSweepModel(body, sweep.model, sweep.effort)

        if (!body) {
          return fail(400, 'atum_google_route_invalid')
        }
      } else {
        if (checkIn && !this.options.checkInCall?.(agent)) {
          return answerSilently(response, requestField(body, 'stream') === true)
        }

        const requested = requestField(body, 'model')
        const storeJob = matrixStoreRunJob(requested)

        if (storeJob !== undefined) {
          // A Store run model this build does not know (null) is never bound: silence.
          try {
            scheduled = storeJob
              ? ((await this.options.scheduledRun?.(agent, storeJob, AbortSignal.timeout(60_000))) ?? null)
              : null
          } catch {
            return fail(403, 'atum_store_execution_denied')
          }

          if (!scheduled) {
            return answerSilently(response, requestField(body, 'stream') === true, String(requested))
          }

          // It runs on the assistant's own Atum model, like its turns, but never at a thinking
          // level: the person chose that for their own conversation, not for a paid job.
          body = withNamedModel(body, this.options.model(agent))
        }

        // Only the person's own turn takes the level they chose; a Store run never does.
        const effort = scheduled ? undefined : this.options.effort?.(agent)

        let fence: ReturnType<NonNullable<MatrixManagedModelOptions['route']>> = 'open'

        try {
          fence = this.options.route?.(agent) ?? 'open'
        } catch {
          // The fence is an authority boundary: an unreadable policy never opens it.
          fence = 'refused'
        }

        if (fence === 'refused') {
          return fail(503, 'atum_google_route_unavailable')
        }

        body =
          fence === 'protected'
            ? withProtectedModel(body)
            : withModel(body, this.options.model(agent), effort, !scheduled)

        if (!body) {
          return fail(400, 'atum_google_route_invalid')
        }
      }
    }

    // Hermes cancelling its request cancels the gateway call, which releases the hold.
    const abort = new AbortController()
    response.on('close', () => abort.abort())
    let upstream: Response | undefined
    let training: Awaited<ReturnType<NonNullable<MatrixManagedModelOptions['training']>>> = null

    if (scheduled) {
      training = scheduled
    } else if (body && !hatchOperation && !checkIn && !sweep && this.options.training) {
      try {
        training = await this.options.training(agent, abort.signal)
      } catch {
        return fail(403, 'atum_store_execution_denied')
      }
    }

    // Only an ordinary agent call is attributed: the model route, a check-in or a Store run,
    // never a pet hatch (hatchOperation) and never the model list.
    let attributedAgent: string | undefined

    if (body && !hatchOperation) {
      try {
        const principal = this.options.agentPrincipal?.(agent)

        attributedAgent = principal && AGENT_PRINCIPAL.test(principal) ? principal.toLowerCase() : undefined
      } catch {
        // Main state is unreadable: send no claim rather than a guess.
        attributedAgent = undefined
      }
    }

    const send = async (payload: Buffer | undefined): Promise<Response | 'sign_in' | 'unavailable' | 'aborted'> => {
      let answer: Response | undefined

      for (const refresh of [false, true]) {
        const bearer = await this.options.bearer(refresh)

        if (!bearer) {
          return 'sign_in'
        }

        try {
          answer = await fetch(`${this.options.gateway}${route}`, {
            method: request.method,
            redirect: 'error',
            signal: abort.signal,
            headers: {
              Authorization: `Bearer ${bearer}`,
              Accept: request.headers.accept ?? 'application/json',
              ...(training
                ? {
                    'X-Atum-Store-Task': training.taskId,
                    'X-Atum-Store-Assistant': training.assistantId,
                    'X-Atum-Store-Executor': training.executorId,
                    'X-Atum-Store-Conversation': training.conversationId,
                    ...(training.leaseToken
                      ? { 'X-Atum-Store-Lease': training.leaseToken }
                      : { 'X-Atum-Store-Invocation': training.invocationId! })
                  }
                : {}),
              ...(hatchOperation ? { 'X-Atum-Pet-Operation': hatchOperation } : {}),
              ...(sweep
                ? {
                    'X-Atum-Sweep-Authorization': sweep.authorizationId,
                    'X-Atum-Sweep-Attribution': sweep.attributionId,
                    'X-Atum-Sweep-Max-Micro-Protons': String(sweep.maxModelMicroProtons)
                  }
                : {}),
              ...(attributedAgent ? { 'X-Atum-Agent': attributedAgent } : {}),
              ...(payload ? { 'Content-Type': 'application/json' } : {})
            },
            ...(payload ? { body: new Uint8Array(payload) } : {})
          })
        } catch {
          return abort.signal.aborted ? 'aborted' : 'unavailable'
        }

        // The gateway authenticates before it holds anything, so a refused token is
        // retried once with a fresh one.
        if (answer.status !== 401 || refresh) {
          break
        }

        await answer.body?.cancel()
      }

      return answer!
    }

    let outcome = await send(body)

    // A hold refused for the balance: the same request with a smaller output cap, so the last
    // Protons still buy an answer (MATRIX_MANAGED_OUTPUT_STEPS). Every other answer is final.
    // Not for a check-in: it runs only when the balance pays for it, and never spends the last
    // Protons the owner may want for their own question (check-ins.ts).
    if (outcome instanceof Response && outcome.status === 402 && body && !hatchOperation && !checkIn && !sweep) {
      const refusal = { status: outcome.status, type: outcome.headers.get('content-type'), text: await boundedText(outcome) }
      let stepped: Awaited<ReturnType<typeof send>> | undefined

      if (refusal.text.includes('insufficient_protons')) {
        for (const cap of matrixManagedOutputSteps(body)) {
          const next = await send(withOutputCap(body, cap))

          if (!(next instanceof Response) || next.status !== 402) {
            stepped = next

            break
          }

          await next.body?.cancel()
        }
      }

      if (stepped === undefined) {
        response.writeHead(refusal.status, {
          'Content-Type': refusal.type ?? 'application/json',
          'Cache-Control': 'no-store'
        })
        response.end(refusal.text)

        return
      }

      outcome = stepped
    }

    if (outcome === 'aborted') {
      return
    }

    if (outcome === 'sign_in') {
      return fail(401, 'atum_sign_in_required')
    }

    if (outcome === 'unavailable') {
      return fail(502, 'atum_gateway_unavailable')
    }

    upstream = outcome

    response.writeHead(upstream!.status, {
      'Content-Type': upstream!.headers.get('content-type') ?? 'application/json',
      'Cache-Control': 'no-store'
    })

    try {
      for await (const chunk of upstream!.body ?? []) {
        if (!response.write(chunk)) {
          await once(response, 'drain')
        }
      }
    } catch {
      // Cancelled by Hermes or broken mid-stream; nothing else to send.
    }

    response.end()
  }
}

/**
 * The agent principal a key's role is attributed to: the enrollment's verified identity,
 * else the runtime's own principal (the roster's, for another agent; set from its
 * enrollment, for the default). Never the owner's human principal, and never anything a
 * request supplied. An unknown role (the human, an app) or an unreadable enrollment has none.
 */
export function matrixManagedAgentPrincipal<Runtime extends { agentPrincipal?: string }>(
  role: string,
  source: {
    runtime: (role: string) => Runtime | undefined
    enrolled: (runtime: Runtime) => string | undefined
  }
): string | undefined {
  const runtime = source.runtime(role)

  if (!runtime) {
    return undefined
  }

  try {
    return source.enrolled(runtime) ?? runtime.agentPrincipal
  } catch {
    return runtime.agentPrincipal
  }
}

/** One field of a request, or nothing when the body is not a JSON object. */
function requestField(body: Buffer, key: 'model' | 'stream'): unknown {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'))

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>)[key] : undefined
  } catch {
    return undefined
  }
}

/** A check-in request beyond its one call: a completion that is only cron's silence marker,
 * as JSON or as a stream (as asked), answered here. Hermes ends the check quietly. */
function answerSilently(response: ServerResponse, stream: boolean, model = MATRIX_CHECK_IN_MODEL_ALIAS) {
  const base = { id: 'atum-silent', created: Math.floor(Date.now() / 1000), model }
  const silence = '[SILENT]'

  if (stream) {
    const chunk = (choice: Record<string, unknown>) =>
      `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [choice] })}\n\n`

    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
    response.end(
      chunk({ index: 0, delta: { role: 'assistant', content: silence }, finish_reason: null }) +
        chunk({ index: 0, delta: {}, finish_reason: 'stop' }) +
        'data: [DONE]\n\n'
    )

    return
  }

  response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(
    JSON.stringify({
      ...base,
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: silence }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    })
  )
}

/** The output caps to try after a refused hold: each below what the request already asked for. */
export function matrixManagedOutputSteps(body: Buffer): number[] {
  let parsed: unknown

  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return []
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return []
  }

  const request = parsed as { max_tokens?: unknown; max_completion_tokens?: unknown }

  const asked = [request.max_completion_tokens, request.max_tokens].find(
    value => typeof value === 'number' && Number.isInteger(value) && value > 0
  ) as number | undefined

  return MATRIX_MANAGED_OUTPUT_STEPS.filter(cap => asked === undefined || cap < asked)
}

/** The request asking for at most `cap` output tokens (the gateway honours the smaller cap). */
function withOutputCap(body: Buffer, cap: number): Buffer {
  const request = JSON.parse(body.toString('utf8')) as Record<string, unknown>
  const { max_completion_tokens: _ignored, ...rest } = request

  return Buffer.from(JSON.stringify({ ...rest, max_tokens: cap }))
}

/** An error answer's text, bounded: only its code matters, and it goes back to Hermes as is. */
async function boundedText(answer: Response): Promise<string> {
  try {
    return (await answer.text()).slice(0, 16_384)
  } catch {
    return ''
  }
}

/** The body with its Atum model name set to `chosen`; anything unreadable goes on unchanged,
 * for the gateway to refuse. */
function withModel(body: Buffer, chosen: MatrixModelId, effort?: MatrixEffort, defaultLevel = true): Buffer {
  let parsed: unknown

  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return body
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return body
  }

  const request = parsed as { model?: unknown }
  const model = matrixRequestModel(request.model, chosen)

  // The person's level when the chosen model takes it, else the default (decision (d),
  // 2026-10-17): a stored level the narrowed list no longer holds is replaced, not dropped.
  // Only on a request that names one of Atum's models, and never on a Store run.
  const level =
    request.model !== MATRIX_CHECK_IN_MODEL_ALIAS && model === chosen
      ? effort && MATRIX_MODEL_EFFORTS[chosen].includes(effort)
        ? effort
        : defaultLevel
          ? MATRIX_DEFAULT_EFFORT
          : undefined
      : undefined

  return model === request.model && !level
    ? body
    : Buffer.from(JSON.stringify(matrixRequestEffort({ ...request, model }, level)))
}

/** A Store run's body naming exactly `model`, at the model's own thinking level: any
 * `reasoning_effort` in it is dropped (a JSON object only; anything else goes on unchanged,
 * for the gateway to refuse). */
function withNamedModel(body: Buffer, model: MatrixModelId): Buffer {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'))

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return body
    }

    const { reasoning_effort: _dropped, ...request } = parsed as Record<string, unknown>

    return Buffer.from(JSON.stringify({ ...request, model }))
  } catch {
    return body
  }
}

/** A platform-dispatched sweep replaces only its internal alias and carries its own effort. */
function withSweepModel(body: Buffer, model: MatrixModelId, effort: MatrixEffort): Buffer | undefined {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'))

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined
    }

    const request = parsed as Record<string, unknown>

    if (request.model !== MATRIX_BACKGROUND_SWEEP_MODEL_ALIAS) {
      return undefined
    }

    return Buffer.from(JSON.stringify(matrixRequestEffort({ ...request, model }, effort)))
  } catch {
    return undefined
  }
}

/** Every request of an agent that may hold Google data goes to the protected alias, whatever
 * model it names. Unlike `withModel`, an unreadable body is refused (undefined), never
 * forwarded: nothing from such an agent may reach the gateway under another model. */
function withProtectedModel(body: Buffer): Buffer | undefined {
  let parsed: unknown

  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return undefined
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined
  }

  return Buffer.from(JSON.stringify({ ...(parsed as Record<string, unknown>), model: MATRIX_GOOGLE_PROTECTED_MODEL }))
}

/** Hatch is a gateway-only alias, deliberately outside the ordinary Matrix
 * conversation model enum. It is forced only after main validates the active
 * operation; a caller's requested alias never decides billing. */
function withHatchModel(body: Buffer): Buffer {
  let parsed: unknown

  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return body
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return body
  }

  const request = parsed as { model?: unknown }

  return request.model === 'hatch' ? body : Buffer.from(JSON.stringify({ ...request, model: 'hatch' }))
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of request) {
    size += (chunk as Buffer).length

    if (size > limit) {
      return undefined
    }

    chunks.push(chunk as Buffer)
  }

  return Buffer.concat(chunks)
}
