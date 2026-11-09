/**
 * app-view/controller.ts
 *
 * Main-process authority for app views (slice 3 of the app-launch design,
 * `docs/APP-LAUNCH-SLICE3-PLAN.md` rev 3).
 *
 * Every app view is a `WebContentsView` main creates, navigates, and
 * destroys. The renderer asks for `{app, route_id}`, receives an opaque
 * `viewId`, and from then on reports only bounds and visibility; it never
 * learns an origin, a path, or the one-time launch URL, and it cannot make
 * the guest navigate. Everything that decides what a view may show comes
 * from the server-authored manifest (`AtumAppSurfacesClient.manifest`) and
 * the platform's launch answer (`launch`).
 *
 * Isolation: persisted state lives in `persist:atum-app-<accountKey>-<app>`.
 * Account hand-off (`revokeAccount`) blocks new opens, destroys every guest
 * of the outgoing account, awaits their destruction, then clears each
 * partition behind a deny-all request filter. Every asynchronous
 * continuation revalidates `{accountKey, generation, viewId}` before acting.
 *
 * This module depends on Electron only through the small interfaces below so
 * the whole lifecycle is testable with fakes.
 */

import { randomBytes, randomUUID } from 'node:crypto'

import {
  APP_VIEW_IPC,
  type AppViewBounds,
  type AppViewBoundsInput,
  type AppViewError,
  type AppViewOpenInput,
  type AppViewOpenResult,
  type AppViewState,
  type AppViewVisibilityInput
} from '../../shared/app-view/ipc'
import {
  APP_LAUNCH_REFUSALS,
  type AppLaunchIssue,
  type AppManifestResponse,
  appViewTransportFailure,
  type BotPanelStatus
} from '../../shared/app-view/protocol'
import { assertSafeBrowserRequestUrl, clampBrowserBounds, scaleBrowserBounds } from '../../shared/browser/policy'
import { ATUM_SHELL_HEADER_HEIGHT } from '../atum-window-mode'
import { nextPopupWindow } from '../consumer-browser/lifecycle'

import { type AppViewEgress, createAppViewEgress, type EgressSession } from './egress'
import { appViewPartition, type DirectoryEntry, discoverAppViewPartitions, forEachBounded, isAppId } from './partitions'

/**
 * Everything about a manifest that decides what a view may reach: the origin
 * it navigates, the version that granted its reach, and the reach itself.
 * A view is bound to the fingerprint it opened under, so a later manifest
 * that grants differently cannot be adopted underneath it.
 */
function networkPolicyFingerprint(manifest: AppManifestResponse): string {
  const origins = manifest.network_origins
    .filter(entry => entry.kinds.includes('connect'))
    .map(entry => entry.origin)
    .sort()

  return JSON.stringify([manifest.web_origin, manifest.manifest.app.app_version_id, origins, manifest.manifest.launch, manifest.manifest.embed])
}

/**
 * The only request classes a declared `connect` origin may be reached through.
 * A positive list, never "anything but a main frame": that would admit
 * scripts, subframes, workers, images, media, beacons and CSP reports, and
 * every ambiguous class Chromium reports as `other`.
 */
const CONNECT_RESOURCE_TYPES = new Set(['xhr', 'webSocket'])

const MAX_RETRY_DELAY_MS = 30_000
const CLEAR_CONCURRENCY = 4
/** A guest normally emits `destroyed` synchronously after `close()`. A broken
 * Electron guest must not hold an account-revocation barrier forever. */
export const APP_VIEW_DESTROY_GRACE_MS = 1_500
/** The renderer paints the titlebar; a view may never cover that band. */
export const APP_VIEW_TOP_INSET_DIPS = ATUM_SHELL_HEADER_HEIGHT

// ---------------------------------------------------------------------------
// Electron seams
// ---------------------------------------------------------------------------

export interface WebRequestLike {
  onBeforeRequest: (
    filter: { urls: string[] },
    listener: (
      details: { url: string; resourceType: string },
      callback: (response: { cancel?: boolean }) => void
    ) => void
  ) => void
  onHeadersReceived: (
    filter: { urls: string[] },
    listener: (
      details: {
        url: string
        resourceType: string
        statusCode: number
        responseHeaders?: Record<string, string[] | string>
        webContentsId?: number
      },
      callback: (response: { cancel?: boolean }) => void
    ) => void
  ) => void
}

export interface SessionLike extends EgressSession {
  webRequest: WebRequestLike
  setPermissionCheckHandler: (handler: (() => boolean) | null) => void
  setPermissionRequestHandler: (
    handler: ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void) | null
  ) => void
  setDevicePermissionHandler?: (handler: (() => boolean) | null) => void
  on: (event: 'will-download', listener: (event: { preventDefault: () => void }) => void) => void
  clearStorageData: () => Promise<void>
  clearCache: () => Promise<void>
}

export interface GuestContentsLike {
  id: number
  getURL?: () => string
  navigationHistory?: { canGoBack(): boolean; goBack(): void }
  isDestroyed: () => boolean
  loadURL: (url: string) => Promise<void>
  close: () => void
  focus: () => void
  send?: (channel: string, payload: unknown) => void
  setWebRTCIPHandlingPolicy: (policy: 'disable_non_proxied_udp') => void
  on: (event: string, listener: (...args: any[]) => void) => void
  once: (event: string, listener: (...args: any[]) => void) => void
  setWindowOpenHandler: (handler: (details: { url: string }) => { action: 'deny' }) => void
}

export interface AppViewLike {
  webContents: GuestContentsLike
  setBounds: (bounds: AppViewBounds) => void
  setVisible: (visible: boolean) => void
}

