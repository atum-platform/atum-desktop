import { describe, expect, it, vi } from 'vitest'

import { drainMatrixRuntimes } from './runtime-drain'

function agent(room = true) {
  let finish!: () => void
  const pending = new Promise<void>(resolve => {
    finish = resolve
  })
  const value = {
    operation: false,
    invocation: room ? { abort: new AbortController(), roomId: '!room:test', pending } : { abort: new AbortController(), pending },
    lease: { drain: vi.fn(() => true), release: vi.fn(async () => {}) },
    listener: { drainAndStop: vi.fn() }
  }

  return { value, finish }
}

describe('runtime drain', () => {
  it('drains and awaits one admitted room turn before quit teardown', async () => {
    const f = agent()
    let settled = false
    const draining = drainMatrixRuntimes([f.value], { holdOperations: true, reason: 'cancelled' })
    void draining.then(() => {
      settled = true
    })

    expect(f.value.operation).toBe(true)
    expect(f.value.listener.drainAndStop).toHaveBeenCalledWith('cancelled')
    expect(f.value.lease.drain).toHaveBeenCalledOnce()
    expect(f.value.lease.release).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(settled).toBe(false)
    f.finish()
    await expect(draining).resolves.toEqual({ timedOut: false })
    expect(settled).toBe(true)
  })

  it('releases an idle or setup-only lease without awaiting it', async () => {
    const f = agent(false)
    await expect(drainMatrixRuntimes([f.value], { holdOperations: true, reason: 'cancelled' })).resolves.toEqual({
      timedOut: false
    })
    expect(f.value.operation).toBe(true)
    expect(f.value.listener.drainAndStop).toHaveBeenCalledWith('cancelled')
    expect(f.value.lease.drain).not.toHaveBeenCalled()
    expect(f.value.lease.release).toHaveBeenCalledOnce()
  })

  it('contains a rejected admitted turn while every runtime still drains', async () => {
    const good = agent()
    const rejected = {
      ...agent().value,
      invocation: { abort: new AbortController(), roomId: '!other:test', pending: Promise.reject(new Error('turn failed')) }
    }
    const draining = drainMatrixRuntimes([good.value, rejected], {
      holdOperations: true,
      reason: 'cancelled'
    })
    good.finish()
    await expect(draining).resolves.toEqual({ timedOut: false })
    expect(rejected.lease.drain).toHaveBeenCalledOnce()
  })

  it('bounds quit drain and aborts the admitted slot into normal settlement', async () => {
    vi.useFakeTimers()
    const f = agent()

    try {
      const draining = drainMatrixRuntimes([f.value], {
        holdOperations: true,
        reason: 'cancelled',
        timeoutMs: 100
      })
      await vi.advanceTimersByTimeAsync(100)
      await expect(draining).resolves.toEqual({ timedOut: true })
      expect(f.value.invocation.abort.signal.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('contains one broken runtime and still drains the rest', async () => {
    const broken = agent(false).value
    const healthy = agent(false).value
    broken.listener.drainAndStop.mockImplementation(() => {
      throw new Error('retired')
    })
    broken.lease.release.mockImplementation(() => {
      throw new Error('broken lease')
    })
    await expect(
      drainMatrixRuntimes([broken, healthy], { holdOperations: true, reason: 'cancelled' })
    ).resolves.toEqual({ timedOut: false })
    expect(healthy.listener.drainAndStop).toHaveBeenCalledOnce()
    expect(healthy.lease.release).toHaveBeenCalledOnce()
  })
})
