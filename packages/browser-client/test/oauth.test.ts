import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { browserOAuth } from '../src/oauth'
import { CALLBACK, matrixScope, type BrowserConfig, type PendingLogin } from '../src/record'

const config: BrowserConfig = { issuer: 'https://mas.localhost/', baseUrl: 'https://matrix.localhost', clientId: 'disposable-public-client', redirectUri: CALLBACK }
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' }

// Signed fixture ID tokens exercise the real library's validation, never a network
// compatibility server or a claim of real MAS login acceptance.
function token(nonce: string, issuer = config.issuer, subject = 'disposable-subject') {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-key' })).toString('base64url')
  const claims = Buffer.from(JSON.stringify({ iss: issuer, sub: subject, aud: config.clientId, nonce,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')
  const input = `${header}.${claims}`
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`
}

function network(nonce: string, options: { metadataIssuer?: string; tokenIssuer?: string; scope?: string } = {}) {
  const metadata = { issuer: config.issuer, authorization_endpoint: `${config.issuer}authorize`, token_endpoint: `${config.issuer}token`,
    jwks_uri: `${config.issuer}jwks`, revocation_endpoint: `${config.issuer}revoke`, response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
    id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['none'] }
  const requests: Array<{ url: string; options?: RequestInit }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    requests.push({ url, options: init })
    let body: unknown
    if (url.endsWith('/auth_metadata')) body = { issuer: options.metadataIssuer ?? config.issuer }
    else if (url.endsWith('/.well-known/openid-configuration')) body = metadata
    else if (url.endsWith('/jwks')) body = { keys: [publicJwk] }
    else if (url.endsWith('/token')) body = { access_token: 'fixture-access', refresh_token: 'fixture-rotated-refresh', token_type: 'Bearer',
      expires_in: 300, scope: options.scope ?? matrixScope('DEVICE_123456'), id_token: token(nonce, options.tokenIssuer) }
    else if (url.endsWith('/account/whoami')) body = { user_id: '@disposable:localhost', device_id: 'DEVICE_123456' }
    else throw new Error('Unexpected fixture request')
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  return requests
}

async function pending(): Promise<{ login: PendingLogin; authorization: URL }> {
  const prepared = await browserOAuth.prepare(config)
  const login: PendingLogin = { ...config, version: 1, revision: 1, kind: 'login', phase: 'pending', createdAt: Date.now(),
    deviceId: 'DEVICE_123456', storageKey: btoa('x'.repeat(32)), verifier: prepared.verifier, nonce: prepared.nonce, state: prepared.state }
  return { login, authorization: await browserOAuth.authorize(prepared.config, login) }
}

afterEach(() => vi.unstubAllGlobals())

describe('real openid-client source contract with fetch fixtures', () => {
  it('requests code + S256 + state + nonce for the fixed public-client callback', async () => {
    network('unused')
    const { authorization, login } = await pending()
    expect(authorization.origin).toBe(new URL(config.issuer).origin)
    expect(authorization.searchParams.get('response_type')).toBe('code')
    expect(authorization.searchParams.get('redirect_uri')).toBe(CALLBACK)
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('state')).toBe(login.state)
    expect(authorization.searchParams.get('nonce')).toBe(login.nonce)
    expect(authorization.searchParams.get('scope')).toBe(`openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:${login.deviceId}`)
    expect(authorization.searchParams.has('client_secret')).toBe(false)
    expect(authorization.searchParams.has('code_verifier')).toBe(false)
  })

  it('redeems with the real library and uses bearer whoami over headers only', async () => {
    network('unused')
    const { login } = await pending()
    const requests = network(login.nonce)
    const result = await browserOAuth.exchange(login, new URL(`${CALLBACK}?code=fixture-code&state=${login.state}`))
    expect(result).toMatchObject({ accessToken: 'fixture-access', refreshToken: 'fixture-rotated-refresh', subject: 'disposable-subject' })
    const grant = requests.find(r => r.url.endsWith('/token'))!
    const body = new URLSearchParams(grant.options!.body as URLSearchParams)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code_verifier')).toBe(login.verifier)
    expect(body.get('redirect_uri')).toBe(CALLBACK)
    expect(body.get('client_id')).toBe(config.clientId)
    expect(body.has('client_secret')).toBe(false)
    await browserOAuth.whoami(config, result.accessToken)
    const whoami = requests.find(r => r.url.endsWith('/account/whoami'))!
    expect(new Headers(whoami.options!.headers).get('Authorization')).toBe('Bearer fixture-access')
    expect(whoami.url).not.toContain('fixture-access')
  })

  it('rejects wrong state before sending the authorization code', async () => {
    const requests = network('unused')
    const { login } = await pending()
    await expect(browserOAuth.exchange(login, new URL(`${CALLBACK}?code=c&state=wrong`))).rejects.toBeDefined()
    expect(requests.some(r => r.url.endsWith('/token'))).toBe(false)
  })

  it('rejects a wrong nonce through openid-client ID-token validation', async () => {
    network('wrong-nonce')
    const { login } = await pending()
    await expect(browserOAuth.exchange(login, new URL(`${CALLBACK}?code=c&state=${login.state}`))).rejects.toBeDefined()
  })

  it('rejects a wrong ID-token issuer through openid-client', async () => {
    network('unused')
    const { login } = await pending()
    network(login.nonce, { tokenIssuer: 'https://other.localhost/' })
    await expect(browserOAuth.exchange(login, new URL(`${CALLBACK}?code=c&state=${login.state}`))).rejects.toBeDefined()
  })

  it('rejects a homeserver issuer mismatch before OIDC discovery or grants', async () => {
    const requests = network('unused', { metadataIssuer: 'https://other.localhost/' })
    await expect(browserOAuth.prepare(config)).rejects.toThrow('recovery_needed')
    expect(requests).toHaveLength(1)
  })

  it('rejects a token scope for a different Matrix device', async () => {
    network('unused')
    const { login } = await pending()
    network(login.nonce, { scope: matrixScope('OTHER_DEVICE') })
    await expect(browserOAuth.exchange(login, new URL(`${CALLBACK}?code=c&state=${login.state}`))).rejects.toThrow('recovery_needed')
  })
})
