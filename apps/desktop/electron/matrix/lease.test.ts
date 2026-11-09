import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MatrixExecutorLease } from './lease'

const executorId = '00000000-0000-4000-8000-75c02539218c'

function fixture() {
  const responses: Array<unknown | Error> = []

  const request = vi.fn(
    async (operation: 'acquire' | 'release', id: string, _metadata?: { protocol: 2; leaseToken?: string }) => {
      if (operation === 'release') {
        return { held: false }
      }

      const next = responses.shift() ?? granted()

      if (next instanceof Error) {
        throw next
      }

      return { ...(next as object), ...(id === executorId ? {} : { executorId: id }) }
    }
  )

  const granted = (acquiredAt = 1_000, expiresAt = Date.now() + 90_000) => ({
    held: true,
    executorId,
    acquiredAt,
    expiresAt
  })

  const v2Granted = (
    leaseToken = '00000000-0000-4000-8000-127ad7633157',
    boundary = 9_999_000,
    acquiredAt = 1_000,
    expiresAt = Date.now() + 90_000
  ) => ({ held: true, executorId, acquiredAt, expiresAt, leaseToken, boundary })

  // No jitter here: the timing assertions below are exact.
  const lease = new MatrixExecutorLease({ request, random: () => 0.5 })

  return { lease, request, responses, granted, v2Granted }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000_000)
})

afterEach(() => vi.useRealTimers())

