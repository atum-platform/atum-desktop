import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type ContinuousListeningPreference, MatrixContinuousListening } from './continuous-listening'
import { MatrixHermesListener, type MatrixTurnOutcome } from './hermes-listener'
import { MatrixExecutorLease } from './lease'
import { MATRIX_LEASE_HANDOVER, MatrixLeaseHandover } from './lease-handover'

const HOLD = MATRIX_LEASE_HANDOVER.holdMs

interface Agent {
  name: string
  executorId: string
  lease: MatrixExecutorLease
}

/** Two agents on one Mac, each with a real answering lease against a platform that grants it
 * to whoever asks while it is free (a renewal keeps the term, a new grant starts one), and
 * main's rules: compete unless handing over, and tell the handover each term this Mac holds. */
function fixture() {
  const holders = new Map<string, string>()
  const terms = new Map<string, number>()
  const requests: { operation: 'acquire' | 'release'; executorId: string }[] = []
  const logs: string[] = []
  let grants = 0

  const agent = (name: string, executorId: string): Agent => {
    const self: Agent = { name, executorId } as Agent
    self.lease = new MatrixExecutorLease({
      request: async (operation, id) => {
        requests.push({ operation, executorId: id })

        if (operation === 'release') {
          holders.delete(name)

          return { held: false }
        }

        if (holders.get(name) && holders.get(name) !== id) {
          return { held: false, until: Date.now() + 90_000 }
        }

        if (holders.get(name) !== id) {
          terms.set(name, (grants += 1))
        }

        holders.set(name, id)

        return { held: true, executorId: id, acquiredAt: terms.get(name), expiresAt: Date.now() + 90_000 }
      },
      onChange: status => {
        if (status.state === 'held') {
          handover.leaseTerm(self, String(status.acquiredAt))
        }
      },
      random: () => 0.5
    })

    return self
  }

  const moon = agent('moon', '00000000-0000-4000-8000-75c02539218c')
  const andy = agent('andy', '00000000-0000-4000-8000-127ad7633157')

  const reconcile = (each: Agent) =>
    handover.competes(each) ? each.lease.start(each.executorId) : void each.lease.release()

  const handover: MatrixLeaseHandover<Agent> = new MatrixLeaseHandover<Agent>({
    release: each => void each.lease.release(),
    resume: reconcile,
    label: each => each.name,
    log: line => logs.push(line)
  })

  return { moon, andy, handover, holders, requests, logs, reconcile }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-10T00:00:00Z'))
})

afterEach(() => vi.useRealTimers())

