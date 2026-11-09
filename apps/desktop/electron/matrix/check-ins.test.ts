import { describe, expect, it, vi } from 'vitest'

import {
  applyMatrixCheckInFeedback,
  defaultMatrixCheckInSettings,
  emptyMatrixCheckInLedger,
  MATRIX_CHECK_IN_LIMITS,
  matrixCheckInEnvelope,
  type MatrixCheckInLedger,
  type MatrixCheckInNudge,
  type MatrixCheckInsState,
  parseMatrixCheckInEnvelope
} from '../../shared/matrix-check-ins'

import {
  admitMatrixCheckIn,
  claimMatrixCheckIn,
  decideMatrixCheckIn,
  type MatrixCheckInContext,
  type MatrixCheckInGateway,
  type MatrixCheckInLeaseHold,
  MatrixCheckIns,
  type MatrixCheckInsDeps,
  refuseMatrixCheckIns
} from './check-ins'

const at = (time: string) => new Date(`2026-10-05T${time}:00`)
const idle: MatrixCheckInContext = { busy: false, canAfford: true }

function state(change: Partial<MatrixCheckInsState> = {}): MatrixCheckInsState {
  return {
    settings: defaultMatrixCheckInSettings(),
    feedback: { muted: [], snoozed: [], ackAt: 0 },
    ledger: emptyMatrixCheckInLedger(),
    ...change
  }
}

const nudge: MatrixCheckInNudge = {
  kind: 'deadline',
  key: 'quote-lan',
  text: 'Báo giá cho chị Lan hết hạn chiều nay.',
  source: 'files',
  ref: 'quote.md',
  action: 'draft'
}

