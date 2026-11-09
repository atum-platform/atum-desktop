import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it, vi } from 'vitest'

import { AgentHomeJournal } from './agent-home-placement/journal'
import { HomeStanding } from './agent-home-placement/standing'
import { createWorld } from './agent-home-placement/world.fixture'
import { applyMatrixJobsHold, MatrixCronHolds } from './cron-hold'
import { MacJobLifecycle } from './mac-job-lifecycle'
import { macJobsTickerPlan } from './mac-job-startup'

it.each([false, true])('gates first-lease startup, reconnect and overlapping preparation (selected=%s)', async selected => {
  const w = await createWorld({ at: 'a' })
  const temp = mkdtempSync(path.join(os.tmpdir(), 'n7-start-'))
  const root = path.resolve(import.meta.dirname, '../../../..')
  const holds = new MatrixCronHolds(temp)
  let leased = false
  let release: (() => void) | undefined
  let delayed = false

  const run = vi.fn(async (_selection, _client, signal: AbortSignal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  })

  const lifecycle = new MacJobLifecycle({
    context: { platform: w.a.platform, auth: w.a.auth, me: () => w.a.deviceServiceId,
      standing: new HomeStanding({ platform: w.a.platform, journal: new AgentHomeJournal(w.a.store), me: () => w.a.deviceServiceId, now: w.clock.now }),
      runtime: { leaseFacts: () => {
        const lease = w.stub.lease(w.agent)

        return leased && lease ? { leaseId: lease.leaseId, executorTerm: lease.term, leaseExpiresAtPlatform: lease.expiresAt } : null
      } } },
    assistantId: randomUUID(), principal: w.agent, agentKey: 'agent', holds, run,
    request: send => send('mas', 'https://shell.test/api/matrix/v1'),
    fetch: async () => {
      if (delayed) { await new Promise<void>(resolve => { release = resolve }) }

      return Response.json({ profile: 'atum.mac-job-snapshot/1', selected, generation: selected ? 'a'.repeat(64) : null, managedJobIds: selected ? ['managed'] : [] })
    }
  })

  // These are the same plan/marker operations used by main at launch and reconciliation.
  const reconcile = () => applyMatrixJobsHold(holds, 'agent', macJobsTickerPlan({ holdUntilAnswering: false }, lifecycle))

  const tick = () => JSON.parse(execFileSync(path.join(root, '.venv/bin/python'), ['-c', `
import json, tempfile
from pathlib import Path
from unittest.mock import patch
from cron.scheduler import tick
from hermes_cli.web_server import _desktop_cron_can_dispatch, _desktop_cron_can_dispatch_job
env = {'HERMES_DESKTOP_CRON_HOLD': ${JSON.stringify(holds.path('agent'))}}
with tempfile.TemporaryDirectory() as tmp:
 with patch('cron.scheduler._get_lock_paths', return_value=(Path(tmp), Path(tmp)/'lock')), patch('cron.scheduler.get_due_jobs', return_value=[{'id':'managed'}, {'id':'personal'}]), patch('cron.scheduler.advance_next_runs') as advance, patch('cron.scheduler._submit_with_guard', return_value=None):
  tick(can_dispatch=_desktop_cron_can_dispatch(env), can_dispatch_job=_desktop_cron_can_dispatch_job(env))
  print(json.dumps([job_id for call in advance.call_args_list for job_id in call.args[0]]))
`], { cwd: root, env: { ...process.env, PYTHONPATH: root, HERMES_HOME: path.join(temp, "hermes") }, encoding: 'utf8' }))

  try {
    reconcile()
    await expect(lifecycle.refresh()).rejects.toThrow('not_home')
    reconcile()
    expect(tick()).toEqual([])
    leased = true
    await lifecycle.refresh()
    reconcile()
    expect(tick()).toEqual(selected ? ['personal'] : ['managed', 'personal'])
    delayed = true
    const reconnect = lifecycle.refresh()
    reconcile()
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(tick()).toEqual([])
    const staleRelease = release!
    delayed = false
    const replacement = lifecycle.refresh()
    reconcile()
    staleRelease()
    await Promise.all([reconnect, replacement])
    reconcile()
    expect(tick()).toEqual(selected ? ['personal'] : ['managed', 'personal'])
    expect(run).toHaveBeenCalledTimes(selected ? 2 : 0)
  } finally { lifecycle.stop(); await lifecycle.drained(); rmSync(temp, { recursive: true, force: true }) }
}, 30000)

it('leaves the plan of an agent D1 does not manage here exactly as it was', () => {
  const plan = { attach: true, tick: true, holdUntilAnswering: false }
  const unprepared = { tickerPrepared: false }
  expect(macJobsTickerPlan(plan, unprepared, false)).toBe(plan)
  expect(macJobsTickerPlan(plan, undefined, true)).toBe(plan)
  expect(macJobsTickerPlan(plan, unprepared, true)).toEqual({ ...plan, holdUntilAnswering: true })
  expect(macJobsTickerPlan(plan, { tickerPrepared: true }, true)).toBe(plan)
})
