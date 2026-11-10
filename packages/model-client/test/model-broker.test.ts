import http from 'node:http'
import net, { type AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { type BrokerRequestRecord, MAX_REQUEST_BYTES, ModelBroker, projectRequest } from '../src/model-broker'
import { ModelGrantRegistry } from '../src/model-grants'
import type { ModelUpstream, UpstreamRequest, UpstreamResponse, UpstreamStreamResponse } from '../src/gateway-upstream'
import { newOpaqueToken } from '../src/opaque-token'

const ANSWER = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'nguyet-thuc',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'hello',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'terminal', arguments: '{}' } }]
      },
      finish_reason: 'tool_calls'
    }
  ],
  usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }
}

class FakeUpstream implements ModelUpstream {
  calls: UpstreamRequest[] = []
  completeCalls = 0
  streamCalls = 0
  respond: (request: UpstreamRequest) => Promise<UpstreamResponse> = async () => ({ status: 200, json: ANSWER })
  streamRespond: (request: UpstreamRequest) => Promise<UpstreamStreamResponse> = async () => ({
    status: 200,
    events: (async function* () {
      yield { data: { id: ANSWER.id, object: 'chat.completion.chunk', created: ANSWER.created, model: 'private-provider-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'hello',
          tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'terminal', arguments: '{}' } }] }, finish_reason: null }] } }
      yield { data: { id: ANSWER.id, object: 'chat.completion.chunk', created: ANSWER.created, model: 'private-provider-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] } }
      yield { data: { id: ANSWER.id, object: 'chat.completion.chunk', created: ANSWER.created, model: 'private-provider-model',
        choices: [], usage: ANSWER.usage } }
      yield { done: true }
    })()
  })

  complete(request: UpstreamRequest) {
    this.calls.push(request)
    this.completeCalls++

    return this.respond(request)
  }

  stream(request: UpstreamRequest) {
    this.calls.push(request)
    this.streamCalls++

    return this.streamRespond(request)
  }
}

let broker: ModelBroker | null = null

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Collect uncaught exceptions instead of letting them end the run. vitest's own handlers are
 * parked while the trap is open, so a crash the controller would suffer shows up as an entry.
 */
function trapUncaught() {
  const parked = process.listeners('uncaughtException')
  const caught: Error[] = []
  const collect = (error: Error) => void caught.push(error)

  process.removeAllListeners('uncaughtException')
  process.on('uncaughtException', collect)

  return {
    caught,
    release() {
      process.off('uncaughtException', collect)
      parked.forEach(listener => process.on('uncaughtException', listener))
    }
  }
}

afterEach(async () => {
  await broker?.stop()
  broker = null
})

async function setup(options: { maxRequestBytes?: number } = {}) {
  const grants = new ModelGrantRegistry()
  const upstream = new FakeUpstream()
  const records: BrokerRequestRecord[] = []
  const logs: string[] = []
  broker = new ModelBroker({
    host: '127.0.0.1',
    port: 0,
    grants,
    upstream,
    log: line => logs.push(line),
    onRecord: record => records.push(record),
    ...options
  })
  const address = (await broker.start()) as AddressInfo
  const base = `http://127.0.0.1:${address.port}/v1`
  const { token, grant } = grants.mint({
    taskId: 'task-0001abcd',
    aliases: ['nguyet-thuc'],
    expiresAt: Date.now() + 60_000,
    maxOutputTokens: 1_000
  })
  grants.bindSource('task-0001abcd', '127.0.0.1')

  const post = (body: unknown, auth: string | null = token) =>
    fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })

  return { grants, upstream, records, logs, base, token, grant, post }
}

const chat = { messages: [{ role: 'user', content: 'a secret prompt' }] }

