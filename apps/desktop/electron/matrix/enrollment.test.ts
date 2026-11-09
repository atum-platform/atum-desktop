import { afterEach, expect, it, vi } from 'vitest'

import {
  agentCredential,
  appCredential,
  appEnrollmentIdentity,
  enrollmentIdentity,
  MatrixEnrollmentRateLimited,
  matrixRetryAfterMs,
  printableDeviceId,
  requestAppTurn,
  requestEnrollment,
  requestInvocation,
  requestLease,
  requestLocalEnrollmentCapabilities,
  sameMatrixEnrollment,
  withoutMatrixExpiry
} from './enrollment'

const owner = { issuer: 'https://id.test/', subject: 'alice', principal: '12345678-1234-1234-1234-123456789abc' }
const executor = '22345678-1234-1234-1234-123456789abc'
const appId = '42345678-1234-1234-1234-123456789abc'
const appVersionId = '52345678-1234-1234-1234-123456789abc'
const installationId = '62345678-1234-1234-1234-123456789abc'
const grant = { ...owner, accessToken: 'domain-only', refreshToken: 'never-sent' }

const credential = () => ({
  ...owner,
  executorId: executor,
  agentPrincipal: '32345678-1234-1234-1234-123456789abc',
  userId: '@hermes:test',
  deviceId: 'AGENT',
  accessToken: 'agent-only',
  expiresAt: Date.now() + 3600000
})

afterEach(() => vi.unstubAllGlobals())

const turn = () => ({
  invocationId: executor,
  text: 'Only this turn',
  mentionedUserIds: ['@app:test'],
  signal: new AbortController().signal,
  deadlineAt: Date.now() + 30000
})

it('delivers a bounded one-shot app turn with only the dispatch-bound text and mentions', async () => {
  const request = vi.fn(async () => Response.json({ text: 'Reply', secretExtra: 'ignored' }))
  vi.stubGlobal('fetch', request)
  const input = { ...turn(), history: ['private canary'], accessToken: 'not forwarded' }
  expect(await requestAppTurn('https://api.test', grant, 'river', input)).toEqual({ text: 'Reply' })
  expect(request).toHaveBeenCalledOnce()
  const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://api.test/apps/river/proxy/turns')
  expect(init.redirect).toBe('error')
  expect(JSON.parse(init.body as string)).toEqual({
    invocationId: executor,
    text: input.text,
    mentionedUserIds: input.mentionedUserIds
  })
  expect(init.headers).toEqual({ Authorization: 'Bearer domain-only', 'Content-Type': 'application/json' })
})

it.each([401, 409, 500])('never replays an ambiguous app delivery after HTTP %s', async status => {
  const request = vi.fn(async () => new Response(null, { status }))
  vi.stubGlobal('fetch', request)
  await expect(requestAppTurn('https://api.test', grant, 'river', turn())).rejects.toThrow(
    'matrix_app_turn_unavailable'
  )
  expect(request).toHaveBeenCalledOnce()
})

it.each([null, {}, { text: '' }, { text: ' '.repeat(4) }, { text: 'x'.repeat(16001) }])(
  'rejects malformed provider result %j',
  async value => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(value))
    )
    await expect(requestAppTurn('https://api.test', grant, 'river', turn())).rejects.toThrow('matrix_app_turn_invalid')
  }
)

it('rejects expired/cancelled turns before fetch and propagates in-flight cancellation', async () => {
  const request = vi.fn(async (_url: unknown, init: RequestInit) => {
    return new Promise<Response>((_resolve, reject) =>
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
    )
  })

  vi.stubGlobal('fetch', request)
  await expect(
    requestAppTurn('https://api.test', grant, 'river', { ...turn(), deadlineAt: Date.now() - 1 })
  ).rejects.toThrow()
  const abort = new AbortController()
  abort.abort()
  await expect(
    requestAppTurn('https://api.test', grant, 'river', { ...turn(), signal: abort.signal })
  ).rejects.toThrow()
  expect(request).not.toHaveBeenCalled()
  const active = new AbortController()
  const pending = requestAppTurn('https://api.test', grant, 'river', { ...turn(), signal: active.signal })
  active.abort()
  await expect(pending).rejects.toThrow()
  expect(request).toHaveBeenCalledOnce()
})

