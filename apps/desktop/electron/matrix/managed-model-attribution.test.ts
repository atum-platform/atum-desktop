import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { MATRIX_MANAGED_OUTPUT_STEPS, matrixManagedAgentPrincipal, MatrixManagedModel } from './managed-model'

// Distinct values for every identity involved: a copy of one for another must fail a test.
const OWNER = '00000000-0000-4000-8000-0000000000a0'
const DEFAULT_AGENT = '00000000-0000-4000-8000-0000000000a1'
const OTHER_AGENT = '00000000-0000-4000-8000-0000000000a2'
const FOREIGN_AGENT = '00000000-0000-4000-8000-0000000000ff'
const DEFAULT_KEY = 'd'.repeat(64)
const OTHER_KEY = 'e'.repeat(64)
const HATCH_KEY = 'f'.repeat(64)

const CAP_BODY = JSON.stringify({
  error: {
    message: 'atum_daily_cap_exhausted',
    type: 'None',
    param: 'None',
    code: '403',
    details: { reason: 'daily_cap_exhausted' }
  }
})

interface Seen {
  method?: string
  url?: string
  headers: IncomingHttpHeaders
  body: string
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(close => close()))
})

/** A real HTTP gateway on loopback: what the proxy's fetch actually talks to. */
async function gateway(answer: (seen: Seen, count: number) => { status: number; body: string }) {
  const seen: Seen[] = []

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      const entry: Seen = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }

      seen.push(entry)
      const { status, body } = answer(entry, seen.length)
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(body)
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  return { seen, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

type Options = Partial<ConstructorParameters<typeof MatrixManagedModel>[0]>

async function bridge(origin: string, options: Options = {}) {
  const model = new MatrixManagedModel({
    gateway: origin,
    port: 0,
    keys: () => [
      [DEFAULT_KEY, 'agent'],
      [OTHER_KEY, `agent:${OTHER_AGENT}`],
      [HATCH_KEY, 'agent']
    ],
    bearer: async () => 'owner-domain-bearer',
    model: () => 'nguyet-thuc',
    ...options
  })

  await model.start()
  cleanups.push(() => model.stop())

  return Number(new URL(model.baseUrl).port)
}

function call(
  port: number,
  input: { key?: string; method?: string; path?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const method = input.method ?? 'POST'

    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path: input.path ?? '/v1/chat/completions',
        headers: { Authorization: `Bearer ${input.key ?? DEFAULT_KEY}`, 'Content-Type': 'application/json', ...input.headers }
      },
      res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      }
    )

    req.on('error', reject)
    req.end(method === 'GET' ? undefined : (input.body ?? JSON.stringify({ model: 'nguyet-thuc', messages: [] })))
  })
}

/** The wiring main.ts builds: which runtime a role names and what its enrollment verified. */
const wiring = {
  runtime: (role: string) =>
    role === 'agent'
      ? { agentPrincipal: undefined as string | undefined }
      : role === `agent:${OTHER_AGENT}`
        ? { agentPrincipal: OTHER_AGENT }
        : undefined,
  enrolled: (runtime: { agentPrincipal?: string }) => (runtime.agentPrincipal === OTHER_AGENT ? OTHER_AGENT : DEFAULT_AGENT)
}

