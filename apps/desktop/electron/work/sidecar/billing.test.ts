import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { recordWorkBillingUnit } from './billing'

describe('Work billing correlation', () => {
  let root: string
  let home: string
  let projection: DatabaseSync
  const signal = new AbortController().signal
  const unit = { sessionId: 'acp-session', requestId: 'request-1', turnRequestId: 'turn-1', reservationId: null }

  const session = JSON.stringify({
    nativeThreadRef: { nativeId: unit.sessionId }, providerInstanceId: 'atum-managed'
  })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'work-billing-'))
    home = join(root, 'server')
    mkdirSync(join(home, 'userdata'), { recursive: true })
    projection = new DatabaseSync(join(home, 'userdata', 'statev2.sqlite'))
    projection.exec(`
      CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT, payload_json TEXT);
      CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, thread_id TEXT, provider_thread_id TEXT, status TEXT);
      INSERT INTO orchestration_v2_projection_runs VALUES ('first', 'thread', 'provider-thread', 'running');
    `)
    projection.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?)').run('provider-thread', session)
  })

  afterEach(() => {
    projection.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps the original run across retries and later runs on the same ACP session', async () => {
    await recordWorkBillingUnit(home, unit, signal, () => true)
    projection.exec(`
      UPDATE orchestration_v2_projection_runs SET status = 'interrupted';
      INSERT INTO orchestration_v2_projection_runs VALUES ('second', 'thread', 'provider-thread', 'running');
    `)
    await recordWorkBillingUnit(home, { ...unit, reservationId: 'reservation' }, signal, () => true)
    await recordWorkBillingUnit(home, { ...unit, turnRequestId: 'turn-2', requestId: 'request-2' }, signal, () => true)
    const ledger = new DatabaseSync(join(root, 'billing.sqlite'), { readOnly: true })

    try {
      expect(ledger.prepare('SELECT requestId, runId, reservationId FROM billing_units ORDER BY requestId').all())
        .toEqual([
          { requestId: 'request-1', runId: 'first', reservationId: 'reservation' },
          { requestId: 'request-2', runId: 'second', reservationId: null }
        ])
    } finally {
      ledger.close()
    }
  })

  it('requires account liveness and immutable billing identity', async () => {
    await expect(recordWorkBillingUnit(home, unit, signal, () => false)).rejects.toThrow('work_billing_unavailable')
    await recordWorkBillingUnit(home, unit, signal, () => true)
    await expect(recordWorkBillingUnit(home, { ...unit, turnRequestId: 'foreign-turn' }, signal, () => true))
      .rejects.toThrow('work_billing_conflict')
  })

  it('refuses two candidate runs instead of attributing a charge to the latest run', async () => {
    projection.exec("INSERT INTO orchestration_v2_projection_runs VALUES ('second', 'thread', 'provider-thread', 'running')")
    await expect(recordWorkBillingUnit(home, unit, signal, () => true)).rejects.toThrow('work_billing_run_unavailable')
  })
})