it('sends only main-chosen executor ID and domain bearer to a fixed nonredirecting endpoint', async () => {
  const request = vi.fn(async () => Response.json(credential()))
  vi.stubGlobal('fetch', request)
  await requestEnrollment('https://api.test', grant, executor, 'POST')
  expect(request).toHaveBeenCalledWith(
    'https://api.test/local-hermes',
    expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: 'Bearer domain-only', 'Content-Type': 'application/json' },
      body: JSON.stringify({ executorId: executor }),
      signal: expect.any(AbortSignal)
    })
  )
  request.mockResolvedValueOnce(new Response(null, { status: 204 }))
  expect(await requestEnrollment('https://api.test', grant, executor, 'DELETE')).toBeNull()
})

it('uses only an exact authenticated local capability read to opt into the host-device creation field', async () => {
  const request = vi.fn(async () => Response.json({ protocol: 2, hostDevice: true }))
  vi.stubGlobal('fetch', request)

  expect(await requestLocalEnrollmentCapabilities('https://api.test', grant)).toBe(true)
  expect(request).toHaveBeenCalledWith(
    'https://api.test/local-hermes/capabilities',
    expect.objectContaining({
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: 'Bearer domain-only' },
      signal: expect.any(AbortSignal)
    })
  )
  const capabilityRequest = (request.mock.calls as unknown as [string, RequestInit][])[0]![1]
  expect(capabilityRequest.body).toBeUndefined()

  for (const response of [
    new Response(null, { status: 404 }),
    Response.json({ protocol: 2 }),
    Response.json({ protocol: 2, hostDevice: true, extra: true }),
    Response.json({ protocol: 3, hostDevice: true }),
    new Response('not-json', { headers: { 'Content-Type': 'application/json' } })
  ]) {
    request.mockResolvedValueOnce(response)
    expect(await requestLocalEnrollmentCapabilities('https://api.test', grant)).toBe(false)
  }

  request.mockRejectedValueOnce(new TypeError('offline'))
  expect(await requestLocalEnrollmentCapabilities('https://api.test', grant)).toBe(false)
})

it('adds a printable native host device only to a local POST and rejects every other shape', async () => {
  const request = vi.fn(async () => Response.json(credential()))
  vi.stubGlobal('fetch', request)

  await requestEnrollment('https://api.test', grant, executor, 'POST', undefined, undefined, 'OWNER-DEVICE')
  expect(request).toHaveBeenCalledWith(
    'https://api.test/local-hermes',
    expect.objectContaining({ body: JSON.stringify({ executorId: executor, hostDevice: 'OWNER-DEVICE' }) })
  )

  for (const value of ['', 'has a space', 'x'.repeat(256), '\n', null, 7]) {
    expect(printableDeviceId(value)).toBe(false)
  }
  expect(printableDeviceId('!~OWNER-DEVICE')).toBe(true)

  await expect(requestEnrollment('https://api.test', grant, executor, 'POST', {
    slug: 'fixture-app', appVersionId, disclosureAccepted: true
  }, undefined, 'OWNER-DEVICE')).rejects.toThrow('matrix_enrollment_invalid')
  await expect(requestEnrollment('https://api.test', grant, executor, 'DELETE', undefined, undefined, 'OWNER-DEVICE'))
    .rejects.toThrow('matrix_enrollment_invalid')
  expect(request).toHaveBeenCalledOnce()
})

it('bounds reply bytes and distinguishes unauthorized from service failure', async () => {
  const request = vi.fn(async () => new Response('', { status: 401 }))
  vi.stubGlobal('fetch', request)
  await expect(requestEnrollment('https://api.test', grant, executor, 'POST')).rejects.toThrow(
    'matrix_enrollment_authentication'
  )
  request.mockResolvedValueOnce(new Response('', { status: 503 }))
  await expect(requestEnrollment('https://api.test', grant, executor, 'POST')).rejects.toThrow(
    'matrix_enrollment_unavailable'
  )
  request.mockResolvedValueOnce(Response.json({ content: 'x'.repeat(17000) }))
  await expect(requestEnrollment('https://api.test', grant, executor, 'POST')).rejects.toThrow('matrix_domain_invalid')
})