describe('the model broker', () => {
  it('returns only the granted alias, including non-streamed upstream answers', async () => {
    const { post, upstream } = await setup()
    upstream.respond = async () => ({ status: 200, json: { ...ANSWER, model: 'private-provider-model' } })
    expect((await (await post(chat)).json()).model).toBe('nguyet-thuc')
  })
  it('refuses a request without a live grant, and lists only the grant’s aliases', async () => {
    const { base, token, post, upstream } = await setup()

    expect((await fetch(`${base}/models`)).status).toBe(401)
    const listed = await (await fetch(`${base}/models`, { headers: { authorization: `Bearer ${token}` } })).json()
    expect(listed.data.map((entry: { id: string }) => entry.id)).toEqual(['nguyet-thuc'])

    expect((await post(chat, null)).status).toBe(401)
    expect((await post(chat, newOpaqueToken())).status).toBe(401)
    expect((await post(chat, 'not-a-token')).status).toBe(401)
    expect(upstream.calls).toHaveLength(0)
  })

  it('forwards only the standard fields, never streamed, with the output capped', async () => {
    const { post, upstream, token } = await setup()
    const response = await post({
      ...chat,
      tools: [{ type: 'function', function: { name: 'terminal' } }],
      max_tokens: 50_000,
      stream: false,
      extra_body: { provider: { order: ['anything'] } },
      user: 'someone',
      metadata: { atum_hold: 'forged' }
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(ANSWER)
    expect(upstream.calls).toHaveLength(1)
    const [call] = upstream.calls
    expect(call.token).toBe(token)
    expect(call.body).toEqual({
      model: 'nguyet-thuc',
      messages: chat.messages,
      tools: [{ type: 'function', function: { name: 'terminal' } }],
      max_tokens: 1_000,
      stream: false
    })
  })

  it('refuses invalid projections while counting only a local broker admission attempt', async () => {
    const { post, upstream, grants } = await setup({ maxRequestBytes: 2_000 })

    expect((await post({ ...chat, model: 'nhat-thuc' })).status).toBe(403)
    expect((await post({ ...chat, n: 2 })).status).toBe(400)
    expect((await post({ messages: [{ role: 'user', content: 'x'.repeat(5_000) }] })).status).toBe(413)
    expect((await post('{not json')).status).toBe(400)
    expect((await post({ messages: [] })).status).toBe(400)
    expect(upstream.calls).toHaveLength(0)
    // `maxRequests` bounds broker admission/body reads, not a wallet: these malformed or
    // unauthorized attempts never reach the upstream, but each consumes one local slot.
    expect(grants.stats('task-0001abcd')).toEqual({ requests: 5, inflight: 0 })
  })

  describe('the request size', () => {
    const MiB = 1024 * 1024
    const image = (bytes: number) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(bytes)}` } })

    /** A chat body of exactly `bytes` bytes of JSON, padded in one text part. */
    const bodyOf = (bytes: number) => {
      const overhead = Buffer.byteLength(JSON.stringify({ messages: [{ role: 'user', content: '' }] }))

      return JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(bytes - overhead) }] })
    }

    it('admits what a vision turn really sends: two 4 MiB images as base64, 8 MiB in all, forwarded whole', async () => {
      const { post, upstream, records } = await setup()
      const content = [{ type: 'text', text: 'compare these' }, image(4 * MiB), image(4 * MiB)]
      const response = await post({ messages: [{ role: 'user', content }] })

      expect(response.status).toBe(200)
      expect(upstream.calls).toHaveLength(1)
      expect(upstream.calls[0].body.messages).toEqual([{ role: 'user', content }])
      expect(records[0].requestBytes).toBeGreaterThan(8 * MiB)
    })

    it('admits a body of exactly the cap and refuses one byte more, before anything reaches the upstream', async () => {
      const { post, upstream, records } = await setup()

      const atCap = bodyOf(MAX_REQUEST_BYTES)
      expect(Buffer.byteLength(atCap)).toBe(MAX_REQUEST_BYTES)
      expect((await post(atCap)).status).toBe(200)
      expect(upstream.calls).toHaveLength(1)

      const overCap = bodyOf(MAX_REQUEST_BYTES + 1)
      expect(Buffer.byteLength(overCap)).toBe(MAX_REQUEST_BYTES + 1)
      const refused = await post(overCap)
      expect(refused.status).toBe(413)
      expect((await refused.json()).error.code).toBe('request_too_large')
      expect(upstream.calls).toHaveLength(1)
      expect(records.at(-1)).toMatchObject({ status: 413, code: 'request_too_large' })
    })

    it('holds the cap for a body that never declares its length, too', async () => {
      const { upstream, base, token, records } = await setup()
      const oversized = Buffer.from(bodyOf(MAX_REQUEST_BYTES + MiB))

      const status = await new Promise<number>((resolve, reject) => {
        // The broker answers 413 at the cap while this oversized upload is still being written.
        // Once the response ends, Node removes its own socket error listener before returning the
        // half-written socket to the keep-alive agent, so a late EPIPE/ECONNRESET on the abandoned
        // write must stay owned by this request and its socket for their whole lifetime.
        const request = http.request(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'transfer-encoding': 'chunked' }
        }, response => {
          response.resume()
          response.once('end', () => resolve(response.statusCode ?? 0))
        })
        request.on('error', reject)
        request.on('socket', socket => socket.on('error', reject))

        for (let at = 0; at < oversized.length; at += MiB) request.write(oversized.subarray(at, at + MiB))
        request.end()
      })

      expect(status).toBe(413)
      expect(upstream.calls).toHaveLength(0)
      expect(records.at(-1)).toMatchObject({ status: 413, code: 'request_too_large' })
    })
  })

  it('keeps serving after the server’s own accept error, and logs its closed code', async () => {
    const { base, logs, token } = await setup()
    const server = (broker as unknown as { server: http.Server }).server

    // EMFILE on accept is a server 'error', not a peer reset: the process guard would exit on it.
    // The handler must consume it (no throw), leave a closed line only, and the broker keeps serving.
    expect(() => server.emit('error', Object.assign(new Error('accept EMFILE'), { code: 'EMFILE' }))).not.toThrow()
    expect(logs).toContain('[broker] server_error code=EMFILE')

    const listed = await (await fetch(`${base}/models`, { headers: { authorization: `Bearer ${token}` } })).json()
    expect(listed.data.map((entry: { id: string }) => entry.id)).toEqual(['nguyet-thuc'])
  })

  it('keeps serving after a client resets right after reading a refusal', async () => {
    const { base, token } = await setup()
    const address = new URL(base)
    const trap = trapUncaught()

    try {
      const socket = net.connect({ host: address.hostname, port: Number(address.port) })
      socket.on('error', () => {})
      await new Promise<void>(resolve => socket.once('connect', resolve))
      const refusal = new Promise<string>(resolve => socket.once('data', chunk => resolve(chunk.toString('latin1'))))
      socket.write(`GET ${address.pathname}/models HTTP/1.1\r\nHost: ${address.host}\r\n\r\n`)
      expect(await refusal).toContain('401')
      // A real reset, not a synthetic emit: the kernel can still be flushing the refusal when
      // the sandbox hangs up, and that transport error must stay on the response, not escape.
      socket.resetAndDestroy()
      await sleep(50)

      expect(trap.caught.map(error => error.message)).toEqual([])
    } finally {
      trap.release()
    }

    // The refused connection did not take the broker down: it still serves the grant.
    const listed = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${token}` } })
    expect(listed.status).toBe(200)
  })

  it('passes bounded upstream events through, rewrites the model alias and retains usage', async () => {
    const { post, upstream, records, logs, token } = await setup()
    const response = await post({ ...chat, stream: true, stream_options: { include_usage: true } })

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const events = (await response.text())
      .split('\n\n')
      .filter(Boolean)
      .map(chunk => chunk.replace(/^data: /, ''))

    expect(events.at(-1)).toBe('[DONE]')
    const [first, finish, usage] = events.slice(0, -1).map(event => JSON.parse(event))
    expect(first.choices[0].delta.content).toBe('hello')
    expect(first.choices[0].delta.tool_calls[0]).toMatchObject({ index: 0, id: 'call_1' })
    expect(first.model).toBe('nguyet-thuc')
    expect(finish.choices[0].finish_reason).toBe('tool_calls')
    expect(usage.usage.total_tokens).toBe(15)
    expect(usage.model).toBe('nguyet-thuc')
    expect(upstream.streamCalls).toBe(1)
    expect(upstream.completeCalls).toBe(0)
    expect(upstream.calls[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } })
    expect(records[0]).toMatchObject({ status: 200, stream: true, promptTokens: 12, completionTokens: 3 })
    const retained = JSON.stringify(records) + logs.join('\n')
    expect(retained).not.toContain('secret prompt')
    expect(retained).not.toContain('hello')
    expect(retained).not.toContain('private-provider-model')
    expect(retained).not.toContain(token)
  })

  it('delivers the first upstream event before completion and hides unrequested usage', async () => {
    const { post, upstream, records } = await setup()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    upstream.streamRespond = async () => ({ status: 200, events: (async function* () {
      yield { data: { id: 'live', model: 'private', choices: [{ index: 0, delta: { content: 'first' }, finish_reason: null }] } }
      await gate
      yield { data: { id: 'live', model: 'private', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: ANSWER.usage } }
      yield { done: true }
    })() })
    const response = await post({ ...chat, stream: true })
    const reader = response.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('"content":"first"')
    expect(records).toHaveLength(0)

    release()
    let rest = ''
    while (true) {
      const item = await reader.read()
      if (item.done) break
      rest += new TextDecoder().decode(item.value)
    }
    expect(rest).not.toContain('"usage"')
    expect(rest).toContain('[DONE]')
    expect(records[0]).toMatchObject({ promptTokens: 12, completionTokens: 3 })
  })

  it('preserves a streamed HTTP refusal as its closed status and code', async () => {
    const { post, upstream, records } = await setup()
    upstream.streamRespond = async () => ({
      status: 402,
      json: { error: { code: 'insufficient_protons', message: 'private provider detail' } }
    })

    const response = await post({ ...chat, stream: true })
    expect(response.status).toBe(402)
    const body = await response.json()
    expect(body.error.code).toBe('insufficient_protons')
    expect(JSON.stringify(body)).not.toContain('private provider detail')
    expect(records[0]).toMatchObject({ status: 402, code: 'insufficient_protons', stream: true })
  })

  it('preserves the daily-cap refusal code the sandbox maps to its plain line', async () => {
    const { post, upstream, records } = await setup()
    upstream.respond = async () => ({
      status: 403,
      json: { error: { code: 'atum_daily_cap_exhausted', message: 'private provider detail' } }
    })

    const response = await post(chat)
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.error.code).toBe('atum_daily_cap_exhausted')
    expect(JSON.stringify(body)).not.toContain('private provider detail')
    expect(records[0]).toMatchObject({ status: 403, code: 'atum_daily_cap_exhausted' })
  })

  it('preserves the daily-cap code on a mid-stream error event and never its text', async () => {
    const { post, upstream, records, logs } = await setup()
    upstream.streamRespond = async () => ({
      status: 200,
      events: (async function* () {
        yield { data: { id: 'live', choices: [{ index: 0, delta: { content: 'first' }, finish_reason: null }] } }
        yield { data: { error: { code: 'atum_daily_cap_exhausted', message: 'private provider detail' } } }
      })()
    })

    const response = await post({ ...chat, stream: true })
    expect(response.status).toBe(200)
    const body = await response.text()
    const refusal = JSON.parse(body.split('\n\n').find(chunk => chunk.includes('atum_broker_error'))!.replace(/^data: /, ''))
    expect(refusal.error).toEqual({ message: 'atum_daily_cap_exhausted', type: 'atum_broker_error', code: 'atum_daily_cap_exhausted' })
    expect(body).not.toContain('private provider detail')
    expect(records[0]).toMatchObject({ status: 502, code: 'atum_daily_cap_exhausted', stream: true })
    expect(JSON.stringify(records) + logs.join('\n')).not.toContain('private provider detail')
  })

  it('keeps the complete-and-replay fallback for an upstream without streaming', async () => {
    const { post, upstream } = await setup()
    Object.defineProperty(upstream, 'stream', { value: undefined })
    const response = await post({ ...chat, stream: true, stream_options: { include_usage: true } })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(await response.text()).toContain('data: [DONE]')
    expect(upstream.completeCalls).toBe(1)
    expect(upstream.streamCalls).toBe(0)
    expect(upstream.calls[0]!.body).toMatchObject({ stream: false })
    expect(upstream.calls[0]!.body).not.toHaveProperty('stream_options')
  })

  it.each(['gateway_stream_too_large', 'gateway_stream_invalid', 'gateway_stream_incomplete'])
  ('closes a started broker stream on a bounded upstream %s failure', async code => {
    const { post, upstream, records, logs, token } = await setup()
    let fail!: () => void
    const gate = new Promise<void>(resolve => { fail = resolve })
    upstream.streamRespond = async () => ({ status: 200, events: (async function* () {
      yield { data: { id: 'live', choices: [{ index: 0, delta: { content: 'visible' }, finish_reason: null }] } }
      await gate
      throw new Error(code)
    })() })
    const response = await post({ ...chat, stream: true })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('visible')
    fail()
    await expect(reader.read()).rejects.toThrow()
    while (!records.length) await new Promise(resolve => setTimeout(resolve, 1))
    expect(records[0]).toMatchObject({ status: 502, code, stream: true })
    const retained = JSON.stringify(records) + logs.join('\n')
    expect(retained).not.toContain('secret prompt')
    expect(retained).not.toContain(token)
  })

  it('aborts the upstream when the streaming client disconnects', async () => {
    const { post, upstream, records } = await setup()
    let seen: AbortSignal | null = null
    upstream.streamRespond = async request => {
      seen = request.signal
      return { status: 200, events: (async function* () {
        yield { data: { id: 'live', choices: [{ index: 0, delta: { content: 'first' }, finish_reason: null }] } }
        await new Promise<never>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('client gone')), { once: true }))
      })() }
    }
    const response = await post({ ...chat, stream: true })
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
    while (!(seen as AbortSignal | null)?.aborted || !records.length) await new Promise(resolve => setTimeout(resolve, 1))
    expect(records[0]).toMatchObject({ status: 502, code: 'upstream_unavailable', stream: true })
  })

  it('cuts a request in flight when the task is revoked', async () => {
    const { post, upstream, grants } = await setup()
    let seen: AbortSignal | null = null
    upstream.respond = request =>
      new Promise((_, reject) => {
        seen = request.signal
        request.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })

    const pending = post(chat)

    while (!seen) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    expect(grants.revokeTask('task-0001abcd', 'lease_lost')).toBe(1)
    const response = await pending
    expect(response.status).toBe(503)
    expect((await response.json()).error.code).toBe('model_grant_revoked')
    expect((seen as AbortSignal | null)?.aborted).toBe(true)
    expect((await post(chat)).status).toBe(401)
  })

  it('cuts an upstream stream in flight when the task is revoked', async () => {
    const { post, upstream, grants, records } = await setup()
    let seen: AbortSignal | null = null
    upstream.streamRespond = async request => {
      seen = request.signal
      return { status: 200, events: (async function* () {
        yield { data: { id: 'live', choices: [{ index: 0, delta: { content: 'first' }, finish_reason: null }] } }
        await new Promise<never>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      })() }
    }
    const response = await post({ ...chat, stream: true })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('first')
    expect(grants.revokeTask('task-0001abcd', 'lease_lost')).toBe(1)
    await expect(reader.read()).rejects.toThrow()
    expect((seen as AbortSignal | null)?.aborted).toBe(true)
    while (!records.length) await new Promise(resolve => setTimeout(resolve, 1))
    expect(records[0]).toMatchObject({ status: 503, code: 'model_grant_revoked', stream: true })
  })

  it('revokes one of two concurrent task streams without disturbing the other', async () => {
    const { post, upstream, grants, token, records } = await setup()
    const second = grants.mint({
      taskId: 'task-0002abcd', aliases: ['nguyet-thuc'], expiresAt: Date.now() + 60_000, maxOutputTokens: 1_000
    })
    grants.bindSource('task-0002abcd', '127.0.0.1')
    let releaseSecond!: () => void
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
    upstream.streamRespond = async request => ({ status: 200, events: (async function* () {
      yield { data: { id: request.grant.taskId, choices: [{ index: 0, delta: { content: 'first' }, finish_reason: null }] } }
      if (request.grant.taskId === 'task-0001abcd') {
        await new Promise<never>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('revoked')), { once: true }))
      } else {
        await secondGate
        yield { data: { id: request.grant.taskId, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } }
        yield { done: true }
      }
    })() })

    const [firstResponse, secondResponse] = await Promise.all([
      post({ ...chat, stream: true }, token),
      post({ ...chat, stream: true }, second.token)
    ])
    const firstReader = firstResponse.body!.getReader()
    const secondReader = secondResponse.body!.getReader()
    await Promise.all([firstReader.read(), secondReader.read()])

    expect(grants.revokeTask('task-0001abcd', 'lease_lost')).toBe(1)
    await expect(firstReader.read()).rejects.toThrow()
    releaseSecond()
    while (!(await secondReader.read()).done) { /* drain */ }
    while (records.length < 2) await new Promise(resolve => setTimeout(resolve, 1))
    expect(records.find(record => record.taskId === 'task-0001abcd')).toMatchObject({ status: 503, code: 'model_grant_revoked' })
    expect(records.find(record => record.taskId === 'task-0002abcd')).toMatchObject({ status: 200, code: null })
  })

  it('relays an upstream refusal as a closed code, not its text', async () => {
    const { post, upstream } = await setup()
    upstream.respond = async () => ({
      status: 402,
      json: { error: { code: 'insufficient_protons', message: 'provider detail that must not leak' } }
    })

    const response = await post(chat)
    expect(response.status).toBe(402)
    const body = await response.json()
    expect(body.error.code).toBe('insufficient_protons')
    expect(JSON.stringify(body)).not.toContain('must not leak')

    upstream.respond = async () => {
      throw new Error('socket hang up')
    }

    expect((await post(chat)).status).toBe(502)
  })

  it('records and logs the provider’s cache-read tokens (SP-1 prompt-cache evidence)', async () => {
    const { post, records, logs, upstream } = await setup()
    upstream.respond = async () => ({ status: 200, json: { ...ANSWER,
      usage: { prompt_tokens: 20_000, completion_tokens: 3, total_tokens: 20_003, prompt_tokens_details: { cached_tokens: 19_456 } } } })

    expect((await post(chat)).status).toBe(200)
    expect(records[0]).toMatchObject({ promptTokens: 20_000, cachedTokens: 19_456 })
    expect(logs.at(-1)).toMatch(/ prompt=20000 cached=19456 /)
  })

  it('logs one line per completed call that names its turn, so one sandbox turn and its cache share read off the log', async () => {
    const { post, records, logs, upstream, grant } = await setup()
    const tools = [{ type: 'function', function: { name: 'terminal' } }]
    const turn = [{ role: 'system', content: 'You are T.' }, { role: 'user', content: 'a secret prompt' }]
    upstream.respond = async request => ({ status: 200, json: { ...ANSWER,
      usage: { prompt_tokens: 1_000 * (request.body.messages as unknown[]).length, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 1_024 } } } })

    expect((await post({ messages: turn, tools })).status).toBe(200)
    expect((await post({ messages: [...turn, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'more' }], tools })).status).toBe(200)

    const shortDigest = (digest: string | undefined) => digest!.replace('sha256:', '').slice(0, 12)
    expect(logs).toEqual([1, 2].map(call =>
      `[broker] task=task-0001abcd grant=${grant.handle} call=${call} alias=nguyet-thuc status=200 ms=${records[call - 1]!.endedAt - records[call - 1]!.startedAt} finish=tool_calls` +
      ` prompt=${call === 1 ? 2_000 : 4_000} cached=1024 completion=7 system=${shortDigest(records[0]!.systemDigest)} tools=${shortDigest(records[0]!.toolsDigest)}`))
    // Both calls of the turn share the cached prefix, so both lines carry the same digests.
    expect(records.map(record => record.systemDigest)).toEqual([records[0]!.systemDigest, records[0]!.systemDigest])
    expect(records.map(record => record.request)).toEqual([1, 2])
  })

  it('records why the provider ended each completion, streamed or not, as a short closed token (R7)', async () => {
    const { post, upstream, records, logs } = await setup()

    expect((await post(chat)).status).toBe(200)
    upstream.respond = async () => ({ status: 200, json: { ...ANSWER, choices: [{ ...ANSWER.choices[0], finish_reason: 'length' }] } })
    expect((await post(chat)).status).toBe(200)
    expect((await post({ ...chat, stream: true })).status).toBe(200)
    upstream.respond = async () => ({ status: 200, json: { ...ANSWER, choices: [{ ...ANSWER.choices[0], finish_reason: 'Weird Reason! with a very long tail that is cut at thirty-two' }] } })
    expect((await post(chat)).status).toBe(200)
    upstream.respond = async () => ({ status: 200, json: { ...ANSWER, choices: [{ ...ANSWER.choices[0], finish_reason: null }] } })
    expect((await post(chat)).status).toBe(200)

    expect(records.map(record => record.finishReason)).toEqual(['tool_calls', 'length', 'tool_calls', 'weird_reason__with_a_very_long_t', null])
    expect(logs.map(line => /finish=(\S+)/.exec(line)?.[1])).toEqual(['tool_calls', 'length', 'tool_calls', 'weird_reason__with_a_very_long_t', undefined])
  })

  it('binds the grant to the sandbox’s address', async () => {
    const { post, grants } = await setup()

    grants.bindSource('task-0001abcd', '10.231.0.9')
    expect((await post(chat)).status).toBe(403)

    grants.bindSource('task-0001abcd', '::ffff:127.0.0.1')
    expect((await post(chat)).status).toBe(200)
  })

  it('records timings and closed codes only, and logs no prompt, answer or token', async () => {
    const { post, records, logs, token } = await setup()

    await post(chat)
    await post({ ...chat, model: 'nhat-thuc' })

    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ status: 200, alias: 'nguyet-thuc', promptTokens: 12, completionTokens: 3, cachedTokens: null })
    expect(records[1]).toMatchObject({ status: 403, code: 'model_alias_not_granted' })
    const everything = JSON.stringify(records) + logs.join('\n')
    expect(everything).not.toContain('secret prompt')
    expect(everything).not.toContain('hello')
    expect(everything).not.toContain(token)
    // A refused projection is still one line, with its closed code and no alias or counts.
    expect(logs[1]).toMatch(/^\[broker\] task=task-0001abcd grant=g_[0-9a-f]{12} call=2 alias=none status=403 code=model_alias_not_granted ms=\d+$/)
  })
})

