import { afterEach, expect, it, vi } from 'vitest'

import type { MatrixListeningState } from '../../shared/matrix'

import {
  type ContinuousListeningContext,
  type ContinuousListeningPreference,
  MatrixContinuousListening
} from './continuous-listening'

const key = 'matrix-continuous-listening-v1'
const binding = 'a'.repeat(64)

interface PendingArm {
  preference: ContinuousListeningPreference
  signal: AbortSignal
  resolve(): void
  reject(error?: unknown): void
}

function preference(overrides: Partial<ContinuousListeningPreference> = {}): ContinuousListeningPreference {
  return { version: 1, binding, roomId: '!room:test', enabledAt: Date.now(), ...overrides }
}

function fixture(
  saved?: string | null,
  options: {
    automatic?: boolean
    recovering?(reason: 'overflow' | 'unavailable'): void
    armed?(): void
    refused?(error: unknown): boolean
    holdArm?(): boolean
  } = {}
) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-28T00:00:00Z'))

  const values = new Map<string, string>()

  if (saved !== null && saved !== undefined) {
    values.set(key, saved)
  }

  let currentContext: ContinuousListeningContext = { state: 'ready' }
  let currentListener: MatrixListeningState | undefined
  const pending: PendingArm[] = []

  const store = {
    getItem: vi.fn((item: string) => values.get(item) ?? null),
    setItem: vi.fn((item: string, value: string) => values.set(item, value)),
    removeItem: vi.fn((item: string) => values.delete(item))
  }

  const context = vi.fn(() => currentContext)

  const arm = vi.fn(
    (next: ContinuousListeningPreference, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => pending.push({ preference: next, signal, resolve, reject }))
  )

  const stop = vi.fn()
  const listener = vi.fn(() => currentListener)
  const changed = vi.fn()
  const controller = new MatrixContinuousListening({ ...options, store, context, arm, stop, listener, changed })

  return {
    controller,
    store,
    context,
    arm,
    stop,
    listener,
    changed,
    pending,
    values,
    setContext(value: ContinuousListeningContext) {
      currentContext = value
    },
    setListener(value: MatrixListeningState | undefined) {
      currentListener = value
    }
  }
}

afterEach(() => vi.useRealTimers())

it('retains lease demand across transient pauses, but not explicit-resume failures', () => {
  const f = fixture()
  expect(f.controller.wantsLease).toBe(false)
  f.controller.enable(binding, '!room:test')
  expect(f.controller.wantsLease).toBe(true)
  f.controller.pause('lease_elsewhere')
  expect(f.controller.wantsLease).toBe(true)
  f.controller.pause('unavailable', true)
  expect(f.controller.enabled).toBe(true)
  expect(f.controller.wantsLease).toBe(false)
  const restored = fixture(f.values.get(key))
  expect(restored.controller.wantsLease).toBe(false)
  restored.controller.enable(binding, '!room:test')
  expect(restored.controller.wantsLease).toBe(true)
  restored.controller.disable()
  expect(restored.controller.wantsLease).toBe(false)
})

it('defaults off without a persisted preference', () => {
  const f = fixture()

  expect(f.controller.enabled).toBe(false)
  expect(f.controller.roomId).toBeUndefined()
  expect(f.controller.snapshot()).toBeUndefined()
  expect(f.context).not.toHaveBeenCalled()
  expect(f.arm).not.toHaveBeenCalled()
})

it('restores a valid preference without action until reconciliation', () => {
  const saved = preference()
  const f = fixture(JSON.stringify(saved))

  expect(f.controller.enabled).toBe(true)
  expect(f.controller.roomId).toBe(saved.roomId)
  expect(f.context).not.toHaveBeenCalled()
  expect(f.arm).not.toHaveBeenCalled()
  expect(f.stop).not.toHaveBeenCalled()

  f.controller.reconcile()
  expect(f.context).toHaveBeenCalledWith(saved)
  expect(f.arm).toHaveBeenCalledOnce()
})

