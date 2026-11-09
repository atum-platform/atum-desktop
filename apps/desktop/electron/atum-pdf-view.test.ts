import assert from 'node:assert/strict'

import { test } from 'vitest'

import { ATUM_PDF_VIEW_MAX, AtumPdfViewController, clearPdfViewSessionStorage, hardenPdfViewSession } from './atum-pdf-view'

test('viewer session clears storage and cache, reports failure and never calls a failed clear ready', async () => {
  const calls: string[] = []
  const failures: unknown[] = []
  const failure = new Error('cache unavailable')
  assert.equal(await clearPdfViewSessionStorage({
    clearStorageData: async () => { calls.push('storage') },
    clearCache: async () => { calls.push('cache'); throw failure }
  }, error => failures.push(error)), false)
  assert.deepEqual(calls, ['storage', 'cache'])
  assert.deepEqual(failures, [failure])
  assert.equal(await clearPdfViewSessionStorage({
    clearStorageData: async () => {}, clearCache: async () => {}
  }), true)
})

function harness(paths: Record<string, string> = { 'tok-1': '/home/u/a.pdf' }, options: { deferredLoad?: boolean; loadFails?: boolean; ready?: boolean; zoom?: number } = {}) {
  const attached: unknown[] = []
  const created: Array<{
    bounds: unknown
    closed: boolean
    frameNavigation?: (event: { isMainFrame: boolean; preventDefault: () => void; url: string }) => void
    loaded: string[]
    navigationBlocked: boolean
    visible: boolean | null
  }> = []
  const pendingLoads: Array<{ reject: (error: Error) => void; resolve: () => void }> = []

  const host = {
    contentView: {
      addChildView: (view: unknown) => attached.push(view),
      removeChildView: (view: unknown) => {
        const index = attached.indexOf(view)

        if (index >= 0) {attached.splice(index, 1)}
      }
    },
    getContentSize: (): [number, number] => [1400, 900],
    isDestroyed: () => false
  }

  const controller = new AtumPdfViewController({
    createView: () => {
      const record = { bounds: null as unknown, closed: false, loaded: [] as string[], navigationBlocked: false, visible: null as boolean | null } as (typeof created)[number]
      created.push(record)

      return {
        setBounds: (bounds: unknown) => { record.bounds = bounds },
        setVisible: (visible: boolean) => { record.visible = visible },
        webContents: {
          close: () => { record.closed = true },
          isDestroyed: () => record.closed,
          loadURL: async (url: string) => {
            record.loaded.push(url)

            if (options.deferredLoad) {
              await new Promise<void>((resolve, reject) => {
                pendingLoads.push({ reject, resolve })
              })
            }

            if (options.loadFails) {
              throw new Error('pdf_load_failed')
            }
          },
          on: (event: string, listener: (...args: never[]) => void) => {
            if (event === 'will-navigate') {
              listener({ preventDefault: () => { record.navigationBlocked = true } } as never)
            }

            if (event === 'will-frame-navigate') {
              record.frameNavigation = listener as never
            }
          },
          setWindowOpenHandler: () => undefined
        }
      }
    },
    host: () => host,
    pathToUrl: filePath => `file://${filePath}`,
    resolvePath: token => paths[token] ?? null,
    zoomFactor: () => options.zoom ?? 1,
    ready: options.ready === undefined ? undefined : async () => options.ready!
  })

  return { attached, controller, created, pendingLoads }
}

test('places one main-owned view per token and loads the resolved file', async () => {
  const { attached, controller, created } = harness()

  assert.deepEqual(await controller.show('tok-1', { height: 700, width: 500, x: 900, y: 60 }), { shown: true })
  assert.equal(created.length, 1)
  assert.deepEqual(created[0]!.loaded, ['file:///home/u/a.pdf#view=Fit&navpanes=0'])
  assert.deepEqual(created[0]!.bounds, { height: 700, width: 500, x: 900, y: 60 })
  assert.equal(created[0]!.visible, true)
  assert.equal(attached.length, 1)

  // A second show repositions the same view rather than making another.
  await controller.show('tok-1', { height: 600, width: 400, x: 950, y: 80 })
  assert.equal(created.length, 1)
  assert.deepEqual(created[0]!.bounds, { height: 600, width: 400, x: 950, y: 80 })
})

