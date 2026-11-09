// node --test scripts/s1-acceptance/lifecycle.test.mjs
// The lifecycle check over an audit directory shaped as WS-4's FileAuditWriter writes it (one JSONL file
// per UTC day): a fenced window passes, and each way it can fail is caught.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { readAudit, verifyLifecycle } from './lifecycle.mjs'

const root = mkdtempSync(path.join(os.tmpdir(), 'lifecycle-'))
after(() => rmSync(root, { recursive: true, force: true }))

const T0 = Date.parse('2026-10-08T09:00:00Z')
function auditDir(name, entries) {
  const dir = path.join(root, name)
  mkdirSync(dir, { recursive: true })
  const byDay = new Map()
  for (const entry of entries) {
    const file = `${new Date(entry.at).toISOString().slice(0, 10)}.jsonl`
    byDay.set(file, `${byDay.get(file) ?? ''}${JSON.stringify(entry)}\n`)
  }
  for (const [file, text] of byDay) writeFileSync(path.join(dir, file), text)
  return dir
}
const run = (dir, extra) => {
  const out = path.join(root, `${Math.random().toString(16).slice(2)}.json`)
  const code = verifyLifecycle({ since: new Date(T0).toISOString(), until: new Date(T0 + 60_000).toISOString(), out, auditDir: dir,
    chatShowsStopped: true, processesEnded: true, ...extra })
  return { code, evidence: JSON.parse(readFileSync(out, 'utf8')) }
}

test('a fenced sign-out during a long command passes', () => {
  const dir = auditDir('fenced', [
    { at: T0 - 5_000, decision: 'admitted', commandHash: 'h1', tool: 'terminal' }, // before the window: the long command
    { at: T0 + 120, decision: 'stopped', summary: 'sign_out' },
    { at: T0 + 2_000, decision: 'refused', summary: 'signed_out' }
  ])
  const { code, evidence } = run(dir, { moment: 'long-command', action: 'sign-out' })
  assert.equal(code, 0)
  assert.equal(evidence.passed, true)
  assert.equal(evidence.measurements.audit.decisions.refused, 1)
})

test('an admission after the action, or a missing fence, fails', () => {
  const admitted = auditDir('admitted', [{ at: T0 + 100, decision: 'stopped' }, { at: T0 + 30_000, decision: 'admitted', commandHash: 'h2' }])
  assert.equal(run(admitted, { moment: 'long-command', action: 'sleep' }).code, 1)
  const unfenced = auditDir('unfenced', [{ at: T0 + 100, decision: 'refused', summary: 'stale_connection' }])
  const result = run(unfenced, { moment: 'long-command', action: 'account-switch' })
  assert.equal(result.code, 1)
  assert.ok(result.evidence.checks.some(check => check.name === 'the Stop fence ran' && !check.ok))
})

test('a partition needs no fence, but nothing may run during it', () => {
  const quiet = auditDir('quiet', [{ at: T0 + 100, decision: 'refused', summary: 'stale_connection' }])
  assert.equal(run(quiet, { moment: 'long-command', action: 'partition' }).code, 0)
})

test('with the approval prompt open, a later approval fails the row', () => {
  const approved = auditDir('approved', [{ at: T0 + 100, decision: 'stopped' }, { at: T0 + 900, decision: 'approved', capabilities: ['ssh_agent'] }])
  assert.equal(run(approved, { moment: 'approval', action: 'sign-out' }).code, 1)
})

test('the owner\'s observations are required, and no audit file is inconclusive', () => {
  const dir = auditDir('owner', [{ at: T0 + 100, decision: 'stopped' }])
  assert.equal(run(dir, { moment: 'long-command', action: 'sign-out', chatShowsStopped: false }).code, 1)
  assert.equal(run(path.join(root, 'nothing-here'), { moment: 'long-command', action: 'sign-out' }).code, 2)
})

test('readAudit keeps only the window and counts malformed lines', () => {
  const dir = auditDir('window', [{ at: T0 - 1, decision: 'admitted' }, { at: T0 + 1, decision: 'stopped' }, { at: T0 + 120_000, decision: 'admitted' }])
  writeFileSync(path.join(dir, '2026-10-08.jsonl'), `${readFileSync(path.join(dir, '2026-10-08.jsonl'), 'utf8')}not json\n`)
  const audit = readAudit(dir, T0, T0 + 60_000)
  assert.deepEqual(audit.entries.map(entry => entry.decision), ['stopped'])
  assert.equal(audit.malformed, 1)
})
