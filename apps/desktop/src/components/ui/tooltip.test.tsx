import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $appViewOverlayCount, resetAppViewOverlayForTests, setAppViewRect } from '@/store/app-view-overlay'

import { suppressNonKeyboardFocusOpen, Tip, TipNative } from './tooltip'

// Radix opens tooltips on ANY trigger focus; menus/dialogs restore focus to
// their trigger on close, which left tips stuck open after a mouse pick (e.g.
// the composer model pill). The trigger's focus handler must preventDefault —
// which Radix's composed handler honors — for non-keyboard focus only.

const focusEvent = (matchesImpl: (selector: string) => boolean) => {
  const preventDefault = vi.fn()

  return {
    event: {
      currentTarget: { matches: matchesImpl } as unknown as HTMLElement,
      preventDefault
    } as unknown as React.FocusEvent<HTMLElement>,
    preventDefault
  }
}

describe('suppressNonKeyboardFocusOpen', () => {
  it('suppresses the focus-open when focus is not keyboard-visible (menu close restore)', () => {
    const { event, preventDefault } = focusEvent(selector => selector !== ':focus-visible')

    suppressNonKeyboardFocusOpen(event)

    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('keeps the focus-open for keyboard (Tab) focus — a11y path', () => {
    const { event, preventDefault } = focusEvent(selector => selector === ':focus-visible')

    suppressNonKeyboardFocusOpen(event)

    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('fails open when :focus-visible is unsupported', () => {
    const { event, preventDefault } = focusEvent(() => {
      throw new Error('unsupported selector')
    })

    suppressNonKeyboardFocusOpen(event)

    expect(preventDefault).not.toHaveBeenCalled()
  })
})

// Beside a native view (the Work view) a DOM tip paints underneath it; the rail's tips there are
// the system tooltip instead, which floats above every view (owner 2026-11-28).
describe('TipNative', () => {
  class NoopResizeObserver {
    disconnect(): void {}
    observe(): void {}
    unobserve(): void {}
  }

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver)
    resetAppViewOverlayForTests()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('draws the Kit chip on hover and sets no system tooltip by default', async () => {
    render(
      <Tip label="Up to date">
        <button type="button">update</button>
      </Tip>
    )
    const trigger = screen.getByRole('button', { name: 'update' })

    expect(trigger.getAttribute('title')).toBeNull()
    fireEvent.pointerMove(trigger)
    expect(await screen.findByRole('tooltip')).toBeTruthy()
  })

  it('hands a text label to the system tooltip and never opens a DOM chip or holds a native view', () => {
    // A native view where the tip would land: a DOM chip there would have to detach it.
    setAppViewRect('work', { height: 2000, width: 2000, x: 0, y: 0 })
    render(
      <TipNative native>
        <Tip label="Up to date">
          <button type="button">update</button>
        </Tip>
      </TipNative>
    )
    const trigger = screen.getByRole('button', { name: 'update' })

    expect(trigger.getAttribute('title')).toBe('Up to date')
    fireEvent.pointerMove(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect($appViewOverlayCount.get()).toBe(0)
  })

  it('keeps the Kit chip for a rich label, which a system tooltip cannot draw', async () => {
    render(
      <TipNative native>
        <Tip label={<span>Rich</span>}>
          <button type="button">rich</button>
        </Tip>
      </TipNative>
    )
    const trigger = screen.getByRole('button', { name: 'rich' })

    expect(trigger.getAttribute('title')).toBeNull()
    fireEvent.pointerMove(trigger)
    expect(await screen.findByRole('tooltip')).toBeTruthy()
  })
})