test('a document view admits only Chromium PDF viewer subframe navigation', async () => {
  const { controller, created } = harness()
  await controller.show('tok-1', { height: 700, width: 500, x: 900, y: 60 })

  assert.equal(created[0]!.navigationBlocked, true)
  const decisions: string[] = []
  const navigate = (url: string, isMainFrame = false) => created[0]!.frameNavigation!({
    isMainFrame,
    preventDefault: () => decisions.push(url),
    url
  })

  navigate('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html')
  navigate('chrome-extension://someotherextensionidabcdefghijkl/index.html')
  navigate('https://example.com/escape')
  navigate('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html', true)

  assert.deepEqual(decisions, [
    'chrome-extension://someotherextensionidabcdefghijkl/index.html',
    'https://example.com/escape',
    'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html'
  ])
})

test('refuses a token that no longer resolves, and drops any view it had', async () => {
  const paths: Record<string, string> = { 'tok-1': '/home/u/a.pdf' }
  const { attached, controller, created } = harness(paths)
  await controller.show('tok-1', { height: 700, width: 500, x: 900, y: 60 })

  delete paths['tok-1']
  assert.deepEqual(await controller.show('tok-1', { height: 700, width: 500, x: 900, y: 60 }), { shown: false })
  assert.equal(created[0]!.closed, true)
  assert.equal(attached.length, 0)
})

test('a failed load tears down the candidate and lets the renderer use its fallback', async () => {
  const { attached, controller, created } = harness(undefined, { loadFails: true })

  assert.deepEqual(await controller.show('tok-1', { height: 700, width: 500, x: 900, y: 60 }), { shown: false })
  assert.equal(created.length, 1)
  assert.equal(created[0]!.closed, true)
  assert.equal(attached.length, 0)
})

test('concurrent shows wait for one atomic load and attach only the settled view', async () => {
  const { attached, controller, created, pendingLoads } = harness(undefined, { deferredLoad: true })
  const first = controller.show('tok-1', { height: 700, width: 500, x: 900, y: 60 })
  const second = controller.show('tok-1', { height: 600, width: 400, x: 950, y: 80 })

  assert.equal(created.length, 1)
  assert.equal(pendingLoads.length, 1)
  assert.equal(attached.length, 0)
  pendingLoads[0]!.resolve()

  assert.deepEqual(await first, { shown: true })
  assert.deepEqual(await second, { shown: true })
  assert.equal(attached.length, 1)
  assert.deepEqual(created[0]!.bounds, { height: 600, width: 400, x: 950, y: 80 })
})

test('a failed shared first load cleans up and both concurrent shows report the fallback', async () => {
  const { attached, controller, created, pendingLoads } = harness(undefined, { deferredLoad: true })
  const first = controller.show('tok-1', { height: 700, width: 500, x: 900, y: 60 })
  const second = controller.show('tok-1', { height: 600, width: 400, x: 950, y: 80 })

  pendingLoads[0]!.reject(new Error('pdf_load_failed'))

  assert.deepEqual(await first, { shown: false })
  assert.deepEqual(await second, { shown: false })
  assert.equal(created[0]!.closed, true)
  assert.equal(attached.length, 0)
})

test('a hide during a deferred load wins: the settled load stays detached until the next show', async () => {
  const { attached, controller, created, pendingLoads } = harness(undefined, { deferredLoad: true })
  const first = controller.show('tok-1', { height: 100, width: 100, x: 0, y: 0 })
  controller.hide('tok-1')
  pendingLoads[0]!.resolve()
  assert.deepEqual(await first, { shown: false })
  assert.equal(attached.length, 0)
  assert.equal(created.length, 1)
  assert.notEqual(created[0]!.visible, true)

  // Eligible again: the same view attaches without reloading.
  assert.deepEqual(await controller.show('tok-1', { height: 100, width: 100, x: 0, y: 0 }), { shown: true })
  assert.equal(attached.length, 1)
  assert.equal(created[0]!.loaded.length, 1)
})

test('a refused placement leaves nothing attached for the token', async () => {
  const { attached, controller } = harness()
  assert.deepEqual(await controller.show('tok-1', { height: 100, width: 100, x: 0, y: 0 }), { shown: true })
  assert.equal(attached.length, 1)
  assert.deepEqual(await controller.show('tok-1', { height: 0, width: 100, x: 0, y: 0 }), { shown: false })
  assert.equal(attached.length, 0)
})

