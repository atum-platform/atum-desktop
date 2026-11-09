import { lookup } from 'node:dns/promises'
import path from 'node:path'

import type { App, BrowserWindow, DownloadItem, IpcMain, IpcMainInvokeEvent, Session, WebContents } from 'electron'

import {
  CONSUMER_BROWSER_IPC,
  type ConsumerBrowserNotice,
  type ConsumerBrowserPopup,
  type ConsumerBrowserPrepareInput,
  type ConsumerBrowserPrepareResult
} from '../../shared/browser/ipc'
import {
  assertPublicResolvedAddresses,
  assertSafeBrowserRequestUrl,
  assertSafeBrowserUrl,
  normalizeBrowserInput
} from '../../shared/browser/policy'
import { type AppViewEgress, createConsumerBrowserEgress } from '../app-view/egress'
import { ATUM_FILE_VIEW_PARTITION } from '../atum-file-view-constants'

import { nextPopupWindow } from './lifecycle'

export const CONSUMER_BROWSER_PARTITION_PREFIX = 'atum-consumer-browser-'
export const APP_BROWSER_PARTITION_PREFIX = 'persist:atum-app-'
export const HERMES_PREVIEW_PARTITION = 'persist:hermes-preview'
export const ATUM_ARTIFACT_PARTITION_PREFIX = 'atum-artifact-'

interface ConsumerBrowserControllerDeps {
  app: Pick<App, 'on' | 'removeListener'>
  browserWindowFromWebContents: (contents: WebContents) => BrowserWindow | null
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>
  /**
   * Durable catalog authority. Persisted app partitions outlive this process,
   * so account/startup cleanup cannot rely only on partitions prepared since
   * the current launch.
   */
  knownAppIds: readonly string[]
  /**
   * Isolated hosts such as Matrix can attach/release only prepared consumer
   * partitions, never arbitrary, preview, SDK, or legacy app sessions.
   */
  consumerOnly?: boolean
  sessionFromPartition: (partition: string) => Session
  /** Test seam for the pinned-address proxy a browser partition is routed through. */
  createEgress?: typeof createConsumerBrowserEgress
  /**
   * Browser tabs may download (FR27): the person picks where each file goes in the save
   * panel, which starts in this folder. Absent, every download is refused as before.
   * Preview panes and app views never download.
   */
  downloads?: { directory: () => string; finished?: (file: string) => void }
}

/** At most this many downloads at once per browser tab session; a page cannot queue more. */
export const CONSUMER_BROWSER_MAX_DOWNLOADS = 3

/** A file name the save panel can start from: no folders, control characters or hidden dot. */
export function consumerBrowserDownloadName(value: string): string {
  const name = [...path.basename(String(value ?? ''))]
    .map(char => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || '/\\:'.includes(char) ? '_' : char))
    .join('')
    .replace(/^\.+/u, '')
    .slice(0, 200)
    .trim()

  return name || 'download'
}

function validPartition(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    new RegExp(`^${CONSUMER_BROWSER_PARTITION_PREFIX}[a-zA-Z0-9-]{1,128}$`, 'u').test(value)
  )
}

function validAppId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/u.test(value)
}

function appPartition(app: string): string {
  return `${APP_BROWSER_PARTITION_PREFIX}${app}`
}

function validAppPartition(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(APP_BROWSER_PARTITION_PREFIX)) {
    return false
  }

  const app = value.slice(APP_BROWSER_PARTITION_PREFIX.length)

  return validAppId(app) && value === appPartition(app)
}

function validPreviewPartition(value: string): boolean {
  return (
    value === HERMES_PREVIEW_PARTITION ||
    new RegExp(`^${ATUM_ARTIFACT_PARTITION_PREFIX}[a-zA-Z0-9-]{1,160}$`, 'u').test(value)
  )
}

function safeWebOrigin(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  try {
    const url = new URL(value)

    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password ? url.origin : null
  } catch {
    return null
  }
}

function matchesAppOrigin(url: URL, origin: string): boolean {
  const expected = new URL(origin)
  const protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol

  return protocol === expected.protocol && url.hostname === expected.hostname && url.port === expected.port
}

