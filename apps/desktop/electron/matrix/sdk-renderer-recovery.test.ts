import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MatrixSdkRendererRecovery } from './sdk-renderer-recovery'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function fixture(results: Array<boolean | Error>) {
  let eligible = true
  const recovered = vi.fn()
  const exhausted = vi.fn()
  const retrying = vi.fn()
  const start = vi.fn(async () => {
    const result = results.shift() ?? false

    if (result instanceof Error) {
      throw result
    }

    return result
  })
  const recovery = new MatrixSdkRendererRecovery<string>({
    eligible: () => eligible,
    start,
    recovered,
    exhausted,
    retrying,
    delays: [10, 20, 30]
  })

  return { recovery, start, recovered, exhausted, retrying, stop: () => (eligible = false) }
}

describe('SDK renderer recovery', () => {
  it('backs off through failures and reports one recovery', async () => {
    const f = fixture([new Error('load'), false, true])
    f.recovery.restart('agent')
    await vi.advanceTimersByTimeAsync(60)
    expect(f.start).toHaveBeenCalledTimes(3)
    expect(f.retrying.mock.calls.map(call => call[1])).toEqual([1, 2, 3])
    expect(f.recovered).toHaveBeenCalledExactlyOnceWith('agent')
    expect(f.exhausted).not.toHaveBeenCalled()
  })

  it('ends admitted work only after the bounded retry ladder is exhausted', async () => {
    const f = fixture([false, false, false])
    f.recovery.restart('human')
    await vi.advanceTimersByTimeAsync(60)
    expect(f.start).toHaveBeenCalledTimes(3)
    expect(f.recovered).not.toHaveBeenCalled()
    expect(f.exhausted).toHaveBeenCalledExactlyOnceWith('human')
  })

  it('cancels a pending retry and stops when the host is no longer eligible', async () => {
    const f = fixture([true])
    f.recovery.restart('agent')
    f.recovery.cancel('agent')
    await vi.advanceTimersByTimeAsync(60)
    expect(f.start).not.toHaveBeenCalled()

    f.recovery.restart('agent')
    f.stop()
    await vi.advanceTimersByTimeAsync(60)
    expect(f.start).not.toHaveBeenCalled()
  })
})
