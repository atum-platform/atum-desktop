import { AssistantRuntimeProvider, type ThreadMessageLike, useExternalStoreRuntime } from '@assistant-ui/react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AtumChatTranscript } from '@/app/atum/chat-transcript'
import { ThreadScrollToBottomButton } from '@/components/assistant-ui/thread/scroll-to-bottom'
import { setThreadAtBottom } from '@/store/thread-scroll'

import { COMPOSER_DOCK_HEIGHT_VAR, ComposerDock } from './composer-dock'

type Observer = { callback: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn> }

let observers: Observer[] = []

/** Deliver a measured block size to every observer, as the browser does when the composer grows. */
function resize(height: number) {
  act(() => {
    for (const { callback } of observers) {
      callback([{ borderBoxSize: [{ blockSize: height, inlineSize: 600 }] } as unknown as ResizeObserverEntry], {} as ResizeObserver)
    }
  })
}

beforeEach(() => {
  observers = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      disconnect = vi.fn()
      observe = vi.fn()
      unobserve = vi.fn()

      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, disconnect: this.disconnect })
      }
    }
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setThreadAtBottom(true)
})

describe('ComposerDock', () => {
  it('publishes its live height on the column, following the composer as it grows and shrinks', () => {
    const { container } = render(
      <div data-testid="column">
        <ComposerDock>
          <textarea />
        </ComposerDock>
      </div>
    )

    const column = container.querySelector<HTMLElement>('[data-testid="column"]')!

    resize(94)
    expect(column.style.getPropertyValue(COMPOSER_DOCK_HEIGHT_VAR)).toBe('94px')

    // A multi-line draft makes the composer taller; the next measurement replaces the last.
    resize(161.4)
    expect(column.style.getPropertyValue(COMPOSER_DOCK_HEIGHT_VAR)).toBe('162px')

    resize(94)
    expect(column.style.getPropertyValue(COMPOSER_DOCK_HEIGHT_VAR)).toBe('94px')
  })

  it('stops observing and clears the height when the chat goes away', () => {
    const { container, unmount } = render(
      <div data-testid="column">
        <ComposerDock />
      </div>
    )

    const column = container.querySelector<HTMLElement>('[data-testid="column"]')!
    resize(120)
    unmount()

    expect(observers.every(observer => observer.disconnect.mock.calls.length > 0)).toBe(true)
    expect(column.style.getPropertyValue(COMPOSER_DOCK_HEIGHT_VAR)).toBe('')
  })

  it('is a transparent overlay: pinned to the foot, no fill, no strip, pointers pass through', () => {
    const { container } = render(
      <div>
        <ComposerDock />
      </div>
    )

    const dock = container.querySelector<HTMLElement>('[data-matrix-composer-dock]')!
    const classes = dock.className.split(/\s+/)

    expect(classes).toEqual(expect.arrayContaining(['absolute', 'bottom-0', 'inset-x-0', 'pointer-events-none']))
    // Nothing opaque or translucent painted behind the composer: no background, border or blur of its own.
    expect(classes.filter(name => /^(bg-|border|backdrop|shadow|ring|from-|via-|to-)/.test(name))).toEqual([])
  })
})

describe('the dock scroll edge and the companion floor', () => {
  it('draws an inert scroll-edge layer beside the dock, at its height, that holds nothing and is not announced', () => {
    const { container } = render(
      <div data-testid="column">
        <ComposerDock>
          <button type="button">after</button>
        </ComposerDock>
      </div>
    )

    const column = container.querySelector<HTMLElement>('[data-testid="column"]')!
    const edge = column.querySelector<HTMLElement>('[data-matrix-dock-edge]')!
    const dock = column.querySelector<HTMLElement>('[data-matrix-composer-dock]')!

    // Siblings in the column, so the edge can sit under the companion's layer while the dock sits over it.
    expect(edge.parentElement).toBe(column)
    expect(dock.parentElement).toBe(column)
    expect(dock.contains(edge)).toBe(false)
    expect(edge.getAttribute('aria-hidden')).toBe('true')
    expect(edge.childElementCount).toBe(0)
    expect(edge.textContent).toBe('')
    expect(edge.style.height).toBe('')
    expect(dock.textContent).toBe('after')
  })
})

describe('transcript under the floating composer', () => {
  function Transcript() {
    const runtime = useExternalStoreRuntime<ThreadMessageLike>({
      convertMessage: message => message,
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      onNew: async () => {}
    })

    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <AtumChatTranscript
          clampToComposer={false}
          components={{
            AssistantMessage: () => <p>assistant</p>,
            UserMessage: () => <p>user</p>
          }}
        />
      </AssistantRuntimeProvider>
    )
  }

  it('keeps the dock height clear below the last message and runs to the column foot', () => {
    const { container } = render(
      <div data-testid="column">
        <Transcript />
      </div>
    )

    const clearance = container.querySelector<HTMLElement>('[data-slot="aui_dock-clearance"]')!
    const viewport = container.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]')!

    // The padding is the dock's live height (a CSS variable the dock keeps current), plus a little air.
    expect(clearance.style.height).toBe('calc(0.5rem + var(--atum-dock-height, 0px))')
    expect(COMPOSER_DOCK_HEIGHT_VAR).toBe('--atum-dock-height')
    // Scrolls the whole column: not clamped to a viewport that stops above the composer.
    expect(viewport.parentElement?.style.height).toBe('100%')
    expect(container.querySelector('[data-slot="aui_composer-clearance"]')).toBeNull()
  })

  it('sits the jump control just above the composer', () => {
    setThreadAtBottom(false)
    const { getByRole } = render(<ThreadScrollToBottomButton inViewport />)

    expect(getByRole('button', { name: 'Scroll to bottom' }).style.bottom).toBe(
      'calc(var(--atum-dock-height, 0px) + 0.625rem)'
    )
  })
})
