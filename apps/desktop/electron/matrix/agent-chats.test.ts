import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  type MatrixAgentChatsBinding,
  requestBoundMatrixAgentChats
} from './agent-chats'
import { runMatrixHermesTurn } from './hermes-turn'

const AGENT = '00000000-0000-4000-8000-23bac9ff0a80'
const EXECUTOR = '00000000-0000-4000-8000-d333c7ed1353'
const TOKEN = 'synthetic-owner-token'

const CONTRACT_FIXTURES = new URL(
  '../../../../packages/device-protocol/fixtures/agent-chats/fixtures/',
  import.meta.url
)

type GatewayEvent = Parameters<Parameters<Parameters<typeof runMatrixHermesTurn>[0]['onAny']>[0]>[0]

const servers = new Set<Server>()

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      server =>
        new Promise<void>(resolve => {
          server.closeAllConnections?.()
          server.close(() => resolve())
        })
    )
  )
  servers.clear()
})

function fixtureText(name: string): string {
  return readFileSync(new URL(name, CONTRACT_FIXTURES), 'utf8')
}

function fixtureJson(name: string): Record<string, unknown> {
  return JSON.parse(fixtureText(name)) as Record<string, unknown>
}

interface RouteCall {
  path: string
  authorization: string | undefined
  agent: string | undefined
  body: string
}

async function chatRoute(input: { status: number; response: string; hold?: Promise<void> }) {
  const calls: RouteCall[] = []
  let observed!: () => void

  const seen = new Promise<void>(resolve => {
    observed = resolve
  })

  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []

    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }

    calls.push({
      path: request.url ?? '',
      authorization: request.headers.authorization,
      agent: request.headers['atum-agent'] as string | undefined,
      body: Buffer.concat(chunks).toString('utf8')
    })
    observed()
    await input.hold
    response.statusCode = input.status
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.end(input.response)
  })

  servers.add(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo

  return {
    resource: `http://127.0.0.1:${address.port}/api/matrix/v1`,
    calls,
    seen
  }
}

function turnFixture() {
  const events = new Set<(event: GatewayEvent) => void>()
  const states = new Set<(state: string) => void>()

  const request = vi.fn(
    async (
      method: string,
      _params?: Record<string, unknown>,
      _timeout?: number,
      _signal?: AbortSignal
    ): Promise<unknown> =>
      method === 'session.create'
        ? { session_id: 'live-session', stored_session_id: 'stored-session', async_delivery: false }
        : method === 'config.get'
          ? { value: 'all' }
          : { status: 'streaming' }
  )

  const gateway = {
    request: request as Parameters<typeof runMatrixHermesTurn>[0]['request'],
    onAny(handler: (event: GatewayEvent) => void) {
      events.add(handler)

      return () => events.delete(handler)
    },
    onState(handler: (state: string) => void) {
      states.add(handler)
      handler('open')

      return () => states.delete(handler)
    }
  }

  const emit = (type: string, payload: unknown = {}, session_id = 'live-session') => {
    for (const handler of events) {
      handler({ type, payload, session_id })
    }
  }

  return { gateway, request, emit }
}

function finish(turn: ReturnType<typeof turnFixture>) {
  turn.emit('message.complete', { text: 'done', status: 'complete' })
  turn.emit('session.info', { running: false, stored_session_id: 'stored-session' })
}

function binding(generation = 7): MatrixAgentChatsBinding {
  return { accountKey: 'synthetic-account', generation, agentPrincipal: AGENT, executorId: EXECUTOR }
}

function account(resource: string) {
  return {
    async s1Request<T>(send: (accessToken: string, route: string) => Promise<T>, signal: AbortSignal): Promise<T> {
      signal.throwIfAborted()

      return send(TOKEN, resource)
    }
  }
}

async function startTurn(input: {
  resource: string
  current(): MatrixAgentChatsBinding | null
  request: Record<string, unknown>
  signal?: AbortSignal
}) {
  const turn = turnFixture()
  const expected = binding()
  const owner = account(input.resource)

  const pending = runMatrixHermesTurn(turn.gateway, {
    invocationId: 'synthetic-invocation',
    text: 'Use the read-only chat view.',
    workspace: '/synthetic',
    ...(input.signal ? { signal: input.signal } : {}),
    onChats: (payload, signal) =>
      requestBoundMatrixAgentChats({
        account: owner,
        binding: expected,
        current: input.current,
        payload,
        signal
      })
  })

  await vi.waitFor(() => expect(turn.request.mock.calls.some(call => call[0] === 'prompt.submit')).toBe(true))
  turn.emit('message.start', { turn_id: 'live-turn' })
  turn.emit('atum.chats.request', {
    request_id: 'chat-request',
    turn_id: 'live-turn',
    ...input.request,
    owner: 'forged-owner',
    agentPrincipal: 'forged-agent',
    accessToken: 'forged-token',
    url: 'https://forged.invalid'
  })

  return { turn, pending, owner }
}

