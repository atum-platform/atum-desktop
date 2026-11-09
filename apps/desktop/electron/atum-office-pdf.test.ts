import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { beforeEach, test, vi } from 'vitest'

const electronMock = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>()

  return {
    app: {
      emit(event: string, ...args: unknown[]) {
        return listeners.get(event)?.(...args)
      },
      once(event: string, callback: (...args: unknown[]) => void) {
        listeners.set(event, callback)
      },
      removeAllListeners() {
        listeners.clear()
      }
    }
  }
})

vi.mock('electron', () => ({
  app: electronMock.app,
  BrowserWindow: class {},
  session: { fromPartition: vi.fn() }
}))

import { ATUM_OFFICE_PDF_CSP, type AtumOfficePdfError, AtumOfficePdfPrinter } from './atum-office-pdf'

/** A4 with uniform 25.4 mm margins, in inches — what the default theme resolves to. */
const PAGE = {
  height: 297 / 25.4,
  margins: { bottom: 1, left: 1, right: 1, top: 1 },
  width: 210 / 25.4
}

class FakeWebContents extends EventEmitter {
  executed: string[] = []
  openHandler?: () => unknown
  pdf = Buffer.from('%PDF-fake')
  printGate: Promise<Buffer> | null = null

  executeJavaScript(script: string) {
    this.executed.push(script)

    return Promise.resolve(true)
  }

  printOptions: unknown[] = []

  printToPDF(options?: unknown) {
    this.printOptions.push(options)

    return this.printGate ?? Promise.resolve(this.pdf)
  }

  setWindowOpenHandler(handler: () => unknown) {
    this.openHandler = handler
  }
}

class FakeWindow {
  destroyed = false
  loadedUrl = ''
  readonly webContents = new FakeWebContents()

  destroy() {
    this.destroyed = true
  }

  isDestroyed() {
    return this.destroyed
  }

  async loadURL(url: string) {
    this.loadedUrl = url
    queueMicrotask(() => this.webContents.emit('did-finish-load'))
  }
}

function fakeSession() {
  const emitter = new EventEmitter()

  const value = Object.assign(emitter, {
    cacheCleared: false,
    permissionCheck: undefined as undefined | (() => boolean),
    permissionRequest: undefined as undefined | ((...args: unknown[]) => void),
    requestHandler: undefined as undefined | ((details: { url: string }, callback: (result: object) => void) => void),
    async clearCache() {
      value.cacheCleared = true
    },
    setPermissionCheckHandler(handler: () => boolean) {
      value.permissionCheck = handler
    },
    setPermissionRequestHandler(handler: (...args: unknown[]) => void) {
      value.permissionRequest = handler
    },
    webRequest: {
      onBeforeRequest(_filter: unknown, handler: typeof value.requestHandler) {
        value.requestHandler = handler ?? undefined
      }
    }
  })

  return value
}

function harness(options: { autoLoad?: boolean; loadTimeoutMs?: number; printTimeoutMs?: number } = {}) {
  const windows: FakeWindow[] = []
  const sessions: ReturnType<typeof fakeSession>[] = []

  const printer = new AtumOfficePdfPrinter({
    createWindow: () => {
      const win = new FakeWindow()

      if (options.autoLoad === false) {
        win.loadURL = async url => void (win.loadedUrl = url)
      }

      windows.push(win)

      return win as never
    },
    fromPartition: () => {
      const value = fakeSession()
      sessions.push(value)

      return value as never
    },
    loadTimeoutMs: options.loadTimeoutMs ?? 20,
    printTimeoutMs: options.printTimeoutMs ?? 20
  })

  return { printer, sessions, windows }
}

beforeEach(() => electronMock.app.removeAllListeners())

