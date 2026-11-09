import { BrowserFailure, type BrowserConfig } from './record'

export interface DomainConfig {
  issuer: string
  matrixBaseUrl: string
  apiBaseUrl: string
  clientId: string
  redirectUri: string
}
export interface MatrixBinding { issuer: string; subject: string; userId: string; deviceId: string }
interface DomainBinding extends DomainConfig { version: 1; revision: number; matrix: MatrixBinding }
export interface DomainPending extends DomainBinding {
  kind: 'domain-login'
  phase: 'pending' | 'exchanging'
  verifier: string
  state: string
  nonce: string
  createdAt: number
}
export interface DomainSession extends DomainBinding {
  kind: 'domain-session'
  phase: 'active' | 'refreshing' | 'blocked' | 'signed_out'
  principal: string
  scope: 'openid'
  accessToken: string
  refreshToken: string
  expiresAt: number
}
export type DomainRecord = DomainPending | DomainSession
export interface DomainStore { read(): Promise<unknown>; replace(expected: number | null, record: DomainRecord): Promise<void> }
export interface DomainCredentials { accessToken: string; refreshToken: string; expiresAt: number; scope: 'openid'; subject?: string }
export interface DomainOwner { issuer: string; subject: string; principal: string }

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 16384
export function parseDomainConfig(value: unknown, matrix: BrowserConfig): DomainConfig | undefined {
  if (value === undefined) return undefined
  const v = value as { clientId?: unknown; apiBaseUrl?: unknown } | null
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(key => !['clientId', 'apiBaseUrl'].includes(key)) ||
      !text(v.clientId) || /[\r\n\0]/.test(v.clientId) || v.clientId.trim() !== v.clientId || v.clientId === matrix.clientId || !text(v.apiBaseUrl)) {
    throw new BrowserFailure('configuration_required')
  }
  try {
    const url = new URL(v.apiBaseUrl)
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((!local && url.protocol !== 'https:') || url.origin !== v.apiBaseUrl || url.username || url.password) throw Error()
  } catch { throw new BrowserFailure('configuration_required') }
  return { issuer: matrix.issuer, matrixBaseUrl: matrix.baseUrl, apiBaseUrl: v.apiBaseUrl,
    clientId: v.clientId, redirectUri: matrix.redirectUri }
}
export function sameMatrixBinding(a: MatrixBinding, b: MatrixBinding): boolean {
  return ['issuer', 'subject', 'userId', 'deviceId'].every(key => a[key as keyof MatrixBinding] === b[key as keyof MatrixBinding])
}
export function parseDomainRecord(value: unknown, config: DomainConfig, matrix: MatrixBinding): DomainRecord {
  const v = value as (Partial<Omit<DomainPending, 'kind' | 'phase'> & Omit<DomainSession, 'kind' | 'phase'>> & { kind?: string; phase?: string }) | null
  if (!v || v.version !== 1 || !Number.isSafeInteger(v.revision) || v.revision! < 1 ||
      !v.matrix || !sameMatrixBinding(v.matrix, matrix) || matrix.issuer !== config.issuer ||
      (['issuer', 'matrixBaseUrl', 'apiBaseUrl', 'clientId', 'redirectUri'] as const).some(key => v[key] !== config[key])) {
    throw new BrowserFailure('recovery_needed')
  }
  if (v.kind === 'domain-login' && ['pending', 'exchanging'].includes(v.phase!) && text(v.state) && text(v.nonce) &&
      text(v.verifier) && /^[A-Za-z0-9_-]{43,128}$/.test(v.verifier) && Number.isFinite(v.createdAt)) return structuredClone(v) as DomainPending
  if (v.kind === 'domain-session' && ['active', 'refreshing', 'blocked', 'signed_out'].includes(v.phase!) &&
      v.scope === 'openid' && text(v.principal) && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v.principal) &&
      text(v.accessToken) && text(v.refreshToken) && Number.isFinite(v.expiresAt) && v.expiresAt! > 0) return structuredClone(v) as DomainSession
  throw new BrowserFailure('recovery_needed')
}
