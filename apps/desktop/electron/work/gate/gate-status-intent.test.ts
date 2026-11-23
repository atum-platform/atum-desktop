import { afterEach, describe, expect, it } from 'vitest'

import { workExpectedThreadId } from './contract'
import { RequestStatusReader } from './status'
import { EVENT_A, EVENT_B, EVENT_C, type Harness, LUNA, makeHarness, REQ_1, REQ_2, REQ_3 } from './test-support'

let h: Harness

afterEach(async () => h?.cleanup())

const launch = (requestId = REQ_1, event = EVENT_A) => h.gate.launch(h.ctx(LUNA), h.args(requestId, event))
const status = (requestId = REQ_1) => h.gate.request(h.ctx(LUNA), { requestId, action: 'status' })

describe('the review\'s second requirement: read-only status is separate from recovery that can dispatch', () => {
  it('status can read a thread and cannot start one: repeated status calls on a resendable row send nothing', async () => {
    h = makeHarness()
    h.t3.loseNextBytes = true
    await launch()
    expect(h.t3.count('launch')).toBe(1)

    for (let i = 0; i < 4; i++) {
      expect(await status()).toMatchObject({ class: 'pending', forwarded: true })
    }

    expect(h.t3.count('launch')).toBe(1)
    expect(h.t3.count('interrupt')).toBe(0)
    expect(h.t3.prompts).toBe(0)
  })

  it('the status path is built from a reader with ONE method: it works with nothing that could dispatch', async () => {
    h = makeHarness()
    h.t3.dropNextReply = true
    await launch()

    const reader = new RequestStatusReader({
      ledger: h.ledger,
      reader: { read: (token, threadId) => h.t3.read(token, threadId) },
      sessions: { owner: () => h.sessions.owner(), agentSessionId: principal => h.sessions.agentSessionId(principal) },
      gateId: () => h.gate.gateId(),
      now: h.clock.now,
      fingerprintFor: () => 'fp'
    })

    expect(await reader.status(LUNA, REQ_1)).toMatchObject({ class: 'accepted' })
  })

  it('status on a row that never reached T3 reads nothing and sends nothing', async () => {
    h = makeHarness()
    const parked = h.pause('admitted')
    const first = launch()

    await parked.reached
    expect(await status()).toMatchObject({ class: 'pending', forwarded: false })
    expect(h.t3.count('read')).toBe(0)
    expect(h.t3.count('launch')).toBe(0)
    void first
  })

  it('a status for an id the Mac never saw is `none`: the helper may launch, and the id is not retired', async () => {
    h = makeHarness()

    expect(await status(REQ_3)).toMatchObject({ class: 'none', receipt: 'none' })
    expect(h.ledger.receipt(LUNA, REQ_3)).toBeUndefined()
  })

  it('recovery that can dispatch is the helper\'s explicit launch retry and the gate\'s own recover(): both resend once', async () => {
    h = makeHarness()
    h.t3.loseNextBytes = true
    await launch()

    // the retry is explicit and goes through the same fence
    expect(await launch()).toMatchObject({ class: 'accepted' })
    expect(h.t3.count('launch')).toBe(2)

    h = makeHarness()
    h.t3.loseNextBytes = true
    await launch()
    await h.gate.recover()

    expect(h.t3.count('launch')).toBe(2)
    expect(h.ledger.receipt(LUNA, REQ_1)?.state).toBe('launched')
  })

  it('a resend is never a third send: after one more attempt the answer is ambiguous', async () => {
    h = makeHarness()
    h.t3.loseNextBytes = true
    await launch()
    h.t3.loseNextBytes = true
    await launch()
    expect(h.t3.count('launch')).toBe(2)

    await h.gate.recover()
    expect(h.t3.count('launch')).toBe(2)
    expect(await launch()).toMatchObject({ class: 'ambiguous', cause: 'not_found' })
  })

  it('recovery waits for the account: while held() or with no T3 process it sends nothing', async () => {
    h = makeHarness()
    const parked = h.pause('admitted')
    void launch()
    await parked.reached
    const killed = h

    h = h.reopen()
    h.held.value = true
    await h.gate.recover()
    expect(h.t3.count('launch')).toBe(0)

    h.held.value = false
    h.t3.alive = false
    await h.gate.recover()
    expect(h.t3.count('launch')).toBe(0)

    h.t3.alive = true
    await h.gate.recover()
    expect(h.t3.count('launch')).toBe(1)
    void killed
  })

  it('a session replaced between admission and the resend: the gate never launches one request under a second session', async () => {
    h = makeHarness()
    h.t3.loseNextBytes = true
    await launch()
    h.sessions.replace(LUNA)
    await h.gate.recover()
    await launch()

    expect(h.t3.count('launch')).toBe(1)
    expect(h.t3.threads.has(workExpectedThreadId(h.sessions.agentSessionId(LUNA) as string, REQ_1))).toBe(false)
  })
})

