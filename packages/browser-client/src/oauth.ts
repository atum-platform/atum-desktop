import * as oidc from 'openid-client'

import { BrowserFailure, matrixScope, requireScope, type BrowserConfig, type DeviceSession, type PendingLogin } from './record'

export interface Credentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope: string
  subject?: string
}

export interface BrowserOAuth {
  prepare(config: BrowserConfig): Promise<{ config: oidc.Configuration; verifier: string; state: string; nonce: string }>
  authorize(config: oidc.Configuration, pending: PendingLogin): Promise<URL>
  exchange(pending: PendingLogin, callback: URL): Promise<Credentials>
  refresh(session: DeviceSession): Promise<Credentials>
  whoami(config: BrowserConfig, token: string): Promise<{ userId: string; deviceId: string }>
  revoke(session: DeviceSession): Promise<void>
}

async function json(url: string, token?: string): Promise<unknown> {
  const response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new BrowserFailure('operation_failed')
  return response.json()
}

async function discovery(config: BrowserConfig): Promise<oidc.Configuration> {
  // Bind the configured homeserver to its advertised issuer before sending any credential.
  const metadata = await json(`${config.baseUrl.replace(/\/$/, '')}/_matrix/client/v1/auth_metadata`) as { issuer?: unknown }
  if (metadata?.issuer !== config.issuer) throw new BrowserFailure('recovery_needed')
  const result = await oidc.discovery(new URL(config.issuer), config.clientId,
    { token_endpoint_auth_method: 'none', redirect_uris: [config.redirectUri], response_types: ['code'] }, oidc.None(), { timeout: 10 })
  const server = result.serverMetadata()
  if (server.issuer !== config.issuer || !server.code_challenge_methods_supported?.includes('S256') ||
      !server.grant_types_supported?.includes('authorization_code') || !server.grant_types_supported?.includes('refresh_token')) {
    throw new BrowserFailure('recovery_needed')
  }
  // No insecure-provider switch, implicit flow, secret, or alternate issuer.
  return result
}

function credentials(tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>, deviceId: string, scope: string, oldRefresh?: string): Credentials {
  const remaining = tokens.expiresIn()
  const refreshToken = tokens.refresh_token ?? oldRefresh
  if (tokens.token_type.toLowerCase() !== 'bearer' || !tokens.access_token || !refreshToken ||
      remaining === undefined || !Number.isFinite(remaining) || remaining <= 0) throw new BrowserFailure('recovery_needed')
  return { accessToken: tokens.access_token, refreshToken, expiresAt: Date.now() + remaining * 1000,
    scope: requireScope(tokens.scope ?? scope, deviceId), subject: tokens.claims()?.sub }
}

export const browserOAuth: BrowserOAuth = {
  async prepare(config) {
    return { config: await discovery(config), verifier: oidc.randomPKCECodeVerifier(), state: oidc.randomState(), nonce: oidc.randomNonce() }
  },
  async authorize(config, pending) {
    return oidc.buildAuthorizationUrl(config, { redirect_uri: pending.redirectUri, response_type: 'code', response_mode: 'query',
      scope: matrixScope(pending.deviceId), state: pending.state, nonce: pending.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(pending.verifier), code_challenge_method: 'S256' })
  },
  async exchange(pending, callback) {
    const config = await discovery(pending)
    const tokens = await oidc.authorizationCodeGrant(config, callback,
      { pkceCodeVerifier: pending.verifier, expectedState: pending.state, expectedNonce: pending.nonce, idTokenExpected: true })
    const result = credentials(tokens, pending.deviceId, matrixScope(pending.deviceId))
    if (!result.subject) throw new BrowserFailure('recovery_needed')
    return result
  },
  async refresh(session) {
    const config = await discovery(session)
    const tokens = await oidc.refreshTokenGrant(config, session.refreshToken)
    const claims = tokens.claims()
    if (claims && (claims.sub !== session.subject || claims.iss !== session.issuer)) throw new BrowserFailure('recovery_needed')
    return credentials(tokens, session.deviceId, session.scope, session.refreshToken)
  },
  async whoami(config, token) {
    const value = await json(`${config.baseUrl.replace(/\/$/, '')}/_matrix/client/v3/account/whoami`, token) as { user_id?: unknown; device_id?: unknown; is_guest?: unknown }
    if (typeof value?.user_id !== 'string' || !/^@[^:]+:.+$/.test(value.user_id) || typeof value.device_id !== 'string' || value.is_guest === true) {
      throw new BrowserFailure('recovery_needed')
    }
    return { userId: value.user_id, deviceId: value.device_id }
  },
  async revoke(session) {
    await oidc.tokenRevocation(await discovery(session), session.refreshToken, { token_type_hint: 'refresh_token' })
  }
}