export function assertTrustedConsumerBrowserSender(
  event: IpcMainInvokeEvent,
  browserWindowFromWebContents: ConsumerBrowserControllerDeps['browserWindowFromWebContents']
): BrowserWindow {
  const owner = browserWindowFromWebContents(event.sender)

  if (
    !owner ||
    owner.isDestroyed() ||
    owner.webContents !== event.sender ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error('untrusted_renderer')
  }

  return owner
}

export async function assertPublicBrowserDestination(raw: string): Promise<string> {
  const url = assertSafeBrowserUrl(raw)

  if (url === 'about:blank') {
    return url
  }

  const parsed = new URL(url)
  const answers = await lookup(parsed.hostname, { all: true, verbatim: true })
  assertPublicResolvedAddresses(answers.map(answer => answer.address))

  return url
}

export function createConsumerBrowserController(deps: ConsumerBrowserControllerDeps): {
  dispose: () => void
  releaseAppPartitions: () => Promise<void>
  releaseConsumerPartitions: () => Promise<void>
} {
  const configured = new WeakSet<Session>()
  const allowedPartitions = new Set<string>()
  const preparing = new Map<string, object>()
  const allowedSessions = new WeakSet<Session>()
  const previewSessions = new WeakSet<Session>()
  const popupTimestamps = new Map<number, number[]>()
  const downloadsInFlight = new WeakMap<Session, number>()
  // One pinned-address proxy per prepared browser partition. Chromium sends it hostnames and never
  // resolves them itself, so the address we vetted is the address that is dialled (no DNS rebinding).
  const egresses = new Map<string, { egress: AppViewEgress; owner: object }>()

  const closeEgress = (partition: string): void => {
    egresses.get(partition)?.egress.close()
    egresses.delete(partition)
  }

  const ensureEgress = async (partition: string, browserSession: Session): Promise<void> => {
    if (!egresses.has(partition)) {
      // Live only while this entry is still the partition's: release or replacement revokes in-flight dials.
      const owner = {}
      const egress = (deps.createEgress ?? createConsumerBrowserEgress)(browserSession, () => egresses.get(partition)?.owner === owner)
      egresses.set(partition, { egress, owner })
    }

    try {
      await egresses.get(partition)!.egress.ready
    } catch {
      closeEgress(partition)
      throw new Error('browser_egress_unavailable')
    }
  }

  const download = (
    browserSession: Session,
    mode: 'browser' | 'preview',
    event: { preventDefault: () => void },
    item: DownloadItem | null | undefined,
    contents: WebContents | null | undefined
  ) => {
    const notify = (type: ConsumerBrowserNotice['type']) =>
      contents?.hostWebContents?.send(CONSUMER_BROWSER_IPC.state, {
        sourceWebContentsId: contents.id,
        type
      } satisfies ConsumerBrowserNotice)

    const inFlight = downloadsInFlight.get(browserSession) ?? 0

    if (mode !== 'browser' || !deps.downloads || !item) {
      event.preventDefault()
      notify('download_refused')

      return
    }

    if (inFlight >= CONSUMER_BROWSER_MAX_DOWNLOADS) {
      event.preventDefault()
      notify('download_busy')

      return
    }

    downloadsInFlight.set(browserSession, inFlight + 1)
    // No save path is set, so Electron asks where to save: nothing lands on disk unseen.
    item.setSaveDialogOptions({
      defaultPath: path.join(deps.downloads.directory(), consumerBrowserDownloadName(item.getFilename()))
    })
    item.once('done', (_done, state) => {
      downloadsInFlight.set(browserSession, Math.max(0, (downloadsInFlight.get(browserSession) ?? 1) - 1))

      if (state === 'completed') {
        deps.downloads?.finished?.(item.getSavePath())
      } else if (state === 'interrupted') {
        notify('download_failed')
      }
    })
  }

  const clearSessionRegistration = async (partition: string, browserSession: Session): Promise<void> => {
    preparing.delete(partition)
    closeEgress(partition)
    allowedPartitions.delete(partition)
    allowedSessions.delete(browserSession)
    previewSessions.delete(browserSession)
    // Keep a request filter installed while persisted state is being cleared.
    // Existing guests may still be alive after their host releases a tab; a
    // null filter would briefly leave them unguarded. A later prepare replaces
    // this deny-all boundary with the current, validated origin policy.
    browserSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (_details, callback) => {
      callback({ cancel: true })
    })
    await browserSession.clearStorageData()
  }

  const configureSession = (partition: string, mode: 'browser' | 'preview', lockedOrigin?: string): void => {
    const browserSession = deps.sessionFromPartition(partition)

    if (!configured.has(browserSession)) {
      configured.add(browserSession)
      browserSession.setPermissionCheckHandler(() => false)
      browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      browserSession.setDevicePermissionHandler?.(() => false)
      browserSession.on('will-download', (event, item, contents) => download(browserSession, mode, event, item, contents))
    }

    if (mode === 'preview') {
      return
    }

    // Replacing the filter is intentional: release installs deny-all, and an
    // app origin may be rebound only after its persisted state is cleared.
    browserSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      void (async () => {
        try {
          const parsed = new URL(details.url)

          if (['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
            if (lockedOrigin && !matchesAppOrigin(parsed, lockedOrigin)) {
              throw new Error('browser_origin_blocked')
            }

            assertSafeBrowserRequestUrl(parsed.href)
            const answers = await lookup(parsed.hostname, { all: true, verbatim: true })
            assertPublicResolvedAddresses(answers.map(answer => answer.address))
          } else if (details.resourceType === 'mainFrame' && details.url !== 'about:blank') {
            throw new Error('browser_url_blocked')
          } else if (!['about:', 'blob:', 'data:'].includes(parsed.protocol)) {
            throw new Error('browser_url_blocked')
          }

          callback({})
        } catch {
          callback({ cancel: true })
        }
      })()
    })
  }

  const onWebContentsCreated = (_event: unknown, contents: WebContents): void => {
    if (contents.getType() !== 'webview') {
      // Host contents: vet webview attachment before it happens. A webview
      // claiming a consumer-browser partition that prepare() never allowed is
      // refused pre-attach; webviews outside our partition namespace (e.g. the
      // preview pane's restricted mode) keep their own guards untouched.
      contents.on('will-attach-webview', (event, webPreferences, params) => {
        // Treat renderer-supplied webview preferences as hostile input. The
        // host may choose a partition and URL only through the prepared seams;
        // it never gets a preload or Node-capable guest.
        delete webPreferences.preload
        webPreferences.nodeIntegration = false
        webPreferences.contextIsolation = true
        webPreferences.sandbox = true
        webPreferences.webSecurity = true
        webPreferences.allowRunningInsecureContent = false
        const partition = typeof params.partition === 'string' ? params.partition : ''

        if (deps.consumerOnly && (!validPartition(partition) || !allowedPartitions.has(partition))) {
          event.preventDefault()

          return
        }

        if (partition === ATUM_FILE_VIEW_PARTITION) {
          // The PDF viewer is a main-owned view; Chromium's viewer cannot
          // render inside a guest. Nothing may claim that partition here.
          event.preventDefault()

          return
        }

        if (validPreviewPartition(partition)) {
          const previewSession = deps.sessionFromPartition(partition)
          allowedSessions.add(previewSession)
          previewSessions.add(previewSession)
          configureSession(partition, 'preview')

          return
        }

        // App partitions belong to main-owned app views (electron/app-view);
        // a renderer webview may never attach to one, prepared or not.
        if (
          partition.startsWith(APP_BROWSER_PARTITION_PREFIX) ||
          (partition.startsWith(CONSUMER_BROWSER_PARTITION_PREFIX) && !allowedPartitions.has(partition))
        ) {
          event.preventDefault()
        }
      })

      return
    }

    // Guest contents: only sessions prepare() created belong to this
    // controller; session identity stands in for the partition string, which
    // main-process Electron no longer exposes on created guests.
    if (!allowedSessions.has(contents.session)) {
      return
    }

    if (previewSessions.has(contents.session)) {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))

      return
    }

    let permittedNavigation: string | null = null
    contents.on('will-navigate', (event, rawUrl) => {
      if (rawUrl === permittedNavigation) {
        permittedNavigation = null

        return
      }

      event.preventDefault()
      void assertPublicBrowserDestination(rawUrl)
        .then(url => {
          if (contents.isDestroyed()) {
            return
          }

          permittedNavigation = url

          return contents.loadURL(url)
        })
        .catch(() => {
          contents.hostWebContents?.send(CONSUMER_BROWSER_IPC.state, {
            sourceWebContentsId: contents.id,
            type: 'navigation_blocked'
          } satisfies ConsumerBrowserNotice)
          contents.hostWebContents?.send(CONSUMER_BROWSER_IPC.popup, {
            sourceWebContentsId: contents.id,
            url: ''
          } satisfies ConsumerBrowserPopup)
        })
    })
    contents.setWindowOpenHandler(details => {
      const now = Date.now()
      const window = nextPopupWindow(popupTimestamps.get(contents.id) ?? [], now)
      popupTimestamps.set(contents.id, window.timestamps)

      if (window.allowed) {
        void assertPublicBrowserDestination(details.url)
          .then(url => {
            if (!contents.isDestroyed()) {
              contents.hostWebContents?.send(CONSUMER_BROWSER_IPC.popup, {
                sourceWebContentsId: contents.id,
                url
              } satisfies ConsumerBrowserPopup)
            }
          })
          .catch(() => undefined)
      }

      return { action: 'deny' }
    })
    contents.on('destroyed', () => popupTimestamps.delete(contents.id))
  }

  deps.app.on('web-contents-created', onWebContentsCreated)
  deps.ipcMain.handle(CONSUMER_BROWSER_IPC.prepare, async (event, input: ConsumerBrowserPrepareInput) => {
    assertTrustedConsumerBrowserSender(event, deps.browserWindowFromWebContents)

    if (!input || !validPartition(input.partition) || typeof input.url !== 'string') {
      throw new Error('browser_request_invalid')
    }

    const attempt = {}
    preparing.set(input.partition, attempt)

    try {
      const url = await assertPublicBrowserDestination(normalizeBrowserInput(input.url))

      // DNS may finish after tab close, sign-out, or a newer navigation. Never
      // restore a revoked guest's authority from an obsolete prepare request.
      if (preparing.get(input.partition) !== attempt) {
        throw new Error('browser_request_cancelled')
      }

      allowedPartitions.add(input.partition)
      const browserSession = deps.sessionFromPartition(input.partition)
      allowedSessions.add(browserSession)
      configureSession(input.partition, 'browser')
      // Nothing navigates until Chromium is provably routed through the pinned proxy; failure is closed.
      await ensureEgress(input.partition, browserSession)

      if (preparing.get(input.partition) !== attempt) {
        throw new Error('browser_request_cancelled')
      }

      return { url } satisfies ConsumerBrowserPrepareResult
    } finally {
      if (preparing.get(input.partition) === attempt) {
        preparing.delete(input.partition)
      }
    }
  })
  deps.ipcMain.handle(CONSUMER_BROWSER_IPC.release, async (event, partition: unknown) => {
    assertTrustedConsumerBrowserSender(event, deps.browserWindowFromWebContents)

    if (!validPartition(partition) && !(!deps.consumerOnly && validAppPartition(partition))) {
      throw new Error('browser_request_invalid')
    }

    const browserSession = deps.sessionFromPartition(partition)
    await clearSessionRegistration(partition, browserSession)

    return { ok: true }
  })

  return {
    dispose: () => {
      preparing.clear()

      for (const partition of [...egresses.keys()]) {
        closeEgress(partition)
      }

      deps.app.removeListener('web-contents-created', onWebContentsCreated)
      deps.ipcMain.removeHandler(CONSUMER_BROWSER_IPC.prepare)
      deps.ipcMain.removeHandler(CONSUMER_BROWSER_IPC.release)
    },
    releaseAppPartitions: async () => {
      const appPartitions = new Set(deps.knownAppIds.filter(validAppId).map(appPartition))

      for (const partition of allowedPartitions) {
        if (validAppPartition(partition)) {
          appPartitions.add(partition)
        }
      }

      await Promise.all(
        [...appPartitions].map(partition => clearSessionRegistration(partition, deps.sessionFromPartition(partition)))
      )
    },
    releaseConsumerPartitions: async () => {
      preparing.clear()
      const consumerPartitions = [...allowedPartitions].filter(validPartition)

      await Promise.all(
        consumerPartitions.map(partition => clearSessionRegistration(partition, deps.sessionFromPartition(partition)))
      )
    }
  }
}
