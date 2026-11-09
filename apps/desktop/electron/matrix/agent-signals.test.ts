import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MATRIX_AGENT_SIGNALS } from '../../shared/matrix-agent-signals'

import { type MatrixAgentSignalCommand, MatrixAgentSignals, matrixWorkingAsk } from './agent-signals'
import type { MatrixHermesAsk } from './hermes-prompts'
import { MatrixExecutorLease } from './lease'

const owner = '@owner:test'
const room = '!assistant:test'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function fixture(ownerId: string | null = owner) {
  const sent: MatrixAgentSignalCommand[] = []
  const log = vi.fn()
  const send = vi.fn(async (command: MatrixAgentSignalCommand) => void sent.push(command))
  const signals = new MatrixAgentSignals({ send, owner: () => ownerId ?? undefined, log })
  const typing = () => sent.filter(command => command.kind === 'agentTyping').map(command => command.typing)

  return { signals, sent, send, log, typing }
}

describe('the agent read receipt request', () => {
  it('names the message and every message this Mac took up in that room, newest last, bounded', () => {
    const { signals, sent } = fixture()

    signals.seen(room, '$q1')
    signals.seen('!other:test', '$x')
    signals.seen(room, '$q2')
    signals.seen(room, '$q1')

    expect(sent).toEqual([
      { kind: 'agentSeen', roomId: room, eventId: '$q1', ownerId: owner, admitted: ['$q1'] },
      { kind: 'agentSeen', roomId: '!other:test', eventId: '$x', ownerId: owner, admitted: ['$x'] },
      { kind: 'agentSeen', roomId: room, eventId: '$q2', ownerId: owner, admitted: ['$q1', '$q2'] },
      { kind: 'agentSeen', roomId: room, eventId: '$q1', ownerId: owner, admitted: ['$q2', '$q1'] }
    ])

    for (let index = 0; index < MATRIX_AGENT_SIGNALS.admittedMax + 5; index++) {
      signals.seen(room, `$m${index}`)
    }

    const last = sent.at(-1) as Extract<MatrixAgentSignalCommand, { kind: 'agentSeen' }>
    expect(last.admitted).toHaveLength(MATRIX_AGENT_SIGNALS.admittedMax)
    expect(last.admitted.at(-1)).toBe(last.eventId)
  })

  it('sends nothing without the owner or for something that is not an event, and forgets on stop', () => {
    const none = fixture(null)
    none.signals.seen(room, '$q1')
    none.signals.work(room).stop()
    expect(none.send).not.toHaveBeenCalled()

    const { signals, sent } = fixture()
    signals.seen(room, '~local')
    expect(sent).toEqual([])
    signals.seen(room, '$q1')
    signals.stop()
    signals.seen(room, '$q2')
    expect(sent.at(-1)).toMatchObject({ eventId: '$q2', admitted: ['$q2'] })
  })

  it('drops a failed request with a log line, never a throw', async () => {
    const log = vi.fn()

    const signals = new MatrixAgentSignals({
      send: () => Promise.reject(new Error('matrix_offline')),
      owner: () => owner,
      log
    })

    signals.seen(room, '$q1')
    await vi.runAllTimersAsync()
    expect(log).toHaveBeenCalledWith('[Matrix] agent read receipt not sent: matrix_offline')

    const throwing = new MatrixAgentSignals({
      send: () => {
        throw new Error('matrix_sdk_unavailable')
      },
      owner: () => owner,
      log
    })

    expect(() => throwing.work(room).stop()).not.toThrow()
    await vi.runAllTimersAsync()
    expect(log).toHaveBeenCalledWith('[Matrix] agent typing not sent: matrix_sdk_unavailable')
  })
})

