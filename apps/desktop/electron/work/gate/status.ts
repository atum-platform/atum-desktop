import { answerForRow } from './answers'
import type { WorkGateId, WorkRequestAnswer } from './contract'
import type { GateLedger, ReceiptRow } from './ledger'
import type { GateSessions, T3Reader, ThreadRead } from './ports'

// The request-status path (plan §11.4 rules 3 and 4, review round 4 R4-2): READ-ONLY. It is built from the ledger
// and a `T3Reader` and nothing else: there is no way from here to start, steer or stop a thread. What it may do is
// write down what it saw (a thread found means `launched`). Recovery that can dispatch is `GateRecovery` in
// gate.ts, which the `request` tool never calls.

export const BUSY_STATUSES = new Set(['running', 'starting', 'preparing', 'waiting'])

export const threadBusy = (read: ThreadRead): boolean =>
  read.kind === 'found' && (read.activeRunId != null || BUSY_STATUSES.has(read.status) || read.runs.some(run => BUSY_STATUSES.has(run.status)))

export interface StatusDeps {
  ledger: GateLedger
  reader: T3Reader
  sessions: Pick<GateSessions, 'owner' | 'agentSessionId'>
  gateId(): WorkGateId
  now(): number
  /** The fingerprint a launch admitted now would carry for this row's call. */
  fingerprintFor(row: ReceiptRow): string
}

export type Resendable = { ok: true } | { ok: false; cause: 'session_replaced' | 'deadline_passed' | 'setting_changed' }

export class RequestStatusReader {
  constructor(private readonly deps: StatusDeps) {}

  /** Whether the gate itself could send the stored call again (rule 4): same session, deadline open, same settings. */
  resendable(row: ReceiptRow): Resendable {
    if (row.sessionId !== this.deps.sessions.agentSessionId(row.principal)) {
      return { ok: false, cause: 'session_replaced' }
    }

    if (row.notAfter === null || this.deps.now() > row.notAfter) {
      return { ok: false, cause: 'deadline_passed' }
    }

    if (row.fingerprint !== this.deps.fingerprintFor(row)) {
      return { ok: false, cause: 'setting_changed' }
    }

    return { ok: true }
  }

  /** Record what a read found. Never starts anything. */
  observe(row: ReceiptRow, read: ThreadRead): void {
    if (read.kind !== 'found') {
      return
    }

    const first = read.runs.find(run => run.ordinal === 1)

    if (row.state === 'admitted') {
      this.deps.ledger.update(row.principal, row.requestId, { state: 'launched', ...(first ? { run_id: first.runId } : {}) })
    } else if (first && !row.runId) {
      this.deps.ledger.update(row.principal, row.requestId, { run_id: first.runId })
    }

    if (!threadBusy(read) && read.runs.length > 0 && read.runs.every(run => ['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back'].includes(run.status))) {
      this.deps.ledger.update(row.principal, row.requestId, { finished: 1 })
    }
  }

  async status(principal: string, requestId: string): Promise<WorkRequestAnswer> {
    const gateId = this.deps.gateId()
    const row = this.deps.ledger.receipt(principal, requestId)

    if (!row) {
      return { gateId, requestId, class: 'none', receipt: 'none' }
    }

    if (row.state !== 'admitted' || row.stopScope) {
      return answerForRow(gateId, row)
    }

    if (!row.forwarded) {
      // T3 cannot have it: nothing to read.
      return answerForRow(gateId, row)
    }

    const read = await this.read(row)

    if (read.kind === 'found') {
      this.observe(row, read)

      return answerForRow(gateId, this.deps.ledger.receipt(principal, requestId) as ReceiptRow)
    }

    const fresh = this.deps.ledger.receipt(principal, requestId) as ReceiptRow

    if (fresh.stopScope) {
      return answerForRow(gateId, fresh)
    }

    if (read.kind === 'absent') {
      const can = this.resendable(fresh)

      if (can.ok === false) {
        return { gateId, requestId, class: 'ambiguous', receipt: 'admitted', forwarded: true, cause: can.cause }
      }
    }

    return { gateId, requestId, class: 'pending', receipt: 'admitted', forwarded: true }
  }

  /** The thread a launch should have made, read with main's owner session (the agent's own may be replaced). */
  async read(row: ReceiptRow): Promise<ThreadRead> {
    try {
      const owner = await this.deps.sessions.owner()

      return await this.deps.reader.read(owner.token, row.threadId as string)
    } catch {
      return { kind: 'transport' }
    }
  }
}