it.each([
  '{not-json',
  JSON.stringify({ ...preference(), binding: '' }),
  JSON.stringify({ ...preference(), binding: 'not-a-sha256' }),
  JSON.stringify({ ...preference(), roomId: '!' }),
  JSON.stringify({ ...preference(), enabledAt: 'not-a-time' })
])('fails closed for a corrupt persisted record: %s', saved => {
  const f = fixture(saved)

  expect(f.controller.enabled).toBe(false)
  expect(f.controller.snapshot()).toBeUndefined()
  f.controller.reconcile()
  expect(f.arm).not.toHaveBeenCalled()
})

it('removes a foreign persisted preference before it can arm', () => {
  const f = fixture(JSON.stringify(preference()))
  f.setContext({ state: 'foreign' })

  f.controller.reconcile()

  expect(f.controller.enabled).toBe(false)
  expect(f.store.removeItem).toHaveBeenCalledWith(key)
  expect(f.stop).toHaveBeenCalledOnce()
  expect(f.arm).not.toHaveBeenCalled()
  expect(f.controller.snapshot()).toBeUndefined()
})

it.each(['offline', 'lease_elsewhere'] as const)('waits without arming while %s', reason => {
  const f = fixture(JSON.stringify(preference()))
  f.setContext({ state: 'waiting', reason })

  f.controller.reconcile()
  f.controller.reconcile()

  expect(f.arm).not.toHaveBeenCalled()
  expect(f.stop).toHaveBeenCalledOnce()
  expect(f.controller.snapshot()).toMatchObject({ mode: 'continuous', state: 'paused', reason })
})

it('arms once when readiness arrives and preserves the continuous listening snapshot', async () => {
  const saved = preference()
  const f = fixture(JSON.stringify(saved))
  f.setContext({ state: 'waiting', reason: 'offline' })
  f.controller.reconcile()
  f.setContext({ state: 'ready' })

  f.controller.reconcile()
  f.controller.reconcile()
  expect(f.arm).toHaveBeenCalledOnce()
  expect(f.arm).toHaveBeenCalledWith(saved, expect.any(AbortSignal))

  f.setListener({ state: 'listening', roomId: saved.roomId, expiresAt: 123, queued: 2 })
  f.pending[0].resolve()
  await Promise.resolve()
  f.controller.reconcile()
  expect(f.arm).toHaveBeenCalledOnce()
  expect(f.controller.snapshot()).toEqual({
    state: 'listening',
    roomId: saved.roomId,
    expiresAt: 123,
    queued: 2,
    mode: 'continuous'
  })
})

it('holds a new watch while a host is reconnecting, without pausing, failing or retrying on its own (R4)', async () => {
  let hold = true
  const saved = preference()
  const f = fixture(JSON.stringify(saved), { holdArm: () => hold, automatic: true })

  f.controller.reconcile()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.arm).not.toHaveBeenCalled()
  expect(f.stop).not.toHaveBeenCalled()

  // The sync is back: main reconciles, and the watch arms once.
  hold = false
  f.controller.reconcile()
  expect(f.arm).toHaveBeenCalledOnce()
})

it('keeps a watch already armed through a reconnecting host (R4)', async () => {
  let hold = false
  const saved = preference()
  const f = fixture(JSON.stringify(saved), { holdArm: () => hold, automatic: true })

  f.controller.reconcile()
  f.setListener({ state: 'listening', roomId: saved.roomId, expiresAt: 123, queued: 0 })
  f.pending[0].resolve()
  await Promise.resolve()

  hold = true
  f.controller.reconcile()
  expect(f.stop).not.toHaveBeenCalled()
  expect(f.controller.snapshot()).toMatchObject({ state: 'listening', roomId: saved.roomId })
  expect(f.arm).toHaveBeenCalledOnce()
})

