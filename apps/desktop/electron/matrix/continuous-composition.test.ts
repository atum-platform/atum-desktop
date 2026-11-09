import { afterEach, expect, it, vi } from 'vitest'

import type { MatrixInvocationResult, MatrixInvocationWatch } from '../../shared/matrix'
import { createKeepAwake } from '../power-save'

import { type ContinuousListeningPreference, MatrixContinuousListening } from './continuous-listening'
import { MatrixHermesListener } from './hermes-listener'
import { MatrixReadinessMonitor, restartMatrixReadinessAfterExpiry } from './readiness'
import { MatrixSdkHost } from './sdk-host'

const key = 'matrix-continuous-listening-v1'
const binding = 'a'.repeat(64)

type SentWatch = { requestId: string; watch: MatrixInvocationWatch }

/**
 * The production arm ordering, composed from the real controller, listener and
 * SDK queue. The transport is deliberately the only fake: an acknowledgement
 * is not a Matrix/crypto proof and must be supplied by each test.
 */
function fixture(
  saved?: Map<string, string>,
  options: { expiresAt?: number | ((sequence: number) => number); leaseHeld?: boolean } = {}
) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-28T00:00:00.000Z'))

  const values = saved ?? new Map<string, string>()
  const sent: SentWatch[] = []
  const executePending: Array<(result: MatrixInvocationResult) => void> = []
  let sequence = 0
  let leaseHeld = options.leaseHeld ?? true
  let controller: MatrixContinuousListening
  let consent: AbortController | undefined

  const listener = new MatrixHermesListener(
    () => new Promise<MatrixInvocationResult>(resolve => executePending.push(resolve)),
    () => controller?.listenerChanged()
  )

  const host = new MatrixSdkHost((requestId, value) => {
    const watch = (value as { kind?: string; watch?: MatrixInvocationWatch }).watch

    if ((value as { kind?: string }).kind === 'watchInvocations' && watch) {
      sent.push({ requestId, watch })
    }
  }, vi.fn())

  const store = {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => values.set(name, value),
    removeItem: (name: string) => values.delete(name)
  }

  const arm = async (preference: ContinuousListeningPreference, signal: AbortSignal) => {
    const watch: MatrixInvocationWatch = {
      id: `watch-${++sequence}`,
      roomId: preference.roomId,
      sender: { userId: '@owner:test', deviceId: 'OWNER' },
      since: Date.now(),
      until:
        typeof options.expiresAt === 'function'
          ? options.expiresAt(sequence)
          : (options.expiresAt ?? Date.now() + 1_000)
    }

    const abort = new AbortController()
    const cancel = () => abort.abort()
    signal.addEventListener('abort', cancel, { once: true })

    if (signal.aborted) {
      abort.abort()
    }

    consent = abort

    try {
      listener.prepare(watch)
      await host.command({ kind: 'watchInvocations', watch })
      abort.signal.throwIfAborted()

      if (!controller.enabled || !leaseHeld || watch.until <= Date.now()) {
        throw new Error('matrix_not_ready')
      }

      if (!listener.commit(watch.id)) {
        throw new Error('matrix_listener_unavailable')
      }
    } catch (error) {
      if (consent === abort) {
        listener.stop('cancelled')
      }

      throw error
    } finally {
      signal.removeEventListener('abort', cancel)

      if (consent === abort) {
        consent = undefined
      }
    }
  }

  controller = new MatrixContinuousListening({
    store,
    context: () => (leaseHeld ? { state: 'ready' } : { state: 'waiting', reason: 'lease_elsewhere' }),
    arm,
    stop: () => {
      consent?.abort()
      listener.stop()
    },
    listener: () => listener.snapshot(),
    changed: () => {}
  })

  return {
    controller,
    executePending,
    host,
    listener,
    sent,
    values,
    acknowledge(index = sent.length - 1) {
      host.result(sent[index].requestId, true, undefined)
    },
    offer(index: number, eventId: string) {
      const watch = sent[index].watch
      listener.offer({ watchId: watch.id, roomId: watch.roomId, eventId })
    },
    setLeaseHeld(value: boolean) {
      leaseHeld = value
    },
    isLeaseHeld() {
      return leaseHeld
    }
  }
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0)
}

afterEach(() => vi.useRealTimers())

it('queues prepared SDK hints without running, then commits and drains only after the acknowledgement', async () => {
  const f = fixture()
  f.controller.enable(binding, '!room:test')
  expect(f.sent).toHaveLength(1)

  f.offer(0, '$before-ack')
  expect(f.listener.snapshot()).toBeUndefined()
  expect(f.executePending).toHaveLength(0)

  f.acknowledge()
  await flush()
  expect(f.listener.snapshot()).toMatchObject({ state: 'listening', roomId: '!room:test', queued: 0 })
  expect(f.executePending).toHaveLength(1)

  f.executePending.shift()!({ state: 'published' })
  await flush()
})

