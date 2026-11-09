export interface DesktopWebview extends HTMLElement {
  canGoBack?: () => boolean
  canGoForward?: () => boolean
  getTitle?: () => string
  getURL?: () => string
  getWebContentsId?: () => number
  goBack?: () => void
  goForward?: () => void
  isLoading?: () => boolean
  loadURL?: (url: string) => Promise<void>
  reload?: () => void
  reloadIgnoringCache?: () => void
  stop?: () => void
}

interface DesktopWebviewMount {
  /** Only with a main-owned setWindowOpenHandler that denies native windows. */
  allowPopups?: boolean
  className: string
  host: HTMLElement
  partition: string
  src: string
  webPreferences?: string
}

/**
 * The single renderer seam for Electron webview creation. Product surfaces
 * retain their own navigation and presentation behavior, while the element,
 * partition and sandbox defaults cannot drift between preview and browser.
 */
export function mountDesktopWebview({
  allowPopups = false,
  className,
  host,
  partition,
  src,
  webPreferences = 'contextIsolation=yes,nodeIntegration=no,sandbox=yes,devTools=no'
}: DesktopWebviewMount): DesktopWebview {
  const webview = document.createElement('webview') as DesktopWebview

  webview.className = className
  webview.setAttribute('partition', partition)
  webview.setAttribute('src', src)
  webview.setAttribute('webpreferences', webPreferences)

  if (allowPopups) {
    webview.setAttribute('allowpopups', '')
  }

  host.replaceChildren(webview)

  return webview
}