it('projects the same-room interrupted marker through pauses but never borrows another room outcome', () => {
  const saved = preference()
  const f = fixture(JSON.stringify(saved), { automatic: true })
  f.setListener({
    state: 'stopped', roomId: saved.roomId, expiresAt: 123, queued: 0,
    result: 'unknown', interruptedEventId: '$uncertain'
  })
  f.controller.pause('offline')
  expect(f.controller.snapshot()).toMatchObject({
    state: 'paused', reason: 'offline', result: 'unknown', interruptedEventId: '$uncertain'
  })
  f.setListener({
    state: 'stopped', roomId: '!different:test', expiresAt: 123, queued: 0,
    result: 'unknown', interruptedEventId: '$foreign'
  })
  expect(f.controller.snapshot()?.result).toBeUndefined()
  expect(f.controller.snapshot()?.interruptedEventId).toBeUndefined()
})

it('aborts a pending arm on disable and never lets its late resolution re-enable listening', async () => {
  const f = fixture(JSON.stringify(preference()))
  f.controller.reconcile()
  const opening = f.pending[0]

  f.controller.disable()
  expect(opening.signal.aborted).toBe(true)
  expect(f.controller.enabled).toBe(false)
  expect(f.stop).toHaveBeenCalledOnce()

  opening.resolve()
  await Promise.resolve()
  f.controller.reconcile()
  expect(f.arm).toHaveBeenCalledOnce()
  expect(f.controller.snapshot()).toBeUndefined()
})

it('supersedes a pending arm so an old completion cannot arm the old room again', async () => {
  const f = fixture()
  f.controller.enable(binding, '!first:test')
  const first = f.pending[0]

  f.controller.enable(binding, '!second:test')
  const second = f.pending[1]
  expect(first.signal.aborted).toBe(true)
  expect(second.preference.roomId).toBe('!second:test')

  first.resolve()
  await Promise.resolve()
  expect(f.arm).toHaveBeenCalledTimes(2)
  expect(f.controller.roomId).toBe('!second:test')
})

it('does not grant new authority when persisting an enable fails', () => {
  const f = fixture()
  f.store.setItem.mockImplementationOnce(() => {
    throw new Error('disk full')
  })

  expect(() => f.controller.enable(binding, '!room:test')).toThrow('disk full')
  expect(f.controller.enabled).toBe(false)
  expect(f.stop).not.toHaveBeenCalled()
  expect(f.arm).not.toHaveBeenCalled()
})

it('writes a durable off marker if deleting the preference fails, preventing restart revival', () => {
  const f = fixture(JSON.stringify(preference()))
  f.setListener({ state: 'listening', roomId: '!room:test', expiresAt: 10, queued: 0 })
  f.store.removeItem.mockImplementationOnce(() => {
    throw new Error('disk full')
  })

  f.controller.disable()
  expect(f.stop).toHaveBeenCalledOnce()
  expect(f.controller.enabled).toBe(false)
  expect(f.controller.snapshot()).toBeUndefined()
  const reboot = fixture(f.values.get(key))
  reboot.controller.reconcile()
  expect(reboot.controller.enabled).toBe(false)
  expect(reboot.arm).not.toHaveBeenCalled()
})

it('keeps an unsaved Stop visibly paused and retries on a later lifecycle event without rearming', () => {
  const f = fixture(JSON.stringify(preference()))
  f.store.removeItem.mockImplementation(() => {
    throw new Error('disk full')
  })
  f.store.setItem.mockImplementation(() => {
    throw new Error('disk full')
  })
  expect(() => f.controller.disable()).toThrow('disk full')
  expect(f.stop).toHaveBeenCalledOnce()
  expect(f.controller.snapshot()).toMatchObject({ state: 'paused', reason: 'storage' })
  const changes = f.changed.mock.calls.length
  f.controller.reconcile()
  expect(f.changed).toHaveBeenCalledTimes(changes)
  expect(f.arm).not.toHaveBeenCalled()
  f.store.removeItem.mockImplementation(name => {
    return f.values.delete(name)
  })
  f.controller.reconcile()
  expect(f.controller.enabled).toBe(false)
  expect(f.arm).not.toHaveBeenCalled()
  expect(fixture(f.values.get(key)).controller.enabled).toBe(false)
})

