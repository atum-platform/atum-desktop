import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { ATUM_FILE_VIEW_PARTITION } from './atum-file-view-constants'

/**
 * The in-panel PDF viewer.
 *
 * Chromium's PDF viewer is a MimeHandlerView, an inner guest of its own. It
 * cannot be nested inside a `<webview>`: the extension loads and the embed is
 * sized, but the inner guest never composites, so the pane renders blank with
 * no load failure to report. Verified on Electron 40 — a `file:` PDF paints in
 * a window and in a `WebContentsView`, and paints nothing inside a `<webview>`,
 * whatever the scheme.
 *
 * Electron 41 moved the bundled PDF viewer into an out-of-process iframe in
 * the document's existing WebContents. The viewer remains a main-owned
 * `WebContentsView` laid over the panel, the same
 * shape the app views use. The renderer only ever reports where to put it and
 * hands back a token; it never learns the path and cannot navigate the view.
 */

export const ATUM_PDF_VIEW_IPC_CHANNELS = {
  close: 'atum:pdf-view:close',
  hide: 'atum:pdf-view:hide',
  show: 'atum:pdf-view:show'
} as const

export interface AtumPdfViewBounds {
  height: number
  width: number
  x: number
  y: number
}

interface PdfWebContents {
  close: () => void
  isDestroyed: () => boolean
  loadURL: (url: string) => Promise<void>
  on: (event: string, listener: (...args: never[]) => void) => void
  setWindowOpenHandler: (handler: () => { action: 'deny' }) => void
}

export interface PdfViewLike {
  setBounds: (bounds: AtumPdfViewBounds) => void
  setVisible: (visible: boolean) => void
  webContents: PdfWebContents
}

export interface AtumPdfViewHost {
  contentView: { addChildView: (view: PdfViewLike) => void; removeChildView: (view: PdfViewLike) => void }
  getContentSize: () => [number, number]
  isDestroyed: () => boolean
}

export interface AtumPdfViewDeps {
  /** Resolves a viewer token to a confined, canonical path, or null. Called on
   * every show, so a file that moved or became disallowed stops resolving. */
  resolvePath: (token: string) => null | string
  createView: () => PdfViewLike
  host: () => AtumPdfViewHost | null
  pathToUrl: (filePath: string) => string
  /** The host page's zoom factor. The renderer measures in CSS px, the window
   * places in DIP; at any zoom but 100% they differ by exactly this factor. */
  zoomFactor: () => number
  /** Resolves once the viewer session is fit to use (its persistent storage
   * emptied at this boundary). `false` keeps the viewer unavailable. */
  ready?: () => Promise<boolean>
}

/** Chromium's built-in PDF viewer: the only extension the viewer session may load. */
export const CHROMIUM_PDF_VIEWER_EXTENSION_ID = 'mhjfbmdgcfjbbpaeojofohoefgiehjai'

export interface PdfViewSessionLike {
  on: (event: 'will-download', listener: (event: { preventDefault: () => void }) => void) => void
  setDevicePermissionHandler?: (handler: () => boolean) => void
  setPermissionCheckHandler: (handler: () => boolean) => void
  setPermissionRequestHandler: (handler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void) => void
  webRequest: {
    onBeforeRequest: (
      filter: { urls: string[] },
      listener: (details: { resourceType: string; url: string }, callback: (response: { cancel?: boolean }) => void) => void
    ) => void
  }
}

/** Keep the dedicated viewer partition empty at startup and account teardown;
 * a failed clear must keep placement unavailable. */
export async function clearPdfViewSessionStorage(
  viewerSession: { clearStorageData(): Promise<void>; clearCache(): Promise<void> },
  onFailure: (reason: unknown) => void = () => {}
): Promise<boolean> {
  const results = await Promise.allSettled([viewerSession.clearStorageData(), viewerSession.clearCache()])
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')

  for (const failure of failures) {
    onFailure(failure.reason)
  }

  return failures.length === 0
}

/**
 * The viewer's session policy, installed once. A document tab shows one file
 * and reaches nothing else: no permissions, no downloads (Chromium's toolbar
 * would otherwise save a copy), and a request filter that admits only the
 * files currently being served, the PDF extension's own resources, Chromium's
 * internal `chrome://resources` bundle the viewer imports, and the inert
 * schemes sub-resources use.
 */
export function hardenPdfViewSession(
  session: PdfViewSessionLike,
  isServedFile: (fileUrl: string) => boolean
): void {
  session.setPermissionCheckHandler(() => false)
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setDevicePermissionHandler?.(() => false)
  session.on('will-download', event => event.preventDefault())
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    let allowed = false

    try {
      const parsed = new URL(details.url)

      allowed =
        (parsed.protocol === 'file:' && isServedFile(parsed.href)) ||
        (parsed.protocol === 'chrome-extension:' && parsed.hostname === CHROMIUM_PDF_VIEWER_EXTENSION_ID) ||
        // Chromium's built-in WebUI bundle (lit, mojo bindings, load_time_data,
        // the default stylesheet). The viewer's frame imports it and draws
        // only its grey background without it. Internal, never the network;
        // scripts and styles, never a frame.
        (parsed.protocol === 'chrome:' &&
          parsed.hostname === 'resources' &&
          details.resourceType !== 'mainFrame' &&
          details.resourceType !== 'subFrame') ||
        (details.resourceType !== 'mainFrame' && ['about:', 'blob:', 'data:'].includes(parsed.protocol))
    } catch {
      allowed = false
    }

    callback(allowed ? {} : { cancel: true })
  })
}

