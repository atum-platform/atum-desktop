import type { MatrixConnectedModel, MatrixEffort, MatrixModelConnection } from './matrix-models'

/** Selected-agent provider presentation. Credentials are write-only; OAuth IDs
 * are opaque handles owned by one native page lifetime. */
export interface MatrixProviderRow {
  id: string
  name: string
  ready: boolean
  current: boolean
  models: string[]
  keyAvailable: boolean
  keySet: boolean
  /** How this row is connected, when known; a safe label helper, never a credential. */
  kind?: Exclude<MatrixModelConnection, 'local'>
  /** Explicit thinking levels each listed model advertises. Absent means none were advertised. */
  efforts?: Record<string, MatrixEffort[]>
  oauth: null | {
    flow: 'pkce' | 'device_code' | 'external'
    connected: boolean
    supported: boolean
    disconnectable: boolean
    /** Native account consent, never a renderer-supplied acceptance fact. */
    acknowledgment?: { policyVersion: string; acknowledgedAt: string }
  }
}

export interface MatrixProviderSnapshot {
  providers: MatrixProviderRow[]
  /** `reasoning`: whether Hermes's catalog says the model takes a thinking level (absent when
   * it does not know). */
  current: MatrixConnectedModel | null
}

export interface MatrixProviderEndpointInput {
  name: string
  baseUrl: string
  model: string
  apiKey: string
}

export type MatrixProviderConfirmation =
  | { kind: 'provider-key'; provider: string }
  | { kind: 'provider-select'; provider: string; model: string }
  | { kind: 'provider-endpoint'; name: string; baseUrl: string; model: string }
  | { kind: 'provider-oauth'; provider: string; planRisk?: { policyVersion: string; acknowledgedAt: string } }
  | { kind: 'provider-disconnect'; provider: string }
  | { kind: 'expensive-model'; provider: string; model: string; message: string }

export type MatrixProviderWriteResult = { status: 'applied'; staleAux?: boolean } | { status: 'cancelled' }

export interface MatrixProviderOAuthSession {
  status: 'pending'
  session: string
  provider: string
  flow: 'pkce' | 'device_code'
  userCode?: string
  expiresIn: number
  pollInterval: number
}

export interface MatrixProviderOAuthResult {
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'error' | 'cancelled'
}

export interface MatrixProviderSettingsClient {
  snapshot(): Promise<MatrixProviderSnapshot>
  saveKey(provider: string, value: string): Promise<MatrixProviderWriteResult>
  selectModel(provider: string, model: string): Promise<MatrixProviderWriteResult>
  addEndpoint(input: MatrixProviderEndpointInput): Promise<MatrixProviderWriteResult>
  startOAuth(provider: string): Promise<MatrixProviderOAuthSession | MatrixProviderWriteResult>
  pollOAuth(session: string): Promise<MatrixProviderOAuthResult>
  submitOAuth(session: string, code: string): Promise<MatrixProviderOAuthResult>
  cancelOAuth(session: string): Promise<MatrixProviderOAuthResult>
  disconnectOAuth(provider: string): Promise<MatrixProviderWriteResult>
}
