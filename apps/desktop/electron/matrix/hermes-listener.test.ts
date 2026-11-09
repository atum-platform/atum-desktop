import { afterEach, expect, it, vi } from 'vitest'

import type { MatrixInvocationResult } from '../../shared/matrix'

import {
  MATRIX_DEFERRED_RETRY_MS,
  MATRIX_DEFERRED_START_MARGIN_MS,
  MatrixHermesListener,
  type MatrixTurnLine,
  type MatrixTurnOutcome
} from './hermes-listener'

afterEach(() => vi.useRealTimers())

function fixture() {
  vi.useFakeTimers()

  const watch = {
    id: 'watch',
    roomId: '!room:test',
    since: Date.now(),
    until: Date.now() + 1000,
    sender: { userId: '@owner:test', deviceId: 'DEVICE' }
  }

  const pending: Array<(result: MatrixInvocationResult) => void> = []

  const execute = vi.fn(
    (_hint: unknown, _watch: unknown, _signal: AbortSignal) =>
      new Promise<MatrixInvocationResult>(resolve => pending.push(resolve))
  )

  const changed = vi.fn()
  const listener = new MatrixHermesListener(execute, changed)
  const offer = (eventId: string) => listener.offer({ watchId: watch.id, roomId: watch.roomId, eventId })

  return { listener, watch, execute, changed, pending, offer }
}

it('starts off, serializes distinct events, drops in-flight duplicates and leaves durable replay fencing to invocation', async () => {
  const f = fixture()
  f.offer('$old')
  expect(f.execute).not.toHaveBeenCalled()
  expect(f.listener.snapshot()).toBeUndefined()
  f.listener.start(f.watch)
  f.offer('$a')
  f.offer('$a')
  f.offer('$b')
  f.offer('$b')
  expect(f.execute).toHaveBeenCalledTimes(1)
  expect(f.execute).toHaveBeenCalledWith({ roomId: f.watch.roomId, eventId: '$a' }, f.watch, expect.any(AbortSignal), {
    queuedAt: Date.now(),
    spent: 0
  })
  expect(f.listener.snapshot()?.queued).toBe(1)
  f.pending.shift()!({ state: 'published' })
  await vi.advanceTimersByTimeAsync(0)
  expect(f.execute).toHaveBeenCalledTimes(2)
  f.pending.shift()!({ state: 'published' })
  await vi.advanceTimersByTimeAsync(0)
  f.offer('$a')
  expect(f.execute).toHaveBeenCalledTimes(3)
  f.listener.stop()
})

it('drains one admitted turn on policy handback without admitting or aborting another', async () => {
  const f = fixture()
  f.listener.start(f.watch)
  f.offer('$running')
  f.offer('$queued')
  const signal = f.execute.mock.calls[0][2]

  f.listener.drainAndStop()
  f.offer('$late')
  expect(signal.aborted).toBe(false)
  expect(f.listener.snapshot()).toMatchObject({ state: 'listening', queued: 0 })
  expect(f.execute).toHaveBeenCalledOnce()

  f.pending.shift()!({ state: 'published' })
  await vi.advanceTimersByTimeAsync(0)
  expect(signal.aborted).toBe(true)
  expect(f.listener.snapshot()).toMatchObject({ state: 'stopped', reason: 'cancelled', queued: 0 })
  expect(f.execute).toHaveBeenCalledOnce()
})

it('queues a prepared watch without publishing listening status or executing before its acknowledgement', () => {
  const f = fixture()
  f.listener.prepare(f.watch)
  f.offer('$a')
  f.offer('$a')
  f.offer('$b')

  expect(f.execute).not.toHaveBeenCalled()
  expect(f.changed).not.toHaveBeenCalled()
  expect(f.listener.snapshot()).toBeUndefined()
})

it('commits an exact prepared watch once and drains its queued hints serially', async () => {
  const f = fixture()
  f.listener.prepare(f.watch)
  f.offer('$a')
  f.offer('$b')

  expect(f.listener.commit(f.watch.id)).toBe(true)
  expect(f.listener.commit(f.watch.id)).toBe(false)
  expect(f.execute).toHaveBeenCalledTimes(1)
  expect(f.listener.snapshot()).toMatchObject({ state: 'listening', queued: 1 })

  f.pending.shift()!({ state: 'published' })
  await vi.advanceTimersByTimeAsync(0)
  expect(f.execute).toHaveBeenCalledTimes(2)
  f.pending.shift()!({ state: 'published' })
  await vi.advanceTimersByTimeAsync(0)
  f.listener.stop()
})

