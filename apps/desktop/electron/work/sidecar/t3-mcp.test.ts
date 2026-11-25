import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'

import { afterEach, expect, it, vi } from 'vitest'

import { deviceServiceCall } from '../gate/platform'

import { mintT3McpCredential, WorkT3McpPublication } from './t3-mcp'

const DAY = 86_400_000
const CONNECT = 'https://mac.example.test'
const LOCAL_BEARER = 'local-fixture'
const PAIRING_CODE = 'pairing-fixture'
const ACCESS_TOKEN = 'access-fixture'
const servers: Server[] = []

interface HttpRecord {
  path: string
  method?: string
  authorization?: string
  body: string
}

async function serve(handle: (record: HttpRecord) => unknown) {
  const records: HttpRecord[] = []

  const server = createServer(async (req, res) => {
    let body = ''

    for await (const chunk of req) {body += chunk}
    const record = { path: req.url ?? '', method: req.method, authorization: req.headers.authorization, body }
    records.push(record)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(handle(record)))
  })

  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()

  if (!address || typeof address === 'string') {throw new Error('fixture unavailable')}

  return { origin: `http://127.0.0.1:${address.port}`, records }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

async function fixture() {
  const state = { connectOrigin: CONNECT, linked: true, badState: false, registrationOrigin: undefined as string | undefined }

  const connect = await serve(({ path }) => path === '/.well-known/oauth-authorization-server'
    ? { registration_endpoint: `${state.registrationOrigin ?? state.connectOrigin}/oauth/mcp/register` }
    : { client_id: 'fixture-client' })

  const work = await serve(({ path, body }) => {
    switch (path) {
      case '/api/connect/link-state':
        return { linked: state.linked, tunnelHostname: new URL(state.connectOrigin).hostname }

      case '/api/auth/pairing-token':
        return { credential: PAIRING_CODE }
      case '/oauth/mcp/decision': {
        const { authorization } = JSON.parse(body)
        const callback = new URL(authorization.redirect_uri)
        callback.searchParams.set('state', state.badState ? 'wrong' : authorization.state)
        callback.searchParams.set('code', 'fixture-code')

        return { redirectTo: callback.href }
      }

      case '/oauth/mcp/token':
        return { access_token: ACCESS_TOKEN, expires_in: 30 * 86_400 }

      default:
        return {}
    }
  })

  const request: typeof fetch = (input, init) => {
    const url = new URL(String(input))

    if (url.origin === state.connectOrigin) {return fetch(new URL(url.pathname, connect.origin), init)}

    if (url.origin === work.origin) {return fetch(url, init)}

    throw new Error('unexpected fixture origin')
  }

  return { work, connect, state, request }
}

it('uses Connect only for discovery and DCR and approves and exchanges the PKCE code on local Work', async () => {
  const { work, connect, request } = await fixture()
  const now = 1_750_000_000_000

  const result = await mintT3McpCredential({
    workOrigin: work.origin, connectUrl: `${CONNECT}/mcp`, localBearer: LOCAL_BEARER, fetch: request, now: () => now
  })

  expect(result).toEqual({ credential: ACCESS_TOKEN, expiresAt: now + 30 * DAY })
  expect(connect.records.map(({ path, method, authorization }) => [path, method, authorization])).toEqual([
    ['/.well-known/oauth-authorization-server', 'GET', undefined],
    ['/oauth/mcp/register', 'POST', undefined]
  ])
  const registration = JSON.parse(connect.records[1]!.body)

  const [pairing, decision, exchange] = work.records
  expect(pairing).toMatchObject({ path: '/api/auth/pairing-token', method: 'POST', authorization: `Bearer ${LOCAL_BEARER}`, body: '{}' })
  expect(decision).toMatchObject({ path: '/oauth/mcp/decision', method: 'POST', authorization: undefined })
  expect(exchange).toMatchObject({ path: '/oauth/mcp/token', method: 'POST', authorization: undefined })
  const form = new URLSearchParams(exchange!.body)
  const { authorization, decision: approval } = JSON.parse(decision!.body)

  expect(approval).toEqual({ _tag: 'pairing-code', access: 'full-access', code: PAIRING_CODE })
  expect(authorization).toMatchObject({
    response_type: 'code', client_id: 'fixture-client',
    resource: `${work.origin}/mcp`, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(form.get('code_verifier')!).digest('base64url')
  })
  expect(registration).toMatchObject({
    redirect_uris: [authorization.redirect_uri], token_endpoint_auth_method: 'none', scope: authorization.scope
  })
  expect(new URL(authorization.redirect_uri).hostname).toBe('127.0.0.1')
  expect(Object.fromEntries(form)).toMatchObject({
    grant_type: 'authorization_code', code: 'fixture-code', client_id: authorization.client_id,
    redirect_uri: authorization.redirect_uri, resource: authorization.resource
  })
})

