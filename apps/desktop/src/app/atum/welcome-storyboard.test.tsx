import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AtumWelcomeStoryboard, calculateAtumWelcomeTransit } from './welcome-storyboard'

beforeEach(() => {
  vi.useFakeTimers()
  window.localStorage.removeItem('hermes.desktop.atum.welcomeSeen')
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('AtumWelcomeStoryboard', () => {
  it('shows the specified cast and persists the once-per-install flag after the handoff', () => {
    const complete = vi.fn()
    render(<AtumWelcomeStoryboard onComplete={complete} />)

    expect(screen.getByText('The AI superapp for Vietnam.')).toBeTruthy()
    expect(screen.getAllByRole('img').map(image => image.getAttribute('alt'))).toEqual(['Moon', 'Andy', 'Taylor', 'Ben'])

    act(() => vi.advanceTimersByTime(5200))
    act(() => vi.advanceTimersByTime(400))
    expect(complete).toHaveBeenCalledOnce()
    expect(window.localStorage.getItem('hermes.desktop.atum.welcomeSeen')).toBe('true')
  })

  it('lets any key skip through the required 400ms fade', () => {
    const complete = vi.fn()
    render(<AtumWelcomeStoryboard onComplete={complete} />)

    fireEvent.keyDown(window, { key: 'a' })
    expect(screen.getByRole('main').getAttribute('data-handoff')).toBe('true')
    act(() => vi.advanceTimersByTime(399))
    expect(complete).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(complete).toHaveBeenCalledOnce()
  })

  it('lets a click skip through the same composed final-frame fade', () => {
    const complete = vi.fn()
    render(<AtumWelcomeStoryboard onComplete={complete} />)

    fireEvent.click(window)
    expect(screen.getByRole('main').getAttribute('data-handoff')).toBe('true')
    act(() => vi.advanceTimersByTime(399))
    expect(complete).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(complete).toHaveBeenCalledOnce()
  })

  it('does not reset the mount-once completion timer when its parent rerenders', () => {
    const first = vi.fn()
    const latest = vi.fn()
    const view = render(<AtumWelcomeStoryboard onComplete={first} />)

    act(() => vi.advanceTimersByTime(3000))
    view.rerender(<AtumWelcomeStoryboard onComplete={latest} />)
    act(() => vi.advanceTimersByTime(2200))

    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledOnce()
  })

  it('skips directly to the composed final frame under reduced motion', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ addEventListener: vi.fn(), matches: true, removeEventListener: vi.fn() }))
    })
    const complete = vi.fn()
    render(<AtumWelcomeStoryboard onComplete={complete} />)

    expect(screen.getByRole('main').getAttribute('data-reduced')).toBe('true')
    act(() => vi.advanceTimersByTime(399))
    expect(complete).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(complete).toHaveBeenCalledOnce()
  })

  it('computes one-element mark transit between measured rect centres and sizes', () => {
    const mark = new DOMRect(500, 300, 56, 56)
    const target = new DOMRect(92, 118, 36, 36)

    expect(calculateAtumWelcomeTransit(mark, target)).toEqual({
      x: -418,
      y: -192,
      scale: 36 / 56
    })
  })
})
