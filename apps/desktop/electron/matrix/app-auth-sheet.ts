import { randomBytes } from 'node:crypto'

import { BrowserWindow, shell, WebContentsView } from 'electron'

import type { DesktopLocale } from '../../shared/desktop-locale'
import { appOnboardingCopy } from '../../shared/matrix-app-onboarding-copy'

import { appAuthApprovedOrigins, appAuthNavigation, appAuthSheetHtml } from './app-auth-sheet-policy'

const HEADER_HEIGHT = 72

export interface AppAuthSheetRequest {
  app: string
  appName: string
  approvedOrigins: readonly string[]
  authorizeUrl: string
  iconDataUrl: string | null
  locale: DesktopLocale
  onClosed: (reason: 'closed' | 'failed') => void
}

/**
 * Open one app-bound authentication sheet.
 *
 * The remote page runs in its own in-memory partition with no preload or Node
 * integration. Only exact server/manifest origins may occupy the sheet. Google
 * OAuth is handed to the system browser; every other foreign navigation and
 * popup is refused. The caller owns attempt/account/cancel binding and closes
 * this handle when its exact loopback return settles.
 */
export async function openAppAuthSheet(
  request: AppAuthSheetRequest,
  parent: BrowserWindow | null = null
): Promise<{ close(): void }> {
  const copy = appOnboardingCopy(request.locale)
  const approved = appAuthApprovedOrigins(request.authorizeUrl, request.approvedOrigins)
  const partition = `atum-app-auth-${request.app}-${randomBytes(16).toString('hex')}`
  const window = new BrowserWindow({
    width: 720,
    height: 760,
    minWidth: 520,
    minHeight: 560,
    show: false,
    frame: false,
    ...(parent && !parent.isDestroyed() ? { parent, modal: true } : {}),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      partition: `${partition}-chrome`
    }
  })
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      partition
    }
  })
  let expectedClose = false
  let opened = false
  let failed = false

  const close = (expected: boolean, asFailure = false) => {
    expectedClose ||= expected
    failed ||= asFailure

    if (!window.isDestroyed()) {
      window.destroy()
    }
  }

  const refuse = () => close(false, true)
  const handleNavigation = (event: { preventDefault(): void }, rawUrl: string) => {
    const decision = appAuthNavigation(rawUrl, approved)

    if (decision === 'allow') {
      return
    }

    event.preventDefault()

    if (decision === 'google_system_browser') {
      void shell.openExternal(rawUrl).catch(refuse)

      return
    }

    refuse()
  }

  const setBounds = () => {
    if (window.isDestroyed() || view.webContents.isDestroyed()) {
      return
    }

    const bounds = window.getContentBounds()
    view.setBounds({
      x: 0,
      y: HEADER_HEIGHT,
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height - HEADER_HEIGHT)
    })
  }

  window.contentView.addChildView(view)
  window.on('resize', setBounds)
  window.on('closed', () => {
    if (!view.webContents.isDestroyed()) {
      view.webContents.close({ waitForBeforeUnload: false })
    }

    if (!expectedClose) {
      request.onClosed(failed ? 'failed' : 'closed')
    }
  })
  window.webContents.on('will-navigate', (event, rawUrl) => {
    event.preventDefault()

    if (rawUrl === 'atum-app-auth://close') {
      close(false)
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const guest = view.webContents
  guest.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  guest.session.setPermissionCheckHandler(() => false)
  guest.session.on('will-download', event => event.preventDefault())
  guest.session.webRequest.onBeforeRequest((details, callback) => {
    const localObject = details.url.startsWith('data:') || details.url.startsWith('blob:')
    callback({ cancel: !localObject && appAuthNavigation(details.url, approved) === 'refuse' })
  })
  guest.setWindowOpenHandler(details => {
    const decision = appAuthNavigation(details.url, approved)

    if (decision === 'google_system_browser') {
      void shell.openExternal(details.url).catch(refuse)
    } else if (decision === 'allow') {
      void guest.loadURL(details.url).catch(refuse)
    } else {
      refuse()
    }

    return { action: 'deny' }
  })
  guest.on('will-navigate', handleNavigation)
  guest.on('will-redirect', handleNavigation)
  guest.on('will-attach-webview', event => event.preventDefault())
  guest.on('context-menu', event => event.preventDefault())
  guest.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault()
      close(false)
    }
  })
  guest.on('render-process-gone', refuse)
  guest.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    // ERR_ABORTED is the expected result of a prevented Google/foreign navigation.
    if (opened && isMainFrame && errorCode !== -3) {
      refuse()
    }
  })

  const chrome = appAuthSheetHtml({
    appName: request.appName,
    closeLabel: copy.close,
    googleHint: copy.authGoogleHint,
    iconDataUrl: request.iconDataUrl,
    title: copy.authTitle(request.appName)
  })

  try {
    await Promise.all([
      window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(chrome)}`),
      guest.loadURL(request.authorizeUrl)
    ])
  } catch (error) {
    close(true)

    throw error
  }

  opened = true
  setBounds()
  window.show()
  window.focus()

  return {
    close: () => close(true)
  }
}