describe('a subscription grant reaches only the subscription edge', () => {
  const SUBSCRIPTION_ANSWER = {
    id: 'chatcmpl-sub', object: 'chat.completion', created: 2, model: 'glm-5.2',
    choices: [{ index: 0, message: { role: 'assistant', content: 'from my plan' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
  }

  async function subscriptionSetup(options: { edge?: boolean } = {}) {
    const grants = new ModelGrantRegistry()
    const managed = new FakeUpstream()
    const edge = new FakeUpstream()
    edge.respond = async () => ({ status: 200, json: SUBSCRIPTION_ANSWER })
    const records: BrokerRequestRecord[] = []
    const logs: string[] = []
    broker = new ModelBroker({
      host: '127.0.0.1', port: 0, grants, upstream: managed,
      ...(options.edge === false ? {} : { subscription: edge }),
      onRecord: record => records.push(record),
      log: line => logs.push(line)
    })
    const address = (await broker.start()) as AddressInfo
    const base = `http://127.0.0.1:${address.port}/v1`
    const { token } = grants.mint({
      taskId: 'task-0005abcd', aliases: ['glm-5.2'], expiresAt: Date.now() + 60_000,
      maxOutputTokens: 16_384, contextLength: 131_072, effort: 'high', source: 'opencode_go'
    })
    grants.bindSource('task-0005abcd', '127.0.0.1')
    const post = (body: unknown, auth: string | null = token) =>
      fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
        body: JSON.stringify(body)
      })
    return { grants, managed, edge, records, logs, base, token, post }
  }

  it('resolves the stable sandbox name without widening subscription authority', async () => {
    const { post, managed, edge } = await subscriptionSetup()
    const response = await post({ messages: [{ role: 'user', content: 'hello' }], model: 'default' })
    expect(response.status).toBe(200)
    expect(edge.calls[0]!.body.model).toBe('glm-5.2')
    expect(edge.calls[0]!.grant.aliases).toEqual(['glm-5.2'])
    const refused = await post({ messages: [{ role: 'user', content: 'hello' }], model: 'other-model' })
    expect(refused.status).toBe(403)
    expect((await refused.json()).error.code).toBe('model_alias_not_granted')
    expect(edge.completeCalls).toBe(1)
    expect(managed.calls).toHaveLength(0)
  })

  it('admits a dotted provider model, sends it to the edge, and never touches the managed gateway', async () => {
    const { post, managed, edge, records } = await subscriptionSetup()
    const response = await post({ messages: [{ role: 'user', content: 'hello' }], model: 'glm-5.2' })
    expect(response.status).toBe(200)
    expect((await response.json()).model).toBe('glm-5.2')
    expect(edge.completeCalls).toBe(1)
    expect(edge.streamCalls).toBe(0)
    expect(edge.calls[0]!.body).toMatchObject({ model: 'glm-5.2', stream: false, reasoning_effort: 'high' })
    expect(managed.calls).toHaveLength(0)
    expect(records.at(-1)).toMatchObject({ alias: 'glm-5.2', status: 200 })
  })

  it('synthesizes a stream from the edge’s non-streaming answer', async () => {
    const { post, edge } = await subscriptionSetup()
    const response = await post({ messages: [{ role: 'user', content: 'hello' }], stream: true })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('from my plan')
    expect(body).toContain('data: [DONE]')
    expect(edge.calls[0]!.body).toMatchObject({ stream: false })
  })

  it('ends a terminal subscription refusal with 403, one edge call, no retry and no fallback', async () => {
    const cases = [
      { edgeStatus: 403, error: 'subscription_unavailable', code: 'subscription_unavailable' },
      { edgeStatus: 502, error: 'subscription_rejected', code: 'subscription_rejected' },
      { edgeStatus: 409, error: 'subscription_revoked', code: 'subscription_revoked' },
      { edgeStatus: 429, error: 'subscription_rate_limited', code: 'subscription_rate_limited' },
      { edgeStatus: 403, error: 'subscription_unavailable', code: 'subscription_grant_exhausted',
        details: { reason: 'grant_exhausted' } }
    ] as const

    for (const refusal of cases) {
      const { post, managed, edge, logs } = await subscriptionSetup()
      edge.respond = async () => ({
        status: refusal.edgeStatus,
        json: { error: refusal.error, ...(('details' in refusal) ? { details: refusal.details } : {}) }
      })
      const response = await post({ messages: [{ role: 'user', content: 'hello' }] })
      const body = await response.json()
      expect(response.status, refusal.code).toBe(403)
      expect(body.error.code, refusal.code).toBe(refusal.code)
      expect(edge.completeCalls, refusal.code).toBe(1)
      expect(managed.calls, refusal.code).toHaveLength(0)
      expect(logs.filter(line => line.startsWith('[broker]')), refusal.code).toHaveLength(1)
      expect(logs.at(-1)).toContain(`code=${refusal.code}`)
      await broker?.stop()
      broker = null
    }
  })

  it('refuses a subscription grant when no subscription edge is configured', async () => {
    const { post, managed } = await subscriptionSetup({ edge: false })
    const response = await post({ messages: [{ role: 'user', content: 'hello' }] })
    expect(response.status).toBe(502)
    expect((await response.json()).error.code).toBe('subscription_unavailable')
    expect(managed.calls).toHaveLength(0)
  })

  it('keeps a managed grant separate and gives a subscription grant exactly one model', async () => {
    const { grants } = await subscriptionSetup()
    expect(grants.mint({ taskId: 'task-0006abcd', aliases: ['nguyet-thuc'], expiresAt: Date.now() + 60_000 })
      .grant.source).toBe('atum')
    expect(() => grants.mint({ taskId: 'task-0007abcd', aliases: ['glm-5.2', 'kimi-k3'],
      expiresAt: Date.now() + 60_000, source: 'opencode_go' })).toThrow('model_grant_invalid:aliases')
    expect(() => grants.mint({ taskId: 'task-0008abcd', aliases: ['glm-5.2'], expiresAt: Date.now() + 60_000,
      source: 'opencode_go', protection: { googlePolicy: 'limited_use_v1', latchState: 'eligible' } }))
      .toThrow('model_grant_invalid:protection')
  })

  it('routes ChatGPT-plan only to the Mac relay; offline never reaches managed billing', async () => {
    const grants = new ModelGrantRegistry()
    const managed = new FakeUpstream()
    const relay = new FakeUpstream()
    relay.respond = async () => ({ status: 503, json: { error: 'subscription_relay_offline' } })
    const logs: string[] = []
    broker = new ModelBroker({ host: '127.0.0.1', port: 0, grants, upstream: managed, chatgptRelay: relay,
      log: line => logs.push(line) })
    const address = (await broker.start()) as AddressInfo
    const invocationId = '00000000-0000-4000-8000-bd7662a5eeb4'
    const { token } = grants.mint({
      taskId: invocationId, aliases: ['gpt-5.6-luna'], expiresAt: Date.now() + 60_000,
      maxOutputTokens: 16_384, contextLength: 196_608, effort: 'medium', source: 'chatgpt_plan',
      relay: { ownerPrincipal: '00000000-0000-4000-8000-b454f82c5857',
        agentPrincipal: '00000000-0000-4000-8000-f6222a1106ee', invocationId,
        deviceServiceId: '00000000-0000-4000-8000-f1d11edf5c5c', revision: 1 }
    })
    grants.bindSource(invocationId, '127.0.0.1')
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'never log this prompt' }], stream: true })
    })
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('subscription_relay_offline')
    expect(relay.completeCalls).toBe(1)
    expect(relay.calls[0]!.body).toMatchObject({ model: 'gpt-5.6-luna', stream: false, reasoning_effort: 'medium' })
    expect(managed.calls).toHaveLength(0)
    expect(logs.join('\n')).not.toContain('never log this prompt')
    expect(logs.at(-1)).toContain('subscription_relay_offline')
  })
})

