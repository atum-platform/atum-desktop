/**
 * A renderer failure that main may write to main.log. Every field is closed: no message,
 * room/event id, token, URL or arbitrary renderer text crosses this diagnostic seam.
 */
export const MATRIX_WINDOW_FAILURE_SOURCES = [
  'unknown',
  'command.select',
  'command.create',
  'command.select-main',
  'connectHermes',
  'retryReadiness',
  'wallet.refresh',
  'openTopUp',
  'chat.action',
  'chat.send',
  'chat.history'
] as const

export type MatrixWindowFailureSource = (typeof MATRIX_WINDOW_FAILURE_SOURCES)[number]

export interface MatrixWindowFailureDiagnostic {
  source: MatrixWindowFailureSource
  code: string
  retryable: boolean
}

const SOURCES = new Set<string>(MATRIX_WINDOW_FAILURE_SOURCES)
const CODE = /^(?:matrix_[a-z_]+|[A-Za-z][A-Za-z0-9_]{0,63})$/

/** The native closed refusal code when present; otherwise only the Error class, never its text. */
export function matrixWindowFailureCode(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  const closed = /\bmatrix_[a-z_]+\b/.exec(text)?.[0]

  if (closed) {
    return closed
  }

  return cause instanceof Error && CODE.test(cause.name) ? cause.name : 'UnknownError'
}

/** Main validates a fresh object before logging anything supplied by the renderer. */
export function parseMatrixWindowFailureDiagnostic(value: unknown): MatrixWindowFailureDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const row = value as Record<string, unknown>

  if (
    Object.keys(row).length !== 3 ||
    typeof row.source !== 'string' ||
    !SOURCES.has(row.source) ||
    typeof row.code !== 'string' ||
    !CODE.test(row.code) ||
    typeof row.retryable !== 'boolean'
  ) {
    return undefined
  }

  return row as unknown as MatrixWindowFailureDiagnostic
}

/** `[Matrix] window failure source=connectHermes code=matrix_agent_unavailable retryable=true` */
export function formatMatrixWindowFailureDiagnostic(value: unknown): string | undefined {
  const line = parseMatrixWindowFailureDiagnostic(value)

  return line
    ? `[Matrix] window failure source=${line.source} code=${line.code} retryable=${line.retryable}`
    : undefined
}
