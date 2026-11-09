import { useStore } from '@nanostores/react'
import { type RefObject, useLayoutEffect } from 'react'

import { $appViewRectRevision, holdAppViewOverlay, overlapsAppView } from './app-view-overlay'

/**
 * Hold the app-view overlay token for as long as the calling overlay content
 * is mounted. Radix keeps portaled content mounted through its closing
 * animation, so mounting this inside the content or overlay element covers
 * the whole time the surface can paint over the workspace.
 */
export function useAppViewOverlayHold(): void {
  // A layout effect runs before the browser paints the overlay, so the
  // native view is asked to detach before the surface can be covered.
  useLayoutEffect(() => holdAppViewOverlay(), [])
}

/**
 * Hold only if this surface lands on an eligible native view's geometry,
 * including while our own hold temporarily detaches that view.
 *
 * For surfaces that cover the window there is nothing to decide — they always
 * overlap, and `useAppViewOverlayHold` is the right hook. This one is for the
 * small, pointer-driven surfaces: a tooltip is anchored to a DOM trigger, and
 * a trigger is by definition outside the rectangle a native view owns, so the
 * overwhelmingly common case is a tip that overlaps nothing. Detaching the
 * view for those made every hover anywhere in the window blank the document.
 *
 * Measured in the same layout effect that would do the holding, before paint,
 * so a tip that DOES reach over a view still detaches it in time — and
 * RE-measured whenever the views move, because a once-on-mount answer goes
 * stale under an open surface. A view can attach, scroll, resize, or be torn
 * down while a tip is up; without this the tip would either sit underneath it
 * or keep every native view detached long after the view moved away.
 */
export function useAppViewOverlayHoldWhenOverlapping(ref: RefObject<HTMLElement | null>): void {
  // Edge-triggered: publishers only report a genuinely changed rectangle, so
  // this re-runs when the geometry moves, not on every scroll or settle tick.
  const revision = useStore($appViewRectRevision)

  useLayoutEffect(() => {
    const node = ref.current

    if (!node) {
      // Nothing to measure: fall back to the safe answer rather than assuming
      // this surface is harmless.
      return holdAppViewOverlay()
    }

    const { height, width, x, y } = node.getBoundingClientRect()

    return overlapsAppView({ height, width, x, y }) ? holdAppViewOverlay() : undefined
  }, [ref, revision])
}

/** Mount inside any bespoke portal or fixed overlay that has no shared content component. */
export function AppViewOverlayHold(): null {
  useAppViewOverlayHold()

  return null
}
