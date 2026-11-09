/**
 * The device audit log (S1 build plan §3, WS-4 `device/audit.ts`).
 *
 * Append-only JSONL under `userData/device/audit/`, mode 0600. Every admission decision, approval and
 * protected attempt is recorded with argument *hashes* and short summaries — never raw command text or
 * secrets. Agent commands cannot read or write it: `userData` is read/write-denied in the Seatbelt
 * profile (`protected-paths.ts`). The log is the owner's record of what T did on this Mac and the
 * evidence for the §10 injection tests.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export type AuditDecision =
  | 'admitted'
  | 'duplicate'
  | 'refused'
  | 'needs_approval'
  | 'approved'
  | 'approval_denied'
  | 'approval_timeout'
  | 'standing_grant_added'
  | 'standing_grant_revoked'
  | 'stopped'
  | 'gui_refused'

export interface AuditEntry {
  readonly at: number
  readonly decision: AuditDecision
  /** The command/approval hash this entry concerns (never the raw command). */
  readonly commandHash?: string
  readonly grantId?: string
  readonly tool?: string
  /** A short, non-sensitive summary (e.g. "terminal", "ssh_agent", a refusal reason). */
  readonly summary?: string
  readonly capabilities?: readonly string[]
}

export interface AuditWriter {
  record(entry: Omit<AuditEntry, 'at'>): void
}

/** The default file-backed writer. Rotates by UTC day so one file never grows without bound. */
export class FileAuditWriter implements AuditWriter {
  private ensured = false

  constructor(
    private readonly directory: string,
    private readonly now: () => number = () => Date.now(),
    private readonly append: (file: string, line: string) => void = (file, line) => appendFileSync(file, line, { mode: 0o600 })
  ) {}

  record(entry: Omit<AuditEntry, 'at'>): void {
    const at = this.now()
    const line = `${JSON.stringify({ at, ...entry })}\n`
    const file = path.join(this.directory, `${new Date(at).toISOString().slice(0, 10)}.jsonl`)

    try {
      this.ensureDir()
      this.append(file, line)
    } catch {
      // The audit log must never break a device operation. A failed write is dropped; the ledger still
      // holds the durable truth of what ran.
    }
  }

  private ensureDir(): void {
    if (this.ensured) {
      return
    }

    if (!existsSync(this.directory)) {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    }

    try {
      chmodSync(this.directory, 0o700)
    } catch {
      // Best-effort; a pre-existing dir with the right owner is fine.
    }

    this.ensured = true
  }
}

/** A no-op writer for contexts where the audit directory is unavailable (tests, early boot). */
export const nullAuditWriter: AuditWriter = { record: () => {} }
