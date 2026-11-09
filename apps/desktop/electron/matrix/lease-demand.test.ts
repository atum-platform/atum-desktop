import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { matrixAgentLeaseDemand, MatrixAgentRuntime, reconcileMatrixAgentLease } from './agent-runtime'
import { MatrixContinuousListening } from './continuous-listening'
import { MatrixHermesListener } from './hermes-listener'
import { MatrixExecutorLease } from './lease'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000_000)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

/** Real lease, listener, preference and production demand composition. Only the
 * server transport/model execution are fake; this is not a Matrix crypto proof. */
function twoMacs() {
  let holder: { executor: string; since: number; until: number } | undefined
  let miniOffline = false
  const calls: Array<{ executor: string; operation: string }> = []
  const pendingReconcile = new Set<() => void>()

  const schedule = (reconcile: () => void) => {
    pendingReconcile.add(reconcile)
  }

  const mac = (executor: string) => {
    const agent = new MatrixAgentRuntime(`agent:${executor}`, executor)
    let watchId = ''
    const execute = vi.fn(async () => ({ state: 'published' as const }))

    const reconcile = () => {
      agent.continuous!.reconcile()
      reconcileMatrixAgentLease(agent, executor)
    }

    const changed = () => schedule(reconcile)
    agent.listener = new MatrixHermesListener(execute, () => {
      agent.continuous?.listenerChanged()
      changed()
    })
    agent.lease = new MatrixExecutorLease({
      random: () => 0.5,
      onChange: changed,
      request: async (operation, id) => {
        calls.push({ executor: id, operation })

        if (id === 'mini' && miniOffline) {throw Error('offline')}

        if (operation === 'release') {
          if (holder?.executor === id) {holder = undefined}

          return { held: false }
        }

        if (holder && holder.until > Date.now() && holder.executor !== id) {
          return { held: false, until: holder.until }
        }

        holder = {
          executor: id,
          since: holder?.executor === id && holder.until > Date.now() ? holder.since : Date.now(),
          until: Date.now() + 90_000
        }

        return { held: true, executorId: id, acquiredAt: holder.since, expiresAt: holder.until }
      }
    })
    const values = new Map<string, string>()
    agent.continuous = new MatrixContinuousListening({
      store: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value)
        },
        removeItem: key => {
          values.delete(key)
        }
      },
      context: () =>
        agent.lease!.held(executor) ? { state: 'ready' } : { state: 'waiting', reason: 'lease_elsewhere' },
      stop: () => agent.listener.stop(),
      listener: () => agent.listener.snapshot(),
      changed,
      arm: async preference => {
        watchId = `watch-${executor}-${Date.now()}`
        agent.listener.start({
          id: watchId,
          roomId: preference.roomId,
          sender: { userId: '@owner:test', deviceId: 'PHONE' },
          since: Date.now(),
          until: Date.now() + 3_600_000
        })
      }
    })
    reconcile()

    return {
      agent,
      execute,
      reconcile,
      incoming: () => agent.listener.offer({ roomId: '!agent:test', watchId, eventId: `$new-${Date.now()}` })
    }
  }

  const mini = mac('mini'),
    laptop = mac('laptop')

  const flush = async (ms = 0) => {
    // Step real renewal timers while flushing the same deferred reconciliation
    // that production schedules after snapshots/lease changes.
    for (let at = 0; at <= ms; at += 1000) {
      await vi.advanceTimersByTimeAsync(at === 0 ? 0 : Math.min(1000, ms - at + 1000))

      for (let round = 0; round < 10; round++) {
        const work = [...pendingReconcile]
        pendingReconcile.clear()

        for (const reconcile of work) {reconcile()}
        await vi.advanceTimersByTimeAsync(0)
      }
    }
  }

  return {
    mini,
    laptop,
    calls,
    flush,
    offline: (value: boolean) => {
      miniOffline = value
    }
  }
}

