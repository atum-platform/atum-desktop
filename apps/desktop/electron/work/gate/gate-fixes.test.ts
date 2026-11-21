import { afterEach, describe, expect, it } from 'vitest'

import type { WorkSyncPage } from './contract'
import type { T3Reply } from './ports'
import { WorkSync } from './sync'
import { ACCOUNT, DEVICE, EVENT_A, EVENT_B, type Harness, LUNA, makeHarness, REQ_1, REQ_2 } from './test-support'

// Fixes from the desktop outcome review (2026-11-21): an uncertain launch survives a retry's rejection, a stop is
// claimed only after a native Stop and a read after it, owed stops are retried by the sync, a session id outlives a
// failed revocation, and the restart check reads T3's own page.

let h: Harness

afterEach(async () => h?.cleanup())

const launch = (requestId = REQ_1, event = EVENT_A) => h.gate.launch(h.ctx(LUNA), h.args(requestId, event))
const row = (requestId = REQ_1) => h.ledger.receipt(LUNA, requestId)
const settled = () => h.gate.scheduleSettle()

describe('a retry\'s rejection does not erase an earlier uncertain launch', () => {
  async function uncertainThenRejectedRetry() {
    h = makeHarness()
    // the first send's bytes are lost: T3 may or may not have it, and the gate cannot tell
    h.t3.loseNextBytes = true
    expect(await launch()).toMatchObject({ class: 'pending', forwarded: true })
    expect(row()).toMatchObject({ forwardCount: 1, incarnation: 'inc-1' })

    // the helper retries; T3 refuses THIS send with a typed code
    h.t3.rejectWith = { code: 'model_unavailable' }

    return launch()
  }

  it('keeps the row admitted and the claim on the owner\'s event; the retry is not a final answer', async () => {
    const answer = await uncertainThenRejectedRetry()

    expect(answer).toMatchObject({ class: 'pending', forwarded: true })
    expect(row()).toMatchObject({ state: 'admitted', forwardCount: 2, reason: 't3_model_unavailable' })
    expect(h.ledger.eventClaimed(EVENT_A)).toBe(true)

    // the same owner message cannot start a second task meanwhile
    expect(await launch(REQ_2, EVENT_A)).toMatchObject({ class: 'refused', reason: 'event_already_used' })
  })

  it('in the same T3 process the absence proves nothing: the retry answer stays ambiguous, the status pending, and the claim stays', async () => {
    await uncertainThenRejectedRetry()

    expect(await launch()).toMatchObject({ class: 'ambiguous', forwarded: true })
    expect(await h.gate.request(h.ctx(LUNA), { requestId: REQ_1, action: 'status' })).toMatchObject({ class: 'pending', forwarded: true })
    expect(row()?.state).toBe('admitted')
    expect(h.ledger.eventClaimed(EVENT_A)).toBe(true)
  })

  it('after another T3 process is ready and the thread is still absent, the rejection and the release of the claim are one commit', async () => {
    await uncertainThenRejectedRetry()
    h.t3.restart()

    expect(await launch()).toMatchObject({ class: 'refused', receipt: 'rejected', reason: 't3_model_unavailable' })
    expect(row()?.state).toBe('rejected')
    expect(h.ledger.eventClaimed(EVENT_A)).toBe(false)
  })

  it('recovery commits it the same way; and a thread that DID start wins over the parked rejection', async () => {
    await uncertainThenRejectedRetry()
    h.t3.restart()
    await h.gate.recover()
    expect(row()?.state).toBe('rejected')

    // second request: the first send had reached T3 after all
    h.t3.rejectWith = undefined
    h.t3.dropNextReply = true
    await launch(REQ_2, EVENT_B)
    h.t3.rejectWith = { code: 'model_unavailable' }
    await h.gate.launch(h.ctx(LUNA), h.args(REQ_2, EVENT_B))
    expect(h.ledger.receipt(LUNA, REQ_2)?.state).toMatch(/launched|admitted/u)
    expect(h.ledger.eventClaimed(EVENT_B)).toBe(true)
  })

  it('a revocation meanwhile keeps the stop owed until the absence is proven by another process', async () => {
    await uncertainThenRejectedRetry()
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    await settled()

    expect(row()).toMatchObject({ settled: null, stopScope: 'agent' })
    expect(h.ledger.eventClaimed(EVENT_A)).toBe(true)
    expect(h.gate.state().stopsOwed.total).toBe(1)

    h.t3.restart()
    await settled()

    expect(row()?.settled).toBe('nothing_started')
  })

  it('a rejection of the only send is final at once, with the claim released in the same write', async () => {
    h = makeHarness()
    h.t3.rejectWith = { code: 'model_unavailable' }

    expect(await launch()).toMatchObject({ class: 'refused', receipt: 'rejected' })
    expect(h.ledger.eventClaimed(EVENT_A)).toBe(false)
  })
})