describe('when a check-in runs', () => {
  it('runs only between 08:00 and 22:00, earlier only for an earlier brief', () => {
    expect(decideMatrixCheckIn(at('07:59'), state(), idle)).toEqual({ run: false, reason: 'quiet_hours' })
    expect(decideMatrixCheckIn(at('22:00'), state(), idle)).toEqual({ run: false, reason: 'quiet_hours' })
    expect(decideMatrixCheckIn(at('08:00'), state(), idle)).toEqual({ run: true, slot: 'brief' })

    const early = state({ settings: { enabled: true, brief: '07:30' } })
    expect(decideMatrixCheckIn(at('07:29'), early, idle)).toEqual({ run: false, reason: 'quiet_hours' })
    expect(decideMatrixCheckIn(at('07:30'), early, idle)).toEqual({ run: true, slot: 'brief' })
  })

  it('briefs once a day, late after a sleeping Mac but never after noon', () => {
    const briefed = claimMatrixCheckIn(emptyMatrixCheckInLedger(), at('08:05'), 'brief')
    expect(decideMatrixCheckIn(at('08:20'), state({ ledger: briefed }), idle)).toEqual({
      run: false,
      reason: 'not_due'
    })
    // Asleep through 08:00: the brief still comes when the Mac wakes in the morning.
    expect(decideMatrixCheckIn(at('11:40'), state(), idle)).toEqual({ run: true, slot: 'brief' })
    // After noon it is no longer a morning brief: an hourly check instead.
    expect(decideMatrixCheckIn(at('13:00'), state(), idle)).toEqual({ run: true, slot: 'check' })
    // No brief chosen: checks only.
    expect(decideMatrixCheckIn(at('08:10'), state({ settings: { enabled: true, brief: null } }), idle)).toEqual({
      run: true,
      slot: 'check'
    })
  })

  it('keeps the morning brief but drops between-brief nudges once sweeps are supported', () => {
    const sweep = { ...idle, betweenBriefChecks: false }
    expect(decideMatrixCheckIn(at('08:00'), state(), sweep)).toEqual({ run: true, slot: 'brief' })

    const briefed = claimMatrixCheckIn(emptyMatrixCheckInLedger(), at('08:00'), 'brief')
    expect(decideMatrixCheckIn(at('13:00'), state({ ledger: briefed }), sweep)).toEqual({
      run: false,
      reason: 'not_due'
    })
    expect(decideMatrixCheckIn(
      at('13:00'),
      state({ settings: { enabled: true, brief: null } }),
      sweep
    )).toEqual({ run: false, reason: 'not_due' })
  })

  it('coalesces missed checks: one check after a long sleep, then the hour starts again', () => {
    const night: MatrixCheckInLedger = {
      ...emptyMatrixCheckInLedger(),
      day: '2026-10-05',
      briefed: '2026-10-05',
      lastRunAt: at('09:00').getTime() - 10 * 60 * 60_000
    }

    expect(decideMatrixCheckIn(at('09:00'), state({ ledger: night }), idle)).toEqual({ run: true, slot: 'check' })
    const claimed = claimMatrixCheckIn(night, at('09:00'), 'check')
    expect(decideMatrixCheckIn(at('09:15'), state({ ledger: claimed }), idle)).toEqual({
      run: false,
      reason: 'not_due'
    })
    expect(decideMatrixCheckIn(at('10:00'), state({ ledger: claimed }), idle)).toEqual({ run: true, slot: 'check' })
  })

  it('waits for the owner: never while the assistant answers or right after the chat was active', () => {
    expect(decideMatrixCheckIn(at('10:00'), state(), { ...idle, busy: true })).toEqual({ run: false, reason: 'busy' })
    expect(decideMatrixCheckIn(at('10:00'), state(), { ...idle, lastActivity: at('09:55').getTime() })).toEqual({
      run: false,
      reason: 'recent_activity'
    })
    expect(decideMatrixCheckIn(at('10:00'), state(), { ...idle, lastActivity: at('09:45').getTime() }).run).toBe(true)
  })

  it('pauses silently without Protons, after the daily cap, and when turned off', () => {
    expect(decideMatrixCheckIn(at('10:00'), state(), { ...idle, canAfford: false })).toEqual({
      run: false,
      reason: 'out_of_protons'
    })

    const spent = { ...emptyMatrixCheckInLedger(), day: '2026-10-05', runs: MATRIX_CHECK_IN_LIMITS.dailyRuns }
    expect(decideMatrixCheckIn(at('10:00'), state({ ledger: spent }), idle)).toEqual({
      run: false,
      reason: 'daily_cap'
    })
    // The cap is per local day.
    expect(decideMatrixCheckIn(new Date('2026-10-06T10:00:00'), state({ ledger: spent }), idle).run).toBe(true)

    expect(decideMatrixCheckIn(at('10:00'), state({ settings: { enabled: false, brief: '08:00' } }), idle)).toEqual({
      run: false,
      reason: 'off'
    })
  })

  it('stops checking once three nudges went out today; the brief never counts', () => {
    const three = {
      ...emptyMatrixCheckInLedger(),
      day: '2026-10-05',
      briefed: '2026-10-05',
      nudges: MATRIX_CHECK_IN_LIMITS.dailyNudges
    }

    expect(decideMatrixCheckIn(at('15:00'), state({ ledger: three }), idle)).toEqual({
      run: false,
      reason: 'nudge_cap'
    })
  })
})

