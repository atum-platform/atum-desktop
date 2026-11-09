import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $appViewOverlayCount, resetAppViewOverlayForTests, setAppViewRect } from '@/store/app-view-overlay'

import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './context-menu'
import { Dialog, DialogContent, DialogTitle } from './dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from './dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Select, SelectContent, SelectItem, SelectTrigger } from './select'
import { Sheet, SheetContent, SheetTitle } from './sheet'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'

/**
 * A native app view is a `WebContentsView` that paints above every DOM node,
 * so any renderer surface that could cover it holds a token while it is open
 * and main detaches the view for that moment. The token must be held only
 * while the surface is actually open.
 *
 * These primitives put the portal *inside* the content wrapper, so the
 * wrapper component mounts as soon as a tree merely declares the surface —
 * every tooltip and menu in the tree, all the time. A hold taken there is
 * never released, which detached every app view for good: the tab body went
 * blank, because main paints the app's content and the renderer draws
 * nothing in its place.
 */

const tooltipTree = (open: boolean) => (
  <TooltipProvider>
    <Tooltip open={open}>
      <TooltipTrigger>hover</TooltipTrigger>
      <TooltipContent>tip</TooltipContent>
    </Tooltip>
  </TooltipProvider>
)

const surfaces: Array<[string, (open: boolean) => React.ReactElement]> = [
  ['tooltip', tooltipTree],
  ['popover', open => (
    <Popover open={open}>
      <PopoverTrigger>open</PopoverTrigger>
      <PopoverContent>body</PopoverContent>
    </Popover>
  )],
  ['dropdown menu', open => (
    <DropdownMenu open={open}>
      <DropdownMenuTrigger>open</DropdownMenuTrigger>
      <DropdownMenuContent><DropdownMenuItem>one</DropdownMenuItem></DropdownMenuContent>
    </DropdownMenu>
  )],
  ['select', open => (
    <Select open={open}>
      <SelectTrigger>pick</SelectTrigger>
      <SelectContent><SelectItem value="one">one</SelectItem></SelectContent>
    </Select>
  )],
  ['dialog', open => (
    <Dialog open={open}>
      <DialogContent><DialogTitle>title</DialogTitle></DialogContent>
    </Dialog>
  )],
  ['sheet', open => (
    <Sheet open={open}>
      <SheetContent><SheetTitle>title</SheetTitle></SheetContent>
    </Sheet>
  )]
]

// Radix's popper measures its content; jsdom ships no ResizeObserver.
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

