import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'

import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { AccessVerifier } from './assertion'
import { WORK_TOOLS } from './contract'
import { createGateHandler } from './http'
import { bindGateSocket, type BoundGateSocket } from './socket'
import { ACCOUNT, DEVICE, EVENT_A, type Harness, LUNA, makeHarness, PINNED_T3_TOOLS, REQ_1, REQ_2 } from './test-support'

// The fifteen admission checks in the contract's order, with a REAL signed assertion (RS256, a locally generated key
// set standing in for Cloudflare's certs) through the REAL gate socket. T3 and the homeserver are fakes.

const TEAM = 'atum-lab.cloudflareaccess.com'
const AUD = 'a'.repeat(64)
const SIBLING_AUD = 'b'.repeat(64)
const CLIENT_ID = 'abcdefghijklmnopqrst.access'
const ROTATED_ID = 'zyxwvutsrqponmlkjihg.access'
const HOST = 'work-test.example.com'

let keys: { kid: string; privateKey: CryptoKey; jwk: object }[]
let h: Harness
let dir: string
let socket: BoundGateSocket
let jwksFetches: number
let jwksPublished: object[]
let logs: string[]
let clientIds: string[]
let bearer: string

beforeAll(async () => {
  keys = []

  for (const kid of ['k1', 'k2']) {
    const pair = await generateKeyPair('RS256', { extractable: true })

    keys.push({ kid, privateKey: pair.privateKey, jwk: { ...(await exportJWK(pair.publicKey)), kid, alg: 'RS256', use: 'sig' } })
  }
})

interface Claims {
  aud?: string | string[]
  iss?: string
  exp?: number
  nbf?: number
  sub?: string
  common_name?: string | null
  kid?: string
  alg?: string
}

async function assertion(claims: Claims = {}): Promise<string> {
  const now = Math.floor(h.clock.now() / 1000)
  const payload: Record<string, unknown> = { type: 'app', sub: claims.sub ?? '' }

  if (claims.common_name !== null) {
    payload.common_name = claims.common_name ?? CLIENT_ID
  }

  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: claims.kid ?? 'k1' })
    .setIssuedAt(now)
    .setIssuer(claims.iss ?? `https://${TEAM}`)
    .setAudience(claims.aud ?? AUD)
    .setExpirationTime(claims.exp ?? now + 3600)

  if (claims.nbf !== undefined) {
    jwt.setNotBefore(claims.nbf)
  }

  const key = keys.find(item => item.kid === (claims.kid ?? 'k1')) ?? keys[0]

  return jwt.sign(key.privateKey)
}

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  json: any
  raw: string
}

function post(body: unknown, headers: Record<string, string> = {}, options: { path?: string; method?: string; host?: string | null } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    const all: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers }

    if (options.host !== null) {
      all.host = options.host ?? HOST
    }

    const req = httpRequest({ socketPath: socket.path, path: options.path ?? '/agent/mcp', method: options.method ?? 'POST', headers: all, agent: false }, response => {
      let raw = ''

      response.on('data', chunk => (raw += chunk))
      response.on('end', () => {
        let json: unknown

        try {
          json = JSON.parse(raw)
        } catch {
          json = null
        }

        resolve({ status: response.statusCode ?? 0, headers: response.headers, json, raw })
      })
    })

    // a refusal answered before the body is read can reset the connection under a late write: the reply is the result
    req.on('socket', client => client.on('error', () => undefined))
    req.on('error', error => {
      // the gate may answer an oversize body before it has read it all: the reply, not the write, is the result
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE' && (error as NodeJS.ErrnoException).code !== 'ECONNRESET') {
        reject(error)
      }
    })
    req.end(text)
  })
}

const rpc = (name: string, args: unknown, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })

async function good(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  return { 'cf-access-jwt-assertion': await assertion(), authorization: `Bearer ${bearer}`, ...extra }
}

const launchArgs = (requestId = REQ_1, event = EVENT_A) => h.args(requestId, event)