it('rejects mismatched and superseded acknowledgements without executing their queued hints', () => {
  const f = fixture()
  f.listener.prepare(f.watch)
  f.offer('$old')
  expect(f.listener.commit('other')).toBe(false)
  expect(f.execute).not.toHaveBeenCalled()

  f.listener.prepare({ ...f.watch, id: 'new' })
  f.listener.offer({ watchId: 'new', roomId: f.watch.roomId, eventId: '$new' })
  expect(f.listener.commit(f.watch.id)).toBe(false)
  expect(f.execute).not.toHaveBeenCalled()
  expect(f.listener.commit('new')).toBe(true)
  expect(f.execute).toHaveBeenCalledTimes(1)
  f.listener.stop()
})

it.each(['stop', 'clear'] as const)(
  'discards prepared hints without executing them on %s before acknowledgement',
  mode => {
    const f = fixture()
    f.listener.prepare(f.watch)
    f.offer('$a')

    if (mode === 'stop') {
      f.listener.stop()
    } else {
      f.listener.clear()
    }

    expect(f.listener.commit(f.watch.id)).toBe(false)
    expect(f.execute).not.toHaveBeenCalled()
  }
)

it('expires and clears prepared hints before acknowledgement', async () => {
  const f = fixture()
  f.listener.prepare(f.watch)
  f.offer('$a')
  await vi.advanceTimersByTimeAsync(1000)

  expect(f.listener.commit(f.watch.id)).toBe(false)
  expect(f.execute).not.toHaveBeenCalled()
  expect(f.listener.snapshot()).toMatchObject({ state: 'stopped', reason: 'expired', queued: 0 })
})

it('keeps listening and drains the next message after an addressed-to-app event is ignored', async () => {
  const f = fixture()
  f.listener.start(f.watch)
  f.offer('$app')
  f.offer('$hermes')
  f.pending.shift()!({ state: 'ignored' })
  await vi.advanceTimersByTimeAsync(0)
  expect(f.listener.snapshot()?.state).toBe('listening')
  expect(f.execute).toHaveBeenCalledTimes(2)
  f.pending.shift()!({ state: 'published' })
  await vi.advanceTimersByTimeAsync(0)
  expect(f.listener.snapshot()?.result).toBe('published')
  f.listener.stop()
})

it('ignores malformed, wrong-watch and cross-room hints', () => {
  const f = fixture()
  f.listener.start(f.watch)

  for (const hint of [
    null,
    {},
    { watchId: 'old', roomId: f.watch.roomId, eventId: '$a' },
    { watchId: f.watch.id, roomId: '!other:test', eventId: '$a' },
    { watchId: f.watch.id, roomId: f.watch.roomId, eventId: 'not-an-event' }
  ]) {
    f.listener.offer(hint)
  }

  expect(f.execute).not.toHaveBeenCalled()
  f.listener.stop()
})

it('account handoff forgets the old room and cannot be repopulated by a late completion', async () => {
  const f = fixture()
  f.listener.start(f.watch)
  f.offer('$running')
  f.offer('$queued')
  f.listener.clear()
  expect(f.execute.mock.calls[0][2].aborted).toBe(true)
  expect(f.listener.snapshot()).toBeUndefined()
  f.pending.shift()!({ state: 'published' })
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.listener.snapshot()).toBeUndefined()
  expect(f.execute).toHaveBeenCalledTimes(1)
  // Clearing is also required after an ordinary Stop, when no work is active.
  f.listener.start(f.watch)
  f.listener.stop()
  expect(f.listener.snapshot()?.state).toBe('stopped')
  f.listener.clear()
  expect(f.listener.snapshot()).toBeUndefined()
})

it.each(['stop', 'expire', 'replace'] as const)(
  'revokes the active signal and clears pending work on %s',
  async mode => {
    const f = fixture()
    f.listener.start(f.watch)
    f.offer('$a')
    f.offer('$b')
    const signal = f.execute.mock.calls[0][2]

    if (mode === 'stop') {
      f.listener.stop()
    } else if (mode === 'expire') {
      await vi.advanceTimersByTimeAsync(1000)
    } else {
      f.listener.start({ ...f.watch, id: 'new' })
    }

    expect(signal.aborted).toBe(true)
    f.pending.shift()!({ state: 'published' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.listener.snapshot()?.queued).toBe(0)

    if (mode !== 'replace') {
      f.offer('$c')
      expect(f.execute).toHaveBeenCalledTimes(1)
      expect(f.listener.snapshot()?.state).toBe('stopped')
    }

    f.listener.stop()
  }
)

it.each(['unknown', 'setup_required', 'publication_pending'] as const)(
  'stops visibly on %s without dispatching the next event',
  async state => {
    const f = fixture()
    f.listener.start(f.watch)
    f.offer('$a')
    f.offer('$b')
    f.pending.shift()!({ state })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.listener.snapshot()).toMatchObject({ state: 'stopped', reason: 'unavailable', result: state })
    expect(f.execute).toHaveBeenCalledTimes(1)
  }
)

