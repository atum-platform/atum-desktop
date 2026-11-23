import { afterEach, describe, expect, it } from 'vitest'

import { WORK_RELAY_PLANS, WORK_RELAY_PROVIDER } from '../../../shared/matrix-work-relay'

import { WORK_CONSENT_FRESHNESS_BOUND_SECONDS, WORK_REFUSAL_REASONS, workPlanLaunchDecision } from './contract'
import { EVENT_A, EVENT_B, type Harness, LUNA, makeHarness, NOVA, REQ_1, REQ_2, REQ_3 } from './test-support'

// Gate 4b (self-work slice B): the Mac's rule for a launch that names the owner's plan, contract atum.work-route/1.2.
// B-0 direct calls: every path from an agent to a plan, on the gate as the Mac runs it. Nothing here asks the platform.

let h: Harness

afterEach(async () => h?.cleanup())

const plan = (principal = LUNA, requestId = REQ_1, event = EVENT_A, extra = {}) =>
  h.gate.launch(h.ctx(principal), h.args(requestId, event, { plan: 'codex', ...extra }))

const launchedCall = (index = 0) =>
  (h.t3.calls.filter(item => item.tool === 'launch')[index]?.args as { call: { modelSelection: { instanceId: string; model: string } } }).call

/** A Mac that is ready for plan launches: a fresh snapshot naming Luna, and the local switch on. */
function ready(extra: Parameters<Harness['consent']>[0] = {}) {
  h = makeHarness()
  h.ledger.setPlanSwitch(true)
  h.consent(extra)
}

describe('the four checks, in the platform\'s order (workPlanLaunchDecision, 12 vectors)', () => {
  const base = { consent: 'on', agentNamed: true, macNamed: true, snapshotAgeSeconds: 10, headRegressed: false, localSwitch: true, scheduled: false, alsoWhenScheduled: false } as const

  it.each([
    ['everything in order', {}, 'allowed'],
    ['exactly the bound is fresh', { snapshotAgeSeconds: 300 }, 'allowed'],
    ['a second past the bound', { snapshotAgeSeconds: 300.001 }, 'plan_consent_stale'],
    ['a regressed head, whatever the snapshot says', { headRegressed: true }, 'plan_consent_stale'],
    ['stale beats off', { snapshotAgeSeconds: 900, consent: 'off' }, 'plan_consent_stale'],
    ['consent off', { consent: 'off' }, 'plan_consent_off'],
    ['this assistant not named', { agentNamed: false }, 'plan_consent_off'],
    ['this Mac not named', { macNamed: false }, 'plan_consent_off'],
    ['off beats the local switch', { consent: 'off', localSwitch: false }, 'plan_consent_off'],
    ['the local switch off', { localSwitch: false }, 'plan_switch_off'],
    ['switch off beats not scheduled', { localSwitch: false, scheduled: true }, 'plan_switch_off'],
    ['not backed by an owner message, consent says no', { scheduled: true }, 'plan_not_scheduled'],
    ['not backed, consent says also when scheduled', { scheduled: true, alsoWhenScheduled: true }, 'allowed']
  ] as const)('%s', (_name, patch, expected) => {
    expect(workPlanLaunchDecision({ ...base, ...patch })).toBe(expected)
  })

  it('the bound is 300 seconds and the four reasons are launch refusals the contract names', () => {
    expect(WORK_CONSENT_FRESHNESS_BOUND_SECONDS).toBe(300)

    for (const reason of ['plan_consent_stale', 'plan_consent_off', 'plan_switch_off', 'plan_not_scheduled']) {
      expect(WORK_REFUSAL_REASONS).toContain(reason)
    }
  })
})