it.each(['offline', 'lease_elsewhere', 'renewing', 'busy', 'document'] as const)(
  'does not latch a known %s transition while waiting for an SDK acknowledgement',
  async reason => {
    const f = fixture(JSON.stringify(preference()))
    f.controller.reconcile()
    f.setContext({ state: 'waiting', reason })
    f.pending[0].reject(new Error('matrix_not_ready'))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.controller.snapshot()).toMatchObject({ state: 'paused', reason })
    f.setContext({ state: 'ready' })
    f.controller.reconcile()
    expect(f.arm).toHaveBeenCalledTimes(2)
    expect(JSON.parse(f.values.get(key)!)).not.toHaveProperty('requiresResume')
  }
)

it('latches an unexplained SDK failure while still ready, avoiding a publish-driven retry loop', async () => {
  const f = fixture(JSON.stringify(preference()))
  f.controller.reconcile()
  f.pending[0].reject(new Error('matrix_operation_failed'))
  await vi.advanceTimersByTimeAsync(0)
  f.controller.reconcile()
  f.controller.reconcile()
  expect(f.arm).toHaveBeenCalledOnce()
  expect(f.controller.snapshot()).toMatchObject({ state: 'paused', reason: 'unavailable' })
  expect(JSON.parse(f.values.get(key)!)).toHaveProperty('requiresResume', 'unavailable')
})

it('automatically retries a pre-dispatch unavailable arm after ten seconds without persisting a resume gate', async () => {
  const saved = preference()
  const f = fixture(JSON.stringify(saved), { automatic: true })
  f.controller.reconcile()
  f.pending[0].reject(new Error('matrix_pre_dispatch_unavailable'))
  await vi.advanceTimersByTimeAsync(0)
  expect(f.controller.snapshot()).toMatchObject({ state: 'paused', reason: 'unavailable' })
  expect(JSON.parse(f.values.get(key)!)).not.toHaveProperty('requiresResume')
  await vi.advanceTimersByTimeAsync(9_999)
  expect(f.arm).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1)
  expect(f.arm).toHaveBeenCalledTimes(2)
})

it('an explicit Stop cancels a pending automatic retry', async () => {
  const f = fixture(JSON.stringify(preference()), { automatic: true })
  f.controller.reconcile()
  f.pending[0].reject(new Error('matrix_pre_dispatch_unavailable'))
  await vi.advanceTimersByTimeAsync(0)
  f.controller.disable()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(f.arm).toHaveBeenCalledOnce()
  expect(f.controller.enabled).toBe(false)
})

it('arms automatic listening again despite a resume gate an earlier build saved', () => {
  const f = fixture(JSON.stringify(preference({ requiresResume: 'unavailable' })), { automatic: true })
  expect(f.controller.wantsLease).toBe(true)
  f.controller.reconcile()
  expect(f.controller.enabled).toBe(true)
  expect(f.arm).toHaveBeenCalledOnce()
})

it('keeps a manual resume gate an earlier build saved', () => {
  const f = fixture(JSON.stringify(preference({ requiresResume: 'unavailable' })))
  f.controller.reconcile()
  expect(f.controller.wantsLease).toBe(false)
  expect(f.arm).not.toHaveBeenCalled()
  expect(f.controller.snapshot()).toMatchObject({ state: 'paused', reason: 'unavailable' })
})

it.each(['overflow', 'unavailable'] as const)(
  'recovers automatic listening from %s by itself after ten seconds, never waiting for a resume',
  async reason => {
    const saved = preference()
    const f = fixture(JSON.stringify(saved), { automatic: true })
    f.controller.reconcile()
    f.pending[0].resolve()
    await vi.advanceTimersByTimeAsync(0)
    f.setListener({ state: 'stopped', roomId: saved.roomId, expiresAt: 123, queued: 0, reason })
    f.controller.listenerChanged()
    expect(f.controller.snapshot()).toMatchObject({ state: 'paused', reason })
    expect(f.controller.wantsLease).toBe(true)
    expect(JSON.parse(f.values.get(key)!)).not.toHaveProperty('requiresResume')
    // Lifecycle events meanwhile do not spin it.
    f.controller.reconcile()
    expect(f.arm).toHaveBeenCalledOnce()
    f.setListener(undefined)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.arm).toHaveBeenCalledTimes(2)
  }
)