test('a viewer session that is not ready refuses every placement without creating a view', async () => {
  const { attached, created, controller } = harness(undefined, { ready: false })
  assert.deepEqual(await controller.show('tok-1', { height: 100, width: 100, x: 0, y: 0 }), { shown: false })
  assert.equal(created.length, 0)
  assert.equal(attached.length, 0)
})

test('rejects bounds that are not a usable rectangle', async () => {
  const { controller, created } = harness()

  for (const bounds of [null, {}, { height: 700, width: 0, x: 1, y: 1 }, { height: 'x', width: 5, x: 1, y: 1 }]) {
    assert.deepEqual(await controller.show('tok-1', bounds), { shown: false })
  }

  assert.equal(created.length, 0)
})

test('clamps a stale rectangle to the window so it cannot cover the app', async () => {
  const { controller, created } = harness()
  await controller.show('tok-1', { height: 5000, width: 9000, x: 1300, y: 800 })

  assert.deepEqual(created[0]!.bounds, { height: 100, width: 100, x: 1300, y: 800 })
})

test('hide detaches but keeps the view; close destroys it', async () => {
  const { attached, controller, created } = harness()
  await controller.show('tok-1', { height: 700, width: 500, x: 900, y: 60 })

  controller.hide('tok-1')
  assert.equal(attached.length, 0)
  assert.equal(created[0]!.visible, false)
  assert.equal(created[0]!.closed, false)

  await controller.show('tok-1', { height: 700, width: 500, x: 900, y: 60 })
  assert.equal(created.length, 1)
  assert.equal(attached.length, 1)

  controller.close('tok-1')
  assert.equal(attached.length, 0)
  assert.equal(created[0]!.closed, true)
})

test('keeps the number of live views bounded', async () => {
  const paths: Record<string, string> = {}

  for (let index = 0; index < ATUM_PDF_VIEW_MAX + 3; index += 1) {
    paths[`tok-${index}`] = `/home/u/${index}.pdf`
  }

  const { controller, created } = harness(paths)

  for (let index = 0; index < ATUM_PDF_VIEW_MAX + 3; index += 1) {
    await controller.show(`tok-${index}`, { height: 700, width: 500, x: 900, y: 60 })
  }

  assert.equal(created.filter(view => !view.closed).length, ATUM_PDF_VIEW_MAX)

  controller.closeAll()
  assert.equal(created.filter(view => !view.closed).length, 0)
})

test('places in DIP: a CSS-px rectangle is scaled by the page zoom factor', async () => {
  const { controller, created } = harness(undefined, { zoom: 1.5 })
  await controller.show('tok-1', { height: 400, width: 300, x: 100, y: 40 })

  assert.deepEqual(created[0]!.bounds, { height: 600, width: 450, x: 150, y: 60 })
})

test('a nonsensical zoom factor is treated as 100%', async () => {
  const { controller, created } = harness(undefined, { zoom: Number.NaN })
  await controller.show('tok-1', { height: 400, width: 300, x: 100, y: 40 })

  assert.deepEqual(created[0]!.bounds, { height: 400, width: 300, x: 100, y: 40 })
})

test('eviction takes a hidden view before one that is on screen', async () => {
  const paths: Record<string, string> = {}

  for (let index = 0; index < ATUM_PDF_VIEW_MAX + 1; index += 1) {
    paths[`tok-${index}`] = `/home/u/${index}.pdf`
  }

  const { attached, controller, created } = harness(paths)

  for (let index = 0; index < ATUM_PDF_VIEW_MAX; index += 1) {
    await controller.show(`tok-${index}`, { height: 700, width: 500, x: 900, y: 60 })
  }

  // tok-1 is hidden; tok-0 is the oldest but still on screen.
  controller.hide('tok-1')
  await controller.show(`tok-${ATUM_PDF_VIEW_MAX}`, { height: 700, width: 500, x: 900, y: 60 })

  assert.equal(created[1]!.closed, true, 'the hidden view was evicted')
  assert.equal(created[0]!.closed, false, 'the visible oldest view survived')
  assert.equal(attached.length, ATUM_PDF_VIEW_MAX)
})

test('reports which files it is serving, for the session filter', async () => {
  const { controller } = harness()
  assert.equal(controller.isServing('file:///home/u/a.pdf'), false)

  await controller.show('tok-1', { height: 700, width: 500, x: 900, y: 60 })
  assert.equal(controller.isServing('file:///home/u/a.pdf'), true)
  assert.equal(controller.isServing('file:///home/u/a.pdf#view=Fit&navpanes=0'), true)
  assert.equal(controller.isServing('file:///home/u/b.pdf'), false)

  controller.close('tok-1')
  assert.equal(controller.isServing('file:///home/u/a.pdf'), false)
})