describe('intent: only the owner can ask, once per message (T9 b-c)', () => {
  it.each([
    ['no such event', 'owner_event_not_found'],
    ['another sender', 'owner_event_not_owner'],
    ['another room', 'owner_event_wrong_room'],
    ['a redacted event', 'owner_event_redacted'],
    ['an undecryptable event', 'owner_event_undecryptable'],
    ['a device that is not the owner\'s', 'owner_event_device_not_owner']
  ] as const)('%s is refused with its reason, and no thread starts', async (_name, reason) => {
    h = makeHarness()
    h.owner.put(EVENT_C, { kind: 'invalid', reason })

    expect(await launch(REQ_1, EVENT_C)).toMatchObject({ class: 'refused', receipt: 'refused', reason })
    expect(h.t3.count('launch')).toBe(0)
    expect(h.ledger.receipt(LUNA, REQ_1)).toMatchObject({ state: 'refused', reason })
    expect(h.ledger.eventClaimed(EVENT_C)).toBe(false)
  })

  it('an old event and an event from the future are refused by the gate\'s own age bound', async () => {
    h = makeHarness()
    h.owner.put(EVENT_B, { kind: 'ok', body: 'old words', originServerTs: h.clock.now() - 16 * 60_000 })
    h.owner.put(EVENT_C, { kind: 'ok', body: 'future words', originServerTs: h.clock.now() + 5 * 60_000 })

    expect(await launch(REQ_1, EVENT_B)).toMatchObject({ class: 'refused', reason: 'owner_event_too_old' })
    expect(await launch(REQ_2, EVENT_C)).toMatchObject({ class: 'refused', reason: 'owner_event_future' })
    expect(h.t3.count('launch')).toBe(0)
  })

  it('a used event is refused (D18): one owner message, one launch, even across a restart', async () => {
    h = makeHarness()
    await launch(REQ_1, EVENT_A)

    h = h.reopen()
    expect(await launch(REQ_2, EVENT_A)).toMatchObject({ class: 'refused', reason: 'event_already_used' })
  })

  it('a homeserver that cannot be reached is `unavailable`, not a receipt: the message stays unused', async () => {
    h = makeHarness()
    h.owner.unreachable = true

    expect(await launch()).toMatchObject({ class: 'unavailable', reason: 'owner_event_unverifiable' })
    expect(h.ledger.receipt(LUNA, REQ_1)).toBeUndefined()
    expect(h.ledger.eventClaimed(EVENT_A)).toBe(false)

    h.owner.unreachable = false

    expect(await launch()).toMatchObject({ class: 'accepted' })
  })

  it('the thread opens with the owner\'s own words, fetched by the gate, above the assistant\'s text', async () => {
    h = makeHarness()
    h.owner.put(EVENT_A, { kind: 'ok', body: 'the owner said this', originServerTs: h.clock.now() })
    await h.gate.launch(h.ctx(LUNA), h.args(REQ_1, EVENT_A, { task: 'the assistant\'s own task' }))

    const message = (h.t3.calls[h.t3.calls.length - 1].args as { call: { message: string } }).call.message

    expect(message.indexOf('the owner said this')).toBeLessThan(message.indexOf('the assistant\'s own task'))
    expect(h.owner.fetched).toEqual([EVENT_A])
  })
})