it('bounds queued IDs and aborts on overflow', () => {
  const f = fixture()
  f.listener.start(f.watch)

  for (let n = 0; n < 18; n++) {
    f.offer('$' + n)
  }

  expect(f.listener.snapshot()).toMatchObject({ state: 'stopped', reason: 'overflow', queued: 0 })
  expect(f.execute).toHaveBeenCalledTimes(1)
  expect(f.execute.mock.calls[0][2].aborted).toBe(true)
})

it.each(['stop', 'expire', 'overflow'] as const)('retains an interrupted outcome after %s', async mode => {
  const f = fixture()
  f.listener.start(f.watch)
  f.offer('$a')

  if (mode === 'stop') {
    f.listener.stop()
  } else if (mode === 'expire') {
    await vi.advanceTimersByTimeAsync(1000)
  } else {
    for (let n = 0; n < 17; n++) {
      f.offer('$q' + n)
    }
  }

  f.pending.shift()!({ state: 'unknown' })
  await vi.advanceTimersByTimeAsync(0)
  expect(f.listener.snapshot()).toMatchObject({ state: 'stopped', result: 'unknown' })
})

it('never writes an old interrupted result into a replacement watch', async () => {
  const f = fixture()
  f.listener.start(f.watch)
  f.offer('$a')
  f.listener.start({ ...f.watch, id: 'new' })
  f.pending.shift()!({ state: 'unknown' })
  await vi.advanceTimersByTimeAsync(0)
  expect(f.listener.snapshot()).toMatchObject({ state: 'listening' })
  expect(f.listener.snapshot()?.result).toBeUndefined()
  f.listener.stop()
})

it('retains an automatic unknown as interrupted while continuing with later events', async () => {
  const f = fixture()
  f.listener.start({ ...f.watch, automatic: { windowStart: f.watch.since } })
  f.offer('$unknown')
  f.offer('$later')
  f.pending.shift()!({ state: 'unknown' })
  await vi.advanceTimersByTimeAsync(0)
  expect(f.listener.snapshot()).toMatchObject({
    state: 'listening',
    interruptedEventId: '$unknown',
    queued: 0
  })
  expect(f.execute).toHaveBeenCalledTimes(2)
  f.pending.shift()!({ state: 'published' })
  await vi.advanceTimersByTimeAsync(0)
  f.listener.stop()
})

it('publishes a lone automatic interruption immediately and keeps it through a transport pause', async () => {
  const f = fixture()
  const published: Array<ReturnType<MatrixHermesListener['snapshot']>> = []
  f.changed.mockImplementation(() => published.push(f.listener.snapshot()))
  f.listener.start({ ...f.watch, automatic: { windowStart: f.watch.since } })
  f.offer('$uncertain')
  f.pending.shift()!({ state: 'unknown' })
  await vi.advanceTimersByTimeAsync(0)
  expect(published.at(-1)).toMatchObject({ state: 'listening', interruptedEventId: '$uncertain' })
  expect(f.execute).toHaveBeenCalledOnce()
  f.listener.stop('unavailable')
  expect(f.listener.snapshot()).toMatchObject({ state: 'stopped', interruptedEventId: '$uncertain' })
  f.listener.clear()
  expect(f.listener.snapshot()).toBeUndefined()
})

it.each(['stop', 'clear', 'replace'] as const)('fences a late automatic interruption after %s', async mode => {
  const f = fixture()
  f.listener.start({ ...f.watch, automatic: { windowStart: f.watch.since } })
  f.offer('$uncertain')

  if (mode === 'clear') {
    f.listener.clear()
  } else if (mode === 'replace') {
    f.listener.start({ ...f.watch, id: 'new', roomId: '!other:test' })
  } else {
    f.listener.stop('unavailable')
  }

  f.pending.shift()!({ state: 'unknown' })
  await vi.advanceTimersByTimeAsync(0)

  if (mode === 'stop') {
    expect(f.listener.snapshot()).toMatchObject({ state: 'stopped', result: 'unknown', interruptedEventId: '$uncertain' })
  } else if (mode === 'clear') {
    expect(f.listener.snapshot()).toBeUndefined()
  } else {
    expect(f.listener.snapshot()).toMatchObject({ state: 'listening', roomId: '!other:test' })
    expect(f.listener.snapshot()?.interruptedEventId).toBeUndefined()
  }

  expect(f.execute).toHaveBeenCalledOnce()
  f.listener.clear()
})

