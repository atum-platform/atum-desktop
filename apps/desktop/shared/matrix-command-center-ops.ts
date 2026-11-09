export const MATRIX_LOCAL_ACTIONS = ['doctor', 'backup'] as const
export type MatrixLocalAction = (typeof MATRIX_LOCAL_ACTIONS)[number]
export interface MatrixLocalActionStatus {
  action: MatrixLocalAction
  state: 'unknown' | 'running' | 'succeeded' | 'failed'
  lines: string[]
  truncated: boolean
  backupAvailable: boolean
}
export type MatrixLocalActionResult = { status: 'cancelled' } | { status: 'started'; value: MatrixLocalActionStatus }
export interface MatrixCommandCenterOpsClient {
  status(action: MatrixLocalAction): Promise<MatrixLocalActionStatus>
  run(action: MatrixLocalAction): Promise<MatrixLocalActionResult>
  revealBackup(): Promise<{ revealed: true }>
}