describe('the request projection', () => {
  const grant = new ModelGrantRegistry().mint({
    taskId: 'task-0002abcd',
    aliases: ['nguyet-thuc', 'nhat-thuc'],
    expiresAt: Date.now() + 60_000,
    maxOutputTokens: 4_096
  }).grant

  it('defaults the alias and the output cap, and maps max_completion_tokens', () => {
    expect(projectRequest(chat, grant).body).toMatchObject({ model: 'nguyet-thuc', max_tokens: 4_096 })
    expect(projectRequest({ ...chat, model: 'nhat-thuc', max_completion_tokens: 100 }, grant).body).toMatchObject({
      model: 'nhat-thuc',
      max_tokens: 100
    })
  })

  it('pins the grant’s effort over the sandbox’s, and forwards the sandbox’s only when the grant has none', () => {
    const pinned = new ModelGrantRegistry().mint({
      taskId: 'task-0003abcd', aliases: ['nhat-thuc'], expiresAt: Date.now() + 60_000, effort: 'low', contextLength: 120_000
    }).grant
    expect(projectRequest(chat, pinned).body).toMatchObject({ max_tokens: 65_536 })
    expect(projectRequest({ ...chat, reasoning_effort: 'high' }, pinned).body).toMatchObject({ reasoning_effort: 'low' })
    expect(projectRequest({ ...chat }, pinned).body).toMatchObject({ reasoning_effort: 'low' })
    expect(projectRequest({ ...chat, reasoning_effort: 'high' }, grant).body).toMatchObject({ reasoning_effort: 'high' })
  })

  it('refuses an effort outside the contract when admitting a grant', () => {
    expect(() => new ModelGrantRegistry().mint({ taskId: 'task-0004abcd', aliases: ['nhat-thuc'], expiresAt: Date.now() + 60_000,
      effort: 'max' as 'low' })).toThrow('model_grant_invalid:effort')
  })
})