it('drains automatic recovery backfill before live hints and deduplicates their overlap', async () => {
  const f = fixture()
  const watch = { ...f.watch, automatic: { windowStart: f.watch.since } }
  f.listener.prepare(watch)
  f.listener.offer({ watchId: watch.id, roomId: watch.roomId, eventId: '$live' })
  f.listener.offer({ watchId: watch.id, roomId: watch.roomId, eventId: '$same' })
  f.listener.backfill(watch.id, [
    { watchId: watch.id, roomId: watch.roomId, eventId: '$recovered' },
    { watchId: watch.id, roomId: watch.roomId, eventId: '$same' }
  ])
  expect(f.listener.commit(watch.id)).toBe(true)
  expect(f.execute.mock.calls.map(([target]) => (target as { eventId: string }).eventId)).toEqual(['$recovered'])
  f.pending.shift()!({ state: 'published' })
  await vi.advanceTimersByTimeAsync(0)
  expect(f.execute.mock.calls.map(([target]) => (target as { eventId: string }).eventId)).toEqual([
    '$recovered',
    '$same'
  ])
  f.pending.shift()!({ state: 'published' })
  await vi.advanceTimersByTimeAsync(0)
  expect(f.execute.mock.calls.map(([target]) => (target as { eventId: string }).eventId)).toEqual([
    '$recovered',
    '$same',
    '$live'
  ])
  f.pending.shift()!({ state: 'published' })
  await vi.advanceTimersByTimeAsync(0)
  f.listener.stop()
})

it('keeps automatic recovery bounded and blocks on scan overflow', () => {
  const f = fixture()
  const watch = { ...f.watch, automatic: { windowStart: f.watch.since } }
  f.listener.prepare(watch)
  f.listener.backfill(
    watch.id,
    Array.from({ length: 257 }, (_, index) => ({ watchId: watch.id, roomId: watch.roomId, eventId: `$scan-${index}` }))
  )
  expect(f.listener.commit(watch.id)).toBe(false)
  expect(f.listener.snapshot()).toMatchObject({ state: 'stopped', reason: 'overflow', queued: 0 })
  expect(f.execute).not.toHaveBeenCalled()
})

// A renewed credential (credential-renewal.ts) moves the end of the watch it admits, so a turn
// running across the old expiry is not cut (launch checklist G1-12; stream RT, slice 2).
it('moves a watch to its renewed end without interrupting the running turn, and ends it there', async () => {
  const f = fixture()
  f.listener.start(f.watch)
  f.offer('$a')
  const signal = f.execute.mock.calls[0]![2]
  const running = f.execute.mock.calls[0]![1]
  f.changed.mockClear()

  const extended = f.listener.extend(watch => watch.until + 60_000)

  expect(extended).toEqual({ ...f.watch, until: f.watch.until })
  expect(extended?.until).toBe(Date.now() + 61_000)
  // In place: the running turn reads the new end.
  expect(running).toBe(f.watch)
  expect(f.watch.until).toBe(Date.now() + 61_000)
  expect(f.listener.snapshot()).toMatchObject({ state: 'listening', expiresAt: Date.now() + 61_000 })
  expect(f.changed).toHaveBeenCalled()

  // Past the old end: still listening, the turn not aborted.
  await vi.advanceTimersByTimeAsync(1_000)
  expect(signal.aborted).toBe(false)
  expect(f.listener.snapshot()?.state).toBe('listening')

  // At the new end: stopped as expired.
  await vi.advanceTimersByTimeAsync(60_000)
  expect(signal.aborted).toBe(true)
  expect(f.listener.snapshot()).toMatchObject({ state: 'stopped', reason: 'expired' })
})

it('never shortens a watch, never extends one already ended, and moves a prepared one too', async () => {
  const f = fixture()
  expect(f.listener.extend(() => Date.now() + 60_000)).toBeUndefined()

  f.listener.prepare(f.watch)
  expect(f.listener.extend(watch => watch.until - 1)).toBeUndefined()
  expect(f.listener.extend(() => Number.NaN)).toBeUndefined()
  expect(f.watch.until).toBe(Date.now() + 1000)

  expect(f.listener.extend(() => Date.now() + 5_000)?.until).toBe(Date.now() + 5_000)
  expect(f.listener.snapshot()).toBeUndefined()
  expect(f.listener.commit(f.watch.id)).toBe(true)
  expect(f.listener.snapshot()?.expiresAt).toBe(Date.now() + 5_000)

  f.listener.stop()
  expect(f.listener.extend(() => Date.now() + 60_000)).toBeUndefined()
})

