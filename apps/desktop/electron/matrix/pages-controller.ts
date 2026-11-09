/**
 * Native authority for the bundled Hermes management pages.  The chat renderer
 * can position and dismiss this view, but it never receives its runtime
 * location or REST capability.  The guest receives only the narrow preload
 * bridge below.
 */

import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { type BrowserWindow, ipcMain, type WebContents, WebContentsView, type WebFrameMain } from 'electron'

import { clampBrowserBounds, scaleBrowserBounds } from '../../shared/browser/policy'
import {
  MATRIX_PAGES_IPC,
  type MatrixPagesContext,
  type MatrixPagesOpenInput,
  type MatrixPagesRequest,
  type MatrixPagesState
} from '../../shared/matrix-pages'
import { ATUM_SHELL_HEADER_HEIGHT } from '../atum-window-mode'

/** Runtime ownership stays in main.  `key` is opaque to this controller so
 * the composition root can bind it to account generation and executor state. */
export interface Scope {
  key: string
  context: MatrixPagesContext
}

export interface MatrixPagesControllerDeps {
  window: () => BrowserWindow | undefined
  /** The one Matrix chat webContents allowed to control the native view. */
  uiContents: () => WebContents | undefined
  /** Exact local Matrix UI document expected in that chat main frame. */
  uiUrl: string
  /** Absolute path to the packaged, bundled management-page entrypoint. */
  pagesFile: string
  /** Absolute path to the dedicated, capability-limited preload. */
  preload: string
  resolve: (input: MatrixPagesOpenInput) => Promise<Scope> | Scope
  /** Rechecks account/generation/agent validity at every async boundary. */
  isCurrent: (scope: Scope) => boolean
  /** Retire transient management operations before closing their native view. */
  retired?: (scope: Scope) => void
  request: (scope: Scope, request: MatrixPagesRequest) => Promise<unknown>
  readMedia: (scope: Scope, path: string) => Promise<string>
  openExternal: (url: string) => Promise<void>
  /** Every open's result, success or the error code, for one main.log line (pages-open-log.ts). */
  opened?: (input: MatrixPagesOpenInput, result: { viewId: string } | { error: string }, ms: number) => void
}

interface IpcEvent {
  sender: WebContents
  senderFrame: WebFrameMain
}

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

interface Record {
  viewId: string
  scope: Scope
  view: WebContentsView
  bounds: Bounds | null
  visible: boolean
  overlayActive: boolean
  attached: boolean
  closing: boolean
  status: MatrixPagesState['status']
  error?: string
  /** The sole local-file navigation may consume this permission once. */
  initialNavigationAllowed: boolean
  navigatingConnections?: boolean
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : 'matrix_pages_failed')

/** A standalone WebContentsView rather than a renderer webview: its owner is
 * main, it has an ephemeral partition, and no navigation survives its initial
 * bundled file load. */
export class MatrixPagesController {
  private readonly pageUrl: string
  private readonly boundWindows = new WeakSet<BrowserWindow>()
  private current: Record | undefined
  private opening = 0
  private registered = false
  private disposed = false

  constructor(private readonly deps: MatrixPagesControllerDeps) {
    this.pageUrl = pathToFileURL(deps.pagesFile).href
  }

  acceptsDiagnostics(event: { sender: unknown; senderFrame: unknown }): boolean {
    try {
      this.requirePageRecord(event as IpcEvent)

      return true
    } catch {
      return false
    }
  }