export interface HostWindowLike {
  isDestroyed: () => boolean
  getContentBounds: () => { width: number; height: number }
  contentView: {
    // Electron's concrete `View` has framework event members beyond the small
    // app-view seam. Keep that vendor surface at this boundary.
    addChildView: (view: any) => void
    removeChildView: (view: any) => void
  }
  webContents: { id: number; send: (channel: string, payload: unknown) => void; focus?: () => void }
  once: (event: 'closed', listener: () => void) => void
}

export interface AppViewWebPreferences {
  partition: string
  contextIsolation: true
  sandbox: true
  nodeIntegration: false
  devTools: false
  navigateOnDragDrop: false
  webSecurity: true
  allowRunningInsecureContent: false
  spellcheck: false
  preload?: string
  additionalArguments?: string[]
}

export interface AppViewIpcEvent {
  sender: { id: number }
}

export interface AppViewControllerDeps {
  /** Matrix's CSS-to-DIP scale. Legacy fixed-scale hosts keep the default 1. */
  zoomFactor?: () => number
  createView: (preferences: AppViewWebPreferences) => AppViewLike
  sessionFromPartition: (partition: string) => SessionLike
  hostWindow: () => HostWindowLike | null
  ipcMain: {
    handle: (channel: string, listener: (event: AppViewIpcEvent, ...args: any[]) => unknown) => void
    removeHandler: (channel: string) => void
  }
  /** `null` until the account runtime is installed; app views fail closed then. */
  surfaces: () => {
    manifest: (app: string) => Promise<AppManifestResponse>
    launch: (app: string, routeId: string) => Promise<AppLaunchIssue>
    panelLink?: (app: string, begin: boolean) => Promise<BotPanelStatus | null>
  } | null
  /** The active account's local key and generation, or `null` when none is active. */
  account: () => { accountKey: string; generation: number } | null
  /** Legacy callers may pass a static catalog; Matrix supplies its live authenticated catalog. */
  knownAppIds: readonly string[] | (() => readonly string[])
  /** Main proves Bot API room/catalog evidence; only v1 may use the plain-page path. */
  openRouteWithoutSession?: (app: string, routeId: string) => boolean
  panelPreload?: string
  userDataPath: string
  readDirectory: (path: string) => Promise<DirectoryEntry[] | null>
  openExternal: (url: string) => Promise<void>
  /** Test seam; production always uses the pinned-address CONNECT transport. */
  createEgress?: typeof createAppViewEgress
  now?: () => number
  randomId?: () => string
  sleep?: (ms: number) => Promise<void>
  /** Return focus to the host selection after the guest's explicit host shortcut. */
  onReturnToHost?: () => void
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

interface ViewRecord {
  viewId: string
  app: string
  routeId: string
  accountKey: string
  generation: number
  partition: string
  webOrigin: string
  /** `networkPolicyFingerprint` of the manifest this view opened under. */
  networkPolicy: string
  view: AppViewLike
  attached: boolean
  visible: boolean
  overlayActive: boolean
  bounds: AppViewBounds | null
  status: AppViewState['status']
  /** Set once `loadURL` for a launch has begun: from here a failure never means "unredeemed". */
  navigationBegun: boolean
  /** One automatic retry per user operation. */
  retryUsed: boolean
  /** The exact launch URL whose main-frame response may carry Moon's landing header. */
  expectedLanding: string | null
  closing: boolean
  operation: Promise<void> | null
  linkWatch: number | null
  launchV2: boolean
  embedNonce: string | null
  routes: { id: string; path: string }[]
  panelNavigation: boolean
  navigationRevision: number
}

function isRefusal(code: string): code is AppViewError {
  return (APP_LAUNCH_REFUSALS as readonly string[]).includes(code) || code === 'rate_limited'
}

/** Moon's landing header (`atum-launch-error`) onto the desktop vocabulary. */
function landingError(value: string): AppViewError {
  switch (value) {
    case 'unlinked':

    case 'not_linked':
      return value

    case 'temporarily_unavailable':

    case 'app_credential_invalid':

    case 'launch_not_configured':
      return 'temporarily_unavailable'

    default:
      // launch_invalid, launch_replayed, launch_unsupported, launch_disabled: a
      // one-time code that did not open a session is a security failure, and
      // it is never retried.
      return 'security_failure'
  }
}

function headerValue(headers: Record<string, string[] | string> | undefined, name: string): string | null {
  if (!headers) {
    return null
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) {
      continue
    }

    const first = Array.isArray(value) ? value[0] : value

    return typeof first === 'string' ? first.trim() : null
  }

  return null
}

function matchesOrigin(url: URL, origin: string): boolean {
  const expected = new URL(origin)
  const protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol

  return protocol === expected.protocol && url.hostname === expected.hostname && url.port === expected.port
}

export interface AppViewController {
  open: (input: AppViewOpenInput) => Promise<AppViewOpenResult>
  setBounds: (input: AppViewBoundsInput) => void
  setVisibility: (input: AppViewVisibilityInput) => void
  focus: (viewId: string) => void
  back: (viewId: string) => void
  external: (viewId: string) => Promise<void>
  reload: (viewId: string) => Promise<void>
  close: (viewId: string) => Promise<void>
  /** Account hand-off barrier: block, destroy, await, deny-all, clear. Rejects on any failure. */
  revokeAccount: (input: { accountKey: string; generation: number }) => Promise<void>
  /** Disconnect one app without closing other apps or signing out of Atum. */
  revokeApp: (input: { accountKey: string; generation: number; app: string }) => Promise<void>
  /** Cold start: clear every partition that can exist on this machine. */
  sweepAllPartitions: () => Promise<void>
  states: () => AppViewState[]
  dispose: () => void
}

