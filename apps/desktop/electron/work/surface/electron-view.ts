import { type BrowserWindow, session as electronSession, WebContentsView } from 'electron'

import type { MatrixWorkRect } from '../../../shared/matrix-work'
import { createElectronOwnerView, installWorkViewPolicy, partitionFor } from '../session'
import type { WorkIncarnation } from '../sidecar/process'

import type { WorkViewHandle } from './surface'

/**
 * The real owner view: a `WebContentsView` on the account's own partition, with R's policy and S's
 * isolated preload, painted over the Work page's host region of the Matrix window.
 */
export function createWorkViewFactory(input: {
  window: () => BrowserWindow | null
  /** S's isolated `dist/electron-work-preload.js`. */
  preload: string
  zoomFactor?: () => number
  /** Corner radius of the region; 0 for Work, whose view paints its own panel corners (spec §1.4). */
  radius?: number
  onBlocked?: (kind: string, origin: string) => void
}): (incarnation: WorkIncarnation) => WorkViewHandle {
  return incarnation => {
    const partition = partitionFor(incarnation.accountKey)
    const session = electronSession.fromPartition(partition)

    const view = new WebContentsView({
      webPreferences: {
        partition,
        preload: input.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false
      }
    })

    // Transparent, so the window's frame (and its vibrancy) shows in the gaps between T3's panels.
    view.setBackgroundColor('#00000000')

    // Electron's overloaded `on`/`removeListener` signatures don't narrow to R's structural targets.
    const disposePolicy = installWorkViewPolicy(view.webContents, session as unknown as Parameters<typeof installWorkViewPolicy>[1], {
      origin: incarnation.origin,
      onBlocked: input.onBlocked
    })

    let host: BrowserWindow | null = null

    const place = (rect: MatrixWorkRect | null) => {
      const window = input.window()

      if (!rect || !window || window.isDestroyed() || view.webContents.isDestroyed()) {
        if (host && !host.isDestroyed()) {
          host.contentView.removeChildView(view)
        }

        host = null

        return
      }

      if (host !== window) {
        if (host && !host.isDestroyed()) {
          host.contentView.removeChildView(view)
        }

        window.contentView.addChildView(view)
        host = window
      }

      const zoom = input.zoomFactor?.() ?? 1
      view.setBorderRadius(Math.round((input.radius ?? 0) * zoom))
      view.setBounds({
        x: Math.round(rect.x * zoom),
        y: Math.round(rect.y * zoom),
        width: Math.max(0, Math.round(rect.width * zoom)),
        height: Math.max(0, Math.round(rect.height * zoom))
      })
    }

    view.webContents.once('destroyed', () => {
      disposePolicy()
      place(null)
    })

    return {
      port: createElectronOwnerView({ contents: view.webContents, session, origin: incarnation.origin }),
      place
    }
  }
}