it('caps each forwarded output by the remaining roundup allowance and denies before another upstream call', async () => {
  const { grants, token, upstream, post } = await setup()
  // Use a separate task because grants are immutable and duplicate admission is forbidden.
  const saved: Array<{ inputTokens: number; outputTokens: number }> = []
  const limited = grants.mint({ taskId: 'roundup-0002', aliases: ['nguyet-thuc'], expiresAt: Date.now()+60000,
    contextLength: 100000, maxOutputTokens: 20000,
    runBudget: { inputTokens: 300000, outputTokens: 12000, persist: value => saved.push({ ...value }) } })
  grants.bindSource('roundup-0002', '127.0.0.1')
  upstream.respond = async () => ({ status: 200, json: { ...ANSWER, usage: { prompt_tokens: 100000, completion_tokens: 7000 } } })
  expect((await post({ ...chat, max_tokens: 20000 }, limited.token)).status).toBe(200)
  expect(upstream.calls.at(-1)!.body.max_tokens).toBe(12000)
  upstream.respond = async () => ({ status: 200, json: { ...ANSWER, usage: { prompt_tokens: 100000, completion_tokens: 5000 } } })
  expect((await post({ ...chat, max_tokens: 20000 }, limited.token)).status).toBe(200)
  expect(upstream.calls.at(-1)!.body.max_tokens).toBe(5000)
  expect((await post(chat, limited.token)).status).toBe(403)
  expect(upstream.calls).toHaveLength(2)
  expect(saved.at(-1)).toEqual({ inputTokens: 200000, outputTokens: 12000 })
  // An ordinary task still has its usual independent grant.
  expect(grants.grantOf(token)?.runTokenBudget).toBeUndefined()
})

