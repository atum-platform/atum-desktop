import { afterEach, describe, expect, it } from 'vitest'

import type { WorkSyncPage } from './contract'
import { GateLedger } from './ledger'
import type { StopReport, WorkPlatform } from './ports'
import { WorkSync } from './sync'
import { ACCOUNT, DEVICE, EVENT_A, type Harness, LUNA, makeHarness, NOVA, REQ_1 } from './test-support'

// Round 2 of the security review (2026-11-21): a retry that outlives its cutoff, a re-added agent whose grant must stay carriable,
// the reopen after a key rotation, a strictly ordered event time, and an outbox that never strands a valid report.

let h: Harness

afterEach(async () => h?.cleanup())

const launch = (requestId = REQ_1, event = EVENT_A) => h.gate.launch(h.ctx(LUNA), h.args(requestId, event))
const row = (requestId = REQ_1) => h.ledger.receipt(LUNA, requestId)
const settled = () => h.gate.scheduleSettle()
const revokeLuna = () => h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })

describe('1. a retry that is still running is not "nothing started"', () => {
  it('first send to process A, retry to process B (reply lost): B answering "absent" proves nothing; only a later process does', async () => {
    h = makeHarness()
    h.t3.loseNextBytes = true
    await launch()
    h.t3.restart() // B
    h.t3.loseNextBytes = true
    await launch()

    expect(row()).toMatchObject({ forwardCount: 2, incarnation: 'inc-2', priorIncarnation: 'inc-1' })

    revokeLuna()
    await settled()

    // the cleanup reads through B, which may still be processing the retry: the stop is owed and the claim stays
    expect(row()?.settled).toBeNull()
    expect(h.ledger.eventClaimed(EVENT_A)).toBe(true)
    expect(h.gate.state().stopsOwed.total).toBe(1)

    h.t3.restart() // C: a process that never saw either send
    await settled()

    expect(row()?.settled).toBe('nothing_started')
  })

  it('a rejection of the retry leaves the FIRST send as the one that must be gone (the earlier proof still counts)', async () => {
    h = makeHarness()
    h.t3.loseNextBytes = true
    await launch()
    h.t3.restart()
    h.t3.rejectWith = { code: 'model_unavailable' }
    await launch()

    // the retry was answered for good, so only the first send (process A) is unresolved
    expect(row()).toMatchObject({ state: 'admitted', reason: 't3_model_unavailable', incarnation: 'inc-1', priorIncarnation: null })

    revokeLuna()
    await settled()
    expect(row()?.settled).toBe('nothing_started')
  })

  it('a read that straddles a restart has no process to credit: it proves nothing, the next pass does', async () => {
    h = makeHarness()
    h.t3.loseNextBytes = true
    await launch()

    const read = h.t3.read.bind(h.t3)
    let first = true

    h.t3.read = async (token, threadId) => {
      const answer = await read(token, threadId)

      if (first) {
        first = false
        h.t3.restart()
      }

      return answer
    }

    revokeLuna()
    await settled()

    // settled, but never on the read that crossed the restart: a second read, by one process, came first
    expect(row()?.settled).toBe('nothing_started')
    expect(h.t3.calls.filter(call => call.tool === 'read' && call.args === row()?.threadId)).toHaveLength(2)
  })

  it('`stopped` needs T3\'s explicit success: a reply that is not a 200 result is not a Stop, whatever the next read shows', async () => {
    h = makeHarness()
    h.t3.autoRunning = false
    await launch()
    const interrupt = h.t3.interrupt.bind(h.t3)

    h.t3.interrupt = async () => ({ transport: 'ok', status: 502, isError: false, data: null, code: null })
    revokeLuna()
    await settled()

    expect(row()?.settled).toBeNull()
    expect(h.ledger.pending('stop_report')).toHaveLength(0)

    h.t3.interrupt = interrupt
    await settled()
    expect(row()?.settled).toBe('stopped')
  })
})

/**
 * A small model of the platform's rules for the Mac's events and grants (0523/0524), so the Mac is tested against what the platform
 * does with the order it gets, not against a stub that says yes to everything.
 */
