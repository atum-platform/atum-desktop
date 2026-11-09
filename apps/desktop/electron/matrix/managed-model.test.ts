import { request as httpRequest } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MATRIX_DEFAULT_EFFORT,
  MATRIX_EFFORTS,
  MATRIX_MODEL_EFFORTS,
  type MatrixEffort,
  type MatrixModelId
} from '../../shared/matrix-models'
import {
  MATRIX_STORE_RUN_MODEL_ALIAS,
  type MatrixStoreRunJob,
  matrixStoreRunModel
} from '../../shared/matrix-store-schedules'

import { MATRIX_MANAGED_OUTPUT_STEPS, MatrixManagedModel, matrixManagedOutputSteps } from './managed-model'

const KEY = 'a'.repeat(64)
const DIGEST: MatrixStoreRunJob = { itemId: 'agent/researcher', scheduleId: 'weekly-digest' }
const proxies: MatrixManagedModel[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(proxies.splice(0).map(proxy => proxy.stop()))
})

async function proxy(
  options: {
    bearer?: (refresh: boolean) => Promise<string | null>
    key?: string | null
    keys?: Iterable<readonly [string, string]>
    model?: () => MatrixModelId
    effort?: () => MatrixEffort | undefined
    training?: ConstructorParameters<typeof MatrixManagedModel>[0]['training']
    hatch?: ConstructorParameters<typeof MatrixManagedModel>[0]['hatch']
    hatchKey?: ConstructorParameters<typeof MatrixManagedModel>[0]['hatchKey']
    checkInCall?: ConstructorParameters<typeof MatrixManagedModel>[0]['checkInCall']
    sweepCall?: ConstructorParameters<typeof MatrixManagedModel>[0]['sweepCall']
    scheduledRun?: ConstructorParameters<typeof MatrixManagedModel>[0]['scheduledRun']
    route?: ConstructorParameters<typeof MatrixManagedModel>[0]['route']
  } = {}
) {
  const bearer = vi.fn(
    options.bearer ?? (async (refresh: boolean) => (refresh ? 'fresh-domain-token' : 'domain-token'))
  )

  const model = new MatrixManagedModel({
    gateway: 'https://gateway.test',
    port: 0,
    keys: () => options.keys ?? (options.key === null ? [] : [[options.key ?? KEY, 'agent'] as const]),
    bearer,
    training: options.training,
    hatch: options.hatch,
    hatchKey: options.hatchKey,
    checkInCall: options.checkInCall,
    sweepCall: options.sweepCall,
    scheduledRun: options.scheduledRun,
    route: options.route,
    model: options.model ?? (() => 'nguyet-thuc'),
    ...(options.effort ? { effort: options.effort } : {})
  })

  await model.start()
  proxies.push(model)

  return { model, bearer, port: Number(new URL(model.baseUrl).port) }
}

/** Plain node:http, because the test stubs the global fetch the proxy uses upstream. */
function call(
  port: number,
  input: { method?: string; path?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: string; type?: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: input.method ?? 'POST',
        path: input.path ?? '/v1/chat/completions',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...input.headers }
      },
      res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, type: res.headers['content-type'] }))
      }
    )

    req.on('error', reject)
    // A proxy that refuses an oversized body answers and drops the connection while the client is still
    // writing, so the rest of the write fails (EPIPE/ECONNRESET) on a socket whose request already got its
    // answer. By then nothing listens on that socket and the error would escape as an uncaught exception.
    req.on('socket', socket => socket.on('error', () => {}))
    // Node sends a GET body unframed, which would corrupt the next keep-alive request.
    req.end(
      (input.method ?? 'POST') === 'GET'
        ? undefined
        : (input.body ?? JSON.stringify({ model: 'binh-minh', messages: [{ role: 'user', content: 'hi' }] }))
    )
  })
}

