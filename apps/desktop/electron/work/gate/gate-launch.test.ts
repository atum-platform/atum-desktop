import { afterEach, describe, expect, it } from 'vitest'

import { workExpectedThreadId, WorkLaunchArgumentsSchema, workParamsHash, WorkT3LaunchCallSchema } from './contract'
import { EVENT_A, EVENT_B, EVENT_C, type Harness, LUNA, makeHarness, REQ_1, REQ_2, REQ_3 } from './test-support'

// §11.6: every fault ends in exactly one outcome class (accepted, refused, ambiguous, revoked).

let h: Harness

afterEach(async () => h?.cleanup())

const launch = (principal = LUNA, requestId = REQ_1, event = EVENT_A, extra = {}) => h.gate.launch(h.ctx(principal), h.args(requestId, event, extra))
const row = (requestId = REQ_1) => h.ledger.receipt(LUNA, requestId)

describe('launch: the happy path and what the gate builds', () => {
  it('admits, forwards the gate\'s own call, and answers accepted with the expected thread', async () => {
    h = makeHarness()
    const answer = await launch()

    expect(answer).toMatchObject({ class: 'accepted', receipt: 'launched' })
    expect((answer as { threadId: string }).threadId).toBe(workExpectedThreadId(h.sessions.agentSessionId(LUNA) as string, REQ_1))
    expect(h.t3.count('launch')).toBe(1)

    const call = (h.t3.calls.find(item => item.tool === 'launch')?.args as { call: unknown; limit: string }).call
    // built from the allowlist: exactly these fields, the delegated provider forced, the owner's words first
    expect(WorkT3LaunchCallSchema.safeParse(call).success).toBe(true)
    expect(Object.keys(call as object).sort()).toEqual(['clientRequestId', 'message', 'modelSelection', 'projectId', 'title', 'workspaceStrategy'])
    expect((call as { modelSelection: unknown }).modelSelection).toEqual({ instanceId: 'atum-managed-delegated', model: 'atum-managed:binh-minh' })
    expect((call as { message: string }).message.startsWith('OWNER (verified, event ')).toBe(true)
    expect((call as { message: string }).message).toContain('ASSISTANT (unverified):')
    expect((h.t3.calls[h.t3.calls.length - 1].args as { limit: string }).limit).toBe('approval-required/default')

    // the receipt holds the call, the mark, the fingerprint, the session and the thread known in advance
    expect(row()).toMatchObject({ state: 'launched', forwarded: true, forwardCount: 1, sessionId: h.sessions.agentSessionId(LUNA) })
    expect(row()?.fingerprint).toMatch(/^[0-9a-f]{64}$/u)
    expect(row()?.callJson).toBeTruthy()
    expect(row()?.incarnation).toBe('inc-1')
  })

  it('a retry with the same id is answered from the row, without calling T3 again', async () => {
    h = makeHarness()
    await launch()
    const again = await launch()

    expect(again).toMatchObject({ class: 'accepted' })
    expect(h.t3.count('launch')).toBe(1)
  })

  it('a terminal row answers first: a retry that changes the task still gets the row\'s answer', async () => {
    h = makeHarness()
    await h.gate.launch(h.ctx(LUNA), h.args(REQ_1, EVENT_A))

    const other = await h.gate.launch(h.ctx(LUNA), h.args(REQ_1, EVENT_A, { task: 'something else' }))

    expect(other).toMatchObject({ class: 'accepted' })
    expect(row()?.paramsHash).toBe(workParamsHash('project-reports', 'List the PDFs in the Reports folder and write their names to index.txt.', EVENT_A))
  })

  it('params_mismatch on an admitted row whose task or deadline changed', async () => {
    h = makeHarness()
    h.t3.dropNextReply = true
    await launch()
    expect(row()?.state).toBe('admitted')

    const changedTask = await h.gate.launch(h.ctx(LUNA), h.args(REQ_1, EVENT_A, { task: 'something else' }))
    const args = h.args(REQ_1, EVENT_A)
    const changedDeadline = await h.gate.launch(h.ctx(LUNA), { ...args, notAfter: args.notAfter + 1000 })

    expect(changedTask).toMatchObject({ class: 'refused', reason: 'params_mismatch' })
    expect(changedDeadline).toMatchObject({ class: 'refused', reason: 'params_mismatch' })
    expect(h.t3.count('launch')).toBe(1)
  })
})

