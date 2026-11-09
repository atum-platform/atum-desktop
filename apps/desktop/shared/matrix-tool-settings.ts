export const MATRIX_TERMINAL_BACKENDS = ['local', 'docker', 'singularity', 'ssh', 'modal', 'daytona'] as const
export type MatrixTerminalBackend = (typeof MATRIX_TERMINAL_BACKENDS)[number]
export const MATRIX_CAPTURE_MODES = ['som', 'vision', 'ax'] as const
export type MatrixCaptureMode = (typeof MATRIX_CAPTURE_MODES)[number]
export type MatrixToolSetting =
  | 'terminal.backend'
  | 'computer_use.max_image_dimension'
  | 'computer_use.capture_after_mode'
export type MatrixToolSettingValue = string | number
export interface MatrixToolSettingsSnapshot {
  configuredBackend: MatrixTerminalBackend | null
  backends: { id: MatrixTerminalBackend; status: 'ready' | 'needs_setup' | 'unavailable' }[]
  capture: {
    maxImageDimension: number | null
    mode: MatrixCaptureMode | null
    dimensionEditable: boolean
    modeEditable: boolean
  }
}
export interface MatrixToolSettingsConfirmation {
  field: MatrixToolSetting
  value: MatrixToolSettingValue
}
export type MatrixToolSettingsResult =
  | { status: 'cancelled' }
  | { status: 'applied'; field: MatrixToolSetting; value: MatrixToolSettingValue }
export interface MatrixToolSettingsClient {
  snapshot(): Promise<MatrixToolSettingsSnapshot>
  set(field: MatrixToolSetting, value: MatrixToolSettingValue): Promise<MatrixToolSettingsResult>
}
