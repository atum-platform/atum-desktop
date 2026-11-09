import { describe, expect, it, vi } from 'vitest'

import { QuitTeardownCoordinator } from './quit-teardown-coordinator'

describe('QuitTeardownCoordinator', () => {
  it('joins re-entrant quit events and runs each teardown once', async () => {
    let release!: () => void

    const pending = new Promise<void>(resolve => {
      release = resolve
    })

    const task = vi.fn(() => pending)
    const onComplete = vi.fn()
    const coordinator = new QuitTeardownCoordinator({ onComplete, timeoutMilliseconds: 4_000 })

    expect(coordinator.defer([task])).toBe(true)
    expect(coordinator.defer([task])).toBe(true)
    await vi.waitFor(() => expect(task).toHaveBeenCalledOnce())

    release()
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce())
    expect(coordinator.defer([task])).toBe(false)
    expect(task).toHaveBeenCalledOnce()
  })

  it('completes when a teardown rejects', async () => {
    const onComplete = vi.fn()
    const coordinator = new QuitTeardownCoordinator({ onComplete, timeoutMilliseconds: 4_000 })

    expect(
      coordinator.defer([
        () => {
          throw new Error('teardown_failed')
        }
      ])
    ).toBe(true)
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce())
    expect(coordinator.defer([() => undefined])).toBe(false)
  })

  it('completes at the bounded deadline when teardown never settles', async () => {
    vi.useFakeTimers()
    const onComplete = vi.fn()
    const coordinator = new QuitTeardownCoordinator({ onComplete, timeoutMilliseconds: 4_000 })

    expect(coordinator.defer([() => new Promise(() => undefined)])).toBe(true)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(onComplete).toHaveBeenCalledOnce()
    expect(coordinator.defer([() => undefined])).toBe(false)
    vi.useRealTimers()
  })
})
