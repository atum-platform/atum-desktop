import type { MatrixWorkRect } from '../../../shared/matrix-work'

/** The parts of a `WebContentsView` that placement touches. */
export interface PlaceableView {
  setBorderRadius(radius: number): void
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void
}

/** The parts of a `BrowserWindow` that placement touches. */
export interface PlaceHostWindow<V> {
  isDestroyed(): boolean
  contentView: {
    addChildView(view: V): void
    removeChildView(view: V): void
  }
}

/**
 * Put the owner view at `rect` in `window`, or take it off the window when `rect` is null. Returns
 * the window that now holds the view.
 *
 * The view gets its final bounds before it is attached. A detached view keeps its last bounds (the
 * full-window preload size, or wherever it was last shown), so attaching first would paint it there
 * for a frame and then move it.
 */
export function placeOwnerView<V extends PlaceableView, W extends PlaceHostWindow<V>>(input: {
  view: V
  host: W | null
  window: W | null
  rect: MatrixWorkRect | null
  zoom: number
  radius: number
}): W | null {
  const { host, rect, view, window, zoom } = input

  if (!rect || !window || window.isDestroyed()) {
    if (host && !host.isDestroyed()) {
      host.contentView.removeChildView(view)
    }

    return null
  }

  view.setBorderRadius(Math.round(input.radius * zoom))
  view.setBounds({
    x: Math.round(rect.x * zoom),
    y: Math.round(rect.y * zoom),
    width: Math.max(0, Math.round(rect.width * zoom)),
    height: Math.max(0, Math.round(rect.height * zoom))
  })

  if (host !== window) {
    if (host && !host.isDestroyed()) {
      host.contentView.removeChildView(view)
    }

    window.contentView.addChildView(view)
  }

  return window
}
