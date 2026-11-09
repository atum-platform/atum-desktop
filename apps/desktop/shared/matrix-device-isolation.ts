/** Per-install opt-in; default changes require the separate G2 owner decision. */
export type MatrixDeviceIsolation = 'all' | 'signed'
export const MATRIX_DEVICE_ISOLATION_DEFAULT: MatrixDeviceIsolation = 'all'

export function matrixDeviceIsolation(value: unknown): MatrixDeviceIsolation {
  if (value === undefined) {
    return MATRIX_DEVICE_ISOLATION_DEFAULT
  }

  if (value === 'all' || value === 'signed') {
    return value
  }

  throw new Error('matrix_device_isolation_invalid')
}

/** Plan5 §6.4: every legacy per-room sharing override uses this definition. */
export function matrixLegacyGroupKeys(value: MatrixDeviceIsolation | undefined): boolean {
  return matrixDeviceIsolation(value) === 'all'
}
