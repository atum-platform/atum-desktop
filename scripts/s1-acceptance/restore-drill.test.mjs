// node --test scripts/s1-acceptance/restore-drill.test.mjs
// The restore drills against a stand-in executor kit and AWS CLI: the drill passes only on the next
// home generation after the restart and the owner's confirmation, compares prompt digests when the
// controller logs them, and the snapshot plan changes nothing.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { committedTurns, localDrill, snapshotPlan, snapshotVerify } from './restore-drill.mjs'

const OWNER = '00000000-0000-4000-8000-cf4c4732fd3b'
const AGENT = '00000000-0000-4000-8000-ecbad70593ee'
const dir = mkdtempSync(path.join(os.tmpdir(), 'restore-'))
const D1 = 'a'.repeat(64)
const D2 = 'b'.repeat(64)
const line = (seconds, home, outcome = 'answered', digests = '') =>
  `${seconds}.000 executor node[1]: [agent] executor=e1 committed invocation=i${home} outcome=${outcome} home=${home}${digests}`

function kit({ afterLines, restartOk = true }) {
  const calls = []
  let restarted = false
  return {
    calls,
    ops: async args => {
      calls.push(args)
      if (args[0] === 'drill-restart') {
        restarted = true
        return { code: restartOk ? 0 : 1, stdout: restartOk ? 'DRILL_RESTARTED at now' : '' }
      }
      if (args[0] === 'timings') return { code: 0, stdout: [line(1000, 4, 'answered', ` systemDigest=${D1} toolsDigest=${D2}`), ...(restarted ? afterLines : [])].join('\n') }
      return { code: 0, stdout: '' }
    }
  }
}

const clock = () => 2_000_000

test('the committed lines parse into turns, digests included when logged', () => {
  const turns = committedTurns([line(1000, 4, 'answered', ` systemDigest=${D1} toolsDigest=${D2}`), 'noise', line(1001, 5)].join('\n'))
  assert.equal(turns.length, 2)
  assert.equal(turns[0].systemDigest, D1)
  assert.equal(turns[1].systemDigest, null)
  assert.equal(committedTurns(line(1, 1), 'other-executor').length, 0)
})

test('the drill passes on the next generation, the same digests and the owner seeing "lotus"', async () => {
  const { ops, calls } = kit({ afterLines: [line(2001, 5, 'answered', ` systemDigest=${D1} toolsDigest=${D2}`)] })
  const out = path.join(dir, 'ok.json')
  const asked = []
  const passed = await localDrill({ owner: OWNER, agent: AGENT, ops, ask: async q => { asked.push(q); return 'y' }, out, waitSeconds: 1, intervalMs: 1, now: clock, sleep: async () => {} })
  assert.equal(passed, true)
  assert.deepEqual(calls.find(c => c[0] === 'drill-restart'), ['drill-restart', `${OWNER}/${AGENT}`, '--apply'])
  assert.equal(asked.length, 2)
  const value = JSON.parse(readFileSync(out, 'utf8'))
  assert.ok(value.checks.some(c => c.name === 'the prompt prefix is byte-stable across the restore' && c.ok))
})

test('a skipped generation, a changed prefix or a wrong answer fails the drill', async () => {
  for (const [afterLines, answer, failing] of [
    [[line(2001, 6)], 'y', 'it committed the next home generation (the home came back from S3)'],
    [[line(2001, 5, 'answered', ` systemDigest=${'c'.repeat(64)} toolsDigest=${D2}`)], 'y', 'the prompt prefix is byte-stable across the restore'],
    [[line(2001, 5)], 'n', 'the owner saw "lotus" (same memory, same conversation)']
  ]) {
    const { ops } = kit({ afterLines })
    const out = path.join(dir, `fail-${failing.length}.json`)
    assert.equal(await localDrill({ owner: OWNER, agent: AGENT, ops, ask: async () => answer, out, waitSeconds: 1, intervalMs: 1, now: clock, sleep: async () => {} }), false)
    assert.ok(JSON.parse(readFileSync(out, 'utf8')).checks.some(c => c.name === failing && !c.ok), failing)
  }
})

test('no turn after the restart, or a failed restart, fails without asking twice', async () => {
  const silent = kit({ afterLines: [] })
  assert.equal(await localDrill({ owner: OWNER, agent: AGENT, ops: silent.ops, ask: async () => 'y', out: path.join(dir, 'silent.json'), waitSeconds: 0, intervalMs: 1, now: clock, sleep: async () => {} }), false)
  const broken = kit({ afterLines: [], restartOk: false })
  const asked = []
  assert.equal(await localDrill({ owner: OWNER, agent: AGENT, ops: broken.ops, ask: async q => { asked.push(q); return 'y' }, out: path.join(dir, 'broken.json'), now: clock }), false)
  assert.equal(asked.length, 0, 'never asks the owner to test a controller that did not come back')
})

test('the snapshot plan names the newest snapshot and changes nothing', async () => {
  const calls = []
  const aws = args => {
    calls.push(args)
    if (args[1] === 'describe-instances') return 'i-00000000000000000\n'
    if (args[1] === 'describe-volumes') return 'vol-0aaaaaaaaaaaaaaaa\tap-southeast-1a\n'
    if (args[1] === 'describe-snapshots') return 'snap-0bbbbbbbbbbbbbbbb\t2026-10-07T17:20:00Z\n'
    throw new Error(`unexpected ${args.join(' ')}`)
  }
  const out = path.join(dir, 'plan.json')
  assert.equal(await snapshotPlan({ aws, out }), true)
  assert.ok(calls.every(c => c[1].startsWith('describe-')), 'read-only calls only')
  const steps = JSON.parse(readFileSync(out, 'utf8')).measurements.steps.join('\n')
  assert.match(steps, /--snapshot-id snap-0bbbbbbbbbbbbbbbb/)
  assert.match(steps, /-replace=aws_instance.host/)
  assert.match(steps, /ATUM_TOFU_APPROVED_PLAN_SHA256/)
})

test('verification needs the restored volume on the running executor and a passing check', async () => {
  const aws = args => args[1] === 'describe-volumes' ? 'i-0new\tattached\n' : 'i-0new\n'
  assert.equal(await snapshotVerify({ aws, ops: async () => ({ code: 0, stdout: 'CHECK_OK' }), restoredVolume: 'vol-0new', out: path.join(dir, 'v1.json') }), true)
  assert.equal(await snapshotVerify({ aws, ops: async () => ({ code: 1, stdout: 'CHECK_FAILED x' }), restoredVolume: 'vol-0new', out: path.join(dir, 'v2.json') }), false)
  const elsewhere = args => args[1] === 'describe-volumes' ? 'i-0old\tattached\n' : 'i-0new\n'
  assert.equal(await snapshotVerify({ aws: elsewhere, ops: async () => ({ code: 0, stdout: 'CHECK_OK' }), restoredVolume: 'vol-0new', out: path.join(dir, 'v3.json') }), false)
})
