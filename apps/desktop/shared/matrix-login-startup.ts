export const MATRIX_LOGIN_STARTUP = {
  status: 'matrix:login-startup:status',
  enabled: 'matrix:login-startup:enabled',
  openSettings: 'matrix:login-startup:open-settings',
  acknowledge: 'matrix:login-startup:acknowledge'
} as const

/** Device-local OS registration, never an account-synced preference or listening consent.
 * `loginItemsPane`: macOS reported a ServiceManagement status, so this is macOS 13+ and
 * System Settings › General › Login Items exists to open (`openSettings`); older macOS has
 * no such pane, and the row never offers it there. `announce`: Atum turned this on by itself
 * (open at login is on by default, once per Mac) and the person hasn't been told yet: the
 * window says so in one line until they acknowledge it (`acknowledge`). */
export type MatrixLoginStartupStatus =
  | {
      state: 'enabled' | 'disabled' | 'requires_approval'
      wasOpenedAtLogin: boolean
      loginItemsPane?: true
      announce?: true
    }
  | { state: 'unavailable'; reason: 'unsupported' | 'development' | 'os_error' }

/** The renderer cannot choose an executable, arguments, service, path or registration name. */
export interface MatrixLoginStartupBridge {
  status(): Promise<MatrixLoginStartupStatus>
  setEnabled(enabled: boolean): Promise<MatrixLoginStartupStatus>
  /** Opens macOS System Settings › General › Login Items; main owns the fixed destination. */
  openSettings(): Promise<void>
  /** The person has seen the one line saying Atum turned this on by default. */
  acknowledge(): Promise<void>
}

declare global {
  interface Window {
    atumLoginStartup?: MatrixLoginStartupBridge
  }
}
