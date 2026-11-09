import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { AlertCircle, WifiOff } from '@/lib/icons'
import { trackAppViewAttachment } from '@/store/app-view-attachment'
import { $appViewOverlayCount, setAppViewRect } from '@/store/app-view-overlay'

import type { AppViewBridge, AppViewError, AppViewState } from '../../../shared/app-view/ipc'

/**
 * The renderer half of an app view. Main owns the `WebContentsView`; this
 * component owns a host element whose geometry and visibility it reports,
 * and it renders the typed failure states in the tab body. It never sees an
 * origin, a path, or the launch URL.
 */

type Phase =
  | { kind: 'opening' }
  | { kind: 'open'; viewId: string; state: AppViewState['status']; error?: AppViewError; retryAfterMs?: number }
  | { kind: 'failed'; error: AppViewError }

function sameBounds(
  a: { x: number; y: number; width: number; height: number } | null,
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function measure(node: HTMLElement): { x: number; y: number; width: number; height: number } {
  const rect = node.getBoundingClientRect()

  // DIPs on both sides: the window content bounds main clamps against are in
  // CSS pixels from `getBoundingClientRect`; the native Matrix host applies its
  // current CSS-to-DIP zoom. Legacy fixed-scale hosts retain factor 1.
  return {
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height))
  }
}

