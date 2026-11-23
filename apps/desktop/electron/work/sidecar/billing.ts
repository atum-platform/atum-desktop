import { closeSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

export interface WorkBillingUnit {
  sessionId: string | null
  requestId: string
  turnRequestId: string
  reservationId: string | null
}

interface WorkRun {
  runId: string
  threadId: string
}

// Pinned to the v0.1.11 projection. Require the ACP session's native ID,
// managed instance and one active run. Timestamps and prompt text cannot
// identify a billing unit, especially across manual continuation.
function readRun(home: string, sessionId: string): WorkRun | undefined {
  const db = new DatabaseSync(join(home, 'userdata', 'statev2.sqlite'), { readOnly: true })

  try {
    const matches = db.prepare(`
      SELECT DISTINCT r.run_id AS runId, r.thread_id AS threadId
      FROM orchestration_v2_projection_runs r
      JOIN orchestration_v2_projection_provider_threads p
        ON r.provider_thread_id = p.provider_thread_id
      WHERE json_extract(p.payload_json, '$.nativeThreadRef.nativeId') = ?
        AND json_extract(p.payload_json, '$.providerInstanceId') IN ('atum-managed', 'atum-managed-delegated')
        AND r.status IN ('starting', 'running', 'waiting')
      LIMIT 2
    `).all(sessionId)

    if (matches.length === 1 && typeof matches[0].runId === 'string' && typeof matches[0].threadId === 'string') {
      return { runId: matches[0].runId, threadId: matches[0].threadId }
    }
  } finally {
    db.close()
  }
}

export async function recordWorkBillingUnit(
  home: string,
  unit: WorkBillingUnit,
  signal: AbortSignal,
  isLive: () => boolean
): Promise<void> {
  const { sessionId, requestId, turnRequestId, reservationId } = unit

  if (!sessionId || !isLive()) {
    throw new Error('work_billing_unavailable')
  }

  const path = join(home, '..', 'billing.sqlite')
  closeSync(openSync(path, 'a', 0o600))
  const db = new DatabaseSync(path)

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS billing_units (
        requestId TEXT PRIMARY KEY,
        turnRequestId TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        runId TEXT NOT NULL,
        threadId TEXT NOT NULL,
        reservationId TEXT
      )
    `)
    const prior = db.prepare('SELECT sessionId, turnRequestId, reservationId FROM billing_units WHERE requestId = ?').get(requestId)

    if (prior) {
      if (prior.sessionId !== sessionId || prior.turnRequestId !== turnRequestId ||
          (prior.reservationId && reservationId && prior.reservationId !== reservationId)) {
        throw new Error('work_billing_conflict')
      }

      if (reservationId) {
        db.prepare('UPDATE billing_units SET reservationId = ? WHERE requestId = ?').run(reservationId, requestId)
      }

      return
    }

    // Provider acceptance and the projection write run concurrently. Wait
    // briefly for the unique projection before permitting a reservation.
    for (let attempt = 0; attempt < 20; attempt++) {
      signal.throwIfAborted()

      if (!isLive()) {
        throw new Error('work_billing_unavailable')
      }

      const run = readRun(home, sessionId)

      if (run) {
        db.prepare('INSERT INTO billing_units VALUES (?, ?, ?, ?, ?, ?)')
          .run(requestId, turnRequestId, sessionId, run.runId, run.threadId, reservationId)

        return
      }

      await delay(50, undefined, { signal })
    }

    throw new Error('work_billing_run_unavailable')
  } finally {
    db.close()
  }
}
