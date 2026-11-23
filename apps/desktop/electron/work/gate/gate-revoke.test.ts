import { afterEach, describe, expect, it } from 'vitest'

import { EVENT_A, EVENT_B, type Harness, LUNA, makeHarness, NOVA, REQ_1, REQ_2 } from './test-support'

// §6.4: a revocation is a cutoff, then a cleanup, and it is complete only when the cleanup is. The review's first
// requirement (R4-2): the final admission check and the handoff to T3 are atomic with the cutoff.

let h: Harness

afterEach(async () => h?.cleanup())

const launch = (principal = LUNA, requestId = REQ_1, event = EVENT_A) => h.gate.launch(h.ctx(principal), h.args(requestId, event))
const row = (requestId = REQ_1, principal = LUNA) => h.ledger.receipt(principal, requestId)
const settled = () => h.gate.scheduleSettle()
const acks = () => h.events.filter(event => event.type === 'acknowledged')

describe('atomic: the final check and the handoff cannot be split by a revocation', () => {
  it('a callback parked between admission and the handoff cannot dispatch after the cutoff', async () => {
    h = makeHarness()
    const parked = h.pause('before_handoff')
    const call = launch()

    await parked.reached
    expect(row()).toMatchObject({ state: 'admitted', forwarded: false })

    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    parked.release()
    const answer = await call

    expect(answer).toMatchObject({ class: 'revoked', receipt: 'revoked', scope: 'agent' })
    expect(h.t3.count('launch')).toBe(0)
    expect(h.t3.prompts).toBe(0)
    // never sent: it settles at once, with no restart, and the owner's message is free again
    expect(row()).toMatchObject({ forwarded: false, settled: 'never_sent' })
    expect(h.ledger.eventClaimed(EVENT_A)).toBe(false)
  })

  it('revoke before the forward, parked at admission: no thread, revoked, claim released, acknowledged', async () => {
    h = makeHarness()
    const parked = h.pause('admitted')
    const call = launch()

    await parked.reached
    h.gate.revoke({ scope: 'route', reason: 'switch_off' })
    parked.release()

    expect(await call).toMatchObject({ class: 'revoked', scope: 'route' })
    expect(h.t3.prompts).toBe(0)
    await settled()
    expect(acks()).toHaveLength(1)
  })

  it('a recovered forward is fenced the same way: a cutoff before recovery means it sends nothing', async () => {
    h = makeHarness()
    const parked = h.pause('admitted')
    void launch()
    await parked.reached
    const first = h

    h = h.reopen()
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_this_mac' })
    await h.gate.recover()
    await h.gate.scheduleSettle()

    expect(h.t3.count('launch')).toBe(0)
    expect(row()).toMatchObject({ settled: 'never_sent' })
    void first
  })

  it('a cutoff that lands after the handoff leaves the row owing a stop and the reply silenced', async () => {
    h = makeHarness()
    const parked = h.pause('handed_off')
    const call = launch()

    await parked.reached
    // the request is already in T3: the thread exists, the gate has not heard yet
    expect(h.t3.prompts).toBe(1)
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    expect(row()).toMatchObject({ forwarded: true, stopScope: 'agent' })
    parked.release()

    const answer = await call

    expect(answer).toMatchObject({ class: 'revoked', scope: 'agent' })
    expect(JSON.stringify(answer)).not.toContain('threadId')
    await settled()
    // main stopped the thread with its OWN owner session, not the agent's
    const interrupt = h.t3.calls.find(item => item.tool === 'interrupt')

    expect(interrupt?.token).toBe('owner-token')
    expect(row()).toMatchObject({ state: 'launched', settled: 'stopped' })
    expect(acks()).toHaveLength(1)
    // no delegated run is active when main acknowledges
    const thread = h.t3.threads.get(row()?.threadId as string)

    expect(thread?.runs.some(run => run.status === 'running')).toBe(false)
  })
})