describe('launch: concurrency', () => {
  it('the same request sent twice at once: one thread, both answered from one row', async () => {
    h = makeHarness()
    const [a, b] = await Promise.all([launch(), launch()])

    expect(a).toMatchObject({ class: 'accepted' })
    expect(b).toMatchObject({ class: 'accepted' })
    expect(h.t3.prompts).toBe(1)
    expect(h.t3.count('launch')).toBe(1)
  })

  it('two request ids naming one owner event at once: one accepted, the other refused, one thread', async () => {
    h = makeHarness()
    const [a, b] = await Promise.all([launch(LUNA, REQ_1, EVENT_A), launch(LUNA, REQ_2, EVENT_A)])
    const classes = [a.class, b.class].sort()

    expect(classes).toEqual(['accepted', 'refused'])
    expect([a, b].find(item => item.class === 'refused')).toMatchObject({ reason: 'event_already_used' })
    expect(h.t3.prompts).toBe(1)
    // and a third id later is refused too
    expect(await launch(LUNA, REQ_3, EVENT_A)).toMatchObject({ class: 'refused', reason: 'event_already_used' })
  })

  it('the claim and the receipt are one write: after a refusal nothing is half-written', async () => {
    h = makeHarness()
    await launch(LUNA, REQ_1, EVENT_A)
    await launch(LUNA, REQ_2, EVENT_A)

    expect(row(REQ_2)).toMatchObject({ state: 'refused', reason: 'event_already_used', forwarded: false })
    expect(h.ledger.eventClaimed(EVENT_A)).toBe(true)
  })
})

describe('launch: lost replies', () => {
  it('the reply dropped: the row stays admitted and forwarded; a status read finds the thread; no second launch', async () => {
    h = makeHarness()
    h.t3.dropNextReply = true
    const first = await launch()

    expect(first).toMatchObject({ class: 'pending', forwarded: true })

    const status = await h.gate.request(h.ctx(LUNA), { requestId: REQ_1, action: 'status' })

    expect(status).toMatchObject({ class: 'accepted' })
    expect(h.t3.count('launch')).toBe(1)
    expect(h.t3.prompts).toBe(1)
  })

  it('the gate killed after the forward and before it stored the reply: the restarted gate finds the thread, no resend', async () => {
    h = makeHarness()
    h.t3.dropNextReply = true
    await launch()
    h = h.reopen()
    await h.gate.recover()

    expect(row()?.state).toBe('launched')
    expect(h.t3.count('launch')).toBe(1)
    expect(h.t3.prompts).toBe(1)
  })

  it('the gate killed after the receipt and before the forward: it resends its own stored call once, under the same session', async () => {
    h = makeHarness()
    const parked = h.pause('admitted')
    const first = launch()

    await parked.reached
    // simulate the kill: the parked callback never runs again. A new gate opens the same ledger.
    const killed = h
    h = h.reopen()
    expect(row()).toMatchObject({ state: 'admitted', forwarded: false })
    await h.gate.recover()

    expect(row()?.state).toBe('launched')
    expect(h.t3.count('launch')).toBe(1)
    expect(h.t3.prompts).toBe(1)

    // the killed process never resumes: its parked callback is left where it stopped
    void first
    void killed
    void parked
  })

  it('the bytes never reached T3: the gate resends once; never two threads', async () => {
    h = makeHarness()
    h.t3.loseNextBytes = true
    const first = await launch()

    expect(first).toMatchObject({ class: 'pending', forwarded: true })
    expect(h.t3.prompts).toBe(0)

    const again = await launch()

    expect(again).toMatchObject({ class: 'accepted' })
    expect(h.t3.prompts).toBe(1)
    expect(h.t3.count('launch')).toBe(2)
    expect(row()?.forwardCount).toBe(2)
  })

  it('a lost reply and a thread found: accepted whatever happened to the session, the deadline or the settings', async () => {
    h = makeHarness()
    h.t3.dropNextReply = true
    await launch()
    h.sessions.replace(LUNA)
    h.clock.advance(5 * 60_000)
    h.t3.fingerprint = 'fp-changed'

    const status = await h.gate.request(h.ctx(LUNA), { requestId: REQ_1, action: 'status' })

    expect(status).toMatchObject({ class: 'accepted' })
  })

  it.each([
    ['the session replaced', () => h.sessions.replace(LUNA), 'session_replaced'],
    ['the deadline passed', () => h.clock.advance(5 * 60_000), 'deadline_passed'],
    ['a setting changed', () => (h.t3.fingerprint = 'fp-changed'), 'setting_changed']
  ])('a lost reply, the thread NOT found, and %s: ambiguous, no resend', async (_name, change, cause) => {
    h = makeHarness()
    h.t3.loseNextBytes = true
    await launch()
    change()

    const status = await h.gate.request(h.ctx(LUNA), { requestId: REQ_1, action: 'status' })

    expect(status).toMatchObject({ class: 'ambiguous', cause })
    expect(h.t3.count('launch')).toBe(1)
    await h.gate.recover()
    expect(h.t3.count('launch')).toBe(1)
  })
})

