import { afterEach, describe, expect, it } from 'vitest'

import type { WorkSyncPage } from './contract'
import type { StopReport, WorkPlatform } from './ports'
import { WorkSync } from './sync'
import { ACCOUNT, DEVICE, EVENT_A, type Harness, LUNA, makeHarness, NOVA, REQ_1 } from './test-support'

// The revocation sync (contract work.sync.*): the Mac pulls, applies in order with no gap, durably, and only then
// acknowledges; settledSeq moves only when every row in scope is settled. Review R4-1: how the helper learns that a
// stop is confirmed after the old credential is dead.

let h: Harness

afterEach(async () => h?.cleanup())

interface FakePlatform extends WorkPlatform {
  pages: WorkSyncPage[]
  pulls: number[]
  acks: { appliedSeq: number; settledSeq: number }[]
  events: { kind: string; agentPrincipal?: string }[]
  carried: { agentPrincipal: string; grant: string; agentGeneration: number }[]
  reports: StopReport[]
  settlementCalls: { deviceServiceId: string; accountId: string; routeEpoch: number; reports: StopReport[] }[]
  /** What the next settlement calls do: an error with a status, or nothing (accepted). Consumed one per call. */
  settlementFailures: ({ status?: number } | null)[]
  offline: boolean
  failCarry: boolean
}

function platform(withReports = false): FakePlatform {
  const fake: FakePlatform = {
    pages: [],
    pulls: [],
    acks: [],
    events: [],
    carried: [],
    reports: [],
    settlementCalls: [],
    settlementFailures: [],
    offline: false,
    failCarry: false,
    async enroll() {
      return { work: null }
    },
    async pull(input) {
      fake.pulls.push(input.appliedSeq)

      if (fake.offline) {
        throw new Error('offline')
      }

      return fake.pages.shift() ?? page({ fromSeq: input.appliedSeq, headSeq: input.appliedSeq, entitled: [LUNA, NOVA] })
    },
    async ack(ack) {
      fake.acks.push({ appliedSeq: ack.appliedSeq, settledSeq: ack.settledSeq })
    },
    async macEvent(event) {
      fake.events.push({ kind: event.kind, agentPrincipal: event.agentPrincipal })
    },
    async carryGrant(carry) {
      if (fake.failCarry) {
        throw new Error('carry failed')
      }

      fake.carried.push({ agentPrincipal: carry.agentPrincipal, grant: carry.grant, agentGeneration: carry.agentGeneration })
    }
  }

  if (withReports) {
    fake.reportSettlements = async input => {
      fake.settlementCalls.push(input)

      const failure = fake.settlementFailures.shift()

      if (failure) {
        throw Object.assign(new Error('settlements'), failure)
      }

      fake.reports.push(...input.reports)
    }
  }

  return fake
}

function page(over: Partial<WorkSyncPage>): WorkSyncPage {
  return { deviceServiceId: DEVICE, accountId: ACCOUNT, issuedAt: 1, fromSeq: 0, headSeq: 0, entitled: [LUNA, NOVA], changes: [], hasMore: false, ...over }
}

const syncFor = (fake: WorkPlatform) =>
  new WorkSync({ gate: h.gate, ledger: h.ledger, platform: fake, accountId: ACCOUNT, deviceServiceId: DEVICE, now: h.clock.now, socketPath: () => '/tmp/g.sock' })