describe('the cleanup: stop, settle, acknowledge', () => {
  it('a lost reply followed by a revoked grant is `revoked` whether or not the thread exists, and the thread is stopped', async () => {
    h = makeHarness()
    h.t3.dropNextReply = true
    await launch()
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    await settled()

    const status = await h.gate.request({ ...h.ctx(LUNA), generation: 99 }, { requestId: REQ_1, action: 'status' })

    expect(status).toMatchObject({ class: 'revoked' })
    expect(row()).toMatchObject({ settled: 'stopped' })
    expect(acks()).toHaveLength(1)
  })

  it('bytes lost and nothing in T3: the stop stays owed until another T3 process is ready, then settles as nothing started', async () => {
    h = makeHarness()
    h.t3.loseNextBytes = true
    await launch()
    h.gate.revoke({ scope: 'route', reason: 'switch_off' })
    await settled()

    // same process: the absence is not authoritative (a committed launch could still appear)
    expect(row()).toMatchObject({ forwarded: true, settled: null })
    expect(acks()).toHaveLength(0)
    expect(h.gate.state().stopsOwed.total).toBe(1)

    h.t3.restart()
    await h.gate.scheduleSettle()

    expect(row()).toMatchObject({ settled: 'nothing_started' })
    expect(acks()).toHaveLength(1)
    expect(h.t3.prompts).toBe(0)
  })

  it('main may restart the server itself when idle; the read made after it settles the row', async () => {
    h = makeHarness()
    h.t3.loseNextBytes = true
    await launch()
    h.t3.restartResult = 'restarted'
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    await settled()

    expect(row()).toMatchObject({ settled: 'nothing_started' })
  })

  it('does not acknowledge while the thread is still running; acknowledges when it is not', async () => {
    h = makeHarness()
    await launch()
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })

    // T3 ignores the stop
    h.t3.interrupt = async (token: string, threadId: string) => {
      h.t3.calls.push({ tool: 'interrupt', token, args: threadId })

      return { transport: 'ok' as const, status: 200, isError: false, data: {} }
    }

    await settled()

    expect(row()?.settled).toBeNull()
    expect(acks()).toHaveLength(0)

    h.t3.finish(row()?.threadId as string, 'interrupted')
    await h.gate.scheduleSettle()

    expect(row()?.settled).toBe('stopped')
    expect(acks()).toHaveLength(1)
  })

  it('a queued follow-up is held, still reads queued, and does not stop the acknowledgement', async () => {
    h = makeHarness()
    await launch()
    const threadId = row()?.threadId as string

    h.t3.queue(threadId)
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    await settled()

    const runs = h.t3.threads.get(threadId)?.runs.map(run => run.status)

    expect(runs).toEqual(['interrupted', 'queued'])
    expect(acks()).toHaveLength(1)
  })

  it('the agent\'s T3 session is revoked (step 3): one agent for an agent scope, every agent for the route', async () => {
    h = makeHarness()
    await launch()
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    await settled()
    expect(h.sessions.revoked).toEqual([LUNA])

    h.gate.revoke({ scope: 'route', reason: 'sign_out' })
    await settled()
    expect(h.sessions.all).toBe(1)
  })

  it('the report owed to the platform is content-free: request id, counters, scope and outcome, never a thread', async () => {
    h = makeHarness()
    await launch()
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    await settled()

    const reports = h.ledger.pending('stop_report')

    expect(reports).toHaveLength(1)
    const body = JSON.parse(reports[0].payload) as Record<string, unknown>

    expect(Object.keys(body).sort()).toEqual([
      'agentGenerationAtAdmit',
      'agentPrincipal',
      'outcome',
      'requestId',
      'revocationId',
      'routeEpochAtAdmit',
      'scope',
      'settledAt'
    ])
    expect(body).toMatchObject({ requestId: REQ_1, agentPrincipal: LUNA, outcome: 'stopped', scope: 'agent', routeEpochAtAdmit: 1, agentGenerationAtAdmit: 1 })
    expect(reports[0].payload).not.toContain('mcp:launch')
  })
})