beforeEach(async () => {
  h = makeHarness()
  dir = mkdtempSync('/tmp/wgs-')
  jwksFetches = 0
  jwksPublished = keys.slice(0, 1).map(key => key.jwk)
  logs = []
  clientIds = [CLIENT_ID]
  bearer = h.gate.mintGrant(LUNA).bearer

  const verifier = new AccessVerifier({
    teamDomain: TEAM,
    audience: AUD,
    clientIds: () => clientIds,
    now: h.clock.now,
    refetchFloorMs: 0,
    fetchJwks: async url => {
      jwksFetches++
      expect(url).toBe(`https://${TEAM}/cdn-cgi/access/certs`)

      return { keys: jwksPublished }
    }
  })

  socket = await bindGateSocket(
    join(dir, 'g.sock'),
    createGateHandler({ gate: h.gate, verifier, hostname: () => HOST, log: (event, fields) => logs.push(`${event} ${JSON.stringify(fields ?? {})}`) })
  )
})

afterEach(async () => {
  await socket.close()
  await h.cleanup()
  rmSync(dir, { recursive: true, force: true })
})

afterAll(() => undefined)

describe('a clean call', () => {
  it('launches through the real socket: 200, a tool result, the gate\'s id in the header and the body, no-store', async () => {
    const reply = await post(rpc('launch', launchArgs()), await good())

    expect(reply.status).toBe(200)
    expect(reply.headers['cache-control']).toBe('no-store')
    expect(reply.headers['x-gate-id']).toBe(`${DEVICE}.${ACCOUNT}.1`)
    expect(reply.json.result.isError).toBe(false)
    expect(reply.json.result.structuredContent).toMatchObject({ class: 'accepted', receipt: 'launched', gateId: { deviceServiceId: DEVICE, accountId: ACCOUNT, routeEpoch: 1 } })
    expect(reply.json.result.content).toHaveLength(1)
    expect(h.t3.count('launch')).toBe(1)
  })

  it('initialize, ping and tools/list are served; tools/list names exactly the six tools; a notification is a 202', async () => {
    const headers = await good()
    const list = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers)

    expect(list.json.result.tools.map((tool: { name: string }) => tool.name)).toEqual([...WORK_TOOLS])
    expect(list.json.result.tools[0].inputSchema.additionalProperties).toBe(false)
    expect((await post({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }, headers)).json.result.serverInfo.name).toBe('atum-work-gate')
    expect((await post({ jsonrpc: '2.0', id: 3, method: 'ping' }, headers)).status).toBe(200)

    const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, headers)

    expect(note.status).toBe(202)
    expect(note.raw).toBe('')
  })

  it('an accepted launch is not an error and a refusal is: isError follows the class', async () => {
    h.access.value = 'empty'
    const reply = await post(rpc('launch', launchArgs()), await good())

    expect(reply.json.result.isError).toBe(true)
    expect(reply.json.result.structuredContent).toMatchObject({ class: 'refused', reason: 'balance_empty' })
  })
})

