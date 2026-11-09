import type { ModelGrant } from './model-grants'

/**
 * Where the broker sends an admitted model request. The broker has already checked the
 * grant, the alias, the size and the output cap; an upstream only carries the request on.
 */
export interface UpstreamRequest {
  /** The projected OpenAI chat-completions body. */
  body: Record<string, unknown>
  grant: ModelGrant
  /** The task's grant token, presented upstream as the gateway's authority to charge. */
  token: string
  /** Aborted by a stop, a lost lease or the grant's expiry. */
  signal: AbortSignal
}

export interface UpstreamResponse {
  status: number
  json: unknown
}

export type UpstreamStreamEvent = { data: unknown } | { done: true }

export interface UpstreamEventStream {
  status: number
  events: AsyncIterable<UpstreamStreamEvent>
}

export type UpstreamStreamResponse = UpstreamResponse | UpstreamEventStream

export interface ModelUpstream {
  complete(request: UpstreamRequest): Promise<UpstreamResponse>
  /** Optional only for the retired spool spike; production provides a real event stream. */
  stream?(request: UpstreamRequest): Promise<UpstreamStreamResponse>
}

export interface GatewayUpstreamOptions {
  /** The managed-model gateway's OpenAI base, e.g. `https://<gateway>/v1`. */
  baseUrl: string
  /** The controller's registry ID (a lowercase UUID). */
  controllerId?: string
  /** The controller's credential, read when needed and never kept in a log or an error. */
  credential?: () => string
  /** Mac occurrence transport supplies MAS + D1 signatures; no controller identity. */
  transport?: (url: string, init: RequestInit, request: UpstreamRequest) => Promise<Response>
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxResponseBytes?: number
  streamIdleTimeoutMs?: number
  maxStreamBytes?: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function parseEvent(block: string): UpstreamStreamEvent | null {
  const data = block.split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, ''))
    .join('\n')

  if (!data) return null
  if (data.trim() === '[DONE]') return { done: true }

  try {
    return { data: JSON.parse(data) }
  } catch {
    throw new Error('gateway_stream_invalid')
  }
}

/**
 * The production path (atum.cloud-execution/1 §6.3.3): the broker presents the task's grant
 * to the managed-model gateway with the controller's own credential, and the gateway checks
 * the grant live with DA on every request (§6.3.4). The sandbox never reaches the gateway,
 * and no provider key is anywhere on the executor host.
 */
export class GatewayUpstream implements ModelUpstream {
  private readonly endpoint: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number
  private readonly streamIdleTimeoutMs: number
  private readonly maxStreamBytes: number

  constructor(private readonly options: GatewayUpstreamOptions) {
    const url = new URL(options.baseUrl)

    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('gateway_upstream_invalid:base_url')
    }

    if (!options.transport && (!options.controllerId || !UUID.test(options.controllerId) || !options.credential)) {
      throw new Error('gateway_upstream_invalid:controller_id')
    }

