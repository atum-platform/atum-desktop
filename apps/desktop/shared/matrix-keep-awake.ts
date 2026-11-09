export const MATRIX_KEEP_AWAKE = {
  status: 'matrix:keep-awake:status',
  enabled: 'matrix:keep-awake:enabled'
} as const

/** One device-local preference. Main owns persistence and the native blocker. */
export interface MatrixKeepAwakeBridge {
  status(): Promise<boolean>
  setEnabled(enabled: boolean): Promise<boolean>
}

declare global {
  interface Window {
    atumKeepAwake?: MatrixKeepAwakeBridge
  }
}