describe('pull, apply, acknowledge', () => {
  it('applies a page durably, then acknowledges; the platform\'s list becomes the entitlement list', async () => {
    h = makeHarness()
    const fake = platform()

    h.ledger.setEntitled(NOVA, false)
    fake.pages.push(page({ fromSeq: 0, headSeq: 2, entitled: [LUNA, NOVA], changes: [{ seq: 1, kind: 'agent_added', agentPrincipal: LUNA, at: 1 }, { seq: 2, kind: 'agent_added', agentPrincipal: NOVA, at: 2 }] }))

    expect(await syncFor(fake).tick()).toBe('ok')
    expect(h.ledger.appliedSeq()).toBe(2)
    expect(h.ledger.agent(NOVA)?.entitled).toBe(true)
    expect(fake.acks.at(-1)).toEqual({ appliedSeq: 2, settledSeq: 2 })
  })

  it('mints a grant for every entitled agent and carries it; only the hash stays on the Mac', async () => {
    h = makeHarness()
    const fake = platform()

    await syncFor(fake).tick()

    expect(fake.carried.map(item => item.agentPrincipal).sort()).toEqual([LUNA, NOVA].sort())
    const carried = fake.carried.find(item => item.agentPrincipal === LUNA)

    expect(carried?.grant).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(h.gate.checkGrant(carried?.grant as string)).toMatchObject({ ok: true })
    expect(JSON.stringify(h.ledger.liveGrant(LUNA))).not.toContain(carried?.grant as string)
    expect(h.ledger.liveGrant(LUNA)?.carried).toBe(true)

    // a second tick mints nothing new: one live grant per agent
    await syncFor(fake).tick()
    expect(fake.carried).toHaveLength(2)
  })

  it('a grant the platform could not carry is dropped, not left usable', async () => {
    h = makeHarness()
    const fake = platform()

    fake.failCarry = true
    await syncFor(fake).tick()

    expect(h.ledger.liveGrant(LUNA)).toBeUndefined()
    fake.failCarry = false
    await syncFor(fake).tick()
    expect(h.ledger.liveGrant(LUNA)?.carried).toBe(true)
  })

  it('nothing is granted before the person accepted the Work screen (D9)', async () => {
    h = makeHarness()
    h.ledger.setMeta('work_grant_accepted_at', '')
    const fake = platform()

    // an unaccepted Mac: the meta key is absent
    h.ledger.tx(() => h.ledger.setMeta('route_open', '0'))
    await syncFor(fake).tick()

    expect(fake.carried).toHaveLength(0)
  })

  it('pages: hasMore is followed, and the list is applied at the last page only', async () => {
    h = makeHarness()
    const fake = platform()

    fake.pages.push(page({ fromSeq: 0, headSeq: 3, hasMore: true, entitled: [LUNA], changes: [{ seq: 1, kind: 'agent_added', agentPrincipal: LUNA, at: 1 }] }))
    fake.pages.push(page({ fromSeq: 1, headSeq: 3, hasMore: false, entitled: [LUNA, NOVA], changes: [{ seq: 2, kind: 'agent_added', agentPrincipal: NOVA, at: 1 }, { seq: 3, kind: 'agent_added', agentPrincipal: LUNA, at: 1 }] }))

    await syncFor(fake).tick()

    expect(fake.pulls).toEqual([0, 1])
    expect(h.ledger.appliedSeq()).toBe(3)
  })
})