function modelPlatform() {
  const model = {
    log: [] as string[],
    pages: [] as WorkSyncPage[],
    entitled: [LUNA, NOVA] as string[],
    routeState: 'open' as 'open' | 'closed',
    staleEnrollment: false,
    barrier: 0,
    applied: 0,
    eventAt: 0,
    offlineEvents: false,
    grants: new Map<string, { generation: number; epoch: number }>(),
    closedGeneration: new Map<string, number>(),
    eventTimes: [] as number[],
    reports: [] as StopReport[],
    rejectReport: (_: StopReport) => false,
    reportCalls: [] as number[]
  }

  const platform: WorkPlatform = {
    async enroll() {
      model.log.push('enroll')
      model.staleEnrollment = false

      return { work: null }
    },
    async pull(input) {
      model.log.push('pull')

      return (
        model.pages.shift() ?? ({ deviceServiceId: DEVICE, accountId: ACCOUNT, issuedAt: 1, fromSeq: input.appliedSeq, headSeq: input.appliedSeq, entitled: model.entitled, changes: [], hasMore: false } satisfies WorkSyncPage)
      )
    },
    async ack(ack) {
      model.log.push('ack')
      model.applied = Math.max(model.applied, ack.appliedSeq)
    },
    async macEvent(event) {
      if (model.offlineEvents) {
        throw Object.assign(new Error('503'), { status: 503 })
      }

      model.log.push(`event:${event.kind}`)
      model.eventTimes.push(event.at)

      if (event.kind === 'agent_closed') {
        const agent = event.agentPrincipal as string
        const generation = event.agentGeneration as number

        model.closedGeneration.set(agent, Math.max(model.closedGeneration.get(agent) ?? 0, generation))

        if ((model.grants.get(agent)?.generation ?? 99) <= generation) {
          model.grants.delete(agent)
        }
      } else if (event.kind === 'route_closed') {
        model.grants.clear()
        model.routeState = 'closed'
        model.eventAt = event.at
      } else if (event.kind === 'route_opened') {
        const held = model.staleEnrollment || model.barrier > model.applied || event.at < model.eventAt || (event.at === model.eventAt && model.routeState === 'closed')

        if (!held) {
          model.routeState = 'open'
          model.eventAt = event.at
        }
      }

      return { routeState: model.routeState }
    },
    async carryGrant(carry) {
      model.log.push('carry')

      if (model.staleEnrollment) {
        throw Object.assign(new Error('409'), { status: 409 })
      }

      if (model.routeState !== 'open') {
        throw Object.assign(new Error('403'), { status: 403 })
      }

      if (carry.agentGeneration <= (model.closedGeneration.get(carry.agentPrincipal) ?? 0)) {
        throw Object.assign(new Error('409'), { status: 409 })
      }

      model.grants.set(carry.agentPrincipal, { generation: carry.agentGeneration, epoch: carry.gateId.routeEpoch })
    },
    async reportSettlements(input) {
      model.reportCalls.push(input.reports.length)

      if (input.reports.some(report => model.rejectReport(report))) {
        throw Object.assign(new Error('400'), { status: 400 })
      }

      model.reports.push(...input.reports)
    }
  }

  return { model, platform }
}

const syncFor = (platform: WorkPlatform) =>
  new WorkSync({ gate: h.gate, ledger: h.ledger, platform, accountId: ACCOUNT, deviceServiceId: DEVICE, now: h.clock.now, socketPath: () => '/tmp/g.sock' })

const change = (seq: number, kind: 'agent_added' | 'agent_removed', agentPrincipal: string) =>
  kind === 'agent_removed' ? ({ seq, kind, agentPrincipal, scope: 'owner', at: seq } as const) : ({ seq, kind, agentPrincipal, at: seq } as const)

const page = (over: Partial<WorkSyncPage>): WorkSyncPage => ({ deviceServiceId: DEVICE, accountId: ACCOUNT, issuedAt: 1, fromSeq: 0, headSeq: 0, entitled: [], changes: [], hasMore: false, ...over })