describe('a plan launch is decided on the Mac, before anything is read from T3 or Matrix', () => {
  it('with no snapshot ever applied it is plan_consent_stale: a refused receipt, no thread, T3 and Matrix untouched', async () => {
    h = makeHarness()
    h.ledger.setPlanSwitch(true)
    const answer = await plan()

    expect(answer).toMatchObject({ class: 'refused', receipt: 'refused', reason: 'plan_consent_stale' })
    expect(h.t3.count('launch')).toBe(0)
    expect(h.t3.planCalls).toBe(0)
    expect(h.owner.fetched).toEqual([])
    expect(h.ledger.eventClaimed(EVENT_A)).toBe(false)
    expect(h.ledger.receipt(LUNA, REQ_1)).toMatchObject({ state: 'refused', reason: 'plan_consent_stale', threadId: null })
  })

  it('a snapshot older than 300 seconds on the monotonic clock is stale; at 300 it is not', async () => {
    ready()
    h.clock.advance(300_000)
    expect(await plan(LUNA, REQ_1, EVENT_A)).toMatchObject({ class: 'accepted' })

    h.clock.advance(1)
    expect(await plan(LUNA, REQ_2, EVENT_B)).toMatchObject({ class: 'refused', reason: 'plan_consent_stale' })
  })

  it('the wall clock is not the age: a set-back or set-forward wall clock changes nothing', async () => {
    ready()
    h.clock.t += 10 * 3_600_000
    h.owner.put(EVENT_B, { kind: 'ok', body: 'x', originServerTs: h.clock.now() })

    expect(await plan(LUNA, REQ_1, EVENT_B)).toMatchObject({ class: 'accepted' })
  })

  it('a regressed page head makes the snapshot stale, whatever it said, until the next good page', async () => {
    ready()
    h.gate.noteHeadRegressed()
    expect(await plan()).toMatchObject({ reason: 'plan_consent_stale' })

    h.gate.noteGoodSync()
    expect(await plan(LUNA, REQ_2, EVENT_B)).toMatchObject({ class: 'accepted' })
  })

  it('after a restart the snapshot is on disk but its age is unknown: stale until the next pull', async () => {
    ready()
    h = h.reopen()
    h.gate.noteGoodSync()
    h.ledger.setPlanSwitch(true)

    expect(h.ledger.consent()?.state).toBe('on')
    expect(await plan()).toMatchObject({ reason: 'plan_consent_stale' })
    h.consent({ revision: 2 })
    expect(await plan(LUNA, REQ_2, EVENT_B)).toMatchObject({ class: 'accepted' })
  })

  it('consent off, or another assistant named, or no one named: plan_consent_off', async () => {
    ready({ state: 'off', agents: [] })
    expect(await plan()).toMatchObject({ reason: 'plan_consent_off' })

    h.consent({ revision: 2, state: 'on', agents: [NOVA] })
    expect(await plan(LUNA, REQ_2, EVENT_B)).toMatchObject({ reason: 'plan_consent_off' })

    h.consent({ revision: 3, state: 'on', agents: [] })
    expect(await plan(LUNA, REQ_3, EVENT_A)).toMatchObject({ reason: 'plan_consent_off' })
    expect(h.owner.fetched).toEqual([])
  })

  it('the local switch is OFF by default: a fully consented launch is plan_switch_off until the owner turns it on', async () => {
    h = makeHarness()
    h.consent({})

    expect(h.gate.planSwitchOn()).toBe(false)
    expect(await plan()).toMatchObject({ class: 'refused', reason: 'plan_switch_off' })
    expect(h.t3.count('launch')).toBe(0)

    h.gate.setPlanSwitch(true)
    expect(await plan(LUNA, REQ_2, EVENT_B)).toMatchObject({ class: 'accepted' })
  })

  it('the first failing check answers: stale before off before switch before not-scheduled', async () => {
    h = makeHarness()
    h.consent({ state: 'off', agents: [] })
    h.clock.advance(400_000)
    expect(await plan(LUNA, REQ_1)).toMatchObject({ reason: 'plan_consent_stale' })

    h.consent({ state: 'off', agents: [], revision: 2 })
    expect(await plan(LUNA, REQ_2, EVENT_B)).toMatchObject({ reason: 'plan_consent_off' })

    h.consent({ revision: 3 })
    expect(await plan(LUNA, REQ_3, EVENT_C_OLD())).toMatchObject({ reason: 'plan_switch_off' })
  })
})

// An owner message that exists but is older than the age bound (900 s).
const EVENT_C_OLD = () => {
  h.owner.put('$eventOldOldOldOldOldOldOldOldOldOldOldOld', { kind: 'ok', body: 'old', originServerTs: h.clock.now() - 2_000_000 })

  return '$eventOldOldOldOldOldOldOldOldOldOldOldOld'
}