describe('revocations that arrive over the sync', () => {
  it('an agent removed: the cutoff is durable before the acknowledgement, and settledSeq waits for the cleanup', async () => {
    h = makeHarness()
    const fake = platform()

    await h.gate.launch(h.ctx(LUNA), h.args(REQ_1, EVENT_A))
    fake.pages.push(page({ fromSeq: 0, headSeq: 1, entitled: [NOVA], changes: [{ seq: 1, kind: 'agent_removed', agentPrincipal: LUNA, scope: 'owner', at: 1 }] }))

    // T3 does not obey the stop yet: the row stays owed
    const interrupt = h.t3.interrupt.bind(h.t3)

    h.t3.interrupt = async (token: string, threadId: string) => {
      h.t3.calls.push({ tool: 'interrupt', token })
      void threadId

      return { transport: 'ok' as const, status: 200, isError: false, data: {} }
    }

    await syncFor(fake).tick()
    await h.gate.scheduleSettle()

    expect(h.ledger.agent(LUNA)).toMatchObject({ entitled: false, generation: 2 })
    expect(h.ledger.agent(NOVA)?.generation).toBe(1)
    expect(fake.acks.at(-1)).toEqual({ appliedSeq: 1, settledSeq: 0 })

    h.t3.interrupt = interrupt
    await h.gate.scheduleSettle()
    await syncFor(fake).tick()

    expect(fake.acks.at(-1)).toEqual({ appliedSeq: 1, settledSeq: 1 })
  })

  it('a device revoked closes the whole route: epoch moves, every grant dies, no agent is entitled', async () => {
    h = makeHarness()
    const fake = platform()

    await syncFor(fake).tick()
    const grant = fake.carried[0].grant

    fake.pages.push(page({ fromSeq: 0, headSeq: 1, entitled: [], changes: [{ seq: 1, kind: 'device_revoked', at: 1 }] }))
    await syncFor(fake).tick()

    expect(h.ledger.routeEpoch()).toBe(2)
    expect(h.gate.routeOpen()).toBe(false)
    expect(h.gate.checkGrant(grant)).toMatchObject({ ok: false, error: 'revoked' })
    expect(h.ledger.agents().every(agent => !agent.entitled)).toBe(true)
  })

  it('an agent the list does not name is removed here even without a change record (the list is authoritative)', async () => {
    h = makeHarness()
    const fake = platform()

    fake.pages.push(page({ fromSeq: 0, headSeq: 5, entitled: [NOVA], changes: [] }))
    // a head ahead with no changes between: a gap
    expect(await syncFor(fake).tick()).toBe('ok')
    expect(h.ledger.agent(LUNA)?.entitled).toBe(false)
    expect(h.ledger.agent(LUNA)?.generation).toBe(2)
  })

  it('a gap in the sequence is not applied and the list is not made fresh', async () => {
    h = makeHarness()
    const fake = platform()

    h.clock.advance(400_000)
    fake.pages.push(page({ fromSeq: 0, headSeq: 3, changes: [{ seq: 2, kind: 'agent_added', agentPrincipal: LUNA, at: 1 }] }))

    expect(await syncFor(fake).tick()).toBe('gap')
    expect(h.ledger.appliedSeq()).toBe(0)
    expect(h.gate.entitlementsFresh()).toBe(false)
  })

  it('a head behind our applied sequence is a regression: stale at once, nothing lowered', async () => {
    h = makeHarness()
    const fake = platform()

    h.ledger.setAppliedSeq(7)
    fake.pages.push(page({ fromSeq: 3, headSeq: 3 }))

    expect(await syncFor(fake).tick()).toBe('regressed')
    expect(h.ledger.appliedSeq()).toBe(7)
    expect(h.gate.entitlementsFresh()).toBe(false)
  })

  it('a page about another Mac or account is refused', async () => {
    h = makeHarness()
    const fake = platform()

    fake.pages.push(page({ deviceServiceId: '67000000-0000-4000-8000-0000000000ff' }))

    expect(await syncFor(fake).tick()).toBe('invalid')
  })

  it('offline: the freshness bound runs out and the gate fails closed; the next good pull reopens it', async () => {
    h = makeHarness()
    const fake = platform()
    const sync = syncFor(fake)

    await sync.tick()
    expect(h.gate.entitlementsFresh()).toBe(true)

    fake.offline = true
    h.clock.advance(301_000)
    expect(await sync.tick()).toBe('offline')
    expect(h.gate.entitlementsFresh()).toBe(false)

    fake.offline = false
    expect(await sync.tick()).toBe('ok')
    expect(h.gate.entitlementsFresh()).toBe(true)
  })

  it('a Mac that was offline applies every change it missed before the gate serves anything', async () => {
    h = makeHarness()
    const fake = platform()

    h.clock.advance(3_600_000)
    expect(h.gate.entitlementsFresh()).toBe(false)
    fake.pages.push(page({ fromSeq: 0, headSeq: 2, entitled: [NOVA], changes: [{ seq: 1, kind: 'agent_added', agentPrincipal: NOVA, at: 1 }, { seq: 2, kind: 'agent_removed', agentPrincipal: LUNA, scope: 'this_mac', at: 2 }] }))
    await syncFor(fake).tick()

    expect(h.ledger.agent(LUNA)?.entitled).toBe(false)
    expect(h.gate.entitlementsFresh()).toBe(true)
  })
})