// 0.20 turn path: a turn refused before dispatch is offered again, quietly; a turn that ends
// unanswered tells the owner (onTrouble) with the streak since the last answer.
function troubled(onTrouble = vi.fn()) {
  vi.useFakeTimers()

  const watch = {
    id: 'watch',
    roomId: '!room:test',
    since: Date.now(),
    until: Date.now() + 15 * 60_000,
    sender: { userId: '@owner:test', deviceId: 'DEVICE' },
    automatic: { windowStart: Date.now() }
  }

  const pending: Array<(result: MatrixTurnOutcome) => void> = []

  const execute = vi.fn(
    (_hint: { roomId: string; eventId: string }, _watch: unknown, _signal: AbortSignal, _line: MatrixTurnLine) =>
      new Promise<MatrixTurnOutcome>(resolve => pending.push(resolve))
  )

  const changed = vi.fn()
  const listener = new MatrixHermesListener(execute, changed, { onTrouble })
  const offer = (eventId: string) => listener.offer({ watchId: watch.id, roomId: watch.roomId, eventId })
  const ran = () => execute.mock.calls.map(([target]) => target.eventId)
  const lines = () => execute.mock.calls.map(([, , , line]) => line)

  /** Settles the oldest running turn and lets the listener move on. */
  const settle = async (outcome: MatrixTurnOutcome) => {
    pending.shift()!(outcome)
    await vi.advanceTimersByTimeAsync(0)
  }

  return { listener, watch, execute, changed, onTrouble, offer, ran, lines, settle }
}

const DEFERRED: MatrixTurnOutcome = { state: 'deferred', reason: 'matrix_hermes_continuity_unavailable' }

it('offers a deferred turn again after its wait, ahead of later messages, without stopping or a status', async () => {
  const f = troubled()
  f.listener.start(f.watch)
  f.offer('$first')
  f.offer('$second')
  await f.settle(DEFERRED)

  // Still listening, nothing recorded for the chat, and the queue waits behind the retry.
  expect(f.listener.snapshot()).toMatchObject({ state: 'listening', queued: 1 })
  expect(f.listener.snapshot()?.result).toBeUndefined()
  expect(f.listener.snapshot()?.interruptedEventId).toBeUndefined()
  expect(f.ran()).toEqual(['$first'])

  // A repeated hint for the waiting message does not run it early.
  f.offer('$first')
  await vi.advanceTimersByTimeAsync(MATRIX_DEFERRED_RETRY_MS[0] - 1)
  expect(f.ran()).toEqual(['$first'])
  await vi.advanceTimersByTimeAsync(1)
  expect(f.ran()).toEqual(['$first', '$first'])

  await f.settle({ state: 'published', eventId: '$answer' })
  expect(f.ran()).toEqual(['$first', '$first', '$second'])
  await f.settle({ state: 'published', eventId: '$answer-2' })
  expect(f.listener.snapshot()).toMatchObject({ state: 'listening', result: 'published', queued: 0 })
  expect(f.onTrouble).not.toHaveBeenCalled()
  f.listener.stop()
})

it('backs off between retries and, out of them, leaves the turn claimed, tells the owner once and goes on', async () => {
  const f = troubled()
  f.listener.start(f.watch)
  f.offer('$slow')
  f.offer('$next')
  await f.settle(DEFERRED)

  for (const wait of MATRIX_DEFERRED_RETRY_MS) {
    const before = f.ran().length
    await vi.advanceTimersByTimeAsync(wait - 1)
    expect(f.ran()).toHaveLength(before)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.ran()).toHaveLength(before + 1)
    await f.settle(DEFERRED)
  }

  const attempts = Array<string>(1 + MATRIX_DEFERRED_RETRY_MS.length).fill('$slow')
  expect(f.ran()).toEqual([...attempts, '$next'])
  expect(f.onTrouble).toHaveBeenCalledOnce()
  expect(f.onTrouble).toHaveBeenCalledWith({ kind: 'deferred_exhausted', streak: 1 })
  expect(f.listener.snapshot()?.state).toBe('listening')

  // This watch does not take it up again (its window was never known); the claim lapses.
  f.offer('$slow')
  await f.settle({ state: 'published', eventId: '$answer' })
  await vi.advanceTimersByTimeAsync(15 * 60_000)
  expect(f.ran()).toEqual([...attempts, '$next'])
  f.listener.stop()
})

