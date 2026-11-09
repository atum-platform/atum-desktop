import { afterEach, describe, expect, it, vi } from 'vitest'

import { startMatrixClaimHeartbeat } from './claim-heartbeat'

afterEach(() => vi.useRealTimers())

describe('a dispatched claim heartbeat', () => {
  it('re-arms the same fence on schedule and stops cleanly', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(1_000_000)
    const invocationId = '00000000-0000-4000-8000-1883c063c457'
    const rearm = vi.fn(async () => ({ invocationId, state: 'dispatched', expiresAt: Date.now() + 120_000 }))
    const heartbeat = await startMatrixClaimHeartbeat(invocationId, rearm)
    expect(rearm).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(rearm).toHaveBeenCalledTimes(2)
    expect(heartbeat.signal.aborted).toBe(false)
    await heartbeat.stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(rearm).toHaveBeenCalledTimes(2)
  })

  it('retries a transport failure inside the acknowledged claim', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(2_000_000)
    const invocationId = '00000000-0000-4000-8000-3c04c8b6e615'
    const rearm = vi
      .fn()
      .mockResolvedValueOnce({ invocationId, state: 'dispatched', expiresAt: Date.now() + 120_000 })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ invocationId, state: 'dispatched', expiresAt: Date.now() + 120_000 })
    const heartbeat = await startMatrixClaimHeartbeat(invocationId, rearm)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(rearm).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(rearm).toHaveBeenCalledTimes(3)
    expect(heartbeat.signal.aborted).toBe(false)
    await heartbeat.stop()
  })

  it('does not leave an expiry timer when stopped during a heartbeat request', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(2_500_000)
    const invocationId = '00000000-0000-4000-8000-ed950dd3af5d'
    let finish: ((grant: { invocationId: string; state: string; expiresAt: number }) => void) | undefined
    const rearm = vi
      .fn()
      .mockResolvedValueOnce({ invocationId, state: 'dispatched', expiresAt: Date.now() + 120_000 })
      .mockImplementationOnce(
        () =>
          new Promise<{ invocationId: string; state: string; expiresAt: number }>(resolve => {
            finish = resolve
          })
      )
    const heartbeat = await startMatrixClaimHeartbeat(invocationId, rearm)
    await vi.advanceTimersByTimeAsync(30_000)
    const stopped = heartbeat.stop()
    finish!({ invocationId, state: 'dispatched', expiresAt: Date.now() + 120_000 })
    await stopped
    expect(vi.getTimerCount()).toBe(0)
    expect(heartbeat.signal.aborted).toBe(false)
  })

  it('aborts at the last acknowledged expiry when re-arming stays unavailable', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(3_000_000)
    const invocationId = '00000000-0000-4000-8000-b3dcd126e28d'
    const rearm = vi
      .fn()
      .mockResolvedValueOnce({ invocationId, state: 'dispatched', expiresAt: Date.now() + 120_000 })
      .mockRejectedValue(new Error('offline'))
    const heartbeat = await startMatrixClaimHeartbeat(invocationId, rearm)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(heartbeat.signal.aborted).toBe(true)
    expect(heartbeat.signal.reason).toMatchObject({ message: 'matrix_invocation_claim_expired' })
    await heartbeat.stop()
  })

  it('refuses a re-arm response that changes the fence or state', async () => {
    await expect(
      startMatrixClaimHeartbeat('00000000-0000-4000-8000-fba115f62115', async () => ({
        invocationId: '00000000-0000-4000-8000-b7ec8414dc71',
        state: 'claimed',
        expiresAt: Date.now() + 120_000
      }))
    ).rejects.toThrow('matrix_invocation_claim_heartbeat_invalid')
  })
})
