import type { DeviceFrameVerdict, DeviceSessionFacts } from './service'

export const CHATGPT_RELAY_REQUEST_MAX_BYTES = 800_000
export const CHATGPT_RELAY_RESPONSE_MAX_BYTES = 800_000
export const CHATGPT_RELAY_CAPABILITY_MAX_MS = 60_000
export const CHATGPT_RELAY_CLOCK_SKEW_MS = 30_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u

export interface ChatGptRelayRequestBody {
  capabilityId: string
  ownerPrincipal: string
  agentPrincipal: string
  invocationId: string
  model: string
  effort: 'low' | 'medium' | 'high'
  relayRevision: number
  deviceServiceId: string
  connectionId: string
  connectionEpoch: number
  issuedAt: number
  expiresAt: number
  maxResponseBytes: number
  requestBytes: number
  request: Record<string, unknown>
}

export type ChatGptRelayResponseBody =
  | { capabilityId: string; state: 'completed'; status: 200; responseJson: string }
  | { capabilityId: string; state: 'refused'; status: number; code: ChatGptRelayRefusal }

export type ChatGptRelayRefusal =
  | 'wrong_owner' | 'wrong_agent' | 'wrong_device' | 'stale_connection' | 'expired' | 'replayed'
  | 'relay_disabled' | 'model_unavailable' | 'request_too_large' | 'response_too_large'
  | 'chatgpt_unavailable' | 'stopped' | 'invalid_request'

export interface ChatGptRelayAuthority {
  ownerPrincipal: string
  agentPrincipals: readonly string[]
  deviceServiceId: string
  enabled: boolean
  models: readonly string[]
}

export interface ChatGptRelayCall {
  status: 200
  response: Record<string, unknown>
}

export interface ChatGptRelayHandlerDeps {
  authority(): ChatGptRelayAuthority | null
  call(input: { model: string; effort: 'low' | 'medium' | 'high'; request: Record<string, unknown> }, signal: AbortSignal): Promise<ChatGptRelayCall>
  authorize?(request: ChatGptRelayRequestBody, signal: AbortSignal): Promise<boolean>
  now?(): number
  log?(line: string): void
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parse(value: Record<string, unknown>): ChatGptRelayRequestBody | null {
  let request: unknown
  try { request = typeof value.requestJson === 'string' ? JSON.parse(value.requestJson) : null } catch { request = null }
  if (!UUID.test(String(value.capabilityId)) || !UUID.test(String(value.ownerPrincipal)) ||
      !UUID.test(String(value.agentPrincipal)) || !UUID.test(String(value.invocationId)) ||
      !MODEL.test(String(value.model)) || !['low', 'medium', 'high'].includes(String(value.effort)) ||
      !Number.isSafeInteger(value.relayRevision) || Number(value.relayRevision) < 1 ||
      !UUID.test(String(value.deviceServiceId)) || !UUID.test(String(value.connectionId)) ||
      !Number.isSafeInteger(value.connectionEpoch) || Number(value.connectionEpoch) < 1 ||
      !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt) ||
      Number(value.expiresAt) < Number(value.issuedAt) ||
      Number(value.expiresAt) - Number(value.issuedAt) > CHATGPT_RELAY_CAPABILITY_MAX_MS ||
      !Number.isSafeInteger(value.maxResponseBytes) || Number(value.maxResponseBytes) < 1 ||
      Number(value.maxResponseBytes) > CHATGPT_RELAY_RESPONSE_MAX_BYTES ||
      !Number.isSafeInteger(value.requestBytes) || Number(value.requestBytes) < 1 ||
      Number(value.requestBytes) > CHATGPT_RELAY_REQUEST_MAX_BYTES || !object(request) ||
      Buffer.byteLength(String(value.requestJson), 'utf8') !== value.requestBytes) {
    return null
  }
  const { requestJson: _requestJson, ...wire } = value
  return { ...wire, request } as unknown as ChatGptRelayRequestBody
}

/** Mac-side admission and execution for one controller-signed relay capability. OAuth custody is
 * behind `call`; this class sees only safe authority facts, bounded content, and closed failures. */
export class ChatGptRelayHandler {
  private readonly seen = new Map<string, number>()
  private readonly inflight = new Map<string, AbortController>()

  constructor(private readonly deps: ChatGptRelayHandlerDeps) {}

  disable(): void {
    for (const controller of this.inflight.values()) {
      controller.abort(new Error('relay_disabled'))
    }

    this.inflight.clear()
  }