describe('admitting a delivered nudge', () => {
  const envelope = { nudge, slot: 'check' as const, claimedAt: at('10:00').getTime() }

  it('never posts the same item twice, but a resumed post of the same run is not a repeat', () => {
    const first = admitMatrixCheckIn(state(), envelope, at('10:01'), 'run-1', idle)
    expect(first.post).toBe(true)

    const ledger = first.post ? first.ledger : emptyMatrixCheckInLedger()
    expect(admitMatrixCheckIn(state({ ledger }), envelope, at('11:01'), 'run-2', idle)).toEqual({
      post: false,
      reason: 'repeat'
    })
    // Another key, same words: still a repeat.
    expect(
      admitMatrixCheckIn(
        state({ ledger }),
        { ...envelope, nudge: { ...nudge, key: 'other' } },
        at('11:01'),
        'run-2',
        idle
      ).post
    ).toBe(false)

    const resumed = admitMatrixCheckIn(state({ ledger }), envelope, at('10:02'), 'run-1', idle)
    expect(resumed).toEqual({ post: true, ledger })
  })

  it('caps nudges at three a day besides the brief', () => {
    let ledger = emptyMatrixCheckInLedger()

    for (let index = 0; index < MATRIX_CHECK_IN_LIMITS.dailyNudges; index++) {
      const admission = admitMatrixCheckIn(
        state({ ledger }),
        { ...envelope, nudge: { ...nudge, key: `item-${index}`, text: `Item ${index}` } },
        at('10:00'),
        `run-${index}`,
        idle
      )

      expect(admission.post).toBe(true)
      ledger = admission.post ? admission.ledger : ledger
    }

    const fourth = { ...envelope, nudge: { ...nudge, key: 'item-4', text: 'Item 4' } }
    expect(admitMatrixCheckIn(state({ ledger }), fourth, at('16:00'), 'run-4', idle)).toEqual({
      post: false,
      reason: 'nudge_cap'
    })

    const brief = {
      nudge: { ...nudge, kind: 'brief' as const, key: 'brief-1', text: 'Today: …' },
      slot: 'brief' as const,
      claimedAt: 1
    }
    expect(admitMatrixCheckIn(state({ ledger }), brief, at('16:00'), 'run-5', idle).post).toBe(true)
  })

  it('drops a muted kind, and drops a check the owner overtook', () => {
    expect(
      admitMatrixCheckIn(
        state({ feedback: { muted: ['deadline'], snoozed: [], ackAt: 0 } }),
        envelope,
        at('10:01'),
        'r',
        idle
      )
    ).toEqual({ post: false, reason: 'muted' })
    expect(
      admitMatrixCheckIn(state(), envelope, at('10:01'), 'r', { busy: false, lastActivity: at('10:00').getTime() + 1 })
    ).toEqual({ post: false, reason: 'owner_first' })
    expect(admitMatrixCheckIn(state(), envelope, at('10:01'), 'r', { busy: true })).toEqual({
      post: false,
      reason: 'owner_first'
    })
  })

  it('pauses and asks after five unanswered nudges, and an answer starts the count again', () => {
    let current = state()

    for (let index = 0; index < MATRIX_CHECK_IN_LIMITS.ignoredBeforeAsking; index++) {
      const time = new Date(at('09:00').getTime() + index * 25 * 60 * 60_000)

      const admission = admitMatrixCheckIn(
        current,
        { ...envelope, claimedAt: time.getTime(), nudge: { ...nudge, key: `n-${index}`, text: `Nudge ${index}` } },
        time,
        `run-${index}`,
        idle
      )

      expect(admission.post).toBe(true)
      current = { ...current, ledger: admission.post ? admission.ledger : current.ledger }
    }

    // Two hours after the fifth (13:00 that day): inside the day's hours, nothing else in the way.
    const later = new Date(current.ledger.lastNudgeAt + 2 * 60 * 60_000)
    expect(decideMatrixCheckIn(later, current, idle)).toEqual({ run: false, reason: 'asking' })

    // "Keep these coming": the owner answered.
    const answered = {
      ...current,
      feedback: applyMatrixCheckInFeedback(current.feedback, { kind: 'ack' }, later.getTime())
    }
    expect(decideMatrixCheckIn(later, answered, idle).run).toBe(true)
  })
})

/** The platform's answering lease: one holder at a time, the way two Macs see it. */
function platformLease() {
  let holder: string | undefined

  return {
    holder: () => holder,
    take(mac: string, persistent = false): MatrixCheckInLeaseHold | null {
      if (holder && holder !== mac) {
        return null
      }

      holder = mac

      return {
        held: () => holder === mac,
        release: () => {
          if (holder === mac && !persistent) {
            holder = undefined
          }
        }
      }
    }
  }
}

/** The owner's account data on the homeserver: every Mac reads and writes the same records. */
function homeserver(initial: MatrixCheckInsState = state()) {
  let records = structuredClone(initial)

  return {
    read: async () => structuredClone(records),
    writeLedger: async (ledger: MatrixCheckInLedger) => {
      await Promise.resolve()
      records = { ...records, ledger: structuredClone(ledger) }
    },
    /** The owner's answers, from any device. */
    answer: (feedback: MatrixCheckInsState['feedback']) => {
      records = { ...records, feedback: structuredClone(feedback) }
    },
    records: () => records
  }
}

/** A backend connection: Hermes's host requests in, the app's answers out. */
function backend() {
  const handlers = new Map<string, (event: { payload?: unknown }) => void>()
  const request = vi.fn(async () => ({}))

  const gateway = {
    on: (type: string, handler: (event: { payload?: unknown }) => void) => {
      handlers.set(type, handler)

      return () => void handlers.delete(type)
    },
    request: request as unknown as MatrixCheckInGateway['request']
  }

  const answers = () =>
    (request.mock.calls as unknown as [string, { request_id: string; result: string }][]).map(([method, params]) => ({
      method,
      requestId: params.request_id,
      result: JSON.parse(params.result) as unknown
    }))

  return { gateway, handlers, request, answers }
}

