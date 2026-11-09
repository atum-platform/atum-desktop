export const CALLBACK = 'http://localhost:4317/callback'
export const DEVICE_LOCK = 'atum.browser.first-device.v1'

export class BrowserFailure extends Error {
  constructor(readonly code: 'configuration_required' | 'secure_context_required' | 'device_busy' | 'recovery_needed' | 'signed_out' | 'operation_failed') {
    super(code)
  }
}

export interface BrowserConfig {
  issuer: string
  baseUrl: string
  clientId: string
  redirectUri: string
}

interface Binding extends BrowserConfig {
  version: 1
  revision: number
  deviceId: string
  storageKey: string
}

export interface PendingLogin extends Binding {
  kind: 'login'
  phase: 'pending' | 'exchanging'
  verifier: string
  state: string
  nonce: string
  createdAt: number
}

export interface DeviceSession extends Binding {
  kind: 'session'
  phase: 'establishing' | 'active' | 'refreshing' | 'blocked' | 'signed_out'
  userId: string
  subject: string
  scope: string
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export type DeviceRecord = PendingLogin | DeviceSession

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16384
}

function safeUrl(value: unknown, httpsOnly: boolean): value is string {
  if (!text(value)) return false
  try {
    const url = new URL(value)
    return !url.username && !url.password && !url.search && !url.hash &&
      (url.protocol === 'https:' || (!httpsOnly && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  } catch { return false }
}

export function parseConfig(value: unknown, expectedOrigin = new URL(CALLBACK).origin): BrowserConfig {
  const v = value as Partial<BrowserConfig> | null
  const redirectUri = `${expectedOrigin}/callback`
  if (!safeUrl(expectedOrigin, false) || new URL(expectedOrigin).origin !== expectedOrigin ||
      !v || !safeUrl(v.issuer, true) || !safeUrl(v.baseUrl, false) || !text(v.clientId) ||
      /[\r\n\0]/.test(v.clientId) || v.redirectUri !== redirectUri) {
    throw new BrowserFailure('configuration_required')
  }
  return { issuer: v.issuer, baseUrl: v.baseUrl, clientId: v.clientId, redirectUri }
}

export function matrixScope(deviceId: string): string {
  // Match canonical electron/matrix/account.ts and the pinned MAS proof lane.
  // Do not silently switch namespaces or negotiate a different device on failure.
  return `openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:${deviceId}`
}

export function requireScope(scope: unknown, deviceId: string): string {
  if (!text(scope)) throw new BrowserFailure('recovery_needed')
  const actual = new Set(scope.split(' '))
  const expected = matrixScope(deviceId).split(' ')
  if (actual.size !== expected.length || expected.some(s => !actual.has(s))) throw new BrowserFailure('recovery_needed')
  return scope
}

export function parseRecord(value: unknown, config: BrowserConfig): DeviceRecord {
  const v = value as (Partial<Binding & Omit<PendingLogin, 'kind' | 'phase'> & Omit<DeviceSession, 'kind' | 'phase'>> & { kind?: string; phase?: string }) | null
  if (!v || v.version !== 1 || !Number.isSafeInteger(v.revision) || v.revision! < 1 ||
      !text(v.deviceId) || !/^[A-Za-z0-9_-]{10,128}$/.test(v.deviceId) ||
      !text(v.storageKey) || !/^[A-Za-z0-9+/]{43}=$/.test(v.storageKey) ||
      (['issuer', 'baseUrl', 'clientId', 'redirectUri'] as const).some(k => v[k] !== config[k])) {
    throw new BrowserFailure('recovery_needed')
  }
  if (v.kind === 'login' && ['pending', 'exchanging'].includes(v.phase!) &&
      text(v.verifier) && /^[A-Za-z0-9_-]{43,128}$/.test(v.verifier) && text(v.state) && text(v.nonce) && Number.isFinite(v.createdAt)) {
    return structuredClone(v) as PendingLogin
  }
  if (v.kind === 'session' && ['establishing', 'active', 'refreshing', 'blocked', 'signed_out'].includes(v.phase!) &&
      text(v.userId) && /^@[^:]+:.+$/.test(v.userId) && text(v.subject) && text(v.accessToken) && text(v.refreshToken) &&
      Number.isFinite(v.expiresAt) && v.expiresAt! > 0) {
    requireScope(v.scope, v.deviceId)
    return structuredClone(v) as DeviceSession
  }
  throw new BrowserFailure('recovery_needed')
}

export function sdkConfiguration(session: DeviceSession) {
  return { baseUrl: session.baseUrl, userId: session.userId, deviceId: session.deviceId,
    storageKey: session.storageKey, accessToken: session.accessToken, refreshToken: session.refreshToken }
}