    this.endpoint = `${url.href.replace(/\/$/, '')}/chat/completions`
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 125_000
    this.maxResponseBytes = options.maxResponseBytes ?? 4 * 1024 * 1024
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 60_000
    // SSE repeats the response envelope around many small deltas; keep it separately bounded.
    this.maxStreamBytes = options.maxStreamBytes ?? 8 * 1024 * 1024
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1 ||
        !Number.isSafeInteger(this.streamIdleTimeoutMs) || this.streamIdleTimeoutMs < 1 ||
        !Number.isSafeInteger(this.maxStreamBytes) || this.maxStreamBytes < 1) {
      throw new Error('gateway_upstream_invalid:response_limit')
    }
  }

  private headers(request: UpstreamRequest): Record<string, string> {
    return {
      ...(this.options.transport ? {} : {
        authorization: `Bearer ${this.options.credential!()}`,
        'x-atum-controller': this.options.controllerId!
      }),
      'content-type': 'application/json',
      'x-atum-model-grant': request.token
    }
  }

  private async json(response: Response, limit = this.maxResponseBytes): Promise<unknown> {
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    if (reader) {
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > limit) {
            await reader.cancel()
            throw new Error('gateway_response_too_large')
          }
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }
    }
    try {
      return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
    } catch {
      // Invalid JSON remains a closed upstream refusal, never raw provider text.
      return null
    }
  }

  private send(init: RequestInit, request: UpstreamRequest): Promise<Response> {
    return this.options.transport
      ? this.options.transport(this.endpoint, init, request)
      : this.fetchImpl(this.endpoint, init)
  }

  private managedOnly(request: UpstreamRequest): void {
    // A subscription token belongs to the platform subscription edge. Sending it here would
    // present it to the Atum gateway, which refuses it; never offer it in the first place.
    if (request.grant.source !== 'atum') throw new Error('subscription_grant_at_managed_gateway')
  }

  async complete(request: UpstreamRequest): Promise<UpstreamResponse> {
    this.managedOnly(request)
    const response = await this.send({
      method: 'POST',
      headers: this.headers(request),
      body: JSON.stringify(request.body),
      redirect: 'error',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(this.timeoutMs)])
    }, request)

    return { status: response.status, json: await this.json(response) }
  }

  async stream(request: UpstreamRequest): Promise<UpstreamStreamResponse> {
    this.managedOnly(request)
    const authority = new AbortController()
    const stop = () => authority.abort(request.signal.reason)
    if (request.signal.aborted) stop()
    else request.signal.addEventListener('abort', stop, { once: true })
    const setup = setTimeout(() => authority.abort(new Error('gateway_upstream_timeout')), this.timeoutMs)
    setup.unref?.()
    let response: Response

    try {
      response = await this.send({
        method: 'POST', headers: this.headers(request), body: JSON.stringify(request.body),
        redirect: 'error', signal: authority.signal
      }, request)
    } catch (error) {
      request.signal.removeEventListener('abort', stop)
      throw error
    } finally {
      clearTimeout(setup)
    }

    if (response.status < 200 || response.status >= 300) {
      try {
        return { status: response.status, json: await this.json(response) }
      } finally {
        request.signal.removeEventListener('abort', stop)
      }
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) {
      request.signal.removeEventListener('abort', stop)
      await response.body?.cancel()
      throw new Error('gateway_stream_invalid')
    }

    return { status: response.status, events: this.events(response.body, authority, stop, request.signal) }
  }

  private async *events(body: ReadableStream<Uint8Array>, authority: AbortController,
    stop: () => void, signal: AbortSignal): AsyncGenerator<UpstreamStreamEvent> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let bytes = 0
    let finished = false
    let endedNormally = false

    try {
      while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined
        let abortRead: (() => void) | undefined
        const aborted = new Promise<never>((_resolve, reject) => {
          abortRead = () => {
            const reason = authority.signal.reason instanceof Error ? authority.signal.reason : new Error('gateway_stream_aborted')
            reject(reason)
            void reader.cancel(reason).catch(() => {})
          }
          if (authority.signal.aborted) abortRead()
          else authority.signal.addEventListener('abort', abortRead, { once: true })
        })
        timer = setTimeout(() => {
          authority.abort(new Error('gateway_stream_idle_timeout'))
        }, this.streamIdleTimeoutMs)
        timer.unref?.()
        let item: ReadableStreamReadResult<Uint8Array>
        try {
          item = await Promise.race([reader.read(), aborted])
        } finally {
          if (timer) clearTimeout(timer)
          if (abortRead) authority.signal.removeEventListener('abort', abortRead)
        }
        if (authority.signal.aborted) {
          throw authority.signal.reason instanceof Error ? authority.signal.reason : new Error('gateway_stream_aborted')
        }
        if (item.done) break
        bytes += item.value.byteLength
        if (bytes > this.maxStreamBytes) {
          await reader.cancel()
          throw new Error('gateway_stream_too_large')
        }
        buffer += decoder.decode(item.value, { stream: true })
        while (true) {
          const boundary = /\r?\n\r?\n/.exec(buffer)
          if (!boundary) break
          const block = buffer.slice(0, boundary.index)
          buffer = buffer.slice(boundary.index + boundary[0].length)
          const event = parseEvent(block)
          if (!event) continue
          if (finished) throw new Error('gateway_stream_invalid')
          if ('done' in event) finished = true
          yield event
        }
      }
      buffer += decoder.decode()
      if (buffer.trim()) {
        const event = parseEvent(buffer)
        if (event) {
          if (finished) throw new Error('gateway_stream_invalid')
          if ('done' in event) finished = true
          yield event
        }
      }
      if (!finished) throw new Error('gateway_stream_incomplete')
      // There is intentionally no total stream timer: the live grant expiry, byte cap and
      // per-byte idle bound stop a slow stream without cutting a healthy long generation.
      endedNormally = true
    } finally {
      if (!endedNormally) await reader.cancel().catch(() => {})
      signal.removeEventListener('abort', stop)
      reader.releaseLock()
    }
  }
}