describe('"scheduled": a launch not backed by a fresh, verified, unclaimed message of the owner', () => {
  it('a message past its age bound is "not scheduled" for a plan launch, not owner_event_too_old', async () => {
    ready()
    expect(await plan(LUNA, REQ_1, EVENT_C_OLD())).toMatchObject({ class: 'refused', reason: 'plan_not_scheduled' })
    expect(h.t3.count('launch')).toBe(0)
  })

  it.each([
    ['a message that does not exist', '$eventMissingMissingMissingMissingMissing'],
    ['a message that is not the owner\'s', 'not-owner']
  ])('%s', async (_name, event) => {
    ready()

    if (event === 'not-owner') {
      h.owner.put('$eventForeignForeignForeignForeignForeig', { kind: 'invalid', reason: 'owner_event_not_owner' })
      event = '$eventForeignForeignForeignForeignForeig'
    }

    expect(await plan(LUNA, REQ_1, event)).toMatchObject({ class: 'refused', reason: 'plan_not_scheduled' })
  })

  it('a message another launch already holds is "not scheduled": one message starts one piece of work', async () => {
    ready()
    expect(await h.gate.launch(h.ctx(LUNA), h.args(REQ_1, EVENT_A))).toMatchObject({ class: 'accepted' })
    expect(await plan(LUNA, REQ_2, EVENT_A)).toMatchObject({ class: 'refused', reason: 'plan_not_scheduled' })
    expect(h.t3.count('launch')).toBe(1)
  })

  it('an unreachable homeserver is NOT a refusal: unavailable, retryable', async () => {
    ready()
    h.owner.unreachable = true
    expect(await plan()).toMatchObject({ class: 'unavailable', reason: 'owner_event_unverifiable' })
    expect(h.ledger.receipt(LUNA, REQ_1)).toBeUndefined()
  })

  it('"also when scheduled" does not let a launch skip the owner message in slice A: the owner-event checks still apply', async () => {
    ready({ alsoWhenScheduled: true })
    expect(await plan(LUNA, REQ_1, EVENT_C_OLD())).toMatchObject({ class: 'refused', reason: 'owner_event_too_old' })
  })
})

describe('a passing plan launch', () => {
  it('sets the provider itself from the compiled list and T3\'s advertised model, and debits nothing', async () => {
    ready()
    h.access.value = 'empty' // an Atum launch would be balance_empty; a plan launch never reads the balance
    const answer = await plan()

    expect(answer).toMatchObject({ class: 'accepted', receipt: 'launched' })
    expect(launchedCall().modelSelection).toEqual({ instanceId: 'codex', model: 'codex-model-1' })
    expect(Object.values(WORK_RELAY_PROVIDER).map(plan => plan.instanceId)).toEqual(['codex', 'claudeAgent', 'antigravity'])
    expect(h.ledger.receipt(LUNA, REQ_1)).toMatchObject({ plan: 'codex', state: 'launched' })
    expect(h.ledger.eventClaimed(EVENT_A)).toBe(true)
  })

  it('an Atum launch never reads the snapshot or the switch, and still checks the balance', async () => {
    h = makeHarness()
    expect(await h.gate.launch(h.ctx(LUNA), h.args(REQ_1, EVENT_A))).toMatchObject({ class: 'accepted' })
    expect(launchedCall().modelSelection.instanceId).toBe('atum-managed-delegated')
    expect(h.t3.planCalls).toBe(0)

    h.access.value = 'empty'
    expect(await h.gate.launch(h.ctx(LUNA), h.args(REQ_2, EVENT_B))).toMatchObject({ reason: 'balance_empty' })
  })

  it('a plan that T3 does not call connected is `unavailable` (provider_not_ready), with no receipt and nothing sent', async () => {
    ready()

    for (const status of ['disconnected', 'unknown'] as const) {
      h.t3.planStatus = status
      expect(await plan()).toMatchObject({ class: 'unavailable', reason: 'provider_not_ready' })
    }

    expect(h.ledger.receipt(LUNA, REQ_1)).toBeUndefined()
    expect(h.t3.count('launch')).toBe(0)
    expect(h.owner.fetched).toEqual([])
  })

  it('a retry that turns an Atum launch into a plan launch (or back) is params_mismatch, not a new thread', async () => {
    ready()
    h.t3.dropNextReply = true
    await h.gate.launch(h.ctx(LUNA), h.args(REQ_1, EVENT_A))

    expect(await plan(LUNA, REQ_1, EVENT_A)).toMatchObject({ class: 'refused', reason: 'params_mismatch' })
    expect(h.t3.count('launch')).toBe(1)
  })
})