function mac(
  name: string,
  lease: ReturnType<typeof platformLease>,
  server: ReturnType<typeof homeserver>,
  now: () => number,
  change: Partial<MatrixCheckInsDeps> = {}
) {
  return new MatrixCheckIns({
    available: () => ({ ok: true, locale: 'vi', watched: ['/home/example/Atum'], model: 'atum-check-in' }),
    cached: () => undefined,
    context: () => idle,
    hold: async () => lease.take(name),
    read: server.read,
    writeLedger: server.writeLedger,
    resurface: async () => {},
    turnOff: async () => true,
    now,
    log: () => {},
    ...change
  })
}

describe('two Macs', () => {
  it('claim one check between them, whoever ticks first', async () => {
    const lease = platformLease()
    const server = homeserver()
    const now = () => at('10:00').getTime()
    const answers = await Promise.all([mac('A', lease, server, now).gate(), mac('B', lease, server, now).gate()])

    expect(answers.filter(answer => answer.run)).toHaveLength(1)
    expect(server.records().ledger.runs).toBe(1)
    expect(lease.holder()).toBeUndefined()

    // A minute later the other Mac ticks again: the check is already taken.
    const later = await mac('B', lease, server, () => at('10:01').getTime()).gate()
    expect(later).toEqual({ run: false, reason: 'not_due' })
  })

  it('leave the checks to the Mac that holds the answering lease', async () => {
    const lease = platformLease()
    const server = homeserver()
    const now = () => at('10:00').getTime()
    // B keeps answering (its lease is held between ticks).
    lease.take('B', true)

    expect(await mac('A', lease, server, now).gate()).toEqual({ run: false, reason: 'lease_elsewhere' })
    const answer = await mac('B', lease, server, now, { hold: async () => lease.take('B', true) }).gate()
    expect(answer.run).toBe(true)
  })

  it('never write a claim after the lease was lost mid-way', async () => {
    const server = homeserver()
    let held = true

    const lost = mac('A', platformLease(), server, () => at('10:00').getTime(), {
      hold: async () => ({ held: () => held, release: () => {} }),
      read: async () => {
        held = false

        return server.read()
      }
    })

    expect(await lost.gate()).toEqual({ run: false, reason: 'lease_elsewhere' })
    expect(server.records().ledger.runs).toBe(0)
  })
})