/** Views are cheap to recreate and expensive to leak; keep the ceiling low. */
export const ATUM_PDF_VIEW_MAX = 6

/** Electron 41+ renders PDFs in an OOPIF. That one Chromium-owned extension
 * frame must navigate for the document to paint; every other frame remains a
 * browser-capable escape and is denied. */
export function isAllowedPdfFrameNavigation(input: { isMainFrame: boolean; url: string }): boolean {
  if (input.isMainFrame) {
    return false
  }

  try {
    const url = new URL(input.url)

    return url.protocol === 'chrome-extension:' && url.hostname === CHROMIUM_PDF_VIEWER_EXTENSION_ID
  } catch {
    return false
  }
}

/**
 * Chromium's PDF viewer implements the PDF open parameters itself. Keep these
 * on the source URL so the first painted page is useful instead of inheriting
 * the last document's zoom/sidebar state from Chromium's persistent viewer.
 * The viewer still owns its hamburger control after it has opened.
 */
function preferredPdfViewerUrl(fileUrl: string): string {
  const url = new URL(fileUrl)
  const parameters = new URLSearchParams(url.hash.slice(1))

  parameters.set('view', 'Fit')
  parameters.set('navpanes', '0')
  url.hash = parameters.toString()

  return url.toString()
}

function pdfSourceUrl(url: string): string {
  const parsed = new URL(url)
  parsed.hash = ''

  return parsed.toString()
}

function sanitizeBounds(input: unknown): AtumPdfViewBounds | null {
  if (!input || typeof input !== 'object') {
    return null
  }

  const source = input as Record<string, unknown>
  const numbers = ['x', 'y', 'width', 'height'].map(key => Number(source[key]))

  if (numbers.some(value => !Number.isFinite(value))) {
    return null
  }

  const [x, y, width, height] = numbers as [number, number, number, number]

  if (width <= 0 || height <= 0) {
    return null
  }

  return { height: Math.round(height), width: Math.round(width), x: Math.round(x), y: Math.round(y) }
}

export class AtumPdfViewController {
  private readonly views = new Map<string, { generation: number; loading: Promise<boolean> | null; url: string; view: PdfViewLike }>()
  private readonly attached = new Set<string>()

  constructor(private readonly deps: AtumPdfViewDeps) {}

  /**
   * Place the viewer for `token` at `bounds`, creating it on first use. Bounds
   * are clamped to the window so a stale rect cannot paint over the whole app.
   */
  async show(rawToken: unknown, rawBounds: unknown): Promise<{ shown: boolean }> {
    const token = String(rawToken ?? '')
    const bounds = sanitizeBounds(rawBounds)
    const host = this.deps.host()

    if (!token || !bounds || !host || host.isDestroyed()) {
      // A refusal promises the renderer nothing is attached for this token.
      this.hide(token)

      return { shown: false }
    }

    if (this.deps.ready && !(await this.deps.ready())) {
      this.hide(token)

      return { shown: false }
    }

    const target = this.deps.resolvePath(token)

    if (!target) {
      this.close(token)

      return { shown: false }
    }

    let record = this.views.get(token)

    if (!record) {
      if (this.views.size >= ATUM_PDF_VIEW_MAX) {
        // Evict a view nobody is looking at before one that is on screen.
        const tokens = [...this.views.keys()]
        const victim = tokens.find(candidate => !this.attached.has(candidate)) ?? tokens[0]

        if (victim !== undefined) {
          this.close(victim)
        }
      }

      const view = this.deps.createView()
      // A document, not a browser: it shows one file and goes nowhere — not by
      // the outer frame and not by the viewer's inner frame either.
      const deny = ((event: { preventDefault: () => void }) => event.preventDefault()) as never
      const denyUnexpectedFrame = ((event: { isMainFrame: boolean; preventDefault: () => void; url: string }) => {
        if (!isAllowedPdfFrameNavigation(event)) {
          event.preventDefault()
        }
      }) as never
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      view.webContents.on('will-navigate', deny)
      view.webContents.on('will-frame-navigate', denyUnexpectedFrame)
      record = { generation: 0, loading: null, url: preferredPdfViewerUrl(this.deps.pathToUrl(target)), view }
      this.views.set(token, record)
      record.loading = this.load(token, record)
    }

    // A `hide` while the load is in flight must win: the overlay that asked
    // for it is on screen now, and the pending show must not paint over it.
    const generation = record.generation

    if (record.loading && !(await record.loading)) {
      return { shown: false }
    }

    if (record.generation !== generation) {
      return { shown: false }
    }

    // `close`, account revocation, or a failed load can replace/remove the
    // record while its load promise settles. Never attach that stale view.
    if (this.views.get(token) !== record || record.view.webContents.isDestroyed() || host.isDestroyed()) {
      return { shown: false }
    }

    const view = record.view

    if (!this.attached.has(token)) {
      host.contentView.addChildView(view)
      this.attached.add(token)
    }

    view.setBounds(clamp(scale(bounds, this.deps.zoomFactor()), host.getContentSize()))
    view.setVisible(true)

    return { shown: true }
  }

