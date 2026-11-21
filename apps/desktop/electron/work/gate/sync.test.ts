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
    fake.reportSettlements = async reports => {
      fake.reports.push(...reports)
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