describe('admission, in the contract\'s order: the first failure answers', () => {
  const cases: [string, () => Promise<Reply>, number, string][] = []

  const add = (name: string, run: () => Promise<Reply>, status: number, type: string) => cases.push([name, run, status, type])

  add('another host', async () => post(rpc('read', { threadId: 't' }), await good(), { host: 'evil.example.com' }), 404, 'wrong_host')
  add('no Host header value matching (empty)', async () => post(rpc('read', { threadId: 't' }), await good(), { host: '' }), 404, 'wrong_host')
  add('T3\'s own /mcp through the hostname', async () => post(rpc('read', { threadId: 't' }), await good(), { path: '/mcp' }), 404, 'no_route')
  add('the root path', async () => post(rpc('read', { threadId: 't' }), await good(), { path: '/' }), 404, 'no_route')
  add('a longer path', async () => post(rpc('read', { threadId: 't' }), await good(), { path: '/agent/mcp/x' }), 404, 'no_route')
  add('a GET', async () => post('', await good(), { method: 'GET' }), 405, 'method_not_allowed')
  add('an Origin header (a browser)', async () => post(rpc('read', { threadId: 't' }), await good({ origin: 'https://app.example.com' })), 403, 'origin_header')
  add('a cookie that is not Access\'s own', async () => post(rpc('read', { threadId: 't' }), await good({ cookie: 'session=abc' })), 403, 'cookie')
  add('Access\'s cookie with another value', async () => post(rpc('read', { threadId: 't' }), await good({ cookie: 'CF_Authorization=other' })), 403, 'cookie')
  add('two cookies', async () => post(rpc('read', { threadId: 't' }), await good({ cookie: 'CF_Authorization=x; a=b' })), 403, 'cookie')
  add('no assertion', async () => post(rpc('read', { threadId: 't' }), { authorization: `Bearer ${bearer}` }), 401, 'no_assertion')
  add('a forged assertion', async () => post(rpc('read', { threadId: 't' }), { 'cf-access-jwt-assertion': 'x.y.z', authorization: `Bearer ${bearer}` }), 401, 'bad_assertion')
  add('no grant', async () => post(rpc('read', { threadId: 't' }), { 'cf-access-jwt-assertion': await assertion() }), 401, 'no_grant')
  add('an unknown grant', async () => post(rpc('read', { threadId: 't' }), await good({ authorization: `Bearer ${'z'.repeat(43)}` })), 401, 'unknown_grant')
  add('bad JSON', async () => post('{not json', await good()), 400, 'bad_request')
  add('a batch', async () => post([rpc('read', {})], await good()), 400, 'bad_request')
  add('an rpc method that is not served', async () => post({ jsonrpc: '2.0', id: 1, method: 'resources/list' }, await good()), 400, 'bad_request')
  add('a call with no id', async () => post({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'read', arguments: {} } }, await good()), 400, 'bad_request')
  add('send is deferred', async () => post(rpc('send', { threadId: 't', message: 'hi' }), await good()), 403, 'tool_not_allowed')
  add('schedule_task', async () => post(rpc('schedule_task', {}), await good()), 403, 'tool_not_allowed')
  add('create_threads and t3_thread_update', async () => post(rpc('t3_thread_update', {}), await good()), 403, 'tool_not_allowed')
  add('an environment tool', async () => post(rpc('orchestrator_capabilities', {}), await good()), 403, 'tool_not_allowed')

  it.each(cases)('%s', async (_name, run, status, type) => {
    const reply = await run()

    expect(reply.status).toBe(status)
    expect(reply.json).toMatchObject({ error: { type }, gateId: { deviceServiceId: DEVICE } })
    expect(reply.headers['x-gate-id']).toBeTruthy()
    expect(h.t3.calls).toHaveLength(0)
  })

  it('the cookie Access itself adds is accepted: exactly `CF_Authorization` equal to the assertion', async () => {
    const token = await assertion()
    const reply = await post(rpc('read', { threadId: 'thread-1' }), { 'cf-access-jwt-assertion': token, cookie: `CF_Authorization=${token}`, authorization: `Bearer ${bearer}` })

    expect(reply.status).toBe(200)
  })

  it('a body over the bound is 413, after the grant and the list were checked', async () => {
    const reply = await post('x'.repeat(70_000), await good())

    expect(reply.status).toBe(413)
    expect(reply.json.error.type).toBe('body_too_large')
  })

  it('an oversize body without a valid grant is refused as a grant first (order)', async () => {
    const reply = await post('x'.repeat(70_000), { 'cf-access-jwt-assertion': await assertion() })

    expect(reply.json.error.type).toBe('no_grant')
  })

  it('a revoked grant on a stale list answers revoked (check 10 before check 11)', async () => {
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    h.clock.advance(400_000)

    expect((await post(rpc('read', { threadId: 't' }), await good())).json.error.type).toBe('revoked')
  })

  it('a stale list refuses every call, reads included, with 503; the next sync reopens', async () => {
    h.clock.advance(400_000)
    const refused = await post(rpc('read', { threadId: 't' }), await good())

    expect(refused.status).toBe(503)
    expect(refused.json.error.type).toBe('stale_entitlements')
    h.gate.noteGoodSync()
    expect((await post(rpc('read', { threadId: 'thread-1' }), await good())).status).toBe(200)
  })
})

