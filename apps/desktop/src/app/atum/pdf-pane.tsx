import { useStore } from '@nanostores/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { trackAppViewAttachment } from '@/store/app-view-attachment'
import { $appViewOverlayCount, setAppViewRect } from '@/store/app-view-overlay'

/** Long enough for a cold viewer on a slow disk, short enough that a viewer
 * which never appears does not read as a hang. */
export const VIEWER_START_TIMEOUT_MS = 8000

/** A native view is repositioned after transitions settle, on this cadence. */
export const VIEWER_SETTLE_INTERVAL_MS = 500

interface Rect {
  height: number
  width: number
  x: number
  y: number
}

function measure(node: HTMLElement): Rect {
  const rect = node.getBoundingClientRect()

  return { height: rect.height, width: rect.width, x: rect.x, y: rect.y }
}

function sameRect(a: Rect | null, b: Rect): boolean {
  return Boolean(a) && a!.x === b.x && a!.y === b.y && a!.width === b.width && a!.height === b.height
}

/**
 * A document tab, not a browser tab.
 *
 * Chromium's PDF viewer is an inner guest of its own and cannot be nested in a
 * `<webview>` — it loads but never composites, which is why this pane used to
 * render blank with nothing to report. So the viewer is a main-owned view laid
 * over this element. That view paints above every DOM node, so the pane owes
 * the same courtesies the app views do: it steps aside for any overlay, hides
 * when scrolled out of view, and follows every reflow. It never learns the
 * file's path and cannot navigate the view.
 *
 * Three effects, three lifetimes: the view lives as long as the token (closed
 * on unmount, never for a visibility flip — a tooltip must not reload the
 * document); geometry is reported only while the pane is eligible to show;
 * and losing eligibility hides the view before the covering surface paints.
 */