  register(): void {
    if (this.registered || this.disposed) {
      return
    }

    this.registered = true
    const ipcMain = this.ipcMain()
    ipcMain.handle(MATRIX_PAGES_IPC.open, async (event: IpcEvent, input: MatrixPagesOpenInput) => {
      const started = Date.now()

      const result = await this.guarded(() => {
        this.requireChat(event)

        return this.open(input)
      })

      try {
        this.deps.opened?.(input, result, Date.now() - started)
      } catch {
        // Reporting never changes what the chat receives.
      }

      return result
    })
    ipcMain.handle(MATRIX_PAGES_IPC.bounds, (event: IpcEvent, input: { viewId: string; bounds: Bounds }) =>
      this.guarded(() => {
        this.requireChat(event)
        const record = this.requireChatRecord(input?.viewId)
        record.bounds = this.clamp(input.bounds)
        this.applyLayout(record)

        return { ok: true }
      })
    )
    ipcMain.handle(
      MATRIX_PAGES_IPC.visibility,
      (event: IpcEvent, input: { viewId: string; visible: boolean; overlayActive: boolean }) =>
        this.guarded(() => {
          this.requireChat(event)
          const record = this.requireChatRecord(input?.viewId)

          if (typeof input.visible !== 'boolean' || typeof input.overlayActive !== 'boolean') {
            throw new Error('matrix_pages_visibility_invalid')
          }

          record.visible = input.visible
          record.overlayActive = input.overlayActive
          this.applyLayout(record)

          return { ok: true }
        })
    )
    ipcMain.handle(MATRIX_PAGES_IPC.focus, (event: IpcEvent, viewId: string) =>
      this.guarded(() => {
        this.requireChat(event)
        const record = this.requireChatRecord(viewId)
        record.view.webContents.focus()

        return { ok: true }
      })
    )
    ipcMain.handle(MATRIX_PAGES_IPC.close, (event: IpcEvent, viewId: string) =>
      this.guarded(() => {
        this.requireChat(event)
        this.destroy(this.requireChatRecord(viewId))

        return { ok: true }
      })
    )
    ipcMain.handle(MATRIX_PAGES_IPC.context, (event: IpcEvent) =>
      this.guarded(() => this.requirePageRecord(event).scope.context)
    )
    ipcMain.handle(MATRIX_PAGES_IPC.navigateConnections, (event: IpcEvent, page: unknown) =>
      this.guarded(async () => {
        const record = this.requirePageRecord(event)
        const previous = record.scope

        if (
          !['connections', 'providers'].includes(previous.context.page) ||
          (page !== 'connections' && page !== 'providers') ||
          page === previous.context.page
        ) {
          throw new Error('matrix_pages_request_forbidden')
        }

        // Retire old approvals immediately; the guest cannot promote its own surface
        // by changing a React view or submitting a marker with an OAuth request.
        record.navigatingConnections = true
        this.deps.retired?.(previous)

        try {
          const next = await this.deps.resolve({
            page,
            agentPrincipal: previous.context.agentPrincipal,
            locale: previous.context.locale,
            appearance: previous.context.appearance
          })

          if (
            this.current !== record ||
            record.closing ||
            this.disposed ||
            record.view.webContents.isDestroyed() ||
            !this.deps.isCurrent(previous) ||
            !this.deps.isCurrent(next) ||
            next.context.page !== page ||
            next.context.agentPrincipal !== previous.context.agentPrincipal
          ) {
            throw new Error('matrix_pages_unavailable')
          }

          record.scope = next
          record.navigatingConnections = false
          this.requireCurrent(record)

          return next.context
        } catch {
          this.destroy(record)
          throw new Error('matrix_pages_unavailable')
        }
      })
    )
    ipcMain.handle(MATRIX_PAGES_IPC.dismiss, (event: IpcEvent) =>
      this.guarded(() => {
        this.destroy(this.requirePageRecord(event))
      })
    )
    ipcMain.handle(MATRIX_PAGES_IPC.api, (event: IpcEvent, request: MatrixPagesRequest) =>
      this.guarded(async () => {
        const record = this.requirePageRecord(event)
        const scope = record.scope
        const response = await this.deps.request(scope, request)
        this.requireCurrent(record)

        if (record.scope !== scope) {
          throw new Error('matrix_pages_unavailable')
        }

        return response
      })
    )
    ipcMain.handle(MATRIX_PAGES_IPC.media, (event: IpcEvent, mediaPath: string) =>
      this.guarded(async () => {
        const record = this.requirePageRecord(event)
        const scope = record.scope
        const response = await this.deps.readMedia(scope, mediaPath)
        this.requireCurrent(record)

        if (record.scope !== scope) {
          throw new Error('matrix_pages_unavailable')
        }

        return response
      })
    )
    ipcMain.handle(MATRIX_PAGES_IPC.external, (event: IpcEvent, url: string) =>
      this.guarded(async () => {
        const record = this.requirePageRecord(event)
        await this.deps.openExternal(url)
        this.requireCurrent(record)
      })
    )
  }