it('distinguishes refreshable authentication, redacted authority refusal and service failures', async () => {
  const request = vi.fn(async () => new Response('', { status: 401 }))
  vi.stubGlobal('fetch', request)
  await expect(requestLease('https://api.test', grant, { operation: 'acquire', executorId: executor })).rejects.toThrow(
    'matrix_lease_authentication'
  )

  request.mockResolvedValueOnce(new Response('', { status: 403 }))
  await expect(requestLease('https://api.test', grant, { operation: 'acquire', executorId: executor })).rejects.toThrow(
    'matrix_lease_denied'
  )

  request.mockResolvedValueOnce(new Response('', { status: 403 }))
  await expect(requestLease('https://api.test', grant, { operation: 'release', executorId: executor })).rejects.toThrow(
    'matrix_lease_denied'
  )

  request.mockResolvedValueOnce(new Response('', { status: 503 }))
  await expect(requestLease('https://api.test', grant, { operation: 'release', executorId: executor })).rejects.toThrow(
    'matrix_lease_unavailable'
  )

  expect(request).toHaveBeenCalledTimes(4)
})

it.each([{ held: false }, { held: false, reason: 'stale_term' }, { held: false, reason: 'upgrade_required' }])(
  'returns normal lease contention/term responses without claiming withdrawal: %j', async value => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(value)))
    await expect(requestLease('https://api.test', grant, { operation: 'acquire', executorId: executor })).resolves.toEqual(value)
  }
)

it('never exposes a provider denial body or mistakes transport failure for authority refusal', async () => {
  const request = vi.fn(async () => Response.json({ error: 'matrix_conflict', detail: 'private canary' }, { status: 403 }))
  vi.stubGlobal('fetch', request)
  const denied = await requestEnrollment('https://api.test', grant, executor, 'POST').catch((error: unknown) => error)
  expect(denied).toMatchObject({ message: 'matrix_enrollment_denied' })
  expect(String(denied)).not.toContain('private canary')
  expect(String(denied)).not.toContain('matrix_conflict')

  request.mockRejectedValueOnce(new TypeError('offline'))
  await expect(requestEnrollment('https://api.test', grant, executor, 'POST')).rejects.toThrow('offline')
})

it('forwards an opted-in v2 lease token only in the lease request body', async () => {
  const request = vi.fn(async () => Response.json({ held: true }))
  vi.stubGlobal('fetch', request)
  await requestLease('https://api.test', grant, {
    operation: 'release',
    executorId: executor,
    protocol: 2,
    leaseToken: '00000000-0000-4000-8000-127ad7633157'
  })
  expect(request).toHaveBeenCalledWith(
    'https://api.test/local-hermes/lease',
    expect.objectContaining({
      body: JSON.stringify({
        operation: 'release',
        executorId: executor,
        protocol: 2,
        leaseToken: '00000000-0000-4000-8000-127ad7633157'
      })
    })
  )
})

