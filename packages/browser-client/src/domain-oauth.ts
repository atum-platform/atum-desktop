import * as oidc from 'openid-client'
import { BrowserFailure } from './record'
import type { DomainConfig, DomainCredentials, DomainOwner, DomainPending, DomainSession } from './domain-record'

export type LegacyDomainResource = 'me' | 'assistant' | 'agents' | 'wallet' | 'wallet-history'
export interface CloudTrialRequest { requestId: string; operation: 'accept'; offerVersion: number; disclosureVersion: number }
export interface CloudTrialDeclineRequest { requestId: string; operation: 'decline'; offerVersion: number }
export interface CloudFundingRequest { requestId: string; walletForCloud: boolean }
export interface CloudEnrollmentRequest { requestId: string; kind: 'cloud'; agentPrincipal: string; ownerDevice: string; disclosureVersion: number }
export interface CloudHandoffRequest { enrollmentId: string; ownerDevice: string }
export interface CloudStopRequest {
  requestId: string
  agentPrincipal: string
  target: { kind: 'turn'; roomId: string; eventId: string }
}

/** The fixed browser-adapter allowlist. Bodies live beside their path and method. */
export type DomainResource = LegacyDomainResource |
  { resource: 'cloud-status' } |
  { resource: 'cloud-disclosure' } |
  { resource: 'cloud-trial'; body: CloudTrialRequest | CloudTrialDeclineRequest } |
  { resource: 'cloud-funding'; body: CloudFundingRequest } |
  { resource: 'cloud-enrollments' } |
  { resource: 'cloud-enrollment'; body: CloudEnrollmentRequest } |
  { resource: 'cloud-revoke'; enrollmentId: string } |
  { resource: 'cloud-handoff'; body: CloudHandoffRequest } |
  { resource: 'cloud-stop'; body: CloudStopRequest } |
  { resource: 'drive-account' }
export interface DomainOAuth {
  prepare(config: DomainConfig): Promise<{ config: oidc.Configuration; verifier: string; state: string; nonce: string }>
  authorize(config: oidc.Configuration, pending: DomainPending): Promise<URL>
  exchange(pending: DomainPending, callback: URL): Promise<DomainCredentials>
  refresh(session: DomainSession): Promise<DomainCredentials>
  me(config: DomainConfig, token: string): Promise<DomainOwner>
  request(config: DomainConfig, token: string, resource: DomainResource): Promise<unknown>
  revoke(session: DomainSession): Promise<void>
}
export type DomainFailureReason = 'invalid' | 'consent_required' | 'bootstrap_required' | 'cohort_budget_exhausted' |
  'verification_required' | 'not_offered' | 'trial_used' | 'request_conflict' | 'capacity_unavailable' |
  'entitlement_required' | 'trial_expired' | 'trust_required' | 'enrollment_revoked' | 'agent_inactive' |
  'stopped' | 'stale_term' | 'not_preferred' | 'not_eligible' | 'budget_exhausted' | 'already_dispatched' |
  'wrong_state' | 'handoff_expired' | 'unavailable'
const failureReasons = new Set<DomainFailureReason>(['invalid', 'consent_required', 'bootstrap_required', 'cohort_budget_exhausted',
  'verification_required', 'not_offered', 'trial_used', 'request_conflict', 'capacity_unavailable', 'entitlement_required', 'trial_expired',
  'trust_required', 'enrollment_revoked', 'agent_inactive', 'stopped', 'stale_term', 'not_preferred', 'not_eligible', 'budget_exhausted',
  'already_dispatched', 'wrong_state', 'handoff_expired', 'unavailable'])