describe('launch: deadline and refusals decided by the gate', () => {
  it('refuses a launch after notAfter, and one that buys a long deadline', async () => {
    h = makeHarness()

    expect(await launch(LUNA, REQ_1, EVENT_A, { notAfter: h.clock.now() - 1 })).toMatchObject({ class: 'refused', reason: 'expired' })
    expect(await launch(LUNA, REQ_2, EVENT_B, { notAfter: h.clock.now() + 3_600_000 })).toMatchObject({ class: 'refused', reason: 'deadline_too_long' })
    expect(h.t3.count('launch')).toBe(0)
    // refused is retired: the same id is never sent later
    expect(await launch(LUNA, REQ_1, EVENT_A)).toMatchObject({ class: 'refused', reason: 'expired' })
    expect(h.t3.count('launch')).toBe(0)
  })

  it('a Mac asleep with the launch queued: an unsent launch past its deadline is refused `expired`, nothing starts', async () => {
    h = makeHarness()
    const parked = h.pause('admitted')
    const first = launch()

    await parked.reached
    h.clock.advance(10 * 60_000)
    parked.release()
    const answer = await first

    expect(answer).toMatchObject({ class: 'refused', reason: 'expired' })
    expect(h.t3.prompts).toBe(0)
    expect(h.ledger.eventClaimed(EVENT_A)).toBe(false)
  })

  it('provider not ready: unavailable, not a receipt, the id is not retired and the owner message is unused', async () => {
    h = makeHarness()
    h.t3.providerOk = false

    expect(await launch()).toMatchObject({ class: 'unavailable', reason: 'provider_not_ready', receipt: 'none' })
    expect(row()).toBeUndefined()
    expect(h.ledger.eventClaimed(EVENT_A)).toBe(false)

    h.t3.providerOk = true

    expect(await launch()).toMatchObject({ class: 'accepted' })
  })

  it('balance empty: refused with a receipt; balance unreadable: unavailable', async () => {
    h = makeHarness()
    h.access.value = 'empty'

    expect(await launch()).toMatchObject({ class: 'refused', reason: 'balance_empty' })
    expect(h.t3.count('launch')).toBe(0)

    h.access.value = 'unavailable'

    expect(await launch(LUNA, REQ_2, EVENT_B)).toMatchObject({ class: 'unavailable' })
    expect(row(REQ_2)).toBeUndefined()
  })

  it('a typed T3 refusal is `rejected`, leaves no thread, and releases the owner event', async () => {
    h = makeHarness()
    h.t3.rejectWith = { code: 'model_unavailable' }

    expect(await launch()).toMatchObject({ class: 'refused', receipt: 'rejected', reason: 't3_model_unavailable' })
    expect(h.ledger.eventClaimed(EVENT_A)).toBe(false)

    h.t3.rejectWith = undefined

    expect(await launch(LUNA, REQ_2, EVENT_A)).toMatchObject({ class: 'accepted' })
    expect(h.t3.prompts).toBe(1)
  })

  it('an HTTP 401 from T3 (a revoked bearer) and a 400 invalid_mode_limit are rejected, not ambiguous', async () => {
    h = makeHarness()
    h.t3.rejectWith = { status: 401 }
    expect(await launch()).toMatchObject({ receipt: 'rejected', reason: 't3_unauthorized' })

    h.t3.rejectWith = { status: 400, code: 'invalid_mode_limit' }
    expect(await launch(LUNA, REQ_2, EVENT_B)).toMatchObject({ receipt: 'rejected', reason: 't3_invalid_mode_limit' })
  })

  it('void: an id with no row is voided and a later launch with it is refused; an existing row is not voided', async () => {
    h = makeHarness()

    expect(await h.gate.request(h.ctx(LUNA), { requestId: REQ_3, action: 'void' })).toMatchObject({ class: 'refused', receipt: 'void' })
    expect(await launch(LUNA, REQ_3, EVENT_C)).toMatchObject({ class: 'refused', receipt: 'void' })
    expect(h.t3.count('launch')).toBe(0)

    await launch()

    expect(await h.gate.request(h.ctx(LUNA), { requestId: REQ_1, action: 'void' })).toMatchObject({ class: 'accepted' })
  })

  it('a launch reply with no run id: wait answers no_run_yet, never an idle thread as finished', async () => {
    h = makeHarness()
    await launch()
    const threadId = row()?.threadId as string

    // T3 has the thread but its first run does not exist yet
    h.t3.threads.get(threadId)!.runs = []

    expect(await h.gate.wait(h.ctx(LUNA), { threadId })).toMatchObject({ class: 'ok', status: 'no_run_yet', waitedMs: 0 })
    expect(h.t3.count('wait')).toBe(0)
  })

  it('wait is bounded and returns the launch\'s own run once it exists', async () => {
    h = makeHarness()
    await launch()
    const threadId = row()?.threadId as string
    const answer = await h.gate.wait(h.ctx(LUNA), { threadId, timeoutMs: 120_000 } as never)

    expect(answer).toMatchObject({ class: 'ok', status: 'running', runId: `run:thread:${threadId}:ordinal:1` })
    expect(h.t3.calls.find(item => item.tool === 'wait')).toBeTruthy()
  })
})

describe('the schemas are strict', () => {
  it('an unknown field is refused, not trimmed', () => {
    expect(WorkLaunchArgumentsSchema.safeParse({ ...{ requestId: REQ_1, projectId: 'p', task: 't', ownerEvent: EVENT_A, notAfter: 1 }, scratch: true }).success).toBe(false)
  })
})
