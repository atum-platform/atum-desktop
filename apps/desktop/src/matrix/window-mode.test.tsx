import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useMatrixWindowMode } from './window-mode'

interface Facts {
  settled: boolean
  identity: string | null
}

let setWindowMode: ReturnType<typeof vi.fn>

function Probe(facts: Facts) {
  useMatrixWindowMode(facts)

  return null
}

/** The window as MatrixApp drives it, one snapshot at a time. */
function windowFor(initial: Facts) {
  let current = initial
  const view = render(<Probe {...current} />)

  return {
    next(change: Partial<Facts>) {
      current = { ...current, ...change }
      view.rerender(<Probe {...current} />)
    },
    /** Every mode asked of main, in order. */
    asked: () => setWindowMode.mock.calls.map(([mode]) => mode)
  }
}

beforeEach(() => {
  setWindowMode = vi.fn(async () => {})
  Object.defineProperty(window, 'atumMatrix', { configurable: true, value: { setWindowMode } })
})
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('the window an account is in', () => {
  it('asks nothing before main’s first snapshot, then the compact window to sign in', () => {
    const win = windowFor({ settled: false, identity: null })
    expect(win.asked()).toEqual([])

    win.next({ settled: true })
    expect(win.asked()).toEqual(['auth'])
  })

  it('opens the product window the moment a sign-in lands, for the launch and the app', () => {
    const win = windowFor({ settled: true, identity: null })

    // The browser trip comes back signed in: the launch is drawn at product size.
    win.next({ identity: '@owner:test' })
    expect(win.asked()).toEqual(['auth', 'normal'])

    // Snapshots of the same account (launch steps, the app) never ask again.
    win.next({ identity: '@owner:test' })
    expect(win.asked()).toEqual(['auth', 'normal'])
  })

  it('opens a restored signed-in window at product size, and never compact first', () => {
    const win = windowFor({ settled: false, identity: '@owner:test' })
    expect(win.asked()).toEqual([])

    win.next({ settled: true })
    expect(win.asked()).toEqual(['normal'])
  })

  it('goes back to the compact window on sign-out, and to the product window for the next account', () => {
    const win = windowFor({ settled: true, identity: '@owner:test' })
    win.next({ identity: null })
    expect(win.asked()).toEqual(['normal', 'auth'])

    win.next({ identity: '@other:test' })
    expect(win.asked()).toEqual(['normal', 'auth', 'normal'])
  })
})
