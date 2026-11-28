import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  $firstRunAsk,
  claimFirstRunAutoPass,
  FIRST_RUN_GREETING_RETRY_MS,
  firstRunAskOpen,
  type FirstRunAskRunner,
  firstRunChoose,
  firstRunHoldsNotices,
  firstRunNextStep,
  firstRunNotNow,
  firstRunStage,
  type FirstRunSureStep,
  registerFirstRunAskRunner,
  resetFirstRunAskForTests,
  runFirstRunGoogle,
  runFirstRunSure,
  useFirstRunGreetingPhase
} from './first-run-controller'

afterEach(() => {
  vi.useRealTimers()
  resetFirstRunAskForTests()
})

/** A runner whose steps record their order and the progress line's step/next at the time each one ran. */
function runner(pending: FirstRunSureStep[], fail: FirstRunSureStep[] = []) {
  const open = new Set(pending)
  const seen: string[] = []

  const value: FirstRunAskRunner & { seen: string[] } = {
    seen,
    pending: () => [...open],
    run: vi.fn(async (step: FirstRunSureStep) => {
      const { next, step: now } = $firstRunAsk.get()
      seen.push(`${now}>${next ?? '-'}`)
      open.delete(step)

      if (fail.includes(step)) {
        throw new Error('denied')
      }
    }),
    admitLearning: vi.fn(async () => {}),
    notNow: vi.fn(async () => {})
  }

  return value
}

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

describe('the conversational ask', () => {
  it('Sure runs the pending steps one after another in order, with what comes next, then offers Google as one tap', async () => {
    const steps = runner(['google', 'mac-reach', 'folders'])
    registerFirstRunAskRunner(steps)

    await runFirstRunSure()

    // Messages had nothing to ask: skipped. Each line names the step after it, Google last.
    expect(steps.seen).toEqual(['folders>mac-reach', 'mac-reach>google'])
    expect(steps.admitLearning).toHaveBeenCalledOnce()
    expect($firstRunAsk.get()).toMatchObject({ phase: 'google', ran: ['folders', 'mac-reach'] })
    expect($firstRunAsk.get().step).toBeUndefined()

    await runFirstRunGoogle()
    expect(steps.run).toHaveBeenLastCalledWith('google')
    expect($firstRunAsk.get().phase).toBe('done')
  })

  it('a denied step settles quietly and the next one still runs; with no Google left it ends done', async () => {
    const steps = runner(['folders', 'messages'], ['folders'])
    registerFirstRunAskRunner(steps)

    await runFirstRunSure()

    expect(steps.seen).toEqual(['folders>messages', 'messages>-'])
    expect($firstRunAsk.get().phase).toBe('done')
  })

  it('keeps running while the list moves (the welcome card closing), and settles if it never comes back', async () => {
    vi.useFakeTimers()
    const first = runner(['folders', 'messages'])
    const unregister = registerFirstRunAskRunner(first)
    first.run = vi.fn(async () => {
      // The first connected source closes the welcome: this list unmounts and the chat's list takes over.
      unregister()
    })

    const second = runner(['messages'])
    const done = runFirstRunSure(1_000)

    await vi.advanceTimersByTimeAsync(0)
    expect(first.run).toHaveBeenCalledWith('folders')
    registerFirstRunAskRunner(second)
    await done

    expect(second.run).toHaveBeenCalledExactlyOnceWith('messages')
    expect($firstRunAsk.get().phase).toBe('done')
  })

  it('Sure and Not now answer once; Not now hands the rest to the list', async () => {
    const steps = runner(['folders'])
    registerFirstRunAskRunner(steps)

    await firstRunNotNow()
    expect(steps.notNow).toHaveBeenCalledOnce()
    expect($firstRunAsk.get().phase).toBe('later')

    await runFirstRunSure()
    expect(steps.run).not.toHaveBeenCalled()
    await firstRunNotNow()
    expect(steps.notNow).toHaveBeenCalledOnce()
  })

  it('Not now at the Google tap just ends the ask', async () => {
    const steps = runner(['google'])
    registerFirstRunAskRunner(steps)

    await runFirstRunSure()
    expect($firstRunAsk.get().phase).toBe('google')
    await firstRunNotNow()

    expect($firstRunAsk.get().phase).toBe('done')
    expect(steps.notNow).not.toHaveBeenCalled()
    expect(steps.run).not.toHaveBeenCalledWith('google')
  })

  it('holds other notices until the ask is answered, unless the list was opened instead', () => {
    expect(firstRunAskOpen($firstRunAsk.get())).toBe(true)

    for (const phase of ['running', 'google'] as const) {
      expect(firstRunAskOpen({ ...$firstRunAsk.get(), phase })).toBe(true)
    }

    for (const phase of ['done', 'later'] as const) {
      expect(firstRunAskOpen({ ...$firstRunAsk.get(), phase })).toBe(false)
    }

    firstRunChoose()
    expect(firstRunAskOpen($firstRunAsk.get())).toBe(false)
  })

  it('names the next pending step, Google last', () => {
    expect(firstRunNextStep(0, ['folders', 'messages', 'google'])).toBe('messages')
    expect(firstRunNextStep(1, ['messages', 'google'])).toBe('google')
    expect(firstRunNextStep(2, ['mac-reach'])).toBeUndefined()
  })

  it('runs the automatic pass once per window', () => {
    expect(claimFirstRunAutoPass()).toBe(true)
    expect(claimFirstRunAutoPass()).toBe(false)
  })
})