describe('a Mac that cannot finish turns hands the agent over', () => {
  it('releases the lease on the second unanswered turn in a row, never the first', async () => {
    const f = fixture()
    f.reconcile(f.moon)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.moon.lease.current.state).toBe('held')

    expect(f.handover.trouble(f.moon, { kind: 'failed', streak: 1 })).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.moon.lease.current.state).toBe('held')
    expect(f.handover.competes(f.moon)).toBe(true)

    expect(f.handover.trouble(f.moon, { kind: 'deferred_exhausted', streak: 2 })).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.moon.lease.current.state).toBe('idle')
    expect(f.requests.at(-1)).toEqual({ operation: 'release', executorId: f.moon.executorId })
    expect(f.holders.has('moon')).toBe(false)
    // Closed codes only.
    expect(f.logs).toEqual(['[Matrix] lease handover moon released kind=deferred_exhausted streak=2'])
  })

  it('stays out of the race for three minutes, so another Mac can take the agent', async () => {
    const f = fixture()
    f.reconcile(f.moon)
    await vi.advanceTimersByTimeAsync(0)
    f.handover.trouble(f.moon, { kind: 'failed', streak: 2 })
    await vi.advanceTimersByTimeAsync(0)
    const acquires = () => f.requests.filter(each => each.operation === 'acquire').length
    const before = acquires()

    // Lifecycle reconciles during the hold-off do not compete.
    for (let at = 0; at < 5; at += 1) {
      f.reconcile(f.moon)
      await vi.advanceTimersByTimeAsync(30_000)
    }

    expect(acquires()).toBe(before)
    expect(f.handover.competes(f.moon)).toBe(false)
    expect(f.moon.lease.current.state).toBe('idle')

    // Another Mac took it meanwhile: once the hold-off ends this one competes and waits its turn.
    f.holders.set('moon', 'another-mac')
    await vi.advanceTimersByTimeAsync(HOLD - 150_000)
    expect(f.handover.competes(f.moon)).toBe(true)
    expect(acquires()).toBe(before + 1)
    expect(f.moon.lease.current.state).toBe('elsewhere')
    expect(f.logs.at(-1)).toBe('[Matrix] lease handover moon resumed')
  })

  it('takes the agent back after the hold-off when nobody else did', async () => {
    const f = fixture()
    f.reconcile(f.moon)
    await vi.advanceTimersByTimeAsync(0)
    f.handover.trouble(f.moon, { kind: 'failed', streak: 2 })
    await vi.advanceTimersByTimeAsync(HOLD - 1)
    expect(f.moon.lease.current.state).toBe('idle')
    await vi.advanceTimersByTimeAsync(1)
    expect(f.moon.lease.current.state).toBe('held')
  })

  it('never moves another agent', async () => {
    const f = fixture()
    f.reconcile(f.moon)
    f.reconcile(f.andy)
    await vi.advanceTimersByTimeAsync(0)

    f.handover.trouble(f.moon, { kind: 'failed', streak: 2 })
    f.reconcile(f.andy)
    await vi.advanceTimersByTimeAsync(0)

    expect(f.moon.lease.current.state).toBe('idle')
    expect(f.andy.lease.current.state).toBe('held')
    expect(f.handover.competes(f.andy)).toBe(true)
    expect(f.requests.filter(each => each.operation === 'release' && each.executorId === f.andy.executorId)).toEqual([])
  })

  it('needs two new failures of its own before stepping aside again', async () => {
    const f = fixture()
    f.reconcile(f.moon)
    await vi.advanceTimersByTimeAsync(0)
    f.handover.trouble(f.moon, { kind: 'failed', streak: 2 })
    // The term it gave up finishes one more unanswered turn: nothing new.
    expect(f.handover.trouble(f.moon, { kind: 'failed', streak: 3 })).toBe(false)
    await vi.advanceTimersByTimeAsync(HOLD)
    expect(f.moon.lease.current.state).toBe('held')

    // Back on this Mac, one more failure is a single failure.
    expect(f.handover.trouble(f.moon, { kind: 'failed', streak: 4 })).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.moon.lease.current.state).toBe('held')
    expect(f.handover.trouble(f.moon, { kind: 'failed', streak: 5 })).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.moon.lease.current.state).toBe('idle')
  })

  it('counts afresh after an answered turn reset the streak', async () => {
    const f = fixture()
    f.handover.trouble(f.moon, { kind: 'failed', streak: 2 })
    await vi.advanceTimersByTimeAsync(HOLD)

    // An answer (the listener calls nothing), then two failures in a row.
    expect(f.handover.trouble(f.moon, { kind: 'failed', streak: 1 })).toBe(false)
    expect(f.handover.trouble(f.moon, { kind: 'failed', streak: 2 })).toBe(true)
  })

  it('never counts a failure from an earlier term toward a fresh one', async () => {
    const f = fixture()
    f.reconcile(f.moon)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.handover.trouble(f.moon, { kind: 'failed', streak: 1 })).toBe(false)

    // This Mac lost the agent for a while (another Mac answered there), then took it back.
    await f.moon.lease.release()
    f.holders.set('moon', 'another-mac')
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    f.holders.delete('moon')
    f.reconcile(f.moon)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.moon.lease.current.state).toBe('held')

    // Its first failure of the new term is a single failure, though the streak reads 2.
    expect(f.handover.trouble(f.moon, { kind: 'failed', streak: 2 })).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.moon.lease.current.state).toBe('held')
    expect(f.handover.trouble(f.moon, { kind: 'failed', streak: 3 })).toBe(true)
  })

  it('a renewal of the same term keeps counting', async () => {
    const f = fixture()
    f.reconcile(f.moon)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.handover.trouble(f.moon, { kind: 'failed', streak: 1 })).toBe(false)
    // Several renewals later, still the same term.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.moon.lease.current.state).toBe('held')
    expect(f.handover.trouble(f.moon, { kind: 'failed', streak: 2 })).toBe(true)
  })

  it('reads three handovers within an hour as persistent trouble, and lets it fade', async () => {
    const f = fixture()

    for (let round = 1; round <= 3; round += 1) {
      expect(f.handover.persistent(f.moon)).toBe(false)
      f.handover.trouble(f.moon, { kind: 'failed', streak: 2 * round })
      await vi.advanceTimersByTimeAsync(HOLD)
    }

    expect(f.handover.persistent(f.moon)).toBe(true)
    expect(f.handover.persistent(f.andy)).toBe(false)
    // The first falls out of the hour.
    await vi.advanceTimersByTimeAsync(MATRIX_LEASE_HANDOVER.windowMs - 3 * HOLD + 1)
    expect(f.handover.persistent(f.moon)).toBe(false)
  })

  it('forgets an agent at sign-out, hold-off included', async () => {
    const f = fixture()
    const resume = vi.fn()
    const handover = new MatrixLeaseHandover<Agent>({ release: () => {}, resume })
    handover.trouble(f.moon, { kind: 'failed', streak: 2 })
    handover.forget(f.moon)
    expect(handover.competes(f.moon)).toBe(true)
    await vi.advanceTimersByTimeAsync(HOLD)
    expect(resume).not.toHaveBeenCalled()
  })

  it('never throws into the listener', () => {
    const f = fixture()

    const handover = new MatrixLeaseHandover<Agent>({
      release: () => {
        throw new Error('synthetic')
      },
      resume: () => {},
      log: () => {
        throw new Error('synthetic')
      }
    })

    expect(handover.trouble(f.moon, { kind: 'failed', streak: 2 })).toBe(true)
    expect(handover.trouble(f.andy, { kind: 'failed', streak: Number.NaN })).toBe(false)
  })
})