describe('managed model loopback proxy', () => {
  it('forwards only a main-authorized hatch as alias hatch with its operation header and no Store context', async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: 'ok' }))
    vi.stubGlobal('fetch', upstream)

    const training = vi.fn(async () => ({
      taskId: '00000000-0000-4000-8000-bc840fdd0fe5',
      assistantId: '00000000-0000-4000-8000-20101becbd5c',
      executorId: '00000000-0000-4000-8000-7c5d7c56e9c8',
      conversationId: '!real:atum.test',
      leaseToken: '00000000-0000-4000-8000-3f24ac60855c'
    }))

    const HATCH_KEY = 'b'.repeat(64)

    const hatch = vi.fn(
      async (agent: string, operationId: string, key: string) =>
        agent === 'agent' && operationId === 'pet-op' && key === HATCH_KEY
    )

    const { port } = await proxy({
      training,
      hatch,
      hatchKey: (_agent, key) => key === HATCH_KEY,
      model: () => 'nguyet-thuc',
      keys: [
        [KEY, 'agent'],
        [HATCH_KEY, 'agent']
      ]
    })

    // A normal Hermes endpoint key cannot forge an active operation.
    expect((await call(port, { headers: { 'X-Atum-Pet-Operation': 'pet-op' } })).status).toBe(403)

    expect(
      (
        await call(port, {
          body: JSON.stringify({ model: 'nguyet-thuc', messages: [] }),
          headers: {
            Authorization: `Bearer ${HATCH_KEY}`,
            'X-Atum-Pet-Operation': 'pet-op',
            'X-Atum-Store-Task': 'forged'
          }
        })
      ).status
    ).toBe(200)
    const init = upstream.mock.calls[0]![1] as RequestInit
    expect(JSON.parse(Buffer.from(init.body as Uint8Array).toString()).model).toBe('hatch')
    expect(init.headers).toMatchObject({ 'X-Atum-Pet-Operation': 'pet-op' })
    expect(JSON.stringify(init.headers)).not.toContain('X-Atum-Store')
    expect(training).not.toHaveBeenCalled()
    expect(hatch).toHaveBeenLastCalledWith('agent', 'pet-op', HATCH_KEY, expect.any(AbortSignal))
  })
  it('refuses an ephemeral hatch key without its operation header before normal billing or training', async () => {
    const upstream = vi.fn()
    vi.stubGlobal('fetch', upstream)
    const HATCH_KEY = 'b'.repeat(64)

    const training = vi.fn(async () => ({
      taskId: '00000000-0000-4000-8000-bc840fdd0fe5',
      assistantId: '00000000-0000-4000-8000-20101becbd5c',
      executorId: '00000000-0000-4000-8000-7c5d7c56e9c8',
      conversationId: '!real:atum.test'
    }))

    const { port } = await proxy({
      training,
      hatchKey: (_agent, key) => key === HATCH_KEY,
      keys: [[HATCH_KEY, 'agent']]
    })

    const result = await call(port, { headers: { Authorization: `Bearer ${HATCH_KEY}` } })
    expect(result.status).toBe(403)
    expect(result.body).toContain('atum_pet_hatch_denied')
    expect(training).not.toHaveBeenCalled()
    expect(upstream).not.toHaveBeenCalled()
  })
  it('refuses stale or forged hatch operations before gateway dispatch', async () => {
    const upstream = vi.fn()
    vi.stubGlobal('fetch', upstream)
    const hatch = vi.fn(async () => false)
    const { port } = await proxy({ hatch })
    const result = await call(port, { headers: { 'X-Atum-Pet-Operation': 'stale-operation' } })
    expect(result.status).toBe(403)
    expect(result.body).toContain('atum_pet_hatch_denied')
    expect(upstream).not.toHaveBeenCalled()
  })
  it('uses only native-resolved execution context and never forwards caller store headers', async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: 'ok' }))
    vi.stubGlobal('fetch', upstream)

    const binding = {
      taskId: '00000000-0000-4000-8000-bc840fdd0fe5',
      assistantId: '00000000-0000-4000-8000-20101becbd5c',
      executorId: '00000000-0000-4000-8000-7c5d7c56e9c8',
      conversationId: '!real:atum.test',
      leaseToken: '00000000-0000-4000-8000-3f24ac60855c'
    }

    const training = vi.fn(async () => binding),
      { port } = await proxy({ training })

    expect(
      (
        await call(port, {
          headers: { 'X-Atum-Store-Task': 'forged', 'X-Atum-Store-Conversation': '!foreign:atum.test' }
        })
      ).status
    ).toBe(200)
    const headers = upstream.mock.calls[0]![1].headers as Record<string, string>
    expect(headers['X-Atum-Store-Task']).toBe(binding.taskId)
    expect(headers['X-Atum-Store-Conversation']).toBe(binding.conversationId)
    expect(headers['X-Atum-Store-Lease']).toBe(binding.leaseToken)
    expect(headers['X-Atum-Store-Invocation']).toBeUndefined()
    expect(training).toHaveBeenCalledWith('agent', expect.any(AbortSignal))
    const plain = await proxy()
    await call(plain.port, { headers: { 'X-Atum-Store-Task': 'forged' } })
    expect(JSON.stringify(upstream.mock.calls[1]![1].headers)).not.toContain('X-Atum-Store')
  })
  it('refuses a failed native execution resolution before contacting or charging the gateway', async () => {
    const upstream = vi.fn()
    vi.stubGlobal('fetch', upstream)

    const { port, bearer } = await proxy({
      training: async () => {
        throw new Error('private canary')
      }
    })

    const result = await call(port)
    expect(result.status).toBe(403)
    expect(result.body).not.toContain('private canary')
    expect(upstream).not.toHaveBeenCalled()
    expect(bearer).not.toHaveBeenCalled()
  })
  it('forwards chat completions with the domain token, never the local key, and streams the answer', async () => {
    const upstream = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    )

    vi.stubGlobal('fetch', upstream)
    const { port } = await proxy()
    const result = await call(port)
    expect(result).toMatchObject({
      status: 200,
      body: 'data: {"choices":[]}\n\ndata: [DONE]\n\n',
      type: 'text/event-stream'
    })
    expect(upstream).toHaveBeenCalledWith(
      'https://gateway.test/v1/chat/completions',
      expect.objectContaining({ method: 'POST', redirect: 'error' })
    )
    const init = upstream.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer domain-token')
    expect(JSON.stringify(init.headers)).not.toContain(KEY)
    // The retired name Hermes still holds for an old conversation goes to the turn's model.
    expect(JSON.parse(Buffer.from(init.body as Uint8Array).toString())).toEqual({
      model: 'nguyet-thuc',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: MATRIX_DEFAULT_EFFORT
    })
  })
  it("sends each completion to the running turn's model and leaves anything else for the gateway", async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: 'ok' }))
    vi.stubGlobal('fetch', upstream)
    let chosen: MatrixModelId = 'nhat-thuc'
    const { port } = await proxy({ model: () => chosen })
    const sent = () => Buffer.from(upstream.mock.calls.at(-1)![1].body as Uint8Array).toString()

    for (const name of ['nguyet-thuc', 'nhat-thuc', 'binh-minh']) {
      await call(port, { body: JSON.stringify({ model: name, messages: [], stream: true }) })
      expect(JSON.parse(sent())).toEqual({
        model: 'nhat-thuc',
        messages: [],
        stream: true,
        reasoning_effort: MATRIX_DEFAULT_EFFORT
      })
    }

    chosen = 'nguyet-thuc'
    await call(port, { body: JSON.stringify({ model: 'nhat-thuc', messages: [] }) })
    expect(JSON.parse(sent()).model).toBe('nguyet-thuc')

    // Not Atum's model, or not readable: forwarded unchanged, for the gateway to refuse.
    await call(port, { body: JSON.stringify({ model: 'gpt-4o', messages: [] }) })
    expect(JSON.parse(sent()).model).toBe('gpt-4o')
    await call(port, { body: 'not json' })
    expect(sent()).toBe('not json')

    for (const body of ['null', '[{"model":"nguyet-thuc"}]', '{"messages":[]}']) {
      await call(port, { body })
      expect(sent()).toBe(body)
    }
  })
  it("sends a check-in to the everyday model, whatever turn runs, and never into that turn's Store task", async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: 'ok' }))
    vi.stubGlobal('fetch', upstream)

    const training = vi.fn(async () => ({
      taskId: '00000000-0000-4000-8000-bc840fdd0fe5',
      assistantId: '00000000-0000-4000-8000-20101becbd5c',
      executorId: '00000000-0000-4000-8000-7c5d7c56e9c8',
      conversationId: '!real:atum.test',
      leaseToken: '00000000-0000-4000-8000-3f24ac60855c'
    }))

    // A turn on the dearer model is running for the same agent.
    const { port } = await proxy({ model: () => 'nhat-thuc', training, checkInCall: () => true })
    await call(port, { body: JSON.stringify({ model: 'atum-check-in', messages: [], max_tokens: 1000 }) })

    const init = upstream.mock.calls[0]![1]
    expect(JSON.parse(Buffer.from(init.body as Uint8Array).toString())).toEqual({
      model: 'nguyet-thuc',
      messages: [],
      max_tokens: 1000
    })
    expect(JSON.stringify(init.headers)).not.toContain('X-Atum-Store')
    expect(training).not.toHaveBeenCalled()
    // The turn's own request still goes to its model, in its task.
    await call(port, { body: JSON.stringify({ model: 'nguyet-thuc', messages: [] }) })
    expect(JSON.parse(Buffer.from(upstream.mock.calls[1]![1].body as Uint8Array).toString()).model).toBe('nhat-thuc')
    expect(training).toHaveBeenCalledTimes(1)
  })

  it('binds one background sweep call to its dispatched model, attribution and hold', async () => {
    let sent: RequestInit | undefined
    const upstream = vi.fn(async (_url: string, init: RequestInit) => {
      sent = init
      return Response.json({ choices: [] })
    })
    vi.stubGlobal('fetch', upstream)
    const training = vi.fn(async () => ({
      taskId: '00000000-0000-4000-8000-bc840fdd0fe5',
      assistantId: '00000000-0000-4000-8000-20101becbd5c',
      executorId: '00000000-0000-4000-8000-7c5d7c56e9c8',
      conversationId: '!real:atum.test'
    }))
    const calls = [{
      authorizationId: '00000000-0000-4000-8000-463bfa64f08a',
      attributionId: '00000000-0000-4000-8000-5bb08005840f',
      model: 'nguyet-thuc' as const,
      effort: 'medium' as const,
      protection: 'standard' as const,
      maxModelMicroProtons: 114_210_000
    }]
    const sweepCall = vi.fn(() => calls.shift() ?? null)
    const { port } = await proxy({ model: () => 'nhat-thuc', training, sweepCall })
    const body = JSON.stringify({ model: 'atum-followup-sweep', messages: [], max_tokens: 1000 })

    expect((await call(port, { body })).status).toBe(200)
    const init = sent!
    expect(JSON.parse(Buffer.from(init.body as Uint8Array).toString())).toMatchObject({
      model: 'nguyet-thuc', reasoning_effort: 'medium', max_tokens: 1000
    })
    expect(init.headers).toMatchObject({
      'X-Atum-Sweep-Authorization': '00000000-0000-4000-8000-463bfa64f08a',
      'X-Atum-Sweep-Attribution': '00000000-0000-4000-8000-5bb08005840f',
      'X-Atum-Sweep-Max-Micro-Protons': '114210000'
    })
    expect(training).not.toHaveBeenCalled()

    const refused = await call(port, { body })
    expect(refused.status).toBe(403)
    expect(refused.body).toContain('atum_background_sweep_denied')
    expect(upstream).toHaveBeenCalledOnce()
  })

  it('forces a protected native sweep from its first model token', async () => {
    let sentInit: RequestInit | undefined
    const upstream = vi.fn(async (_url: string, init: RequestInit) => {
      sentInit = init
      return Response.json({ choices: [] })
    })
    vi.stubGlobal('fetch', upstream)
    const { port } = await proxy({
      route: () => 'protected',
      sweepCall: () => ({
        authorizationId: '00000000-0000-4000-8000-463bfa64f08a',
        attributionId: '00000000-0000-4000-8000-5bb08005840f',
        model: 'nguyet-thuc',
        effort: 'medium',
        protection: 'google_protected',
        maxModelMicroProtons: 300_000_000
      })
    })

    expect((await call(port, { body: JSON.stringify({ model: 'atum-followup-sweep', messages: [] }) })).status).toBe(200)
    const sent = JSON.parse(Buffer.from(sentInit!.body as Uint8Array).toString())
    expect(sent.model).toBe('google-protected')
  })
  it("binds a paid assistant's scheduled run to its home-room Store task on the agent's own model", async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: 'ok' }))
    vi.stubGlobal('fetch', upstream)

    const binding = {
      taskId: '00000000-0000-4000-8000-4266a7446ed5',
      assistantId: '00000000-0000-4000-8000-2906f24444d9',
      executorId: '00000000-0000-4000-8000-b2d5ad235f3b',
      conversationId: '!home:atum.test',
      leaseToken: '00000000-0000-4000-8000-a5e54dc7cb86'
    }

    const scheduledRun = vi.fn(async () => binding)
    // A typed turn's task never binds a scheduled run.
    const training = vi.fn(async () => null)
    const { port } = await proxy({ model: () => 'nhat-thuc', scheduledRun, training })

    const answer = await call(port, {
      body: JSON.stringify({ model: matrixStoreRunModel(DIGEST), messages: [], max_tokens: 900 })
    })

    expect(answer.status).toBe(200)
    // The job is read back from its model name: its slot is claimed on its own.
    expect(scheduledRun).toHaveBeenCalledWith('agent', DIGEST, expect.any(AbortSignal))
    expect(training).not.toHaveBeenCalled()
    const init = upstream.mock.calls[0]![1]
    expect(JSON.parse(Buffer.from(init.body as Uint8Array).toString())).toEqual({
      model: 'nhat-thuc',
      messages: [],
      max_tokens: 900
    })
    expect(init.headers).toMatchObject({
      'X-Atum-Store-Task': binding.taskId,
      'X-Atum-Store-Assistant': binding.assistantId,
      'X-Atum-Store-Executor': binding.executorId,
      'X-Atum-Store-Conversation': '!home:atum.test',
      'X-Atum-Store-Lease': binding.leaseToken
    })
  })
  it('answers a scheduled run with silence, never forwarded or charged, on a Mac without the lease', async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: 'ok' }))
    vi.stubGlobal('fetch', upstream)
    const { port, bearer } = await proxy({ scheduledRun: async () => null })
    const run = { model: matrixStoreRunModel(DIGEST), messages: [{ role: 'user', content: 'Write the digest.' }] }

    const plain = await call(port, { body: JSON.stringify(run) })
    expect(plain.status).toBe(200)
    expect(JSON.parse(plain.body).choices[0].message.content).toBe('[SILENT]')

    const streamed = await call(port, { body: JSON.stringify({ ...run, stream: true }) })
    expect(streamed.type).toBe('text/event-stream')
    expect(streamed.body).toContain('"content":"[SILENT]"')

    expect(upstream).not.toHaveBeenCalled()
    expect(bearer).not.toHaveBeenCalled()
  })
  it('refuses a scheduled run the Store would not bind, and a build without the binding stays silent', async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: 'ok' }))
    vi.stubGlobal('fetch', upstream)
    const run = JSON.stringify({ model: matrixStoreRunModel(DIGEST), messages: [] })

    const refused = await proxy({
      scheduledRun: async () => {
        throw new Error('matrix_store_execution_denied')
      }
    })

    const denied = await call(refused.port, { body: run })
    expect(denied.status).toBe(403)
    expect(denied.body).toContain('atum_store_execution_denied')

    const unbound = await proxy()
    expect(JSON.parse((await call(unbound.port, { body: run })).body).choices[0].message.content).toBe('[SILENT]')

    // A Store run model naming no job this build knows (the bare alias, or another build's
    // job) is never bound: silent, and the binding is not even asked for.
    const scheduledRun = vi.fn(async () => {
      throw new Error('unexpected')
    })

    const strange = await proxy({ scheduledRun })

    for (const model of [MATRIX_STORE_RUN_MODEL_ALIAS, `${MATRIX_STORE_RUN_MODEL_ALIAS}-researcher-no-such-job`]) {
      const answer = await call(strange.port, { body: JSON.stringify({ model, messages: [] }) })
      expect(JSON.parse(answer.body).choices[0].message.content).toBe('[SILENT]')
    }

    expect(scheduledRun).not.toHaveBeenCalled()
    expect(upstream).not.toHaveBeenCalled()
  })
  it('lets a check-in make one model call per claimed check, and answers any other with silence, uncharged', async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: 'ok' }))
    vi.stubGlobal('fetch', upstream)
    const calls = [true]
    const checkInCall = vi.fn(() => calls.shift() ?? false)
    const { port } = await proxy({ checkInCall })
    const checkIn = { model: 'atum-check-in', messages: [{ role: 'user', content: 'Check in.' }], max_tokens: 1000 }

    // The claimed check's call goes to the gateway.
    expect((await call(port, { body: JSON.stringify(checkIn) })).status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(1)

    // A second call for the same check (a continuation, a retry) is answered here.
    const again = await call(port, { body: JSON.stringify(checkIn) })
    expect(again.status).toBe(200)
    expect(JSON.parse(again.body).choices[0].message.content).toBe('[SILENT]')

    // So is a streamed one, as a stream.
    const streamed = await call(port, { body: JSON.stringify({ ...checkIn, stream: true }) })
    expect(streamed.type).toBe('text/event-stream')
    expect(streamed.body).toContain('"content":"[SILENT]"')
    expect(streamed.body.trim().endsWith('data: [DONE]')).toBe(true)

    expect(upstream).toHaveBeenCalledTimes(1)
    expect(checkInCall).toHaveBeenCalledWith('agent')

    // Anything else is not a check-in and goes through as ever.
    await call(port, { body: JSON.stringify({ model: 'nguyet-thuc', messages: [] }) })
    expect(upstream).toHaveBeenCalledTimes(2)
    expect(checkInCall).toHaveBeenCalledTimes(3)
  })
  it('changes only the model and states the level: tools, sampling, caps and streaming go through as sent', async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: 'ok' }))
    vi.stubGlobal('fetch', upstream)
    const { port } = await proxy({ model: () => 'nhat-thuc' })

    const request = {
      model: 'binh-minh',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'terminal', parameters: { type: 'object' } } }],
      temperature: 0.2,
      max_tokens: 900,
      stream: true,
      stream_options: { include_usage: true }
    }

    await call(port, { body: JSON.stringify(request) })
    expect(JSON.parse(Buffer.from(upstream.mock.calls[0]![1].body as Uint8Array).toString())).toEqual({
      ...request,
      model: 'nhat-thuc',
      reasoning_effort: MATRIX_DEFAULT_EFFORT
    })
  })
  it.each(['nguyet-thuc', 'nhat-thuc'] as const)(
    'sends the default effort on %s when none was stored or the stored level is not offered',
    async chosen => {
      const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: 'ok' }))
      vi.stubGlobal('fetch', upstream)
      let effort: MatrixEffort | undefined
      const { port } = await proxy({ model: () => chosen, effort: () => effort })
      const sent = () => JSON.parse(Buffer.from(upstream.mock.calls.at(-1)![1].body as Uint8Array).toString())

      await call(port, { body: JSON.stringify({ model: 'nguyet-thuc', messages: [] }) })
      expect(sent()).toEqual({ model: chosen, messages: [], reasoning_effort: MATRIX_DEFAULT_EFFORT })

      // A level the picked model's list no longer holds is replaced, not dropped.
      for (const stale of MATRIX_EFFORTS.filter(level => !MATRIX_MODEL_EFFORTS[chosen].includes(level))) {
        effort = stale
        await call(port, { body: JSON.stringify({ model: 'nguyet-thuc', messages: [], reasoning_effort: 'max' }) })
        expect(sent()).toEqual({ model: chosen, messages: [], reasoning_effort: MATRIX_DEFAULT_EFFORT })
      }
    }
  )

  it('keeps a stored level the chosen model offers', async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: 'ok' }))
    vi.stubGlobal('fetch', upstream)
    // Written against the list, so this still holds when the dial returns.
    const stored = MATRIX_MODEL_EFFORTS['nhat-thuc'][0]!
    const { port } = await proxy({ model: () => 'nhat-thuc', effort: () => stored })
    await call(port, { body: JSON.stringify({ model: 'nguyet-thuc', messages: [], reasoning_effort: 'max' }) })
    expect(JSON.parse(Buffer.from(upstream.mock.calls.at(-1)![1].body as Uint8Array).toString())).toEqual({
      model: 'nhat-thuc', messages: [], reasoning_effort: stored
    })
  })

  it("sends the turn's level with Atum's model only, and none to a check-in or a foreign model", async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: 'ok' }))
    vi.stubGlobal('fetch', upstream)
    let effort: MatrixEffort | undefined = 'high'
    const checkInCall = vi.fn(() => true)
    const { port } = await proxy({ model: () => 'nhat-thuc', effort: () => effort, checkInCall })
    const sent = () => JSON.parse(Buffer.from(upstream.mock.calls.at(-1)![1].body as Uint8Array).toString())

    await call(port, { body: JSON.stringify({ model: 'nguyet-thuc', messages: [], reasoning_effort: 'max' }) })
    // A stale stored level is replaced by the default, over whatever Hermes put there.
    expect(sent()).toEqual({ model: 'nhat-thuc', messages: [], reasoning_effort: MATRIX_DEFAULT_EFFORT })

    effort = 'medium'
    await call(port, { body: JSON.stringify({ model: 'nguyet-thuc', messages: [] }) })
    expect(sent()).toEqual({ model: 'nhat-thuc', messages: [], reasoning_effort: 'medium' })

    // A check-in, or a model the proxy does not name, never carries the turn's level.
    await call(port, { body: JSON.stringify({ model: 'atum-check-in', messages: [] }) })
    expect(sent()).toEqual({ model: 'nguyet-thuc', messages: [] })
    await call(port, { body: JSON.stringify({ model: 'someone-elses', messages: [] }) })
    expect(sent()).toEqual({ model: 'someone-elses', messages: [] })
  })
  it("never gives a paid assistant's Store run or a pet hatch the running turn's thinking level", async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: 'ok' }))
    vi.stubGlobal('fetch', upstream)
    const HATCH_KEY = 'b'.repeat(64)

    const binding = {
      taskId: '00000000-0000-4000-8000-28309c0dd9eb',
      assistantId: '00000000-0000-4000-8000-a03a0d3664fe',
      executorId: '00000000-0000-4000-8000-1b7b3a4b2781',
      conversationId: '!home:atum.test',
      leaseToken: '00000000-0000-4000-8000-88171f86e2da'
    }

    // The person's own turn is running at Kỹ on the dearer model while the job fires.
    const { port } = await proxy({
      model: () => 'nhat-thuc',
      effort: () => 'high',
      scheduledRun: async () => binding,
      hatch: async (_agent, operationId, key) => operationId === 'pet-op' && key === HATCH_KEY,
      hatchKey: (_agent, key) => key === HATCH_KEY,
      keys: [
        [KEY, 'agent'],
        [HATCH_KEY, 'agent']
      ]
    })

    const sent = () => JSON.parse(Buffer.from(upstream.mock.calls.at(-1)![1].body as Uint8Array).toString())

    await call(port, { body: JSON.stringify({ model: matrixStoreRunModel(DIGEST), messages: [], max_tokens: 900 }) })
    expect(sent()).toEqual({ model: 'nhat-thuc', messages: [], max_tokens: 900 })
    expect(upstream.mock.calls.at(-1)![1].headers).toMatchObject({ 'X-Atum-Store-Task': binding.taskId })

    // Whatever level the job's request carried is dropped too: the job runs at the default.
    await call(port, {
      body: JSON.stringify({ model: matrixStoreRunModel(DIGEST), messages: [], reasoning_effort: 'high' })
    })
    expect(sent()).toEqual({ model: 'nhat-thuc', messages: [] })

    await call(port, {
      body: JSON.stringify({ model: 'nguyet-thuc', messages: [] }),
      headers: { Authorization: `Bearer ${HATCH_KEY}`, 'X-Atum-Pet-Operation': 'pet-op' }
    })
    expect(sent()).toEqual({ model: 'hatch', messages: [] })

    // The person's own turn still carries a level; a stale high becomes the default.
    await call(port, { body: JSON.stringify({ model: 'nguyet-thuc', messages: [] }) })
    expect(sent()).toEqual({ model: 'nhat-thuc', messages: [], reasoning_effort: MATRIX_DEFAULT_EFFORT })
  })
  it('refuses browsers, a wrong or missing key, and every other route, without calling the gateway', async () => {
    const upstream = vi.fn()
    vi.stubGlobal('fetch', upstream)
    const { port } = await proxy()
    expect((await call(port, { headers: { Origin: 'https://evil.test' } })).status).toBe(403)
    expect((await call(port, { headers: { Host: 'evil.test' } })).status).toBe(403)
    expect((await call(port, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await call(port, { headers: { Authorization: '' } })).status).toBe(401)
    expect((await call(port, { path: '/v1/embeddings' })).status).toBe(404)
    expect((await call(port, { method: 'GET', path: '/v1/chat/completions' })).status).toBe(404)
    expect((await call(port, { path: '/key/generate' })).status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
    const signedOut = await proxy({ key: null })
    expect((await call(signedOut.port)).status).toBe(401)
  })
  it('retries a refused token once with a fresh one, and never retries anything else', async () => {
    const upstream = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(Response.json({ id: 'ok' }))

    vi.stubGlobal('fetch', upstream)
    const { port, bearer } = await proxy()
    expect((await call(port)).status).toBe(200)
    expect(bearer.mock.calls).toEqual([[false], [true]])
    expect(((upstream.mock.calls[1]![1] as RequestInit).headers as Record<string, string>).Authorization).toBe(
      'Bearer fresh-domain-token'
    )

    upstream.mockReset()
    upstream.mockResolvedValue(new Response('{"error":"atum_model_unavailable"}', { status: 503 }))
    const unavailable = await call(port)
    expect(unavailable.status).toBe(503)
    expect(unavailable.body).toContain('atum_model_unavailable')
    expect(upstream).toHaveBeenCalledTimes(1)

    upstream.mockReset()
    upstream.mockResolvedValue(new Response('{}', { status: 401 }))
    expect((await call(port)).status).toBe(401)
    expect(upstream).toHaveBeenCalledTimes(2)
  })
  it('spends the last Protons: a hold refused for the balance asks again with a smaller answer (FR13)', async () => {
    const refused = () =>
      new Response('{"error":{"message":"insufficient_protons","code":"402"}}', {
        status: 402,
        headers: { 'Content-Type': 'application/json' }
      })

    const upstream = vi
      .fn()
      .mockResolvedValueOnce(refused())
      .mockResolvedValueOnce(refused())
      .mockResolvedValueOnce(new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))

    vi.stubGlobal('fetch', upstream)
    const { port } = await proxy()
    const sent = (index: number) => JSON.parse(Buffer.from(upstream.mock.calls[index]![1].body as Uint8Array).toString())

    const answer = await call(port, {
      body: JSON.stringify({ model: 'nguyet-thuc', messages: [], max_completion_tokens: 16384, stream: true })
    })

    expect(answer).toMatchObject({ status: 200, body: 'data: [DONE]\n\n', type: 'text/event-stream' })
    expect(upstream).toHaveBeenCalledTimes(3)
    expect(sent(0).max_completion_tokens).toBe(16384)
    expect([sent(1), sent(2)].map(body => body.max_tokens)).toEqual(MATRIX_MANAGED_OUTPUT_STEPS.slice(0, 2))
    // The smaller cap replaces the caller's; everything else goes as sent.
    expect(sent(1)).toEqual({
      model: 'nguyet-thuc',
      messages: [],
      max_tokens: MATRIX_MANAGED_OUTPUT_STEPS[0],
      stream: true,
      reasoning_effort: MATRIX_DEFAULT_EFFORT
    })
  })
  it('gives Hermes the original refusal when no smaller answer fits, and never steps down for anything else', async () => {
    const upstream = vi.fn(async () => new Response('{"error":"atum_insufficient_protons"}', { status: 402 }))
    vi.stubGlobal('fetch', upstream)
    const { port } = await proxy()

    const paid = await call(port)
    expect(paid.status).toBe(402)
    expect(paid.body).toContain('atum_insufficient_protons')
    expect(upstream).toHaveBeenCalledTimes(1 + MATRIX_MANAGED_OUTPUT_STEPS.length)

    // A 402 that is not about this person's balance is final.
    upstream.mockReset()
    upstream.mockImplementation(async () => new Response('{"error":"provider_out_of_credit"}', { status: 402 }))
    expect((await call(port)).status).toBe(402)
    expect(upstream).toHaveBeenCalledTimes(1)
  })
  it("never steps a check-in down: the owner's last Protons stay theirs", async () => {
    const upstream = vi.fn(async () => new Response('{"error":{"message":"insufficient_protons"}}', { status: 402 }))
    vi.stubGlobal('fetch', upstream)
    const { port } = await proxy({ checkInCall: () => true })

    const refused = await call(port, { body: JSON.stringify({ model: 'atum-check-in', messages: [], max_tokens: 8192 * 2 }) })
    expect(refused.status).toBe(402)
    expect(upstream).toHaveBeenCalledTimes(1)
  })
  it("keeps a latched agent's smaller request on the protected alias", async () => {
    const upstream = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"insufficient_protons"}}', { status: 402 }))
      .mockResolvedValueOnce(Response.json({ id: 'ok' }))

    vi.stubGlobal('fetch', upstream)
    const { port } = await proxy({ route: () => 'protected' })

    expect((await call(port, { body: JSON.stringify({ model: 'nguyet-thuc', messages: [] }) })).status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(2)
    const retried = JSON.parse(Buffer.from(upstream.mock.calls[1]![1].body as Uint8Array).toString())
    expect(retried).toMatchObject({ model: 'google-protected', max_tokens: MATRIX_MANAGED_OUTPUT_STEPS[0] })
  })
  it('asks for sign-in instead of calling the gateway when there is no domain grant', async () => {
    const upstream = vi.fn()
    vi.stubGlobal('fetch', upstream)
    const { port } = await proxy({ bearer: async () => null })
    const result = await call(port)
    expect(result.status).toBe(401)
    expect(result.body).toContain('atum_sign_in_required')
    expect(upstream).not.toHaveBeenCalled()
  })
  it('cancels the gateway call when Hermes cancels its request', async () => {
    let upstreamSignal: AbortSignal | undefined

    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            upstreamSignal = init.signal!
            init.signal!.addEventListener('abort', () => reject(new Error('aborted')))
          })
      )
    )
    const { port } = await proxy()

    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { Authorization: `Bearer ${KEY}` }
    })

    req.on('error', () => {})
    req.end('{}')
    await vi.waitFor(() => expect(upstreamSignal).toBeDefined())
    req.destroy()
    await vi.waitFor(() => expect(upstreamSignal!.aborted).toBe(true))
  })
})

