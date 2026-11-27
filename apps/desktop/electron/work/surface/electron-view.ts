import { type BrowserWindow, session as electronSession, WebContentsView } from 'electron'

import type { MatrixWorkRect } from '../../../shared/matrix-work'
import { createElectronOwnerView, installWorkViewPolicy, partitionFor } from '../session'
import type { WorkIncarnation } from '../sidecar/process'

import { placeOwnerView } from './place-view'
import type { WorkViewHandle } from './surface'

// The pinned Work chrome can also render Update Everything for provider-only offers.
// Suppress its two footer menu states in this embed. Its separate CLI provider pill is outside the menu.
const EMBEDDED_WORK_UPDATE_STYLE = `
  [data-sidebar="footer"] [data-slot="sidebar-menu-item"].ml-auto.shrink-0,
  [data-sidebar="footer"] [data-slot="sidebar-menu-item"][class~="@container/sidebar-update"] {
    display: none !important;
  }
`

/**
 * The real owner view: a `WebContentsView` on the account's own partition, with R's policy and S's
 * isolated preload, painted over the Work page's host region of the Matrix window.
 */
export function createWorkViewFactory(input: {
  log?(phase: string, ms: number): void
  window: () => BrowserWindow | null
  /** S's isolated `dist/electron-work-preload.js`. */
  preload: string
  zoomFactor?: () => number
  /** Corner radius of the region in CSS pixels (Work: the panel radius, WORK_VIEW_RADIUS). */
  radius?: number
  onBlocked?: (kind: string, origin: string) => void
}): (incarnation: WorkIncarnation) => WorkViewHandle {
  return incarnation => {
    const startedAt = Date.now()
    const partition = partitionFor(incarnation.accountKey)
    const session = electronSession.fromPartition(partition)

    const view = new WebContentsView({
      webPreferences: {
        partition,
        // Pairing and client hydration must run at foreground speed while the view is detached.
        backgroundThrottling: false,
        preload: input.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false
      }
    })

    const contents = view.webContents

    const throttle = setTimeout(() => {
      if (!contents.isDestroyed()) {
        contents.setBackgroundThrottling(true)
      }
    }, 15_000)

    throttle.unref?.()

    input.log?.('view-created', Date.now() - startedAt)
    contents.on('dom-ready', () => {
      void contents.insertCSS(EMBEDDED_WORK_UPDATE_STYLE, { cssOrigin: 'user' }).catch(() => undefined)
      input.log?.('page-dom-ready', Date.now() - startedAt)
    })
    contents.on('did-finish-load', () => input.log?.('page-load', Date.now() - startedAt))

    // A detached preload still needs a desktop viewport, rather than a zero-width mobile layout.
    const initialWindow = input.window()
    const bounds = initialWindow && !initialWindow.isDestroyed() ? initialWindow.getContentBounds() : null

    if (bounds) {
      view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height })
    }

    // Transparent, so the window's frame (and its vibrancy) shows in the gaps between T3's panels.
    view.setBackgroundColor('#00000000')

    // Electron's overloaded `on`/`removeListener` signatures don't narrow to R's structural targets.
    const disposePolicy = installWorkViewPolicy(contents, session as unknown as Parameters<typeof installWorkViewPolicy>[1], {
      origin: incarnation.origin,
      onBlocked: input.onBlocked
    })

    let host: BrowserWindow | null = null

    const place = (rect: MatrixWorkRect | null) => {
      const window = rect && !contents.isDestroyed() ? input.window() : null
      const canPlace = window && !window.isDestroyed()

      host = placeOwnerView({
        view,
        host,
        window: canPlace ? window : null,
        rect,
        zoom: canPlace ? (input.zoomFactor?.() ?? 1) : 1,
        radius: input.radius ?? 0
      })
    }

    // Electron can clear view.webContents before emitting 'destroyed' on contents.
    contents.once('destroyed', () => {
      clearTimeout(throttle)
      disposePolicy()
      place(null)
    })

    return {
      port: createElectronOwnerView({ contents, session, origin: incarnation.origin }),
      place,
      focus: () => {
        if (!contents.isDestroyed()) {
          contents.focus()
        }
      }
    }
  }
}
