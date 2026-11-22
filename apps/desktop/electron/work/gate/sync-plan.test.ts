import { afterEach, describe, expect, it } from 'vitest'

import type { WorkConsentSnapshot, WorkSyncPage } from './contract'
import type { WorkPlatform } from './ports'
import { WorkSync } from './sync'
import { ACCOUNT, DEVICE, EVENT_A, type Harness, LUNA, makeHarness, NOVA, REQ_1 } from './test-support'

// Contract 1.2 on the Mac's sync client: the pull asks for it, the consent snapshot is applied durably with its page, the ack names
// the revision, and a platform that does not know 1.2 costs nothing but the plan.

let h: Harness

afterEach(async () => h?.cleanup())

const snapshot = (over: Partial<WorkConsentSnapshot> = {}): WorkConsentSnapshot => ({ provider: 'codex', state: 'on', revision: 4, agents: [LUNA], alsoWhenScheduled: false, ...over })
const page = (over: Partial<WorkSyncPage> = {}): WorkSyncPage => ({ deviceServiceId: DEVICE, accountId: ACCOUNT, issuedAt: 1, fromSeq: 0, headSeq: 0, entitled: [LUNA, NOVA], changes: [], hasMore: false, ...over })

function platform() {
  const fake = {
    pulls: [] as { contract?: string }[],
    acks: [] as Record<string, unknown>[],
    pages: [] as WorkSyncPage[],
    rejectContract: false,
    async enroll() {
      return { work: null }
    },
    async pull(input: { contract?: '1.2'; appliedSeq: number }) {
      fake.pulls.push({ contract: input.contract })

      if (fake.rejectContract && input.contract) {
        throw Object.assign(new Error('400'), { status: 400 })
      }

      return fake.pages.shift() ?? page({ fromSeq: input.appliedSeq, headSeq: input.appliedSeq })
    },
    async ack(ack: Record<string, unknown>) {
      fake.acks.push(ack)
    },
    async macEvent() {},
    async carryGrant() {}
  }

  return fake as typeof fake & WorkPlatform
}

const syncFor = (fake: WorkPlatform, extra = {}) =>
  new WorkSync({ gate: h.gate, ledger: h.ledger, platform: fake, accountId: ACCOUNT, deviceServiceId: DEVICE, now: h.clock.now, socketPath: () => '/tmp/g.sock', ...extra })

describe('the pull asks for 1.2 and applies what comes back', () => {
  it('stores the snapshot in the same step as the page, starts its age, and acknowledges its revision', async () => {
    h = makeHarness()
    const fake = platform()

    fake.pages.push(page({ consent: snapshot() }))
    expect(await syncFor(fake).tick()).toBe('ok')

    expect(fake.pulls[0]).toEqual({ contract: '1.2' })
    expect(h.ledger.consent()).toEqual(snapshot())
    expect(h.gate.planConsentState()).toBe('on')
    expect(fake.acks.at(-1)).toMatchObject({ consentRevision: 4 })
  })

  it('a page with no consent key leaves the snapshot where it was and the ack without a revision', async () => {
    h = makeHarness()
    const fake = platform()

    expect(await syncFor(fake).tick()).toBe('ok')
    expect(h.ledger.consent()).toBeUndefined()
    expect(fake.acks.at(-1)).not.toHaveProperty('consentRevision')
    expect(h.gate.planConsentState()).toBe('unknown')
  })

  it('a page that is not applied (a gap, a regression) does not apply its snapshot: the plan stays as stale as it was', async () => {
    h = makeHarness()
    h.ledger.setAppliedSeq(5)
    const fake = platform()

    fake.pages.push(page({ fromSeq: 3, headSeq: 3, consent: snapshot() }))
    expect(await syncFor(fake).tick()).toBe('regressed')
    expect(h.ledger.consent()).toBeUndefined()

    fake.pages.push(page({ fromSeq: 5, headSeq: 9, changes: [{ seq: 8, kind: 'agent_added', agentPrincipal: NOVA, at: 1 }], consent: snapshot() }))
    expect(await syncFor(fake).tick()).toBe('gap')
    expect(h.ledger.consent()).toBeUndefined()
  })

  it('a snapshot that stops naming an assistant interrupts its plan threads in the same cycle, and reports them stopped', async () => {
    h = makeHarness()
    h.ledger.setPlanSwitch(true)
    h.consent({ agents: [LUNA] })
    await h.gate.launch(h.ctx(LUNA), h.args(REQ_1, EVENT_A, { plan: 'codex' }))
    const fake = platform()

    fake.pages.push(page({ consent: snapshot({ revision: 5, agents: [NOVA] }) }))
    await syncFor(fake).tick()
    await h.gate.scheduleSettle()

    expect(h.ledger.receipt(LUNA, REQ_1)).toMatchObject({ stopScope: 'agent', settled: 'stopped' })
    expect(fake.acks.at(-1)).toMatchObject({ consentRevision: 5 })
  })

  it('a platform that answers 400 to 1.2 is pulled as 1.1: revocation keeps working, the plan is refused stale, 1.2 is tried again later', async () => {
    h = makeHarness()
    const fake = platform()

    fake.rejectContract = true
    fake.pages.push(page({ fromSeq: 0, headSeq: 1, changes: [{ seq: 1, kind: 'agent_added', agentPrincipal: LUNA, at: 1 }] }))
    const sync = syncFor(fake)

    expect(await sync.tick()).toBe('ok')
    expect(h.ledger.appliedSeq()).toBe(1)
    expect(fake.pulls).toEqual([{ contract: '1.2' }, { contract: undefined }])

    await sync.tick()
    expect(fake.pulls.slice(2)).toEqual([{ contract: undefined }])

    h.clock.advance(3_600_001)
    await sync.tick()
    expect(fake.pulls.at(-2)).toEqual({ contract: '1.2' })
  })

  it('while the platform is pulled as 1.1 an old snapshot is never acknowledged (a 1.1 ack would not know the key)', async () => {
    h = makeHarness()
    h.consent({ revision: 3 })
    const fake = platform()

    fake.rejectContract = true
    await syncFor(fake).tick()

    expect(fake.acks.at(-1)).not.toHaveProperty('consentRevision')
  })

  it('an offline pull leaves the snapshot to age: after 300 seconds on the monotonic clock plan launches are stale', async () => {
    h = makeHarness()
    h.ledger.setPlanSwitch(true)
    h.consent({})
    h.clock.advance(301_000)

    expect(h.gate.planConsentState()).toBe('unknown')
    expect(await h.gate.launch(h.ctx(LUNA), h.args(REQ_1, EVENT_A, { plan: 'codex' }))).toMatchObject({ reason: 'plan_consent_stale' })
  })
})

describe('the plan fact rides the cycle', () => {
  it('is checked at the end of every cycle, and `final` runs in the last bounded flush before sign-out', async () => {
    h = makeHarness()
    const calls: string[] = []
    const fake = platform()
    const sync = syncFor(fake, { planFact: { tick: async () => void calls.push('tick'), final: async () => void calls.push('final') } })

    await sync.tick()
    await sync.flushBounded(1_000)

    expect(calls).toEqual(['tick', 'final'])
  })

  it('a plan fact check that fails never fails the cycle', async () => {
    h = makeHarness()
    const sync = syncFor(platform(), { planFact: { tick: async () => Promise.reject(new Error('x')), final: async () => undefined } })

    expect(await sync.tick()).toBe('ok')
  })
})