test('later PDF range reads revalidate the grant instead of trusting the loaded URL', async () => {
  const paths: Record<string, string> = { 'tok-1': '/home/u/a.pdf' }
  const { controller } = harness(paths)
  await controller.show('tok-1', { height: 700, width: 500, x: 900, y: 60 })
  assert.equal(controller.isServing('file:///home/u/a.pdf'), true)
  delete paths['tok-1']
  assert.equal(controller.isServing('file:///home/u/a.pdf'), false)
  paths['tok-1'] = '/home/u/b.pdf'
  assert.equal(controller.isServing('file:///home/u/a.pdf'), false)
})

test('a revoked grant does not mask another live view of the same PDF', async () => {
  const paths: Record<string, string> = { 'tok-1': '/home/u/a.pdf', 'tok-2': '/home/u/a.pdf' }
  const { controller } = harness(paths)
  const bounds = { height: 700, width: 500, x: 900, y: 60 }
  await controller.show('tok-1', bounds)
  await controller.show('tok-2', bounds)
  delete paths['tok-1']
  assert.equal(controller.isServing('file:///home/u/a.pdf'), true)
  delete paths['tok-2']
  assert.equal(controller.isServing('file:///home/u/a.pdf'), false)
})

test('the viewer session denies permissions and downloads and admits only served files and the PDF extension', () => {
  const calls: string[] = []
  let filter: ((details: { resourceType: string; url: string }, callback: (r: { cancel?: boolean }) => void) => void) | null = null
  let download: ((event: { preventDefault: () => void }) => void) | null = null
  let permissionRequest: ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void) | null = null
  let permissionCheck: (() => boolean) | null = null
  let devicePermission: (() => boolean) | null = null

  hardenPdfViewSession(
    {
      on: (_event, listener) => { download = listener },
      setDevicePermissionHandler: handler => { devicePermission = handler },
      setPermissionCheckHandler: handler => { permissionCheck = handler },
      setPermissionRequestHandler: handler => { permissionRequest = handler },
      webRequest: { onBeforeRequest: (_filter, listener) => { filter = listener } }
    },
    fileUrl => fileUrl === 'file:///home/u/a.pdf'
  )

  assert.equal(permissionCheck!(), false)
  assert.equal(devicePermission!(), false)
  permissionRequest!({}, 'geolocation', granted => calls.push(`perm:${granted}`))
  download!({ preventDefault: () => calls.push('download-prevented') })
  assert.deepEqual(calls, ['perm:false', 'download-prevented'])

  const decide = (url: string, resourceType = 'mainFrame') => {
    let result: { cancel?: boolean } = {}
    filter!({ resourceType, url }, response => { result = response })

    return result
  }

  assert.deepEqual(decide('file:///home/u/a.pdf'), {})
  assert.deepEqual(decide('file:///home/u/b.pdf'), { cancel: true })
  assert.deepEqual(decide('file:///etc/passwd', 'other'), { cancel: true })
  assert.deepEqual(decide('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html'), {})
  assert.deepEqual(decide('chrome-extension://someotherextensionidabcdefghijkl/x.js', 'script'), { cancel: true })
  // Chromium's internal WebUI bundle: the viewer imports it, as sub-resources only.
  assert.deepEqual(decide('chrome://resources/js/load_time_data.js', 'script'), {})
  assert.deepEqual(decide('chrome://resources/css/text_defaults_md.css', 'stylesheet'), {})
  assert.deepEqual(decide('chrome://resources/x.html'), { cancel: true })
  assert.deepEqual(decide('chrome://resources/x.html', 'subFrame'), { cancel: true })
  assert.deepEqual(decide('chrome://settings/'), { cancel: true })
  assert.deepEqual(decide('chrome://settings/x.js', 'script'), { cancel: true })
  assert.deepEqual(decide('https://example.com/'), { cancel: true })
  assert.deepEqual(decide('https://example.com/t.js', 'script'), { cancel: true })
  assert.deepEqual(decide('blob:null/abc', 'other'), {})
  assert.deepEqual(decide('data:text/html,x', 'mainFrame'), { cancel: true })
  assert.deepEqual(decide('not a url'), { cancel: true })
})