it('recovers from an incomplete catch-up main marks as overflow', async () => {
  const f = fixture(JSON.stringify(preference()), { automatic: true })
  f.controller.reconcile()
  // main's armHermesWatch: pause('overflow', true), then the arm fails.
  f.controller.pause('overflow', true)
  f.pending[0].reject(new Error('matrix_catchup_incomplete'))
  await vi.advanceTimersByTimeAsync(9_999)
  expect(f.arm).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1)
  expect(f.arm).toHaveBeenCalledTimes(2)
})

it('tells the failover each automatic recovery, and each watch that armed', async () => {
  const saved = preference()
  const recovering = vi.fn()
  const armed = vi.fn()
  const f = fixture(JSON.stringify(saved), { automatic: true, recovering, armed })

  // main's incomplete catch-up.
  f.controller.reconcile()
  f.controller.pause('overflow', true)
  f.pending[0].reject(new Error('matrix_catchup_incomplete'))
  await vi.advanceTimersByTimeAsync(0)
  expect(recovering.mock.calls).toEqual([['overflow']])

  // An unexplained arm failure while still ready.
  await vi.advanceTimersByTimeAsync(10_000)
  f.pending[1].reject(new Error('matrix_listener_unavailable'))
  await vi.advanceTimersByTimeAsync(0)
  expect(recovering.mock.calls).toEqual([['overflow'], ['unavailable']])
  expect(armed).not.toHaveBeenCalled()

  await vi.advanceTimersByTimeAsync(10_000)
  f.pending[2].resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(armed).toHaveBeenCalledOnce()

  // A committed watch that stops unavailable recovers too.
  f.setListener({ state: 'stopped', roomId: saved.roomId, expiresAt: 123, queued: 0, reason: 'unavailable' })
  f.controller.listenerChanged()
  expect(recovering).toHaveBeenCalledTimes(3)
})

it('retries a refusal every Mac would meet without counting it, and moves to the main without counting', async () => {
  const recovering = vi.fn()
  const refusal = new Error('matrix_earlier_conversation')
  const refused = vi.fn((error: unknown) => error === refusal)
  const f = fixture(JSON.stringify(preference()), { automatic: true, recovering, refused })

  // The room is an earlier conversation and no main is known yet (the 0.20.1 crossed move).
  f.controller.reconcile()
  f.pending[0].reject(refusal)
  await vi.advanceTimersByTimeAsync(0)
  expect(refused).toHaveBeenCalledWith(refusal)
  expect(recovering).not.toHaveBeenCalled()
  expect(f.controller.snapshot()).toMatchObject({ state: 'paused', reason: 'unavailable' })

  // Still retried after ten seconds, like any automatic failure.
  await vi.advanceTimersByTimeAsync(10_000)
  expect(f.arm).toHaveBeenCalledTimes(2)

  // A main is known now: main moves listening there before the failure lands. The stale
  // failure is not counted, and the next arm is for the main.
  const main = '!main:test'
  f.controller.enable(binding, main)
  f.pending[1].reject(refusal)
  await vi.advanceTimersByTimeAsync(0)
  expect(recovering).not.toHaveBeenCalled()
  expect(f.arm.mock.calls.at(-1)?.[0]).toMatchObject({ roomId: main })
  expect(JSON.parse(f.values.get(key)!)).toMatchObject({ roomId: main })

  // Anything else while ready still counts toward the handover.
  f.pending.at(-1)!.reject(new Error('matrix_listener_unavailable'))
  await vi.advanceTimersByTimeAsync(0)
  expect(recovering).toHaveBeenCalledOnce()

  // A manual (non-automatic) listener keeps its explicit resume gate whatever the error.
  const manual = fixture(JSON.stringify(preference()), { refused })
  manual.controller.reconcile()
  manual.pending[0].reject(refusal)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(manual.arm).toHaveBeenCalledOnce()
})

