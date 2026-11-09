import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { I18nProvider } from '@/i18n'
import { holdAppViewOverlay, resetAppViewOverlayForTests } from '@/store/app-view-overlay'

import { AtumPdfPane, VIEWER_START_TIMEOUT_MS } from './pdf-pane'

const show = vi.fn(async () => ({ shown: true }))
const hide = vi.fn(async () => undefined)
const close = vi.fn(async () => undefined)
const openNative = vi.fn(async () => ({ ok: true }))
const PANE_RECT = { height: 709, width: 549, x: 909, y: 60 }

function renderPane(props: { sourcePath?: string; token?: string } = {}) {
  return render(
    <I18nProvider configClient={null} initialLocale="vi">
      <AtumPdfPane sourcePath={props.sourcePath} title="q3.pdf" token={props.token ?? 'tok-1'} />
    </I18nProvider>
  )
}

// Placement is coalesced per animation frame; settle one frame of work.
async function flushFrame() {
  await act(async () => {
    await new Promise<void>(resolve => {
      window.requestAnimationFrame(() => resolve())
    })
    await Promise.resolve()
  })
}

beforeEach(() => {
  resetAppViewOverlayForTests()
  show.mockClear()
  hide.mockClear()
  close.mockClear()
  openNative.mockClear()
  show.mockResolvedValue({ shown: true })
  Object.assign(window, { hermesDesktop: { atumPdfView: { close, hide, show }, consumerFiles: { openNative } } })
  // jsdom has no ResizeObserver, and the pane must not depend on one to place.
  Object.assign(window, {
    ResizeObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
    }
  })
  stubRect(PANE_RECT)
})

/** Point the shared prototype stub at one rectangle for the next measurement. */
function stubRect({ height, width, x, y }: { height: number; width: number; x: number; y: number }) {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ bottom: y + height, height, left: x, right: x + width, top: y, width, x, y })
  })
}

afterEach(() => {
  cleanup()
  // Restore the shared prototype: leaving it patched would follow other suites.
  Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect')
  Reflect.deleteProperty(window, 'ResizeObserver')
})