test('renders PDF in an isolated denied session, injects CSP, and cleans up', async () => {
  const { printer, sessions, windows } = harness()

  const bytes = await printer.render({
    page: PAGE,
    html: '<html><head></head><body>Xin chào</body></html>',
    title: 'Memo'
  })

  assert.deepEqual(bytes, new Uint8Array(Buffer.from('%PDF-fake')))
  assert.equal(windows[0]?.destroyed, true)
  assert.equal(sessions[0]?.cacheCleared, true)
  const decoded = Buffer.from(windows[0]!.loadedUrl.split(',')[1]!, 'base64').toString('utf8')
  assert.match(decoded, new RegExp(ATUM_OFFICE_PDF_CSP.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  assert.deepEqual(windows[0]?.webContents.openHandler?.(), { action: 'deny' })
  assert.equal(sessions[0]?.permissionCheck?.(), false)
  let permission = true
  sessions[0]?.permissionRequest?.(null, null, (allowed: boolean) => (permission = allowed))
  assert.equal(permission, false)
  let externalRequest: object | undefined
  sessions[0]?.requestHandler?.({ url: 'https://example.com/a.png' }, result => (externalRequest = result))
  assert.deepEqual(externalRequest, { cancel: true })

  const navigation = {
    prevented: false,
    preventDefault() {
      this.prevented = true
    }
  }

  windows[0]?.webContents.emit('will-navigate', navigation, 'https://example.com')
  assert.equal(navigation.prevented, true)

  const download = {
    prevented: false,
    preventDefault() {
      this.prevented = true
    }
  }

  sessions[0]?.emit('will-download', download)
  assert.equal(download.prevented, true)
})

test('load timeout rejects at load and destroys the window', async () => {
  const { printer, windows } = harness({ autoLoad: false, loadTimeoutMs: 5 })
  await assert.rejects(
    printer.render({ page: PAGE, html: '<p>x</p>', title: 'x' }),
    (error: AtumOfficePdfError) => error.stage === 'load'
  )
  assert.equal(windows[0]?.destroyed, true)
})

test('print timeout rejects at print and destroys the window', async () => {
  const { printer, windows } = harness({ printTimeoutMs: 5 })
  queueMicrotask(() => {
    if (windows[0]) {
      windows[0].webContents.printGate = new Promise(() => undefined)
    }
  })
  await assert.rejects(
    printer.render({ page: PAGE, html: '<p>x</p>', title: 'x' }),
    (error: AtumOfficePdfError) => error.stage === 'print'
  )
  assert.equal(windows[0]?.destroyed, true)
})

test('render-process-gone rejects and destroys the window', async () => {
  const { printer, windows } = harness({ autoLoad: false })
  const rendering = printer.render({ page: PAGE, html: '<p>x</p>', title: 'x' })
  queueMicrotask(() => windows[0]?.webContents.emit('render-process-gone', {}, { reason: 'crashed' }))
  await assert.rejects(rendering, /PDF_RENDER_PROCESS_GONE/u)
  assert.equal(windows[0]?.destroyed, true)
})

test('serializes renders and cancelAll rejects the active and queued jobs', async () => {
  const { printer, windows } = harness({ autoLoad: false, loadTimeoutMs: 100 })
  const first = printer.render({ page: PAGE, html: '<p>one</p>', title: 'one' })
  const second = printer.render({ page: PAGE, html: '<p>two</p>', title: 'two' })
  assert.equal(windows.length, 1)
  printer.cancelAll('CAPABILITY_REVOKED')
  await assert.rejects(first, /CAPABILITY_REVOKED/u)
  await assert.rejects(second, /CAPABILITY_REVOKED/u)
  assert.equal(windows[0]?.destroyed, true)
})

test("cancelOwner rejects only that owner's active and queued jobs", async () => {
  const { printer } = harness({ autoLoad: false, loadTimeoutMs: 500 })
  const mine = printer.render({ page: PAGE, html: '<html></html>', ownerId: 'a', title: 'A' })
  const theirs = printer.render({ page: PAGE, html: '<html></html>', ownerId: 'b', title: 'B' })
  const mineQueued = printer.render({ page: PAGE, html: '<html></html>', ownerId: 'a', title: 'A2' })
  mine.catch(() => undefined)
  mineQueued.catch(() => undefined)
  printer.cancelOwner('a', 'EXPORT_OWNER_DESTROYED')
  await assert.rejects(mine, /EXPORT_OWNER_DESTROYED/u)
  await assert.rejects(mineQueued, /EXPORT_OWNER_DESTROYED/u)

  // The other owner's job is still pending (not rejected by the cancellation).
  const outcome = await Promise.race([
    theirs.then(
      () => 'settled',
      () => 'rejected'
    ),
    new Promise(resolve => setTimeout(() => resolve('pending'), 30))
  ])

  assert.equal(outcome, 'pending')
  printer.cancelAll('APP_QUITTING')
  await assert.rejects(theirs, /APP_QUITTING/u)
})

test('a window that fails to construct settles the job with a rejection and frees the queue', async () => {
  let calls = 0

  const printer = new AtumOfficePdfPrinter({
    createWindow: () => {
      calls += 1

      if (calls === 1) {
        throw new Error('NO_GPU')
      }

      return new FakeWindow() as never
    },
    fromPartition: () => fakeSession() as never,
    loadTimeoutMs: 20,
    printTimeoutMs: 20
  })

  await assert.rejects(printer.render({ page: PAGE, html: '<html></html>', title: 'x' }), /NO_GPU/u)
  const bytes = await printer.render({ page: PAGE, html: '<html><head></head><body>ok</body></html>', title: 'y' })
  assert.deepEqual(bytes, new Uint8Array(Buffer.from('%PDF-fake')))
})

test('forwards the page box to printToPDF as explicit inches and an object paper size', async () => {
  const { printer, windows } = harness()

  await printer.render({ html: '<html><head></head><body>ok</body></html>', page: PAGE, title: 'geo' })

  const options = windows[0]!.webContents.printOptions.at(-1) as Record<string, unknown>
  assert.deepEqual(options, {
    margins: { bottom: 1, left: 1, right: 1, top: 1 },
    pageSize: { height: 297 / 25.4, width: 210 / 25.4 },
    printBackground: true
  })
  // marginType is never read by printToPDF and must not be sent; a named size
  // would be Electron's rounded A4.
  assert.equal('marginType' in (options.margins as object), false)
  assert.equal(typeof options.pageSize, 'object')
})