it('cannot resurrect a prepared watch when Stop wins before the SDK acknowledgement', async () => {
  const f = fixture()
  f.controller.enable(binding, '!room:test')
  f.offer(0, '$before-stop')

  f.controller.disable()
  f.acknowledge()
  await flush()

  expect(f.controller.enabled).toBe(false)
  expect(f.listener.snapshot()).toMatchObject({ state: 'stopped', queued: 0 })
  expect(f.executePending).toHaveLength(0)
  expect(f.listener.commit(f.sent[0].watch.id)).toBe(false)
})

it('expires, re-gates, and creates a fresh bounded watch without replaying old queued hints', async () => {
  const f = fixture(undefined, { expiresAt: () => Date.now() + 100 })
  f.controller.enable(binding, '!room:test')
  f.offer(0, '$old')
  f.acknowledge()
  await flush()
  expect(f.executePending).toHaveLength(1)

  await vi.advanceTimersByTimeAsync(100)
  expect(f.listener.snapshot()).toMatchObject({ state: 'stopped', reason: 'expired', queued: 0 })
  expect(f.controller.snapshot()).toMatchObject({ state: 'paused', reason: 'renewing' })

  let restart!: () => void

  const readiness = new MatrixReadinessMonitor({
    gate: [
      {
        step: 'assistant',
        check: async () => {
          f.controller.reconcile()

          return { ok: true }
        }
      }
    ],
    watch: [],
    onChange: () => {},
    timings: { watchMs: 30_000, jitterMs: 0, backoffMs: [1] },
    random: () => 0.5
  })

  const oldWatch = f.sent[0].watch

  const stopped = new Promise<void>(resolve => {
    restart = resolve
  })

  const renewal = restartMatrixReadinessAfterExpiry(
    stopped,
    () => true,
    () => readiness.start()
  )

  restart()
  await renewal
  await flush()

  expect(f.sent).toHaveLength(2)
  expect(f.sent[1].watch).toMatchObject({ roomId: oldWatch.roomId })
  expect(f.sent[1].watch.id).not.toBe(oldWatch.id)
  expect(f.sent[1].watch.since).toBeGreaterThanOrEqual(oldWatch.until)

  // A hint from the expired SDK watch is not transferable to the renewal watch.
  f.listener.offer({ watchId: oldWatch.id, roomId: oldWatch.roomId, eventId: '$late-old' })
  f.acknowledge(1)
  await flush()
  expect(f.executePending).toHaveLength(1)

  f.offer(1, '$fresh')
  expect(f.executePending).toHaveLength(2)
  f.executePending.shift()!({ state: 'published' })
  f.executePending.shift()!({ state: 'published' })
  await flush()
  readiness.stop()
})

it('pausing or losing the lease for one agent leaves another agent listening and keeps power awake until the last lease is gone', async () => {
  const first = fixture()
  const second = fixture()
  const blocker = { start: vi.fn(() => 7), stop: vi.fn(), isStarted: vi.fn(() => true) }
  const awake = createKeepAwake(blocker)

  const syncPower = () =>
    awake.set(
      [first, second].some(
        item => item.controller.enabled && item.listener.snapshot()?.state === 'listening' && item.isLeaseHeld()
      )
    )

  first.controller.enable(binding, '!first:test')
  second.controller.enable(binding, '!second:test')
  first.acknowledge()
  second.acknowledge()
  await flush()
  // This is only a local ownership/power predicate, not a Matrix crypto assertion.
  syncPower()
  expect(awake.isActive()).toBe(true)

  first.setLeaseHeld(false)
  first.controller.reconcile()
  expect(first.listener.snapshot()).toMatchObject({ state: 'stopped' })
  expect(second.listener.snapshot()).toMatchObject({ state: 'listening' })
  syncPower()
  expect(awake.isActive()).toBe(true)

  second.setLeaseHeld(false)
  second.controller.reconcile()
  syncPower()
  expect(second.listener.snapshot()).toMatchObject({ state: 'stopped' })
  expect(awake.isActive()).toBe(false)
  expect(blocker.stop).toHaveBeenCalledWith(7)
})

it.each(['unknown', 'publication_pending'] as const)(
  'latches a $state turn across a fresh controller until explicit Resume enables a new watch',
  async state => {
    const first = fixture()
    first.controller.enable(binding, '!room:test')
    first.acknowledge()
    await flush()
    first.offer(0, '$uncertain')
    first.executePending.shift()!({ state })
    await flush()

    expect(first.controller.snapshot()).toMatchObject({ state: 'paused', reason: 'unavailable', result: state })
    const afterRestart = fixture(first.values)
    afterRestart.controller.reconcile()
    expect(afterRestart.sent).toHaveLength(0)
    expect(afterRestart.controller.snapshot()).toMatchObject({ state: 'paused', reason: 'unavailable' })

    afterRestart.controller.enable(binding, '!room:test')
    expect(afterRestart.sent).toHaveLength(1)
    afterRestart.acknowledge()
    await flush()
    expect(afterRestart.listener.snapshot()).toMatchObject({ state: 'listening' })
  }
)