it('finishes 15 realistic roundup calls with discounted cache reads, then stops real excess', async () => {
  const { grants, upstream, post } = await setup()
  let saved = { inputTokens: 0, outputTokens: 0 }
  const limited = grants.mint({ taskId: 'real-roundup', aliases: ['nguyet-thuc'], expiresAt: Date.now()+60000,
    contextLength: 200000, maxRequests: 100, runBudget: { inputTokens: 300000, outputTokens: 12000,
      persist: v => { saved = v } } })
  grants.bindSource('real-roundup', '127.0.0.1')
  const tools = Array.from({ length: 40 }, (_, i) => ({ type: 'function', function: { name: `tool_${i}`,
    description: 'Read source data. '.repeat(20), parameters: { type: 'object', properties: {} } } }))
  for (let i = 0; i < 15; i++) {
    const prompt = 25000+i*1500
    upstream.respond = async () => ({ status: 200, json: { ...ANSWER,
      usage: { prompt_tokens: prompt, completion_tokens: 500, prompt_tokens_details: { cached_tokens: i ? prompt-6000 : 0 } } } })
    const messages = Array.from({ length: 22+i*2 }, (_, n) => ({ role: n % 2 ? 'assistant' : 'user', content: 'source text '.repeat(300) }))
    expect((await post({ messages, tools, max_tokens: 1000 }, limited.token)).status).toBe(200)
  }
  expect(saved.outputTokens).toBe(7500)
  expect(saved.inputTokens).toBeLessThan(200000)
  upstream.respond = async () => ({ status: 200, json: { ...ANSWER, usage: { prompt_tokens: 180000, completion_tokens: 1 } } })
  expect((await post(chat, limited.token)).status).toBe(200)
  expect((await post(chat, limited.token)).status).toBe(403)
  expect(upstream.calls).toHaveLength(16)
})