describe('the app-view detach token', () => {
  it.each(surfaces)('is not held by a closed %s', (_name, tree) => {
    render(tree(false))
    expect($appViewOverlayCount.get()).toBe(0)
  })

  it.each(surfaces.filter(([name]) => name !== 'tooltip'))('is held by an open %s', (_name, tree) => {
    render(tree(true))
    expect($appViewOverlayCount.get()).toBeGreaterThan(0)
  })

  /**
   * A tooltip is the one surface small enough for the question to be worth
   * asking. It takes the SAME token, but only for a view it actually covers:
   * holding for every tip meant hovering any button in the window detached
   * every app view, and the PDF viewer blinked out on each pass of the pointer.
   */
  describe('an open tooltip', () => {
    function stubChipRect(rect: { height: number; width: number; x: number; y: number }) {
      Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ ...rect, bottom: rect.y + rect.height, left: rect.x, right: rect.x + rect.width, top: rect.y })
      })
    }

    afterEach(() => {
      Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect')
    })

    it('holds the token when it lands on a native view', () => {
      setAppViewRect('view-1', { height: 600, width: 500, x: 900, y: 60 })
      stubChipRect({ height: 20, width: 90, x: 1000, y: 300 })
      render(tooltipTree(true))
      expect($appViewOverlayCount.get()).toBeGreaterThan(0)
    })

    it('leaves the token alone when it lands clear of every native view', () => {
      setAppViewRect('view-1', { height: 600, width: 500, x: 900, y: 60 })
      stubChipRect({ height: 20, width: 90, x: 40, y: 300 })
      render(tooltipTree(true))
      expect($appViewOverlayCount.get()).toBe(0)
    })

    it('leaves the token alone when no native view is painted at all', () => {
      stubChipRect({ height: 20, width: 90, x: 1000, y: 300 })
      render(tooltipTree(true))
      expect($appViewOverlayCount.get()).toBe(0)
    })

    // A tip is short-lived but not instantaneous, and a native view moves on
    // scroll, resize, transition and a settle tick. A decision taken once on
    // mount goes stale under the open tip — in both directions.
    it('takes the token when a view moves underneath it while it is open', () => {
      stubChipRect({ height: 20, width: 90, x: 1000, y: 300 })
      render(tooltipTree(true))
      expect($appViewOverlayCount.get()).toBe(0)

      act(() => setAppViewRect('view-1', { height: 600, width: 500, x: 900, y: 60 }))
      expect($appViewOverlayCount.get()).toBeGreaterThan(0)
    })

    it('releases the token when the view moves out from under it', () => {
      setAppViewRect('view-1', { height: 600, width: 500, x: 900, y: 60 })
      stubChipRect({ height: 20, width: 90, x: 1000, y: 300 })
      render(tooltipTree(true))
      expect($appViewOverlayCount.get()).toBeGreaterThan(0)

      act(() => setAppViewRect('view-1', { height: 600, width: 500, x: 0, y: 0 }))
      expect($appViewOverlayCount.get()).toBe(0)
    })

    it('releases the token when the view it was covering is torn down', () => {
      setAppViewRect('view-1', { height: 600, width: 500, x: 900, y: 60 })
      stubChipRect({ height: 20, width: 90, x: 1000, y: 300 })
      render(tooltipTree(true))
      expect($appViewOverlayCount.get()).toBeGreaterThan(0)

      act(() => setAppViewRect('view-1', null))
      expect($appViewOverlayCount.get()).toBe(0)
    })

    it('does not churn the token when a view republishes the same rectangle', () => {
      const rect = { height: 600, width: 500, x: 900, y: 60 }
      setAppViewRect('view-1', rect)
      stubChipRect({ height: 20, width: 90, x: 1000, y: 300 })
      render(tooltipTree(true))
      const held = $appViewOverlayCount.get()

      act(() => setAppViewRect('view-1', { ...rect }))
      expect($appViewOverlayCount.get()).toBe(held)
    })
  })

  // A context menu has no controlled open state: only the closed half of the
  // claim can be made here, and it is the half that regressed.
  it('is not held by a context menu that has never been opened', () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>target</ContextMenuTrigger>
        <ContextMenuContent><ContextMenuItem>one</ContextMenuItem></ContextMenuContent>
      </ContextMenu>
    )
    expect($appViewOverlayCount.get()).toBe(0)
  })
})

describe('surfaces the closed/open pair cannot reach', () => {
  it('is held by a context menu once it is opened', () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>target</ContextMenuTrigger>
        <ContextMenuContent><ContextMenuItem>one</ContextMenuItem></ContextMenuContent>
      </ContextMenu>
    )

    fireEvent.contextMenu(screen.getByText('target'))
    expect($appViewOverlayCount.get()).toBeGreaterThan(0)
  })

  it('is held once per open surface, submenu included', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>more</DropdownMenuSubTrigger>
            <DropdownMenuSubContent><DropdownMenuItem>deep</DropdownMenuItem></DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    )

    expect($appViewOverlayCount.get()).toBe(2)
  })

  /**
   * Radix keeps a closing select's content mounted for its exit animation, and
   * `open` is already false by then. Handing the window straight back would
   * let the native view paint over the fade.
   */
  it('keeps holding while a select plays its exit animation', () => {
    vi.useFakeTimers()

    try {
      const view = render(
        <Select open>
          <SelectTrigger>pick</SelectTrigger>
          <SelectContent><SelectItem value="one">one</SelectItem></SelectContent>
        </Select>
      )

      expect($appViewOverlayCount.get()).toBe(1)

      view.rerender(
        <Select open={false}>
          <SelectTrigger>pick</SelectTrigger>
          <SelectContent><SelectItem value="one">one</SelectItem></SelectContent>
        </Select>
      )

      expect($appViewOverlayCount.get()).toBe(1)
      act(() => { vi.advanceTimersByTime(199) })
      expect($appViewOverlayCount.get()).toBe(1)
      act(() => { vi.advanceTimersByTime(1) })
      expect($appViewOverlayCount.get()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
