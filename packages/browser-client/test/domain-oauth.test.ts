import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DomainHttpFailure, domainOAuth, type DomainResource } from '../src/domain-oauth'
import type { DomainConfig, DomainPending, DomainSession, MatrixBinding } from '../src/domain-record'
import { CALLBACK } from '../src/record'

const matrix: MatrixBinding = { issuer: 'https://mas.localhost/', subject: 'matrix-subject', userId: '@human:localhost', deviceId: 'MATRIX_DEVICE_123456' }
const config: DomainConfig = { issuer: matrix.issuer, matrixBaseUrl: 'https://matrix.localhost', apiBaseUrl: 'https://api.localhost',
  clientId: 'domain-public-client', redirectUri: CALLBACK }
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' }

interface FixtureOptions {
  metadataIssuer?: string
  tokenIssuer?: string
  tokenAudience?: string
  tokenSubject?: string
  scope?: string
  refreshToken?: string | undefined
  refreshIdToken?: boolean
  owner?: unknown
}

function idToken(nonce: string, options: FixtureOptions = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-key' })).toString('base64url')
  const claims = Buffer.from(JSON.stringify({ iss: options.tokenIssuer ?? config.issuer, sub: options.tokenSubject ?? matrix.subject,
    aud: options.tokenAudience ?? config.clientId, nonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')
  const input = `${header}.${claims}`
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`
}

function network(nonce: string, options: FixtureOptions = {}) {
  const metadata = { issuer: config.issuer, authorization_endpoint: `${config.issuer}authorize`, token_endpoint: `${config.issuer}token`,
    jwks_uri: `${config.issuer}jwks`, revocation_endpoint: `${config.issuer}revoke`, response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
    id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['none'] }
  const requests: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    requests.push({ url, init })
    if (url.endsWith('/auth_metadata')) return Response.json({ issuer: options.metadataIssuer ?? config.issuer })
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json(metadata)
    if (url.endsWith('/jwks')) return Response.json({ keys: [publicJwk] })
    if (url.endsWith('/token')) {
      const grant = new URLSearchParams(init?.body as URLSearchParams).get('grant_type')
      return Response.json({ access_token: grant === 'refresh_token' ? 'rotated-domain-access' : 'domain-access',
        ...(grant === 'refresh_token' ? { ...(options.refreshToken === undefined ? {} : { refresh_token: options.refreshToken }),
          ...(options.refreshIdToken ? { id_token: idToken(nonce, options) } : {}) }
          : { refresh_token: options.refreshToken ?? 'rotated-domain-refresh', id_token: idToken(nonce, options) }),
        token_type: 'Bearer', expires_in: 300, scope: options.scope ?? 'openid' })
    }
    if (url.endsWith('/revoke')) return new Response(null, { status: 200 })
    if (url.startsWith(`${config.apiBaseUrl}/api/matrix/web/v1/`)) return Response.json(options.owner ?? {
      issuer: config.issuer, subject: matrix.subject, principal: '00000000-0000-4000-8000-fffeb1027f6c' })
    throw new Error(`Unexpected fixture request: ${url}`)
  }))
  return requests
}

async function pending(): Promise<{ pending: DomainPending; authorization: URL }> {
  const prepared = await domainOAuth.prepare(config)
  const login: DomainPending = { ...config, matrix, version: 1, revision: 1, kind: 'domain-login', phase: 'pending',
    verifier: prepared.verifier, state: prepared.state, nonce: prepared.nonce, createdAt: Date.now() }
  return { pending: login, authorization: await domainOAuth.authorize(prepared.config, login) }
}

function session(): DomainSession {
  return { ...config, matrix, version: 1, revision: 1, kind: 'domain-session', phase: 'active', scope: 'openid',
    principal: '00000000-0000-4000-8000-fffeb1027f6c', accessToken: 'domain-access', refreshToken: 'existing-domain-refresh', expiresAt: Date.now() + 300_000 }
}

afterEach(() => vi.unstubAllGlobals())

describe('browser-domain public-client OAuth', () => {
  it('uses a distinct public client with only openid, PKCE, state, and nonce', async () => {
    network('unused')
    const { authorization, pending: login } = await pending()
    expect(authorization.searchParams.get('client_id')).toBe(config.clientId)
    expect(authorization.searchParams.get('redirect_uri')).toBe(CALLBACK)
    expect(authorization.searchParams.get('response_type')).toBe('code')
    expect(authorization.searchParams.get('scope')).toBe('openid')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('state')).toBe(login.state)
    expect(authorization.searchParams.get('nonce')).toBe(login.nonce)
    expect(authorization.searchParams.has('client_secret')).toBe(false)
    expect(authorization.searchParams.has('code_verifier')).toBe(false)
  })

  it('redeems through openid-client, binds the Matrix subject, and sends the bearer only to the fixed me endpoint', async () => {
    network('unused')
    const { pending: login } = await pending()
    const requests = network(login.nonce)
    const result = await domainOAuth.exchange(login, new URL(`${CALLBACK}?code=domain-code&state=${login.state}`))
    expect(result).toMatchObject({ accessToken: 'domain-access', refreshToken: 'rotated-domain-refresh', scope: 'openid', subject: matrix.subject })
    const grant = requests.find(request => request.url.endsWith('/token'))!
    const body = new URLSearchParams(grant.init!.body as URLSearchParams)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('client_id')).toBe(config.clientId)
    expect(body.get('redirect_uri')).toBe(CALLBACK)
    expect(body.get('code_verifier')).toBe(login.verifier)
    expect(body.has('client_secret')).toBe(false)

    await domainOAuth.me(config, result.accessToken)
    const me = requests.find(request => request.url.endsWith('/api/matrix/web/v1/me'))!
    expect(me.url).not.toContain(result.accessToken)
    expect(me.init).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error' })
    expect(new Headers(me.init!.headers).get('Authorization')).toBe(`Bearer ${result.accessToken}`)
  })

  it('fails closed before or during redemption for callback, signed identity, and scope mismatches', async () => {
    const wrongState = network('unused')
    const { pending: login } = await pending()
    await expect(domainOAuth.exchange(login, new URL(`${CALLBACK}?code=c&state=wrong`))).rejects.toBeDefined()
    expect(wrongState.some(request => request.url.endsWith('/token'))).toBe(false)

    for (const options of [
      { tokenSubject: 'other-subject' }, { tokenIssuer: 'https://other.localhost/' },
      { tokenAudience: 'matrix-public-client' }, { scope: 'openid urn:matrix:org.matrix.msc2967.client:api:*' },
    ]) {
      network('wrong-nonce', options)
      const created = await pending()
      network(created.pending.nonce, options)
      await expect(domainOAuth.exchange(created.pending, new URL(`${CALLBACK}?code=c&state=${created.pending.state}`))).rejects.toBeDefined()
    }
  })

  it('retains the old refresh credential when a valid refresh has no ID token', async () => {
    const requests = network('unused')
    const result = await domainOAuth.refresh(session())
    expect(result).toMatchObject({ accessToken: 'rotated-domain-access', refreshToken: 'existing-domain-refresh', scope: 'openid', subject: undefined })
    const refresh = requests.find(request => request.url.endsWith('/token'))!
    const body = new URLSearchParams(refresh.init!.body as URLSearchParams)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('existing-domain-refresh')
    expect(body.get('client_id')).toBe(config.clientId)
    expect(body.has('client_secret')).toBe(false)
  })

  it('uses only the fixed browser-domain resources with their fixed paths, methods, and bodies', async () => {
    const requests = network('unused')
    const id = '00000000-0000-4000-8000-fffeb1027f6c'
    const resources: Array<[DomainResource, string, string, string | undefined]> = [
      ['me', '/me', 'GET', undefined], ['assistant', '/assistant', 'POST', '{}'], ['agents', '/agents', 'GET', undefined],
      ['wallet', '/wallet', 'GET', undefined], ['wallet-history', '/wallet/history', 'GET', undefined],
      [{ resource: 'cloud-status' }, '/cloud/status', 'GET', undefined],
      [{ resource: 'cloud-trial', body: { requestId: id, operation: 'accept', offerVersion: 1, disclosureVersion: 2 } }, '/cloud/trial', 'POST', JSON.stringify({ requestId: id, operation: 'accept', offerVersion: 1, disclosureVersion: 2 })],
      [{ resource: 'cloud-funding', body: { requestId: id, walletForCloud: true } }, '/cloud/funding', 'POST', JSON.stringify({ requestId: id, walletForCloud: true })],
      [{ resource: 'cloud-enrollments' }, '/cloud/enrollments', 'GET', undefined],
      [{ resource: 'cloud-enrollment', body: { requestId: id, kind: 'cloud', agentPrincipal: id, ownerDevice: 'MATRIX_DEVICE_123456', disclosureVersion: 2 } }, '/cloud/enrollments', 'POST', JSON.stringify({ requestId: id, kind: 'cloud', agentPrincipal: id, ownerDevice: 'MATRIX_DEVICE_123456', disclosureVersion: 2 })],
      [{ resource: 'cloud-revoke', enrollmentId: id }, `/cloud/enrollments/${id}`, 'DELETE', undefined],
      [{ resource: 'cloud-handoff', body: { enrollmentId: id, ownerDevice: 'MATRIX_DEVICE_123456' } }, `/cloud/enrollments/${id}/handoff`, 'POST', JSON.stringify({ ownerDevice: 'MATRIX_DEVICE_123456' })],
      [{ resource: 'cloud-stop', body: { requestId: id, agentPrincipal: id, target: { kind: 'turn', roomId: '!room:test', eventId: '$event' } } }, '/cloud/stop', 'POST', JSON.stringify({ requestId: id, agentPrincipal: id, target: { kind: 'turn', roomId: '!room:test', eventId: '$event' } })],
      [{ resource: 'drive-account' }, '/drive/account', 'POST', '{}'],
    ]
    for (const [resource] of resources) await domainOAuth.request(config, 'domain-access', resource)
    const api = requests.filter(request => request.url.startsWith(`${config.apiBaseUrl}/api/matrix/web/v1/`))
    expect(api.map(request => new URL(request.url).pathname)).toEqual(resources.map(([, path]) => `/api/matrix/web/v1${path}`))
    for (const request of api) {
      expect(request.url).not.toContain('domain-access')
      expect(request.init).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error' })
      expect(new Headers(request.init!.headers).get('Authorization')).toBe('Bearer domain-access')
    }
    for (const [index, [, , method, body]] of resources.entries()) {
      const request = api[index]
      expect(request.init?.method).toBe(method)
      expect(request.init?.body).toBe(body)
      expect(new Headers(request.init?.headers).has('Content-Type')).toBe(body !== undefined)
    }
  })

  it('preserves only documented server refusal reasons', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'matrix_403', details: { reason: 'trial_expired' } }, { status: 403 })))
    await expect(domainOAuth.request(config, 'domain-access', { resource: 'cloud-status' })).rejects.toMatchObject({ status: 403, reason: 'trial_expired' } satisfies Partial<DomainHttpFailure>)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'matrix_500', details: { reason: 'database detail must not leak' } }, { status: 500 })))
    await expect(domainOAuth.request(config, 'domain-access', { resource: 'cloud-status' })).rejects.toMatchObject({ status: 500, reason: 'unavailable' } satisfies Partial<DomainHttpFailure>)
  })

  it('uses public-client revocation without placing the refresh credential in the request URL', async () => {
    const requests = network('unused')
    await domainOAuth.revoke(session())
    const revoke = requests.find(request => request.url.endsWith('/revoke'))!
    expect(revoke.url).not.toContain('existing-domain-refresh')
    expect(revoke.init?.method).toBe('POST')
    const body = new URLSearchParams(revoke.init!.body as URLSearchParams)
    expect(body.get('token')).toBe('existing-domain-refresh')
    expect(body.get('token_type_hint')).toBe('refresh_token')
    expect(body.get('client_id')).toBe(config.clientId)
    expect(body.has('client_secret')).toBe(false)
  })
})