describe('a Mac stuck re-arming hands the agent over too', () => {
  const roomId = '!room:test'

  /** main's automatic listening for one agent, against its real lease: armHermesWatch's
   * incomplete catch-up is `pause('overflow', true)` then a throw, until the catch-up completes. */
  function listening(f: ReturnType<typeof fixture>, agent: Agent) {
    let complete = false
    let current: { state: 'listening' | 'stopped'; reason?: 'unavailable' } | undefined

    const saved: ContinuousListeningPreference = {
      version: 1,
      binding: 'a'.repeat(64),
      roomId,
      enabledAt: Date.now()
    }

    const values = new Map([['matrix-continuous-listening-v1', JSON.stringify(saved)]])

    const controller: MatrixContinuousListening = new MatrixContinuousListening({
      automatic: true,
      store: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => void values.set(key, value),
        removeItem: key => void values.delete(key)
      },
      context: () =>
        agent.lease.held(agent.executorId)
          ? { state: 'ready' }
          : { state: 'waiting', reason: f.handover.competes(agent) ? 'unavailable' : 'lease_elsewhere' },
      arm: async () => {
        if (!complete) {
          controller.pause('overflow', true)

          throw new Error('matrix_catchup_incomplete')
        }

        current = { state: 'listening' }
      },
      stop: () => {
        if (current?.state === 'listening') {
          current = undefined
        }
      },
      listener: () => current && { ...current, roomId, expiresAt: Date.now() + 3_600_000, queued: 0 },
      changed: () => {},
      recovering: reason => void f.handover.recovering(agent, reason),
      armed: () => f.handover.armed(agent)
    })

    return {
      controller,
      completes(value: boolean) {
        complete = value
      },
      /** The committed watch stops unavailable (a turn's drain threw). */
      stops() {
        current = { state: 'stopped', reason: 'unavailable' }
        controller.listenerChanged()
        current = undefined
      }
    }
  }

  it('an incomplete catch-up that keeps coming back does not keep the lease from another Mac', async () => {
    const f = fixture()
    f.reconcile(f.moon)
    f.reconcile(f.andy)
    await vi.advanceTimersByTimeAsync(0)
    const watch = listening(f, f.moon)

    watch.controller.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    // One incomplete catch-up is a single failure: it keeps the lease and retries.
    expect(f.moon.lease.current.state).toBe('held')
    expect(f.handover.competes(f.moon)).toBe(true)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.moon.lease.current.state).toBe('idle')
    expect(f.holders.has('moon')).toBe(false)
    expect(f.handover.competes(f.moon)).toBe(false)
    expect(f.logs).toEqual(['[Matrix] lease handover moon released kind=recovering reason=overflow streak=2'])

    // Another Mac takes the agent; this one stays out, and the other agent is untouched.
    f.holders.set('moon', 'another-mac')
    f.reconcile(f.moon)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.moon.lease.current.state).toBe('idle')
    expect(f.andy.lease.current.state).toBe('held')
    expect(f.handover.competes(f.andy)).toBe(true)
  })

  it('a watch that armed between failures keeps the lease', async () => {
    const f = fixture()
    f.reconcile(f.moon)
    await vi.advanceTimersByTimeAsync(0)
    const watch = listening(f, f.moon)

    watch.controller.reconcile()
    await vi.advanceTimersByTimeAsync(0)
    watch.completes(true)

    for (let round = 0; round < 3; round += 1) {
      await vi.advanceTimersByTimeAsync(10_000)
      expect(watch.controller.snapshot()?.state).toBe('listening')
      watch.stops()
    }

    await vi.advanceTimersByTimeAsync(0)
    expect(f.moon.lease.current.state).toBe('held')
    expect(f.handover.competes(f.moon)).toBe(true)
    expect(f.logs).toEqual([])
  })
})