it('ends a round rather than start its last retry on a claim about to lapse, then takes it up again once it has', async () => {
  const f = troubled()
  f.listener.start(f.watch)
  const start = Date.now()
  // A claim that lapses before the last retry would have its margin to reach dispatch.
  const claimUntil = start + MATRIX_DEFERRED_RETRY_MS[0] + MATRIX_DEFERRED_RETRY_MS[1] + 10_000
  const deferred: MatrixTurnOutcome = { ...DEFERRED, claimUntil, retryBefore: start + 15 * 60_000 }

  f.offer('$slow')
  await f.settle(deferred)

  for (const wait of MATRIX_DEFERRED_RETRY_MS.slice(0, -1)) {
    await vi.advanceTimersByTimeAsync(wait)
    await f.settle(deferred)
  }

  expect(f.ran()).toHaveLength(MATRIX_DEFERRED_RETRY_MS.length)
  expect(f.onTrouble).toHaveBeenCalledWith({ kind: 'deferred_exhausted', streak: 1 })

  // Nothing while the claim is still this Mac's, not even for a repeated hint.
  f.offer('$slow')
  await vi.advanceTimersByTimeAsync(claimUntil - Date.now())
  expect(f.ran()).toHaveLength(MATRIX_DEFERRED_RETRY_MS.length)

  // Lapsed: another round, with a fresh claim, and this time it is answered.
  await vi.advanceTimersByTimeAsync(MATRIX_DEFERRED_RETRY_MS[0])
  expect(f.ran()).toHaveLength(MATRIX_DEFERRED_RETRY_MS.length + 1)
  await f.settle({ state: 'published', eventId: '$answer' })
  expect(f.onTrouble).toHaveBeenCalledOnce()
  expect(f.listener.snapshot()).toMatchObject({ state: 'listening', result: 'published' })
  f.listener.stop()
})

it('hands the claim an earlier attempt reported to the next retry, so a requeue can weigh it as defer() does', async () => {
  const f = troubled()
  f.listener.start(f.watch)
  const claimUntil = Date.now() + 10 * 60_000
  f.offer('$slow')
  await f.settle({ ...DEFERRED, claimUntil, retryBefore: Date.now() + 15 * 60_000 })
  await vi.advanceTimersByTimeAsync(MATRIX_DEFERRED_RETRY_MS[0])
  expect(f.lines().at(-1)).toMatchObject({ spent: 1, claimUntil })
  f.listener.stop()
})

it('reports each round that runs out, so a Mac that keeps failing a message is handed over', async () => {
  const f = troubled()
  f.listener.start(f.watch)
  const deferred: MatrixTurnOutcome = { ...DEFERRED, retryBefore: Date.now() + 15 * 60_000 }
  f.offer('$stuck')

  for (let round = 1; round <= 2; round++) {
    if (round > 1) {
      // No claim of its own to wait for: the next round comes after the first wait.
      await vi.advanceTimersByTimeAsync(MATRIX_DEFERRED_RETRY_MS[0])
    }

    await f.settle(deferred)

    for (const wait of MATRIX_DEFERRED_RETRY_MS) {
      await vi.advanceTimersByTimeAsync(wait)
      await f.settle(deferred)
    }

    expect(f.ran()).toHaveLength(round * (1 + MATRIX_DEFERRED_RETRY_MS.length))
    expect(f.onTrouble).toHaveBeenLastCalledWith({ kind: 'deferred_exhausted', streak: round })
  }

  // The owner's failover stops this watch: the next round goes with it.
  f.listener.stop()
  const ran = f.ran().length
  await vi.advanceTimersByTimeAsync(15 * 60_000)
  expect(f.ran()).toHaveLength(ran)
})

it('never offers a deferred turn again past the window of its message', async () => {
  const f = troubled()
  f.listener.start(f.watch)
  // Room for one retry before the window's margin, not for a second or another round.
  const retryBefore = Date.now() + MATRIX_DEFERRED_START_MARGIN_MS + MATRIX_DEFERRED_RETRY_MS[0]

  f.offer('$late')
  await f.settle({ ...DEFERRED, retryBefore })
  await vi.advanceTimersByTimeAsync(MATRIX_DEFERRED_RETRY_MS[0])
  // A retry's own read failed early and said nothing new: the window it knew still holds.
  await f.settle(DEFERRED)

  expect(f.ran()).toEqual(['$late', '$late'])
  expect(f.onTrouble).toHaveBeenCalledWith({ kind: 'deferred_exhausted', streak: 1 })
  expect(f.listener.snapshot()?.state).toBe('listening')
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(f.ran()).toEqual(['$late', '$late'])
  f.listener.stop()
})

