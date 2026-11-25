import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { memorySecretStore, T3Sessions } from './sessions'
import { createT3Client } from './t3-client'

// The headless OAuth sequence (S0-1, S0-4) against a stand-in T3, and the T3 client's one hard property: a launch
// is STARTED in the same synchronous step that committed the forwarded mark.

const sessionId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const bearer = (n: number) => `${Buffer.from(JSON.stringify({ kind: 'session', sid: sessionId(n) })).toString('base64url')}.signature`

function fakeT3() {
  const log: { url: string; body: unknown }[] = []
  const codes = new Set<string>()
  const challenges = new Map<string, string>()
  const sessions: string[] = ['existing']
  let n = 0

  const fetcher = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    const body = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init?.body ? JSON.parse(String(init.body)) : undefined

    log.push({ url: path, body })

    if (path === '/oauth/mcp/register') {
      return Response.json({ client_id: `client-${++n}` })
    }

    if (path === '/oauth/mcp/decision') {
      const { authorization, decision } = body as { authorization: { code_challenge: string; client_id: string; redirect_uri: string; state: string }; decision: { code: string; access: string } }

      if (!codes.has(decision.code)) {
        return Response.json({ error: 'bad code' }, { status: 400 })
      }

      codes.delete(decision.code)
      const sequence = authorization.client_id.slice(7)
      challenges.set(`auth-${sequence}`, authorization.code_challenge)

      return Response.json({ redirectTo: `${authorization.redirect_uri}?code=auth-${sequence}&state=${authorization.state}` })
    }

    if (path === '/oauth/mcp/token') {
      const grant = body as { code: string; code_verifier: string }

      if (createHash('sha256').update(grant.code_verifier).digest('base64url') !== challenges.get(grant.code)) {
        return Response.json({ error: 'pkce' }, { status: 400 })
      }

      const sequence = Number(grant.code.slice(5))
      sessions.push(sessionId(sequence), `unrelated-${sequence}`)

      return Response.json({ access_token: bearer(sequence), expires_in: 2_592_000 })
    }

    return Response.json({}, { status: 404 })
  }) as typeof fetch

  return { fetcher, log, codes, sessions }
}

function sessionsFor(t3: ReturnType<typeof fakeT3>, unfinished = () => false) {
  const revoked: string[] = []
  const store = memorySecretStore()

  const instance = new T3Sessions({
    origin: () => 'http://127.0.0.1:4321',
    pairing: { create: async () => { const code = `code-${t3.codes.size + 1}-${Math.random()}`; t3.codes.add(code);

 return code } },
    auth: { sessionIds: async () => [...t3.sessions], revokeSession: async id => void revoked.push(id) },
    store,
    agentName: principal => `Agent ${principal.slice(-4)}`,
    unfinished,
    fetch: t3.fetcher,
    knownAgents: () => ['p1', 'p2']
  })

  return { instance, revoked, store }
}

