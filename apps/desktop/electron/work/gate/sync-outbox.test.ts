import { afterEach, describe, expect, it } from 'vitest'

import type { WorkSyncPage } from './contract'
import type { StopReport, WorkPlatform } from './ports'
import { WorkSync } from './sync'
import { ACCOUNT, DEVICE, type Harness, LUNA, makeHarness, REQ_1, EVENT_A } from './test-support'

// The outbox after an offline switch cycle: obsolete route events are superseded when the platform has moved on, the
// events behind a refused one are not wedged, the cutoff and its event are one commit, and a retirement delivers the
// cutoff and the settled reports once, within a bound.

let h: Harness

afterEach(async () => h?.cleanup())

interface Event {
  kind: string
  routeEpoch: number
  agentPrincipal?: string
}

function platform(onEvent: (event: Event) => void | Promise<void>) {
  const delivered: Event[] = []
  const reports: StopReport[] = []

  const fake: WorkPlatform & { delivered: Event[]; reports: StopReport[]; acks: number } = {
    delivered,
    reports,
    acks: 0,
    enroll: async () => ({ work: null }),
    pull: async input => ({ deviceServiceId: DEVICE, accountId: ACCOUNT, issuedAt: 1, fromSeq: input.appliedSeq, headSeq: input.appliedSeq, entitled: [LUNA], changes: [], hasMore: false }) satisfies WorkSyncPage,
    ack: async () => void fake.acks++,
    macEvent: async event => {
      await onEvent(event)
      delivered.push(event)
    },
    carryGrant: async () => undefined,
    reportSettlements: async input => void reports.push(...input.reports)
  }

  return fake
}

const syncFor = (fake: WorkPlatform) =>
  new WorkSync({ gate: h.gate, ledger: h.ledger, platform: fake, accountId: ACCOUNT, deviceServiceId: DEVICE, now: h.clock.now, socketPath: () => '/tmp/g.sock' })

const refuse = (status: number) => Object.assign(new Error('refused'), { status })

describe('the cutoff and its event are one commit', () => {
  it('the cutoff queues its report in its own transaction: a crash before `finishRevoke` loses neither', () => {
    h = makeHarness()
    h.gate.beginRevoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })

    const queued = h.ledger.pending('mac_event').map(row => JSON.parse(row.payload))

    expect(queued).toEqual([expect.objectContaining({ kind: 'agent_closed', agentPrincipal: LUNA, agentGeneration: 2 })])
  })

  it('a cutoff that rolls back leaves no event behind', () => {
    h = makeHarness()

    expect(() =>
      h.ledger.tx(() => {
        h.gate.beginRevoke({ scope: 'route', reason: 'switch_off' })
        throw new Error('crash')
      })
    ).toThrow('crash')
    expect(h.ledger.pending('mac_event')).toHaveLength(0)
    expect(h.ledger.routeEpoch()).toBe(1)
  })
})

describe('an offline switch cycle does not wedge the outbox', () => {
  function cycle() {
    // off, on, off, on while offline: four route events queued, then an agent's cutoff
    for (let i = 0; i < 2; i++) {
      h.gate.revoke({ scope: 'route', reason: 'switch_off' })
      h.ledger.setMeta('route_open', '1')
      h.ledger.enqueue('mac_event', { kind: 'route_opened', routeEpoch: h.ledger.routeEpoch(), at: h.clock.now() })
    }

    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
  }

  it('the platform refuses the stale route events (its epoch moved on): they are superseded by the newest, and the agent\'s cutoff still goes out', async () => {
    h = makeHarness()
    cycle()
    const newest = h.ledger.routeEpoch()

    const fake = platform(event => {
      if (event.kind.startsWith('route_') && event.routeEpoch < newest) {
        throw refuse(409)
      }
    })

    await syncFor(fake).flush()

    // epoch 2's closed and opened were refused and superseded; epoch 3's own events, and the agent's cutoff, arrived
    expect(fake.delivered.map(event => event.kind)).toEqual(['route_closed', 'route_opened', 'agent_closed'])
    expect(fake.delivered.every(event => event.routeEpoch >= newest)).toBe(true)
    expect(h.ledger.pending('mac_event')).toHaveLength(0)
  })

  it('the newest event of a family is never dropped on a refusal; the events behind it still go', async () => {
    h = makeHarness()
    h.gate.revoke({ scope: 'route', reason: 'switch_off' })
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })

    const fake = platform(event => {
      if (event.kind === 'route_closed') {
        throw refuse(409)
      }
    })

    await syncFor(fake).flush()

    expect(fake.delivered.map(event => event.kind)).toEqual(['agent_closed'])
    expect(h.ledger.pending('mac_event').map(row => JSON.parse(row.payload).kind)).toEqual(['route_closed'])
  })

  it.each([401, 403, 408, 429, 500, 503])('a %s is not an answer about the event: nothing is dropped and the order holds', async status => {
    h = makeHarness()
    cycle()
    const before = h.ledger.pending('mac_event').length

    await syncFor(platform(() => void (() => { throw refuse(status) })())).flush()

    expect(h.ledger.pending('mac_event')).toHaveLength(before)
  })
})

describe('retirement delivers what is owed before the credential goes', () => {
  it('flushBounded sends the cutoff, the settled reports and the acknowledgement', async () => {
    h = makeHarness()
    await h.gate.launch(h.ctx(LUNA), h.args(REQ_1, EVENT_A))
    h.gate.revoke({ scope: 'route', reason: 'sign_out' })
    await h.gate.scheduleSettle()

    const fake = platform(() => undefined)

    await syncFor(fake).flushBounded(2_000)

    expect(fake.delivered.map(event => event.kind)).toEqual(['route_closed'])
    expect(fake.reports).toHaveLength(1)
    expect(fake.acks).toBe(1)
  })

  it('it never waits longer than its bound and never throws', async () => {
    h = makeHarness()
    h.gate.revoke({ scope: 'route', reason: 'sign_out' })
    const fake = platform(() => new Promise(() => undefined))
    const started = Date.now()

    await expect(syncFor(fake).flushBounded(60)).resolves.toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2_000)

    await expect(syncFor(platform(() => { throw refuse(500) })).flushBounded(60)).resolves.toBeUndefined()
  })

  it('it ignores the settlement back-off: a failed delivery earlier must not stop the last attempt', async () => {
    h = makeHarness()
    await h.gate.launch(h.ctx(LUNA), h.args(REQ_1, EVENT_A))
    h.gate.revoke({ scope: 'route', reason: 'sign_out' })
    await h.gate.scheduleSettle()

    let fail = true
    const fake = platform(() => undefined)
    const send = fake.reportSettlements!.bind(fake)

    fake.reportSettlements = async input => {
      if (fail) {
        fail = false
        throw refuse(503)
      }

      return send(input)
    }

    const sync = syncFor(fake)

    await sync.flush()
    expect(fake.reports).toHaveLength(0)

    await sync.flushBounded(2_000)
    expect(fake.reports).toHaveLength(1)
  })
})
