/**
 * process-exit-reports.ts
 *
 * Sends the existing operation-failure contract for a renderer, child or
 * managed-backend process that went away. Consent, allowlisting and transport
 * stay in AtumObservability; these helpers only classify and hand over.
 */

import type { DiagnosticError, ProductEvent } from '../shared/atum-observability'

import { backendExitReport, childProcessGoneReport, rendererGoneReport } from './process-exit'

export interface ProcessReportTarget {
  capture(event: ProductEvent): void
  error(error: DiagnosticError): void
}

/** One report per `operation:kind` per ten minutes, and a hard process cap. */
const REPORT_COOLDOWN_MS = 10 * 60_000
const REPORT_PROCESS_CAP = 20
const reportTimes = new Map<string, number>()
let processReportCount = 0

/** Test-only: reset the per-process report limits. */
export function resetProcessReportLimits(): void {
  reportTimes.clear()
  processReportCount = 0
}

function withinReportLimits(operation: DiagnosticError['operation'], kind: string): boolean {
  if (processReportCount >= REPORT_PROCESS_CAP) {return false}
  const key = `${operation}:${kind}`
  const now = Date.now()
  const previous = reportTimes.get(key)

  if (previous !== undefined && now - previous < REPORT_COOLDOWN_MS) {return false}
  reportTimes.set(key, now)
  processReportCount += 1

  return true
}

function diagnostic(
  operation: DiagnosticError['operation'],
  report: { kind: string; exitCode?: number },
  childType?: 'GPU' | 'Utility'
) {
  return {
    operation,
    kind: report.kind,
    ...(report.exitCode === undefined ? {} : { exitCode: report.exitCode }),
    ...(childType === undefined ? {} : { childType })
  }
}

/**
 * A renderer process gone. `crashSession` settles release health as crashed;
 * callers pass it only for the app's primary window, where the session itself
 * really did end in a crash. It runs last so the live session contains the
 * classified error before its journal marker is cleared.
 *
 * A report suppressed by the cooldown/cap still returns true: the process was
 * recognised as a reportable crash, but the budget refused another send.
 */
export function reportRendererGone(
  target: ProcessReportTarget,
  details: { reason?: unknown; exitCode?: unknown } | null | undefined,
  options: { crashSession?: () => void } = {}
): boolean {
  const report = rendererGoneReport(details)

  if (!report) {
    return false
  }

  if (!withinReportLimits('renderer', report.kind)) {
    return true
  }

  target.capture({ name: 'operation_failed', properties: { operation: 'renderer', code: 'process_gone' } })
  target.error(diagnostic('renderer', report))
  options.crashSession?.()

  return true
}

/** GPU and utility children that did not exit cleanly. */
export function reportChildProcessGone(
  target: ProcessReportTarget,
  details: { type?: unknown; reason?: unknown; exitCode?: unknown } | null | undefined
): boolean {
  const report = childProcessGoneReport(details)

  if (!report) {
    return false
  }

  const type = details?.type
  const childType = type === 'GPU' || type === 'Utility' ? type : undefined

  if (!childType || !withinReportLimits('main', report.kind)) {
    return true
  }

  target.capture({ name: 'operation_failed', properties: { operation: 'main', code: 'process_gone' } })
  target.error(diagnostic('main', report, childType))

  return true
}

/** A managed Hermes backend that exited without a clean, intentional stop. */
export function reportBackendExit(
  target: ProcessReportTarget,
  input: { code?: unknown; signal?: unknown; intentional?: unknown } | null | undefined
): boolean {
  const report = backendExitReport(input)

  if (!report) {
    return false
  }

  if (!withinReportLimits('backend', report.kind)) {
    return true
  }

  target.capture({ name: 'operation_failed', properties: { operation: 'backend', code: 'process_gone' } })
  target.error(diagnostic('backend', report))

  return true
}
