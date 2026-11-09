import { afterEach, describe, expect, it, vi } from 'vitest'

import { ModelGrantRegistry } from '../src/model-grants'
import { GatewayUpstream } from '../src/gateway-upstream'

const request = () => ({
  body: { model: 'nguyet-thuc', messages: [] },
  grant: new ModelGrantRegistry().mint({ taskId: 'task-0001abcd', aliases: ['nguyet-thuc'], expiresAt: Date.now() + 60_000 }).grant,
  token: 'synthetic-grant',
  signal: new AbortController().signal
})

const options = {
  baseUrl: 'https://gateway.example/v1',
  controllerId: '00000000-0000-4000-8000-11e594f48195',
  credential: () => 'synthetic-controller-credential'
}

const encoder = new TextEncoder()
const event = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`)
const done = encoder.encode('data: [DONE]\n\n')

function bodyAt(schedule: Array<[number, Uint8Array]>, closeAt: number, cancelled: () => void = () => {}) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const [at, bytes] of schedule) setTimeout(() => controller.enqueue(bytes), at)
      setTimeout(() => controller.close(), closeAt)
    },
    cancel: cancelled
  })
}

afterEach(() => vi.useRealTimers())

describe('gateway response bounds', () => {
  it('accepts valid bounded JSON and closes malformed JSON without exposing it', async () => {
    const good = new GatewayUpstream({ ...options, fetchImpl: async () => new Response('{"choices":[]}') })
    expect((await good.complete(request())).json).toEqual({ choices: [] })
    const bad = new GatewayUpstream({ ...options, fetchImpl: async () => new Response('private provider error') })
    expect((await bad.complete(request())).json).toBeNull()
  })

  it('cancels a chunked response beyond the byte cap, even without Content-Length', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(8)) },
      cancel() { cancelled = true }
    })
    const upstream = new GatewayUpstream({ ...options, maxResponseBytes: 10, fetchImpl: async () => new Response(body) })
    await expect(upstream.complete(request())).rejects.toThrow('gateway_response_too_large')
    expect(cancelled).toBe(true)
  })

  it('keeps a healthy five-minute event stream alive when every byte gap is under one minute', async () => {
    vi.useFakeTimers()
    const schedule: Array<[number, Uint8Array]> = [
      [0, event({ choices: [{ delta: { content: 'a' } }] })],
      [50_000, event({ choices: [{ delta: { content: 'b' } }] })],
      [100_000, event({ choices: [{ delta: { content: 'c' } }] })],
      [150_000, event({ choices: [{ delta: { content: 'd' } }] })],
      [200_000, event({ choices: [{ delta: { content: 'e' } }] })],
      [250_000, event({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 5 } })],
      [300_000, done]
    ]
    const upstream = new GatewayUpstream({ ...options, timeoutMs: 1_000, streamIdleTimeoutMs: 60_000,
      fetchImpl: async () => new Response(bodyAt(schedule, 300_001), { headers: { 'content-type': 'text/event-stream' } }) })
    const response = await upstream.stream(request())
    if (!('events' in response)) throw new Error('expected stream')
    const collected = (async () => {
      const values = []
      for await (const value of response.events) values.push(value)
      return values
    })()

    await vi.advanceTimersByTimeAsync(300_001)
    const values = await collected
    expect(values).toHaveLength(7)
    expect(values.at(-1)).toEqual({ done: true })
  })

  it('cuts a stream whose next byte misses the idle bound', async () => {
    vi.useFakeTimers()
    let cancelled = false
    const upstream = new GatewayUpstream({ ...options, streamIdleTimeoutMs: 60_000,
      fetchImpl: async () => new Response(bodyAt([[0, event({ choices: [] })]], 120_000, () => { cancelled = true }),
        { headers: { 'content-type': 'text/event-stream' } }) })
    const response = await upstream.stream(request())
    if (!('events' in response)) throw new Error('expected stream')
    const collected = (async () => {
      for await (const _value of response.events) { /* consume */ }
    })()
    const outcome = collected.then(() => null, error => error as Error)

    await vi.advanceTimersByTimeAsync(60_001)
    expect((await outcome)?.message).toBe('gateway_stream_idle_timeout')
    expect(cancelled).toBe(true)
  })

  it('cancels a pending body read immediately when the grant signal ends', async () => {
    const authority = new AbortController()
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
    const upstream = new GatewayUpstream({ ...options, streamIdleTimeoutMs: 60_000,
      fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) })
    const response = await upstream.stream({ ...request(), signal: authority.signal })
    if (!('events' in response)) throw new Error('expected stream')
    const iterator = response.events[Symbol.asyncIterator]()
    const outcome = iterator.next().then(() => null, error => error as Error)

    authority.abort(new Error('grant_revoked'))
    expect((await outcome)?.message).toBe('grant_revoked')
    expect(cancelled).toBe(true)
  })

  it('accepts harmless whitespace around the terminal DONE marker', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('data: [DONE] \r\n\r\n')); controller.close() }
    })
    const upstream = new GatewayUpstream({ ...options,
      fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) })
    const response = await upstream.stream(request())
    if (!('events' in response)) throw new Error('expected stream')
    const values = []
    for await (const value of response.events) values.push(value)
    expect(values).toEqual([{ done: true }])
  })

  it('caps stream framing separately and requires an event-stream response', async () => {
    let cancelled = false
    const tooLarge = new GatewayUpstream({ ...options, maxStreamBytes: 10,
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(11)) },
        cancel() { cancelled = true }
      }), { headers: { 'content-type': 'text/event-stream' } }) })
    const response = await tooLarge.stream(request())
    if (!('events' in response)) throw new Error('expected stream')
    await expect((async () => { for await (const _value of response.events) { /* consume */ } })())
      .rejects.toThrow('gateway_stream_too_large')
    expect(cancelled).toBe(true)

    const wrongType = new GatewayUpstream({ ...options,
      fetchImpl: async () => new Response('private response', { headers: { 'content-type': 'text/plain' } }) })
    await expect(wrongType.stream(request())).rejects.toThrow('gateway_stream_invalid')
  })
})

describe('the managed gateway refuses a subscription grant', () => {
  it('never sends the subscription token to the Atum gateway', async () => {
    const grants = new ModelGrantRegistry()
    const { grant } = grants.mint({
      taskId: 'task-0002abcd', aliases: ['glm-5.2'], expiresAt: Date.now() + 60_000, source: 'opencode_go'
    })
    const fetchImpl = vi.fn(async () => new Response('{"choices":[]}'))
    const upstream = new GatewayUpstream({ ...options, fetchImpl })
    const input = { body: { model: 'glm-5.2', messages: [] }, grant, token: 'synthetic-subscription-token', signal: new AbortController().signal }
    await expect(upstream.complete(input)).rejects.toThrow('subscription_grant_at_managed_gateway')
    await expect(upstream.stream(input)).rejects.toThrow('subscription_grant_at_managed_gateway')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('also refuses a ChatGPT-plan relay grant before fetch', async () => {
    const invocationId = '00000000-0000-4000-8000-bd7662a5eeb4'
    const { grant } = new ModelGrantRegistry().mint({ taskId: invocationId, aliases: ['gpt-5.6-luna'],
      expiresAt: Date.now() + 60_000, source: 'chatgpt_plan', relay: {
        ownerPrincipal: '00000000-0000-4000-8000-b454f82c5857',
        agentPrincipal: '00000000-0000-4000-8000-f6222a1106ee', invocationId,
        deviceServiceId: '00000000-0000-4000-8000-f1d11edf5c5c', revision: 1 } })
    const fetchImpl = vi.fn(async () => new Response('{"choices":[]}'))
    const upstream = new GatewayUpstream({ ...options, fetchImpl })
    await expect(upstream.complete({ ...request(), grant })).rejects.toThrow('subscription_grant_at_managed_gateway')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