describe('stops are claimed only after a native Stop and a read after it', () => {
  it('a thread that reads idle at first is still stopped natively before `stopped` is reported', async () => {
    h = makeHarness()
    h.t3.autoRunning = false
    await launch()
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    await settled()

    expect(h.t3.count('interrupt')).toBeGreaterThan(0)
    expect(row()?.settled).toBe('stopped')
  })

  it('a Stop T3 did not accept leaves the stop owed, and the report is not written', async () => {
    h = makeHarness()
    await launch()
    const interrupt = h.t3.interrupt.bind(h.t3)

    h.t3.interrupt = async () => ({ transport: 'failed', error: 'ECONNRESET' }) as T3Reply
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    await settled()

    expect(row()?.settled).toBeNull()
    expect(h.ledger.pending('stop_report')).toHaveLength(0)
    expect(h.gate.state().stopsOwed.total).toBe(1)

    h.t3.interrupt = interrupt
    await settled()
    expect(row()?.settled).toBe('stopped')
    expect(h.ledger.pending('stop_report')).toHaveLength(1)
  })

  it('a post-stop read that fails (not found, transport) is not a verification', async () => {
    h = makeHarness()
    await launch()
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    const read = h.t3.read.bind(h.t3)
    let reads = 0

    h.t3.read = async (token: string, threadId: string) => {
      reads++

      return reads === 1 ? read(token, threadId) : { kind: 'transport' as const }
    }

    await settled()
    expect(row()?.settled).toBeNull()
  })

  it('the sync retries an owed stop on every tick, after a transient failure', async () => {
    h = makeHarness()
    await launch()
    const interrupt = h.t3.interrupt.bind(h.t3)

    h.t3.interrupt = async () => ({ transport: 'failed', error: 'ECONNRESET' }) as T3Reply
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    await settled()
    expect(row()?.settled).toBeNull()

    h.t3.interrupt = interrupt
    const acks: number[] = []

    const sync = new WorkSync({
      gate: h.gate,
      ledger: h.ledger,
      platform: {
        enroll: async () => ({ work: null }),
        pull: async input => ({ deviceServiceId: DEVICE, accountId: ACCOUNT, issuedAt: 1, fromSeq: input.appliedSeq, headSeq: input.appliedSeq, entitled: [LUNA], changes: [], hasMore: false }) satisfies WorkSyncPage,
        ack: async ack => void acks.push(ack.settledSeq),
        macEvent: async () => undefined,
        carryGrant: async () => undefined
      },
      accountId: ACCOUNT,
      deviceServiceId: DEVICE,
      now: h.clock.now,
      socketPath: () => '/tmp/g.sock'
    })

    await sync.tick()
    expect(row()?.settled).toBe('stopped')
    expect(h.gate.state().stopsOwed.total).toBe(0)
  })

  it('a declined restart is retried on the next pass', async () => {
    h = makeHarness()
    h.t3.loseNextBytes = true
    await launch()
    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    await settled()
    expect(row()?.settled).toBeNull()

    h.t3.restartResult = 'restarted'
    await settled()
    expect(row()?.settled).toBe('nothing_started')
  })
})

describe('the revoked caller\'s session is revoked before the cleanup is acknowledged', () => {
  it('a failed revocation is retried and the acknowledgement waits for it', async () => {
    h = makeHarness()
    await launch()
    const revoke = h.sessions.revokeAgent.bind(h.sessions)
    let fail = true

    h.sessions.revokeAgent = async principal => {
      if (fail) {
        throw new Error('t3_auth_session_revoke')
      }

      return revoke(principal)
    }

    h.gate.revoke({ scope: 'agent', principal: LUNA, reason: 'agent_removed_owner' })
    await settled()

    expect(row()?.settled).toBe('stopped')
    expect(h.events.filter(event => event.type === 'acknowledged')).toHaveLength(0)

    fail = false
    await settled()
    expect(h.events.filter(event => event.type === 'acknowledged')).toHaveLength(1)
  })
})

describe('the owner\'s runs are idle only on T3\'s own complete page', () => {
  const reply = (data: Record<string, unknown>, isError = false): T3Reply => ({ transport: 'ok', status: 200, isError, data, code: null })
  const thread = (extra: Record<string, unknown> = {}) => ({ threadId: 'thread:1', status: 'idle', blockedOnThreadWait: false, pendingBackgroundTasks: [], ...extra })

  async function idleWith(list: T3Reply): Promise<boolean> {
    h = makeHarness()
    h.t3.list = async () => list

    return h.gate.ownerRunsIdle()
  }

  it('one page of idle threads is idle; an empty page is idle', async () => {
    expect(await idleWith(reply({ threads: [thread()], nextCursor: null, total: 1 }))).toBe(true)
    expect(await idleWith(reply({ threads: [], nextCursor: null, total: 0 }))).toBe(true)
  })

  it('anything else is not idle: a cursor, a total that does not match, a busy or waiting or unknown thread, an error', async () => {
    expect(await idleWith(reply({ threads: [thread()], nextCursor: 'abc', total: 2 }))).toBe(false)
    expect(await idleWith(reply({ threads: [thread()], nextCursor: null, total: 5 }))).toBe(false)
    expect(await idleWith(reply({ threads: [thread({ status: 'running' })], nextCursor: null, total: 1 }))).toBe(false)
    expect(await idleWith(reply({ threads: [thread({ status: 'queued' })], nextCursor: null, total: 1 }))).toBe(false)
    expect(await idleWith(reply({ threads: [thread({ status: 'something_new' })], nextCursor: null, total: 1 }))).toBe(false)
    expect(await idleWith(reply({ threads: [thread({ blockedOnThreadWait: true })], nextCursor: null, total: 1 }))).toBe(false)
    expect(await idleWith(reply({ threads: [thread({ pendingBackgroundTasks: [{}] })], nextCursor: null, total: 1 }))).toBe(false)
    expect(await idleWith(reply({ code: 'target_required' }, true))).toBe(false)
    expect(await idleWith(reply({}))).toBe(false)
    expect(await idleWith({ transport: 'failed' })).toBe(false)
  })
})
