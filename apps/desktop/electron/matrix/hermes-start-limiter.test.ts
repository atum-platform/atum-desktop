import { describe, expect, it, vi } from 'vitest'

import { HermesStartLimiter } from './hermes-start-limiter'

describe('HermesStartLimiter', () => {
  it('hands an available permit back synchronously so launch keeps its abort listener ordering', () => {
    const limiter = new HermesStartLimiter(1)
    const release = limiter.acquire(new AbortController().signal)

    expect(typeof release).toBe('function')
    ;(release as () => void)()
  })

  it('admits two cold starts, then releases queued agents in order', async () => {
    const limiter = new HermesStartLimiter(2)
    const first = await limiter.acquire(new AbortController().signal)
    const second = await limiter.acquire(new AbortController().signal)
    const thirdReady = vi.fn()
    const third = Promise.resolve(limiter.acquire(new AbortController().signal)).then(release => {
      thirdReady()

      return release
    })

    await Promise.resolve()
    expect(thirdReady).not.toHaveBeenCalled()
    first()
    const releaseThird = await third
    expect(thirdReady).toHaveBeenCalledOnce()
    releaseThird()
    second()
  })

  it('removes an aborted queued start without consuming the next permit', async () => {
    const limiter = new HermesStartLimiter(1)
    const first = await limiter.acquire(new AbortController().signal)
    const cancelled = new AbortController()
    const waiting = limiter.acquire(cancelled.signal)
    const next = limiter.acquire(new AbortController().signal)

    cancelled.abort(new Error('closed'))
    await expect(waiting).rejects.toThrow('closed')
    first()
    const releaseNext = await next
    releaseNext()
  })

  it('makes release idempotent', async () => {
    const limiter = new HermesStartLimiter(1)
    const first = await limiter.acquire(new AbortController().signal)
    const next = limiter.acquire(new AbortController().signal)

    first()
    first()
    const releaseNext = await next
    const third = Promise.resolve(limiter.acquire(new AbortController().signal))

    await Promise.resolve()
    let admitted = false
    void third.then(() => {
      admitted = true
    })
    expect(admitted).toBe(false)
    releaseNext()
    ;(await third)()
  })
})