describe('output caps after a refused hold', () => {
  it('tries only caps below what the request already asked for, and none for an unreadable body', () => {
    const steps = (value: unknown) => matrixManagedOutputSteps(Buffer.from(JSON.stringify(value)))
    expect(steps({ messages: [] })).toEqual([...MATRIX_MANAGED_OUTPUT_STEPS])
    expect(steps({ max_tokens: 4096 })).toEqual(MATRIX_MANAGED_OUTPUT_STEPS.filter(cap => cap < 4096))
    expect(steps({ max_completion_tokens: 2048, max_tokens: 9000 })).toEqual(
      MATRIX_MANAGED_OUTPUT_STEPS.filter(cap => cap < 2048)
    )
    expect(steps({ max_tokens: Math.min(...MATRIX_MANAGED_OUTPUT_STEPS) })).toEqual([])
    expect(matrixManagedOutputSteps(Buffer.from('not json'))).toEqual([])
    expect(steps(['a'])).toEqual([])
  })
})

describe('the readiness probe', () => {
  it('needs a 200 for GET /v1/models through the proxy, with the domain bearer upstream', async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => new Response('{"data":[]}', { status: 200 }))
    vi.stubGlobal('fetch', upstream)
    const { model, bearer } = await proxy()

    expect(await model.probe('agent')).toEqual({ ok: true })
    expect(upstream.mock.calls[0]?.[0]).toBe('https://gateway.test/v1/models')
    expect((upstream.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBe('Bearer domain-token')
    expect(bearer).toHaveBeenCalled()
  })

  it.each([
    [402, 'out_of_protons'],
    [503, 'ai_unavailable'],
    [500, 'ai_unavailable'],
    [404, 'ai_unavailable']
  ] as const)('maps an upstream %i to %s', async (status, code) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status }))
    )
    const { model } = await proxy()
    expect(await model.probe('agent')).toEqual({ ok: false, code })
  })

  it('reports a gateway it cannot reach as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      })
    )
    const { model } = await proxy()
    expect(await model.probe('agent')).toEqual({ ok: false, code: 'ai_unavailable' })
  })

  it('asks for sign-in when there is no domain token, and for setup without a local key', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const signedOut = await proxy({ bearer: async () => null })
    expect(await signedOut.model.probe('agent')).toEqual({ ok: false, code: 'sign_in_required' })

    const unconfigured = await proxy({ key: null })
    expect(await unconfigured.model.probe('agent')).toEqual({ ok: false, code: 'setup_required' })
  })

  // Several agents, one port ( §2.5).
  it("sends each agent's completion to that agent's running turn's model, at the same time", async () => {
    const OTHER = 'b'.repeat(64)
    const release: Array<() => void> = []

    const upstream = vi.fn(
      (_url: string, _init: RequestInit) =>
        new Promise<Response>(resolve => release.push(() => resolve(Response.json({ id: 'ok' }))))
    )

    vi.stubGlobal('fetch', upstream)

    const model = new MatrixManagedModel({
      gateway: 'https://gateway.test',
      port: 0,
      keys: () => [
        [KEY, 'agent'],
        [OTHER, 'agent:alfred']
      ],
      bearer: async () => 'domain-token',
      model: agent => (agent === 'agent:alfred' ? 'nhat-thuc' : 'nguyet-thuc')
    })

    await model.start()
    proxies.push(model)
    const port = Number(new URL(model.baseUrl).port)
    const body = JSON.stringify({ model: 'binh-minh', messages: [] })

    // Both requests are in flight before either is answered.
    const first = call(port, { body })
    const second = call(port, { body, headers: { Authorization: `Bearer ${OTHER}` } })
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(2))
    const sent = upstream.mock.calls.map(call => JSON.parse(Buffer.from(call[1].body as Uint8Array).toString()).model)
    expect(sent.sort()).toEqual(['nguyet-thuc', 'nhat-thuc'])
    release.forEach(answer => answer())
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)

    // A key no agent holds is refused, and each agent's probe uses its own key.
    expect((await call(port, { headers: { Authorization: `Bearer ${'c'.repeat(64)}` } })).status).toBe(401)
    upstream.mockImplementation(async () => Response.json({ data: [] }))
    expect(await model.probe('agent:alfred')).toEqual({ ok: true })
    expect((upstream.mock.lastCall![1].headers as Record<string, string>).Authorization).toBe('Bearer domain-token')
    expect(await model.probe('agent:bea')).toEqual({ ok: false, code: 'setup_required' })
  })
})

