import fs from 'node:fs'
import path from 'node:path'

import { makeSession, type Session, updateSession } from '@sentry/core'

import { diagnosticFrames, diagnosticKind } from './diagnostic-redaction'
import { processExitCode } from './process-exit'

export interface SafeDiagnostic {
  operation: string
  kind: string
  frames: ReturnType<typeof diagnosticFrames>
  /** Numeric process status only; never a message or path. */
  exitCode?: number
}

/** One bounded lifecycle marker, not an offline telemetry queue. A crash cannot
 * wait for networking; the next launch settles this exact Sentry session ID. */
export class ReportingSessionJournal {
  constructor(private readonly file: string, private readonly id: string, private readonly environment: string) {}

  write(session: Session, crash?: SafeDiagnostic): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      // Synchronous and tiny: also usable from uncaughtExceptionMonitor.
      fs.writeFileSync(this.file, JSON.stringify({
        sid: session.sid, did: this.id, started: session.started, timestamp: Math.max(session.started, session.timestamp, Date.now() / 1000),
        status: session.status, errors: session.errors, release: session.release,
        environment: this.environment, crash
      }), { mode: 0o600 })
    } catch { /* Reporting never prevents quitting. A torn marker is discarded. */ }
  }

  clear(): void { try {fs.rmSync(this.file, { force: true })} catch { /* Best effort. */ } }

  take(): { session: Session; crash?: SafeDiagnostic } | null {
    try {
      if (fs.statSync(this.file).size > 16_384) {return null}
      const r = JSON.parse(fs.readFileSync(this.file, 'utf8'))

      if (typeof r.sid !== 'string' || !/^[a-f0-9]{32}$/i.test(r.sid) || r.did !== this.id || r.environment !== this.environment ||
          typeof r.release !== 'string' || !/^atum(?:-matrix)?-desktop@\d+\.\d+\.\d+(?:-[\w.-]+)?\+[a-f0-9]{40}(?:-dirty)?$/.test(r.release) ||
          !Number.isFinite(r.started) || !Number.isFinite(r.timestamp) || r.started < 0 || r.timestamp < r.started ||
          !['ok', 'exited', 'crashed', 'abnormal'].includes(r.status)) {return null}

      const session = makeSession()
      updateSession(session, {
        init: false, sid: r.sid, did: this.id, started: r.started, timestamp: r.timestamp,
        status: r.status === 'ok' ? 'abnormal' : r.status,
        errors: Number.isInteger(r.errors) ? Math.max(0, Math.min(1_000_000, r.errors)) : 0,
        release: r.release, environment: this.environment,
        ...(r.status === 'ok' ? { abnormal_mechanism: 'unknown' } : {})
      })

      let crash: SafeDiagnostic | undefined

      if (r.status === 'crashed' && r.crash && ['main', 'renderer', 'backend'].includes(r.crash.operation)) {
        const stack = Array.isArray(r.crash.frames) ? r.crash.frames.slice(0, 40).reverse().map(f =>
          typeof f?.filename === 'string' && Number.isInteger(f.lineno) && Number.isInteger(f.colno)
            ? `${f.filename}:${f.lineno}:${f.colno}` : '').join('\n') : ''

        crash = { operation: r.crash.operation, kind: diagnosticKind(r.crash.kind), frames: diagnosticFrames(stack) }

        const exitCode = processExitCode(r.crash.exitCode)

        if (exitCode !== undefined) {
          crash.exitCode = exitCode
        }
      }

      return { session, crash }
    } catch {return null} finally {this.clear()}
  }
}