export function AtumPdfPane({
  sourcePath,
  title,
  token,
  bridge: injectedBridge,
  hidden = false
}: {
  sourcePath?: string
  title: string
  token: string
  hidden?: boolean
  bridge?: {
    show(token: string, bounds: Rect): Promise<{ shown: boolean }>
    hide(token: string): Promise<unknown>
    close(token: string): Promise<unknown>
  }
}) {
  const { t } = useI18n()
  const hostRef = useRef<HTMLDivElement>(null)
  const lastRect = useRef<Rect | null>(null)
  const shown = useRef(false)
  const [failure, setFailure] = useState<null | string>(null)
  const [intersecting, setIntersecting] = useState(true)
  const overlayCount = useStore($appViewOverlayCount)
  const eligible = !hidden && intersecting
  const visible = eligible && overlayCount === 0
  const bridge = injectedBridge ?? window.hermesDesktop?.atumPdfView

  // Lifetime: one view per token. Closed when the pane unmounts or the token
  // changes, and at no other time. The intersection observer lives here too,
  // so scrolling back into view is noticed while the pane is ineligible.
  useEffect(() => {
    const host = hostRef.current

    if (!host) {
      return
    }

    if (!bridge) {
      setFailure('viewer unavailable')

      return
    }

    setFailure(null)
    shown.current = false
    lastRect.current = null

    const intersection =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(entries => setIntersecting(entries.some(entry => entry.isIntersecting)))
        : null

    intersection?.observe(host)

    return () => {
      intersection?.disconnect()
      setAppViewRect(`pdf:${token}`, null)
      void trackAppViewAttachment(`pdf:${token}`, false, () => bridge.close(token))
    }
  }, [bridge, token])

  // Geometry, while eligible: place the view over this element and keep it
  // there through element resize, window resize, scroll, transitions and a
  // settle tick. Requests are coalesced per frame and skipped when nothing
  // moved. A request that is refused or rejected forgets the rectangle so the
  // next reflow tries again; only a refusal is reported as "not attached".
  useEffect(() => {
    const host = hostRef.current

    if (!host || !bridge || !eligible) {
      return
    }

    let disposed = false
    let frame: number | null = null
    let timer: number | null = null

    const confirmShown = () => {
      if (disposed) {
        return
      }

      shown.current = true

      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }

      // A late successful placement can follow a slow-disk timeout. The view
      // is now real, so remove the stale fallback instead of covering it.
      setFailure(null)
    }

    const placeNow = () => {
      frame = null

      if (disposed) {
        return
      }

      const rect = measure(host)
      // Geometry remains authoritative while an overlay temporarily detaches
      // the view. Otherwise that overlay releases its own hold and oscillates.
      setAppViewRect(`pdf:${token}`, rect)

      if (!visible || rect.width <= 0 || rect.height <= 0 || sameRect(lastRect.current, rect)) {
        return
      }

      lastRect.current = rect
      // Publish where the viewer is BEFORE main answers: a small renderer
      // surface deciding whether it overlaps must err towards stepping aside,
      // and an attach that is refused clears the rectangle a moment later.
      void trackAppViewAttachment(`pdf:${token}`, true, () =>
        bridge.show(token, rect).then(
          result => {
            if (result?.shown) {
              confirmShown()

              return result
            }

            // Refused: main guarantees nothing is attached for a refusal, so
            // tell the tracker so, and let the next reflow try again.
            lastRect.current = null
            setAppViewRect(`pdf:${token}`, null)

            return { error: 'not shown' }
          },
          (error: unknown) => {
            // Rejected: main may or may not have attached the view. Retry on
            // the next reflow, but leave the tracker's conservative count
            // alone — it treats a rejected attach as possibly painted.
            lastRect.current = null
            throw error
          }
        )
      )
    }

    const place = () => {
      if (frame === null) {
        frame = window.requestAnimationFrame(placeNow)
      }
    }

    place()

    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null
    resize?.observe(host)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    document.addEventListener('transitionend', place, true)
    const settle = window.setInterval(place, VIEWER_SETTLE_INTERVAL_MS)

    if (visible && !shown.current) {
      timer = window.setTimeout(() => {
        if (!disposed && !shown.current) {
          setFailure('viewer did not start')
        }
      }, VIEWER_START_TIMEOUT_MS)
    }

    return () => {
      disposed = true

      if (frame !== null) {
        window.cancelAnimationFrame(frame)
      }

      if (timer !== null) {
        window.clearTimeout(timer)
      }

      resize?.disconnect()
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
      document.removeEventListener('transitionend', place, true)
      window.clearInterval(settle)
    }
  }, [bridge, eligible, token, visible])

  // Overlays and off-screen scrolling: a layout effect so main is asked to
  // take the view down before the overlay paints, not after. Hidden, not
  // closed: the document comes back where it was.
  useLayoutEffect(() => {

    if (!bridge || visible) {
      return
    }

    lastRect.current = null

    if (!eligible) {setAppViewRect(`pdf:${token}`, null)}
    void trackAppViewAttachment(`pdf:${token}`, false, () => bridge.hide(token))
  }, [bridge, eligible, token, visible])

  return (
    <div
      className="relative h-full min-h-0 w-full"
      data-atum-pdf-overlay-count={overlayCount}
      data-atum-pdf-state={visible ? 'visible' : overlayCount > 0 ? 'overlay' : 'offscreen'}
    >
      {/* Mock 1b: the page sits on the ground — margin 8 28 0, r14 on top
          only, bleeds to the bottom, bg-high with the glass edge. */}
      <div
        aria-label={`${t.atum.workspace.filesPdfViewer}: ${title}`}
        className="mx-7 mt-2 h-[calc(100%-0.5rem)] min-h-0 overflow-hidden rounded-t-[var(--atum-r-card)] bg-(--atum-bg-high) shadow-[var(--atum-glass-edge)]"
        data-testid="atum-pdf-pane"
        ref={hostRef}
        role="document"
      />
      {failure && (
        <div
          className="absolute inset-0 grid place-items-center px-6 text-center"
          data-testid="atum-pdf-pane-error"
          role="alert"
        >
          <div>
            <p className="text-[0.875rem] font-semibold text-(--atum-ink)">
              {t.atum.workspace.filesPdfFailed}
            </p>
            <p className="mt-1 text-(length:--atum-t-body) text-(--atum-ink-muted)">{failure}</p>
            {sourcePath && (
              <button
                className="mt-2 text-(length:--atum-t-control) text-(--atum-ink-muted) underline underline-offset-2 hover:text-(--atum-ink)"
                onClick={() => void window.hermesDesktop?.consumerFiles?.openNative(sourcePath)}
                type="button"
              >
                {t.atum.workspace.filesOpenNative}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
