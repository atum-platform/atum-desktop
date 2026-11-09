export const MATRIX_COMMAND_LOG_FILES = ['agent', 'errors', 'gateway', 'desktop'] as const
export const MATRIX_COMMAND_LOG_LEVELS = ['ALL', 'INFO', 'WARNING', 'ERROR'] as const
export const MATRIX_COMMAND_USAGE_DAYS = [7, 30, 90] as const
export type MatrixCommandLogFile = (typeof MATRIX_COMMAND_LOG_FILES)[number]
export type MatrixCommandLogLevel = (typeof MATRIX_COMMAND_LOG_LEVELS)[number]
export type MatrixCommandUsageDays = (typeof MATRIX_COMMAND_USAGE_DAYS)[number]
export type MatrixCommandHealth = 'ok' | 'degraded' | 'unknown'
export interface MatrixCommandStatus {
  version: string | null
  gatewayRunning: boolean | null
  activeSessions: number | null
  overall: MatrixCommandHealth
  components: { name: 'gateway' | 'dashboard' | 'storage' | 'platforms'; status: MatrixCommandHealth }[]
}
export interface MatrixCommandLogs {
  file: MatrixCommandLogFile
  lines: string[]
  truncated: boolean
}
export interface MatrixCommandUsage {
  days: MatrixCommandUsageDays
  totals: { sessions: number | null; calls: number | null; input: number | null; output: number | null }
  daily: { day: string; input: number | null; output: number | null }[]
  models: { name: string; input: number | null; output: number | null }[]
}
export interface MatrixCommandCurator {
  enabled: boolean | null
  paused: boolean | null
  intervalHours: number | null
  lastRunAt: string | null
  lastRunKnown: boolean
}
export interface MatrixCommandCenterClient {
  status(): Promise<MatrixCommandStatus>
  logs(file: MatrixCommandLogFile, level: MatrixCommandLogLevel): Promise<MatrixCommandLogs>
  usage(days: MatrixCommandUsageDays): Promise<MatrixCommandUsage>
  curator(): Promise<MatrixCommandCurator>
}