it('waits longer after each refusal in a row, up to two minutes, and starts over once a watch arms', async () => {
  const refusal = new Error('matrix_earlier_conversation')
  const recovering = vi.fn()
  const f = fixture(JSON.stringify(preference()), { automatic: true, recovering, refused: error => error === refusal })

  f.controller.reconcile()

  // 10 s, 20 s, 40 s, 80 s, then 2 min each: every arm is a full server read.
  for (const wait of [10_000, 20_000, 40_000, 80_000, 120_000, 120_000]) {
    const before = f.arm.mock.calls.length
    f.pending.at(-1)!.reject(refusal)
    await vi.advanceTimersByTimeAsync(wait - 1)
    expect(f.arm).toHaveBeenCalledTimes(before)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.arm).toHaveBeenCalledTimes(before + 1)
  }

  // A watch that arms starts the wait over.
  f.pending.at(-1)!.resolve()
  await vi.advanceTimersByTimeAsync(0)
  // The watch ended later (no listener now): the next pass arms again.
  f.controller.reconcile()
  const before = f.arm.mock.calls.length
  expect(before).toBeGreaterThan(7)
  f.pending.at(-1)!.reject(refusal)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(f.arm).toHaveBeenCalledTimes(before + 1)

  // So does a re-point to the main: it arms at once, and its first refusal waits ten seconds.
  for (const _ of [1, 2, 3]) {
    f.pending.at(-1)!.reject(refusal)
    await vi.advanceTimersByTimeAsync(120_000)
  }

  f.controller.enable(binding, '!main:test')
  expect(f.arm.mock.calls.at(-1)?.[0]).toMatchObject({ roomId: '!main:test' })
  const repointed = f.arm.mock.calls.length
  f.pending.at(-1)!.reject(refusal)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(f.arm).toHaveBeenCalledTimes(repointed + 1)
  expect(recovering).not.toHaveBeenCalled()
})

it('never counts an explained wait, a manual gate or a failure the failover throws on', async () => {
  const recovering = vi.fn(() => {
    throw new Error('synthetic')
  })

  const automatic = fixture(JSON.stringify(preference()), { automatic: true, recovering })
  automatic.controller.reconcile()
  // The lease went elsewhere meanwhile: an explained wait.
  automatic.setContext({ state: 'waiting', reason: 'lease_elsewhere' })
  automatic.pending[0].reject(new Error('matrix_automatic_lease_required'))
  await vi.advanceTimersByTimeAsync(0)
  expect(recovering).not.toHaveBeenCalled()
  expect(automatic.controller.snapshot()).toMatchObject({ state: 'paused', reason: 'lease_elsewhere' })

  // The failover throwing never reaches the controller; it still retries.
  automatic.setContext({ state: 'ready' })
  automatic.controller.reconcile()
  automatic.controller.pause('overflow', true)
  expect(recovering).toHaveBeenCalledOnce()
  automatic.pending[1].reject(new Error('matrix_catchup_incomplete'))
  await vi.advanceTimersByTimeAsync(10_000)
  expect(automatic.arm).toHaveBeenCalledTimes(3)

  const manualRecovering = vi.fn()
  const manual = fixture(JSON.stringify(preference()), { recovering: manualRecovering })
  manual.controller.reconcile()
  manual.controller.pause('overflow', true)
  expect(manualRecovering).not.toHaveBeenCalled()
})

it('preserves a temporary pause choice and restores it once ready', () => {
  const f = fixture(JSON.stringify(preference()))
  f.controller.pause('offline')

  expect(f.controller.enabled).toBe(true)
  expect(f.controller.snapshot()).toMatchObject({ mode: 'continuous', state: 'paused', reason: 'offline' })

  f.controller.reconcile()
  expect(f.arm).toHaveBeenCalledOnce()
})