describe('AtumPdfPane', () => {
  it('asks main to place the viewer over its own box, and takes it away on unmount', async () => {
    const view = renderPane()
    await flushFrame()

    expect(screen.getByRole('document', { name: 'Trình xem PDF: q3.pdf' })).toBeTruthy()
    expect(show).toHaveBeenCalledWith('tok-1', { height: 709, width: 549, x: 909, y: 60 })
    expect(screen.queryByTestId('atum-pdf-pane-error')).toBeNull()

    view.unmount()
    expect(close).toHaveBeenCalledWith('tok-1')
  })

  it('never hosts the viewer itself, because a guest cannot render a PDF', () => {
    renderPane()

    expect(globalThis.document.querySelector('webview')).toBeNull()
  })

  it('reports a viewer that never appears, instead of leaving the pane blank', async () => {
    show.mockResolvedValue({ shown: false })
    vi.useFakeTimers()

    try {
      renderPane({ sourcePath: '/home/example/Documents/q3.pdf' })
      expect(screen.queryByTestId('atum-pdf-pane-error')).toBeNull()
      await act(async () => {
        vi.advanceTimersByTime(VIEWER_START_TIMEOUT_MS + 100)
        await Promise.resolve()
      })
      expect(screen.getByTestId('atum-pdf-pane-error').textContent).toContain('Không hiển thị được tệp PDF này.')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays quiet once main confirms the viewer is shown', async () => {
    vi.useFakeTimers()

    try {
      renderPane()
      // Let the placement frame run and main's confirmation land first.
      await act(async () => {
        vi.advanceTimersByTime(20)
        await Promise.resolve()
        await Promise.resolve()
      })
      await act(async () => {
        vi.advanceTimersByTime(VIEWER_START_TIMEOUT_MS + 100)
      })
      expect(screen.queryByTestId('atum-pdf-pane-error')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears a prior timeout failure when a late placement eventually succeeds', async () => {
    let resolveShow: ((value: { shown: boolean }) => void) | null = null
    show.mockImplementationOnce(() => new Promise<{ shown: boolean }>(resolve => { resolveShow = resolve }))
    vi.useFakeTimers()

    try {
      renderPane()
      await act(async () => {
        vi.advanceTimersByTime(VIEWER_START_TIMEOUT_MS + 100)
        await Promise.resolve()
      })
      expect(screen.getByTestId('atum-pdf-pane-error')).toBeTruthy()

      await act(async () => {
        resolveShow?.({ shown: true })
        await Promise.resolve()
      })
      expect(screen.queryByTestId('atum-pdf-pane-error')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('steps aside for an overlay and comes back when it closes', async () => {
    renderPane()
    await flushFrame()
    expect(show).toHaveBeenCalledTimes(1)

    let release: (() => void) | null = null
    await act(async () => {
      release = holdAppViewOverlay()
    })
    await flushFrame()
    expect(hide).toHaveBeenCalledWith('tok-1')
    expect(show).toHaveBeenCalledTimes(1)

    await act(async () => {
      release?.()
    })
    await flushFrame()
    expect(show).toHaveBeenCalledTimes(2)
  })

  // #REGRESSION: every tip in the window used to take the overlay token, so
  // hovering any button anywhere — the roster, the titlebar, the composer —
  // detached the viewer and the document blinked out until the pointer moved
  // off again. A tip only steps aside for the rectangle it actually covers.
  //
  // Opened declaratively: Radix's hover/focus paths need real pointer
  // emulation jsdom does not provide, and what is under test is what an OPEN
  // tip does to the view, not how it came to be open.
  function renderOpenTip(rect: { height: number; width: number; x: number; y: number }) {
    // Keep the document's rectangle stable while measuring the portaled tip. The old global
    // one-rectangle stub also moved the PDF pane under the tip; a concurrent resize/settle event
    // could then manufacture an overlap and make this test fail only in the full CI suite.
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: HTMLElement) {
        const measured = this.getAttribute('role') === 'document' ? PANE_RECT : rect

        return {
          ...measured,
          bottom: measured.y + measured.height,
          left: measured.x,
          right: measured.x + measured.width,
          top: measured.y
        }
      }
    })

    return render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>trigger</TooltipTrigger>
          <TooltipContent>label</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  it('keeps the document painted while a tip elsewhere in the window is open', async () => {
    renderPane()
    await flushFrame()
    expect(show).toHaveBeenCalledTimes(1)

    // The pane sits at x 909–1458; this tip is measured well to its left.
    let tip!: ReturnType<typeof renderOpenTip>
    await act(async () => { tip = renderOpenTip({ height: 20, width: 90, x: 40, y: 300 }) })
    await flushFrame()

    // Radix renders the chip plus a visually-hidden a11y mirror.
    expect(screen.getAllByText('label').length).toBeGreaterThan(0)
    expect(hide).not.toHaveBeenCalled()
    tip.unmount()
  })

  it('still steps aside for a tip that reaches over the document', async () => {
    renderPane()
    await flushFrame()
    expect(show).toHaveBeenCalledTimes(1)

    // Measured inside the pane's own rectangle: this one really would paint
    // under the native view, so the view has to come down.
    let tip!: ReturnType<typeof renderOpenTip>
    await act(async () => { tip = renderOpenTip({ height: 20, width: 90, x: 1000, y: 300 }) })
    await flushFrame()

    expect(hide).toHaveBeenCalledWith('tok-1')
    tip.unmount()
  })

  it('does not reattach underneath an overlapping tip when its own detach completes', async () => {
    let paneX = 909
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value() {
        const rect = this.getAttribute('role') === 'document'
          ? { height: 709, width: 549, x: paneX, y: 60 }
          : { height: 20, width: 90, x: 1000, y: 300 }

        return { ...rect, bottom: rect.y + rect.height, left: rect.x, right: rect.x + rect.width, top: rect.y }
      }
    })
    renderPane()
    await flushFrame()

    const tip = render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>trigger</TooltipTrigger>
          <TooltipContent>label</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )

    for (let frame = 0; frame < 4; frame++) {
      await flushFrame()
    }

    expect(hide).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    paneX = 920
    await act(async () => { window.dispatchEvent(new Event('resize')) })
    await flushFrame()
    await flushFrame()
    expect(show).toHaveBeenCalledTimes(1)
    tip.unmount()
    await flushFrame()
    expect(show).toHaveBeenCalledTimes(2)
  })

  it('sends one placement per geometry, not one per event', async () => {
    renderPane()
    await flushFrame()
    expect(show).toHaveBeenCalledTimes(1)

    await act(async () => {
      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('resize'))
      document.dispatchEvent(new Event('scroll'))
    })
    await flushFrame()
    await flushFrame()
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('hides for an overlay without closing, and closes exactly once on unmount', async () => {
    const view = renderPane()
    await flushFrame()
    expect(show).toHaveBeenCalledTimes(1)

    let release: (() => void) | null = null
    await act(async () => {
      release = holdAppViewOverlay()
    })
    await flushFrame()
    expect(hide).toHaveBeenCalledWith('tok-1')
    expect(close).not.toHaveBeenCalled()

    await act(async () => {
      release?.()
    })
    await flushFrame()
    // The same document comes back where it was: placed again, never reloaded.
    expect(show).toHaveBeenCalledTimes(2)
    expect(close).not.toHaveBeenCalled()

    view.unmount()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('forgets the rectangle when the call fails, so the next frame retries', async () => {
    show.mockRejectedValueOnce(new Error('ipc down'))
    renderPane()
    await flushFrame()
    expect(show).toHaveBeenCalledTimes(1)

    // Same geometry, but the last request never landed: try again.
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    await flushFrame()
    expect(show).toHaveBeenCalledTimes(2)
  })

  it('says so when the desktop bridge cannot host a viewer at all', () => {
    Object.assign(window, { hermesDesktop: {} })
    renderPane()

    expect(screen.getByTestId('atum-pdf-pane-error').textContent).toContain('viewer unavailable')
  })
})