describe('the fence at the handoff: the plan rule is checked again at the moment of sending', () => {
  it('consent withdrawn between admission and the send: nothing is sent and the row settles as never sent', async () => {
    ready()
    const parked = h.pause('admitted')
    const launching = plan()

    await parked.reached
    h.consent({ revision: 2, state: 'off', agents: [] })
    parked.release()

    expect(await launching).toMatchObject({ class: 'revoked', scope: 'agent' })
    expect(h.t3.count('launch')).toBe(0)
    expect(h.ledger.receipt(LUNA, REQ_1)).toMatchObject({ settled: 'never_sent' })
    expect(h.ledger.eventClaimed(EVENT_A)).toBe(false)
  })

  it('the snapshot going stale between admission and the send refuses the unsent row for good', async () => {
    ready()
    h.clock.advance(250_000) // the snapshot is 250 s old: fresh now, stale 50 s later (inside the launch's own 90 s deadline)
    h.owner.put(EVENT_A)
    const parked = h.pause('before_handoff')
    const launching = plan()

    await parked.reached
    h.clock.advance(60_000)
    parked.release()

    expect(await launching).toMatchObject({ class: 'refused', reason: 'plan_consent_stale' })
    expect(h.t3.count('launch')).toBe(0)
    expect(h.ledger.eventClaimed(EVENT_A)).toBe(false)
  })

  it('a ledger row that names a provider outside the compiled list is never sent, whatever else is true', async () => {
    ready()
    h.t3.dropNextReply = true
    await plan()
    const row = h.ledger.receipt(LUNA, REQ_1)
    const call = JSON.parse(row?.callJson as string)

    call.modelSelection = { instanceId: 'claudeAgent', model: 'claude-opus-5-5' }
    h.ledger.update(LUNA, REQ_1, { call_json: JSON.stringify(call), forwarded: 0, forward_count: 0 })
    h.t3.threads.clear()
    h.t3.calls.length = 0

    expect(await plan()).toMatchObject({ class: 'refused', reason: 'invalid_field' })
    expect(h.t3.count('launch')).toBe(0)
  })

  it('an Atum row whose stored call names the plan instance is not sent either (the two sets do not mix)', async () => {
    h = makeHarness()
    h.t3.dropNextReply = true
    await h.gate.launch(h.ctx(LUNA), h.args(REQ_1, EVENT_A))
    const call = JSON.parse(h.ledger.receipt(LUNA, REQ_1)?.callJson as string)

    call.modelSelection = { instanceId: 'codex', model: 'x' }
    h.ledger.update(LUNA, REQ_1, { call_json: JSON.stringify(call), forwarded: 0, forward_count: 0 })
    h.t3.threads.clear()
    h.t3.calls.length = 0

    expect(await h.gate.launch(h.ctx(LUNA), h.args(REQ_1, EVENT_A))).toMatchObject({ class: 'refused', reason: 'invalid_field' })
    expect(h.t3.count('launch')).toBe(0)
  })
})

describe('re-reading the thread before a send', () => {
  it('a resend first reads the thread: one that exists is never sent to again, and a provider that is not the row\'s is logged', async () => {
    ready()
    const logs: string[] = []

    h.t3.dropNextReply = true
    await plan()
    const thread = [...h.t3.threads.values()][0]
    thread.provider = 'someOtherProvider'
    h.t3.calls.length = 0

    const gateLog = (h.gate as unknown as { options: { log?: (event: string) => void } }).options
    gateLog.log = event => logs.push(event)

    expect(await plan()).toMatchObject({ class: 'accepted' })
    expect(h.t3.count('launch')).toBe(0)
    expect(h.t3.count('read')).toBeGreaterThan(0)
    expect(logs).toContain('thread_provider_changed')
  })
})