it('refunds transient refusals without usage and preserves recording on settle-save failure', async () => {
  const { grants, upstream, post, records, logs } = await setup()
  let saved = { inputTokens: 0, outputTokens: 0 }, fail = false
  const limited = grants.mint({ taskId: 'refund-roundup', aliases: ['nguyet-thuc'], expiresAt: Date.now()+60000,
    contextLength: 200000, runBudget: { inputTokens: 10000, outputTokens: 100,
      persist: v => { if (fail) throw Error('disk'); saved = v } } })
  grants.bindSource('refund-roundup', '127.0.0.1')
  upstream.respond = async () => ({ status: 503, json: { error: { code: 'busy' } } })
  for (let i = 0; i < 5; i++) {
    expect((await post(chat, limited.token)).status).toBe(503)
    expect(saved).toEqual({ inputTokens: 0, outputTokens: 0 })
  }
  upstream.respond = async () => { fail = true; return { status: 200, json: ANSWER } }
  expect((await post(chat, limited.token)).status).toBe(200)
  expect(records).toHaveLength(6)
  expect(logs).toContain('[broker] roundup_budget_persist_failed')
  expect(logs.at(-1)).toContain('status=200')
  // Reserve-save failure is terminal, with no upstream call or retryable 502.
  expect((await post(chat, limited.token)).status).toBe(403)
  expect(upstream.calls).toHaveLength(6)
})