it('drops the horizon an in-window attempt stored when the message reports its window closed, and retries it by count', async () => {
  const f = troubled()
  f.listener.start(f.watch)
  // Room for the first retry to start before the window's margin, then the message ages past it.
  const retryBefore = Date.now() + MATRIX_DEFERRED_START_MARGIN_MS + MATRIX_DEFERRED_RETRY_MS[0]

  f.offer('$late')
  await f.settle({ ...DEFERRED, retryBefore })
  await vi.advanceTimersByTimeAsync(MATRIX_DEFERRED_RETRY_MS[0])
  // The retry finds the message late: no horizon of its own, and the stored one goes with it.
  await f.settle({ ...DEFERRED, windowClosed: true })

  // Count-bounded retries still start, each after its own wait, instead of exhausting on the
  // stale horizon the moment the late attempt returns.
  await vi.advanceTimersByTimeAsync(MATRIX_DEFERRED_RETRY_MS[1])
  await f.settle({ ...DEFERRED, windowClosed: true })

  expect(f.lines().at(-1)).not.toHaveProperty('windowEnd')
  await vi.advanceTimersByTimeAsync(MATRIX_DEFERRED_RETRY_MS[2])
  await f.settle({ ...DEFERRED, windowClosed: true })

  expect(f.ran()).toEqual(['$late', '$late', '$late', '$late'])
  expect(f.onTrouble).toHaveBeenCalledOnce()
  expect(f.onTrouble).toHaveBeenCalledWith({ kind: 'deferred_exhausted', streak: 1 })
  f.listener.stop()
})

it('hands each turn its place in line: when its message arrived, however long the turns ahead took', async () => {
  const f = troubled()
  f.watch.until = Date.now() + 3 * 60 * 60_000
  f.listener.start(f.watch)
  const first = Date.now()
  f.offer('$long')
  await vi.advanceTimersByTimeAsync(60_000)
  const second = Date.now()
  f.offer('$follow-up')

  // The first answer takes 40 minutes; the follow-up waits behind it, from when it arrived.
  await vi.advanceTimersByTimeAsync(40 * 60_000)
  await f.settle({ state: 'published', eventId: '$answer' })
  expect(f.ran()).toEqual(['$long', '$follow-up'])
  expect(f.lines()).toEqual([
    { queuedAt: first, spent: 0 },
    { queuedAt: second, spent: 0 }
  ])
  await f.settle({ state: 'published', eventId: '$answer-2' })
  f.listener.stop()
})

it('a retry carries the window its turn reported, waiting from its own return, and a later round keeps it', async () => {
  const f = troubled()
  f.watch.until = Date.now() + 60 * 60_000
  f.listener.start(f.watch)
  const windowEnd = Date.now() + 15 * 60_000
  const deferred: MatrixTurnOutcome = { ...DEFERRED, retryBefore: windowEnd }
  f.offer('$slow')
  await f.settle(deferred)

  await vi.advanceTimersByTimeAsync(MATRIX_DEFERRED_RETRY_MS[0])
  // How many retries it has had is handed on too: its next wait decides whether it can still start.
  expect(f.lines().at(-1)).toEqual({ queuedAt: Date.now(), windowEnd, spent: 1 })
  // A retry's read failed early and said nothing: the window it knew is still handed on.
  await f.settle(DEFERRED)

  for (const [index, wait] of MATRIX_DEFERRED_RETRY_MS.slice(1).entries()) {
    await vi.advanceTimersByTimeAsync(wait)
    expect(f.lines().at(-1)).toEqual({ queuedAt: Date.now(), windowEnd, spent: index + 2 })
    await f.settle(DEFERRED)
  }

  expect(f.onTrouble).toHaveBeenCalledWith({ kind: 'deferred_exhausted', streak: 1 })

  // Another round, once its (unknown) claim allows: the same window.
  await vi.advanceTimersByTimeAsync(MATRIX_DEFERRED_RETRY_MS[0])
  expect(f.ran()).toHaveLength(2 + MATRIX_DEFERRED_RETRY_MS.length)
  expect(f.lines().at(-1)).toEqual({ queuedAt: Date.now(), windowEnd, spent: 0 })
  await f.settle({ state: 'published', eventId: '$answer' })
  expect(f.listener.snapshot()).toMatchObject({ state: 'listening', result: 'published' })
  f.listener.stop()
})