describe('the agent typing notice', () => {
  it('starts as the turn works, renews about every 20 seconds within its 30 second timeout, and stops at the end', () => {
    const { signals, typing } = fixture()
    expect(MATRIX_AGENT_SIGNALS.typingRenewMs).toBeLessThan(MATRIX_AGENT_SIGNALS.typingTimeoutMs)
    expect(MATRIX_AGENT_SIGNALS.typingTimeoutMs).toBeLessThanOrEqual(30_000)

    const work = signals.work(room)
    expect(typing()).toEqual([true])
    vi.advanceTimersByTime(MATRIX_AGENT_SIGNALS.typingRenewMs * 2)
    expect(typing()).toEqual([true, true, true])

    work.stop()
    work.stop()
    expect(typing()).toEqual([true, true, true, false])
    vi.advanceTimersByTime(MATRIX_AGENT_SIGNALS.typingRenewMs * 3)
    expect(typing()).toEqual([true, true, true, false])
  })

  it('stays on while any turn in the room still works', () => {
    const { signals, typing } = fixture()
    const first = signals.work(room)
    const second = signals.work(room)
    expect(typing()).toEqual([true])

    first.stop()
    expect(typing()).toEqual([true])
    second.stop()
    expect(typing()).toEqual([true, false])
  })

  it('stops while the turn waits on its owner (an approval, a question) and resumes after, even on failure', async () => {
    const { signals, typing } = fixture()
    const work = signals.work(room)
    let answer!: (value: string) => void
    let refuse!: (error: Error) => void

    const approval = work.waiting(new Promise<string>(resolve => (answer = resolve)))
    expect(typing()).toEqual([true, false])
    // No renewal while it waits.
    vi.advanceTimersByTime(MATRIX_AGENT_SIGNALS.typingRenewMs * 2)
    expect(typing()).toEqual([true, false])

    answer('once')
    await expect(approval).resolves.toBe('once')
    expect(typing()).toEqual([true, false, true])

    const question = work.waiting(new Promise<string>((_, reject) => (refuse = reject)))
    refuse(new Error('matrix_hermes_prompt_expired'))
    await expect(question).rejects.toThrow('matrix_hermes_prompt_expired')
    expect(typing()).toEqual([true, false, true, false, true])

    work.stop()
    // A wait after the end never turns typing back on.
    await work.waiting(Promise.resolve('late'))
    expect(typing()).toEqual([true, false, true, false, true, false])
  })

  it('turns everything off on stop, and a turn ending afterwards sends nothing more', () => {
    const { signals, typing } = fixture()
    const work = signals.work(room)
    signals.stop()
    expect(typing()).toEqual([true, false])
    vi.advanceTimersByTime(MATRIX_AGENT_SIGNALS.typingRenewMs * 2)
    work.stop()
    expect(typing()).toEqual([true, false])
  })

  it("pauses through a turn's questions only when that turn types", async () => {
    const { signals, typing } = fixture()
    const ask = vi.fn<MatrixHermesAsk>(async () => ({ kind: 'approval', choice: 'once' }))
    expect(matrixWorkingAsk(ask, undefined)).toBe(ask)

    const work = signals.work(room)
    const asking = matrixWorkingAsk(ask, work)
    const prompt = { kind: 'clarify' as const, question: 'Which?', choices: [] }
    const signal = new AbortController().signal
    await expect(asking(prompt, signal, 1)).resolves.toEqual({ kind: 'approval', choice: 'once' })
    expect(ask).toHaveBeenCalledWith(prompt, signal, 1)
    expect(typing()).toEqual([true, false, true])
    work.stop()
  })
})

