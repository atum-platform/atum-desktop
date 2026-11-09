export type MatrixCuratorAction = 'pause' | 'resume' | 'run'
export interface MatrixCuratorStatus {
  enabled: boolean
  paused: boolean
  consolidate: boolean
  intervalHours: number | null
  lastRunAt: string | null
  run: {
    state: 'unknown' | 'running' | 'succeeded' | 'failed'
    lines: string[]
    truncated: boolean
  }
}
export type MatrixCuratorResult = { status: 'cancelled' } | { status: 'completed'; value: MatrixCuratorStatus }
export interface MatrixCuratorClient {
  status(): Promise<MatrixCuratorStatus>
  act(action: MatrixCuratorAction): Promise<MatrixCuratorResult>
}
