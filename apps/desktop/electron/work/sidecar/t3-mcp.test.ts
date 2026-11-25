import { createHash } from 'node:crypto'

import { expect, it, vi } from 'vitest'

import { memorySecretStore } from '../gate/sessions'

import { WorkT3McpPublication } from './t3-mcp'

const DAY = 86_400_000
const LOCAL = 'http://127.0.0.1:4321'
const CONNECT = 'https://mac.example.test'
const START = 1_750_000_000_000
const sessionId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const bearer = (n: number) => `${Buffer.from(JSON.stringify({ kind: 'session', sid: sessionId(n) })).toString('base64url')}.signature`

function fixture() {
  const state = { connectOrigin: CONNECT, linked: true, badState: false, registrationOrigin: undefined as string | undefined }
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

    if (![LOCAL, state.connectOrigin].includes(url.origin)) {throw new Error('unexpected fixture origin')}

    switch (url.pathname) {
      case '/.well-known/oauth-authorization-server':
        return Response.json({ registration_endpoint: `${state.registrationOrigin ?? state.connectOrigin}/oauth/mcp/register` })
      case '/oauth/mcp/register':
        return Response.json({ client_id: 'fixture-client' })
      case '/api/connect/link-state':
        return Response.json({ linked: state.linked, linkableHere: false, tunnelHostname: new URL(state.connectOrigin).hostname })
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
  await expect(newPublication().clear(target, { shell })).rejects.toThrow('owner bearer expired')
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
  await expect(newPublication().clear(target)).rejects.toThrow('native revoke unavailable')
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