export function AtumAppView({
  app,
  bridge: injectedBridge,
  hidden = false,
  onConnect,
  linkRecovery,
  routeId,
  onNavigation,
  panelPresentation: panelCopy
}: {
  app: string
  /** Matrix supplies its own narrow capability; Atum retains the preload fallback. */
  bridge?: AppViewBridge
  hidden?: boolean
  /** Opens the connect card for `not_linked` / `unlinked`; the view itself never navigates to a login. */
  onConnect?: () => void
  linkRecovery?: { label: string; message: string }
  routeId: string
  onNavigation?: (state: AppViewState) => void
  /** Inside the app side panel: host-drawn states (one glyph, one line, one action) with its copy. */
  panelPresentation?: { failed: string; offline: string }
}) {
  const { t } = useI18n()
  const panelPresentation = Boolean(panelCopy)
  const navigationCallback = useRef(onNavigation)
  navigationCallback.current = onNavigation
  const [offline, setOffline] = useState(panelPresentation && !navigator.onLine)
  useEffect(() => {
    if (!panelPresentation) {return}
    const onOffline = () => setOffline(true)

    const onOnline = () => {
      setOffline(false)
      setPhase({ kind: 'opening' })
      setAttempt(value => value + 1)
    }

    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)

    return () => {
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    }
  }, [panelPresentation])
  const hostRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'opening' })
  /**
   * Bumped to reopen from scratch. A view is bound to the manifest it opened
   * under, so when the app's declared reach or version changes, reloading the
   * same view can only ever return the same refusal — recovery has to be a
   * new view, not a new attempt at the old one.
   */
  const [attempt, setAttempt] = useState(0)
  const overlayCount = useStore($appViewOverlayCount)
  const [intersecting, setIntersecting] = useState(true)
  const lastBounds = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const viewId = phase.kind === 'open' ? phase.viewId : null
  const failed = panelPresentation && (phase.kind === 'failed' || (phase.kind === 'open' && phase.state === 'error'))
  const bridge = injectedBridge ?? window.hermesDesktop?.appView

  useEffect(() => {
    if (!bridge) {
      setPhase({ kind: 'failed', error: 'account_unavailable' })

      return
    }

    let active = true
    let opened: string | null = null

    const deadline = panelPresentation
      ? window.setTimeout(() => {
          setPhase(current => {
            if (current.kind === 'opening' || (current.kind === 'open' && current.state === 'launching')) {
              active = false

              if (opened) {
                void bridge.close(opened)
              }

              return { kind: 'failed', error: 'load_failed' }
            }

            return current
          })
        }, 15_000)
      : undefined

    const stopState = bridge.onState(state => {
      if (!active || state.viewId !== opened) {
        return
      }

      navigationCallback.current?.(state)
      setPhase(current =>
        current.kind === 'open' && current.viewId === state.viewId
          ? {
              kind: 'open',
              viewId: state.viewId,
              state: state.status,
              error: state.error,
              retryAfterMs: state.retryAfterMs
            }
          : current
      )
    })

    void bridge
      .open({ app, route_id: routeId, ...(panelPresentation ? { panelNavigation: true } : {}) })
      .then(result => {
        if (!active) {
          if ('viewId' in result) {
            void bridge.close(result.viewId)
          }

          return
        }

        if ('error' in result) {
          const error = result.error
          setPhase({
            kind: 'failed',
            error:
              error === 'route_unknown' || error === 'app_id_invalid'
                ? 'route_unknown'
                : error === 'account_unavailable'
                  ? 'account_unavailable'
                  : 'temporarily_unavailable'
          })

          return
        }

        opened = result.viewId
        lastBounds.current = null
        setPhase({ kind: 'open', viewId: result.viewId, state: 'launching' })
      })
      .catch(() => {
        if (active) {
          setPhase({ kind: 'failed', error: 'temporarily_unavailable' })
        }
      })

    return () => {
      active = false
      stopState()
      window.clearTimeout(deadline)

      if (opened) {
        void bridge.close(opened)
      }
    }
  }, [app, attempt, bridge, panelPresentation, routeId])

  const report = useCallback(() => {
    const node = hostRef.current

    if (!node || !bridge || !viewId) {
      return
    }

    const bounds = measure(node)
    setAppViewRect(viewId, hidden || !intersecting ? null : bounds)

    if (!sameBounds(lastBounds.current, bounds)) {
      lastBounds.current = bounds
      void bridge.setBounds({ viewId, bounds })
    }
  }, [bridge, hidden, intersecting, viewId])

  // Geometry: element resize, window resize, layout and scroll, transition
  // end, and a final measurement after transitions.
  useEffect(() => {
    const node = hostRef.current

    if (!node || !viewId) {
      return
    }

    report()
    const observer = new ResizeObserver(() => report())
    observer.observe(node)

    const intersection =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(entries => {
            setIntersecting(entries.some(entry => entry.isIntersecting))
            report()
          })
        : null

    intersection?.observe(node)
    const onWindow = () => report()
    window.addEventListener('resize', onWindow)
    document.addEventListener('scroll', onWindow, true)
    document.addEventListener('transitionend', onWindow, true)
    const settle = window.setInterval(report, 500)

    return () => {
      observer.disconnect()
      intersection?.disconnect()
      window.removeEventListener('resize', onWindow)
      document.removeEventListener('scroll', onWindow, true)
      document.removeEventListener('transitionend', onWindow, true)
      window.clearInterval(settle)
    }
  }, [report, viewId])

  // A layout effect: when an overlay takes the hold, main is asked to detach
  // the native view before the overlay paints, not after.
  useLayoutEffect(() => {
    if (!bridge || !viewId) {
      return
    }

    const attached = !hidden && !offline && !failed && intersecting && overlayCount === 0

    // The view counts as attached until main has answered the request that
    // detaches it: floating surfaces must not return while the native view
    // is still painted.
    if (hidden || !intersecting) {
      setAppViewRect(viewId, null)
    }

    void trackAppViewAttachment(viewId, attached, () =>
      bridge.setVisibility({ viewId, visible: !hidden && !offline && !failed && intersecting, overlayActive: overlayCount > 0 })
    )
  }, [bridge, failed, hidden, intersecting, offline, overlayCount, viewId])

  // Geometry belongs to the view's lifetime, not each temporary overlay hold.
  useLayoutEffect(
    () => () => {
      if (bridge && viewId) {
        lastBounds.current = null
        setAppViewRect(viewId, null)
        void trackAppViewAttachment(viewId, false, () =>
          bridge.setVisibility({ viewId, visible: false, overlayActive: false })
        )
      }
    },
    [bridge, viewId]
  )

  const retry = () => {
    if (!bridge) {
      return
    }

    // `app_unavailable` is how main reports a manifest that no longer matches
    // what this view opened under. Reloading keeps that view, and its answer,
    // so recovery reopens instead.
    if (reopenToRecover) {
      setPhase({ kind: 'opening' })
      setAttempt(current => current + 1)

      return
    }

    if (!viewId) {
      return
    }

    setPhase({ kind: 'open', viewId, state: 'launching' })
    void bridge.reload(viewId)
  }

  const error =
    phase.kind === 'failed'
      ? phase.error
      : phase.kind === 'open' && phase.state === 'error'
        ? (phase.error ?? 'load_failed')
        : null

  const copy: Record<AppViewError, string> = {
    not_linked: t.atum.appView.notLinked,
    unlinked: t.atum.appView.unlinked,
    membership_inactive: t.atum.appView.membershipInactive,
    app_unavailable: t.atum.appView.appUnavailable,
    app_version_incompatible: t.atum.appView.versionIncompatible,
    route_unknown: t.atum.appView.invalid,
    route_session_not_required: t.atum.appView.invalid,
    temporarily_unavailable: t.atum.appView.temporarilyUnavailable,
    rate_limited: t.atum.appView.rateLimited,
    security_failure: t.atum.appView.securityFailure,
    navigation_blocked: t.atum.appView.invalid,
    load_failed: t.atum.appView.loadFailed,
    account_unavailable: t.atum.appView.accountUnavailable
  }

  // In the panel every failure reopens the page (the slow-page deadline closed its view);
  // standalone views keep their own per-error recovery.
  const reopenToRecover = error === 'app_unavailable' || (panelPresentation && error !== null)

  const retryable =
    error === 'temporarily_unavailable' || error === 'rate_limited' || error === 'load_failed' || reopenToRecover

  const connectable = error === 'not_linked' || error === 'unlinked'

  return (
    <div
      className={hidden ? 'hidden' : 'flex h-full min-h-0 w-full flex-1 flex-col'}
      data-atum-app-view={app}
      data-atum-app-view-route={routeId}
      data-atum-app-view-state={error ? 'error' : phase.kind === 'open' ? phase.state : phase.kind}
    >
      <div className="relative min-h-0 flex-1 bg-(--atum-card)" ref={hostRef}>
        {offline && panelCopy && (
          <div className="app-panel-state absolute inset-0" data-app-panel-state role="status">
            <WifiOff aria-hidden className="ak-icon" />
            <p>{panelCopy.offline}</p>
          </div>
        )}
        {!offline && (phase.kind === 'opening' || (phase.kind === 'open' && phase.state === 'launching' && !error)) ? (
          <div
            className={
              panelPresentation
                ? 'app-panel-progress absolute inset-x-0 top-0'
                : 'absolute inset-0 flex items-center justify-center text-[length:var(--atum-t-ui)] text-(--atum-ink-muted)'
            }
            role="status"
          >
            <span className={panelPresentation ? 'sr-only' : undefined}>{t.atum.appView.loading}</span>
          </div>
        ) : null}
        {!offline && error && panelCopy ? (
          // One action only: a page that needs the account offers the link, anything else Retry.
          <div className="app-panel-state absolute inset-0" data-app-panel-state role="alert">
            {connectable && linkRecovery ? null : <AlertCircle aria-hidden className="ak-icon" />}
            <p>{connectable && linkRecovery ? linkRecovery.message : panelCopy.failed}</p>
            {connectable && onConnect ? (
              <button className="ak-btn ak-btn--primary app-panel-primary" onClick={onConnect} type="button">
                {linkRecovery?.label ?? (error === 'unlinked' ? t.atum.appView.reconnect : t.atum.appView.connect)}
              </button>
            ) : viewId || reopenToRecover ? (
              <button className="ak-btn ak-btn--sm" onClick={retry} type="button">
                {t.atum.appView.retry}
              </button>
            ) : null}
          </div>
        ) : !offline && error ? (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center"
            role="alert"
          >
            <p className="max-w-sm text-[length:var(--atum-t-ui)] text-(--atum-ink)">
              {connectable && linkRecovery ? linkRecovery.message : copy[error]}
            </p>
            {connectable && onConnect ? (
              <Button onClick={onConnect} size="sm" variant="secondary">
                {linkRecovery?.label ?? (error === 'unlinked' ? t.atum.appView.reconnect : t.atum.appView.connect)}
              </Button>
            ) : null}
            {retryable && (viewId || reopenToRecover) ? (
              <Button onClick={retry} size="sm" variant="secondary">
                {t.atum.appView.retry}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