  /** Opens a new page and synchronously invalidates an older in-flight open. */
  async open(input: MatrixPagesOpenInput): Promise<{ viewId: string }> {
    this.assertUsable()
    const opening = ++this.opening

    if (this.current) {
      this.destroy(this.current)
    }

    const scope = await this.deps.resolve(input)

    if (opening !== this.opening || this.disposed || !this.deps.isCurrent(scope)) {
      throw new Error('matrix_pages_unavailable')
    }

    const record = this.create(scope)
    this.current = record
    this.emit(record, { status: 'loading' })

    try {
      await record.view.webContents.loadURL(this.pageUrl)
      record.initialNavigationAllowed = false
      this.requireCurrent(record)
      this.emit(record, { status: 'ready' })
    } catch (error) {
      record.initialNavigationAllowed = false

      if (this.isCurrent(record)) {
        this.emit(record, { status: 'error', error: errorMessage(error) })
      }

      this.destroy(record)

      throw new Error('matrix_pages_load_failed')
    }

    this.requireCurrent(record)

    return { viewId: record.viewId }
  }

  /** Account sign-out/runtime teardown.  This never stops the shared executor. */
  clearAll(): void {
    ++this.opening

    if (this.current) {
      this.destroy(this.current)
    }
  }

  /** Retiring or switching one agent only tears down that agent's page. */
  clearAgent(principal: string): void {
    if (this.current?.scope.context.agentPrincipal === principal) {
      this.clearAll()
    }
  }

  state(): MatrixPagesState | undefined {
    const record = this.current

    return record ? this.stateFor(record) : undefined
  }

  /** A live account alone is insufficient for a pending page-originated approval. */
  ownsScope(scope: Scope): boolean {
    const record = this.current

    return Boolean(record && record.scope === scope && this.isCurrent(record))
  }

  dispose(): void {
    if (this.disposed) {
      return
    }

    this.disposed = true
    this.clearAll()

    if (this.registered) {
      for (const channel of Object.values(MATRIX_PAGES_IPC)) {
        this.ipcMain().removeHandler(channel)
      }

      this.registered = false
    }
  }

  private ipcMain(): {
    handle: (channel: string, listener: (...args: any[]) => unknown) => void
    removeHandler: (channel: string) => void
  } {
    return ipcMain
  }