describe('2. removing and re-adding an agent does not strand its grant', () => {
  it('the close names the RETIRED generation; the replacement grant (the new generation) is carried after it and survives it', async () => {
    h = makeHarness()
    const { model, platform } = modelPlatform()
    const sync = syncFor(platform)

    await sync.tick()
    expect(model.grants.get(LUNA)?.generation).toBe(1)

    // removed (owner), then added back: the Mac cuts generation 1 off and moves to 2
    model.pages.push(page({ fromSeq: 0, headSeq: 1, entitled: [NOVA], changes: [change(1, 'agent_removed', LUNA)] }))
    await sync.tick()
    expect(h.ledger.agent(LUNA)).toMatchObject({ generation: 2, entitled: false })
    expect(model.closedGeneration.get(LUNA)).toBe(1)

    model.pages.push(page({ fromSeq: 1, headSeq: 2, entitled: [LUNA, NOVA], changes: [change(2, 'agent_added', LUNA)] }))
    await sync.tick()

    expect(model.grants.get(LUNA)).toMatchObject({ generation: 2 })
    expect(model.log.lastIndexOf('event:agent_closed')).toBeLessThan(model.log.lastIndexOf('carry'))
  })

  it('a close that reaches the platform AFTER the replacement was carried does not delete it', async () => {
    h = makeHarness()
    const { model, platform } = modelPlatform()
    const sync = syncFor(platform)

    await sync.tick()
    revokeLuna()
    h.ledger.setEntitled(LUNA, true)
    // the close is still queued: deliver the replacement first, as an earlier ordering would have
    const minted = h.gate.mintGrant(LUNA)

    await platform.carryGrant({ gateId: { deviceServiceId: DEVICE, accountId: ACCOUNT, routeEpoch: h.ledger.routeEpoch() }, agentPrincipal: LUNA, grant: minted.bearer, agentGeneration: minted.generation, mintedAt: minted.mintedAt, expiresAt: minted.expiresAt })
    await sync.flush()

    expect(model.grants.get(LUNA)).toMatchObject({ generation: 2 })
  })
})

describe('3. recovery from a key rotation is explicit', () => {
  function rotated() {
    h = makeHarness()
    const fixture = modelPlatform()

    // the platform closed the route and holds it until this Mac applied the cutoffs and enrolled again
    fixture.model.staleEnrollment = true
    fixture.model.routeState = 'closed'
    fixture.model.barrier = 2
    fixture.model.entitled = []
    fixture.model.pages.push(page({ fromSeq: 0, headSeq: 2, entitled: [], changes: [change(1, 'agent_removed', LUNA), change(2, 'agent_removed', NOVA)] }))

    return fixture
  }

  it('apply the cutoff, confirm the ack, enroll again, then publish open; grants only after the platform says open', async () => {
    const { model, platform } = rotated()
    const sync = syncFor(platform)

    await sync.tick()

    const at = (entry: string) => model.log.indexOf(entry)

    expect(at('ack')).toBeGreaterThan(-1)
    expect(at('ack')).toBeLessThan(at('enroll'))
    expect(at('enroll')).toBeLessThan(at('event:route_opened'))
    expect(model.routeState).toBe('open')
    expect(model.log).not.toContain('carry') // nobody is entitled yet: the removals stand

    model.entitled = [LUNA, NOVA]
    model.pages.push(page({ fromSeq: 2, headSeq: 4, entitled: [LUNA, NOVA], changes: [change(3, 'agent_added', LUNA), change(4, 'agent_added', NOVA)] }))
    await sync.tick()

    expect(model.grants.get(LUNA)).toMatchObject({ generation: 2 })
    expect(model.grants.get(NOVA)).toMatchObject({ generation: 2 })
  })

  it('an open the platform holds (answers `closed`) stays queued and is sent again; nothing is carried meanwhile', async () => {
    const { model, platform } = rotated()
    const sync = syncFor(platform)

    model.barrier = 99 // the platform will not take the open yet
    await sync.tick()

    expect(model.routeState).toBe('closed')
    expect(h.ledger.pending('mac_event').map(item => JSON.parse(item.payload).kind)).toContain('route_opened')
    expect(model.log).not.toContain('carry')

    model.barrier = 0
    await sync.tick()

    expect(model.routeState).toBe('open')
    expect(h.ledger.pending('mac_event').filter(item => JSON.parse(item.payload).kind === 'route_opened')).toHaveLength(0)
  })

  it('a restart queues the open itself: the route the platform does not hold open is reopened without the owner touching the switch', async () => {
    h = makeHarness()
    const { model, platform } = modelPlatform()

    model.routeState = 'closed'
    await syncFor(platform).tick()

    expect(model.log).toContain('enroll')
    expect(model.routeState).toBe('open')
    expect(h.ledger.platformRoute()).toBe('open')
  })

  it('consent withdrawn or the switch off: nothing is published', async () => {
    h = makeHarness()
    const { model, platform } = modelPlatform()

    h.ledger.setMeta('switch_on', '0')
    model.routeState = 'closed'
    await syncFor(platform).tick()

    expect(model.log).not.toContain('event:route_opened')
    expect(model.log).not.toContain('carry')
  })
})