// 020 assembly: the real listener's `onTrouble` (hermes-listener.ts) into the handover, wired the
// way main.ts's createListener wires it, against a real lease.
describe('the listener reports unanswered turns straight into the handover', () => {
  function listened(f: ReturnType<typeof fixture>, agent: Agent) {
    const watch = {
      id: 'watch',
      roomId: '!room:test',
      since: Date.now(),
      until: Date.now() + 15 * 60_000,
      sender: { userId: '@owner:test', deviceId: 'DEVICE' },
      automatic: { windowStart: Date.now() }
    }

    const pending: Array<(outcome: MatrixTurnOutcome) => void> = []

    const listener = new MatrixHermesListener(
      () => new Promise<MatrixTurnOutcome>(resolve => pending.push(resolve)),
      () => {},
      { onTrouble: event => void f.handover.trouble(agent, event) }
    )

    listener.start(watch)

    return {
      listener,
      /** Offers a message and settles its turn with this outcome. */
      turn: async (eventId: string, outcome: MatrixTurnOutcome) => {
        listener.offer({ watchId: watch.id, roomId: watch.roomId, eventId })
        await vi.advanceTimersByTimeAsync(0)
        pending.shift()!(outcome)
        await vi.advanceTimersByTimeAsync(0)
      }
    }
  }

  it('two turns failing after dispatch release the lease and hold this Mac off; one does not', async () => {
    const f = fixture()
    f.reconcile(f.moon)
    await vi.advanceTimersByTimeAsync(0)
    const moon = listened(f, f.moon)

    await moon.turn('$a', { state: 'unknown', failed: 'matrix_hermes_outcome_unknown' })
    expect(f.moon.lease.current.state).toBe('held')
    expect(f.handover.competes(f.moon)).toBe(true)

    await moon.turn('$b', { state: 'unknown', failed: 'matrix_turn_timeout' })
    expect(f.moon.lease.current.state).toBe('idle')
    expect(f.holders.has('moon')).toBe(false)
    expect(f.handover.competes(f.moon)).toBe(false)
    expect(f.logs).toEqual(['[Matrix] lease handover moon released kind=failed streak=2'])

    await vi.advanceTimersByTimeAsync(HOLD)
    expect(f.handover.competes(f.moon)).toBe(true)
    moon.listener.stop()
  })

  it('an answer between two failures keeps the lease', async () => {
    const f = fixture()
    f.reconcile(f.moon)
    await vi.advanceTimersByTimeAsync(0)
    const moon = listened(f, f.moon)

    await moon.turn('$a', { state: 'unknown', failed: 'unexpected' })
    await moon.turn('$b', { state: 'published', eventId: '$answer' })
    await moon.turn('$c', { state: 'unknown', failed: 'unexpected' })

    expect(f.moon.lease.current.state).toBe('held')
    expect(f.handover.competes(f.moon)).toBe(true)
    expect(f.logs).toEqual([])
    moon.listener.stop()
  })
})
