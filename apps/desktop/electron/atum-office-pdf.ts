import { randomBytes } from 'node:crypto'

import { app, BrowserWindow, session, type Session } from 'electron'

const PDF_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'"
const DEFAULT_LOAD_TIMEOUT_MS = 10_000
const DEFAULT_PRINT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_QUEUE_LENGTH = 8

export type AtumOfficePdfStage = 'load' | 'fonts' | 'print'

export class AtumOfficePdfError extends Error {
  constructor(
    readonly stage: AtumOfficePdfStage,
    message: string
  ) {
    super(message)
    this.name = 'AtumOfficePdfError'
  }
}

interface PdfJob {
  html: string
  /** Page box in inches, from the pinned theme. The only geometry authority. */
  page: { width: number; height: number; margins: { top: number; right: number; bottom: number; left: number } }
  ownerId?: string
  reject: (reason: unknown) => void
  resolve: (bytes: Uint8Array) => void
  title: string
}

interface PdfWindow {
  destroy(): void
  isDestroyed(): boolean
  loadURL(url: string): Promise<void>
  webContents: Electron.WebContents
}

interface PdfPrinterDependencies {
  createWindow?: (options: Electron.BrowserWindowConstructorOptions) => PdfWindow
  fromPartition?: (partition: string) => Session
  loadTimeoutMs?: number
  maxQueueLength?: number
  printTimeoutMs?: number
}