describe('4. events keep a strict order, and grants wait for the events', () => {
  it('two events in one millisecond, a clock set back and a restart never give an earlier event a later-or-equal time', () => {
    h = makeHarness()
    const first = h.ledger.nextEventAt()
    const second = h.ledger.nextEventAt()

    expect(second).toBeGreaterThan(first)

    const path = `${h.dir}/ledger.sqlite`
    h.ledger.close()

    const reopened = new GateLedger(path, ACCOUNT, () => first - 60_000) // the clock was corrected backwards
    const third = reopened.nextEventAt()

    expect(third).toBeGreaterThan(second)
    reopened.close()
    h.ledger = new GateLedger(path, ACCOUNT, h.clock.now)
  })

  it('an off/on cycle inside one millisecond queues close < open, and the platform applies the open', async () => {
    h = makeHarness()
    const { model, platform } = modelPlatform()

    h.gate.revoke({ scope: 'route', reason: 'switch_off' })
    h.ledger.setMeta('route_open', '1')
    h.ledger.enqueueMacEvent({ kind: 'route_opened', routeEpoch: h.ledger.routeEpoch() })

    const times = h.ledger.pending('mac_event').map(item => JSON.parse(item.payload).at as number)

    expect(times[1]).toBeGreaterThan(times[0])
    await syncFor(platform).flush()
    expect(model.routeState).toBe('open')
  })

  it('an offline off/on cycle: no grant is carried while the close and the reopen are queued, and the one carried after them stays', async () => {
    h = makeHarness()
    const { model, platform } = modelPlatform()
    const sync = syncFor(platform)

    await sync.tick()
    expect(model.grants.size).toBe(2)

    // off and on while the events cannot be delivered
    model.offlineEvents = true
    h.gate.revoke({ scope: 'route', reason: 'switch_off' })
    h.ledger.setMeta('route_open', '1')
    h.ledger.enqueueMacEvent({ kind: 'route_opened', routeEpoch: h.ledger.routeEpoch() })

    await sync.tick()
    expect(model.log.filter(entry => entry === 'carry')).toHaveLength(2) // only the first tick's

    model.offlineEvents = false
    await sync.tick()

    expect(model.routeState).toBe('open')
    expect(model.grants.get(LUNA)).toMatchObject({ epoch: h.ledger.routeEpoch() })
    expect(model.grants.get(NOVA)).toMatchObject({ epoch: h.ledger.routeEpoch() })
    expect(model.log.lastIndexOf('event:route_opened')).toBeLessThan(model.log.lastIndexOf('carry'))
  })
})

const report = (index: number): StopReport => ({
  agentPrincipal: LUNA,
  requestId: `${'A'.repeat(20)}${String(index).padStart(2, '0')}`,
  routeEpochAtAdmit: 1,
  agentGenerationAtAdmit: 1,
  scope: 'agent',
  outcome: 'stopped',
  revocationId: 1,
  settledAt: 1_795_000_000_000
})

describe('9. rejected reports have their own schedule', () => {
  it('a full leading batch the platform keeps refusing does not hold back the reports behind it', async () => {
    h = makeHarness()
    const { model, platform } = modelPlatform()
    const bad = new Set<string>()

    for (let i = 0; i < 64; i++) {
      bad.add(report(i).requestId)
      h.ledger.enqueue('stop_report', report(i))
    }

    for (let i = 64; i < 67; i++) {
      h.ledger.enqueue('stop_report', report(i))
    }

    model.rejectReport = item => bad.has(item.requestId)
    const sync = syncFor(platform)

    await sync.flush()
    await sync.flush()

    expect(model.reports.map(item => item.requestId)).toEqual([64, 65, 66].map(index => report(index).requestId))
    expect(h.ledger.pending('stop_report')).toHaveLength(64)

    // the refused ones wait on their own clock, not in the batch: nothing is re-sent before it
    const calls = model.reportCalls.length

    await sync.flush()
    expect(model.reportCalls).toHaveLength(calls)

    h.clock.advance(60_000)
    await sync.flush()
    expect(model.reportCalls.length).toBeGreaterThan(calls)
  })
})