it('uses the fixed app route and explicit disclosure/version, while revoke needs neither approval nor disclosure', async () => {
  const request = vi.fn(async () => Response.json({}))
  vi.stubGlobal('fetch', request)
  const app = { slug: 'fixture-app', appVersionId, disclosureAccepted: true as const }
  await requestEnrollment('https://api.test', grant, executor, 'POST', app)
  expect(request).toHaveBeenCalledWith(
    'https://api.test/apps/fixture-app/proxy',
    expect.objectContaining({
      redirect: 'error',
      body: JSON.stringify({ executorId: executor, appVersionId, disclosureAccepted: true })
    })
  )
  request.mockResolvedValueOnce(new Response(null, { status: 204 }))
  await requestEnrollment('https://api.test', grant, executor, 'DELETE', { slug: app.slug })
  expect(request).toHaveBeenLastCalledWith(
    'https://api.test/apps/fixture-app/proxy',
    expect.objectContaining({
      body: JSON.stringify({ executorId: executor }),
      method: 'DELETE'
    })
  )
  await requestInvocation('https://api.test', grant, { operation: 'claim' }, app.slug)
  expect(request).toHaveBeenLastCalledWith(
    'https://api.test/apps/fixture-app/proxy/invocations',
    expect.objectContaining({
      body: JSON.stringify({ operation: 'claim' }),
      headers: { Authorization: 'Bearer domain-only', 'Content-Type': 'application/json' }
    })
  )

  for (const slug of ['', '../other', 'https://foreign.test', 'foo/bar', 'foo?bar', 'foo%2fbar']) {
    await expect(requestInvocation('https://api.test', grant, {}, slug)).rejects.toThrow('matrix_enrollment_invalid')
  }

  await expect(requestEnrollment('https://api.test', grant, executor, 'POST', { slug: app.slug })).rejects.toThrow(
    'matrix_enrollment_invalid'
  )
  expect(request).toHaveBeenCalledTimes(3)
})

it('binds proxy credentials to the approved app and projects no bearer to metadata', () => {
  const row = { ...credential(), appId, appVersionId, installationId, linkEpoch: 1, injected: 'not-retained' }
  const expected = { appId, appVersionId, ownerUserId: '@owner:test' }
  const parsed = appCredential(row, owner, executor, expected)
  expect(parsed).not.toHaveProperty('injected')
  expect(appEnrollmentIdentity(parsed)).toEqual({
    ...enrollmentIdentity(parsed),
    appId,
    appVersionId,
    installationId,
    linkEpoch: 1
  })
  expect(appEnrollmentIdentity(parsed)).not.toHaveProperty('accessToken')

  for (const patch of [
    { appId: executor },
    { appVersionId: executor },
    { installationId: 'bad' },
    { linkEpoch: 0 },
    { linkEpoch: 1.5 },
    { userId: '@owner:test' },
    { principal: executor }
  ]) {
    expect(() => appCredential({ ...row, ...patch }, owner, executor, expected)).toThrow('matrix_enrollment_invalid')
  }
})

it('projects credentials to a narrow main record and metadata to a token-free UI', () => {
  const result = agentCredential({ ...credential(), operatorToken: 'unrelated' }, owner, executor)
  expect(result).not.toHaveProperty('operatorToken')
  expect(enrollmentIdentity(result)).not.toHaveProperty('accessToken')

  for (const patch of [
    null,
    { subject: 'bob' },
    { issuer: 'https://other.test/' },
    { principal: executor },
    { executorId: 'other' },
    { agentPrincipal: owner.principal },
    { userId: 'bad' },
    { expiresAt: 1 },
    { expiresAt: Date.now() + 7200000 },
    { accessToken: '' },
    { deviceId: '' }
  ]) {
    expect(() => agentCredential(patch === null ? null : { ...credential(), ...patch }, owner, executor)).toThrow(
      'matrix_enrollment_invalid'
    )
  }
})

// Another of the person's agents (0146;  §2.2).
const agentPrincipal = '00000000-0000-4000-8000-8728d438aca6'

