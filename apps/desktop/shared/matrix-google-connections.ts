/**
 * Matrix-facing Google connection metadata. This deliberately describes
 * safe account status and legacy local sources only; credentials, provider
 * references and filesystem locations never cross into the renderer.
 */
import type { DesktopLocale } from './desktop-locale'

export type MatrixGoogleConnectionKind = 'email' | 'calendar' | 'drive'
export type MatrixGoogleConnectionState = 'connected' | 'reconnect'
export type MatrixGoogleConnectionError =
  | 'unavailable'
  | 'busy'
  | 'fence'
  | 'cancelled'
  | 'denied'
  | 'reconnect'
  | 'network'
  | 'storage'
  | 'invalid_input'

export interface MatrixGoogleConnectionSource {
  /** Main-generated opaque source id, suitable only for this adapter's preferences. */
  id: string
  /** Main-generated opaque grant-group id, suitable only for disconnect. */
  groupId: string
  provider: 'google'
  kind: MatrixGoogleConnectionKind
  label: string
  primary?: boolean
  state: MatrixGoogleConnectionState
  enabled: boolean
  writable?: boolean
}

export interface MatrixGoogleConnectionStatus {
  /** Account authority, independent of this Mac’s legacy vault and selected assistant. */
  accountState?: 'ready' | 'disconnected' | 'attention'
  /** The Google account Atum is connected to (shown as "Connected as …"). Absent for a connection made before the account was pinned. */
  accountEmail?: string
  /** Set for a few minutes after a different Google account tried to connect and was refused. */
  accountNotice?: 'google_account_mismatch'
  sources: MatrixGoogleConnectionSource[]
  available: boolean
  degraded?: boolean
}

export type MatrixGoogleConnectionResult =
  | { status: MatrixGoogleConnectionStatus; error?: undefined }
  | { status: null; error: MatrixGoogleConnectionError }

/** `google` is the one consent for Gmail, Calendar and Drive (the person may untick any of
 * them); the separate grants remain for adding a service to an older connection. */
export type MatrixGoogleConnectionGrant = 'google' | 'email-calendar' | 'drive'

/** Native uses this presentation-only tag to attach the first-run value job after the
 * provider, not the renderer, has confirmed a real connection. It carries no account ID. */
export interface MatrixGoogleConnectionContext {
  origin: 'first_run'
  locale: DesktopLocale
}

export const MATRIX_GOOGLE_CONNECTION_IPC = 'matrix:google-connections:request'

export interface MatrixGoogleConnectionBridge {
  status(context?: MatrixGoogleConnectionContext): Promise<MatrixGoogleConnectionResult>
  connect(grant: MatrixGoogleConnectionGrant, context?: MatrixGoogleConnectionContext): Promise<MatrixGoogleConnectionResult>
  disconnect(groupId: string): Promise<MatrixGoogleConnectionResult>
  setSourcePreferences(preferences: ReadonlyArray<{ id: string; enabled: boolean }>): Promise<MatrixGoogleConnectionResult>
}