it('estimates images independently of context size', async () => {
  const { grants, post } = await setup()
  const limited = grants.mint({ taskId: 'image-roundup', aliases: ['nguyet-thuc'], expiresAt: Date.now()+60000,
    contextLength: 1000000, runBudget: { inputTokens: 10000, outputTokens: 100, persist() {} } })
  grants.bindSource('image-roundup', '127.0.0.1')
  expect((await post({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,'+'a'.repeat(50000) } }] }] }, limited.token)).status).toBe(200)
})

it('refunds pre-upstream subscription refusals and stream setup failures', async () => {
  const { grants, upstream, post } = await setup()
  let saved = { inputTokens: 0, outputTokens: 0 }
  const make = (taskId: string, source: 'atum' | 'opencode_go' = 'atum') => {
    const value = grants.mint({ taskId, ...(source === 'atum' ? {} : { source }), aliases: ['nguyet-thuc'], expiresAt: Date.now()+60000,
      runBudget: { inputTokens: 10000, outputTokens: 100, persist: v => { saved = v } } })
    grants.bindSource(taskId, '127.0.0.1')
    return value.token
  }
  const subscription = make('no-edge-1', 'opencode_go')
  for (let i = 0; i < 3; i++) {
    expect((await post(chat, subscription)).status).toBe(502)
    expect(saved).toEqual({ inputTokens: 0, outputTokens: 0 })
  }
  const managed = make('stream-setup')
  upstream.streamRespond = async () => { throw Error('connection_refused') }
  expect((await post({ ...chat, stream: true }, managed)).status).toBe(502)
  expect(saved).toEqual({ inputTokens: 0, outputTokens: 0 })
  upstream.streamRespond = async () => ({ status: 200, events: (async function* () { throw Error('setup_failed') })() })
  const broken = await post({ ...chat, stream: true }, managed).catch(() => null)
  await broken?.text().catch(() => '')
  expect(saved).toEqual({ inputTokens: 0, outputTokens: 0 })
  upstream.respond = async () => ({ status: 200, json: ANSWER })
  expect((await post(chat, managed)).status).toBe(200)
  expect(saved).toEqual({ inputTokens: 12, outputTokens: 3 })
})
