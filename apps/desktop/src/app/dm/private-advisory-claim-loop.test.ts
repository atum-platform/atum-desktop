import { afterEach, expect, it, vi } from 'vitest'

import { startPrivateAdvisoryClaimLoop } from './private-advisory-claim-loop'

afterEach(() => vi.useRealTimers())

it('claims existing authorized slots serially and stops when the renderer closes', async () => {
  vi.useFakeTimers()
  let enabled = false
  let finish!: () => void
  const claim = vi.fn().mockImplementation(() => new Promise<{ jobId: string }>(resolve => { finish = () => resolve({ jobId: 'job' }) }))
  const stop = startPrivateAdvisoryClaimLoop({ canClaim: async () => enabled, claim })
  await vi.advanceTimersByTimeAsync(5_000)
  expect(claim).not.toHaveBeenCalled()
  enabled = true
  await vi.advanceTimersByTimeAsync(10_000)
  expect(claim).toHaveBeenCalledTimes(1)
  expect(claim.mock.calls[0][0]).toMatch(/^[0-9a-f-]{36}$/)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(claim).toHaveBeenCalledTimes(1)
  finish()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(claim).toHaveBeenCalledTimes(2)
  stop()
  finish()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(claim).toHaveBeenCalledTimes(2)
})

it('does not claim if teardown occurs during the capability read', async () => {
  let allow!: (value: boolean) => void
  const claim = vi.fn()
  const stop = startPrivateAdvisoryClaimLoop({ canClaim: () => new Promise(resolve => { allow = resolve }), claim })
  stop()
  allow(true)
  await Promise.resolve()
  expect(claim).not.toHaveBeenCalled()
})


it('backs off empty claims to 60-second recovery, resets on work and wake', async () => {
  vi.useFakeTimers()
  let wake!: () => void
  let jobId: string | null = null
  const claim = vi.fn(async () => ({ jobId }))
  const unsubscribe = vi.fn()
  const stop = startPrivateAdvisoryClaimLoop({
    canClaim: async () => true, claim,
    subscribeWake: callback => { wake = callback; return unsubscribe }
  })
  await vi.advanceTimersByTimeAsync(75_000)
  expect(claim).toHaveBeenCalledTimes(5)
  await vi.advanceTimersByTimeAsync(59_999)
  expect(claim).toHaveBeenCalledTimes(5)
  jobId = 'queued-job'
  await vi.advanceTimersByTimeAsync(1)
  expect(claim).toHaveBeenCalledTimes(6)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(claim).toHaveBeenCalledTimes(7)
  jobId = null
  await vi.advanceTimersByTimeAsync(80_000)
  const beforeWake = claim.mock.calls.length
  wake()
  await vi.advanceTimersByTimeAsync(0)
  expect(claim).toHaveBeenCalledTimes(beforeWake + 1)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(claim).toHaveBeenCalledTimes(beforeWake + 2)
  stop()
  expect(unsubscribe).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(claim).toHaveBeenCalledTimes(beforeWake + 2)
})

it('serializes a wake during a claim and follows it immediately', async () => {
  vi.useFakeTimers()
  let wake!: () => void
  let finish!: (value: { jobId: null }) => void
  const claim = vi.fn(() => new Promise<{ jobId: null }>(resolve => { finish = resolve }))
  const stop = startPrivateAdvisoryClaimLoop({
    canClaim: async () => true, claim,
    subscribeWake: callback => { wake = callback; return () => undefined }
  })
  await vi.advanceTimersByTimeAsync(0)
  wake()
  expect(claim).toHaveBeenCalledTimes(1)
  finish({ jobId: null })
  await vi.advanceTimersByTimeAsync(0)
  expect(claim).toHaveBeenCalledTimes(2)
  stop()
  finish({ jobId: null })
})