describe('T3 sessions: register, approve with a pairing code, authorization code + PKCE', () => {
  it('registers an agent as a peer link and the owner as an ordinary client', async () => {
    const t3 = fakeT3()
    const { instance } = sessionsFor(t3)

    const agent = await instance.agent('p1')
    const owner = await instance.owner()

    expect(agent).toEqual({ token: bearer(1), sessionId: sessionId(1) })
    expect(owner.sessionId).toBe(sessionId(2))

    const registers = t3.log.filter(item => item.url === '/oauth/mcp/register').map(item => item.body as Record<string, unknown>)

    expect(registers[0]).toMatchObject({ software_id: 't3code-peer-link', client_name: 'Agent p1'.replace('p1', 'p1') })
    expect(registers[1].software_id).toBeUndefined()
    expect(registers[1].token_endpoint_auth_method).toBe('none')
    const decisions = t3.log.filter(item => item.url === '/oauth/mcp/decision').map(item => (item.body as { decision: { access: string; _tag: string } }).decision)

    expect(decisions.map(item => item._tag)).toEqual(['pairing-code', 'pairing-code'])
    expect(decisions.every(item => item.access === 'auto-accept-edits')).toBe(true)
  })

  it('caches: asking again issues nothing; the id is known without issuing', async () => {
    const t3 = fakeT3()
    const { instance } = sessionsFor(t3)

    expect(instance.agentSessionId('p1')).toBeUndefined()
    await instance.agent('p1')
    await instance.agent('p1')

    expect(t3.log.filter(item => item.url === '/oauth/mcp/register')).toHaveLength(1)
    expect(instance.agentSessionId('p1')).toBe(sessionId(1))
  })

  it('two callers at once share one sign-in', async () => {
    const t3 = fakeT3()
    const { instance } = sessionsFor(t3)

    const [a, b] = await Promise.all([instance.agent('p1'), instance.agent('p1')])

    expect(a).toEqual(b)
    expect(t3.log.filter(item => item.url === '/oauth/mcp/register')).toHaveLength(1)
  })

  it('a new session is not issued while the agent has an unfinished thread', async () => {
    const t3 = fakeT3()
    const { instance } = sessionsFor(t3, () => true)

    await expect(instance.agent('p1')).rejects.toThrow('session_replacement_blocked')
    expect(t3.log).toHaveLength(0)
  })

  it('identifies each session when two principals mint alongside unrelated native sessions', async () => {
    const t3 = fakeT3()
    const { instance } = sessionsFor(t3)
    const [agent, owner] = await Promise.all([instance.agent('p1'), instance.owner()])

    expect(agent.sessionId).toBe(sessionId(1))
    expect(owner.sessionId).toBe(sessionId(2))
    expect(t3.sessions).toContain('unrelated-2')
  })

  it('persists the session in the secret store and reloads it after a restart', async () => {
    const t3 = fakeT3()
    const first = sessionsFor(t3)

    await first.instance.agent('p1')

    const second = new T3Sessions({
      origin: () => 'http://127.0.0.1:4321',
      pairing: { create: async () => 'x' },
      auth: { sessionIds: async () => [], revokeSession: async () => undefined },
      store: first.store,
      agentName: () => 'a',
      unfinished: () => false,
      fetch: t3.fetcher,
      knownAgents: () => ['p1']
    })

    expect(second.agentSessionId('p1')).toBe(sessionId(1))
    expect(await second.agent('p1')).toEqual({ token: bearer(1), sessionId: sessionId(1) })
  })

  it('revokes one agent\'s session through T3 and forgets it; a reset forgets everything without calling T3', async () => {
    const t3 = fakeT3()
    const { instance, revoked, store } = sessionsFor(t3)

    await instance.agent('p1')
    await instance.agent('p2')
    await instance.owner()
    await instance.revokeAgent('p1')

    expect(revoked).toEqual([sessionId(1)])
    expect(instance.agentSessionId('p1')).toBeUndefined()

    instance.forgetAll()
    expect(instance.agentSessionId('p2')).toBeUndefined()
    expect(store.get('owner')).toBeUndefined()
    expect(revoked).toEqual([sessionId(1)])
  })

  it('fails closed when the sign-in does not complete or the new session cannot be identified', async () => {
    const t3 = fakeT3()

    const broken = new T3Sessions({
      origin: () => 'http://127.0.0.1:4321',
      pairing: { create: async () => 'not-a-code' },
      auth: { sessionIds: async () => [], revokeSession: async () => undefined },
      store: memorySecretStore(),
      agentName: () => 'a',
      unfinished: () => false,
      fetch: t3.fetcher,
      knownAgents: () => []
    })

    await expect(broken.agent('p1')).rejects.toThrow('t3_oauth_decision_failed')

    const noOrigin = new T3Sessions({ ...(broken as unknown as { options: ConstructorParameters<typeof T3Sessions>[0] }).options, origin: () => undefined })

    await expect(noOrigin.owner()).rejects.toThrow('t3_not_serving')
  })
})

