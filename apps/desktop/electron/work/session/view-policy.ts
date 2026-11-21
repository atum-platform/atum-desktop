import { createWindowOpenHandler } from '../../window-open-policy'

/**
 * The Work view's policy (plan §8.2 "After", U1; lane R's first check).
 *
 * It is installed on the account's partition session, so every owner view of
 * that account is covered, and on the view's WebContents. The view may talk to
 * its own loopback origin and nothing else: an off-origin navigation, redirect
 * or request is cancelled, `window.open` is denied without any external open,
 * every permission is refused, every download is cancelled, and `<webview>` is
 * refused. Nothing here ever calls `openExternal`.
 */
export interface NavigationEventLike {
  preventDefault(): void
  url?: string
}

export interface WebContentsPolicyTarget {
  on(event: 'will-navigate' | 'will-redirect' | 'will-frame-navigate', listener: (event: NavigationEventLike, url?: string) => void): unknown
  on(event: 'will-attach-webview', listener: (event: NavigationEventLike) => void): unknown
  removeListener(event: string, listener: (...args: never[]) => void): unknown
  setWindowOpenHandler(handler: ((details: { url: string }) => { action: 'deny' }) | null): void
}

export interface SessionPolicyTarget {
  setPermissionRequestHandler(handler: ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void) | null): void
  setPermissionCheckHandler(handler: (() => boolean) | null): void
  on(event: 'will-download', listener: (event: unknown, item: { cancel(): void }) => void): unknown
  removeListener(event: string, listener: (...args: never[]) => void): unknown
  webRequest: {
    onBeforeRequest(
      filter: { urls: string[] },
      listener: ((details: { url: string }, callback: (response: { cancel: boolean }) => void) => void) | null
    ): void
  }
}

export interface ViewPolicyOptions {
  /** The incarnation's origin, e.g. `http://127.0.0.1:61275`. */
  origin: string
  /** Observer for blocked navigations and requests. Receives an origin or scheme only, never a URL. */
  onBlocked?: (kind: 'navigation' | 'request' | 'window' | 'permission' | 'download' | 'webview', origin: string) => void
}

export function sameOriginHttpFamily(url: string, origin: string): boolean {
  try {
    const parsed = new URL(url)
    const allowed = new URL(origin)

    if (parsed.hostname !== allowed.hostname || parsed.port !== allowed.port) {
      return false
    }

    // The page's own websocket (ws://127.0.0.1:<port>) is the same listener.
    return ['http:', 'ws:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

function describe(url?: string): string {
  try {
    const parsed = new URL(url ?? '')

    return parsed.origin === 'null' ? parsed.protocol : parsed.origin
  } catch {
    return '<unparseable>'
  }
}

export function installWorkViewPolicy(
  contents: WebContentsPolicyTarget,
  session: SessionPolicyTarget,
  options: ViewPolicyOptions
): () => void {
  const note = (kind: Parameters<NonNullable<ViewPolicyOptions['onBlocked']>>[0], url?: string) => {
    try {
      options.onBlocked?.(kind, describe(url))
    } catch {
      // An observer cannot weaken a decision.
    }
  }

  const guard = (event: NavigationEventLike, url?: string) => {
    const target = url ?? event.url ?? ''

    if (!sameOriginHttpFamily(target, options.origin)) {
      event.preventDefault()
      note('navigation', target)
    }
  }

  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
  contents.on('will-frame-navigate', guard)

  const attach = (event: NavigationEventLike) => {
    event.preventDefault()
    note('webview')
  }

  contents.on('will-attach-webview', attach)
  contents.setWindowOpenHandler(createWindowOpenHandler(origin => note('window', origin)))

  session.setPermissionRequestHandler((_contents, permission, callback) => {
    note('permission', permission)
    callback(false)
  })
  session.setPermissionCheckHandler(() => false)

  const download = (_event: unknown, item: { cancel(): void }) => {
    item.cancel()
    note('download')
  }

  session.on('will-download', download)

  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    if (sameOriginHttpFamily(details.url, options.origin)) {
      callback({ cancel: false })
    } else {
      note('request', details.url)
      callback({ cancel: true })
    }
  })

  return () => {
    for (const event of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
      contents.removeListener(event, guard as never)
    }

    contents.removeListener('will-attach-webview', attach as never)
    contents.setWindowOpenHandler(null)
    session.setPermissionRequestHandler(null)
    session.setPermissionCheckHandler(null)
    session.removeListener('will-download', download as never)
    session.webRequest.onBeforeRequest({ urls: [] }, null)
  }
}