export function createAppViewController(deps: AppViewControllerDeps): AppViewController {
  const now = deps.now ?? (() => Date.now())
  const randomId = deps.randomId ?? (() => randomBytes(16).toString('hex'))
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

  const knownAppIds = (): readonly string[] =>
    typeof deps.knownAppIds === 'function' ? deps.knownAppIds() : deps.knownAppIds

  const records = new Map<string, ViewRecord>()
  /** One live view per `{accountKey, app, route_id}` per generation. */
  const liveKeys = new Map<string, string>()

  /**
   * Per-partition network policy. The egress instance/immutable origin set is
   * replaced on a policy change; revocation closes pending and live tunnels.
   */
  const configuredSessions = new Map<
    string,
    {
      session: SessionLike
      origin: string | null
      connectOrigins: ReadonlySet<string>
      deny: boolean
      egress?: AppViewEgress
      egressOrigins?: ReadonlySet<string>
      policyInstalled?: boolean
    }
  >()

  /** Guest webContents id → viewId, for header correlation. */
  const guestIds = new Map<number, string>()
  const popupTimestamps = new Map<number, number[]>()
  /**
   * Accounts whose views may not open: during a hand-off, and after a
   * cleanup failure until a later revocation or sweep succeeds (poisoned).
   */
  const blockedAccounts = new Set<string>()
  const blockedPartitions = new Set<string>()
  const partitionEpochs = new Map<string, number>()
  /** Concurrent opens for one key share one promise, reserved before any await. */
  const openings = new Map<string, Promise<AppViewOpenResult>>()
  const boundHosts = new WeakSet<HostWindowLike>()
  let disposed = false

  const liveKey = (accountKey: string, generation: number, app: string, routeId: string): string =>
    `${accountKey}:${generation}:${app}:${routeId}`

  const currentAccount = (): { accountKey: string; generation: number } => {
    const account = deps.account()

    if (!account || blockedAccounts.has(account.accountKey)) {
      throw new Error('account_unavailable')
    }

    return account
  }

  const isCurrent = (record: ViewRecord): boolean => {
    const account = deps.account()

    return (
      !record.closing &&
      !disposed &&
      !blockedPartitions.has(record.partition) &&
      account !== null &&
      account.accountKey === record.accountKey &&
      account.generation === record.generation
    )
  }

  const emit = (record: ViewRecord, state: Omit<AppViewState, 'viewId'>): void => {
    record.status = state.status

    if (state.error === 'not_linked' && record.launchV2) {void observeLink(record)}
    const host = deps.hostWindow()

    if (host && !host.isDestroyed()) {
      host.webContents.send(APP_VIEW_IPC.state, { viewId: record.viewId, ...state } satisfies AppViewState)
    }
  }

  // Authenticated completion is a retry signal only. The fresh launch checks binding again.
  const observeLink = async (record: ViewRecord): Promise<void> => {
    const surfaces = deps.surfaces()

    if (record.linkWatch === record.navigationRevision || !surfaces?.panelLink || !isCurrent(record)) {return}
    const revision = record.navigationRevision
    record.linkWatch = revision
    const current = () => isCurrent(record) && record.navigationRevision === revision

    try {
      const attempt = await surfaces.panelLink(record.app, true)

      if (!current() || attempt?.state !== 'pending') {return}
      const deadline = now() + 10 * 60_000

      while (current() && now() < deadline) {
        await sleep(3_000)

        if (!current()) {return}
        const status = await surfaces.panelLink(record.app, false)

        if (!current() || !status || status.attempt_id !== attempt.attempt_id) {return}

        if (status.state === 'pending') {continue}

        if (status.state !== 'linked' || status.binding_revision <= attempt.binding_revision) {return}
        // Finish the refused load before spending a new code. No stale operation may win.
        await record.operation

        if (!current()) {return}
        await runOperation(record, () => {
          record.retryUsed = false
          record.navigationBegun = false

          return navigate(record)
        })

        return
      }
    } catch {
      // Keep the actionable not-linked state; reopening/reload can start a new observation.
    } finally {
      if (record.linkWatch === revision) {
        record.linkWatch = null
      }
    }
  }

  // ---- session policy ------------------------------------------------------

  const installRequestFilter = (entry: {
    session: SessionLike
    origin: string | null
    connectOrigins: ReadonlySet<string>
    deny: boolean
  }): void => {
    entry.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      if (entry.deny || !entry.origin) {
        callback({ cancel: true })

        return
      }

      // URL/resource authorization is synchronous. Address validation belongs
      // to the CONNECT transport that dials the checked IP, not a DNS preflight
      // followed by Chromium independently resolving the hostname again.
      const origin = entry.origin
      const connectOrigins = entry.connectOrigins

      try {
        const parsed = new URL(details.url)

        if (['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
          // The app's own origin is navigable and may be reached by any
          // class. A declared origin is data connectivity only.
          const declaredForData =
            connectOrigins.size > 0 &&
            CONNECT_RESOURCE_TYPES.has(details.resourceType) &&
            [...connectOrigins].some(candidate => matchesOrigin(parsed, candidate))

          if (!matchesOrigin(parsed, origin) && !declaredForData) {
            throw new Error('app_view_origin_blocked')
          }

          assertSafeBrowserRequestUrl(parsed.href)
        } else if (details.resourceType === 'mainFrame' || !['about:', 'blob:', 'data:'].includes(parsed.protocol)) {
          throw new Error('app_view_url_blocked')
        }

        callback({})
      } catch {
        callback({ cancel: true })
      }
    })
  }

  const configureSession = async (
    partition: string,
    origin: string,
    connectOrigins: ReadonlySet<string>
  ): Promise<SessionLike> => {
    let entry = configuredSessions.get(partition)

    const sameConnect = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
      left.size === right.size && [...left].every(value => right.has(value))

    if (
      entry &&
      entry.origin !== null &&
      (entry.origin !== origin || !sameConnect(entry.connectOrigins, connectOrigins)) &&
      [...records.values()].some(record => record.partition === partition && !record.view.webContents.isDestroyed())
    ) {
      // The filter is session-wide, so rebinding it would change the network
      // policy underneath a guest that is still painted. Refuse instead.
      throw new Error('app_view_partition_policy_conflict')
    }

    if (!entry) {
      const session = deps.sessionFromPartition(partition)
      entry = { session, origin, connectOrigins, deny: false }
      configuredSessions.set(partition, entry)
    }

    // A startup sweep/revocation may have created the deny-all entry before the
    // first open. It still needs the full guest policy exactly once.
    if (!entry.policyInstalled) {
      const session = entry.session
      entry.policyInstalled = true
      session.setPermissionCheckHandler(() => false)
      session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      session.setDevicePermissionHandler?.(() => false)
      session.on('will-download', event => event.preventDefault())
      installRequestFilter(entry)
      // One controller-owned dispatcher per session: Moon's landing header on a
      // main-frame response is correlated to the guest that navigated.
      session.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
        callback({})

        if (details.resourceType !== 'mainFrame' || typeof details.webContentsId !== 'number') {
          return
        }

        const viewId = guestIds.get(details.webContentsId)
        const record = viewId ? records.get(viewId) : undefined

        if (!record || !isCurrent(record)) {
          return
        }

        // Only the response to the launch navigation main initiated may
        // carry the landing header, and only while that launch is in
        // flight; the correlation is consumed by the first matching response.
        if (record.status !== 'launching' || !record.expectedLanding || details.url !== record.expectedLanding) {
          return
        }

        record.expectedLanding = null
        const landing = headerValue(details.responseHeaders, 'atum-launch-error')

        if (landing) {
          emit(record, { status: 'error', error: landingError(landing) })
        }
      })
    }

    if (entry.origin !== origin || !sameConnect(entry.connectOrigins, connectOrigins) || entry.deny) {
      entry.egress?.close()
      entry.egress = undefined
      entry.origin = origin
      entry.connectOrigins = connectOrigins
      entry.deny = false
    }

    if (!entry.egress) {
      const owned = entry
      owned.egressOrigins = new Set([origin, ...connectOrigins])
      owned.egress = (deps.createEgress ?? createAppViewEgress)(owned.session, () =>
        disposed || owned.deny ? null : (owned.egressOrigins ?? null)
      )
    }

    const pending = entry.egress

    try {
      await pending.ready

      if (disposed || entry.deny || entry.egress !== pending) {
        throw new Error('account_unavailable')
      }
    } catch (error) {
      pending.close()

      if (entry.egress === pending) {
        entry.egress = undefined
      }

      throw error
    }

    return entry.session
  }

  const clearPartition = async (partition: string): Promise<void> => {
    let entry = configuredSessions.get(partition)

    if (!entry) {
      entry = {
        session: deps.sessionFromPartition(partition),
        origin: null,
        connectOrigins: new Set<string>(),
        deny: true
      }
      configuredSessions.set(partition, entry)
      installRequestFilter(entry)
    }

    entry.deny = true
    entry.egress?.close()
    entry.egress = undefined
    entry.egressOrigins = undefined
    entry.origin = null
    entry.connectOrigins = new Set<string>()
    await entry.session.closeAllConnections()
    await entry.session.clearStorageData()
    await entry.session.clearCache()
  }

  // ---- guest policy --------------------------------------------------------

  const attachGuestPolicy = (record: ViewRecord): void => {
    const contents = record.view.webContents
    // Data channels do not require camera/microphone permissions. Force their
    // transport through the partition proxy too, instead of direct UDP egress.
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    guestIds.set(contents.id, record.viewId)

    // Guest preload exposes cosmetic messages only. Never authenticate from this relay.
    contents.on('ipc-message', (event: { senderFrame?: { url: string; parent: unknown } }, channel: string, message: unknown) => {
      if (!record.embedNonce || !isCurrent(record) || channel !== 'atum:panel:guest'
        || !event.senderFrame || event.senderFrame.parent !== null) {return}

      try {
        if (new URL(event.senderFrame.url).origin !== record.webOrigin) {return}
      } catch { return }

      const body = message as { profile?: unknown; type?: unknown; nonce?: unknown }

      if (!body || Object.keys(body).length !== 3 || body.profile !== 'atum.panel/1'
        || body.nonce !== record.embedNonce || (body.type !== 'ready' && body.type !== 'ack')) {return}

      if (body.type === 'ready') {contents.send?.('atum:panel:host', {
        profile: 'atum.panel/1', type: 'host-context', nonce: record.embedNonce,
        surface: 'panel', route_id: record.routeId, chrome: 'host'
      })}
    })

    const guardNavigation = (event: { preventDefault: () => void }, rawUrl: string) => {
      let parsed: URL

      try {
        parsed = new URL(rawUrl)
      } catch {
        event.preventDefault()

        return
      }

      if (parsed.protocol === 'https:' && matchesOrigin(parsed, record.webOrigin)) {
        return
      }

      event.preventDefault()

      if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:') {
        void deps.openExternal(rawUrl).catch(() => undefined)
      }
    }

    contents.on('will-navigate', guardNavigation)
    contents.on('will-redirect', guardNavigation)
    contents.setWindowOpenHandler(details => {
      const window = nextPopupWindow(popupTimestamps.get(contents.id) ?? [], now())
      popupTimestamps.set(contents.id, window.timestamps)

      if (window.allowed) {
        try {
          const parsed = new URL(details.url)

          if (parsed.protocol === 'https:' && matchesOrigin(parsed, record.webOrigin)) {
            if (isCurrent(record) && !contents.isDestroyed()) {
              void contents.loadURL(parsed.toString()).catch(() => undefined)
            }
          } else if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
            void deps.openExternal(parsed.toString()).catch(() => undefined)
          }
        } catch {
          /* refused */
        }
      }

      return { action: 'deny' }
    })
    contents.on('context-menu', (event: { preventDefault: () => void }) => event.preventDefault())
    contents.on('will-attach-webview', (event: { preventDefault: () => void }) => event.preventDefault())
    contents.on(
      'before-input-event',
      (
        event: { preventDefault: () => void },
        input: { type?: string; key?: string; meta?: boolean; control?: boolean; shift?: boolean }
      ) => {
        if (input.type === 'keyDown' && record.panelNavigation && isCurrent(record)) {
          if ((input.meta || input.control) && input.key?.toLowerCase() === 'r') {
            event.preventDefault()
            void controller.reload(record.viewId).catch(() => undefined)

            return
          }

          const digit = (input.meta || input.control) && /^[1-9]$/.test(input.key ?? '')

          if (digit || input.key === 'Escape') {
            event.preventDefault()
            deps.hostWindow()?.webContents.focus?.()
            emit(record, { status: record.status, panelCommand: digit ? Number(input.key) - 1 : 'focus-chat' })

            return
          }
        }

        // Standalone views keep provider keys. Host return is an explicit, documented
        // chord that works on both macOS and other desktop platforms.
        if (
          input.type !== 'keyDown' ||
          input.key?.toLowerCase() !== 'h' ||
          input.shift !== true ||
          (input.meta !== true && input.control !== true)
        ) {
          return
        }

        event.preventDefault()
        const host = deps.hostWindow()

        if (host && !host.isDestroyed()) {
          host.webContents.focus?.()
        }

        deps.onReturnToHost?.()
      }
    )

    const reportNavigation = (_event: unknown, url: string, isMainFrame = true) => {
      if (!isMainFrame || !isCurrent(record)) {
        return
      }

      const match = matchAppPanelRoute(url, record.webOrigin, record.routes)
      emit(record, {
        status: record.status,
        canGoBack: contents.navigationHistory?.canGoBack() ?? false,
        matchedRouteId: match?.id ?? null,
        atRouteRoot: match?.root ?? false
      })
    }

    contents.on('did-navigate', reportNavigation)
    contents.on('did-navigate-in-page', reportNavigation)
    contents.on('did-finish-load', () => {
      // A launch is terminal once its main frame painted. Do not let a stale
      // header from that navigation be consumed by a later retry/reload.
      record.expectedLanding = null

      if (isCurrent(record) && record.status === 'launching') {
        emit(record, { status: 'ready' })
      }
    })
    contents.on(
      'did-fail-load',
      (_event: unknown, code: number, _description: string, _url: string, isMainFrame: boolean) => {
        if (isMainFrame) {
          record.expectedLanding = null

          if (code !== -3 && isCurrent(record)) {
            emit(record, { status: 'error', error: 'load_failed' })
          }
        }
      }
    )
    contents.on('render-process-gone', () => {
      record.expectedLanding = null

      if (isCurrent(record)) {
        emit(record, { status: 'error', error: 'load_failed' })
      }
    })
    contents.on('destroyed', () => {
      guestIds.delete(contents.id)
      popupTimestamps.delete(contents.id)
    })
  }

  /** Bind the window-close contract to the host the first time it is seen. */
  const ensureHostBound = (host: HostWindowLike): void => {
    if (boundHosts.has(host)) {
      return
    }

    boundHosts.add(host)
    host.once('closed', () => {
      for (const record of [...records.values()]) {
        void destroyRecord(record)
      }
    })
  }

  // ---- geometry ------------------------------------------------------------

  const applyLayout = (record: ViewRecord): void => {
    const host = deps.hostWindow()

    if (!host || host.isDestroyed() || record.closing) {
      return
    }

    const shouldAttach = record.visible && !record.overlayActive && record.bounds !== null && isCurrent(record)

    if (shouldAttach) {
      if (!record.attached) {
        host.contentView.addChildView(record.view)
        record.attached = true
      }

      record.view.setBounds(record.bounds!)
      record.view.setVisible(true)
    } else if (record.attached) {
      record.view.setVisible(false)
      host.contentView.removeChildView(record.view)
      record.attached = false
    }
  }

  const clampToHost = (bounds: AppViewBounds): AppViewBounds => {
    const host = deps.hostWindow()

    if (!host || host.isDestroyed()) {
      throw new Error('app_view_host_unavailable')
    }

    const content = host.getContentBounds()
    const clamped = clampBrowserBounds(scaleBrowserBounds(bounds, deps.zoomFactor?.() ?? 1), content)
    const y = Math.max(clamped.y, APP_VIEW_TOP_INSET_DIPS)

    return { x: clamped.x, y, width: clamped.width, height: Math.max(0, clamped.height - (y - clamped.y)) }
  }

  // ---- lifecycle -----------------------------------------------------------

  const destroyRecord = async (record: ViewRecord): Promise<void> => {
    if (record.closing) {
      return
    }

    record.closing = true
    records.delete(record.viewId)
    liveKeys.delete(liveKey(record.accountKey, record.generation, record.app, record.routeId))
    const host = deps.hostWindow()

    if (record.attached && host && !host.isDestroyed()) {
      try {
        record.view.setVisible(false)
        host.contentView.removeChildView(record.view)
      } catch {
        /* the window may be tearing down */
      }
    }

    record.attached = false
    const contents = record.view.webContents

    if (!contents.isDestroyed()) {
      const destroyed = new Promise<void>(resolve => {
        contents.once('destroyed', () => resolve())
      })

      try {
        contents.close()
      } catch {
        // A teardown race is already contained by record removal and the
        // account partition's deny-and-clear barrier below.
      }

      await Promise.race([destroyed, sleep(APP_VIEW_DESTROY_GRACE_MS)])
    }

    emit(record, { status: 'destroyed' })
  }

  const refusalError = (error: unknown): { error: AppViewError; retryAfterMs?: number; retryable: boolean } => {
    const transport = appViewTransportFailure(error)

    if (transport) {
      if (isRefusal(transport.code)) {
        const retryAfterMs =
          typeof transport.details?.retry_after_ms === 'number'
            ? Math.min(transport.details.retry_after_ms, MAX_RETRY_DELAY_MS)
            : (transport.retryAfterMs ?? undefined)

        const retryable = transport.code === 'temporarily_unavailable' || transport.code === 'rate_limited'

        return { error: transport.code as AppViewError, retryAfterMs, retryable }
      }

      if (transport.code === 'app_surface_cancelled' || transport.code === 'account_unavailable') {
        return { error: 'account_unavailable', retryable: false }
      }
    }

    return { error: 'temporarily_unavailable', retryable: false }
  }

  /**
   * Resolve and navigate. Exactly one automatic retry per user operation,
   * and only when the platform's answer proves a fresh launch is safe.
   */
  const navigate = async (record: ViewRecord): Promise<void> => {
    const surfaces = deps.surfaces()

    if (!surfaces || !isCurrent(record)) {
      emit(record, { status: 'error', error: 'account_unavailable' })

      return
    }

    record.navigationRevision += 1
    emit(record, { status: 'launching' })
    // A prior navigation may have failed without a response header. Its
    // landing correlation must never survive into this fresh operation.
    record.expectedLanding = null

    let manifest: AppManifestResponse

    try {
      manifest = await surfaces.manifest(record.app)
    } catch (error) {
      if (!isCurrent(record)) {
        return
      }

      const refusal = refusalError(error)
      emit(record, { status: 'error', error: refusal.error === 'route_unknown' ? 'app_unavailable' : refusal.error })

      return
    }

    if (!isCurrent(record)) {
      return
    }

    if (networkPolicyFingerprint(manifest) !== record.networkPolicy) {
      // The origin, the app version, or the reach it granted changed under
      // us. The session was configured for the old one, and a repin that
      // narrows reach must not leave this view running with the old grant.
      // Refuse rather than rebind silently; a fresh open adopts the new
      // policy.
      emit(record, { status: 'error', error: 'app_unavailable' })

      return
    }

    const route = manifest.manifest.routes.find(entry => entry.id === record.routeId)

    if (!route) {
      emit(record, { status: 'error', error: 'route_unknown' })

      return
    }

    let target: string

    if (route.session === 'none' || (manifest.manifest.launch?.profile === 'atum.app-launch/1'
      && deps.openRouteWithoutSession?.(record.app, record.routeId) === true)) {
      target = `${manifest.web_origin}${route.path}`
    } else {
      let issued: AppLaunchIssue

      try {
        issued = await surfaces.launch(record.app, record.routeId)
      } catch (error) {
        if (!isCurrent(record)) {
          return
        }

        const refusal = refusalError(error)

        if (refusal.retryable && !record.retryUsed) {
          record.retryUsed = true
          const delay = refusal.retryAfterMs ?? 1_000
          emit(record, { status: 'launching', retryAfterMs: delay })
          await sleep(Math.min(delay, MAX_RETRY_DELAY_MS))

          if (!isCurrent(record)) {
            return
          }

          return navigate(record)
        }

        emit(record, {
          status: 'error',
          error: refusal.error,
          ...(refusal.retryAfterMs === undefined ? {} : { retryAfterMs: refusal.retryAfterMs })
        })

        return
      }

      if (!isCurrent(record)) {
        return
      }

      if (issued.expiresAt <= now()) {
        if (!record.retryUsed && !record.navigationBegun) {
          // Expired before any navigation: provably unredeemed, one fresh launch.
          record.retryUsed = true

          return navigate(record)
        }

        // A second expired launch is never navigated.
        emit(record, { status: 'error', error: 'temporarily_unavailable' })

        return
      }

      target = issued.launchUrl
      record.expectedLanding = issued.launchUrl
    }

    if (!isCurrent(record) || record.view.webContents.isDestroyed()) {
      return
    }

    record.navigationBegun = true

    try {
      await record.view.webContents.loadURL(target)
    } catch {
      // Once loadURL has begun, nothing is "unredeemed": report, never relaunch.
      if (isCurrent(record) && record.status === 'launching') {
        emit(record, { status: 'error', error: 'load_failed' })
      }
    }
  }

  const runOperation = (record: ViewRecord, work: () => Promise<void>): Promise<void> => {
    if (record.operation) {
      return record.operation
    }

    const operation = work().finally(() => {
      if (record.operation === operation) {
        record.operation = null
      }
    })

    record.operation = operation

    return operation
  }

  // ---- public API ----------------------------------------------------------

  const requireRecord = (viewId: unknown, sender: AppViewIpcEvent['sender']): ViewRecord => {
    const host = deps.hostWindow()

    if (!host || host.isDestroyed() || host.webContents.id !== sender.id) {
      throw new Error('untrusted_renderer')
    }

    const record = typeof viewId === 'string' ? records.get(viewId) : undefined

    if (!record || record.closing) {
      throw new Error('app_view_unknown')
    }

    return record
  }

  const open = async (input: AppViewOpenInput, sender?: AppViewIpcEvent['sender']): Promise<AppViewOpenResult> => {
    const host = deps.hostWindow()

    if (!host || host.isDestroyed()) {
      throw new Error('app_view_host_unavailable')
    }

    if (sender && host.webContents.id !== sender.id) {
      throw new Error('untrusted_renderer')
    }

    const app = typeof input?.app === 'string' ? input.app.trim().toLowerCase() : ''
    const routeId = typeof input?.route_id === 'string' ? input.route_id.trim() : ''

    if (!isAppId(app) || !knownAppIds().includes(app)) {
      throw new Error('app_id_invalid')
    }

    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(routeId)) {
      throw new Error('route_unknown')
    }

    ensureHostBound(host)
    const account = currentAccount()

    if (blockedPartitions.has(appViewPartition(account.accountKey, app))) {
      throw new Error('account_unavailable')
    }

    const key = liveKey(account.accountKey, account.generation, app, routeId)
    const existing = liveKeys.get(key)

    if (existing) {
      const record = records.get(existing)

      if (record && !record.closing) {
        if (record.status === 'error') {
          // A refused view is re-opened as a new user operation (fresh
          // retry budget, fresh launch) instead of being focused as-is.
          void runOperation(record, () => {
            record.retryUsed = false
            record.navigationBegun = false

            return navigate(record)
          })
        }

        record.view.webContents.focus()

        return { viewId: existing }
      }
    }

    // Reserve the key before the first await so concurrent opens for the
    // same {account, generation, app, route} share one outcome.
    const inFlight = openings.get(key)

    if (inFlight) {
      return inFlight
    }

    const opening = createView(account, key, app, routeId, input.panelNavigation === true).finally(() => {
      if (openings.get(key) === opening) {
        openings.delete(key)
      }
    })

    openings.set(key, opening)

    return opening
  }

  const createView = async (
    account: { accountKey: string; generation: number },
    key: string,
    app: string,
    routeId: string,
    panelNavigation: boolean
  ): Promise<AppViewOpenResult> => {
    const surfaces = deps.surfaces()

    if (!surfaces) {
      throw new Error('account_unavailable')
    }

    // The manifest decides the origin the partition is locked to before any
    // guest exists; the route must be declared.
    const partition = appViewPartition(account.accountKey, app)
    const expectedEpoch = partitionEpochs.get(partition) ?? 0
    const manifest = await surfaces.manifest(app)
    const current = deps.account()

    if (
      !current ||
      current.accountKey !== account.accountKey ||
      current.generation !== account.generation ||
      blockedAccounts.has(account.accountKey) ||
      blockedPartitions.has(partition) ||
      (partitionEpochs.get(partition) ?? 0) !== expectedEpoch
    ) {
      throw new Error('account_unavailable')
    }

    if (!manifest.manifest.routes.some(route => route.id === routeId)) {
      throw new Error('route_unknown')
    }

    await configureSession(
      partition,
      manifest.web_origin,
      new Set(manifest.network_origins.filter(entry => entry.kinds.includes('connect')).map(entry => entry.origin))
    )

    const afterNetwork = deps.account()

    if (
      disposed ||
      !afterNetwork ||
      afterNetwork.accountKey !== account.accountKey ||
      afterNetwork.generation !== account.generation ||
      blockedAccounts.has(account.accountKey) ||
      blockedPartitions.has(partition) ||
      (partitionEpochs.get(partition) ?? 0) !== expectedEpoch
    ) {
      throw new Error('account_unavailable')
    }

    const embedNonce = manifest.manifest.embed && deps.panelPreload ? randomUUID() : null

    const view = deps.createView({
      ...(embedNonce ? { preload: deps.panelPreload, additionalArguments: [`--atum-panel-nonce=${embedNonce}`] } : {}),
      partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: false,
      navigateOnDragDrop: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false
    })

    const record: ViewRecord = {
      viewId: randomId(),
      app,
      routeId,
      accountKey: account.accountKey,
      generation: account.generation,
      partition,
      webOrigin: manifest.web_origin,
      networkPolicy: networkPolicyFingerprint(manifest),
      view,
      attached: false,
      visible: false,
      overlayActive: false,
      bounds: null,
      status: 'launching',
      navigationBegun: false,
      retryUsed: false,
      expectedLanding: null,
      closing: false,
      operation: null,
      linkWatch: null,
      launchV2: manifest.manifest.launch?.profile === 'atum.app-launch/2',
      embedNonce,
      routes: manifest.manifest.routes,
      panelNavigation,
      navigationRevision: 0
    }

    records.set(record.viewId, record)
    liveKeys.set(key, record.viewId)
    attachGuestPolicy(record)
    void runOperation(record, () => navigate(record))

    return { viewId: record.viewId }
  }

  const controller: AppViewController = {
    open: input => open(input),
    setBounds: input => {
      const record = records.get(input?.viewId)

      if (!record || record.closing) {
        throw new Error('app_view_unknown')
      }

      record.bounds = clampToHost(input.bounds)
      applyLayout(record)
    },
    setVisibility: input => {
      const record = records.get(input?.viewId)

      if (!record || record.closing) {
        throw new Error('app_view_unknown')
      }

      record.visible = input.visible === true
      record.overlayActive = input.overlayActive === true
      applyLayout(record)
    },
    focus: viewId => {
      const record = records.get(viewId)

      if (record && !record.closing && record.attached && !record.view.webContents.isDestroyed()) {
        record.view.webContents.focus()
      }
    },
    back: viewId => {
      const record = records.get(viewId)

      if (record && isCurrent(record) && record.view.webContents.navigationHistory?.canGoBack()) {
        record.view.webContents.navigationHistory.goBack()
      }
    },
    external: async viewId => {
      const record = records.get(viewId)

      if (!record || !isCurrent(record)) {
        return
      }

      const current = record.view.webContents.getURL?.()
      const match = current ? matchAppPanelRoute(current, record.webOrigin, record.routes) : null
      const route = record.routes.find(entry => entry.id === (match?.id ?? record.routeId))

      if (!route) {
        return
      }

      const url = new URL(route.path, record.webOrigin)
      url.search = ''
      url.hash = ''
      await deps.openExternal(url.toString())
    },
    reload: async viewId => {
      const record = records.get(viewId)

      if (!record || record.closing) {
        throw new Error('app_view_unknown')
      }

      // A reload is a new user operation: one retry budget, one fresh launch
      // for a session-required route.
      await runOperation(record, () => {
        record.retryUsed = false
        record.navigationBegun = false

        return navigate(record)
      })
    },
    close: async viewId => {
      const record = records.get(viewId)

      if (record) {
        await destroyRecord(record)
      }
    },
    revokeAccount: async ({ accountKey, generation }) => {
      // Blocked from here; released only by this revocation succeeding or by
      // a later complete sweep. A failed clear leaves the account poisoned.
      blockedAccounts.add(accountKey)

      const outgoing = [...records.values()].filter(
        record => record.accountKey === accountKey && record.generation <= generation
      )

      await Promise.all(outgoing.map(record => destroyRecord(record)))
      const partitions = new Set<string>()

      for (const app of knownAppIds().filter(isAppId)) {
        partitions.add(appViewPartition(accountKey, app))
      }

      for (const record of outgoing) {
        partitions.add(record.partition)
      }

      await forEachBounded([...partitions], CLEAR_CONCURRENCY, clearPartition)

      for (const partition of partitions) {
        blockedPartitions.delete(partition)
      }

      blockedAccounts.delete(accountKey)
    },
    revokeApp: async ({ accountKey, generation, app }) => {
      // Revocation may arrive after the authenticated catalog has already
      // removed the app. It is a cleanup authority, not an open grant.
      if (!isAppId(app)) {
        throw new Error('app_id_invalid')
      }

      const partition = appViewPartition(accountKey, app)
      blockedPartitions.add(partition)
      partitionEpochs.set(partition, (partitionEpochs.get(partition) ?? 0) + 1)
      const expectedEpoch = partitionEpochs.get(partition)

      const outgoing = [...records.values()].filter(
        record => record.accountKey === accountKey && record.generation <= generation && record.app === app
      )

      for (const key of openings.keys()) {
        if (key.startsWith(`${accountKey}:${generation}:${app}:`)) {
          openings.delete(key)
        }
      }

      await Promise.all(outgoing.map(record => destroyRecord(record)))
      await clearPartition(partition)

      if (partitionEpochs.get(partition) === expectedEpoch) {
        blockedPartitions.delete(partition)
      }
    },
    sweepAllPartitions: async () => {
      const partitions = await discoverAppViewPartitions({
        userDataPath: deps.userDataPath,
        knownAppIds: knownAppIds(),
        readDirectory: deps.readDirectory,
        livePartitions: [...records.values()].map(record => record.partition)
      })

      await forEachBounded(partitions, CLEAR_CONCURRENCY, clearPartition)
      // A complete sweep proves every partition clean: lift any poison.
      blockedAccounts.clear()
      blockedPartitions.clear()
    },
    states: () => [...records.values()].map(record => ({ viewId: record.viewId, status: record.status })),
    dispose: () => {
      disposed = true

      for (const entry of configuredSessions.values()) {
        entry.deny = true
        entry.egress?.close()
        void entry.session.closeAllConnections().catch(() => undefined)
      }

      for (const channel of [
        APP_VIEW_IPC.open,
        APP_VIEW_IPC.bounds,
        APP_VIEW_IPC.visibility,
        APP_VIEW_IPC.focus,
        APP_VIEW_IPC.reload,
        APP_VIEW_IPC.back,
        APP_VIEW_IPC.external,
        APP_VIEW_IPC.close
      ]) {
        deps.ipcMain.removeHandler(channel)
      }

      for (const record of records.values()) {
        void destroyRecord(record)
      }
    }
  }

  // ---- IPC (trusted sender only; results are values or a stable error code) --

  const guarded = <T>(work: () => T | Promise<T>): Promise<{ error: string } | T> =>
    Promise.resolve()
      .then(work)
      .catch((error: unknown) => ({ error: error instanceof Error ? error.message : 'app_view_failed' }))

  deps.ipcMain.handle(APP_VIEW_IPC.open, (event, input: AppViewOpenInput) => guarded(() => open(input, event.sender)))
  deps.ipcMain.handle(APP_VIEW_IPC.bounds, (event, input: AppViewBoundsInput) =>
    guarded(() => {
      requireRecord(input?.viewId, event.sender)
      controller.setBounds(input)

      return { ok: true }
    })
  )
  deps.ipcMain.handle(APP_VIEW_IPC.visibility, (event, input: AppViewVisibilityInput) =>
    guarded(() => {
      requireRecord(input?.viewId, event.sender)
      controller.setVisibility(input)

      return { ok: true }
    })
  )
  deps.ipcMain.handle(APP_VIEW_IPC.focus, (event, viewId: string) =>
    guarded(() => {
      requireRecord(viewId, event.sender)
      controller.focus(viewId)

      return { ok: true }
    })
  )
  deps.ipcMain.handle(APP_VIEW_IPC.reload, (event, viewId: string) =>
    guarded(async () => {
      requireRecord(viewId, event.sender)
      await controller.reload(viewId)

      return { ok: true }
    })
  )

  for (const action of ['back', 'external'] as const) {
    deps.ipcMain.handle(APP_VIEW_IPC[action], (event, viewId: string) =>
      guarded(async () => {
        requireRecord(viewId, event.sender)
        await controller[action](viewId)

        return { ok: true }
      })
    )
  }

  deps.ipcMain.handle(APP_VIEW_IPC.close, (event, viewId: string) =>
    guarded(async () => {
      requireRecord(viewId, event.sender)
      await controller.close(viewId)

      return { ok: true }
    })
  )

  const initialHost = deps.hostWindow()

  if (initialHost && !initialHost.isDestroyed()) {
    ensureHostBound(initialHost)
  }

  return controller
}

/** Longest whole-segment match. URLs and paths stay in main. */
export function matchAppPanelRoute(raw: string, origin: string, routes: { id: string; path: string }[]) {
  try {
    const url = new URL(raw)

    if (url.origin !== origin) {
      return null
    }

    const path = url.pathname.replace(/\/$/, '') || '/'

    const matches = routes
      .map(route => ({ ...route, path: new URL(route.path, origin).pathname.replace(/\/$/, '') || '/' }))
      .filter(route => path === route.path || route.path === '/' || path.startsWith(`${route.path}/`))
      .sort((a, b) => b.path.length - a.path.length)

    return matches[0] ? { id: matches[0].id, root: path === matches[0].path } : null
  } catch {
    return null
  }
}