describe('scopes: an agent\'s stop holds back that agent; a route-wide stop holds back every agent', () => {
  it('removing Luna leaves Nova\'s grant valid and her work running', async () => {
    h = makeHarness()
    const luna = h.ledger.liveGrant(LUNA)
    void luna
    const grants = [h.gate.mintGrant(LUNA), h.gate.mintGrant(NOVA)]

    await launch(LUNA, REQ_1, EVENT_A)
    await launch(NOVA, REQ_2, EVENT_B)
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    h.ledger.setEntitled(LUNA, false)
    await settled()

    expect(h.gate.checkGrant(grants[0].bearer)).toMatchObject({ ok: false, error: 'revoked' })
    expect(h.gate.checkGrant(grants[1].bearer)).toMatchObject({ ok: true })
    const nova = h.ledger.receipt(NOVA, REQ_2)

    expect(nova?.stopScope).toBeNull()
    expect(h.t3.threads.get(nova?.threadId as string)?.runs[0].status).toBe('running')
    // Nova may still launch while Luna's stop is owed
    h.t3.autoRunning = true
    expect(await h.gate.launch(h.ctx(NOVA), h.args('AAAAAAAAAAAAAAAAAAAAA9', EVENT_A, {}))).not.toMatchObject({ class: 'revocation_pending' })
  })

  it('while a route-wide stop is owed, every agent\'s launch is `revocation_pending`; nothing is claimed', async () => {
    h = makeHarness()
    h.t3.loseNextBytes = true
    await launch(LUNA, REQ_1, EVENT_A)
    h.gate.revoke({ scope: 'route', reason: 'switch_off' })
    await settled()
    // reopen the route in the ledger (as a re-enabled switch would) while the stop is still owed
    h.ledger.setMeta('route_open', '1')

    expect(await h.gate.launch({ principal: NOVA, routeEpoch: h.ledger.routeEpoch(), generation: 1 }, h.args(REQ_2, EVENT_B))).toMatchObject({
      class: 'revocation_pending',
      receipt: 'none'
    })
    expect(h.ledger.receipt(NOVA, REQ_2)).toBeUndefined()
    expect(h.ledger.eventClaimed(EVENT_B)).toBe(false)
    // and no new grant is minted for anyone while it is owed
    expect(() => h.gate.mintGrant(NOVA)).toThrow()
  })
})

describe('across a restart', () => {
  it('a stop owed is a row in main\'s store: after a kill the gate admits nothing in that scope until it is settled', async () => {
    h = makeHarness()
    const parked = h.pause('handed_off')
    void launch()
    await parked.reached
    h.gate.revoke({ scope: 'route', reason: 'switch_off' })
    // the app is killed here: no cleanup ran
    h.sessions.revoked.length = 0
    const owedBefore = h.ledger.owedRows().length

    expect(owedBefore).toBe(1)
    h = h.reopen()
    h.ledger.setMeta('route_open', '1')

    // the fence survives the restart: a launch is refused until the owed stop settles
    const early = await h.gate.launch({ principal: LUNA, routeEpoch: h.ledger.routeEpoch(), generation: 1 }, h.args(REQ_2, EVENT_B))

    expect(early).toMatchObject({ class: 'revocation_pending' })
    expect(h.gate.continuation()).toBe(false)

    await h.gate.start()

    expect(h.ledger.owedRows()).toHaveLength(0)
    expect(row()).toMatchObject({ settled: 'stopped' })
    expect(h.t3.threads.get(row()?.threadId as string)?.runs[0].status).toBe('interrupted')
    expect(h.gate.state().stopsOwed.total).toBe(0)
    expect(h.events.filter(event => event.type === 'acknowledged')).toHaveLength(1)
  })

  it('an update or an unfinished reset holds the account: the gate admits nothing while held()', async () => {
    h = makeHarness()
    h.held.value = true

    await expect(launch()).rejects.toMatchObject({ type: 'stale_entitlements' })
    expect(h.t3.prompts).toBe(0)
    expect(h.gate.state().phase).toBe('holding')
  })

  it('reset done: sessions are forgotten and the route is cut off; earlier threads are then read-only to the agent', async () => {
    h = makeHarness()
    await launch()
    const first = row()?.threadId as string

    await h.gate.onResetDone()
    h.ledger.setMeta('route_open', '1')

    // the agent's session id changed: its earlier thread can no longer be stopped by the agent
    const answer = await h.gate.interrupt({ principal: LUNA, routeEpoch: h.ledger.routeEpoch(), generation: 2 }, { threadId: first })

    expect(['revoked', 'refused']).toContain(answer.class)
  })
})

