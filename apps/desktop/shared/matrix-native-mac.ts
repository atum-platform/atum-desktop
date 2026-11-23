/**
 * Native Hermes reach-down to this Mac (files + terminal over the system's own Remote Login), as the
 * window sees it. Main owns setup (`electron/matrix/device/native-ssh.ts`); this is display state and
 * owner actions. Nothing here is execution authority.
 */
export const MATRIX_NATIVE_MAC_IPC = {
  /** The main-process native SSH service (registered beside it in `matrix/main.ts`). */
  ssh: 'matrix:native-ssh',
  /** One fresh Touch ID (or the Mac's password) before the window answers a command approval. */
  confirmCommand: 'matrix:native-command-confirm'
} as const

export type MatrixNativeSshStatus =
  | 'connected'
  | 'set_up'
  | 'needs_remote_login'
  | 'needs_full_disk_access_hint'
  | 'tunnel_down'
  /** The owner disconnected this Mac; Connect sets it up again from scratch. */
  | 'not_connected'
  | 'error'

/** Where setup stopped. Fixed step names only, never text from a process or the account. */
export type MatrixNativeSshSetupStep =
  | 'prepare'
  | 'authorized_keys'
  | 'write_keys'
  | 'start_tunnel'
  | 'enroll'

export type MatrixNativeSshAction =
  | 'status'
  | 'refresh'
  | 'connect'
  | 'disconnect'
  | 'enable_remote_login'
  | 'full_disk_access_hint'
  | 'open_settings'

/** Fixed reason codes only, never provider or process text. */
export interface MatrixNativeSshView {
  status: MatrixNativeSshStatus
  settingsUrl: string
  reason?: string
  /** The setup step that failed, so the window can say where it stopped. */
  step?: MatrixNativeSshSetupStep
  /** A safe code for the failed step: our own code, an OS error code or an HTTP status number. */
  code?: string
}

/** `confirmed`: the owner is present and said yes; `declined`: they cancelled the sheet. */
export type MatrixNativeCommandConfirm = 'confirmed' | 'declined' | 'unavailable'

/** The longest command text main puts on the Touch ID sheet; the card itself can show all of it. */
export const MATRIX_NATIVE_COMMAND_SHEET_MAX = 80

export interface MatrixNativeMacBridge {
  ssh(action: MatrixNativeSshAction): Promise<MatrixNativeSshView>
  /** Ask for presence before approving `command` (shown, shortened, on the system sheet). */
  confirmCommand(command: string): Promise<MatrixNativeCommandConfirm>
}

/** The command as one short, plain line for the system sheet: no control characters, no newlines. */
export function matrixNativeCommandSheetText(command: string): string {
  const flat = command.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  const points = Array.from(flat)

  return points.length > MATRIX_NATIVE_COMMAND_SHEET_MAX
    ? `${points.slice(0, MATRIX_NATIVE_COMMAND_SHEET_MAX - 1).join('')}…`
    : flat
}
