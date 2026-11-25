import { createHash } from 'node:crypto'

import { expect, it, vi } from 'vitest'

import { memorySecretStore } from '../gate/sessions'

import { WorkT3McpPublication } from './t3-mcp'

const DAY = 86_400_000
const LOCAL = 'http://127.0.0.1:4321'
const CONNECT = 'https://mac.example.test'
const RELAY = 'https://relay.atumplatform.com'
const START = 1_750_000_000_000
const sessionId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const bearer = (n: number) => `${Buffer.from(JSON.stringify({ kind: 'session', sid: sessionId(n) })).toString('base64url')}.signature`

function fixture() {
  const state = {
    connectOrigin: CONNECT, linked: true, linkableHere: false, relayUnavailable: false, linkResponseLost: false,
    badState: false, registrationOrigin: undefined as string | undefined
  }
  const sessions = new Map<string, string>()
  const records: Array<{ url: string; init?: RequestInit }> = []
  let minted = 0
  let now = START
  const auth = {
    sessionIds: vi.fn(async (label?: string) => [...sessions.keys()].filter(id => !label || label === sessions.get(id))),
    revokeSession: vi.fn(async (id: string) => { sessions.delete(id) })
  }
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    records.push({ url: url.href, init })

    if (![LOCAL, state.connectOrigin, RELAY].includes(url.origin)) {throw new Error('unexpected fixture origin')}

    switch (url.pathname) {
      case '/.well-known/oauth-authorization-server':
        return Response.json({ registration_endpoint: `${state.registrationOrigin ?? state.connectOrigin}/oauth/mcp/register` })
      case '/oauth/mcp/register':
        return Response.json({ client_id: 'fixture-client' })
      case '/api/connect/link-state':
        return Response.json({ linked: state.linked, linkableHere: state.linkableHere, tunnelHostname: new URL(state.connectOrigin).hostname })
      case '/.well-known/t3/environment':
        return Response.json({ environmentId: 'env-fixture' })
      case '/v1/client/environment-link-challenges':
        return state.relayUnavailable ? new Response(null, { status: 503 }) : Response.json({ challenge: 'challenge' })
      case '/api/connect/link-proof':
        return Response.json('proof')
      case '/v1/client/environment-links':
        return Response.json({
          ok: true, environmentId: 'env-fixture', cloudUserId: 'owner', relayIssuer: RELAY,
          endpoint: { providerKind: 'cloudflare_tunnel' },
          endpointRuntime: { providerKind: 'cloudflare_tunnel', connectorToken: 'connector-fixture' },
          environmentCredential: 'environment-fixture', cloudMintPublicKey: 'mint-key-fixture'
        })
      case '/api/connect/relay-config':
        state.linked = true
        if (state.linkResponseLost) {throw new Error('lost config reply')}

        return Response.json({ ok: true })
      case '/oauth/mcp/decision': {
        const { authorization } = JSON.parse(String(init?.body))
        const callback = new URL(authorization.redirect_uri)
        callback.searchParams.set('state', state.badState ? 'wrong' : authorization.state)
        callback.searchParams.set('code', 'fixture-code')

        return Response.json({ redirectTo: callback.href })
      }
      case '/oauth/mcp/token':
        sessions.set(sessionId(++minted), 'Atum Work')

        return Response.json({ access_token: bearer(minted), expires_in: 30 * 86_400 })
      default:
        throw new Error('unexpected fixture path')
    }
  }
  const target = {
    accountKey: 'owner', deviceServiceId: 'device-fixture', workOrigin: LOCAL, ownerFetch: request,
    assertion: vi.fn(async () => 'assertion'), pairing: { create: vi.fn(async () => 'pairing-fixture') },
    store: memorySecretStore(), current: () => true, auth, call: vi.fn(async (_operation: string, _body: object) => {})
  }
  const newPublication = () => new WorkT3McpPublication(request, () => now)

  return { target, records, auth, state, sessions, newPublication, advance: (ms: number) => { now += ms } }
}