describe('Mac atum.chats host bridge', () => {
  it.each([
    {
      name: 'list with absolute sinceMs plus opaque before/next',
      request: 'list.request.full.json',
      response: 'list.response.next.json',
      status: 200
    },
    {
      name: 'list with null highlights and encrypted metadata',
      request: 'list.request.minimal.json',
      response: 'list.response.json',
      status: 200
    },
    { name: 'read with eventId, edit, redaction and next', request: 'read.request.json', response: 'read.response.json', status: 200 },
    { name: 'search', request: 'search.request.json', response: 'search.response.json', status: 200 },
    { name: 'rate limited', request: 'list.request.minimal.json', response: 'error.rate-limited.json', status: 429 },
    { name: 'unavailable', request: 'list.request.minimal.json', response: 'error.unavailable.json', status: 503 }
  ])('carries exact $name response bytes from the live event through the owner route', async testCase => {
    const request = fixtureJson(testCase.request)
    const response = fixtureText(testCase.response)
    const route = await chatRoute({ status: testCase.status, response })
    const current = binding()
    const run = await startTurn({ resource: route.resource, current: () => current, request })

    await vi.waitFor(() =>
      expect(run.turn.request.mock.calls.some(call => call[0] === 'atum.chats.respond')).toBe(true)
    )

    const reply = run.turn.request.mock.calls.find(call => call[0] === 'atum.chats.respond')![1] as {
      result: string
    }

    expect(Buffer.from(reply.result)).toEqual(Buffer.from(response))
    expect(route.calls).toHaveLength(1)
    expect(route.calls[0]).toMatchObject({
      path: '/api/matrix/v1/chats',
      authorization: `Bearer ${TOKEN}`,
      agent: AGENT
    })
    expect(JSON.parse(route.calls[0]!.body)).toEqual(request)
    expect(route.calls[0]!.body).not.toContain('forged-owner')
    expect(route.calls[0]!.body).not.toContain('forged-agent')
    expect(route.calls[0]!.body).not.toContain('forged-token')
    expect(route.calls[0]!.body).not.toContain('forged.invalid')

    if (testCase.request === 'list.request.full.json') {
      expect(JSON.parse(route.calls[0]!.body)).toMatchObject({
        sinceMs: 1_791_913_600_000,
        before: 'l1.WzE3OTIwMDAwMDAwMDAsIiFRazN2TG0wd1h6UmJUOmF0dW1wbGF0Zm9ybS5jb20iXQ'
      })
      expect(JSON.parse(reply.result)).toMatchObject({
        truncated: true,
        next: 'l1.WzE3OTIwMDAwMDAwMDAsIiFRazN2TG0wd1h6UmJUOmF0dW1wbGF0Zm9ybS5jb20iXQ'
      })
    }

    if (testCase.response === 'list.response.json') {
      const list = JSON.parse(reply.result) as { rooms: Array<Record<string, unknown>> }
      expect(list.rooms[1]).toMatchObject({ notifications: 2, highlights: null, encrypted: true })
    }

    if (testCase.response === 'read.response.json') {
      expect(JSON.parse(reply.result)).toMatchObject({
        messages: [
          { eventId: '$m1abc', edited: true },
          { eventId: '$m2abc' },
          { eventId: '$m3abc', text: null, redacted: true }
        ],
        next: 't11-300_0_0_0_0_0_0_0_0_0'
      })
    }

    if (testCase.response === 'search.response.json') {
      expect(JSON.parse(reply.result)).toMatchObject({ hits: [{ eventId: '$s1abc' }] })
    }

    finish(run.turn)
    await run.pending
  })

  it('uses only the platform chats route for encrypted metadata and never opens a local decryption path', async () => {
    const request = { op: 'read', id: '!Zr81pQe2JhNcA:atumplatform.com', limit: 20 }
    const response = fixtureText('read.response.encrypted.json')
    const route = await chatRoute({ status: 200, response })
    const current = binding()
    const run = await startTurn({ resource: route.resource, current: () => current, request })

    await vi.waitFor(() =>
      expect(run.turn.request.mock.calls.some(call => call[0] === 'atum.chats.respond')).toBe(true)
    )

    const reply = run.turn.request.mock.calls.find(call => call[0] === 'atum.chats.respond')![1] as {
      result: string
    }

    expect(reply.result).toBe(response)
    expect(JSON.parse(reply.result)).toMatchObject({
      messages: [{ eventId: '$e1abc', kind: 'encrypted', text: null }]
    })
    expect(route.calls.map(call => call.path)).toEqual(['/api/matrix/v1/chats'])

    finish(run.turn)
    await run.pending
  })

  it.each([
    { name: 'signed-in account generation', next: binding(8) },
    {
      name: 'enrolled agent/executor binding',
      next: {
        ...binding(),
        agentPrincipal: '00000000-0000-4000-8000-44d2263c2f1c',
        executorId: '00000000-0000-4000-8000-2cde49a134cd'
      }
    }
  ])('discards an HTTP success when the $name changes during the await', async ({ next }) => {
    let release!: () => void

    const hold = new Promise<void>(resolve => {
      release = resolve
    })

    const response = fixtureText('list.response.json')
    const route = await chatRoute({ status: 200, response, hold })
    let current = binding()

    const run = await startTurn({
      resource: route.resource,
      current: () => current,
      request: fixtureJson('list.request.minimal.json')
    })

    await route.seen
    current = next
    release()

    await vi.waitFor(() =>
      expect(run.turn.request.mock.calls.some(call => call[0] === 'atum.chats.respond')).toBe(true)
    )

    const reply = run.turn.request.mock.calls.find(call => call[0] === 'atum.chats.respond')![1] as {
      result: string
    }

    expect(reply.result).toBe('{"error":"unavailable"}')
    expect(reply.result).not.toContain('Linh')

    finish(run.turn)
    await run.pending
  })

  it('aborts the owner-route request with its original turn and sends no late response', async () => {
    let release!: () => void

    const hold = new Promise<void>(resolve => {
      release = resolve
    })

    const route = await chatRoute({ status: 200, response: fixtureText('list.response.json'), hold })
    const abort = new AbortController()
    const current = binding()

    const run = await startTurn({
      resource: route.resource,
      current: () => current,
      request: fixtureJson('list.request.minimal.json'),
      signal: abort.signal
    })

    await route.seen
    abort.abort()
    release()

    await expect(run.pending).rejects.toThrow('matrix_hermes_outcome_unknown')
    expect(run.turn.request.mock.calls.some(call => call[0] === 'atum.chats.respond')).toBe(false)
  })
})
