import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import answered from './fixtures/agent-turns-v1.1/presentation-answered.sequence.json'
import refused from './fixtures/agent-turns-v1.1/presentation-refused.sequence.json'
import afterOutcome from './fixtures/agent-turns-v1.1/presentation-typing-after-outcome.sequence.json'
import beforeAdmission from './fixtures/agent-turns-v1.1/presentation-typing-before-admission.sequence.json'
import whileWaiting from './fixtures/agent-turns-v1.1/presentation-typing-while-waiting.sequence.json'
import waitThenResume from './fixtures/agent-turns-v1.1/presentation-wait-then-resume.sequence.json'
import receipts from './fixtures/agent-turns-v1.1/receipt-targets.vectors.json'
import { MATRIX_AGENT_SIGNALS } from './matrix-agent-signals'
import {
  type MatrixPresentationCommand,
  type MatrixPresentationEvent,
  MatrixPresentationSignals,
  type MatrixPresentationState,
  matrixPresentationTransition,
  type MatrixReceiptDisposition,
  type MatrixReceiptEvent,
  matrixReceiptTarget,
  matrixTypingBody
} from './matrix-presentation-signals'

describe('frozen agent-turns/v1.1 presentation contract', () => {
  it.each(receipts.vectors)('$name', vector => {
    expect(matrixReceiptTarget(vector.events as MatrixReceiptEvent[], vector.previous)).toBe(vector.target)
  })

  it.each([answered, refused, waitThenResume])('accepts a valid status path', sequence => {
    for (const step of sequence.steps) {
      expect(
        matrixPresentationTransition(step.from as MatrixPresentationState, step.event as MatrixPresentationEvent)
      ).toBe(step.to)
    }
  })

  it.each([beforeAdmission, whileWaiting, afterOutcome])('rejects invalid typing edges', sequence => {
    const last = sequence.steps.at(-1)!
    expect(
      matrixPresentationTransition(last.from as MatrixPresentationState, last.event as MatrixPresentationEvent)
    ).toBeNull()
  })

  it('never passes an unresolved turn after the last agent message or moves a receipt backwards', () => {
    const kinds: MatrixReceiptDisposition[] = [
      'admitted',
      'answered',
      'status_shown',
      'not_a_turn',
      'unchecked',
      'refused_silently',
      'agent_message'
    ]

    for (let vector = 0; vector < kinds.length ** 4; vector++) {
      let remaining = vector

      const events = Array.from({ length: 4 }, (_, index) => {
        const disposition = kinds[remaining % kinds.length]!
        remaining = Math.floor(remaining / kinds.length)

        return { eventId: `$e${index}`, disposition }
      })

      const target = matrixReceiptTarget(events)
      const targetAt = events.findIndex(event => event.eventId === target)
      const spokeAt = events.findLastIndex(event => event.disposition === 'agent_message')

      if (targetAt >= 0) {
        expect(['admitted', 'answered', 'status_shown']).toContain(events[targetAt]!.disposition)
        expect(
          events
            .slice(spokeAt + 1, targetAt + 1)
            .some(event => ['unchecked', 'refused_silently'].includes(event.disposition))
        ).toBe(false)
      }

      for (const previous of events) {
        const next = matrixReceiptTarget(events, previous.eventId)

        if (next !== null) {
          expect(events.findIndex(event => event.eventId === next)).toBeGreaterThan(events.indexOf(previous))
        }
      }
    }
  })

  it('retains the private SDK target before a hold without making unrelated group messages eligible', () => {
    const events: MatrixReceiptEvent[] = [
      { eventId: '$q1', disposition: 'answered' },
      { eventId: '$answer', disposition: 'agent_message' },
      { eventId: '$denied', disposition: 'unchecked' },
      { eventId: '$q3', disposition: 'admitted' }
    ]

    expect(matrixReceiptTarget(events)).toBe('$q1')
    expect(matrixReceiptTarget(events.map(event => ({ ...event, receiptEligible: true })))).toBe('$answer')
    expect(matrixReceiptTarget([{ eventId: '$other-person', disposition: 'not_a_turn' }])).toBeNull()
  })

  it('bounds a crash notice at 30 seconds and removes the timeout on stop', () => {
    expect(matrixTypingBody(true)).toEqual({ typing: true, timeout: 30_000 })
    expect(matrixTypingBody(false)).toEqual({ typing: false })
    expect(MATRIX_AGENT_SIGNALS.typingRenewMs).toBeLessThan(MATRIX_AGENT_SIGNALS.typingTimeoutMs)
  })
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function fixture() {
  let held = true
  const sent: MatrixPresentationCommand[] = []
  const log = vi.fn()

  const signals = new MatrixPresentationSignals({
    send: async command => void sent.push(command),
    owner: () => '@owner:test',
    leaseHeld: () => held,
    every: (milliseconds, run) => {
      const timer = setInterval(run, milliseconds)

      return () => clearInterval(timer)
    },
    log
  })

  const typing = () => sent.filter(command => command.kind === 'agentTyping').map(command => command.typing)

  return { signals, sent, log, typing, lease: (value: boolean) => (held = value) }
}

describe('one emitter through a deterministic clock and lease port', () => {
  it('emits neither admission receipts nor typing without a lease', () => {
    const { signals, sent, lease } = fixture()
    lease(false)
    signals.seen('!r:test', '$q1')
    signals.work('!r:test').stop()
    vi.advanceTimersByTime(60_000)
    expect(sent).toEqual([])
  })

  it('acknowledges the answer of a turn claimed under the lease once the lease went idle, and nothing new', () => {
    const { signals, sent, typing, lease } = fixture()
    const room = '!r:test'
    // Taken up under the lease, worked on, answered; the run's end leaves no work, so the lease
    // goes idle a moment before the answer reaches the room.
    signals.seen(room, '$q1')
    signals.work(room).stop()
    lease(false)
    signals.seen(room, '$q1', 'claimed')
    // Without the lease nothing new is taken up, and nobody types.
    signals.seen(room, '$q2')
    signals.work(room).stop()
    vi.advanceTimersByTime(60_000)

    expect(sent.filter(command => command.kind === 'agentSeen')).toEqual([
      { kind: 'agentSeen', roomId: room, eventId: '$q1', ownerId: '@owner:test', admitted: ['$q1'] },
      { kind: 'agentSeen', roomId: room, eventId: '$q1', ownerId: '@owner:test', admitted: ['$q1'] }
    ])
    expect(typing()).toEqual([true, false])
  })

  it('renews every 20 seconds, stops on lease loss, and cannot resume an old work handle', async () => {
    const { signals, typing, lease } = fixture()
    const work = signals.work('!r:test')
    vi.advanceTimersByTime(40_000)
    expect(typing()).toEqual([true, true, true])
    lease(false)
    vi.advanceTimersByTime(20_000)
    expect(typing()).toEqual([true, true, true, false])
    lease(true)
    await work.waiting(Promise.resolve('late'))
    vi.advanceTimersByTime(60_000)
    work.stop()
    expect(typing()).toEqual([true, true, true, false])
    signals.work('!r:test').stop()
    expect(typing()).toEqual([true, true, true, false, true, false])
  })

  it('stops for all nested approval/device waits and renews only after the last wait ends', async () => {
    const { signals, typing } = fixture()
    const work = signals.work('!r:test')
    let finishApproval!: () => void
    let finishDevice!: () => void
    const approval = work.waiting(new Promise<void>(resolve => (finishApproval = resolve)))
    const device = work.waiting(new Promise<void>(resolve => (finishDevice = resolve)))
    vi.advanceTimersByTime(60_000)
    expect(typing()).toEqual([true, false])
    finishApproval()
    await approval
    expect(typing()).toEqual([true, false])
    finishDevice()
    await device
    expect(typing()).toEqual([true, false, true])
    work.stop()
    expect(typing()).toEqual([true, false, true, false])
  })

  it('cancels every timer and prevents a late wait from restarting after sign-out', async () => {
    const { signals, typing } = fixture()
    const first = signals.work('!r:test')
    signals.work('!other:test')
    let finish!: () => void
    const wait = first.waiting(new Promise<void>(resolve => (finish = resolve)))
    signals.stop()
    const stopped = [...typing()]
    finish()
    await wait
    vi.advanceTimersByTime(120_000)
    expect(typing()).toEqual(stopped)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps admission sets room-scoped and bounded and drops secret-bearing transport errors', async () => {
    const { signals, sent } = fixture()

    for (let index = 0; index < 70; index++) {
      signals.seen('!r:test', `$q${index}`)
    }

    signals.seen('!other:test', '$other')
    expect(sent.at(-2)).toMatchObject({
      eventId: '$q69',
      admitted: Array.from({ length: 64 }, (_, index) => `$q${index + 6}`)
    })
    expect(sent.at(-1)).toMatchObject({ admitted: ['$other'] })
    const log = vi.fn()

    const failed = new MatrixPresentationSignals({
      send: () => {
        throw new Error('private-token-and-message')
      },
      owner: () => '@owner:test',
      leaseHeld: () => true,
      every: () => () => {},
      log
    })

    expect(() => failed.seen('!r:test', '$q')).not.toThrow()
    await Promise.resolve()
    expect(log).toHaveBeenCalledWith('[Matrix] agent read receipt not sent: unexpected')
  })
})