describe('the T3 client', () => {
  const reply = (result: unknown, headers: Record<string, string> = {}) => Response.json({ jsonrpc: '2.0', id: 1, result }, { headers })

  it('starts a launch in the same synchronous step: fetch has been called when launch() returns', async () => {
    const seen: { headers: Record<string, string>; body: string }[] = []

    const client = createT3Client({
      origin: () => 'http://127.0.0.1:4321',
      incarnation: () => 'inc-1',
      settingsFile: '/nonexistent',
      delegated: { instanceId: 'atum-managed-delegated', model: 'm' },
      fetch: (async (_url: string, init?: RequestInit) => {
        seen.push({ headers: init?.headers as Record<string, string>, body: String(init?.body) })

        return String(init?.body).includes('"initialize"')
          ? reply({}, { 'mcp-session-id': 'sid-1' })
          : reply({ structuredContent: { threadId: 'mcp:launch:abc' }, content: [{ type: 'text', text: '{}' }] })
      }) as typeof fetch
    })

    const call = { projectId: 'p', workspaceStrategy: { type: 'root' as const }, modelSelection: { instanceId: 'i', model: 'm' }, message: 'x', title: 't', clientRequestId: 'AAAAAAAAAAAAAAAAAAAAA1' }

    // not prepared: nothing is sent
    expect(await client.launch('tok', call, 'approval-required/default')).toMatchObject({ transport: 'failed', error: 'session_not_prepared' })
    expect(seen).toHaveLength(0)

    expect(await client.prepare('tok')).toBe(true)
    seen.length = 0
    const pending = client.launch('tok', call, 'approval-required/default')

    expect(seen).toHaveLength(1)
    expect(seen[0].headers['T3-Mode-Limit']).toBe('approval-required/default')
    expect(seen[0].headers['mcp-session-id']).toBe('sid-1')
    expect(seen[0].headers.authorization).toBe('Bearer tok')
    expect(await pending).toMatchObject({ transport: 'ok', status: 200, data: { threadId: 'mcp:launch:abc' } })
  })

  it('reads a thread: found, absent, and a typed error; and a transport failure is not an absence', async () => {
    const answers: Response[] = []

    const client = createT3Client({
      origin: () => 'http://127.0.0.1:4321',
      incarnation: () => 'inc-1',
      settingsFile: '/nonexistent',
      delegated: { instanceId: 'i', model: 'm' },
      fetch: (async (_url: string, init?: RequestInit) => (String(init?.body).includes('"initialize"') ? reply({}, { 'mcp-session-id': 's' }) : (answers.shift() as Response))) as typeof fetch
    })

    answers.push(reply({ structuredContent: { thread: { status: 'idle', activeRunId: null }, recentRuns: [{ runId: 'r', ordinal: 1, status: 'completed' }] }, content: [] }))
    expect(await client.read('t', 'x')).toMatchObject({ kind: 'found', status: 'idle', runs: [{ runId: 'r', ordinal: 1 }] })

    answers.push(reply({ isError: true, structuredContent: { code: 'thread_not_found' }, content: [] }))
    expect(await client.read('t', 'x')).toEqual({ kind: 'absent' })

    answers.push(reply({ isError: true, structuredContent: { code: 'forbidden' }, content: [] }))
    expect(await client.read('t', 'x')).toEqual({ kind: 'error', code: 'forbidden' })

    const down = createT3Client({ origin: () => undefined, incarnation: () => undefined, settingsFile: '/x', delegated: { instanceId: 'i', model: 'm' } })

    expect(await down.read('t', 'x')).toEqual({ kind: 'transport' })
  })

  it('knows the provider is ready only when the delegated instance advertises its model', async () => {
    let models: string[] = ['default']
    let gatewayReady = false

    const client = createT3Client({
      origin: () => 'http://127.0.0.1:4321',
      incarnation: () => 'inc-1',
      settingsFile: '/nonexistent',
      delegated: { instanceId: 'atum-managed-delegated', model: 'atum-managed:nguyet-thuc' },
      delegatedGatewayReady: () => gatewayReady,
      fetch: (async (_url: string, init?: RequestInit) =>
        String(init?.body).includes('"initialize"')
          ? reply({}, { 'mcp-session-id': 's' })
          : reply({ structuredContent: { providers: [{ providerInstanceId: 'atum-managed-delegated', models: models.map(id => ({ id })) }] }, content: [] })) as typeof fetch
    })

    expect(await client.providerReady('t')).toBe(false)
    models = ['default', 'atum-managed:nguyet-thuc']
    expect(await client.providerReady('t')).toBe(false)
    gatewayReady = true
    expect(await client.providerReady('t')).toBe(true)
  })
})