describe('native presentation under the real executor lease', () => {
  const executorId = '00000000-0000-4000-8000-75c02539218c'

  function leased() {
    let enrolledExecutor: string | undefined = executorId

    const lease = new MatrixExecutorLease({
      request: async (operation, id) =>
        operation === 'release'
          ? { held: false }
          : { held: true, executorId: id, acquiredAt: 1, expiresAt: Date.now() + 90_000 },
      random: () => 0.5
    })

    const sent: MatrixAgentSignalCommand[] = []

    const signals = new MatrixAgentSignals({
      send: async command => void sent.push(command),
      owner: () => owner,
      // Same fresh identity/held-session predicate supplied by createAgentSignals.
      leaseHeld: () => !!enrolledExecutor && !!lease.held(enrolledExecutor)
    })

    return { lease, signals, sent, identity: (id?: string) => void (enrolledExecutor = id) }
  }

  it('admits notices only with a held lease and never renews old work after release and reacquisition', async () => {
    const f = leased()
    f.signals.seen(room, '$before')
    f.signals.work(room).stop()
    expect(f.sent).toEqual([])

    f.lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    const session = f.lease.held(executorId)!
    f.signals.seen(room, '$accepted')
    const oldWork = f.signals.work(room)
    expect(f.sent.map(command => command.kind)).toEqual(['agentSeen', 'agentTyping'])
    await f.lease.release()
    expect(session.signal.aborted).toBe(true)
    f.signals.seen(room, '$after-loss')
    await vi.advanceTimersByTimeAsync(MATRIX_AGENT_SIGNALS.typingRenewMs)
    expect(f.sent.at(-1)).toMatchObject({ kind: 'agentTyping', typing: false })
    const ended = f.sent.length

    f.lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    await oldWork.waiting(Promise.resolve('late'))
    oldWork.stop()
    await vi.advanceTimersByTimeAsync(MATRIX_AGENT_SIGNALS.typingRenewMs * 2)
    expect(f.sent).toHaveLength(ended)
    f.signals.seen(room, '$new-session')
    expect(f.sent.at(-1)).toMatchObject({ admitted: ['$new-session'] })
    f.signals.stop()
    await f.lease.stop()
  })

  it('still acknowledges the answer of a turn it claimed under the lease after the lease went idle at the end of the run', async () => {
    const f = leased()
    f.lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    f.signals.seen(room, '$question')
    const work = f.signals.work(room)
    work.stop()
    // main: once the run ended nothing is left to execute, so the lease is released before the
    // answer is posted (local-turn.ts executionPending, main.ts reconcileLease).
    await f.lease.release()
    expect(f.lease.held(executorId)).toBeNull()
    f.signals.seen(room, '$question', 'claimed')
    // Anything not claimed under the lease is never acknowledged, and nothing types.
    f.signals.seen(room, '$unclaimed')
    f.signals.work(room).stop()
    await vi.advanceTimersByTimeAsync(MATRIX_AGENT_SIGNALS.typingRenewMs * 2)

    expect(f.sent).toEqual([
      { kind: 'agentSeen', roomId: room, eventId: '$question', ownerId: owner, admitted: ['$question'] },
      { kind: 'agentTyping', roomId: room, ownerId: owner, typing: true },
      { kind: 'agentTyping', roomId: room, ownerId: owner, typing: false },
      { kind: 'agentSeen', roomId: room, eventId: '$question', ownerId: owner, admitted: ['$question'] }
    ])
    f.signals.stop()
    await f.lease.stop()
  })

  it('rechecks the enrolled executor on renewal and refuses a replacement or absent identity', async () => {
    const f = leased()
    f.lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    const work = f.signals.work(room)
    f.identity('00000000-0000-4000-8000-127ad7633157')
    f.signals.seen(room, '$wrong-executor')
    await vi.advanceTimersByTimeAsync(MATRIX_AGENT_SIGNALS.typingRenewMs)
    expect(f.sent).toEqual([
      { kind: 'agentTyping', roomId: room, ownerId: owner, typing: true },
      { kind: 'agentTyping', roomId: room, ownerId: owner, typing: false }
    ])
    f.identity()
    f.signals.seen(room, '$no-identity')
    f.signals.work(room).stop()
    work.stop()
    expect(f.sent).toHaveLength(2)
    f.signals.stop()
    await f.lease.stop()
  })
})
