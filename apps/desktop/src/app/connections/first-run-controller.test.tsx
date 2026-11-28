import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FIRST_RUN_GREETING_RETRY_MS, firstRunHoldsNotices, firstRunStage, useFirstRunGreetingPhase } from './first-run-controller'

afterEach(() => vi.useRealTimers())

describe('the first run’s one sequencer', () => {
  it('shows the Connections list only after the welcome or the quiet state', () => {
    expect(firstRunStage({ greeting: false, phase: 'pending' })).toEqual({ greeting: 'pending', connections: false })
    expect(firstRunStage({ greeting: false, phase: 'retrying' })).toEqual({ greeting: 'retrying', connections: false })
    expect(firstRunStage({ greeting: false, phase: 'quiet' })).toEqual({ greeting: 'quiet', connections: true })
    // A welcome wins whatever the waiting phase was.
    expect(firstRunStage({ greeting: true, phase: 'quiet' })).toEqual({ greeting: 'generated', connections: true })
  })

  it('asks once more after the wait, then goes quiet; Try again asks again', () => {
    vi.useFakeTimers()
    const resend = vi.fn(async () => {})
    const { result } = renderHook(() => useFirstRunGreetingPhase({ resend, waiting: true }))

    expect(result.current.phase).toBe('pending')
    act(() => void vi.advanceTimersByTime(FIRST_RUN_GREETING_RETRY_MS - 1))
    expect(resend).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(1))
    expect(result.current.phase).toBe('retrying')
    expect(resend).toHaveBeenCalledOnce()
    act(() => void vi.advanceTimersByTime(FIRST_RUN_GREETING_RETRY_MS))
    expect(result.current.phase).toBe('quiet')
    act(() => void vi.advanceTimersByTime(FIRST_RUN_GREETING_RETRY_MS * 5))
    expect(resend).toHaveBeenCalledOnce()

    act(() => result.current.tryAgain())
    expect(result.current.phase).toBe('retrying')
    expect(resend).toHaveBeenCalledTimes(2)
  })

  it('does not count while no request is out, and goes quiet without a resend route', () => {
    vi.useFakeTimers()
    const idle = renderHook(() => useFirstRunGreetingPhase({ waiting: false }))

    act(() => void vi.advanceTimersByTime(FIRST_RUN_GREETING_RETRY_MS * 3))
    expect(idle.result.current.phase).toBe('pending')

    const noRoute = renderHook(() => useFirstRunGreetingPhase({ waiting: true }))

    act(() => void vi.advanceTimersByTime(FIRST_RUN_GREETING_RETRY_MS))
    expect(noRoute.result.current.phase).toBe('quiet')
  })

  it('holds other first-chat notices while the welcome is pending or the list has open rows', () => {
    expect(firstRunHoldsNotices({ firstRunHere: true, listOpen: false })).toBe(true)
    expect(firstRunHoldsNotices({ firstRunHere: false, listOpen: true })).toBe(true)
    expect(firstRunHoldsNotices({ firstRunHere: false, listOpen: false })).toBe(false)
  })
})