describe('managed model agent attribution (X-Atum-Agent)', () => {
  it('sends the default and per-agent keys’ enrollment-verified agent, never the owner', async () => {
    const { seen, origin } = await gateway(() => ({ status: 200, body: '{"id":"ok"}' }))

    const port = await bridge(origin, {
      agentPrincipal: role => matrixManagedAgentPrincipal(role, wiring)
    })

    expect((await call(port, { key: DEFAULT_KEY })).status).toBe(200)
    expect((await call(port, { key: OTHER_KEY })).status).toBe(200)
    expect(seen.map(entry => entry.headers['x-atum-agent'])).toEqual([DEFAULT_AGENT, OTHER_AGENT])
    // The owner's bearer still authenticates; the claim is only the agent.
    expect(seen.every(entry => entry.headers.authorization === 'Bearer owner-domain-bearer')).toBe(true)
    expect(JSON.stringify(seen.map(entry => entry.headers))).not.toContain(OWNER)
  })

  it('ignores an X-Atum-Agent (or owner) claim Hermes makes, with and without a verified identity', async () => {
    const { seen, origin } = await gateway(() => ({ status: 200, body: '{"id":"ok"}' }))
    const spoof = { 'X-Atum-Agent': FOREIGN_AGENT, 'X-Atum-Owner': OWNER, 'X-Atum-Principal': OWNER }
    const verified = await bridge(origin, { agentPrincipal: () => DEFAULT_AGENT })

    await call(verified, { headers: spoof })
    expect(seen[0]!.headers['x-atum-agent']).toBe(DEFAULT_AGENT)
    expect(seen[0]!.headers['x-atum-owner']).toBeUndefined()
    expect(seen[0]!.headers['x-atum-principal']).toBeUndefined()

    const unverified = await bridge(origin, { agentPrincipal: () => undefined })

    await call(unverified, { headers: spoof })
    expect(seen[1]!.headers['x-atum-agent']).toBeUndefined()

    // Nor from the body.
    await call(verified, {
      body: JSON.stringify({ model: 'nguyet-thuc', messages: [], agent: FOREIGN_AGENT, owner: OWNER })
    })
    expect(seen[2]!.headers['x-atum-agent']).toBe(DEFAULT_AGENT)
  })

  it('sends no claim without a verified UUID identity, so an older client path is unchanged', async () => {
    const { seen, origin } = await gateway(() => ({ status: 200, body: '{"id":"ok"}' }))
    const absent = await bridge(origin)

    for (const value of [undefined, '', 'not-a-uuid', `${DEFAULT_AGENT}, ${FOREIGN_AGENT}`, `${DEFAULT_AGENT}\r\nx: y`]) {
      const port = await bridge(origin, { agentPrincipal: () => value })

      expect((await call(port)).status).toBe(200)
    }

    const throwing = await bridge(origin, {
      agentPrincipal: () => {
        throw new Error('main state unreadable')
      }
    })

    expect((await call(absent)).status).toBe(200)
    expect((await call(throwing)).status).toBe(200)
    expect(seen).toHaveLength(7)
    expect(seen.every(entry => entry.headers['x-atum-agent'] === undefined)).toBe(true)
  })

  it('attributes a check-in but never a pet hatch or the model list', async () => {
    const { seen, origin } = await gateway(() => ({ status: 200, body: '{"id":"ok"}' }))
    const principal: string[] = []

    const port = await bridge(origin, {
      agentPrincipal: role => {
        principal.push(role)

        return DEFAULT_AGENT
      },
      checkInCall: () => true,
      hatchKey: (_role, key) => key === HATCH_KEY,
      hatch: () => true
    })

    await call(port, { body: JSON.stringify({ model: 'atum-check-in', messages: [] }) })
    expect(seen[0]!.headers['x-atum-agent']).toBe(DEFAULT_AGENT)

    await call(port, { key: HATCH_KEY, headers: { 'X-Atum-Pet-Operation': 'op-1', 'X-Atum-Agent': FOREIGN_AGENT } })
    expect(seen[1]!.headers['x-atum-pet-operation']).toBe('op-1')
    expect(seen[1]!.headers['x-atum-agent']).toBeUndefined()

    await call(port, { method: 'GET', path: '/v1/models' })
    expect(seen[2]!.headers['x-atum-agent']).toBeUndefined()
    // The hatch is a subsidy: its role was never even looked up.
    expect(principal).toEqual(['agent'])
  })

  it('passes a 403 daily-cap refusal through byte for byte and never retries it', async () => {
    const { seen, origin } = await gateway(() => ({ status: 403, body: CAP_BODY }))
    const port = await bridge(origin, { agentPrincipal: () => DEFAULT_AGENT })

    const answer = await call(port)

    expect(answer).toEqual({ status: 403, body: CAP_BODY })
    expect(seen).toHaveLength(1)
  })

  it('still steps a 402 balance refusal down, claiming the same agent on every attempt', async () => {
    const refusal = '{"error":{"message":"insufficient_protons","code":"402"}}'

    const { seen, origin } = await gateway((_seen, count) =>
      count < 3 ? { status: 402, body: refusal } : { status: 200, body: '{"id":"ok"}' }
    )

    const port = await bridge(origin, { agentPrincipal: () => DEFAULT_AGENT })

    const answer = await call(port, {
      body: JSON.stringify({ model: 'nguyet-thuc', messages: [], max_completion_tokens: 16384 })
    })

    expect(answer.status).toBe(200)
    expect(seen).toHaveLength(3)
    expect(seen.map(entry => entry.headers['x-atum-agent'])).toEqual([DEFAULT_AGENT, DEFAULT_AGENT, DEFAULT_AGENT])
    expect(seen.slice(1).map(entry => JSON.parse(entry.body).max_tokens)).toEqual(
      MATRIX_MANAGED_OUTPUT_STEPS.slice(0, 2)
    )
  })

  it('does not treat a gateway that rejects the claim as an attribution downgrade', async () => {
    const denied = '{"error":{"message":"atum_agent_denied","code":"403"}}'
    const { seen, origin } = await gateway(() => ({ status: 403, body: denied }))
    const port = await bridge(origin, { agentPrincipal: () => DEFAULT_AGENT })

    expect(await call(port)).toEqual({ status: 403, body: denied })
    expect(await call(port)).toEqual({ status: 403, body: denied })
    // One request each, both claiming the agent: no silent retry without it.
    expect(seen.map(entry => entry.headers['x-atum-agent'])).toEqual([DEFAULT_AGENT, DEFAULT_AGENT])
  })
})

describe('matrixManagedAgentPrincipal', () => {
  const runtimes = new Map([
    ['agent', { agentPrincipal: undefined as string | undefined, principal: undefined as string | undefined }],
    [`agent:${OTHER_AGENT}`, { agentPrincipal: OTHER_AGENT, principal: OTHER_AGENT }]
  ])

  const source = (enrolled: (runtime: { agentPrincipal?: string }) => string | undefined) => ({
    runtime: (role: string) => runtimes.get(role),
    enrolled
  })

  it('prefers the enrollment identity over the runtime’s own principal', () => {
    expect(matrixManagedAgentPrincipal('agent', source(() => DEFAULT_AGENT))).toBe(DEFAULT_AGENT)
    expect(matrixManagedAgentPrincipal(`agent:${OTHER_AGENT}`, source(() => FOREIGN_AGENT))).toBe(FOREIGN_AGENT)
  })

  it('falls back to the runtime’s agent principal, and to nothing — never the owner', () => {
    expect(matrixManagedAgentPrincipal(`agent:${OTHER_AGENT}`, source(() => undefined))).toBe(OTHER_AGENT)
    expect(matrixManagedAgentPrincipal('agent', source(() => undefined))).toBeUndefined()
    expect(
      matrixManagedAgentPrincipal(
        `agent:${OTHER_AGENT}`,
        source(() => {
          throw new Error('enrollment unreadable')
        })
      )
    ).toBe(OTHER_AGENT)
  })

  it('has no agent for the human, an app or an unknown role', () => {
    for (const role of ['human', 'app:demoza', `agent:${FOREIGN_AGENT}`, '']) {
      expect(matrixManagedAgentPrincipal(role, source(() => OWNER))).toBeUndefined()
    }
  })
})