describe('the gate', () => {
  it('declines from the synced records without taking the lease or reading the server', async () => {
    const hold = vi.fn()
    const read = vi.fn()

    const gate = mac('A', platformLease(), homeserver(), () => at('23:00').getTime(), {
      cached: () => state(),
      hold,
      read
    })

    expect(await gate.gate()).toEqual({ run: false, reason: 'quiet_hours' })
    expect(hold).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it('hands Hermes what the check needs: its slot, the last check, the items already said', async () => {
    const sent = { key: 'quote-lan', text: 'Older nudge', at: 1, run: 'r0' }

    const server = homeserver(
      state({
        ledger: {
          ...emptyMatrixCheckInLedger(),
          lastRunAt: at('08:30').getTime(),
          sent: [sent],
          day: '2026-10-05',
          briefed: '2026-10-05'
        },
        feedback: { muted: ['meeting'], snoozed: [], ackAt: 0 }
      })
    )

    const answer = await mac('A', platformLease(), server, () => at('10:00').getTime()).gate()

    expect(answer).toMatchObject({
      run: true,
      slot: 'check',
      since: at('08:30').getTime(),
      claimed_at: at('10:00').getTime(),
      day: '2026-10-05',
      locale: 'vi',
      model: 'atum-check-in',
      sent: [{ key: 'quote-lan', text: 'Older nudge' }],
      muted: ['meeting'],
      nudges_left: MATRIX_CHECK_IN_LIMITS.dailyNudges,
      watched: ['/home/example/Atum'],
      signals: []
    })
  })

  it('opens one model call per check this Mac claimed, and closes a call the check did not make', async () => {
    const { gateway, handlers } = backend()
    let now = at('10:00').getTime()
    const checkIns = mac('A', platformLease(), homeserver(), () => now)
    checkIns.listen(gateway)

    expect(checkIns.takeCall()).toBe(false)

    // A claimed check makes its call, once.
    expect((await checkIns.gate()).run).toBe(true)
    expect(checkIns.takeCall()).toBe(true)
    expect(checkIns.takeCall()).toBe(false)

    // The next claimed check settles with nothing new: its call is closed, never made.
    now = at('11:01').getTime()
    const answer = await checkIns.gate()
    expect(answer.run).toBe(true)
    handlers.get('heartbeat.settled')!({ payload: { claimed_at: answer.run && answer.claimed_at, outcome: 'skipped' } })
    expect(checkIns.takeCall()).toBe(false)

    // A call left open is closed after its window.
    now = at('12:02').getTime()
    expect((await checkIns.gate()).run).toBe(true)
    now += 11 * 60_000
    expect(checkIns.takeCall()).toBe(false)
  })

  it('brings a due snooze back without a model run, once, and again when snoozed again', async () => {
    const snooze = { key: 'quote-lan', until: at('09:00').getTime(), nudge }
    const server = homeserver(state({ feedback: { muted: [], snoozed: [snooze], ackAt: 0 } }))
    const resurface = vi.fn(async () => {})
    let now = at('10:00').getTime()
    const gate = mac('A', platformLease(), server, () => now, { resurface })

    expect(await gate.gate()).toEqual({ run: false, reason: 'resurface' })
    await new Promise(resolve => setImmediate(resolve))
    expect(resurface).toHaveBeenCalledWith(snooze, at('10:00').getTime())
    expect(server.records().ledger.runs).toBe(0)

    // The next tick runs normally: it came back once.
    expect((await gate.gate()).run).toBe(true)

    // The owner snoozes the card that came back: it comes back at its new time, once more.
    const until = at('13:00').getTime()
    server.answer(
      applyMatrixCheckInFeedback(server.records().feedback, { kind: 'snooze', nudge, until }, at('10:05').getTime())
    )
    now = at('13:30').getTime()

    expect(await gate.gate()).toEqual({ run: false, reason: 'resurface' })
    await new Promise(resolve => setImmediate(resolve))
    expect(resurface).toHaveBeenLastCalledWith({ key: 'quote-lan', until, nudge }, at('13:30').getTime())
    expect(resurface).toHaveBeenCalledTimes(2)
  })

  it('answers Hermes on the backend connection, and refuses an unreadable request quietly', async () => {
    const { gateway, handlers, request } = backend()
    const stop = mac('A', platformLease(), homeserver(), () => at('10:00').getTime()).listen(gateway)

    handlers.get('heartbeat.gate.request')!({ payload: { request_id: 'ab12', job_id: 'a7c4ec4e0001' } })
    handlers.get('heartbeat.gate.request')!({ payload: { request_id: 'not hex!' } })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))

    const [method, params] = request.mock.calls[0] as unknown as [string, { request_id: string; result: string }]
    expect(method).toBe('heartbeat.gate.respond')
    expect(params.request_id).toBe('ab12')
    expect(JSON.parse(params.result)).toMatchObject({ run: true, slot: 'brief' })

    stop()
    expect(handlers.size).toBe(0)
  })
})

describe('asking the assistant to stop', () => {
  it('turns check-ins off for the owner when its cron tool asks, in whatever words they used', async () => {
    const { gateway, handlers, request, answers } = backend()
    const turnOff = vi.fn(async () => true)
    mac('A', platformLease(), homeserver(), () => at('10:00').getTime(), { turnOff }).listen(gateway)

    handlers.get('heartbeat.off.request')!({ payload: { request_id: 'cd34', job_id: 'a7c4ec4e0001' } })
    handlers.get('heartbeat.off.request')!({ payload: { request_id: 'not hex!' } })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))

    expect(turnOff).toHaveBeenCalledTimes(1)
    expect(answers()).toEqual([{ method: 'heartbeat.off.respond', requestId: 'cd34', result: { off: true } }])
  })

  it('says so when they could not be turned off, so the assistant points to Settings', async () => {
    const { gateway, handlers, request, answers } = backend()
    mac('A', platformLease(), homeserver(), () => at('10:00').getTime(), {
      turnOff: async () => Promise.reject(new Error('offline'))
    }).listen(gateway)

    handlers.get('heartbeat.off.request')!({ payload: { request_id: 'cd34' } })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    expect(answers()).toEqual([{ method: 'heartbeat.off.respond', requestId: 'cd34', result: { off: false } }])
  })

  it("never lets another agent's backend run a check or change the default assistant's", async () => {
    const { gateway, handlers, request, answers } = backend()
    const stop = refuseMatrixCheckIns(gateway)

    handlers.get('heartbeat.gate.request')!({ payload: { request_id: 'ab12' } })
    handlers.get('heartbeat.off.request')!({ payload: { request_id: 'cd34' } })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))

    expect(answers()).toEqual([
      { method: 'heartbeat.gate.respond', requestId: 'ab12', result: { run: false, reason: 'unavailable' } },
      { method: 'heartbeat.off.respond', requestId: 'cd34', result: { off: false } }
    ])
    stop()
    expect(handlers.size).toBe(0)
  })
})