describe('the Google fence on model calls (G2-19)', () => {
  const sentModel = (upstream: ReturnType<typeof vi.fn>) =>
    JSON.parse(Buffer.from(upstream.mock.lastCall![1].body as Uint8Array).toString()).model

  it('sends every call of a latched agent to the protected alias, whatever model it names', async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: 'ok' }))
    vi.stubGlobal('fetch', upstream)
    const { port } = await proxy({ route: () => 'protected', model: () => 'nhat-thuc' })

    for (const named of ['binh-minh', 'nhat-thuc', 'some-other-provider/model']) {
      const answer = await call(port, { body: JSON.stringify({ model: named, messages: [], tools: [] }) })
      expect(answer.status).toBe(200)
      expect(sentModel(upstream)).toBe('google-protected')
    }

    // Everything else in the request goes through as sent.
    expect(JSON.parse(Buffer.from(upstream.mock.lastCall![1].body as Uint8Array).toString())).toMatchObject({ messages: [], tools: [] })
  })

  it('refuses a latched agent on the Mac when the protected route is not served, without calling the gateway', async () => {
    const upstream = vi.fn(async () => Response.json({ id: 'should-not-happen' }))
    vi.stubGlobal('fetch', upstream)
    const { port, bearer } = await proxy({ route: () => 'refused' })

    const answer = await call(port)
    expect(answer.status).toBe(503)
    expect(answer.body).toContain('atum_google_route_unavailable')
    expect(upstream).not.toHaveBeenCalled()
    expect(bearer).not.toHaveBeenCalled()
  })

  it('never forwards an unreadable body from a latched agent under any model', async () => {
    const upstream = vi.fn(async () => Response.json({ id: 'should-not-happen' }))
    vi.stubGlobal('fetch', upstream)
    const { port } = await proxy({ route: () => 'protected' })

    expect((await call(port, { body: 'not json' })).status).toBe(400)
    expect((await call(port, { body: '[1,2]' })).status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('fails closed when the fence policy itself throws', async () => {
    const upstream = vi.fn(async () => Response.json({ id: 'should-not-happen' }))
    vi.stubGlobal('fetch', upstream)

    const { port } = await proxy({
      route: () => {
        throw new Error('store unavailable')
      }
    })

    expect((await call(port)).status).toBe(503)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('leaves an unlatched agent on its conversation model', async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: 'ok' }))
    vi.stubGlobal('fetch', upstream)
    const { port } = await proxy({ route: () => 'open', model: () => 'nhat-thuc' })

    expect((await call(port)).status).toBe(200)
    expect(sentModel(upstream)).toBe('nhat-thuc')
  })

  it("sends a latched agent's check-in to the protected alias too, still at most one call per check", async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: 'ok' }))
    vi.stubGlobal('fetch', upstream)
    const calls = [true]
    const checkInCall = vi.fn(() => calls.shift() ?? false)
    let fence: 'protected' | 'refused' = 'protected'
    const { port } = await proxy({ route: () => fence, checkInCall })
    const checkIn = JSON.stringify({ model: 'atum-check-in', messages: [], max_tokens: 1000 })

    // The check's one call goes to the protected alias, never to the everyday model.
    expect((await call(port, { body: checkIn })).status).toBe(200)
    expect(sentModel(upstream)).toBe('google-protected')

    // Another call for the same check is answered here, as ever.
    expect(JSON.parse((await call(port, { body: checkIn })).body).choices[0].message.content).toBe('[SILENT]')
    expect(upstream).toHaveBeenCalledTimes(1)

    // With the route not served, a newly claimed check is refused on the Mac.
    calls.push(true)
    fence = 'refused'
    expect((await call(port, { body: checkIn })).status).toBe(503)
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it("reads whether the gateway serves an alias from the person's own model list", async () => {
    const upstream = vi.fn(async () => Response.json({ data: [{ id: 'nguyet-thuc' }, { id: 'google-protected' }] }))
    vi.stubGlobal('fetch', upstream)
    const { model } = await proxy()

    expect(await model.servesModel('google-protected')).toBe(true)
    expect(String((upstream.mock.lastCall as unknown as [string])[0])).toBe('https://gateway.test/v1/models')
    expect(await model.servesModel('not-served')).toBe(false)

    upstream.mockImplementation(async () => new Response('down', { status: 502 }))
    expect(await model.servesModel('google-protected')).toBeNull()

    upstream.mockImplementation(async () => {
      throw new TypeError('offline')
    })
    expect(await model.servesModel('google-protected')).toBeNull()
  })

  it('asks again with a fresh token once when the gateway refuses the first, and gives up signed out', async () => {
    const upstream = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'google-protected' }] }))

    vi.stubGlobal('fetch', upstream)
    const { model, bearer } = await proxy()

    expect(await model.servesModel('google-protected')).toBe(true)
    expect(bearer.mock.calls.map(call => call[0])).toEqual([false, true])

    const signedOut = await proxy({ bearer: async () => null })
    expect(await signedOut.model.servesModel('google-protected')).toBeNull()
  })
})

describe('the request body ceiling', () => {
  it('forwards a prompt larger than the old 4 MiB cap and refuses one over 16 MiB before the gateway', async () => {
    const upstream = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: 'ok' }))
    vi.stubGlobal('fetch', upstream)
    const { port } = await proxy({ model: () => 'nguyet-thuc' })
    const message = (bytes: number) =>
      JSON.stringify({ model: 'nguyet-thuc', messages: [{ role: 'user', content: 'x'.repeat(bytes) }] })

    expect((await call(port, { body: message(6 * 1024 * 1024) })).status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(1)

    const tooLarge = await call(port, { body: message(17 * 1024 * 1024) })
    expect(tooLarge.status).toBe(413)
    expect(tooLarge.body).toContain('atum_request_too_large')
    expect(upstream).toHaveBeenCalledTimes(1)
  })
})
