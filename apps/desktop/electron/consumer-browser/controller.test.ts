import { lookup } from 'node:dns/promises'

import { describe, expect, it, vi } from 'vitest'

import { ATUM_FILE_VIEW_PARTITION } from '../atum-file-view-constants'

import {
  APP_BROWSER_PARTITION_PREFIX,
  assertTrustedConsumerBrowserSender,
  ATUM_ARTIFACT_PARTITION_PREFIX,
  CONSUMER_BROWSER_MAX_DOWNLOADS,
  CONSUMER_BROWSER_PARTITION_PREFIX,
  consumerBrowserDownloadName,
  createConsumerBrowserController,
  HERMES_PREVIEW_PARTITION
} from './controller'
import { nextPopupWindow } from './lifecycle'
import { sanitizeConsumerBrowserTab } from './model'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34' }])
}))

function fakeSession() {
  return {
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    clearStorageData: vi.fn().mockResolvedValue(undefined),
    webRequest: { onBeforeRequest: vi.fn() }
  }
}

function harness(
  options: {
    consumerOnly?: boolean
    browserWindowFromWebContents?: () => unknown
    downloads?: { directory: () => string; finished?: (file: string) => void }
    createEgress?: NonNullable<Parameters<typeof createConsumerBrowserController>[0]['createEgress']>
  } = {}
) {
  const egresses: Array<{ active: () => boolean; close: ReturnType<typeof vi.fn> }> = []

  const fakeEgress: NonNullable<Parameters<typeof createConsumerBrowserController>[0]['createEgress']> = (_session, active) => {
    const egress = { active, close: vi.fn() }
    egresses.push(egress)

    return { ready: Promise.resolve(), close: egress.close }
  }

  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  let webContentsCreated: ((event: unknown, contents: unknown) => void) | null = null
  const sessions = new Map<string, ReturnType<typeof fakeSession>>()
  const sender = { mainFrame: {} }
  const owner = { isDestroyed: () => false, webContents: sender }
  const event = { sender, senderFrame: sender.mainFrame }

  const controller = createConsumerBrowserController({
    app: {
      on: (name: string, listener: (event: unknown, contents: unknown) => void) => {
        if (name === 'web-contents-created') {
          webContentsCreated = listener
        }
      }
    } as never,
    knownAppIds: ['moon', 'andy', 'ben', 'taylor'],
    browserWindowFromWebContents: () => (options.browserWindowFromWebContents?.() ?? owner) as never,
    consumerOnly: options.consumerOnly ?? false,
    createEgress: options.createEgress ?? fakeEgress,
    ...(options.downloads ? { downloads: options.downloads } : {}),
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
      removeHandler: () => undefined
    } as never,
    sessionFromPartition: partition => {
      const existing = sessions.get(partition) ?? fakeSession()
      sessions.set(partition, existing)

      return existing as never
    }
  })

  return { controller, egresses, event, handlers, sessions, webContentsCreated: () => webContentsCreated! }
}

function hostAttachProbe(webContentsCreated: (event: unknown, contents: unknown) => void) {
  let attach:
    | ((event: { preventDefault: () => void }, prefs: unknown, params: Record<string, unknown>) => void)
    | null = null

  webContentsCreated(undefined, {
    getType: () => 'window',
    on: (name: string, listener: typeof attach) => {
      if (name === 'will-attach-webview') {
        attach = listener
      }
    }
  })

  return (partition: string, webPreferences: Record<string, unknown> = {}) => {
    const prevented = vi.fn()
    attach!({ preventDefault: prevented }, webPreferences, { partition })

    return prevented.mock.calls.length > 0
  }
}

describe('consumer browser document viewer', () => {
  it('refuses any webview claiming the viewer partition, because a guest cannot render a PDF', () => {
    const { webContentsCreated } = harness()

    let attach:
      | ((
          event: { preventDefault: () => void },
          prefs: Record<string, unknown>,
          params: Record<string, unknown>
        ) => void)
      | null = null

    webContentsCreated()(undefined, {
      getType: () => 'window',
      on: (name: string, listener: typeof attach) => {
        if (name === 'will-attach-webview') {
          attach = listener
        }
      }
    })

    const prevented = vi.fn()
    attach!(
      { preventDefault: prevented },
      {},
      { partition: ATUM_FILE_VIEW_PARTITION, src: 'atum-file://view/abcdefghijklmnopqrstuvwx' }
    )
    expect(prevented).toHaveBeenCalled()
  })
})

