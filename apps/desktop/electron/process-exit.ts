/**
 * process-exit.ts
 *
 * Closed classifications for a process that went away without a clean exit.
 * Only the reason class, a POSIX signal name or a numeric status may leave
 * this module: never a message, path, argument or environment value.
 *
 * Electron's exact reason set (40.x `RenderProcessGoneDetails.reason` and
 * `app.on('child-process-gone')` details):
 * `clean-exit | abnormal-exit | killed | crashed | oom | launch-failed |
 * integrity-failure | memory-eviction`.
 */

export const PROCESS_GONE_REASONS = [
  'abnormal-exit',
  'killed',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
  'memory-eviction'
] as const

export type ProcessGoneReason = (typeof PROCESS_GONE_REASONS)[number]

/** Node's POSIX signal names plus its Windows-only `SIGBREAK`. */
export const PROCESS_SIGNALS = [
  'SIGHUP',
  'SIGINT',
  'SIGQUIT',
  'SIGILL',
  'SIGTRAP',
  'SIGABRT',
  'SIGIOT',
  'SIGBUS',
  'SIGFPE',
  'SIGKILL',
  'SIGUSR1',
  'SIGSEGV',
  'SIGUSR2',
  'SIGPIPE',
  'SIGALRM',
  'SIGTERM',
  'SIGCHLD',
  'SIGCONT',
  'SIGSTOP',
  'SIGTSTP',
  'SIGTTIN',
  'SIGTTOU',
  'SIGURG',
  'SIGXCPU',
  'SIGXFSZ',
  'SIGVTALRM',
  'SIGPROF',
  'SIGWINCH',
  'SIGIO',
  'SIGINFO',
  'SIGSYS',
  'SIGBREAK'
] as const

export interface ProcessExitReport {
  /** A closed class: an Electron reason, a signal name, `exit` or `signal`. */
  kind: string
  /** Numeric status only; absent when the platform reported a signal. */
  exitCode?: number
}

const reasons = new Set<string>(PROCESS_GONE_REASONS)
const signals = new Set<string>(PROCESS_SIGNALS)
const STATUS_MIN = -2_147_483_648
const STATUS_MAX = 2_147_483_647

/** A bounded integer exit status, or undefined for anything else. */
export function processExitCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= STATUS_MIN && value <= STATUS_MAX
    ? value
    : undefined
}

export function processGoneReason(value: unknown): ProcessGoneReason | null {
  return typeof value === 'string' && reasons.has(value) ? (value as ProcessGoneReason) : null
}

function report(kind: string, value: unknown): ProcessExitReport {
  const exitCode = processExitCode(value)

  return exitCode === undefined ? { kind } : { kind, exitCode }
}

/** A renderer that is gone for a reportable (non-clean) reason. */
export function rendererGoneReport(
  details: { reason?: unknown; exitCode?: unknown } | null | undefined
): ProcessExitReport | null {
  const reason = processGoneReason(details?.reason)

  return reason ? report(reason, details?.exitCode) : null
}

/** GPU and utility children only; the other child types are not product surfaces. */
export function childProcessGoneReport(
  details: { type?: unknown; reason?: unknown; exitCode?: unknown } | null | undefined
): ProcessExitReport | null {
  if (details?.type !== 'GPU' && details?.type !== 'Utility') {
    return null
  }

  return rendererGoneReport(details)
}

/**
 * A managed backend child. A clean code-0 exit or an intentional stop (app
 * teardown, profile switch, replacement) is not a failure. Otherwise the
 * signal name, or `exit` plus its numeric status, is the whole report.
 */
export function backendExitReport(
  input: { code?: unknown; signal?: unknown; intentional?: unknown } | null | undefined
): ProcessExitReport | null {
  if (!input || input.intentional === true) {
    return null
  }

  const signal = typeof input.signal === 'string' && input.signal ? input.signal : null

  if (!signal && input.code === 0) {
    return null
  }

  if (signal) {
    return { kind: signals.has(signal) ? signal : 'signal' }
  }

  return report('exit', input.code)
}
