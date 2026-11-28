import { randomUUID } from 'node:crypto'

import type { Session, WebContents, WebPreferences } from 'electron'

import type { MatrixWorkGuest } from '../../../shared/matrix-work'
import { createElectronOwnerView, installWorkViewPolicy, partitionFor } from '../session'
import type { WorkIncarnation } from '../sidecar/process'

// The pinned Work chrome can render its own Update Everything for provider-only offers.
const EMBEDDED_WORK_UPDATE_STYLE = `
  [data-sidebar="footer"] [data-slot="sidebar-menu-item"].ml-auto.shrink-0,
  [data-sidebar="footer"] [data-slot="sidebar-menu-item"][class~="@container/sidebar-update"] {
    display: none !important;
  }
`

export function createWorkGuestHost(input: {
  contents(): WebContents | undefined
  sessionFromPartition(partition: string): Session
  preload: string
  log?(phase: string, ms: number): void
  onBlocked?: (kind: string, origin: string) => void
}) {
  let pending: { host: WebContents; guest: MatrixWorkGuest; accepted: boolean } | undefined

  return {
    /** This is the only exception to Matrix's consumer-only webview rule. */
    allowAttach(host: WebContents, preferences: WebPreferences, params: Record<string, unknown>): boolean {
      if (!pending || pending.host !== host || pending.accepted ||
          params.partition !== pending.guest.partition || params.src !== pending.guest.src) {
        return false
      }

      pending.accepted = true

      // The renderer supplies an element and the one-use mount descriptor. Main owns every preference.
      for (const key of Object.keys(preferences) as (keyof WebPreferences)[]) {
        delete preferences[key]
      }

      Object.assign(preferences, {
        partition: pending.guest.partition,
        preload: input.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        webSecurity: true,
        backgroundThrottling: false,
        zoomFactor: host.getZoomFactor(),
        disablePopups: true
      })
      delete params.httpreferrer
      delete params.useragent

      return true
    },
    async createView(incarnation: WorkIncarnation, signal: AbortSignal, publishGuest: (guest: MatrixWorkGuest) => void) {
      const host = input.contents()

      if (!host || host.isDestroyed() || pending || signal.aborted) {throw new Error('work_guest_unavailable')}

      const startedAt = Date.now()
      const partition = partitionFor(incarnation.accountKey)
      const session = input.sessionFromPartition(partition)
      const request = { host, guest: { partition, src: `about:blank#${randomUUID()}` }, accepted: false }
      pending = request

      return new Promise<ReturnType<typeof createElectronOwnerView>>((resolve, reject) => {
        let guestContents: WebContents | undefined

        const finish = () => {
          clearTimeout(timeout)
          signal.removeEventListener('abort', cancel)
          host.removeListener('destroyed', cancel)
          host.removeListener('did-attach-webview', attached)
          guestContents?.removeListener('destroyed', cancel)
          guestContents?.removeListener('did-finish-load', ready)
          pending = undefined
        }

        const cancel = () => {
          finish()

          if (guestContents && !guestContents.isDestroyed()) {guestContents.close()}
          reject(new Error('work_guest_unavailable'))
        }

        const attached = (_event: unknown, contents: WebContents) => {
          if (!request.accepted || contents.session !== session) {return}
          guestContents = contents
          input.log?.('view-created', Date.now() - startedAt)

          // Electron starts the inert URL just before did-attach-webview. Fence the guest now,
          // and wait for that navigation to finish before WorkSession loads the pairing grant.
          const disposePolicy = installWorkViewPolicy(contents, session as unknown as Parameters<typeof installWorkViewPolicy>[1], {
            origin: incarnation.origin,
            onBlocked: input.onBlocked
          })

          const throttle = setTimeout(() => {
            if (!contents.isDestroyed()) {contents.setBackgroundThrottling(true)}
          }, 15_000)

          throttle.unref?.()
          contents.once('destroyed', () => {
            clearTimeout(throttle)
            disposePolicy()
          })
          contents.on('render-process-gone', () => {
            if (!contents.isDestroyed()) {contents.close()}
          })
          contents.once('destroyed', cancel)
          contents.once('did-finish-load', ready)
        }

        const ready = () => {
          const contents = guestContents!
          finish()
          contents.on('dom-ready', () => {
            void contents.insertCSS(EMBEDDED_WORK_UPDATE_STYLE, { cssOrigin: 'user' }).catch(() => undefined)
            input.log?.('page-dom-ready', Date.now() - startedAt)
          })
          contents.on('did-finish-load', () => input.log?.('page-load', Date.now() - startedAt))
          resolve(createElectronOwnerView({ contents, session, origin: incarnation.origin }))
        }

        const timeout = setTimeout(cancel, 10_000)
        timeout.unref?.()
        host.on('did-attach-webview', attached)
        host.once('destroyed', cancel)
        signal.addEventListener('abort', cancel, { once: true })
        publishGuest(request.guest)
      })
    }
  }
}
