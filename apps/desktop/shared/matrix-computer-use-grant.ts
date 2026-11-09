/** Native-owned permission request capability. operationId is a UUIDv4 issued
 * only after a valid start reply and held in this page scope's memory. Never a
 * PID, action name, profile, command, log or confirmation flag. */
export type MatrixComputerUseGrantStart =
  | { status: 'started'; operationId: string }
  | { status: 'cancelled' }
  | { status: 'blocked'; reason: 'unsupported' | 'not-installed' | 'busy' }
  | { status: 'unknown' }

/** Completion describes only the request process. Read fresh permission facts
 * after every terminal/lost result; never infer a grant from its exit code. */
export interface MatrixComputerUseGrantOperation {
  status: 'running' | 'completed' | 'failed' | 'unknown'
}

export interface MatrixComputerUseGrantClient {
  start(): Promise<MatrixComputerUseGrantStart>
  operationStatus(operationId: string): Promise<MatrixComputerUseGrantOperation>
}

/** Finite mounted polling; after the budget, check the same issued operation
 * manually. No automatic POST retry or adoption of a backend action. */
export const MATRIX_COMPUTER_USE_GRANT_POLL_MS = 2_000
export const MATRIX_COMPUTER_USE_GRANT_POLL_LIMIT = 30