describe('answering-executor lease', () => {
  it('releases to idle without retrying, then reacquires on actual demand', async () => {
    const f = fixture()
    await f.lease.release()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.lease.current.state).toBe('idle')
    expect(f.request).not.toHaveBeenCalled()
    f.lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    const session = f.lease.held(executorId)!
    await f.lease.release()
    expect(session.signal.aborted).toBe(true)
    expect(f.request).toHaveBeenLastCalledWith('release', executorId)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.request).toHaveBeenCalledTimes(2)
    f.lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.lease.current.state).toBe('held')
    expect(f.request).toHaveBeenCalledTimes(3)
  })

  it('does not retry another holder when demand ends', async () => {
    const f = fixture()
    f.responses.push({ held: false })
    f.lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    await f.lease.release()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.request).toHaveBeenCalledTimes(1)
    expect(f.lease.current.state).toBe('idle')
  })

  it('ends held work when release is denied without retrying cleanup or resurrecting authority', async () => {
    const f = fixture()
    const grant = f.v2Granted()
    f.responses.push(grant)
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(0)
    const session = f.lease.held(executorId)!
    f.request.mockRejectedValueOnce(new Error('matrix_lease_denied'))

    await expect(f.lease.release()).resolves.toBeUndefined()
    expect(session.signal.aborted).toBe(true)
    expect(f.lease.held(executorId)).toBeNull()
    expect(f.lease.current.state).toBe('idle')
    expect(f.request).toHaveBeenLastCalledWith('release', executorId, { protocol: 2, leaseToken: grant.leaseToken })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.request).toHaveBeenCalledTimes(2)
    await expect(f.lease.stop()).resolves.toBeUndefined()
    expect(f.lease.current.state).toBe('stopped')
    expect(f.request).toHaveBeenCalledTimes(2)
  })

  it('releases an in-flight acquisition before starting the next session', async () => {
    const f = fixture()
    let finish!: (value: unknown) => void
    f.request.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    f.lease.start(executorId)
    f.lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    const released = f.lease.release()
    f.lease.start(executorId)
    expect(f.request).toHaveBeenCalledTimes(1)
    finish(f.granted())
    await released
    await vi.advanceTimersByTimeAsync(0)
    expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(['acquire', 'release', 'acquire'])
    expect(f.lease.current.state).toBe('held')
  })

  it('stop cancels queued demand during an old release', async () => {
    const f = fixture()
    f.lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    let finish!: (value: unknown) => void
    f.request.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const released = f.lease.release()
    await vi.advanceTimersByTimeAsync(0)
    f.lease.start(executorId)
    const stopped = f.lease.stop()
    finish({ held: false })
    await Promise.all([released, stopped])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.request).toHaveBeenCalledTimes(2)
    expect(f.lease.current.state).toBe('stopped')
  })

  it('takes the lease once per session and renews it without starting a new session', async () => {
    const f = fixture()
    f.lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    const session = f.lease.held(executorId)
    expect(session).toMatchObject({ since: 10_000_000 })
    expect(f.lease.held('another-executor')).toBeNull()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.request).toHaveBeenCalledTimes(2)
    expect(f.lease.held(executorId)).toMatchObject({ since: 10_000_000, signal: session!.signal })
    expect(session!.signal.aborted).toBe(false)
  })

  it('reports another holder, then takes over as a new session', async () => {
    const f = fixture()
    f.responses.push({ held: false, until: Date.now() + 40_000 })
    f.lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.lease.current).toEqual({ state: 'elsewhere', until: Date.now() + 40_000 })
    expect(f.lease.held(executorId)).toBeNull()

    f.responses.push(f.granted(5_000))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.lease.held(executorId)).toMatchObject({ since: 10_000_000 + 30_000 })
  })

  it('keeps the lease through a failed renewal while it cannot lapse yet', async () => {
    const f = fixture()
    f.lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    const session = f.lease.held(executorId)!
    f.responses.push(new Error('offline'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.lease.held(executorId)).not.toBeNull()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f.lease.held(executorId)?.signal).toBe(session.signal)
    expect(session.signal.aborted).toBe(false)
  })

  it('ends held work immediately on an authority denial, without retrying the withdrawn executor', async () => {
    const f = fixture()
    f.responses.push(f.v2Granted())
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(0)
    const session = f.lease.held(executorId)!
    f.responses.push(new Error('matrix_lease_denied'))
    await vi.advanceTimersByTimeAsync(30_000)

    expect(session.signal.aborted).toBe(true)
    expect(f.lease.held(executorId)).toBeNull()
    expect(f.lease.current).toEqual({ state: 'unavailable', reason: 'authority_withdrawn' })
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.request).toHaveBeenCalledTimes(2)
  })

  it('does not retry an initial authority denial', async () => {
    const f = fixture()
    f.responses.push(new Error('matrix_lease_denied'))
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.request).toHaveBeenCalledOnce()
    expect(f.lease.ready).toBe(false)
    expect(f.lease.current).toEqual({ state: 'unavailable', reason: 'authority_withdrawn' })
  })

  it('a late grant cannot resurrect a generation after another renewal proves withdrawal', async () => {
    const f = fixture()
    f.responses.push(f.v2Granted())
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(0)
    let finish!: (value: unknown) => void
    f.request.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    await vi.advanceTimersByTimeAsync(30_000)
    f.responses.push(new Error('matrix_lease_denied'))
    // The hung request loses its lease at 75 s. The next attempt proves denial at 85 s.
    await vi.advanceTimersByTimeAsync(55_000)
    expect(f.lease.current).toEqual({ state: 'unavailable', reason: 'authority_withdrawn' })
    finish(f.v2Granted('00000000-0000-4000-8000-150a96bed4e5'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.lease.held(executorId)).toBeNull()
    expect(f.lease.current).toEqual({ state: 'unavailable', reason: 'authority_withdrawn' })
    expect(f.request).toHaveBeenCalledTimes(3)
  })

  it('ends the session before the lease could lapse when no renewal succeeds', async () => {
    const f = fixture()
    f.lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    const session = f.lease.held(executorId)!
    // Every renewal now hangs, as a stalled network would.
    f.request.mockImplementation(() => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(74_000)
    expect(session.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(session.signal.aborted).toBe(true)
    expect(f.lease.current).toEqual({ state: 'unavailable' })
    expect(f.lease.held(executorId)).toBeNull()
  })

  it('held is null past the wall-clock margin even when the lapse timer never fired', async () => {
    const f = fixture()
    f.lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    const session = f.lease.held(executorId)!

    // Moving the wall clock does not run fake timers: this models a timer frozen by sleep.
    vi.setSystemTime(10_000_000 + 75_000)
    expect(f.lease.held(executorId)).toBeNull()
    expect(session.signal.aborted).toBe(true)
    expect(f.lease.current).toEqual({ state: 'unavailable' })
  })

  it('revalidates a frozen held term on resume', async () => {
    const lost = vi.fn()
    const f = fixture()
    const lease = new MatrixExecutorLease({
      request: f.request,
      random: () => 0.5,
      onLost: lost
    })
    lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    const session = lease.held(executorId)!

    vi.setSystemTime(10_000_000 + 75_000)
    lease.resume()
    expect(session.signal.aborted).toBe(true)
    expect(lease.held(executorId)).toBeNull()
    expect(lost).toHaveBeenCalledWith('resume')
  })

  it('fences a renewal that was in flight before resume', async () => {
    const f = fixture()
    const token = '00000000-0000-4000-8000-127ad7633157'
    f.responses.push(f.v2Granted(token))
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(0)
    const session = f.lease.held(executorId)!
    let finish!: (value: unknown) => void
    f.request.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    await vi.advanceTimersByTimeAsync(30_000)

    const resumedExpiry = Date.now() + 90_000
    f.responses.push(f.v2Granted(token, undefined, 1_000, resumedExpiry))
    f.lease.resume()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.lease.current).toMatchObject({ state: 'held', expiresAt: resumedExpiry })

    finish(f.v2Granted(token, undefined, 1_000, resumedExpiry - 30_000))
    await Promise.resolve()
    expect(f.lease.current).toMatchObject({ state: 'held', expiresAt: resumedExpiry })
    expect(f.lease.held(executorId)?.signal).toBe(session.signal)
  })

  it('keeps the current wall-clock guard while a resume renewal hangs', async () => {
    const f = fixture()
    f.lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    const session = f.lease.held(executorId)!
    f.request.mockImplementationOnce(() => new Promise(() => {}))

    f.lease.resume()
    await vi.advanceTimersByTimeAsync(74_000)
    expect(session.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(session.signal.aborted).toBe(true)
    expect(f.lease.current).toEqual({ state: 'unavailable' })
  })

  it('releases a grant whose server start is too far ahead to trust', async () => {
    const lost = vi.fn()
    const f = fixture()
    f.responses.push(f.v2Granted(undefined, undefined, Date.now() + 5_001, Date.now() + 95_001))
    const lease = new MatrixExecutorLease({
      request: f.request,
      random: () => 0.5,
      onLost: lost
    })

    lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()

    expect(lease.held(executorId)).toBeNull()
    expect(lost).toHaveBeenCalledWith('skew')
    expect(f.request).toHaveBeenLastCalledWith('release', executorId, {
      protocol: 2,
      leaseToken: '00000000-0000-4000-8000-127ad7633157'
    })
  })

  it('starts a new session after losing the lease, even when the platform kept its start', async () => {
    const f = fixture()
    f.lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    const first = f.lease.held(executorId)!
    f.request.mockImplementationOnce(() => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(76_000)
    expect(first.signal.aborted).toBe(true)
    // The platform still has this executor's lease and returns its original start.
    await vi.advanceTimersByTimeAsync(30_000)
    const second = f.lease.held(executorId)!
    // Lost at 75 s (15 s before the 90 s term), retried 30 s later.
    expect(second.since).toBe(10_000_000 + 105_000)
    expect(second.signal).not.toBe(first.signal)
  })

  it('falls back to per-message grants when the platform has no lease route', async () => {
    const f = fixture()
    f.responses.push(new Error('matrix_lease_unavailable'))
    f.lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.lease.current).toEqual({ state: 'unavailable' })
    expect(f.lease.held(executorId)).toBeNull()
  })

  it('releases a held lease on stop and ends its session', async () => {
    const f = fixture()
    f.lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    const session = f.lease.held(executorId)!
    await f.lease.stop()
    expect(session.signal.aborted).toBe(true)
    expect(f.request).toHaveBeenLastCalledWith('release', executorId)
    expect(f.lease.current).toEqual({ state: 'stopped' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.request).toHaveBeenCalledTimes(2)
  })

  it('keeps a v2 session and token through a renewal', async () => {
    const f = fixture()
    const token = '00000000-0000-4000-8000-127ad7633157'
    f.responses.push(f.v2Granted(token))
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(0)
    const session = f.lease.held(executorId)!
    expect(session).toMatchObject({ leaseToken: token, boundary: 9_999_000 })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.request).toHaveBeenLastCalledWith('acquire', executorId, { protocol: 2, leaseToken: token })
    expect(f.lease.held(executorId)?.signal).toBe(session.signal)
  })

  it.each(['owner_policy', 'owner_home'])('holds a normal v2 grant with the %s selection reason', async reason => {
    const f = fixture()
    const grant = f.v2Granted()
    f.responses.push({
      ...grant,
      selection: { generation: 2, reason, yield: false }
    })

    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(0)

    expect(f.lease.current).toMatchObject({
      state: 'held',
      leaseToken: grant.leaseToken,
      boundary: grant.boundary
    })
    expect(f.lease.fenceFacts(executorId)).toEqual({
      leaseId: grant.leaseToken, leaseExpiresAtPlatform: grant.expiresAt, executorTerm: 2
    })
    const session = f.lease.held(executorId)!
    f.responses.push({ ...grant, expiresAt: grant.expiresAt + 30_000,
      selection: { generation: 2, reason, yield: false } })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.lease.held(executorId)?.signal).toBe(session.signal)
    expect(f.lease.current.state).toBe('held')
  })

  it('rejects an unknown selection reason on an otherwise valid v2 grant', async () => {
    const f = fixture()
    f.responses.push({ ...f.v2Granted(), selection: { generation: 2, reason: 'unknown', yield: false } })
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(0)

    expect(f.lease.current.state).toBe('unavailable')
    expect(f.lease.held(executorId)).toBeNull()
    expect(f.lease.fenceFacts(executorId)).toBeNull()
  })

  describe('the fence an agent-home executor signs with (atum.agent-home/2.1)', () => {
    it('offers the lease token, the platform expiry and the grant\'s lease generation as the executor term', async () => {
      const f = fixture()
      const grant = f.v2Granted()
      f.responses.push({ ...grant, selection: { generation: 7, reason: 'owner_policy', yield: false } })

      f.lease.start(executorId, 2)
      await vi.advanceTimersByTimeAsync(0)

      expect(f.lease.fenceFacts(executorId)).toEqual({
        leaseId: grant.leaseToken,
        leaseExpiresAtPlatform: grant.expiresAt,
        executorTerm: 7
      })
      // The status itself is exactly what it was: the term is not part of it.
      expect(f.lease.current).toEqual({
        state: 'held',
        acquiredAt: grant.acquiredAt,
        expiresAt: grant.expiresAt,
        leaseToken: grant.leaseToken,
        boundary: grant.boundary
      })
    })

    it('follows a renewal to the new expiry and a new term to its generation', async () => {
      const f = fixture()
      const token = '00000000-0000-4000-8000-127ad7633157'
      const first = f.v2Granted(token, 9_999_000, 1_000, Date.now() + 90_000)
      const renewed = { ...first, expiresAt: first.expiresAt + 30_000 }
      f.responses.push({ ...first, selection: { generation: 7, reason: 'owner_policy', yield: false } })
      f.responses.push({ ...renewed, selection: { generation: 7, reason: 'owner_policy', yield: false } })

      f.lease.start(executorId, 2)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(30_000)

      expect(f.lease.fenceFacts(executorId)).toEqual({ leaseId: token, leaseExpiresAtPlatform: renewed.expiresAt, executorTerm: 7 })
    })

    it('has nothing to offer without a v2 term, a policy generation, the right executor, or after the term is lost', async () => {
      const f = fixture()
      f.responses.push(f.v2Granted())
      f.lease.start(executorId, 2)
      await vi.advanceTimersByTimeAsync(0)

      // A v2 grant that is not policy-selected carries no generation.
      expect(f.lease.fenceFacts(executorId)).toBeNull()
      expect(f.lease.fenceFacts('00000000-0000-4000-8000-899c4850a597')).toBeNull()

      const g = fixture()
      g.responses.push({ ...g.v2Granted(), selection: { generation: 3, reason: 'owner_policy', yield: false } })
      g.lease.start(executorId, 2)
      await vi.advanceTimersByTimeAsync(0)
      expect(g.lease.fenceFacts(executorId)).not.toBeNull()
      await g.lease.stop()
      expect(g.lease.fenceFacts(executorId)).toBeNull()
    })
  })

  it('stops new claims on a policy yield while an existing turn keeps its fenced signal', async () => {
    const f = fixture()
    const token = '00000000-0000-4000-8000-127ad7633157'
    const expiresAt = Date.now() + 90_000
    const grant = f.v2Granted(token, 9_999_000, 1_000, expiresAt)
    f.responses.push(grant, {
      held: true,
      executorId,
      acquiredAt: grant.acquiredAt,
      expiresAt,
      leaseToken: token,
      selection: { generation: 2, reason: 'higher_priority', yield: true }
    })
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(0)
    const active = f.lease.held(executorId)!
    await vi.advanceTimersByTimeAsync(30_000)

    expect(f.lease.current).toEqual({
      state: 'yielding',
      acquiredAt: 1_000,
      expiresAt,
      leaseToken: token,
      boundary: 9_999_000
    })
    expect(f.lease.held(executorId)).toBeNull()
    expect(active.signal.aborted).toBe(false)
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f.request).toHaveBeenCalledTimes(2)

    await f.lease.release()
    expect(active.signal.aborted).toBe(true)
    expect(f.request).toHaveBeenLastCalledWith('release', executorId, { protocol: 2, leaseToken: token })
  })

  it('locally drains an admitted v2 turn without renewing or aborting its fenced signal', async () => {
    const f = fixture()
    const grant = f.v2Granted()
    f.responses.push(grant)
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(0)
    const active = f.lease.held(executorId)!

    expect(f.lease.drain()).toBe(true)
    expect(f.lease.drain()).toBe(true)
    expect(f.lease.current).toEqual({
      state: 'yielding',
      acquiredAt: grant.acquiredAt,
      expiresAt: grant.expiresAt,
      leaseToken: grant.leaseToken,
      boundary: grant.boundary
    })
    expect(f.lease.held(executorId)).toBeNull()
    expect(active.signal.aborted).toBe(false)
    f.lease.resume()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.lease.current.state).toBe('yielding')
    expect(active.signal.aborted).toBe(false)
    expect(f.request).toHaveBeenCalledOnce()

    await f.lease.release()
    expect(active.signal.aborted).toBe(true)
    expect(f.request).toHaveBeenLastCalledWith('release', executorId, {
      protocol: 2,
      leaseToken: grant.leaseToken
    })
  })

  it('releases immediately when no fenced v2 term can drain', async () => {
    const f = fixture()
    f.lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    const active = f.lease.held(executorId)!
    expect(f.lease.drain()).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(active.signal.aborted).toBe(true)
    expect(f.lease.current.state).toBe('idle')
  })

  it('does not revive a drained term after its original wall-clock margin', async () => {
    const f = fixture()
    f.responses.push(f.v2Granted())
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(0)
    const active = f.lease.held(executorId)!
    expect(f.lease.drain()).toBe(true)
    await vi.advanceTimersByTimeAsync(75_000)
    expect(active.signal.aborted).toBe(true)
    expect(f.lease.current.state).toBe('unavailable')
    expect(f.lease.drain()).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.lease.current.state).toBe('idle')
    expect(f.request).toHaveBeenCalledOnce()
  })

  it('ends a yielding term at the original wall-clock margin when work does not finish', async () => {
    const f = fixture()
    const token = '00000000-0000-4000-8000-127ad7633157'
    const expiresAt = Date.now() + 90_000
    const grant = f.v2Granted(token, 9_999_000, 1_000, expiresAt)
    f.responses.push(grant, {
      held: true,
      executorId,
      acquiredAt: grant.acquiredAt,
      expiresAt,
      leaseToken: token,
      selection: { generation: 2, reason: 'higher_priority', yield: true }
    })
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(0)
    const active = f.lease.held(executorId)!
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(45_000)

    expect(active.signal.aborted).toBe(true)
    expect(f.lease.current).toEqual({ state: 'unavailable' })
  })

  it('rejects a yield that changes the exact term or injects another response field', async () => {
    const f = fixture()
    const token = '00000000-0000-4000-8000-127ad7633157'
    const expiresAt = Date.now() + 90_000
    const grant = f.v2Granted(token, 9_999_000, 1_000, expiresAt)
    f.responses.push(grant, {
      held: true,
      executorId,
      acquiredAt: grant.acquiredAt,
      expiresAt: expiresAt + 1,
      leaseToken: token,
      boundary: grant.boundary,
      selection: { generation: 2, reason: 'higher_priority', yield: true }
    })
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(0)
    const active = f.lease.held(executorId)!
    await vi.advanceTimersByTimeAsync(30_000)

    expect(f.lease.current).toMatchObject({ state: 'held', expiresAt })
    expect(f.lease.held(executorId)?.signal).toBe(active.signal)
    expect(active.signal.aborted).toBe(false)
  })

  it('treats a changed v2 token as a replacement even when acquiredAt is unchanged', async () => {
    const f = fixture()
    const oldToken = '00000000-0000-4000-8000-127ad7633157'
    const successorToken = '00000000-0000-4000-8000-150a96bed4e5'
    f.responses.push(f.v2Granted(oldToken), f.v2Granted(successorToken))
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(0)
    const first = f.lease.held(executorId)!
    await vi.advanceTimersByTimeAsync(30_000)
    const second = f.lease.held(executorId)!
    expect(first.signal.aborted).toBe(true)
    expect(second.signal).not.toBe(first.signal)
    expect(second.leaseToken).toBe(successorToken)
    await f.lease.stop()
    expect(f.request).toHaveBeenLastCalledWith('release', executorId, { protocol: 2, leaseToken: successorToken })
  })

  it('fails closed when a v2 grant omits its activation boundary', async () => {
    const f = fixture()
    f.responses.push({ ...f.v2Granted(), boundary: undefined })
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.lease.current).toEqual({ state: 'unavailable' })
    expect(f.lease.held(executorId)).toBeNull()
  })

  it('releases a delayed v2 grant with its returned token', async () => {
    const f = fixture()
    let finish!: (value: unknown) => void
    f.request.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(0)
    const stopped = f.lease.stop()
    finish(f.v2Granted())
    await stopped
    expect(f.request.mock.calls).toEqual([
      ['acquire', executorId, { protocol: 2 }],
      ['release', executorId, { protocol: 2, leaseToken: '00000000-0000-4000-8000-127ad7633157' }]
    ])
  })

  it('releases a stopped v2 holder with exactly its held token', async () => {
    const f = fixture()
    const token = '00000000-0000-4000-8000-127ad7633157'
    f.responses.push(f.v2Granted(token))
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(0)
    await f.lease.stop()
    expect(f.request).toHaveBeenLastCalledWith('release', executorId, { protocol: 2, leaseToken: token })
  })

  it('aborts the old session and starts a new one when the protocol changes', async () => {
    const f = fixture()
    f.responses.push(f.granted(), f.v2Granted())
    f.lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    const legacy = f.lease.held(executorId)!
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(0)
    expect(legacy.signal.aborted).toBe(true)
    expect(f.request.mock.calls.map(([operation, _id, metadata]) => [operation, metadata])).toEqual([
      ['acquire', undefined],
      ['release', undefined],
      ['acquire', { protocol: 2 }]
    ])
    expect(f.lease.held(executorId)?.leaseToken).toBe('00000000-0000-4000-8000-127ad7633157')
  })

  it('stops legacy retries after the platform requires the upgraded protocol', async () => {
    const f = fixture()
    f.responses.push({ held: false, reason: 'upgrade_required' })
    f.lease.start(executorId)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.lease.current).toEqual({ state: 'unavailable', reason: 'upgrade_required' })
    expect(f.request).toHaveBeenCalledTimes(1)
  })

  it("keeps asking while the platform holds the agent for the owner's plan, and takes it once the plan is back (0238)", async () => {
    const f = fixture()
    f.responses.push({ held: false, reason: 'entitlement_required' })
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(0)

    // Not terminal like upgrade_required: this Mac is not holding, and says why.
    expect(f.lease.current).toEqual({ state: 'elsewhere', reason: 'entitlement_required' })
    expect(f.lease.held(executorId)).toBeNull()
    expect(f.lease.ready).toBe(true)

    f.responses.push(f.v2Granted())
    await vi.advanceTimersByTimeAsync(12_000)
    expect(f.lease.held(executorId)?.leaseToken).toBe('00000000-0000-4000-8000-127ad7633157')
    expect(f.lease.current.state).toBe('held')
  })

  it('carries no reason the platform did not name from the closed list', async () => {
    const f = fixture()
    f.responses.push({ held: false, reason: 'something_else' })
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.lease.current).toEqual({ state: 'elsewhere' })
  })

  it('retries another v2 holder after 10 seconds with jitter', async () => {
    const f = fixture()
    f.responses.push({ held: false })
    f.lease.start(executorId, 2)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(7_999)
    expect(f.request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.request).toHaveBeenLastCalledWith('acquire', executorId, { protocol: 2 })
  })
})

it('renews within ±20% of its term, so many agents never renew in lockstep', async () => {
  for (const [random, earliest] of [
    [0, 24_000],
    [1, 36_000]
  ] as const) {
    const request = vi.fn(async (operation: string) =>
      operation === 'acquire'
        ? { held: true, executorId: 'executor', acquiredAt: Date.now(), expiresAt: Date.now() + 90_000 }
        : { held: false }
    )

    const lease = new MatrixExecutorLease({ request, random: () => random })
    lease.start('executor')
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(earliest - 1)
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(2)
    await lease.stop()
  }
})