it('uses Connect for discovery and DCR, and loopback Work for pairing, approval and PKCE exchange', async () => {
  const { target, records, newPublication } = fixture()
  await newPublication().refresh(target)

  expect(records.map(row => row.url)).toEqual([
    `${LOCAL}/api/connect/link-state`,
    `${CONNECT}/.well-known/oauth-authorization-server`,
    `${CONNECT}/oauth/mcp/register`,
    `${LOCAL}/oauth/mcp/decision`,
    `${LOCAL}/oauth/mcp/token`
  ])
  expect(records[0]?.init).toMatchObject({ credentials: 'include', redirect: 'error' })
  expect(target.pairing.create).toHaveBeenCalledTimes(1)
  expect(target.assertion).not.toHaveBeenCalled()
  const registration = JSON.parse(String(records[2]?.init?.body))
  const { authorization, decision } = JSON.parse(String(records[3]?.init?.body))
  const form = new URLSearchParams(records[4]?.init?.body as URLSearchParams)

  expect(decision).toEqual({ _tag: 'pairing-code', access: 'full-access', code: 'pairing-fixture' })
  expect(registration).toMatchObject({ client_name: 'Atum Work', redirect_uris: [authorization.redirect_uri], token_endpoint_auth_method: 'none' })
  expect(authorization).toMatchObject({
    response_type: 'code', client_id: 'fixture-client', resource: `${LOCAL}/mcp`,
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(form.get('code_verifier')!).digest('base64url')
  })
  expect(Object.fromEntries(form)).toMatchObject({
    grant_type: 'authorization_code', code: 'fixture-code', client_id: authorization.client_id,
    redirect_uri: authorization.redirect_uri, resource: authorization.resource
  })
  expect(target.call).toHaveBeenCalledWith('work_t3_mcp_set', {
    deviceServiceId: target.deviceServiceId, connectUrl: `${CONNECT}/mcp`, credential: bearer(1), expiresAt: START + 30 * DAY
  })
})

it('refuses cross-origin registration metadata and a callback with the wrong OAuth state', async () => {
  const { state, records, target, newPublication } = fixture()
  const publication = newPublication()

  state.registrationOrigin = 'https://foreign.example.test'
  await expect(publication.refresh(target)).rejects.toThrow('work_t3_mcp_invalid_registration_endpoint')
  expect(target.pairing.create).not.toHaveBeenCalled()

  state.registrationOrigin = undefined
  state.badState = true
  await expect(publication.refresh(target)).rejects.toThrow('t3_oauth_decision_failed')
  expect(records.some(row => row.url.endsWith('/oauth/mcp/token'))).toBe(false)
  expect(target.call).not.toHaveBeenCalled()
})

it('reuses one live credential across relaunch, revokes orphans and replaces the session on renewal or URL change', async () => {
  const { state, target, sessions, auth, newPublication, advance } = fixture()
  sessions.set(sessionId(90), 'Other app')
  sessions.set(sessionId(91), 'Atum Work')
  const first = newPublication()
  await Promise.all([first.refresh(target), first.refresh(target)])
  expect(auth.revokeSession).toHaveBeenCalledExactlyOnceWith(sessionId(91))

  const next = newPublication()
  const restartedOrigin = 'http://127.0.0.1:5555'
  await next.refresh({
    ...target, workOrigin: restartedOrigin,
    ownerFetch: (input, init) => target.ownerFetch(String(input).replace(restartedOrigin, LOCAL), init)
  })
  advance(23 * DAY)
  await next.refresh(target)
  expect(target.pairing.create).toHaveBeenCalledTimes(1)

  advance(1)
  await next.refresh(target)
  expect(target.call.mock.calls[1]?.[1]).toMatchObject({ credential: bearer(2), expiresAt: START + 53 * DAY + 1 })
  expect(auth.revokeSession).toHaveBeenLastCalledWith(sessionId(1))

  state.connectOrigin = 'https://other-mac.example.test'
  await next.refresh(target)
  expect(target.call.mock.calls[2]?.[1]).toMatchObject({ connectUrl: `${state.connectOrigin}/mcp`, credential: bearer(3) })
  expect(auth.revokeSession).toHaveBeenLastCalledWith(sessionId(2))
  expect([...sessions.keys()]).toEqual([sessionId(90), sessionId(3)])

  state.linked = false
  await next.refresh(target)
  expect(auth.revokeSession).toHaveBeenLastCalledWith(sessionId(3))
  expect(target.call).toHaveBeenLastCalledWith('work_t3_mcp_clear', { deviceServiceId: target.deviceServiceId })
})