  private create(scope: Scope): Record {
    const viewId = `matrix-pages-${randomUUID()}`

    const view = new WebContentsView({
      webPreferences: {
        partition: `matrix-pages-${randomUUID()}`,
        preload: this.deps.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        navigateOnDragDrop: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false
      }
    })

    const record: Record = {
      viewId,
      scope,
      view,
      bounds: null,
      visible: false,
      overlayActive: false,
      attached: false,
      closing: false,
      status: 'loading',
      initialNavigationAllowed: true
    }

    const contents = view.webContents
    const pageUrl = this.pageUrl

    contents.session.setPermissionCheckHandler(() => false)
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    contents.session.setDevicePermissionHandler?.(() => false)
    contents.on('will-navigate', (event: { preventDefault: () => void }, rawUrl: string) => {
      if (record.initialNavigationAllowed && rawUrl === pageUrl) {
        return
      }

      event.preventDefault()
    })
    contents.on('will-frame-navigate', ((
      event: { preventDefault: () => void },
      rawUrl: string,
      _inPlace: boolean,
      isMainFrame: boolean
    ) => {
      if (record.initialNavigationAllowed && isMainFrame && rawUrl === pageUrl) {
        return
      }

      event.preventDefault()
    }) as never)
    contents.on('will-redirect', (event: { preventDefault: () => void }) => event.preventDefault())
    contents.on('will-prevent-unload', (event: { preventDefault: () => void }) => event.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-attach-webview', (event: { preventDefault: () => void }) => event.preventDefault())
    contents.on('context-menu', (event: { preventDefault: () => void }) => event.preventDefault())
    contents.on(
      'did-fail-load',
      (_event: unknown, code: number, _description: string, _url: string, isMainFrame: boolean) => {
        if (isMainFrame && code !== -3 && this.isCurrent(record)) {
          this.emit(record, { status: 'error', error: 'load_failed' })
        }
      }
    )
    contents.on('render-process-gone', () => {
      if (this.isCurrent(record)) {
        this.emit(record, { status: 'error', error: 'load_failed' })
      }

      this.destroy(record)
    })
    contents.on('destroyed', () => {
      this.destroy(record)
    })

    const window = this.deps.window()

    if (window && !window.isDestroyed() && !this.boundWindows.has(window)) {
      this.boundWindows.add(window)
      window.once('closed', () => this.clearAll())
    }

    return record
  }

  private clamp(bounds: Bounds): Bounds {
    const window = this.deps.window()

    if (!window || window.isDestroyed()) {
      throw new Error('matrix_pages_host_unavailable')
    }

    const clamped = clampBrowserBounds(
      scaleBrowserBounds(bounds, this.deps.uiContents()?.getZoomFactor() ?? 1),
      window.getContentBounds()
    )

    const y = Math.max(clamped.y, ATUM_SHELL_HEADER_HEIGHT)

    return { x: clamped.x, y, width: clamped.width, height: Math.max(0, clamped.height - (y - clamped.y)) }
  }

  private applyLayout(record: Record): void {
    const window = this.deps.window()

    if (!window || window.isDestroyed() || record.closing) {
      return
    }

    const attach = record.visible && !record.overlayActive && record.bounds !== null && this.isCurrent(record)

    if (attach) {
      if (!record.attached) {
        window.contentView.addChildView(record.view)
        record.attached = true
      }

      record.view.setBounds(record.bounds!)
      record.view.setVisible(true)
    } else if (record.attached) {
      record.view.setVisible(false)
      window.contentView.removeChildView(record.view)
      record.attached = false
    }
  }

  private destroy(record: Record): void {
    if (record.closing) {
      return
    }

    record.closing = true

    if (this.current === record) {
      this.current = undefined
    }

    this.deps.retired?.(record.scope)

    const window = this.deps.window()

    if (record.attached && window && !window.isDestroyed()) {
      try {
        record.view.setVisible(false)
        window.contentView.removeChildView(record.view)
      } catch {
        // The host can be concurrently closing.
      }
    }

    record.attached = false

    if (!record.view.webContents.isDestroyed()) {
      try {
        record.view.webContents.close({ waitForBeforeUnload: false })
      } catch {
        // Removing the record has already revoked all controller authority.
      }
    }

    this.emit(record, { status: 'destroyed' })
  }

  private requireChat(event: IpcEvent): void {
    const ui = this.deps.uiContents()

    if (
      this.disposed ||
      !ui ||
      event.sender !== ui ||
      event.senderFrame !== ui.mainFrame ||
      ui.mainFrame.url !== this.deps.uiUrl ||
      event.sender.getURL() !== this.deps.uiUrl
    ) {
      throw new Error('matrix_pages_sender_invalid')
    }
  }

  private requireChatRecord(viewId: unknown): Record {
    const record = this.current

    if (record && !this.isCurrent(record)) {
      this.destroy(record)
    }

    if (typeof viewId !== 'string' || !record || record.viewId !== viewId || !this.isCurrent(record)) {
      throw new Error('matrix_pages_view_invalid')
    }

    return record
  }

  private requirePageRecord(event: IpcEvent): Record {
    const record = this.current

    if (record?.navigatingConnections) {
      throw new Error('matrix_pages_busy')
    }

    if (record && !this.isCurrent(record)) {
      this.destroy(record)
    }

    const contents = record?.view.webContents

    if (
      !record ||
      !contents ||
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame ||
      contents.mainFrame.url !== this.pageUrl ||
      event.sender.getURL() !== this.pageUrl ||
      !this.isCurrent(record)
    ) {
      throw new Error('matrix_pages_sender_invalid')
    }

    return record
  }

  private requireCurrent(record: Record): void {
    if (!this.isCurrent(record)) {
      throw new Error('matrix_pages_unavailable')
    }
  }

  private isCurrent(record: Record): boolean {
    return (
      !this.disposed &&
      !record.closing &&
      !record.navigatingConnections &&
      this.current === record &&
      !record.view.webContents.isDestroyed() &&
      this.deps.isCurrent(record.scope)
    )
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new Error('matrix_pages_unavailable')
    }
  }

  private stateFor(record: Record): MatrixPagesState {
    return {
      viewId: record.viewId,
      status: record.status,
      ...(record.error === undefined ? {} : { error: record.error })
    }
  }

  private emit(record: Record, next: Omit<MatrixPagesState, 'viewId'>): void {
    record.status = next.status
    record.error = next.error
    const ui = this.deps.uiContents()

    if (ui && !ui.isDestroyed()) {
      ui.send(MATRIX_PAGES_IPC.state, { viewId: record.viewId, ...next })
    }
  }

  private guarded<T>(work: () => T | Promise<T>): Promise<{ error: string } | T> {
    return Promise.resolve()
      .then(work)
      .catch(error => ({ error: errorMessage(error) }))
  }
}