describe('revocation: the plan threads an assistant started stop, and nothing else does', () => {
  const firstThread = () => [...h.t3.threads.values()][0]

  it('a snapshot that stops naming the assistant interrupts its plan threads and settles them with the usual report', async () => {
    ready({ agents: [LUNA, NOVA] })
    h.access.value = 'allowed'
    await plan(LUNA, REQ_1, EVENT_A)
    await h.gate.launch(h.ctx(LUNA), h.args(REQ_2, EVENT_B)) // Luna's Atum thread
    await plan(NOVA, REQ_3, EVENT_A === EVENT_A ? '$eventCcccccccccccccccccccccccccccccccccccccc' : EVENT_B)
    const [planThread, atumThread, novaThread] = [...h.t3.threads.values()]

    h.consent({ revision: 2, agents: [NOVA] })
    await h.gate.scheduleSettle()

    expect(planThread.runs.every(run => run.status !== 'running')).toBe(true)
    expect(atumThread.runs.some(run => run.status === 'running')).toBe(true)
    expect(novaThread.runs.some(run => run.status === 'running')).toBe(true)
    expect(h.t3.calls.filter(call => call.tool === 'interrupt').map(call => call.token)).toEqual(['owner-token'])
    expect(h.ledger.receipt(LUNA, REQ_1)).toMatchObject({ stopScope: 'agent', settled: 'stopped' })
    expect(h.ledger.receipt(LUNA, REQ_2)).toMatchObject({ stopScope: null, settled: null })
    expect(h.ledger.pending('stop_report').map(row => JSON.parse(row.payload))).toEqual([
      expect.objectContaining({ agentPrincipal: LUNA, requestId: REQ_1, scope: 'agent', outcome: 'stopped' })
    ])
    // an assistant that lost the plan keeps its Atum access: no generation move, no session revoked, no route event
    expect(h.ledger.agent(LUNA)?.generation).toBe(1)
    expect(h.sessions.revoked).toEqual([])
    expect(h.ledger.pending('mac_event')).toHaveLength(0)
    expect(h.events.some(event => event.type === 'acknowledged')).toBe(true)
  })

  it('consent turned off interrupts every plan thread, and the assistant may start Atum work once they have settled', async () => {
    ready({ agents: [LUNA, NOVA] })
    await plan(LUNA, REQ_1, EVENT_A)
    await plan(NOVA, REQ_2, EVENT_B)

    h.consent({ revision: 2, state: 'off', agents: [] })
    await h.gate.scheduleSettle()

    expect([...h.t3.threads.values()].every(thread => thread.runs.every(run => run.status !== 'running'))).toBe(true)
    expect(await h.gate.launch(h.ctx(LUNA), h.args(REQ_3, '$eventCcccccccccccccccccccccccccccccccccccccc'))).toMatchObject({ class: 'accepted' })
  })

  it('the local switch turned off interrupts every plan thread at once; turning it on again resumes nothing', async () => {
    ready()
    await plan()
    const thread = firstThread()

    h.gate.setPlanSwitch(false)
    await h.gate.scheduleSettle()
    expect(thread.runs.every(run => run.status !== 'running')).toBe(true)
    expect(h.ledger.receipt(LUNA, REQ_1)).toMatchObject({ settled: 'stopped' })

    h.gate.setPlanSwitch(true)
    expect(thread.runs.every(run => run.status !== 'running')).toBe(true)
  })

  it('a thread that already finished is not touched by a revocation', async () => {
    ready()
    await plan()
    h.t3.finish(firstThread().id)
    await h.gate.read(h.ctx(LUNA), { threadId: firstThread().id })

    h.consent({ revision: 2, state: 'off', agents: [] })
    expect(h.ledger.receipt(LUNA, REQ_1)).toMatchObject({ stopScope: null })
    expect(h.t3.count('interrupt')).toBe(0)
  })

  it('a route-wide cutoff (the Work switch, sign-out) covers plan threads like any other', async () => {
    ready()
    await plan()
    h.gate.revoke({ scope: 'route', reason: 'switch_off' })
    await h.gate.scheduleSettle()

    expect(h.ledger.receipt(LUNA, REQ_1)).toMatchObject({ stopScope: 'route', settled: 'stopped' })
  })
})

describe('the consent revision the ack carries', () => {
  it('is the durably applied snapshot\'s revision, absent until one was applied', () => {
    h = makeHarness()
    expect(h.gate.consentRevision()).toBeUndefined()
    h.consent({ revision: 7 })
    expect(h.gate.consentRevision()).toBe(7)
  })
})


it.each(WORK_RELAY_PLANS)('uses the connected %s account consent for owner turns and the Mac switch', plan => {
  h = makeHarness()
  h.consent({ provider: plan, scheduledAgents: [] })
  expect(h.gate.planDecision(LUNA, false, plan)).toBe('allowed')
  expect(h.gate.planDecision(LUNA, true, plan)).toBe('plan_not_scheduled')
  h.gate.setPlanSwitch(false)
  expect(h.gate.planDecision(LUNA, false, plan)).toBe('plan_switch_off')
})