  async handle(body: Record<string, unknown>, session: DeviceSessionFacts, verdict: DeviceFrameVerdict): Promise<ChatGptRelayResponseBody> {
    const started = this.deps.now?.() ?? Date.now()
    const id = typeof body.capabilityId === 'string' && UUID.test(body.capabilityId)
      ? body.capabilityId : '00000000-0000-4000-8000-000000000000'
    const refuse = (code: ChatGptRelayRefusal, status = code === 'request_too_large' ? 413 : 403): ChatGptRelayResponseBody => {
      this.deps.log?.(`[ChatGPT relay] state=refused code=${code} ms=${Math.max(0, (this.deps.now?.() ?? Date.now()) - started)}`)
      return { capabilityId: id, state: 'refused', status, code }
    }
    if (verdict !== 'ok') {
      return refuse('invalid_request')
    }

    if (Number(body.requestBytes) > CHATGPT_RELAY_REQUEST_MAX_BYTES ||
        (typeof body.requestJson === 'string' && Buffer.byteLength(body.requestJson, 'utf8') > CHATGPT_RELAY_REQUEST_MAX_BYTES)) {
      return refuse('request_too_large', 413)
    }
    const request = parse(body)

    if (!request) {
      return refuse('invalid_request', 400)
    }

    const now = this.deps.now?.() ?? Date.now()

    if (request.issuedAt > now + CHATGPT_RELAY_CLOCK_SKEW_MS) {
      return refuse('invalid_request', 400)
    }

    for (const [key, until] of this.seen) {
      if (until <= now) {
        this.seen.delete(key)
      }
    }

    if (this.seen.has(request.capabilityId)) {
      return refuse('replayed')
    }

    // Consume before any local provider work. A transport retry cannot spend the plan twice.
    this.seen.set(request.capabilityId, request.expiresAt)

    if (now > request.expiresAt) {
      return refuse('expired')
    }

    if (request.deviceServiceId !== session.deviceServiceId) {
      return refuse('wrong_device')
    }

    if (request.connectionId !== session.connectionId || request.connectionEpoch !== session.connectionEpoch) {
      return refuse('stale_connection')
    }
    const authority = this.deps.authority()

    if (!authority || !authority.enabled) {
      return refuse('relay_disabled')
    }

    if (authority.ownerPrincipal !== request.ownerPrincipal) {
      return refuse('wrong_owner')
    }

    if (!authority.agentPrincipals.includes(request.agentPrincipal)) {
      return refuse('wrong_agent')
    }

    if (authority.deviceServiceId !== request.deviceServiceId) {
      return refuse('wrong_device')
    }

    if (!authority.models.includes(request.model)) {
      return refuse('model_unavailable')
    }

    const actualRequestBytes = Buffer.byteLength(JSON.stringify(request.request), 'utf8')
    if (actualRequestBytes !== request.requestBytes || actualRequestBytes > CHATGPT_RELAY_REQUEST_MAX_BYTES) {
      return refuse('request_too_large', 413)
    }
    if (request.request.model !== request.model || request.request.stream === true || !Array.isArray(request.request.messages)) {
      return refuse('invalid_request', 400)
    }
    const controller = new AbortController()
    this.inflight.set(request.capabilityId, controller)
    const expiry = setTimeout(() => controller.abort(new Error('relay_expired')),
      Math.max(0, request.expiresAt - (this.deps.now?.() ?? Date.now())))
    expiry.unref?.()
    let authorityCheck: ReturnType<typeof setInterval> | undefined
    try {
      if (this.deps.authorize && !(await this.deps.authorize(request, controller.signal))) {
        return refuse('relay_disabled')
      }
      let checking = false
      authorityCheck = this.deps.authorize ? setInterval(() => {
        if (checking || controller.signal.aborted) {
          return
        }

        checking = true
        void this.deps.authorize!(request, controller.signal).then(
          authorized => {
            if (!authorized) {
              controller.abort(new Error('relay_disabled'))
            }
          },
          () => controller.abort(new Error('relay_unavailable'))
        ).finally(() => { checking = false })
      }, 1_000) : undefined
      authorityCheck?.unref?.()
      const answer = await this.deps.call({ model: request.model, effort: request.effort, request: request.request }, controller.signal)

      if (controller.signal.aborted) {
        return refuse('stopped', 409)
      }

      const bytes = Buffer.byteLength(JSON.stringify(answer.response), 'utf8')
      if (bytes > request.maxResponseBytes || bytes > CHATGPT_RELAY_RESPONSE_MAX_BYTES) {
        return refuse('response_too_large', 502)
      }
      this.deps.log?.(`[ChatGPT relay] state=completed model=${request.model} response_bytes=${bytes} ms=${Math.max(0, (this.deps.now?.() ?? Date.now()) - started)}`)
      return { capabilityId: request.capabilityId, state: 'completed', status: 200,
        responseJson: JSON.stringify(answer.response) }
    } catch {
      return refuse(controller.signal.aborted ? 'stopped' : 'chatgpt_unavailable', controller.signal.aborted ? 409 : 502)
    } finally {
      if (authorityCheck) {
        clearInterval(authorityCheck)
      }

      clearTimeout(expiry)
      this.inflight.delete(request.capabilityId)
    }
  }
}