it.each([
  { reason: 'unavailable' as const, result: 'unknown' as const },
  { reason: 'overflow' as const, result: undefined }
])('latches $reason listener failure until explicit enable confirms a resume', ({ reason, result }) => {
  const saved = preference()
  const f = fixture(JSON.stringify(saved))
  f.setListener({
    state: 'stopped',
    roomId: saved.roomId,
    expiresAt: 10,
    queued: 0,
    reason,
    ...(result ? { result } : {})
  })

  f.controller.listenerChanged()
  f.controller.reconcile()
  expect(f.arm).not.toHaveBeenCalled()
  expect(f.controller.snapshot()).toMatchObject({ mode: 'continuous', state: 'paused', reason })
  expect(f.controller.snapshot()?.result).toBe(result)

  const afterRestart = fixture(f.values.get(key))
  afterRestart.controller.reconcile()
  expect(afterRestart.arm).not.toHaveBeenCalled()
  expect(afterRestart.controller.snapshot()).toMatchObject({ state: 'paused', reason })

  f.controller.enable(binding, saved.roomId)
  expect(f.arm).toHaveBeenCalledOnce()
})

it('disposal preserves the preference for a next boot but never arms or displays the old controller', () => {
  const saved = preference()
  const f = fixture(JSON.stringify(saved))
  f.controller.reconcile()
  const opening = f.pending[0]

  f.controller.dispose()
  expect(opening.signal.aborted).toBe(true)
  expect(f.controller.enabled).toBe(false)
  expect(f.controller.snapshot()).toBeUndefined()
  f.controller.reconcile()
  expect(f.arm).toHaveBeenCalledOnce()
  expect(f.values.get(key)).toBe(JSON.stringify(saved))

  const next = fixture(f.values.get(key))
  expect(next.controller.enabled).toBe(true)
  next.controller.reconcile()
  expect(next.arm).toHaveBeenCalledOnce()
})

it('turns on by default only where nobody chose', () => {
  expect(fixture().controller.awaitsDefault).toBe(true)
  expect(fixture('null').controller.awaitsDefault).toBe(false)
  expect(fixture(JSON.stringify(preference())).controller.awaitsDefault).toBe(false)

  const f = fixture()
  f.controller.enable(binding, '!room:test')
  expect(f.controller.awaitsDefault).toBe(false)
  expect(f.controller.enabled).toBe(true)
})

it("remembers the person's Stop as a durable off the default never undoes", () => {
  const f = fixture(JSON.stringify(preference()))

  f.controller.switchOff()

  expect(f.values.get(key)).toBe('null')
  expect(f.store.removeItem).not.toHaveBeenCalled()
  expect(f.controller.awaitsDefault).toBe(false)
  const reboot = fixture(f.values.get(key))
  expect(reboot.controller.enabled).toBe(false)
  expect(reboot.controller.awaitsDefault).toBe(false)
})

it('leaves the default free to return after a cleanup (the chat moved)', () => {
  const f = fixture(JSON.stringify(preference()))
  f.setContext({ state: 'foreign' })

  f.controller.reconcile()

  expect(f.controller.enabled).toBe(false)
  expect(f.controller.awaitsDefault).toBe(true)
  expect(fixture(f.values.get(key)).controller.awaitsDefault).toBe(true)
})

it('retries an unsaved Stop as an off, never as a removal', () => {
  const f = fixture(JSON.stringify(preference()))
  f.store.setItem.mockImplementationOnce(() => {
    throw new Error('disk full')
  })

  expect(() => f.controller.switchOff()).toThrow('disk full')
  expect(f.controller.snapshot()).toMatchObject({ state: 'paused', reason: 'storage' })
  f.controller.reconcile()

  expect(f.store.removeItem).not.toHaveBeenCalled()
  expect(f.values.get(key)).toBe('null')
  expect(f.controller.enabled).toBe(false)
  expect(f.controller.awaitsDefault).toBe(false)
})

it('never turns on by default from a store it cannot read', () => {
  const controller = new MatrixContinuousListening({
    store: {
      getItem: () => {
        throw new Error('locked')
      },
      setItem: vi.fn(),
      removeItem: vi.fn()
    },
    context: () => ({ state: 'ready' }),
    arm: () => Promise.resolve(),
    stop: vi.fn(),
    listener: () => undefined,
    changed: vi.fn()
  })

  expect(controller.awaitsDefault).toBe(false)
  expect(controller.enabled).toBe(false)
})