describe('R4-1: how the helper learns a confirmed stop after its credential is dead', () => {
  it('Mac events are delivered; stop reports stay queued until the platform can carry them', async () => {
    h = makeHarness()
    const fake = platform()

    await h.gate.launch(h.ctx(LUNA), h.args(REQ_1, EVENT_A))
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    await h.gate.scheduleSettle()
    await syncFor(fake).flush()

    expect(fake.events).toEqual([{ kind: 'agent_closed', agentPrincipal: LUNA }])
    expect(h.ledger.pending('mac_event')).toHaveLength(0)
    // the platform has no operation for them yet: kept, and counted for the Settings surface
    expect(h.ledger.pending('stop_report')).toHaveLength(1)
    expect(h.gate.state().undeliveredReports).toBe(1)
  })

  it('once the platform carries them: one content-free report per request, delivered once', async () => {
    h = makeHarness()
    const fake = platform(true)

    await h.gate.launch(h.ctx(LUNA), h.args(REQ_1, EVENT_A))
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    await h.gate.scheduleSettle()
    await syncFor(fake).flush()
    await syncFor(fake).flush()

    expect(fake.reports).toEqual([
      expect.objectContaining({ agentPrincipal: LUNA, requestId: REQ_1, outcome: 'stopped', scope: 'agent', routeEpochAtAdmit: 1, agentGenerationAtAdmit: 1 })
    ])
    expect(JSON.stringify(fake.reports)).not.toContain('mcp:launch')
    expect(h.ledger.pending('stop_report')).toHaveLength(0)
  })

  it('a report is written only when the stop settled: a row still owed reports nothing', async () => {
    h = makeHarness()
    h.t3.loseNextBytes = true
    await h.gate.launch(h.ctx(LUNA), h.args(REQ_1, EVENT_A))
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    await h.gate.scheduleSettle()

    expect(h.ledger.pending('stop_report')).toHaveLength(0)
  })

  it('after a re-grant the same row still answers revoked: it is keyed by agent and request, not by grant', async () => {
    h = makeHarness()
    await h.gate.launch(h.ctx(LUNA), h.args(REQ_1, EVENT_A))
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    await h.gate.scheduleSettle()
    h.ledger.setEntitled(LUNA, true)

    const fresh = h.gate.mintGrant(LUNA)
    const grant = h.gate.checkGrant(fresh.bearer)

    expect(grant).toMatchObject({ ok: true })
    expect(await h.gate.request((grant as { ctx: ReturnType<Harness['ctx']> }).ctx, { requestId: REQ_1, action: 'status' })).toMatchObject({ class: 'revoked', scope: 'agent' })
  })
})