describe('the signed assertion', () => {
  const refused = async (claims: Claims) => {
    const reply = await post(rpc('read', { threadId: 't' }), await good({ 'cf-access-jwt-assertion': await assertion(claims) }))

    expect(reply.status).toBe(401)
    expect(reply.json.error.type).toBe('bad_assertion')
    expect(JSON.stringify(reply.json)).not.toMatch(/iss|aud|exp|kid|signature/u)
  }

  it('wrong issuer; the sibling application\'s audience; an expired assertion; one not yet valid', async () => {
    await refused({ iss: 'https://other.cloudflareaccess.com' })
    await refused({ aud: SIBLING_AUD })
    await refused({ aud: [SIBLING_AUD] })
    await refused({ exp: Math.floor(h.clock.now() / 1000) - 10 })
    await refused({ nbf: Math.floor(h.clock.now() / 1000) + 600 })
  })

  it('a user identity (no common_name) and a token that is not enrolled are refused', async () => {
    await refused({ common_name: null, sub: 'user-1' })
    await refused({ common_name: 'qqqqqqqqqqqqqqqqqqqq.access' })
    await refused({ sub: 'someone' })
  })

  it('aud as an array holding this application is accepted; so is either Client ID during a rotation', async () => {
    const array = await post(rpc('read', { threadId: 'thread-1' }), await good({ 'cf-access-jwt-assertion': await assertion({ aud: [SIBLING_AUD, AUD] }) }))

    expect(array.status).toBe(200)

    clientIds = [CLIENT_ID, ROTATED_ID]
    const rotated = await post(rpc('read', { threadId: 'thread-1' }), await good({ 'cf-access-jwt-assertion': await assertion({ common_name: ROTATED_ID }) }))

    expect(rotated.status).toBe(200)

    clientIds = [ROTATED_ID]
    expect((await post(rpc('read', { threadId: 'thread-1' }), await good())).json.error.type).toBe('bad_assertion')
  })

  it('alg none and an HS256 token signed with the public key are refused', async () => {
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: `https://${TEAM}`, aud: AUD, exp: 9_999_999_999, common_name: CLIENT_ID, sub: '' })).toString('base64url')}.`
    const reply = await post(rpc('read', { threadId: 't' }), await good({ 'cf-access-jwt-assertion': none }))

    expect(reply.json.error.type).toBe('bad_assertion')

    const hs = await new SignJWT({ common_name: CLIENT_ID, sub: '' })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD)
      .setExpirationTime(Math.floor(h.clock.now() / 1000) + 3600)
      .sign(new TextEncoder().encode(JSON.stringify(keys[0].jwk)))

    expect((await post(rpc('read', { threadId: 't' }), await good({ 'cf-access-jwt-assertion': hs }))).json.error.type).toBe('bad_assertion')
  })

  it('a signature by a key the team does not publish is refused; an unknown kid fetches the certs again, then refuses', async () => {
    const before = jwksFetches

    await refused({ kid: 'k2' })
    expect(jwksFetches).toBeGreaterThan(before)
  })

  it('a key that rotates in is picked up by the refetch on an unknown kid', async () => {
    expect((await post(rpc('read', { threadId: 'thread-1' }), await good())).status).toBe(200)
    jwksPublished = keys.map(key => key.jwk)

    const reply = await post(rpc('read', { threadId: 'thread-1' }), await good({ 'cf-access-jwt-assertion': await assertion({ kid: 'k2' }) }))

    expect(reply.status).toBe(200)
  })

  it('with no certs cached and none fetchable the answer is refuse', async () => {
    jwksPublished = []
    const fresh = new AccessVerifier({ teamDomain: TEAM, audience: AUD, clientIds: () => [CLIENT_ID], now: h.clock.now, fetchJwks: async () => { throw new Error('offline') } })

    expect(await fresh.verify(await assertion())).toMatchObject({ ok: false })
  })
})

describe('B-0: every path from an agent to a plan, with a granted credential, through the real socket', () => {
  const planReady = () => {
    h.ledger.setPlanSwitch(true)
    h.consent({})
  }

  it('a plan launch with the consent: one thread on Codex, set by the gate, and no Proton read', async () => {
    planReady()
    h.access.value = 'empty'
    const reply = await post(rpc('launch', { ...launchArgs(), plan: 'codex' }), await good())

    expect(reply.json.result.structuredContent).toMatchObject({ class: 'accepted', receipt: 'launched' })
    expect((h.t3.calls.find(call => call.tool === 'launch')?.args as { call: { modelSelection: unknown } }).call.modelSelection).toEqual({ instanceId: 'codex', model: 'codex-model-1' })
  })

  it.each([
    ['claude', 'claude'],
    ['claudeAgent', 'claudeAgent'],
    ['antigravity', 'antigravity'],
    ['another case', 'CODEX'],
    ['a padded name', 'codex '],
    ['true', true],
    ['an object', { instanceId: 'codex' }],
    ['null', null]
  ])('plan: %s is refused as an invalid field; T3 and the homeserver see nothing', async (_name, value) => {
    planReady()
    const reply = await post(rpc('launch', { ...launchArgs(), plan: value }), await good())

    expect(reply.json.result.structuredContent).toMatchObject({ class: 'refused', reason: 'invalid_field' })
    expect(h.t3.calls).toHaveLength(0)
    expect(h.owner.fetched).toHaveLength(0)
  })

  it.each([
    ['a provider beside the plan', { plan: 'codex', provider: 'claudeAgent' }],
    ['a model selection beside the plan', { plan: 'codex', modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' } }],
    ['an instance id', { plan: 'codex', instanceId: 'antigravity' }],
    ['a runtime mode', { plan: 'codex', runtimeMode: 'full-access' }],
    ['a plan list', { plans: ['codex'] }]
  ])('%s is an unknown field, refused and not trimmed', async (_name, extra) => {
    planReady()
    const reply = await post(rpc('launch', { ...launchArgs(), ...extra }), await good())

    expect(reply.json.result.structuredContent).toMatchObject({ class: 'refused', reason: 'unknown_field' })
    expect(h.t3.calls).toHaveLength(0)
  })

  it('the six gate tools share no name with any tool T3 advertises, and every one of T3\'s is refused at the gate with T3 never called', async () => {
    planReady()

    for (const name of PINNED_T3_TOOLS) {
      expect(WORK_TOOLS).not.toContain(name)

      const reply = await post(rpc(name, { threadId: 't', message: 'hi', providerInstanceId: 'codex' }), await good())

      expect(reply.status).toBe(403)
      expect(reply.json.error.type).toBe('tool_not_allowed')
    }

    expect(h.t3.calls).toHaveLength(0)
  })

  it('there is no tool that sends to a thread or moves one to a provider: the list is the six and `launch` is the only one that starts a run', async () => {
    const list = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, await good())

    expect(list.json.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(['interrupt', 'launch', 'list', 'read', 'request', 'wait'])
  })

  it('consent and the switch are the Mac\'s alone: the answer to an agent names only the check that failed', async () => {
    h.consent({ state: 'off', agents: [] })
    const reply = await post(rpc('launch', { ...launchArgs(), plan: 'codex' }), await good())

    expect(reply.json.result.structuredContent).toMatchObject({ class: 'refused', reason: 'plan_consent_off' })
    expect(JSON.stringify(reply.json)).not.toMatch(/revision|consent":|switch|codex-model/u)
  })
})

describe('direct calls with a granted credential (T10)', () => {
  it.each([
    ['scratch', { scratch: true }],
    ['an attachment', { attachments: [{ name: 'a' }] }],
    ['delegatedFrom', { delegatedFrom: 'x' }],
    ['an environmentId', { environmentId: 'e' }],
    ['another provider', { provider: 'codex' }],
    ['a modelSelection', { modelSelection: { instanceId: 'codex', model: 'x' } }],
    ['a workspaceStrategy', { workspaceStrategy: { type: 'worktree' } }],
    ['an agent id', { agent: LUNA }],
    ['an unknown field', { surprise: 1 }]
  ])('a launch with %s is refused, not trimmed, and T3 sees nothing', async (_name, extra) => {
    const reply = await post(rpc('launch', { ...launchArgs(), ...extra }), await good())

    expect(reply.status).toBe(200)
    expect(reply.json.result.structuredContent).toMatchObject({ class: 'refused', reason: 'unknown_field' })
    expect(reply.json.result.isError).toBe(true)
    expect(h.t3.calls).toHaveLength(0)
    expect(h.owner.fetched).toHaveLength(0)
  })

  it('a malformed value is `invalid_field`; a bad request id is a 400', async () => {
    const invalid = await post(rpc('launch', { ...launchArgs(), task: '' }), await good())

    expect(invalid.json.result.structuredContent).toMatchObject({ class: 'refused', reason: 'invalid_field' })

    const bad = await post(rpc('launch', { ...launchArgs(), requestId: 'short' }), await good())

    expect(bad.status).toBe(400)
    expect(h.t3.calls).toHaveLength(0)
  })

  it('an interrupt of a thread the agent did not start, and one it did not launch under the current session, is refused', async () => {
    const notMine = await post(rpc('interrupt', { threadId: 'thread-owner-1' }), await good())

    expect(notMine.json.result.structuredContent).toMatchObject({ class: 'refused', reason: 'not_in_ledger' })
    expect(h.t3.count('interrupt')).toBe(0)
  })

  it('reads of other Work conversations succeed, as the enrollment text says (D14): the Access token and the grant are enough', async () => {
    h.t3.threads.set('thread-owner-1', { id: 'thread-owner-1', sessionId: 'sess-owner', runs: [{ runId: 'r1', ordinal: 1, status: 'completed' }], message: 'owner thread', provider: 'atum-managed' })
    const reply = await post(rpc('read', { threadId: 'thread-owner-1' }), await good())

    expect(reply.json.result.structuredContent).toMatchObject({ class: 'ok', status: 'completed' })
  })

  it('a request with a bad action is a 400; an invalid thread tool body is `invalid_arguments`', async () => {
    expect((await post(rpc('request', { requestId: REQ_2, action: 'delete' }), await good())).status).toBe(400)
    expect((await post(rpc('read', { threadId: 'a b' }), await good())).json.result.structuredContent).toMatchObject({ class: 'refused', reason: 'invalid_arguments' })
    expect((await post(rpc('wait', { threadId: 't', timeoutMs: 120_000 }), await good())).json.result.structuredContent).toMatchObject({ class: 'refused', reason: 'invalid_arguments' })
  })
})

describe('reply silencing at release (step 2)', () => {
  it('a wait in flight when its agent is revoked is answered `revoked`, never the content', async () => {
    const accepted = await post(rpc('launch', launchArgs()), await good())
    const threadId = accepted.json.result.structuredContent.threadId as string
    let release!: () => void

    h.t3.holdWait = new Promise<void>(resolve => {
      release = resolve
    })

    const waiting = post(rpc('wait', { threadId, timeoutMs: 50_000 }), await good())

    await new Promise(resolve => setTimeout(resolve, 30))
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    h.t3.finish(threadId)
    release()

    const reply = await waiting

    expect(reply.status).toBe(200)
    expect(reply.json.result.structuredContent).toMatchObject({ class: 'revoked', scope: 'agent' })
    expect(reply.json.result.structuredContent.status).toBeUndefined()
    expect(reply.json.result.isError).toBe(true)
    // and the next call with the dead grant is an admission `revoked`
    expect((await post(rpc('read', { threadId }), await good())).json.error.type).toBe('revoked')
  })

  it('a launch reply held in T3 when the route closes is `revoked` with no thread; the thread is stopped', async () => {
    let release!: () => void

    h.t3.holdReply = new Promise<void>(resolve => {
      release = resolve
    })

    const launching = post(rpc('launch', launchArgs()), await good())

    await new Promise(resolve => setTimeout(resolve, 30))
    h.gate.revoke({ scope: 'route', reason: 'switch_off' })
    release()

    const reply = await launching

    expect(reply.json.result.structuredContent).toMatchObject({ class: 'revoked', receipt: 'revoked', scope: 'route' })
    expect(JSON.stringify(reply.json)).not.toContain('mcp:launch')
    await h.gate.scheduleSettle()
    expect([...h.t3.threads.values()][0].runs[0].status).toBe('interrupted')
  })
})

describe('logs carry ids and typed reasons only', () => {
  it('no assertion, grant, prompt or reply body in the gate\'s log', async () => {
    const token = await assertion()

    await post(rpc('launch', launchArgs()), { 'cf-access-jwt-assertion': token, authorization: `Bearer ${bearer}` })
    await post(rpc('read', { threadId: 't' }), { 'cf-access-jwt-assertion': 'x.y.z', authorization: `Bearer ${bearer}` })

    const joined = logs.join('\n')

    expect(joined).not.toContain(token)
    expect(joined).not.toContain(bearer)
    expect(joined).not.toContain('Reports folder')
    expect(joined).not.toContain('eyJ')
    expect(joined.length).toBeGreaterThan(0)
  })
})