it('names another agent when enrolling its executor, never when revoking one', async () => {
  const request = vi.fn(async () => Response.json({ ok: true }))
  vi.stubGlobal('fetch', request)
  await requestEnrollment('https://api.test', grant, executor, 'POST', undefined, agentPrincipal)
  const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://api.test/local-hermes')
  expect(JSON.parse(init.body as string)).toEqual({ executorId: executor, agentPrincipal })

  request.mockResolvedValueOnce(new Response(null, { status: 204 }))
  await requestEnrollment('https://api.test', grant, executor, 'DELETE', undefined, agentPrincipal)
  expect(JSON.parse((request.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({
    executorId: executor
  })

  for (const [app, agent] of [
    [undefined, 'not-a-principal'],
    [{ slug: 'river', appVersionId, disclosureAccepted: true as const }, agentPrincipal]
  ] as const) {
    await expect(requestEnrollment('https://api.test', grant, executor, 'POST', app, agent)).rejects.toThrow(
      'matrix_enrollment_invalid'
    )
  }
})

it("accepts an agent's credential only for the agent it was issued for", () => {
  const row = { ...credential(), agentPrincipal }
  expect(agentCredential(row, owner, executor, { agentPrincipal }).agentPrincipal).toBe(agentPrincipal)
  expect(() => agentCredential(credential(), owner, executor, { agentPrincipal })).toThrow('matrix_enrollment_invalid')
})

// A per-owner bound (platform 0150) and a redacted authority refusal (launch checklist G1-13's
// follow-ups; stream RT, slice 2).
it('reports a 429 as a wait of its Retry-After, and a 403 as an authority refusal', async () => {
  const request = vi.fn(
    async () => new Response('{"error":"matrix_429"}', { status: 429, headers: { 'Retry-After': '120' } })
  )

  vi.stubGlobal('fetch', request)

  const limited = await requestEnrollment('https://api.test', grant, executor, 'POST').catch((error: unknown) => error)
  expect(limited).toBeInstanceOf(MatrixEnrollmentRateLimited)
  expect(limited).toMatchObject({ message: 'matrix_enrollment_rate_limited', retryAfterMs: 120_000 })

  request.mockResolvedValueOnce(new Response(null, { status: 429 }))
  await expect(requestEnrollment('https://api.test', grant, executor, 'DELETE')).rejects.toMatchObject({
    retryAfterMs: 60_000
  })

  request.mockResolvedValueOnce(new Response('{"error":"matrix_403"}', { status: 403 }))
  await expect(requestEnrollment('https://api.test', grant, executor, 'POST')).rejects.toThrow(
    'matrix_enrollment_denied'
  )
})

it.each([
  ['120', 120_000],
  [' 1 ', 1_000],
  ['0', 1_000],
  ['86400', 86_400_000],
  ['999999', 86_400_000],
  [null, 60_000],
  ['', 60_000],
  ['soon', 60_000],
  ['1.5', 60_000],
  ['Tue, 29 Sep 2026 10:05:00 GMT', 300_000],
  ['Tue, 29 Sep 2026 09:00:00 GMT', 1_000]
])('reads Retry-After %j as %i ms, between a second and a day', (header, ms) => {
  expect(matrixRetryAfterMs(header, Date.parse('2026-09-29T10:00:00Z'))).toBe(ms)
})

it('sees a renewed enrollment as the same one, and any other change as a different one', () => {
  const ready = { state: 'ready' as const, identity: enrollmentIdentity(credential()) }
  const renewed = { ...ready, identity: { ...ready.identity, expiresAt: ready.identity.expiresAt + 3_600_000 } }

  expect(sameMatrixEnrollment(renewed, ready)).toBe(true)
  expect(withoutMatrixExpiry(renewed.identity)).toEqual(withoutMatrixExpiry(ready.identity))
  expect(withoutMatrixExpiry(renewed.identity)).not.toHaveProperty('expiresAt')

  for (const change of [{ deviceId: 'OTHER' }, { userId: '@other:test' }, { executorId: agentPrincipal }]) {
    expect(sameMatrixEnrollment({ ...ready, identity: { ...ready.identity, ...change } }, ready)).toBe(false)
  }

  expect(sameMatrixEnrollment({ state: 'expired', identity: ready.identity }, ready)).toBe(false)
  expect(sameMatrixEnrollment({ state: 'pending', identity: null }, { state: 'pending', identity: null })).toBe(true)
})

 it.each([
  [429, { details: { reason: 'room_cap' } }, 'matrix_group_room_cap'],
  [429, { details: { reason: 'other', raw: 'private SQL' } }, 'matrix_invocation_unavailable'],
  [503, { details: { reason: 'room_cap' } }, 'matrix_invocation_unavailable']
] as const)('maps only the closed canonical room cap from HTTP %s', async (status, body, error) => {
  const request = vi.fn(async () => Response.json(body, { status }))
  vi.stubGlobal('fetch', request)
  await expect(requestInvocation('https://api.test', grant, { operation: 'claim' })).rejects.toThrow(error)
  expect(request).toHaveBeenCalledOnce()
})