it('idle laptop never takes a listening mini lease during lapse and recovery', async () => {
  const f = twoMacs()
  await f.flush()
  expect(f.laptop.agent.lease!.ready).toBe(true)
  expect(f.calls).toEqual([])
  f.mini.agent.continuous!.enable('a'.repeat(64), '!agent:test')
  await f.flush()
  expect(f.mini.agent.listener.snapshot()?.state).toBe('listening')
  f.offline(true)
  await f.flush(96_000)
  expect(f.mini.agent.lease!.held('mini')).toBeNull()
  expect(f.mini.agent.continuous!.wantsLease).toBe(true)
  expect(f.calls.filter(call => call.executor === 'laptop')).toEqual([])
  f.offline(false)
  await f.flush(40_000)
  expect(f.mini.agent.listener.snapshot()?.state).toBe('listening')
  f.mini.incoming()
  await f.flush()
  expect(f.mini.execute).toHaveBeenCalledTimes(1)
  expect(f.laptop.execute).not.toHaveBeenCalled()
  expect(f.calls.filter(call => call.executor === 'laptop')).toEqual([])
})

it('room-bound local work cannot steal a held lease, and releases after completion', async () => {
  const f = twoMacs()
  f.mini.agent.continuous!.enable('a'.repeat(64), '!agent:test')
  await f.flush()
  // Model preparation also occupies invocation, but must not claim ownership.
  f.laptop.agent.invocation = { abort: new AbortController(), pending: Promise.resolve() }
  expect(matrixAgentLeaseDemand(f.laptop.agent)).toBe(false)
  f.laptop.reconcile()
  await f.flush()
  expect(f.calls.filter(call => call.executor === 'laptop')).toEqual([])
  f.laptop.agent.invocation.roomId = '!agent:test'
  f.laptop.reconcile()
  await f.flush()
  expect(f.laptop.agent.lease!.current.state).toBe('elsewhere')
  expect(f.mini.agent.listener.snapshot()?.state).toBe('listening')
  f.laptop.agent.invocation = undefined
  f.laptop.reconcile()
  await f.flush(120_000)
  expect(f.laptop.agent.lease!.current.state).toBe('idle')
  expect(f.calls.filter(call => call.executor === 'laptop')).toHaveLength(1)
  f.mini.agent.continuous!.disable()
  await f.flush()
  expect(f.mini.agent.lease!.current.state).toBe('idle')
  expect(f.calls.at(-1)).toEqual({ executor: 'mini', operation: 'release' })
})

it('retains local-turn ownership until actual execution ends; no idle grace monopolizes it', async () => {
  const f = twoMacs()
  f.laptop.agent.invocation = { roomId: '!agent:test', abort: new AbortController(), pending: Promise.resolve() }
  f.laptop.reconcile()
  await f.flush(120_000)
  const session = f.laptop.agent.lease!.held('laptop')!
  expect(session.signal.aborted).toBe(false)
  expect(f.calls.filter(call => call.operation === 'release')).toEqual([])
  // Cancellation is not yet quiescence: keep ownership until the turn's
  // finally block clears its slot, even after the abort was requested.
  f.laptop.agent.invocation!.abort.abort()
  f.laptop.reconcile()
  await f.flush()
  expect(session.signal.aborted).toBe(false)
  f.laptop.agent.invocation = undefined
  f.laptop.reconcile()
  await f.flush()
  expect(session.signal.aborted).toBe(true)
  expect(f.laptop.agent.lease!.current.state).toBe('idle')
})

it('a group message to the agent takes a free lease on this Mac, never one another Mac holds', async () => {
  const f = twoMacs()
  // Nobody holds it: the owner's message to the agent in a group asks for it here.
  expect(matrixAgentLeaseDemand(f.laptop.agent)).toBe(false)
  f.laptop.agent.groupDemand += 1
  expect(matrixAgentLeaseDemand(f.laptop.agent)).toBe(true)
  f.laptop.reconcile()
  await f.flush()
  expect(f.laptop.agent.lease!.held('laptop')).not.toBeNull()
  // Answered (or not): demand ends, and the lease goes back.
  f.laptop.agent.groupDemand -= 1
  f.laptop.reconcile()
  await f.flush()
  expect(f.laptop.agent.lease!.current.state).toBe('idle')

  // The mini answers this agent: a group message on the laptop doesn't take its lease.
  f.mini.agent.continuous!.enable('a'.repeat(64), '!agent:test')
  await f.flush()
  f.laptop.agent.groupDemand += 1
  f.laptop.reconcile()
  await f.flush()
  expect(f.laptop.agent.lease!.current.state).toBe('elsewhere')
  expect(f.mini.agent.lease!.held('mini')).not.toBeNull()
})