it('retries a lost publication acknowledgement after relaunch with the same pending bearer', async () => {
  const { target, newPublication } = fixture()
  target.call.mockRejectedValueOnce(new Error('reply lost'))

  await expect(newPublication().refresh(target)).rejects.toThrow('reply lost')
  await newPublication().refresh(target)

  expect(target.pairing.create).toHaveBeenCalledTimes(1)
  expect(target.call.mock.calls[1]).toEqual(target.call.mock.calls[0])
})

it('revokes locally when the owner bearer has expired or the device revoke already deleted the Shell row', async () => {
  const { target, sessions, newPublication } = fixture()
  await newPublication().refresh(target)
  target.call.mockRejectedValueOnce(new Error('owner bearer expired'))
  const shell = { deviceServiceId: target.deviceServiceId, call: target.call }
  await expect(newPublication().clear(target, { shell })).rejects.toThrow('t3_mcp_shell_clear_failed')
  expect(sessions.size).toBe(0)

  await newPublication().refresh(target)
  target.call.mockClear()
  await newPublication().clear(target, { revokedDeviceServiceId: target.deviceServiceId })
  expect(sessions.size).toBe(0)
  expect(target.call).not.toHaveBeenCalled()
})

it('keeps the current credential when a delayed revoke names an earlier enrollment', async () => {
  const { target, sessions, newPublication } = fixture()
  await newPublication().refresh(target)
  await newPublication().clear(target, { revokedDeviceServiceId: 'old-device' })
  expect([...sessions.keys()]).toEqual([sessionId(1)])
})

it('retries a failed native revoke before ever reusing the retired credential', async () => {
  const { target, auth, sessions, newPublication } = fixture()
  await newPublication().refresh(target)
  auth.revokeSession.mockRejectedValueOnce(new Error('native revoke unavailable'))
  await expect(newPublication().clear(target)).rejects.toThrow('t3_mcp_native_revoke_failed')
  expect(sessions.has(sessionId(1))).toBe(true)

  await newPublication().refresh(target)
  expect([...sessions.keys()]).toEqual([sessionId(2)])
  expect(target.call).toHaveBeenLastCalledWith('work_t3_mcp_set', expect.objectContaining({ credential: bearer(2) }))
})

it('joins a publication in flight, then revokes and clears it', async () => {
  const { target, sessions, newPublication } = fixture()
  const publication = newPublication()
  let finishSet!: () => void
  const set = new Promise<void>(resolve => { finishSet = resolve })
  let startClear!: () => void
  const setStarted = new Promise<void>(resolve => { startClear = resolve })

  target.call.mockImplementationOnce(async () => {
    startClear()
    await set
  })

  const refresh = publication.refresh(target)
  await setStarted
  const retiring = publication.clear(target, { shell: { deviceServiceId: target.deviceServiceId, call: target.call } })
  expect(target.call).toHaveBeenCalledTimes(1)
  finishSet()
  await Promise.all([refresh, retiring])
  expect(target.call.mock.calls.map(([operation]) => operation)).toEqual(['work_t3_mcp_set', 'work_t3_mcp_clear'])
  expect(sessions.size).toBe(0)
})

it('respects a native unlink across relaunch, withdraws both credentials and accepts a new opt-in', async () => {
  const { target, state, sessions, newPublication } = fixture()
  Object.assign(state, { linked: false, linkableHere: true })
  await newPublication().refresh(target)
  expect(state.linked).toBe(true)
  expect([...sessions.keys()]).toEqual([sessionId(1)])

  state.linked = false
  await newPublication().refresh(target)
  await newPublication().refresh(target)
  expect(target.call.mock.calls.map(([operation]) => operation)).toEqual(['work_t3_mcp_set', 'work_t3_mcp_clear'])
  expect(target.assertion).toHaveBeenCalledTimes(2)
  expect(sessions.size).toBe(0)
  expect(state.linked).toBe(false)

  const publication = newPublication()
  publication.allowConnectLink(target.accountKey, target.store)
  await publication.refresh(target)
  expect(state.linked).toBe(true)
  expect([...sessions.keys()]).toEqual([sessionId(2)])
})

