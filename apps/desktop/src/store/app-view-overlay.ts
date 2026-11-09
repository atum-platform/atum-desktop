import { atom } from 'nanostores'

/**
 * Renderer-owned surfaces that may overlap an app view (drawer scrim, modal,
 * command palette, popover). A native `WebContentsView` sits above every DOM
 * node, so while any of these is open the app view must be detached from the
 * window rather than painted under a z-index. Each overlapping surface holds
 * one token for as long as it is open.
 */
export const $appViewOverlayCount = atom(0)

export function holdAppViewOverlay(): () => void {
  $appViewOverlayCount.set($appViewOverlayCount.get() + 1)
  let released = false

  return () => {
    if (released) {return}
    released = true
    $appViewOverlayCount.set(Math.max(0, $appViewOverlayCount.get() - 1))
  }
}

/**
 * Where eligible native views belong, in viewport coordinates, keyed by the
 * same id `markAppViewAttached` uses. Temporary overlay detachment must retain
 * this geometry: clearing it makes the covering surface release its hold,
 * then the view reattaches underneath it and triggers another detach.
 * Owners clear geometry when hidden, offscreen, closed or refused by main.
 *
 * A full-screen surface (a dialog, a scrim, the command palette) always covers
 * a view and can hold unconditionally. A SMALL surface — a tooltip above all —
 * usually does not: it is anchored to a DOM trigger, and every trigger lives
 * outside the rectangle a native view owns. Holding unconditionally meant that
 * hovering ANY button anywhere in the window tore the PDF viewer off the
 * window and put it back on mouse-out, so the document blinked out of
 * existence on every pointer move across the chrome.
 *
 * This is a plain module-level map rather than an atom: it is read during the
 * layout effect that decides whether to hold, never rendered.
 */
const viewRects = new Map<string, Readonly<AppViewRect>>()

/**
 * Bumped whenever the set of rectangles actually changes. A surface whose hold
 * depends on where the views ARE has to re-decide when they move: a view can
 * attach, scroll, or resize under a tooltip that is already open, and a
 * once-on-mount answer would leave that tip painted underneath it — or leave it
 * holding for a view that has since moved away. Edge-triggered, because the
 * publishers only report a genuinely changed rectangle.
 */
export const $appViewRectRevision = atom(0)

export interface AppViewRect {
  height: number
  width: number
  x: number
  y: number
}

function sameRect(a: AppViewRect | undefined, b: AppViewRect): boolean {
  return a !== undefined && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** Publish (or, with `null`, forget) an eligible native view's placement. */
export function setAppViewRect(viewId: string, rect: AppViewRect | null): void {
  const paints = Boolean(rect && rect.width > 0 && rect.height > 0)

  if (paints && sameRect(viewRects.get(viewId), rect!)) {
    return
  }

  if (paints) {
    viewRects.set(viewId, rect!)
  } else if (!viewRects.delete(viewId)) {
    return
  }

  $appViewRectRevision.set($appViewRectRevision.get() + 1)
}

/**
 * Would `rect` overlap any eligible native view? Include views temporarily
 * detached by an overlay, so an overlay cannot invalidate its own hold.
 */
export function overlapsAppView(rect: AppViewRect): boolean {
  for (const view of viewRects.values()) {
    if (
      rect.x < view.x + view.width &&
      view.x < rect.x + rect.width &&
      rect.y < view.y + view.height &&
      view.y < rect.y + rect.height
    ) {
      return true
    }
  }

  return false
}

/**
 * App views currently attached to the window (open, visible, on screen).
 * Renderer surfaces that float over the workspace without a hold — the pet —
 * read this to stay out of the app-view rectangle while a guest is painted.
 */
export const $attachedAppViews = atom(0)
const attachedViewIds = new Set<string>()

export function markAppViewAttached(viewId: string, attached: boolean): void {
  if (attached) {
    attachedViewIds.add(viewId)
  } else {
    attachedViewIds.delete(viewId)
  }

  $attachedAppViews.set(attachedViewIds.size)
}

export function resetAppViewOverlayForTests(): void {
  $appViewOverlayCount.set(0)
  attachedViewIds.clear()
  viewRects.clear()
  $appViewRectRevision.set(0)
  $attachedAppViews.set(0)
}