describe('settlement delivery (contract 1.1 work.mac.settlements)', () => {
  const REQ = (n: number) => `settlereq${String(n).padStart(13, '0')}`

  const report = (n: number, over: Partial<StopReport> = {}): StopReport => ({
    agentPrincipal: LUNA,
    requestId: REQ(n),
    routeEpochAtAdmit: 1,
    agentGenerationAtAdmit: 1,
    scope: 'agent',
    outcome: 'stopped',
    revocationId: 3,
    settledAt: 1_795_000_000_000,
    ...over
  })

  const queue = (...reports: StopReport[]) => reports.map(item => h.ledger.enqueue('stop_report', item))

  it('delivers through the new operation with the Mac, account and current epoch, in order, and clears only on the acknowledgement', async () => {
    h = makeHarness()
    const fake = platform(true)

    queue(report(1), report(2, { scope: 'route', outcome: 'never_sent' }))
    await syncFor(fake).flush()

    expect(fake.settlementCalls).toEqual([{ deviceServiceId: DEVICE, accountId: ACCOUNT, routeEpoch: h.ledger.routeEpoch(), reports: [report(1), report(2, { scope: 'route', outcome: 'never_sent' })] }])
    expect(h.ledger.pending('stop_report')).toHaveLength(0)
    expect(h.gate.state().undeliveredReports).toBe(0)
  })

  it('never sends a thread or any text: the batch is the contract\'s report and nothing else', async () => {
    h = makeHarness()
    const fake = platform(true)

    await h.gate.launch(h.ctx(LUNA), h.args(REQ_1, EVENT_A))
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    await h.gate.scheduleSettle()
    await syncFor(fake).flush()

    const sent = JSON.stringify(fake.settlementCalls)

    expect(sent).not.toContain('mcp:launch')
    expect(sent).not.toContain('threadId')
    expect(Object.keys(fake.settlementCalls[0]?.reports[0] ?? {}).sort()).toEqual(
      ['agentGenerationAtAdmit', 'agentPrincipal', 'outcome', 'requestId', 'revocationId', 'routeEpochAtAdmit', 'scope', 'settledAt']
    )
  })

  it('sends at most 64 a call, the next batch on the same flush cycle after the first is acknowledged', async () => {
    h = makeHarness()
    const fake = platform(true)

    queue(...Array.from({ length: 70 }, (_, index) => report(index + 1)))
    await syncFor(fake).flush()

    expect(fake.settlementCalls.map(call => call.reports.length)).toEqual([64])
    expect(h.ledger.pending('stop_report')).toHaveLength(6)

    await syncFor(fake).flush()
    expect(fake.settlementCalls.map(call => call.reports.length)).toEqual([64, 6])
    expect(h.ledger.pending('stop_report')).toHaveLength(0)
    expect(fake.reports.map(item => item.requestId)).toEqual(Array.from({ length: 70 }, (_, index) => REQ(index + 1)))
  })

  it('a failure keeps every report queued and backs off: 30 s, then 60 s, doubling, capped at 15 minutes', async () => {
    h = makeHarness()
    const fake = platform(true)
    const sync = syncFor(fake)

    queue(report(1))
    fake.settlementFailures.push({ status: 503 }, { status: 503 }, { status: 503 })

    await sync.flush()
    expect(h.ledger.pending('stop_report')).toHaveLength(1)
    expect(fake.settlementCalls).toHaveLength(1)

    h.clock.advance(29_000)
    await sync.flush()
    expect(fake.settlementCalls).toHaveLength(1) // still inside the first back-off

    h.clock.advance(1_000)
    await sync.flush()
    expect(fake.settlementCalls).toHaveLength(2)

    h.clock.advance(59_000)
    await sync.flush()
    expect(fake.settlementCalls).toHaveLength(2) // the second wait is 60 s

    h.clock.advance(1_000)
    await sync.flush()
    expect(fake.settlementCalls).toHaveLength(3)

    h.clock.advance(120_000)
    await sync.flush() // succeeds
    expect(fake.settlementCalls).toHaveLength(4)
    expect(h.ledger.pending('stop_report')).toHaveLength(0)

    // the failure count resets: the next failure waits the base step again
    queue(report(2))
    fake.settlementFailures.push({ status: 500 })
    await sync.flush()
    h.clock.advance(30_000)
    await sync.flush()
    expect(fake.settlementCalls).toHaveLength(6)
    expect(h.ledger.pending('stop_report')).toHaveLength(0)
  })

  it('a network failure (no status) backs off the same way and loses nothing', async () => {
    h = makeHarness()
    const fake = platform(true)
    const sync = syncFor(fake)

    queue(report(1))
    fake.settlementFailures.push({})
    await sync.flush()
    expect(h.ledger.pending('stop_report')).toHaveLength(1)
    h.clock.advance(30_000)
    await sync.flush()
    expect(h.ledger.pending('stop_report')).toHaveLength(0)
  })

  it('survives a restart: the queue is durable, and a fresh sync retries at once', async () => {
    h = makeHarness()
    const fake = platform(true)

    queue(report(1))
    fake.settlementFailures.push({ status: 503 })
    await syncFor(fake).flush()
    expect(h.ledger.pending('stop_report')).toHaveLength(1)

    await syncFor(fake).flush() // a new WorkSync (a restarted app) has no back-off memory
    expect(h.ledger.pending('stop_report')).toHaveLength(0)
  })

  it('a platform 400 isolates the refused report: the rest are cleared, the refused one stays queued', async () => {
    h = makeHarness()
    const fake = platform(true)

    queue(report(1), report(2), report(3))
    fake.settlementFailures.push({ status: 400 }, null, { status: 400 }) // the batch, then report 1 ok, report 2 refused (report 3 ok)
    await syncFor(fake).flush()

    expect(fake.reports.map(item => item.requestId)).toEqual([REQ(1), REQ(3)])
    expect(h.ledger.pending('stop_report').map(row => (JSON.parse(row.payload) as StopReport).requestId)).toEqual([REQ(2)])
  })

  it('an old platform that answers 400 to everything loses nothing: every report stays queued', async () => {
    h = makeHarness()
    const fake = platform(true)

    queue(report(1), report(2))
    fake.settlementFailures.push({ status: 400 }, { status: 400 }, { status: 400 })
    await syncFor(fake).flush()

    expect(h.ledger.pending('stop_report')).toHaveLength(2)
    expect(h.gate.state().undeliveredReports).toBe(2)
  })

  it('a report that cannot be sent from here is dropped with a log line; one the platform may still take is kept', async () => {
    h = makeHarness()
    const fake = platform(true)
    const logged: string[] = []
    const sync = new WorkSync({ gate: h.gate, ledger: h.ledger, platform: fake, accountId: ACCOUNT, deviceServiceId: DEVICE, now: h.clock.now, socketPath: () => '/tmp/g.sock', log: event => void logged.push(event) })

    h.ledger.enqueue('stop_report', { requestId: 'short', outcome: 'completed' }) // fails the contract
    h.ledger.enqueue('stop_report', { ...report(1), threadId: 'mcp:launch:x' }) // content: an unknown field is refused, not trimmed
    queue(report(2, { routeEpochAtAdmit: h.ledger.routeEpoch() + 1 })) // admitted above this Mac's current epoch
    queue(report(3))
    await sync.flush()

    expect(fake.reports.map(item => item.requestId)).toEqual([REQ(3)])
    expect(h.ledger.pending('stop_report')).toHaveLength(0)
    expect(logged.filter(event => event === 'stop_report_dropped')).toHaveLength(3)
  })

  it('a report older than the platform\'s retention is dropped, a recent one is not', async () => {
    h = makeHarness()
    const fake = platform(true)

    queue(report(1))
    h.clock.advance(31 * 86_400_000)
    queue(report(2))
    await syncFor(fake).flush()

    expect(fake.reports.map(item => item.requestId)).toEqual([REQ(2)])
  })

  it('without the operation (a stand-in platform) reports stay queued and nothing is thrown', async () => {
    h = makeHarness()
    const fake = platform(false)

    queue(report(1))
    await expect(syncFor(fake).flush()).resolves.toBeUndefined()
    expect(h.ledger.pending('stop_report')).toHaveLength(1)
  })

  it('tick() delivers the queue as part of its cycle, after the grants', async () => {
    h = makeHarness()
    const fake = platform(true)

    queue(report(1))
    await syncFor(fake).tick()

    expect(fake.reports.map(item => item.requestId)).toEqual([REQ(1)])
    expect(fake.carried.length).toBeGreaterThan(0)
  })
})