it('preserves unlink intent if Work applied the config but its reply was lost', async () => {
  const { target, state, newPublication } = fixture()
  Object.assign(state, { linked: false, linkableHere: true, linkResponseLost: true })
  await expect(newPublication().refresh(target)).rejects.toThrow('lost config reply')
  expect(state.linked).toBe(true)

  state.linked = false
  await newPublication().refresh(target)
  expect(state.linked).toBe(false)
  expect(target.assertion).toHaveBeenCalledTimes(2)
  expect(target.call).not.toHaveBeenCalled()
})

it('backs off failed link attempts exponentially, capped at 30 minutes', async () => {
  const { target, state, newPublication, advance } = fixture()
  Object.assign(state, { linked: false, linkableHere: true, relayUnavailable: true })
  const publication = newPublication()
  await expect(publication.refresh(target)).rejects.toThrow('work_connect_unavailable')

  for (const [index, minutes] of [2, 4, 8, 16, 30, 30].entries()) {
    advance(minutes * 60_000 - 1)
    await publication.refresh(target)
    expect(target.assertion).toHaveBeenCalledTimes(index + 1)

    advance(1)
    await expect(publication.refresh(target)).rejects.toThrow('work_connect_unavailable')
    expect(target.assertion).toHaveBeenCalledTimes(index + 2)
  }

  state.relayUnavailable = false
  publication.allowConnectLink(target.accountKey, target.store)
  await publication.refresh(target)
  expect(state.linked).toBe(true)
})

it('reports both withdrawal failures with safe codes and retries both after relaunch', async () => {
  const { target, state, auth, sessions, newPublication } = fixture()
  await newPublication().refresh(target)
  state.linked = false
  auth.revokeSession.mockRejectedValueOnce(new Error('native sensitive detail'))
  target.call.mockRejectedValueOnce(new Error('Shell sensitive detail'))

  await expect(newPublication().refresh(target)).rejects.toMatchObject({
    message: 't3_mcp_native_revoke_failed, t3_mcp_shell_clear_failed',
    failures: ['t3_mcp_native_revoke_failed', 't3_mcp_shell_clear_failed']
  })
  expect(sessions.has(sessionId(1))).toBe(true)
  expect(target.call).toHaveBeenLastCalledWith('work_t3_mcp_clear', { deviceServiceId: target.deviceServiceId })

  await newPublication().refresh(target)
  expect(sessions.size).toBe(0)
  expect(target.call.mock.calls.map(([operation]) => operation)).toEqual([
    'work_t3_mcp_set', 'work_t3_mcp_clear', 'work_t3_mcp_clear'
  ])
})

it('keeps the published native models while Work is offline and accepts an explicit disconnect', async () => {
  const { target, advance, newPublication } = fixture()
  const { deviceServiceId, store } = target
  const publication = newPublication()
  const catalog = { codex: { state: 'connected' as const, models: [{ id: 'test-model', displayName: 'Test model' }] } }

  expect(publication.isPublished(store, deviceServiceId)).toBe(false)
  await publication.refresh(target)
  expect(publication.isPublished(store, deviceServiceId)).toBe(true)
  expect(publication.planCatalog(store, deviceServiceId, catalog)).toEqual(catalog)

  const reopened = newPublication()
  expect(reopened.isPublished(store, deviceServiceId)).toBe(true)
  expect(reopened.planCatalog(store, deviceServiceId, {})).toEqual(catalog)
  const disconnected = { codex: { state: 'disconnected' as const } }
  expect(reopened.planCatalog(store, deviceServiceId, disconnected)).toEqual(disconnected)
  expect(reopened.planCatalog(store, 'another-device', {})).toEqual({})

  advance(31 * DAY)
  expect(reopened.isPublished(store, deviceServiceId)).toBe(false)
})