describe('the assistant\'s own stop (T5) and the fence on interrupt', () => {
  it('stops its own thread; the queued one never starts', async () => {
    h = makeHarness()
    await launch()
    const threadId = row()?.threadId as string

    h.t3.queue(threadId)

    const answer = await h.gate.interrupt(h.ctx(LUNA), { threadId })

    expect(answer).toMatchObject({ class: 'ok', stopped: true, status: 'queued' })
    expect(h.t3.threads.get(threadId)?.runs.map(run => run.status)).toEqual(['interrupted', 'queued'])
    expect(h.t3.calls.find(item => item.tool === 'interrupt')?.args).toMatchObject({ stop: true })
  })

  it('refuses a thread that is not in this agent\'s ledger and one from before a session replacement', async () => {
    h = makeHarness()
    await launch(LUNA, REQ_1, EVENT_A)
    await launch(NOVA, REQ_2, EVENT_B)

    expect(await h.gate.interrupt(h.ctx(LUNA), { threadId: h.ledger.receipt(NOVA, REQ_2)?.threadId as string })).toMatchObject({
      class: 'refused',
      reason: 'not_in_ledger'
    })
    expect(await h.gate.interrupt(h.ctx(LUNA), { threadId: 'thread-owner-1' })).toMatchObject({ reason: 'not_in_ledger' })

    h.sessions.replace(LUNA)

    expect(await h.gate.interrupt(h.ctx(LUNA), { threadId: row()?.threadId as string })).toMatchObject({
      class: 'refused',
      reason: 'thread_from_earlier_session'
    })
    expect(h.t3.count('interrupt')).toBe(0)
  })
})

describe('freshness and the counters', () => {
  it('past the freshness bound every call is stale_entitlements; the next good sync reopens', async () => {
    h = makeHarness()
    const grant = h.gate.mintGrant(LUNA)

    expect(h.gate.checkGrant(grant.bearer)).toMatchObject({ ok: true })
    h.clock.advance(301_000)
    expect(h.gate.checkGrant(grant.bearer)).toMatchObject({ ok: false, error: 'stale_entitlements' })
    h.gate.noteGoodSync()
    expect(h.gate.checkGrant(grant.bearer)).toMatchObject({ ok: true })
  })

  it('a head that regressed makes the list stale at once', async () => {
    h = makeHarness()
    const grant = h.gate.mintGrant(LUNA)

    h.gate.noteHeadRegressed()
    expect(h.gate.checkGrant(grant.bearer)).toMatchObject({ error: 'stale_entitlements' })
  })

  it('a grant from an older epoch or generation is refused as revoked, never as unknown', async () => {
    h = makeHarness()
    const grant = h.gate.mintGrant(LUNA)

    h.gate.revoke({ scope: 'route', reason: 'sign_out' })
    h.ledger.setMeta('route_open', '1')
    expect(h.gate.checkGrant(grant.bearer)).toMatchObject({ ok: false, error: 'revoked' })
    expect(h.gate.checkGrant('x'.repeat(43))).toMatchObject({ ok: false, error: 'unknown_grant' })
  })

  it('minting replaces the old grant at once and stores only a hash', async () => {
    h = makeHarness()
    const first = h.gate.mintGrant(LUNA)
    const second = h.gate.mintGrant(LUNA)

    expect(first.bearer).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(h.gate.checkGrant(first.bearer)).toMatchObject({ error: 'revoked' })
    expect(h.gate.checkGrant(second.bearer)).toMatchObject({ ok: true })
    expect(JSON.stringify(h.ledger.grantByHash(second.hash))).not.toContain(second.bearer)
  })

  it('the reply is silenced at release when the counters moved during the call', async () => {
    h = makeHarness()
    const ctx = h.ctx(LUNA)

    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    const released = h.gate.silence(ctx, { class: 'ok' }, () => ({ class: 'revoked' }))

    expect(released).toEqual({ class: 'revoked' })
  })
})