describe('consumer browser controller sessions', () => {
  it('allows known preview partitions and refuses unprepared browser namespaces', async () => {
    const { event, handlers, webContentsCreated } = harness()
    const attachPrevented = hostAttachProbe(webContentsCreated())
    expect(attachPrevented(HERMES_PREVIEW_PARTITION)).toBe(false)
    expect(attachPrevented(`${ATUM_ARTIFACT_PARTITION_PREFIX}account-1`)).toBe(false)
    expect(attachPrevented(`${CONSUMER_BROWSER_PARTITION_PREFIX}rogue`)).toBe(true)
    expect(attachPrevented(`${APP_BROWSER_PARTITION_PREFIX}rogue`)).toBe(true)
    const partition = `${CONSUMER_BROWSER_PARTITION_PREFIX}tab-1`
    await handlers.get('atum:consumer-browser:prepare')!(event, { partition, url: 'about:blank' })
    expect(attachPrevented(partition)).toBe(false)
  })

  it('pins sandboxed webview preferences before attachment', () => {
    const { webContentsCreated } = harness()
    const attachPrevented = hostAttachProbe(webContentsCreated())

    const preferences = {
      allowRunningInsecureContent: true,
      contextIsolation: false,
      nodeIntegration: true,
      preload: '/tmp/renderer-controlled.js',
      sandbox: false,
      webSecurity: false
    }

    expect(attachPrevented(HERMES_PREVIEW_PARTITION, preferences)).toBe(false)
    expect(preferences).toEqual({
      allowRunningInsecureContent: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    })
  })

  it('guards only guests whose session prepare() created', async () => {
    const { event, handlers, sessions, webContentsCreated } = harness()
    const partition = `${CONSUMER_BROWSER_PARTITION_PREFIX}tab-1`
    await handlers.get('atum:consumer-browser:prepare')!(event, { partition, url: 'about:blank' })

    const guarded = {
      getType: () => 'webview',
      session: sessions.get(partition),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn()
    }

    webContentsCreated()(undefined, guarded)
    expect(guarded.setWindowOpenHandler).toHaveBeenCalled()
    const foreign = { getType: () => 'webview', session: fakeSession(), on: vi.fn(), setWindowOpenHandler: vi.fn() }
    webContentsCreated()(undefined, foreign)
    expect(foreign.setWindowOpenHandler).not.toHaveBeenCalled()
  })

  it('denies permissions, downloads, and popups for the shared preview session', () => {
    const { sessions, webContentsCreated } = harness()
    expect(sessions.has(HERMES_PREVIEW_PARTITION)).toBe(false)
    const attachPrevented = hostAttachProbe(webContentsCreated())
    expect(attachPrevented(HERMES_PREVIEW_PARTITION)).toBe(false)
    const preview = sessions.get(HERMES_PREVIEW_PARTITION)!
    expect(preview.setPermissionCheckHandler).toHaveBeenCalled()
    expect(preview.setPermissionRequestHandler).toHaveBeenCalled()
    expect(preview.webRequest.onBeforeRequest).not.toHaveBeenCalled()

    const send = vi.fn()
    const preventDefault = vi.fn()
    const downloadHandler = preview.on.mock.calls.find(([name]) => name === 'will-download')?.[1]
    downloadHandler?.({ preventDefault }, null, { hostWebContents: { send }, id: 42 })
    expect(preventDefault).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('atum:consumer-browser:state', {
      sourceWebContentsId: 42,
      type: 'download_refused'
    })

    const guest = { getType: () => 'webview', session: preview, on: vi.fn(), setWindowOpenHandler: vi.fn() }
    webContentsCreated()(undefined, guest)
    expect(guest.setWindowOpenHandler).toHaveBeenCalled()
  })

  it('re-installs the request filter when a released partition is prepared again', async () => {
    const { event, handlers, sessions } = harness()
    const partition = `${CONSUMER_BROWSER_PARTITION_PREFIX}tab-1`
    const prepare = handlers.get('atum:consumer-browser:prepare')!
    const release = handlers.get('atum:consumer-browser:release')!
    await prepare(event, { partition, url: 'about:blank' })
    const session = sessions.get(partition)!
    expect(session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1)
    await release(event, partition)
    await prepare(event, { partition, url: 'about:blank' })
    // once for install, once for the release deny-all boundary, once for the re-install
    expect(session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(3)
    expect(session.webRequest.onBeforeRequest).toHaveBeenLastCalledWith({ urls: ['<all_urls>'] }, expect.any(Function))
  })
})

describe('consumer browser downloads (FR27)', () => {
  function downloadItem(filename: string) {
    let done: ((event: unknown, state: string) => void) | undefined

    return {
      getFilename: () => filename,
      getSavePath: () => `/home/example/Downloads/${filename}`,
      setSaveDialogOptions: vi.fn(),
      once: vi.fn((name: string, listener: typeof done) => {
        if (name === 'done') {
          done = listener
        }
      }),
      finish: (state: string) => done?.({}, state)
    }
  }

  async function browserTab(downloads?: { directory: () => string; finished?: (file: string) => void }) {
    const setup = harness(downloads ? { downloads } : {})
    const partition = `${CONSUMER_BROWSER_PARTITION_PREFIX}tab-1`
    await setup.handlers.get('atum:consumer-browser:prepare')!(setup.event, { partition, url: 'about:blank' })
    const session = setup.sessions.get(partition)!
    const handler = session.on.mock.calls.find(([name]) => name === 'will-download')![1]
    const send = vi.fn()

    const start = (item: ReturnType<typeof downloadItem>) => {
      const preventDefault = vi.fn()
      handler({ preventDefault }, item, { hostWebContents: { send }, id: 7 })

      return preventDefault.mock.calls.length > 0
    }

    return { send, start }
  }

  it('asks where to save, starting in Downloads, and tells the Dock when the file lands', async () => {
    const finished = vi.fn()
    const tab = await browserTab({ directory: () => '/home/example/Downloads', finished })
    const item = downloadItem('report.pdf')

    expect(tab.start(item)).toBe(false)
    expect(item.setSaveDialogOptions).toHaveBeenCalledWith({ defaultPath: '/home/example/Downloads/report.pdf' })
    item.finish('completed')
    expect(finished).toHaveBeenCalledWith('/home/example/Downloads/report.pdf')
    expect(tab.send).not.toHaveBeenCalled()
  })

  it('says when a download fails, and stays quiet when the person cancels the save panel', async () => {
    const tab = await browserTab({ directory: () => '/Downloads' })
    const failed = downloadItem('a.zip')
    const cancelled = downloadItem('b.zip')

    tab.start(failed)
    tab.start(cancelled)
    cancelled.finish('cancelled')
    expect(tab.send).not.toHaveBeenCalled()
    failed.finish('interrupted')
    expect(tab.send).toHaveBeenCalledWith('atum:consumer-browser:state', { sourceWebContentsId: 7, type: 'download_failed' })
  })

  it('lets a page run only a few downloads at once', async () => {
    const tab = await browserTab({ directory: () => '/Downloads' })
    const items = Array.from({ length: CONSUMER_BROWSER_MAX_DOWNLOADS }, (_value, index) => downloadItem(`${index}.bin`))

    expect(items.map(item => tab.start(item))).toEqual(items.map(() => false))
    expect(tab.start(downloadItem('extra.bin'))).toBe(true)
    expect(tab.send).toHaveBeenLastCalledWith('atum:consumer-browser:state', { sourceWebContentsId: 7, type: 'download_busy' })
    items[0]!.finish('completed')
    expect(tab.start(downloadItem('next.bin'))).toBe(false)
  })

  it('still refuses every download where the host has not enabled them', async () => {
    const tab = await browserTab()
    expect(tab.start(downloadItem('report.pdf'))).toBe(true)
    expect(tab.send).toHaveBeenCalledWith('atum:consumer-browser:state', { sourceWebContentsId: 7, type: 'download_refused' })
  })

  it('never downloads from a preview pane, even where browser tabs may', () => {
    const { sessions, webContentsCreated } = harness({ downloads: { directory: () => '/Downloads' } })
    hostAttachProbe(webContentsCreated())(HERMES_PREVIEW_PARTITION)
    const preview = sessions.get(HERMES_PREVIEW_PARTITION)!
    const preventDefault = vi.fn()
    preview.on.mock.calls.find(([name]) => name === 'will-download')![1]({ preventDefault }, downloadItem('x.exe'), {
      hostWebContents: { send: vi.fn() },
      id: 1
    })
    expect(preventDefault).toHaveBeenCalled()
  })

  it('starts the save panel from a plain file name', () => {
    expect(consumerBrowserDownloadName('../../.ssh/authorized_keys')).toBe('authorized_keys')
    expect(consumerBrowserDownloadName('.bashrc')).toBe('bashrc')
    expect(consumerBrowserDownloadName('re\u0007port:v1.pdf')).toBe('re_port_v1.pdf')
    expect(consumerBrowserDownloadName('')).toBe('download')
  })
})

describe('consumer browser controller boundaries', () => {
  it('never lets a renderer webview attach to an app partition: app views are main-owned', () => {
    const { webContentsCreated } = harness()
    const attachPrevented = hostAttachProbe(webContentsCreated())

    expect(attachPrevented(`${APP_BROWSER_PARTITION_PREFIX}moon`)).toBe(true)
    expect(attachPrevented(`${APP_BROWSER_PARTITION_PREFIX}${'a'.repeat(64)}-moon`)).toBe(true)
    expect(attachPrevented('atum-consumer-browser-x')).toBe(true)
  })

  it('releases app partitions and clears their persisted session state', async () => {
    const { event, handlers, sessions } = harness()
    const partition = `${APP_BROWSER_PARTITION_PREFIX}moon`
    const release = handlers.get('atum:consumer-browser:release')!

    await expect(release(event, partition)).resolves.toEqual({ ok: true })
    const appSession = sessions.get(partition)!
    expect(appSession.clearStorageData).toHaveBeenCalledTimes(1)
    expect(appSession.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(
      { urls: ['<all_urls>'] },
      expect.any(Function)
    )
  })

  it('can make the release channel consumer-partition-only for an isolated host', async () => {
    const { event, handlers, sessions } = harness({ consumerOnly: true })
    const release = handlers.get('atum:consumer-browser:release')!
    const consumerPartition = `${CONSUMER_BROWSER_PARTITION_PREFIX}tab-1`

    await expect(release(event, `${APP_BROWSER_PARTITION_PREFIX}moon`)).rejects.toThrow('browser_request_invalid')
    await expect(release(event, consumerPartition)).resolves.toEqual({ ok: true })
    expect(sessions.get(consumerPartition)?.clearStorageData).toHaveBeenCalledTimes(1)
  })

  it('refuses every non-consumer guest partition in an isolated Matrix host', async () => {
    const { event, handlers, webContentsCreated } = harness({ consumerOnly: true })
    const attachPrevented = hostAttachProbe(webContentsCreated())

    for (const partition of [
      '',
      'arbitrary',
      'persist:matrix-sdk-private',
      HERMES_PREVIEW_PARTITION,
      `${ATUM_ARTIFACT_PARTITION_PREFIX}account-1`,
      `${APP_BROWSER_PARTITION_PREFIX}moon`,
      `${CONSUMER_BROWSER_PARTITION_PREFIX}unprepared`
    ]) {
      expect(attachPrevented(partition)).toBe(true)
    }

    const prepared = `${CONSUMER_BROWSER_PARTITION_PREFIX}prepared`
    await handlers.get('atum:consumer-browser:prepare')!(event, { partition: prepared, url: 'about:blank' })
    expect(attachPrevented(prepared)).toBe(false)
  })

  it('releases every prepared consumer partition on an account transition', async () => {
    const { controller, event, handlers, sessions } = harness()
    const prepare = handlers.get('atum:consumer-browser:prepare')!
    const partitions = [`${CONSUMER_BROWSER_PARTITION_PREFIX}tab-1`, `${CONSUMER_BROWSER_PARTITION_PREFIX}tab-2`]

    await Promise.all(partitions.map(partition => prepare(event, { partition, url: 'about:blank' })))
    await controller.releaseConsumerPartitions()

    for (const partition of partitions) {
      expect(sessions.get(partition)?.clearStorageData).toHaveBeenCalledTimes(1)
    }
  })

  it.each(['tab', 'account'])('does not revive a partition when DNS finishes after %s release', async scope => {
    const { controller, event, handlers, webContentsCreated } = harness()
    const partition = `${CONSUMER_BROWSER_PARTITION_PREFIX}pending`
    let finishLookup!: (answers: { address: string; family: number }[]) => void
    vi.mocked(lookup).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishLookup = resolve
        }) as never
    )
    const pending = handlers.get('atum:consumer-browser:prepare')!(event, { partition, url: 'https://example.com' })
    const rejected = expect(pending).rejects.toThrow('browser_request_cancelled')

    if (scope === 'tab') {
      await handlers.get('atum:consumer-browser:release')!(event, partition)
    } else {
      await controller.releaseConsumerPartitions()
    }

    finishLookup([{ address: '93.184.216.34', family: 4 }])
    await rejected
    expect(hostAttachProbe(webContentsCreated())(partition)).toBe(true)
  })

  // 2026-11-06 audit lead atum-consumer-browser-unpinned-dns-public-check: the address vetted in main must be
  // the address Chromium connects to, so Chromium is routed through a pinned-address proxy before any navigation.
  it('routes a browser partition through the pinned-address proxy before prepare returns', async () => {
    const { egresses, event, handlers } = harness()
    const partition = `${CONSUMER_BROWSER_PARTITION_PREFIX}tab-1`
    await handlers.get('atum:consumer-browser:prepare')!(event, { partition, url: 'https://example.com' })
    expect(egresses).toHaveLength(1)
    expect(egresses[0]!.active()).toBe(true)
    // Preparing the same tab again (a navigation) reuses the proxy rather than stacking another.
    await handlers.get('atum:consumer-browser:prepare')!(event, { partition, url: 'https://example.org' })
    expect(egresses).toHaveLength(1)
  })

  it('does not prepare a partition whose proxy cannot be applied (no direct route)', async () => {
    const { event, handlers } = harness({
      createEgress: () => ({ ready: Promise.reject(new Error('app_egress_unavailable')), close: vi.fn() })
    })

    const partition = `${CONSUMER_BROWSER_PARTITION_PREFIX}tab-1`
    await expect(handlers.get('atum:consumer-browser:prepare')!(event, { partition, url: 'https://example.com' })).rejects.toThrow('browser_egress_unavailable')
  })

  it.each(['tab', 'account'] as const)('closes the proxy and revokes in-flight dials on %s release', async scope => {
    const { controller, egresses, event, handlers } = harness()
    const partition = `${CONSUMER_BROWSER_PARTITION_PREFIX}tab-1`
    await handlers.get('atum:consumer-browser:prepare')!(event, { partition, url: 'about:blank' })
    const [egress] = egresses

    if (scope === 'tab') {
      await handlers.get('atum:consumer-browser:release')!(event, partition)
    } else {
      await controller.releaseConsumerPartitions()
    }

    expect(egress!.close).toHaveBeenCalledOnce()
    expect(egress!.active()).toBe(false)
    await handlers.get('atum:consumer-browser:prepare')!(event, { partition, url: 'about:blank' })
    expect(egresses).toHaveLength(2)
  })

  it('keeps released guests denied even if storage cleanup fails', async () => {
    const { controller, event, handlers, sessions, webContentsCreated } = harness()
    const partition = `${CONSUMER_BROWSER_PARTITION_PREFIX}tab-1`
    await handlers.get('atum:consumer-browser:prepare')!(event, { partition, url: 'about:blank' })
    const session = sessions.get(partition)!
    session.clearStorageData.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(controller.releaseConsumerPartitions()).rejects.toThrow('storage unavailable')
    expect(hostAttachProbe(webContentsCreated())(partition)).toBe(true)
    const callback = vi.fn()
    session.webRequest.onBeforeRequest.mock.lastCall?.[1]({}, callback)
    expect(callback).toHaveBeenCalledWith({ cancel: true })
  })

  it('clears every catalogued legacy app partition during an account transition without any prepare', async () => {
    const { controller, sessions } = harness()
    await controller.releaseAppPartitions()

    for (const app of ['moon', 'andy', 'ben', 'taylor']) {
      expect(sessions.get(`${APP_BROWSER_PARTITION_PREFIX}${app}`)!.clearStorageData).toHaveBeenCalledTimes(1)
    }
  })

  it('requires the primary renderer frame as IPC sender', () => {
    const sender = { mainFrame: {} }
    const owner = { isDestroyed: () => false, webContents: sender }
    const event = { sender, senderFrame: sender.mainFrame }
    expect(assertTrustedConsumerBrowserSender(event as never, () => owner as never)).toBe(owner)
    expect(() =>
      assertTrustedConsumerBrowserSender({ ...event, senderFrame: {} } as never, () => owner as never)
    ).toThrow('untrusted_renderer')
    expect(() => assertTrustedConsumerBrowserSender(event as never, () => null)).toThrow('untrusted_renderer')
  })

  it('uses an ephemeral, non-persistent partition prefix', () => {
    expect(CONSUMER_BROWSER_PARTITION_PREFIX.startsWith('persist:')).toBe(false)
  })

  it('blocks unsafe restored tabs instead of loading them', () => {
    expect(sanitizeConsumerBrowserTab({ active: true, tabId: 'b1', title: 'Bad', url: 'file:///etc/passwd' })).toEqual({
      active: true,
      restoreBlocked: true,
      tabId: 'b1',
      title: 'Bad',
      url: 'about:blank'
    })
  })

  it('rate-limits popup requests before opening panel tabs', () => {
    let timestamps: number[] = []

    for (const now of [1, 2, 3]) {
      const outcome = nextPopupWindow(timestamps, now)
      expect(outcome.allowed).toBe(true)
      timestamps = outcome.timestamps
    }

    expect(nextPopupWindow(timestamps, 4).allowed).toBe(false)
    expect(() => nextPopupWindow([], Number.NaN)).toThrow('browser_popup_clock_invalid')
    vi.useRealTimers()
  })
})
