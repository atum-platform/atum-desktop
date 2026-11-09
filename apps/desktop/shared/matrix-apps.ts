/**
 * Public Matrix app-link state. This crosses the main/renderer bridge, so it
 * deliberately excludes the loopback URI, initiation id, and return code.
 */
export interface MatrixAppConnection {
  state: 'never_linked' | 'linked' | 'unlinked'
  connectionRequired: boolean
  available: boolean
  readiness: 'not_linked' | 'pending' | 'ready' | 'unavailable'
  cleanup?: 'pending' | 'complete' | 'unconfirmed'
}

/** A per-app, display-only view of the native linking lifetime. */
export interface MatrixAppConnectionState {
  phase: 'idle' | 'opening' | 'waiting' | 'confirm' | 'confirming' | 'failed'
  connection?: MatrixAppConnection
  /** Deliberately coarse: authority and callback details stay in main. */
  error?: 'unavailable' | 'timed_out'
}