export class DomainHttpFailure extends BrowserFailure {
  constructor(readonly status: number, readonly reason: DomainFailureReason = 'unavailable') { super('operation_failed') }
}
async function errorReason(response: Response): Promise<DomainFailureReason> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > 1_048_576) { await response.body?.cancel(); return 'unavailable' }
  const text = await response.text()
  if (text.length > 1_048_576) return 'unavailable'
  try {
    const value = JSON.parse(text) as { details?: { reason?: unknown } }
    return typeof value?.details?.reason === 'string' && failureReasons.has(value.details.reason as DomainFailureReason)
      ? value.details.reason as DomainFailureReason : 'unavailable'
  } catch { return 'unavailable' }
}
async function json(url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(url, { ...init, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new DomainHttpFailure(response.status, await errorReason(response))
  const text = await response.text()
  if (text.length > 1_048_576) throw new BrowserFailure('operation_failed')
  try { return JSON.parse(text) } catch { throw new BrowserFailure('operation_failed') }
}
async function discovery(config: DomainConfig): Promise<oidc.Configuration> {
  const metadata = await json(`${config.matrixBaseUrl.replace(/\/$/, '')}/_matrix/client/v1/auth_metadata`) as { issuer?: unknown }
  if (metadata?.issuer !== config.issuer) throw new BrowserFailure('recovery_needed')
  const result = await oidc.discovery(new URL(config.issuer), config.clientId,
    { token_endpoint_auth_method: 'none', redirect_uris: [config.redirectUri], response_types: ['code'] }, oidc.None(), { timeout: 10 })
  const server = result.serverMetadata()
  if (server.issuer !== config.issuer || !server.code_challenge_methods_supported?.includes('S256') ||
      !server.grant_types_supported?.includes('authorization_code') || !server.grant_types_supported?.includes('refresh_token')) throw new BrowserFailure('recovery_needed')
  return result
}
function credentials(tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>, oldRefresh?: string): DomainCredentials {
  const remaining = tokens.expiresIn()
  const refreshToken = tokens.refresh_token ?? oldRefresh
  if (tokens.token_type.toLowerCase() !== 'bearer' || !tokens.access_token || !refreshToken ||
      remaining === undefined || !Number.isFinite(remaining) || remaining <= 0 ||
      (tokens.scope !== undefined && tokens.scope !== 'openid')) throw new BrowserFailure('recovery_needed')
  return { accessToken: tokens.access_token, refreshToken, expiresAt: Date.now() + remaining * 1000, scope: 'openid', subject: tokens.claims()?.sub }
}
interface RequestSpec { path: string; method: 'GET' | 'POST' | 'DELETE'; body?: object }
const legacyPaths: Record<LegacyDomainResource, string> = { me: '/me', assistant: '/assistant', agents: '/agents', wallet: '/wallet', 'wallet-history': '/wallet/history' }
function requestSpec(resource: DomainResource): RequestSpec | undefined {
  if (typeof resource === 'string') return Object.hasOwn(legacyPaths,resource)
    ? { path: legacyPaths[resource], method: resource === 'assistant' ? 'POST' : 'GET', ...(resource === 'assistant' ? { body: {} } : {}) } : undefined
  if (resource.resource === 'cloud-disclosure') return { path: '/cloud/disclosure', method: 'GET' }
  if (resource.resource === 'cloud-status') return { path: '/cloud/status', method: 'GET' }
  if (resource.resource === 'cloud-trial') return { path: '/cloud/trial', method: 'POST', body: resource.body }
  if (resource.resource === 'cloud-funding') return { path: '/cloud/funding', method: 'POST', body: resource.body }
  if (resource.resource === 'cloud-enrollments') return { path: '/cloud/enrollments', method: 'GET' }
  if (resource.resource === 'cloud-enrollment') return { path: '/cloud/enrollments', method: 'POST', body: resource.body }
  if (resource.resource === 'cloud-revoke' && validUuid(resource.enrollmentId)) return { path: `/cloud/enrollments/${resource.enrollmentId}`, method: 'DELETE' }
  if (resource.resource === 'cloud-handoff' && validUuid(resource.body.enrollmentId)) return { path: `/cloud/enrollments/${resource.body.enrollmentId}/handoff`, method: 'POST', body: { ownerDevice: resource.body.ownerDevice } }
  if (resource.resource === 'cloud-stop') return { path: '/cloud/stop', method: 'POST', body: resource.body }
  if (resource.resource === 'drive-account') return { path: '/drive/account', method: 'POST', body: {} }
  return undefined
}
function validUuid(value: string): boolean { return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value) }
export const domainOAuth: DomainOAuth = {
  async prepare(config) { return { config: await discovery(config), verifier: oidc.randomPKCECodeVerifier(), state: oidc.randomState(), nonce: oidc.randomNonce() } },
  async authorize(config, pending) {
    return oidc.buildAuthorizationUrl(config, { redirect_uri: pending.redirectUri, response_type: 'code', response_mode: 'query', scope: 'openid',
      state: pending.state, nonce: pending.nonce, code_challenge: await oidc.calculatePKCECodeChallenge(pending.verifier), code_challenge_method: 'S256' })
  },
  async exchange(pending, callback) {
    const tokens = await oidc.authorizationCodeGrant(await discovery(pending), callback,
      { pkceCodeVerifier: pending.verifier, expectedState: pending.state, expectedNonce: pending.nonce, idTokenExpected: true })
    const result = credentials(tokens)
    if (!result.subject || result.subject !== pending.matrix.subject) throw new BrowserFailure('recovery_needed')
    return result
  },
  async refresh(session) {
    const tokens = await oidc.refreshTokenGrant(await discovery(session), session.refreshToken)
    const claims = tokens.claims()
    if (claims && (claims.sub !== session.matrix.subject || claims.iss !== session.issuer)) throw new BrowserFailure('recovery_needed')
    return credentials(tokens, session.refreshToken)
  },
  async me(config, token) {
    const value = await this.request(config, token, 'me') as Partial<DomainOwner> | null
    if (!value || value.issuer !== config.issuer || typeof value.subject !== 'string' || !value.subject || value.subject.length > 1024 ||
        typeof value.principal !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.principal)) throw new BrowserFailure('recovery_needed')
    return { issuer: value.issuer, subject: value.subject, principal: value.principal }
  },
  async request(config, token, resource) {
    const spec = requestSpec(resource)
    if (!spec || !token) throw new BrowserFailure('operation_failed')
    return json(`${config.apiBaseUrl}/api/matrix/web/v1${spec.path}`, { method: spec.method,
      headers: { Authorization: `Bearer ${token}`, ...(spec.body ? { 'Content-Type': 'application/json' } : {}) },
      ...(spec.body ? { body: JSON.stringify(spec.body) } : {}) })
  },
  async revoke(session) { await oidc.tokenRevocation(await discovery(session), session.refreshToken, { token_type_hint: 'refresh_token' }) }
}