it('counts turns that end unanswered since the last answer, and an answer resets the count silently', async () => {
  const f = troubled()
  f.listener.start(f.watch)

  f.offer('$a')
  await f.settle({ state: 'unknown', failed: 'matrix_hermes_outcome_unknown' })
  f.offer('$b')
  await f.settle({ state: 'unknown', failed: 'matrix_turn_timeout' })
  expect(f.onTrouble.mock.calls).toEqual([[{ kind: 'failed', streak: 1 }], [{ kind: 'failed', streak: 2 }]])
  // The failed turn is still the interrupted one the window offers (unchanged).
  expect(f.listener.snapshot()).toMatchObject({ state: 'listening', interruptedEventId: '$b' })

  f.offer('$c')
  await f.settle({ state: 'published', eventId: '$answer' })
  expect(f.onTrouble).toHaveBeenCalledTimes(2)

  f.offer('$d')
  await f.settle({ state: 'unknown', failed: 'unexpected' })
  expect(f.onTrouble).toHaveBeenLastCalledWith({ kind: 'failed', streak: 1 })

  // An unknown that did not fail here (fenced: it ran before) and an ignored message say nothing.
  f.offer('$e')
  await f.settle({ state: 'unknown' })
  f.offer('$f')
  await f.settle({ state: 'ignored' })
  expect(f.onTrouble).toHaveBeenCalledTimes(3)
  f.listener.stop()
})

it('keeps listening when the owner callback throws', async () => {
  const f = troubled(
    vi.fn(() => {
      throw new Error('owner failed')
    })
  )

  f.listener.start(f.watch)
  f.offer('$a')
  f.offer('$b')
  await f.settle({ state: 'unknown', failed: 'unexpected' })
  expect(f.onTrouble).toHaveBeenCalledOnce()
  expect(f.ran()).toEqual(['$a', '$b'])
  expect(f.listener.snapshot()?.state).toBe('listening')
  f.listener.stop()
})

it('says nothing for a turn its own stop cut short, and a stop takes a waiting retry with it', async () => {
  const f = troubled()
  f.listener.start(f.watch)
  f.offer('$cut')
  f.listener.stop('unavailable')
  await f.settle({ state: 'unknown', failed: 'matrix_turn_aborted' })
  expect(f.onTrouble).not.toHaveBeenCalled()

  f.listener.start({ ...f.watch, id: 'next' })
  f.listener.offer({ watchId: 'next', roomId: f.watch.roomId, eventId: '$waiting' })
  await f.settle(DEFERRED)
  f.listener.stop()
  await vi.advanceTimersByTimeAsync(MATRIX_DEFERRED_RETRY_MS[0])
  expect(f.ran()).toEqual(['$cut', '$waiting'])
})

// R3: a run that failed after dispatch and was queued again (invocation.ts) is offered again like a
// refusal before dispatch, but it is a failure of this Mac's run: it counts toward stepping aside.
const REQUEUED: MatrixTurnOutcome = { state: 'deferred', reason: 'matrix_requeued', failed: 'matrix_hermes_outcome_unknown' }

it('offers a run that failed and was queued again after its wait, and counts the failure', async () => {
  const f = troubled()
  f.listener.start(f.watch)
  f.offer('$slow')
  await f.settle(REQUEUED)

  expect(f.onTrouble).toHaveBeenCalledOnce()
  expect(f.onTrouble).toHaveBeenCalledWith({ kind: 'failed', streak: 1 })
  expect(f.ran()).toEqual(['$slow'])
  await vi.advanceTimersByTimeAsync(MATRIX_DEFERRED_RETRY_MS[0])
  expect(f.ran()).toEqual(['$slow', '$slow'])

  // Answered the second time: the count starts over, silently.
  await f.settle({ state: 'published', eventId: '$answer' })
  expect(f.onTrouble).toHaveBeenCalledOnce()
  f.listener.offer({ watchId: f.watch.id, roomId: f.watch.roomId, eventId: '$next' })
  await f.settle({ state: 'unknown', failed: 'unexpected' })
  expect(f.onTrouble).toHaveBeenLastCalledWith({ kind: 'failed', streak: 1 })
  f.listener.stop()
})

it('does not count a refusal before dispatch as a failed run', async () => {
  const f = troubled()
  f.listener.start(f.watch)
  f.offer('$slow')
  await f.settle(DEFERRED)
  expect(f.onTrouble).not.toHaveBeenCalled()
  f.listener.stop()
})

it('drops the waiting retry when counting the failure made this Mac step aside', async () => {
  let listener!: MatrixHermesListener
  const f = troubled(vi.fn(() => listener.stop('unavailable')))
  listener = f.listener
  f.listener.start(f.watch)
  f.offer('$slow')
  await f.settle(REQUEUED)

  // This watch is over; its retry went with it (the next holder takes the queued message).
  expect(f.listener.snapshot()).toMatchObject({ state: 'stopped', reason: 'unavailable' })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.ran()).toEqual(['$slow'])
})