function withCsp(html: string): string {
  if (/http-equiv\s*=\s*["']Content-Security-Policy["']/iu.test(html)) {
    return html
  }

  const meta = `<meta http-equiv="Content-Security-Policy" content="${PDF_CSP}">`

  if (/<head(?:\s[^>]*)?>/iu.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/iu, match => `${match}${meta}`)
  }

  if (/<html(?:\s[^>]*)?>/iu.test(html)) {
    return html.replace(/<html(?:\s[^>]*)?>/iu, match => `${match}<head>${meta}</head>`)
  }

  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`
}

function stageError(stage: AtumOfficePdfStage, reason: unknown): AtumOfficePdfError {
  if (reason instanceof AtumOfficePdfError) {
    return reason
  }

  return new AtumOfficePdfError(stage, reason instanceof Error ? reason.message : String(reason))
}

export class AtumOfficePdfPrinter {
  private active: { cancel: (reason: unknown) => void; ownerId?: string; window: PdfWindow } | null = null
  private readonly queue: PdfJob[] = []
  private shuttingDown = false

  constructor(private readonly dependencies: PdfPrinterDependencies = {}) {
    app.once('before-quit', () => {
      this.shuttingDown = true
      this.cancelAll('APP_QUITTING')
    })
  }

  render(input: {
    html: string
    ownerId?: string
    title: string
    /**
     * The page box, in inches, derived from the pinned theme. This is the ONLY
     * page-geometry authority: the print stylesheet deliberately carries no
     * `@page` rule, so there is nothing for Chromium to resolve against these
     * options and no CSS page size that could make it silently rescale the
     * document to fit.
     */
    page: { width: number; height: number; margins: { top: number; right: number; bottom: number; left: number } }
  }): Promise<Uint8Array> {
    if (this.shuttingDown) {
      return Promise.reject(new AtumOfficePdfError('load', 'APP_QUITTING'))
    }

    if (this.queue.length + (this.active ? 1 : 0) >= (this.dependencies.maxQueueLength ?? DEFAULT_MAX_QUEUE_LENGTH)) {
      return Promise.reject(new AtumOfficePdfError('load', 'PDF_QUEUE_FULL'))
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      this.queue.push({ ...input, reject, resolve })
      this.drain()
    })
  }

  cancelAll(reason: string): void {
    const error = new AtumOfficePdfError('load', reason)

    for (const job of this.queue.splice(0)) {
      job.reject(error)
    }

    this.active?.cancel(error)
  }

  /** Cancel only the jobs that belong to one owner (a destroyed window); other owners keep their place. */
  cancelOwner(ownerId: string, reason: string): void {
    const error = new AtumOfficePdfError('load', reason)
    const remaining = this.queue.filter(job => job.ownerId !== ownerId)
    const cancelled = this.queue.filter(job => job.ownerId === ownerId)
    this.queue.splice(0, this.queue.length, ...remaining)

    for (const job of cancelled) {
      job.reject(error)
    }

    if (this.active?.ownerId === ownerId) {
      this.active.cancel(error)
    }
  }

  private drain(): void {
    if (this.active || this.shuttingDown) {
      return
    }

    const job = this.queue.shift()

    if (!job) {
      return
    }

    void this.run(job).finally(() => {
      this.active = null
      this.drain()
    })
  }

  private async run(job: PdfJob): Promise<void> {
    let settledJob = false

    const settle = (outcome: { bytes?: Uint8Array; error?: unknown }) => {
      if (settledJob) {
        return
      }

      settledJob = true
      outcome.error === undefined && outcome.bytes ? job.resolve(outcome.bytes) : job.reject(outcome.error)
    }

    let win: PdfWindow | null = null
    let browserSession: Session | null = null
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const disposers: Array<() => void> = []

    const deadline = (ms: number, error: AtumOfficePdfError) =>
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(error), ms)
        timers.add(timer)
      })

    let cancelActive: (reason: unknown) => void = () => undefined

    const cancelled = new Promise<never>((_resolve, reject) => {
      cancelActive = reason => {
        if (win && !win.isDestroyed()) {
          win.destroy()
        }

        reject(reason)
      }
    })

    // Every branch of the race below is observed here, so a losing rejection is never unhandled.
    cancelled.catch(() => undefined)

    try {
      const partition = `atum-office-pdf:${randomBytes(16).toString('hex')}`
      browserSession = (this.dependencies.fromPartition ?? session.fromPartition)(partition)
      const createWindow = this.dependencies.createWindow ?? (options => new BrowserWindow(options))
      win = createWindow({
        show: false,
        webPreferences: {
          contextIsolation: true,
          devTools: false,
          nodeIntegration: false,
          sandbox: true,
          spellcheck: false,
          webSecurity: true,
          webviewTag: false,
          session: browserSession
        }
      })
      const window = win
      let currentStage: AtumOfficePdfStage = 'load'
      this.active = { cancel: cancelActive, ownerId: job.ownerId, window }

      const onGone = (_event: unknown, details: { reason: string }) => {
        cancelActive(new AtumOfficePdfError(currentStage, `PDF_RENDER_PROCESS_GONE:${details.reason}`))
      }

      window.webContents.once('render-process-gone', onGone)
      disposers.push(() => window.webContents.removeListener('render-process-gone', onGone))

      browserSession.setPermissionCheckHandler(() => false)
      browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      browserSession.on('will-download', event => event.preventDefault())

      const securedHtml = withCsp(job.html)
      const dataUrl = `data:text/html;base64,${Buffer.from(securedHtml, 'utf8').toString('base64')}`
      browserSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
        callback(details.url === dataUrl ? {} : { cancel: true })
      })
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      let authorizedLoad = true
      window.webContents.on('will-navigate', (event, url) => {
        if (authorizedLoad && url === dataUrl) {
          authorizedLoad = false

          return
        }

        event.preventDefault()
      })
      window.webContents.on('will-redirect', event => event.preventDefault())

      const loadTimeoutMs = this.dependencies.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS
      const printTimeoutMs = this.dependencies.printTimeoutMs ?? DEFAULT_PRINT_TIMEOUT_MS

      await Promise.race([
        new Promise<void>((resolve, reject) => {
          let done = false

          const finish = (error?: unknown) => {
            if (done) {
              return
            }

            done = true
            window.webContents.removeListener('did-finish-load', loaded)
            window.webContents.removeListener('did-fail-load', failed)
            error ? reject(error) : resolve()
          }

          const loaded = () => finish()

          const failed = (_event: unknown, code: number, description: string) =>
            finish(new AtumOfficePdfError('load', `PDF_LOAD_FAILED:${code}:${description}`))

          window.webContents.once('did-finish-load', loaded)
          window.webContents.once('did-fail-load', failed)
          disposers.push(() => {
            window.webContents.removeListener('did-finish-load', loaded)
            window.webContents.removeListener('did-fail-load', failed)
          })
          cancelled.catch(finish)
          void window.loadURL(dataUrl).catch(error => finish(stageError('load', error)))
        }),
        deadline(loadTimeoutMs, new AtumOfficePdfError('load', 'PDF_LOAD_TIMEOUT')),
        cancelled
      ])

      currentStage = 'fonts'
      await Promise.race([
        window.webContents
          .executeJavaScript('document.fonts.ready.then(() => true)')
          .catch(error => Promise.reject(stageError('fonts', error))),
        deadline(loadTimeoutMs, new AtumOfficePdfError('fonts', 'PDF_FONTS_TIMEOUT')),
        cancelled
      ])

      currentStage = 'print'

      const bytes = await Promise.race([
        window.webContents.printToPDF({
          // Inches. `marginType` is not read by printToPDF at all, and the
          // named 'A4' is 210.058 x 297.18 mm rather than 210 x 297, so the
          // paper is given explicitly from the same millimetres the Word
          // writer uses.
          margins: {
            bottom: job.page.margins.bottom,
            left: job.page.margins.left,
            right: job.page.margins.right,
            top: job.page.margins.top
          },
          pageSize: { height: job.page.height, width: job.page.width },
          printBackground: true
        }),
        deadline(printTimeoutMs, new AtumOfficePdfError('print', 'PDF_PRINT_TIMEOUT')),
        cancelled
      ]).catch(error => Promise.reject(stageError('print', error)))

      settle({ bytes: new Uint8Array(bytes) })
    } catch (error) {
      settle({ error: stageError('load', error) })
    } finally {
      for (const timer of timers) {
        clearTimeout(timer)
      }

      timers.clear()

      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // Listener already gone with the window.
        }
      }

      if (win && !win.isDestroyed()) {
        win.destroy()
      }

      await browserSession?.clearCache().catch(() => undefined)
      settle({ error: new AtumOfficePdfError('load', 'PDF_JOB_ABANDONED') })
    }
  }
}

export const ATUM_OFFICE_PDF_CSP = PDF_CSP