it('refuses cross-origin registration metadata and a callback with the wrong OAuth state', async () => {
  const { work, connect, state, request } = await fixture()
  const input = { workOrigin: work.origin, connectUrl: `${CONNECT}/mcp`, localBearer: LOCAL_BEARER, fetch: request }
  state.registrationOrigin = 'https://foreign.example.test'
  await expect(mintT3McpCredential(input)).rejects.toThrow('work_t3_mcp_invalid_registration_endpoint')
  expect(connect.records).toHaveLength(1)
  expect(work.records).toHaveLength(0)

  state.registrationOrigin = undefined
  state.badState = true
  await expect(mintT3McpCredential(input)).rejects.toThrow('work_t3_mcp_invalid_callback')
  expect(work.records.map(row => row.path)).toEqual(['/api/auth/pairing-token', '/oauth/mcp/decision'])
})

it('publishes for a linked Mac, renews inside seven days, replaces changed URLs and clears on unlink', async () => {
  const { work, connect, state, request } = await fixture()
  const shell = await serve(() => ({ ok: true }))
  const start = 1_750_000_000_000
  let now = start
  const publication = new WorkT3McpPublication(request, () => now)

  const target = {
    deviceServiceId: 'device-fixture', workOrigin: work.origin, localBearer: async () => LOCAL_BEARER,
    current: () => true,
    call: deviceServiceCall({ endpoint: `${shell.origin}/device-services`, bearer: async () => 'owner-fixture' })
  }

  const publish = () => publication.refresh(target)
  const payloads = () => shell.records.map(row => JSON.parse(row.body))

  state.linked = false
  await publish()
  expect(connect.records).toHaveLength(0)
  expect(payloads()).toEqual([])

  state.linked = true
  await Promise.all([publish(), publish()])
  expect(payloads()).toEqual([{ operation: 'work_t3_mcp_set', deviceServiceId: target.deviceServiceId,
    connectUrl: `${CONNECT}/mcp`, credential: ACCESS_TOKEN, expiresAt: start + 30 * DAY }])
  expect(shell.records[0]).toMatchObject({ authorization: 'Bearer owner-fixture', path: '/device-services' })

  now += 23 * DAY
  await publish()
  expect(payloads()).toHaveLength(1)

  now += 1
  await publish()
  expect(payloads()[1]).toMatchObject({ operation: 'work_t3_mcp_set', expiresAt: now + 30 * DAY })

  state.connectOrigin = 'https://other-mac.example.test'
  await publish()
  expect(payloads()[2]).toMatchObject({ operation: 'work_t3_mcp_set', connectUrl: `${state.connectOrigin}/mcp` })

  state.linked = false
  await publish()
  expect(payloads()[3]).toEqual({ operation: 'work_t3_mcp_clear', deviceServiceId: target.deviceServiceId })
})

it('waits for a set in flight before clearing on retirement', async () => {
  const { work, request } = await fixture()
  const publication = new WorkT3McpPublication(request)
  let finishSet!: () => void
  const set = new Promise<void>(resolve => { finishSet = resolve })
  let startClear!: () => void
  const setStarted = new Promise<void>(resolve => { startClear = resolve })

  const call = vi.fn(async (operation: string) => {
    if (operation === 'work_t3_mcp_set') {
      startClear()
      await set
    }
  })

  const target = { deviceServiceId: 'mac', workOrigin: work.origin, localBearer: async () => LOCAL_BEARER, current: () => true, call }

  const refresh = publication.refresh(target)
  await setStarted
  const retiring = publication.clear(target.deviceServiceId, call)
  expect(call).toHaveBeenCalledTimes(1)
  finishSet()
  await Promise.all([refresh, retiring])
  expect(call.mock.calls.map(([operation]) => operation)).toEqual(['work_t3_mcp_set', 'work_t3_mcp_clear'])
})