describe('the delivered envelope', () => {
  it('reads exactly what Hermes writes (cron/check_ins.py envelope), and nothing malformed', () => {
    // json.dumps(..., ensure_ascii=False, separators=(",", ":")), as Hermes sends it.
    const fromHermes =
      '{"v":1,"check_in":{"kind":"deadline","key":"quote-lan","text":"Báo giá cho chị Lan hết hạn chiều nay.",' +
      '"source":"files","ref":"quote.md","action":"draft","slot":"check","claimed_at":1759633200000}}'

    expect(parseMatrixCheckInEnvelope(fromHermes)).toEqual({ nudge, slot: 'check', claimedAt: 1759633200000 })
    expect(
      parseMatrixCheckInEnvelope(matrixCheckInEnvelope({ nudge, slot: 'check', claimedAt: 5, resurfaced: true }))
    ).toEqual({
      nudge,
      slot: 'check',
      claimedAt: 5,
      resurfaced: true
    })

    for (const bad of [
      'Lan asked about the quote',
      '{"v":2,"check_in":{}}',
      fromHermes.replace('"slot":"check"', '"slot":"brief"'),
      fromHermes.replace('"action":"draft"', '"action":"send"'),
      fromHermes.replace('"key":"quote-lan"', '"key":"Quote Lan!"')
    ]) {
      expect(parseMatrixCheckInEnvelope(bad)).toBeUndefined()
    }
  })

  it('is admitted through the lease, recorded before it is posted', async () => {
    const server = homeserver()
    const checkIns = mac('A', platformLease(), server, () => at('10:01').getTime())
    const text = matrixCheckInEnvelope({ nudge, slot: 'check', claimedAt: at('10:00').getTime() })

    expect(await checkIns.admit(text, 'run-1')).toEqual({ nudge })
    expect(server.records().ledger).toMatchObject({ nudges: 1, ignored: 1, sent: [{ key: 'quote-lan', run: 'run-1' }] })
    expect(await checkIns.admit(text, 'run-2')).toEqual({ drop: 'repeat' })
    expect(await checkIns.admit('free text', 'run-3')).toEqual({ drop: 'malformed' })
  })
})

describe('the window asking', () => {
  const identity = { userId: '@owner:atum.test', deviceId: 'MAC' }

  it("passes only the owner's own settings and answers through", async () => {
    const { parseMatrixCommand } = await import('./ipc-policy')

    expect(
      parseMatrixCommand({ kind: 'checkInsChange', identity, change: { field: 'brief', value: '07:30' } })
    ).toEqual({
      kind: 'checkInsChange',
      identity,
      change: { field: 'brief', value: '07:30' }
    })
    expect(
      parseMatrixCommand({ kind: 'checkInsFeedback', identity, feedback: { kind: 'less', nudge: 'deadline' } })
    ).toEqual({
      kind: 'checkInsFeedback',
      identity,
      feedback: { kind: 'less', nudge: 'deadline' }
    })

    for (const bad of [
      { kind: 'checkInsChange', identity, change: { field: 'runs', value: 0 } },
      { kind: 'checkInsChange', identity: { userId: 'owner', deviceId: 'MAC' }, change: { field: 'introduced' } },
      {
        kind: 'checkInsFeedback',
        identity,
        feedback: { kind: 'snooze', nudge: { ...nudge, action: 'send' }, until: 1 }
      },
      // The ledger is main's alone; the window can never write it.
      { kind: 'checkInsLedger', ledger: emptyMatrixCheckInLedger() },
      { kind: 'checkInsRead' }
    ]) {
      expect(() => parseMatrixCommand(bad)).toThrow()
    }
  })
})