  /** Whether `fileUrl` is a document a live view was told to load. The
   * session filter consults this so nothing else can be fetched over file:. */
  isServing(fileUrl: string): boolean {
    let candidate: string

    try {
      candidate = pdfSourceUrl(fileUrl)
    } catch {
      return false
    }

    for (const [token, record] of this.views) {
      if (pdfSourceUrl(record.url) === candidate) {
        // Chromium can ask for later ranges after first paint. The original
        // URL alone is not authority if the selected inode/grant was revoked.
        const current = this.deps.resolvePath(token)

        if (current && pdfSourceUrl(this.deps.pathToUrl(current)) === candidate) {
          return true
        }
      }
    }

    return false
  }

  /** Detach without destroying: the tab is off-screen but may come back. */
  hide(rawToken: unknown): void {
    const token = String(rawToken ?? '')
    const record = this.views.get(token)

    if (!record) {
      return
    }

    record.generation += 1
    const { view } = record
    view.setVisible(false)
    this.detach(token, view)
  }

  close(rawToken: unknown): void {
    const token = String(rawToken ?? '')
    const record = this.views.get(token)

    if (!record) {
      return
    }

    this.closeRecord(token, record)
  }

  private async load(token: string, record: { generation: number; loading: Promise<boolean> | null; url: string; view: PdfViewLike }): Promise<boolean> {
    try {
      await record.view.webContents.loadURL(record.url)
    } catch {
      // A blank main-owned view is worse than the renderer's ordinary
      // fallback. Only tear down this exact candidate: a new token record
      // must never be closed by an older failed load.
      if (this.views.get(token) === record) {
        this.closeRecord(token, record)
      }

      return false
    }

    return this.views.get(token) === record && !record.view.webContents.isDestroyed()
  }

  private closeRecord(token: string, record: { generation: number; loading: Promise<boolean> | null; url: string; view: PdfViewLike }): void {
    const { view } = record
    this.detach(token, view)
    this.views.delete(token)

    if (!view.webContents.isDestroyed()) {
      view.webContents.close()
    }
  }

  closeAll(): void {
    for (const token of [...this.views.keys()]) {
      this.close(token)
    }
  }

  private detach(token: string, view: PdfViewLike): void {
    if (!this.attached.has(token)) {
      return
    }

    this.attached.delete(token)
    const host = this.deps.host()

    if (host && !host.isDestroyed()) {
      host.contentView.removeChildView(view)
    }
  }
}

/** CSS px → DIP. A factor that is not a sane positive number is treated as 1. */
function scale(bounds: AtumPdfViewBounds, factor: number): AtumPdfViewBounds {
  const z = Number.isFinite(factor) && factor > 0 ? factor : 1

  return {
    height: Math.round(bounds.height * z),
    width: Math.round(bounds.width * z),
    x: Math.round(bounds.x * z),
    y: Math.round(bounds.y * z)
  }
}

function clamp(bounds: AtumPdfViewBounds, [hostWidth, hostHeight]: [number, number]): AtumPdfViewBounds {
  const x = Math.max(0, Math.min(bounds.x, Math.max(0, hostWidth - 1)))
  const y = Math.max(0, Math.min(bounds.y, Math.max(0, hostHeight - 1)))

  return {
    height: Math.max(1, Math.min(bounds.height, hostHeight - y)),
    width: Math.max(1, Math.min(bounds.width, hostWidth - x)),
    x,
    y
  }
}

export function registerAtumPdfViewIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  controller: AtumPdfViewController,
  assertTrustedSender: (event: IpcMainInvokeEvent) => void
): void {
  ipcMain.handle(ATUM_PDF_VIEW_IPC_CHANNELS.show, (event, token: unknown, bounds: unknown) => {
    assertTrustedSender(event)

    return controller.show(token, bounds)
  })
  ipcMain.handle(ATUM_PDF_VIEW_IPC_CHANNELS.hide, (event, token: unknown) => {
    assertTrustedSender(event)
    controller.hide(token)
  })
  ipcMain.handle(ATUM_PDF_VIEW_IPC_CHANNELS.close, (event, token: unknown) => {
    assertTrustedSender(event)
    controller.close(token)
  })
}

export { ATUM_FILE_VIEW_PARTITION }
