import assert from 'node:assert/strict'

import { expect, test, vi } from 'vitest'

import { APP_VIEW_IPC, type AppViewState } from '../../shared/app-view/ipc'
import type { BotPanelStatus } from '../../shared/app-view/protocol'
import type { AppLaunchIssue, AppManifestResponse } from '../atum-messaging/app-surfaces'
import { MessagingHttpError } from '../atum-messaging/http-client'
import { createMatrixApps } from '../matrix/app-workspace'

import {
  APP_VIEW_TOP_INSET_DIPS,
  type AppViewLike,
  type AppViewWebPreferences,
  createAppViewController,
  type GuestContentsLike,
  type SessionLike
} from './controller'
import type { createAppViewEgress } from './egress'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const WEB_ORIGIN = 'https://moon.atumplatform.com'

function manifest(
  overrides: Partial<AppManifestResponse['manifest']> = {},
  response: Partial<AppManifestResponse> = {}
): AppManifestResponse {
  return {
    web_origin: WEB_ORIGIN,
    network_origins: [],
    manifest: {
      profile: 'atum.remote-app-manifest/1',
      manifest_version: '1.0.0',
      app: {
        id: '00000000-0000-4000-8000-e79acd97ac88',
        slug: 'moon',
        app_version_id: '00000000-0000-4000-8000-a9703d75e616',
        name: { vi: 'Moon', en: 'Moon' },
        verified: true,
        availability: 'available'
      },
      link: { mode: 'external_account', state: 'linked' },
      launch: { profile: 'atum.app-launch/1', path: '/atum/launch' },
      routes: [
        {
          id: 'readings',
          label: { vi: 'Lá số', en: 'Readings' },
          icon: 'moon',
          path: '/readings',
          placements: ['menu'],
          session: 'required'
        },
        {
          id: 'pricing',
          label: { vi: 'Giá', en: 'Pricing' },
          icon: 'tag',
          path: '/pricing',
          placements: ['menu'],
          session: 'none'
        }
      ],
      ...overrides
    },
    ...response
  }
}

function launchIssue(code = 'Q'.repeat(43), expiresAt = Date.now() + 45_000): AppLaunchIssue {
  return { launchUrl: `${WEB_ORIGIN}/atum/launch?code=${code}`, expiresAt }
}

interface FakeGuest extends GuestContentsLike {
  loaded: string[]
  destroyed: boolean
  listeners: Map<string, Array<(...args: any[]) => void>>
  emit: (event: string, ...args: any[]) => void
  windowOpen: ((details: { url: string }) => { action: 'deny' }) | null
}

let nextGuestId = 100

function fakeGuest(): FakeGuest {
  const listeners = new Map<string, Array<(...args: any[]) => void>>()

  const guest: FakeGuest = {
    id: nextGuestId++,
    loaded: [],
    destroyed: false,
    listeners,
    windowOpen: null,
    isDestroyed: () => guest.destroyed,
    loadURL: async url => {
      guest.loaded.push(url)
    },
    close: () => {
      guest.destroyed = true
      guest.emit('destroyed')
    },
    focus: () => undefined,
    setWebRTCIPHandlingPolicy: vi.fn(),
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    once: (event, listener) => {
      const wrapped = (...args: any[]) => {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter(entry => entry !== wrapped)
        )
        listener(...args)
      }

      listeners.set(event, [...(listeners.get(event) ?? []), wrapped])
    },
    setWindowOpenHandler: handler => {
      guest.windowOpen = handler
    },
    emit: (event, ...args) => {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        listener(...args)
      }
    }
  }

  return guest
}

interface FakeView extends AppViewLike {
  webContents: FakeGuest
  bounds: { x: number; y: number; width: number; height: number } | null
  visible: boolean
  partition: string
}

interface FakeSession extends SessionLike {
  partition: string
  cleared: number
  cacheCleared: number
  before:
    | ((details: { url: string; resourceType: string }, callback: (response: { cancel?: boolean }) => void) => void)
    | null
  headers: ((details: any, callback: (response: { cancel?: boolean }) => void) => void) | null
  downloads: Array<(event: { preventDefault: () => void }) => void>
}

function harness(
  options: {
    surfaces?: Partial<{
      manifest: (app: string) => Promise<AppManifestResponse>
      launch: (app: string, routeId: string) => Promise<AppLaunchIssue>
      panelLink: (app: string, begin: boolean) => Promise<BotPanelStatus | null>
    }> | null
    account?: { accountKey: string; generation: number } | null
    knownAppIds?: readonly string[] | (() => readonly string[])
    openRouteWithoutSession?: (app: string, routeId: string) => boolean
    panelPreload?: string
    onReturnToHost?: () => void
    createEgress?: typeof createAppViewEgress
    zoomFactor?: () => number
  } = {}
) {
  const views: FakeView[] = []
  const preferencesSeen: AppViewWebPreferences[] = []
  const sessions = new Map<string, FakeSession>()
  const attached: FakeView[] = []
  const sent: AppViewState[] = []
  const external: string[] = []
  const handlers = new Map<string, (event: any, ...args: any[]) => unknown>()
  let account = options.account === undefined ? { accountKey: KEY_A, generation: 1 } : options.account

  const surfaces =
    options.surfaces === null
      ? null
      : {
          manifest: vi.fn(async () => manifest()),
          launch: vi.fn(async () => launchIssue()),
          ...options.surfaces
        }

  let hostDestroyed = false

  const host = {
    isDestroyed: () => hostDestroyed,
    getContentBounds: () => ({ width: 1200, height: 800 }),
    contentView: {
      addChildView: (view: AppViewLike) => {
        attached.push(view as FakeView)
      },
      removeChildView: (view: AppViewLike) => {
        const index = attached.indexOf(view as FakeView)

        if (index >= 0) {
          attached.splice(index, 1)
        }
      }
    },
    webContents: {
      id: 1,
      send: (_channel: string, payload: unknown) => {
        sent.push(payload as AppViewState)
      },
      focus: vi.fn()
    },
    once: () => undefined
  }

  const controller = createAppViewController({
    createView: preferences => {
      preferencesSeen.push(preferences)

      const view: FakeView = {
        webContents: fakeGuest(),
        bounds: null,
        visible: false,
        partition: preferences.partition,
        setBounds: b => {
          view.bounds = b
        },
        setVisible: v => {
          view.visible = v
        }
      }

      assert.equal(preferences.devTools, false)
      assert.equal(preferences.navigateOnDragDrop, false)
      assert.equal(preferences.sandbox, true)
      views.push(view)

      return view
    },
    sessionFromPartition: partition => {
      let session = sessions.get(partition)

      if (!session) {
        session = {
          partition,
          cleared: 0,
          cacheCleared: 0,
          before: null,
          headers: null,
          downloads: [],
          setProxy: async () => undefined,
          resolveProxy: async () => 'test-only-unused',
          closeAllConnections: async () => undefined,
          webRequest: {
            onBeforeRequest: (_filter, listener) => {
              session!.before = listener
            },
            onHeadersReceived: (_filter, listener) => {
              session!.headers = listener
            }
          },
          setPermissionCheckHandler: vi.fn(),
          setPermissionRequestHandler: vi.fn(),
          setDevicePermissionHandler: () => undefined,
          on: (_event, listener) => {
            session!.downloads.push(listener)
          },
          clearStorageData: async () => {
            session!.cleared += 1
          },
          clearCache: async () => {
            session!.cacheCleared += 1
          }
        }
        sessions.set(partition, session)
      }

      return session
    },
    hostWindow: () => host,
    zoomFactor: options.zoomFactor,
    ipcMain: {
      handle: (channel, listener) => {
        handlers.set(channel, listener)
      },
      removeHandler: channel => {
        handlers.delete(channel)
      }
    },
    openRouteWithoutSession: options.openRouteWithoutSession,
    panelPreload: options.panelPreload,
    surfaces: () => surfaces,
    account: () => account,
    knownAppIds: options.knownAppIds ?? ['moon', 'andy'],
    userDataPath: '/ud',
    readDirectory: async () => null,
    openExternal: async url => {
      external.push(url)
    },
    createEgress: options.createEgress ?? (() => ({ ready: Promise.resolve(), close: () => undefined })),
    randomId: (() => {
      let n = 0

      return () => `view-${++n}`
    })(),
    sleep: async () => undefined,
    onReturnToHost: options.onReturnToHost
  })

  const settle = () => new Promise(resolve => setTimeout(resolve, 5))

  return {
    controller,
    preferencesSeen,
    views,
    sessions,
    attached,
    sent,
    external,
    handlers,
    surfaces,
    settle,
    host,
    setAccount: (next: typeof account) => {
      account = next
    },
    destroyHost: () => {
      hostDestroyed = true
    },
    invoke: (channel: string, senderId: number, ...args: unknown[]) =>
      handlers.get(channel)!({ sender: { id: senderId } }, ...args)
  }
}

test('a session-required route is opened from {app, route_id} only: main resolves the manifest, mints the launch, and navigates', async () => {
  const h = harness()
  const { viewId } = await h.controller.open({ app: 'moon', route_id: 'readings' })
  await h.settle()
  expect(viewId).toBe('view-1')
  expect(h.surfaces!.launch).toHaveBeenCalledWith('moon', 'readings')
  expect(h.views[0].partition).toBe(`persist:atum-app-${KEY_A}-moon`)
  expect(h.views[0].webContents.loaded).toEqual([`${WEB_ORIGIN}/atum/launch?code=${'Q'.repeat(43)}`])
  // The renderer saw only the view id and typed state.
  expect(JSON.stringify(h.sent)).not.toContain('atum/launch')
  expect(JSON.stringify(h.sent)).not.toContain(WEB_ORIGIN)
  expect(h.sent[0]).toEqual({ viewId, status: 'launching' })
  h.views[0].webContents.emit('did-finish-load')
  expect(h.sent.at(-1)).toEqual({ viewId, status: 'ready' })
})

test('a Matrix composer-only function reaches the real native launch authority', async () => {
  const declaration = manifest()
  declaration.manifest.routes = [{ ...declaration.manifest.routes[0], id: 'top-up', path: '/pricing', placements: ['composer'] }]

  const app = {
    app: 'moon', app_id: declaration.manifest.app.id, app_version_id: declaration.manifest.app.app_version_id,
    name: { en: 'Moon', vi: 'Moon' }, subtitle: null, description: null, icon: null, accent: null, affiliation: 'first_party',
    verified: true, availability: 'available', roster_default: true, roster_order: 1, supported_modes: ['direct'],
    has_surface: true, link: { mode: 'external_account', state: 'linked' }
  }

  const request = vi.fn(async (resource: { action?: string }, body?: unknown) => {
    if (!resource.action) {return { profile: 'atum.app-catalog/1', apps: [app] }}

    if (resource.action === 'manifest') {return { profile: 'atum.app-workspace/1', descriptor: app, ...declaration }}

    if (resource.action === 'launch') {
      expect(body).toEqual({ app_version_id: app.app_version_id, route_id: 'top-up' })

      return { launch_url: `${WEB_ORIGIN}/atum/launch?code=${'Q'.repeat(43)}`, expires_at: new Date(Date.now() + 45_000).toISOString() }
    }

    throw new Error('unexpected_request')
  })

  const apps = createMatrixApps({
    account: { appScope: () => ({ accountKey: KEY_A, generation: 1 }), readDomain: async () => {}, appRequest: request } as never,
    views: () => h.controller, resource: 'https://matrix.test/api/matrix/v1', openExternal: async () => {}, changed: () => {}, catalogChanged: async () => {}
  })

  const h = harness({ surfaces: apps.surfaces })
  await apps.refresh()
  expect((await apps.menu(app.app_id)).actions).toEqual([expect.objectContaining({ id: 'top-up' })])
  await h.controller.open({ app: 'moon', route_id: 'top-up' })
  await h.settle()
  expect(h.views[0].webContents.loaded).toEqual([`${WEB_ORIGIN}/atum/launch?code=${'Q'.repeat(43)}`])
  expect(request).toHaveBeenCalledWith({ app: 'moon', action: 'launch' }, { app_version_id: app.app_version_id, route_id: 'top-up' })
  h.controller.dispose()
})

test('a session-free route navigates to the declared path without spending a launch', async () => {
  const h = harness()
  await h.controller.open({ app: 'moon', route_id: 'pricing' })
  await h.settle()
  expect(h.surfaces!.launch).not.toHaveBeenCalled()
  expect(h.views[0].webContents.loaded).toEqual([`${WEB_ORIGIN}/pricing`])
})

test('the guest return chord focuses the host and leaves Escape to provider dialogs', async () => {
  const onReturnToHost = vi.fn()
  const h = harness({ onReturnToHost })
  await h.controller.open({ app: 'moon', route_id: 'readings' })
  const guest = h.views[0]!.webContents
  const returned = { preventDefault: vi.fn() }
  const escape = { preventDefault: vi.fn() }

  guest.emit('before-input-event', returned, { type: 'keyDown', key: 'H', meta: true, shift: true })
  guest.emit('before-input-event', returned, { type: 'keyUp', key: 'H', meta: true, shift: true })
  guest.emit('before-input-event', escape, { key: 'Escape' })

  expect(returned.preventDefault).toHaveBeenCalledOnce()
  expect(h.host.webContents.focus).toHaveBeenCalledOnce()
  expect(onReturnToHost).toHaveBeenCalledOnce()
  expect(escape.preventDefault).not.toHaveBeenCalled()
})

test('known app ids may be supplied by a live authenticated catalog', async () => {
  let ids: readonly string[] = ['moon']
  const h = harness({ knownAppIds: () => ids })
  await h.controller.open({ app: 'moon', route_id: 'readings' })
  ids = ['andy']
  await assert.rejects(h.controller.open({ app: 'moon', route_id: 'readings' }), /app_id_invalid/)
  await h.controller.revokeApp({ accountKey: KEY_A, generation: 1, app: 'moon' })
  expect(h.sessions.get(`persist:atum-app-${KEY_A}-moon`)!.cleared).toBe(1)
})

test('unknown apps, undeclared routes, and a missing account fail closed before any guest exists', async () => {
  const h = harness()
  await assert.rejects(h.controller.open({ app: 'evil', route_id: 'readings' }), /app_id_invalid/)
  await assert.rejects(h.controller.open({ app: 'moon', route_id: 'nope' }), /route_unknown/)
  await assert.rejects(h.controller.open({ app: 'moon', route_id: '/readings' }), /route_unknown/)
  expect(h.views).toHaveLength(0)
  h.setAccount(null)
  await assert.rejects(h.controller.open({ app: 'moon', route_id: 'readings' }), /account_unavailable/)
  expect(h.views).toHaveLength(0)
})

test('one live view per {account, generation, app, route}: a second open returns the same view id', async () => {
  const h = harness()
  const first = await h.controller.open({ app: 'moon', route_id: 'readings' })
  const second = await h.controller.open({ app: 'moon', route_id: 'readings' })
  expect(second.viewId).toBe(first.viewId)
  expect(h.views).toHaveLength(1)
  await h.controller.close(first.viewId)
  const third = await h.controller.open({ app: 'moon', route_id: 'readings' })
  expect(third.viewId).not.toBe(first.viewId)
})

test('only the active, unobstructed view is attached; bounds are clamped below the titlebar band', async () => {
  const h = harness()
  const { viewId } = await h.controller.open({ app: 'moon', route_id: 'readings' })
  await h.settle()
  expect(h.attached).toHaveLength(0)
  h.controller.setBounds({ viewId, bounds: { x: 10, y: 5, width: 5000, height: 5000 } })
  h.controller.setVisibility({ viewId, visible: true, overlayActive: false })
  expect(h.attached).toHaveLength(1)
  expect(h.views[0].bounds).toEqual({
    x: 10,
    y: APP_VIEW_TOP_INSET_DIPS,
    width: 1190,
    height: 800 - 5 - (APP_VIEW_TOP_INSET_DIPS - 5)
  })
  h.controller.setVisibility({ viewId, visible: true, overlayActive: true })
  expect(h.attached).toHaveLength(0)
  expect(h.views[0].visible).toBe(false)
  h.controller.setVisibility({ viewId, visible: false, overlayActive: false })
  expect(h.attached).toHaveLength(0)
  assert.throws(
    () => h.controller.setBounds({ viewId, bounds: { x: -1, y: 0, width: 10, height: 10 } }),
    /browser_bounds_invalid/
  )
})

test('Matrix app views follow current shell zoom without weakening titlebar, clipping or raw bounds validation', async () => {
  let factor = 0.9
  const h = harness({ zoomFactor: () => factor })
  const { viewId } = await h.controller.open({ app: 'moon', route_id: 'readings' })
  await h.settle()
  h.controller.setVisibility({ viewId, visible: true, overlayActive: false })

  for (const zoom of [0.9, 1.1]) {
    factor = zoom
    h.controller.setBounds({ viewId, bounds: { x: 100, y: 100, width: 600, height: 500 } })
    expect(h.views[0].bounds).toEqual({ x: Math.round(100 * zoom), y: Math.round(100 * zoom), width: Math.round(600 * zoom), height: Math.round(500 * zoom) })
    h.controller.setBounds({ viewId, bounds: { x: 0, y: 5, width: 5000, height: 5000 } })
    expect(h.views[0].bounds).toEqual({ x: 0, y: APP_VIEW_TOP_INSET_DIPS, width: 1200, height: 800 - APP_VIEW_TOP_INSET_DIPS })
    expect(() => h.controller.setBounds({ viewId, bounds: { x: -0.1, y: 50, width: 10, height: 10 } })).toThrow('browser_bounds_invalid')
  }
})

test('guest navigation is confined to the approved origin; everything else leaves through the handoff and popups are denied', async () => {
  const h = harness()
  const { viewId } = await h.controller.open({ app: 'moon', route_id: 'readings' })
  await h.settle()
  const guest = h.views[0].webContents
  const prevented: string[] = []
  const navigate = (url: string) => guest.emit('will-navigate', { preventDefault: () => prevented.push(url) }, url)
  navigate(`${WEB_ORIGIN}/readings/1`)
  navigate('https://evil.example/steal')
  navigate('javascript:alert(1)')
  expect(prevented).toEqual(['https://evil.example/steal', 'javascript:alert(1)'])
  await h.settle()
  expect(h.external).toEqual(['https://evil.example/steal'])
  expect(guest.windowOpen!({ url: 'https://other.example/popup' })).toEqual({ action: 'deny' })
  await h.settle()
  expect(h.external).toEqual(['https://evil.example/steal', 'https://other.example/popup'])
  expect(guest.windowOpen!({ url: `${WEB_ORIGIN}/same-origin` })).toEqual({ action: 'deny' })
  await h.settle()
  expect(guest.loaded.at(-1)).toBe(`${WEB_ORIGIN}/same-origin`)
  expect(viewId).toBe('view-1')
})

test('the session locks requests to the approved origin and refuses downloads and permissions', async () => {
  const h = harness()
  await h.controller.open({ app: 'moon', route_id: 'readings' })
  const session = h.sessions.get(`persist:atum-app-${KEY_A}-moon`)!

  const decide = (url: string, resourceType = 'xhr') =>
    new Promise<boolean>(resolve => session.before!({ url, resourceType }, response => resolve(!response.cancel)))

  expect(await decide(`${WEB_ORIGIN}/api/x`)).toBe(true)
  expect(await decide('wss://moon.atumplatform.com/socket')).toBe(true)
  expect(await decide('https://evil.example/x')).toBe(false)
  expect(await decide('file:///etc/passwd', 'mainFrame')).toBe(false)
  let refused = false

  for (const listener of session.downloads) {
    listener({
      preventDefault: () => {
        refused = true
      }
    })
  }

  expect(refused).toBe(true)
})

test("Moon's landing header on the launch response maps to the typed vocabulary", async () => {
  for (const [header, expected] of [
    ['unlinked', 'unlinked'],
    ['launch_replayed', 'security_failure'],
    ['temporarily_unavailable', 'temporarily_unavailable']
  ] as const) {
    const h = harness()
    const { viewId } = await h.controller.open({ app: 'moon', route_id: 'readings' })
    await h.settle()
    const session = h.sessions.get(`persist:atum-app-${KEY_A}-moon`)!
    const guestId = h.views[0].webContents.id
    const launchUrl = `${WEB_ORIGIN}/atum/launch?code=${'Q'.repeat(43)}`

    const deliver = (extra: Record<string, unknown> = {}) =>
      session.headers!(
        {
          url: launchUrl,
          resourceType: 'mainFrame',
          statusCode: 409,
          responseHeaders: { 'Atum-Launch-Error': [header] },
          webContentsId: guestId,
          ...extra
        },
        () => undefined
      )

    const before = h.sent.length
    deliver({ resourceType: 'subFrame' })
    deliver({ webContentsId: 999 })
    deliver({ url: 'https://evil.example/atum/launch?code=' + 'Q'.repeat(43) })
    expect(h.sent).toHaveLength(before)
    deliver()
    expect(h.sent.at(-1)).toEqual({ viewId, status: 'error', error: expected })
  }
})

test('launch refusals are typed, retried at most once only when provably safe, and never after loadURL began', async () => {
  const refusal = (code: string, status = 409, details: Record<string, unknown> = { launch_error: code }) =>
    new MessagingHttpError(code, status, code === 'temporarily_unavailable', null, null, details)

  const h = harness({
    surfaces: {
      launch: vi.fn(async () => {
        throw refusal('unlinked')
      })
    }
  })

  const { viewId } = await h.controller.open({ app: 'moon', route_id: 'readings' })
  await h.settle()
  expect(h.sent.at(-1)).toEqual({ viewId, status: 'error', error: 'unlinked' })
  expect(h.surfaces!.launch).toHaveBeenCalledTimes(1)

  const terminal = harness({
    surfaces: {
      launch: vi.fn().mockRejectedValue(new MessagingHttpError('app_unavailable', 503, true, null, null, null))
    }
  })

  const terminalView = await terminal.controller.open({ app: 'moon', route_id: 'readings' })
  await terminal.settle()
  expect(terminal.surfaces!.launch).toHaveBeenCalledTimes(1)
  expect(terminal.sent.at(-1)).toEqual({ viewId: terminalView.viewId, status: 'error', error: 'app_unavailable' })

  const flaky = harness({
    surfaces: {
      launch: vi
        .fn()
        .mockRejectedValueOnce(new MessagingHttpError('rate_limited', 429, true, null, null, { retry_after_ms: 900 }))
        .mockResolvedValue(launchIssue())
    }
  })

  const second = await flaky.controller.open({ app: 'moon', route_id: 'readings' })
  await flaky.settle()
  expect(flaky.surfaces!.launch).toHaveBeenCalledTimes(2)
  expect(flaky.sent.map(state => state.status)).toEqual(['launching', 'launching', 'launching'])
  expect(flaky.sent[1]).toEqual({ viewId: second.viewId, status: 'launching', retryAfterMs: 900 })
  expect(flaky.views[0].webContents.loaded).toHaveLength(1)

  const twice = harness({ surfaces: { launch: vi.fn().mockRejectedValue(refusal('temporarily_unavailable', 503)) } })
  const third = await twice.controller.open({ app: 'moon', route_id: 'readings' })
  await twice.settle()
  expect(twice.surfaces!.launch).toHaveBeenCalledTimes(2)
  expect(twice.sent.at(-1)).toEqual({ viewId: third.viewId, status: 'error', error: 'temporarily_unavailable' })

  const expired = harness({
    surfaces: {
      launch: vi
        .fn()
        .mockResolvedValueOnce(launchIssue('E'.repeat(43), Date.now() - 1))
        .mockResolvedValue(launchIssue())
    }
  })

  await expired.controller.open({ app: 'moon', route_id: 'readings' })
  await expired.settle()
  expect(expired.surfaces!.launch).toHaveBeenCalledTimes(2)
  expect(expired.views[0].webContents.loaded).toEqual([`${WEB_ORIGIN}/atum/launch?code=${'Q'.repeat(43)}`])

  const failing = harness()
  failing.views.length = 0
  const record = await failing.controller.open({ app: 'moon', route_id: 'readings' })
  await failing.settle()
  failing.views[0].webContents.emit('did-fail-load', {}, -105, 'name not resolved', `${WEB_ORIGIN}/atum/launch`, true)
  expect(failing.sent.at(-1)).toEqual({ viewId: record.viewId, status: 'error', error: 'load_failed' })
  expect(failing.surfaces!.launch).toHaveBeenCalledTimes(1)
})

test('reload is a new user operation that spends one fresh launch', async () => {
  const h = harness()
  const { viewId } = await h.controller.open({ app: 'moon', route_id: 'readings' })
  await h.settle()
  await h.controller.reload(viewId)
  expect(h.surfaces!.launch).toHaveBeenCalledTimes(2)
  expect(h.views[0].webContents.loaded).toHaveLength(2)
})

test('disconnect clears only the selected app and leaves other app views alive', async () => {
  const h = harness()
  await h.controller.open({ app: 'moon', route_id: 'readings' })
  await h.controller.open({ app: 'andy', route_id: 'readings' })
  await h.settle()
  await h.controller.revokeApp({ accountKey: KEY_A, generation: 1, app: 'moon' })
  expect(h.views[0].webContents.destroyed).toBe(true)
  expect(h.views[1].webContents.destroyed).toBe(false)
  expect(h.sessions.get(`persist:atum-app-${KEY_A}-moon`)!.cleared).toBe(1)
  expect(h.sessions.get(`persist:atum-app-${KEY_A}-andy`)!.cleared).toBe(0)
})

test('a manifest returned after disconnect cannot recreate the old app view', async () => {
  let release!: (value: AppManifestResponse) => void

  const h = harness({
    surfaces: {
      manifest: () =>
        new Promise(resolve => {
          release = resolve
        })
    }
  })

  const opening = h.controller.open({ app: 'moon', route_id: 'readings' })
  const rejected = assert.rejects(opening, /account_unavailable/)
  await h.controller.revokeApp({ accountKey: KEY_A, generation: 1, app: 'moon' })
  release(manifest())
  await rejected
  expect(h.views).toHaveLength(0)
})

test('failed app cleanup blocks new views until a successful cleanup', async () => {
  const h = harness()
  await h.controller.open({ app: 'moon', route_id: 'readings' })
  const session = h.sessions.get(`persist:atum-app-${KEY_A}-moon`)!

  session.clearStorageData = async () => {
    throw new Error('disk')
  }

  await assert.rejects(h.controller.revokeApp({ accountKey: KEY_A, generation: 1, app: 'moon' }), /disk/)
  await assert.rejects(h.controller.open({ app: 'moon', route_id: 'readings' }), /account_unavailable/)
  session.clearStorageData = async () => undefined
  await h.controller.revokeApp({ accountKey: KEY_A, generation: 1, app: 'moon' })
  await h.controller.open({ app: 'moon', route_id: 'readings' })
})

test('account revocation destroys the outgoing guests, awaits them, then clears every partition behind deny-all; a stale continuation is dropped', async () => {
  let release: (value: AppLaunchIssue) => void = () => undefined

  const h = harness({
    surfaces: {
      launch: vi.fn(
        () =>
          new Promise<AppLaunchIssue>(resolve => {
            release = resolve
          })
      )
    }
  })

  const { viewId } = await h.controller.open({ app: 'moon', route_id: 'readings' })
  h.controller.setBounds({ viewId, bounds: { x: 0, y: 40, width: 800, height: 600 } })
  h.controller.setVisibility({ viewId, visible: true, overlayActive: false })
  expect(h.attached).toHaveLength(1)
  const barrier = h.controller.revokeAccount({ accountKey: KEY_A, generation: 1 })
  h.setAccount({ accountKey: KEY_B, generation: 2 })
  await barrier
  expect(h.attached).toHaveLength(0)
  expect(h.views[0].webContents.destroyed).toBe(true)
  expect(h.sent.at(-1)).toEqual({ viewId, status: 'destroyed' })
  const moon = h.sessions.get(`persist:atum-app-${KEY_A}-moon`)!
  const andy = h.sessions.get(`persist:atum-app-${KEY_A}-andy`)!
  expect([moon.cleared, moon.cacheCleared, andy.cleared, andy.cacheCleared]).toEqual([1, 1, 1, 1])
  // Deny-all stays installed after clearing.
  expect(
    await new Promise<boolean>(resolve =>
      moon.before!({ url: `${WEB_ORIGIN}/x`, resourceType: 'xhr' }, response => resolve(!response.cancel))
    )
  ).toBe(false)
  // The launch that resolves after the switch never navigates anything.
  release(launchIssue())
  await h.settle()
  expect(h.views[0].webContents.loaded).toEqual([])
  // The new account cannot reuse the old view.
  const fresh = await h.controller.open({ app: 'moon', route_id: 'readings' })
  expect(fresh.viewId).not.toBe(viewId)
  expect(h.views[1].partition).toBe(`persist:atum-app-${KEY_B}-moon`)
})

test('account revocation finishes its deny-and-clear barrier when a broken guest never emits destroyed', async () => {
  const h = harness()
  await h.controller.open({ app: 'moon', route_id: 'readings' })
  const guest = h.views[0]!.webContents

  guest.close = () => {
    guest.destroyed = true
  }

  await h.controller.revokeAccount({ accountKey: KEY_A, generation: 1 })

  const moon = h.sessions.get(`persist:atum-app-${KEY_A}-moon`)!
  expect(moon.cleared).toBe(1)
  expect(moon.cacheCleared).toBe(1)
  expect(h.controller.states()).toEqual([])
})

test('a failed clear rejects the barrier so the incoming account is blocked', async () => {
  const h = harness()
  await h.controller.open({ app: 'moon', route_id: 'readings' })
  const moon = h.sessions.get(`persist:atum-app-${KEY_A}-moon`)!

  moon.clearStorageData = async () => {
    throw new Error('disk')
  }

  await assert.rejects(h.controller.revokeAccount({ accountKey: KEY_A, generation: 1 }), /disk/)
})

test('the cold-start sweep clears every discoverable partition, including ones no account root names', async () => {
  const h = harness()

  const controller = createAppViewController({
    createView: () => {
      throw new Error('unused')
    },
    sessionFromPartition: partition =>
      h.sessions.get(partition) ??
      (() => {
        const session: FakeSession = {
          partition,
          cleared: 0,
          cacheCleared: 0,
          before: null,
          headers: null,
          downloads: [],
          setProxy: async () => undefined,
          resolveProxy: async () => 'test-only-unused',
          closeAllConnections: async () => undefined,
          webRequest: {
            onBeforeRequest: (_f, l) => {
              session.before = l
            },
            onHeadersReceived: () => undefined
          },
          setPermissionCheckHandler: () => undefined,
          setPermissionRequestHandler: () => undefined,
          on: () => undefined,
          clearStorageData: async () => {
            session.cleared += 1
          },
          clearCache: async () => {
            session.cacheCleared += 1
          }
        }

        h.sessions.set(partition, session)

        return session
      })(),
    hostWindow: () => null,
    ipcMain: { handle: () => undefined, removeHandler: () => undefined },
    surfaces: () => null,
    account: () => null,
    knownAppIds: ['moon'],
    userDataPath: '/ud',
    readDirectory: async path =>
      path === '/ud/Partitions'
        ? [{ name: `atum-app-${KEY_B}-taylor`, isDirectory: true, isSymbolicLink: false }]
        : null,
    openExternal: async () => undefined
  })

  await controller.sweepAllPartitions()
  expect([...h.sessions.keys()].sort()).toEqual([`persist:atum-app-${KEY_B}-taylor`, 'persist:atum-app-moon'])
  expect(h.sessions.get('persist:atum-app-moon')!.cleared).toBe(1)
})

test('IPC accepts only the host renderer and never throws or leaks at it', async () => {
  const h = harness()
  const opened = (await h.invoke(APP_VIEW_IPC.open, 1, { app: 'moon', route_id: 'readings' })) as { viewId: string }
  expect(opened.viewId).toBe('view-1')
  expect(await h.invoke(APP_VIEW_IPC.open, 2, { app: 'moon', route_id: 'readings' })).toEqual({
    error: 'untrusted_renderer'
  })
  expect(
    await h.invoke(APP_VIEW_IPC.bounds, 2, { viewId: opened.viewId, bounds: { x: 0, y: 40, width: 10, height: 10 } })
  ).toEqual({ error: 'untrusted_renderer' })
  expect(
    await h.invoke(APP_VIEW_IPC.bounds, 1, { viewId: 'nope', bounds: { x: 0, y: 40, width: 10, height: 10 } })
  ).toEqual({ error: 'app_view_unknown' })
  expect(
    await h.invoke(APP_VIEW_IPC.visibility, 1, { viewId: opened.viewId, visible: true, overlayActive: false })
  ).toEqual({ ok: true })
  expect(await h.invoke(APP_VIEW_IPC.close, 1, opened.viewId)).toEqual({ ok: true })
  expect(await h.invoke(APP_VIEW_IPC.open, 1, { app: 'moon' })).toEqual({ error: 'route_unknown' })
  const payloads = JSON.stringify(h.sent)
  expect(payloads).not.toContain('http')
})

test('concurrent opens for one key share one view; a refused view is re-opened as a new operation', async () => {
  let releaseManifest: (value: AppManifestResponse) => void = () => undefined

  const h = harness({
    surfaces: {
      manifest: vi.fn(
        () =>
          new Promise<AppManifestResponse>(resolve => {
            releaseManifest = resolve
          })
      )
    }
  })

  const first = h.controller.open({ app: 'moon', route_id: 'readings' })
  const second = h.controller.open({ app: 'moon', route_id: 'readings' })
  releaseManifest(manifest())
  const [a, b] = await Promise.all([first, second])
  expect(a.viewId).toBe(b.viewId)
  expect(h.views).toHaveLength(1)

  const refused = harness({
    surfaces: {
      launch: vi
        .fn()
        .mockRejectedValueOnce(new MessagingHttpError('unlinked', 409, false, null, null, { launch_error: 'unlinked' }))
        .mockResolvedValue(launchIssue())
    }
  })

  const { viewId } = await refused.controller.open({ app: 'moon', route_id: 'readings' })
  await refused.settle()
  expect(refused.sent.at(-1)).toEqual({ viewId, status: 'error', error: 'unlinked' })
  const again = await refused.controller.open({ app: 'moon', route_id: 'readings' })
  await refused.settle()
  expect(again.viewId).toBe(viewId)
  expect(refused.views).toHaveLength(1)
  expect(refused.surfaces!.launch).toHaveBeenCalledTimes(2)
  expect(refused.views[0].webContents.loaded).toHaveLength(1)
})

test('a second expired launch is refused, never navigated', async () => {
  const h = harness({ surfaces: { launch: vi.fn().mockResolvedValue(launchIssue('E'.repeat(43), Date.now() - 1)) } })
  const { viewId } = await h.controller.open({ app: 'moon', route_id: 'readings' })
  await h.settle()
  expect(h.surfaces!.launch).toHaveBeenCalledTimes(2)
  expect(h.views[0].webContents.loaded).toEqual([])
  expect(h.sent.at(-1)).toEqual({ viewId, status: 'error', error: 'temporarily_unavailable' })
})

test('the landing header is accepted only for the launch response main initiated, once', async () => {
  const h = harness()
  const { viewId } = await h.controller.open({ app: 'moon', route_id: 'readings' })
  await h.settle()
  const session = h.sessions.get(`persist:atum-app-${KEY_A}-moon`)!
  const guestId = h.views[0].webContents.id

  const deliver = (url: string) =>
    session.headers!(
      {
        url,
        resourceType: 'mainFrame',
        statusCode: 409,
        responseHeaders: { 'atum-launch-error': ['unlinked'] },
        webContentsId: guestId
      },
      () => undefined
    )

  const before = h.sent.length
  // An unrelated same-origin main-frame response never overwrites the state.
  deliver(`${WEB_ORIGIN}/readings`)
  expect(h.sent).toHaveLength(before)
  deliver(`${WEB_ORIGIN}/atum/launch?code=${'Q'.repeat(43)}`)
  expect(h.sent.at(-1)).toEqual({ viewId, status: 'error', error: 'unlinked' })
  // Consumed: a replayed response changes nothing, and neither does one after ready.
  const after = h.sent.length
  deliver(`${WEB_ORIGIN}/atum/launch?code=${'Q'.repeat(43)}`)
  expect(h.sent).toHaveLength(after)
})

test('a failed launch clears header correlation before a fresh navigation', async () => {
  const h = harness({
    surfaces: {
      launch: vi
        .fn()
        .mockResolvedValueOnce(launchIssue('Q'.repeat(43)))
        .mockResolvedValueOnce(launchIssue('Z'.repeat(43)))
    }
  })

  const { viewId } = await h.controller.open({ app: 'moon', route_id: 'readings' })
  await h.settle()
  const session = h.sessions.get(`persist:atum-app-${KEY_A}-moon`)!
  const guestId = h.views[0]!.webContents.id
  const firstUrl = `${WEB_ORIGIN}/atum/launch?code=${'Q'.repeat(43)}`

  h.views[0]!.webContents.emit('did-fail-load', {}, -105, 'name not resolved', firstUrl, true)
  await h.controller.reload(viewId)
  await h.settle()

  const beforeStaleHeader = h.sent.length
  session.headers!(
    {
      url: firstUrl,
      resourceType: 'mainFrame',
      statusCode: 409,
      responseHeaders: { 'atum-launch-error': ['unlinked'] },
      webContentsId: guestId
    },
    () => undefined
  )

  expect(h.sent).toHaveLength(beforeStaleHeader)
})

test('a failed clear poisons the account until a later revocation or sweep succeeds', async () => {
  const h = harness()
  await h.controller.open({ app: 'moon', route_id: 'readings' })
  const moon = h.sessions.get(`persist:atum-app-${KEY_A}-moon`)!
  const original = moon.clearStorageData

  moon.clearStorageData = async () => {
    throw new Error('disk')
  }

  await assert.rejects(h.controller.revokeAccount({ accountKey: KEY_A, generation: 1 }), /disk/)
  await assert.rejects(h.controller.open({ app: 'moon', route_id: 'readings' }), /account_unavailable/)
  moon.clearStorageData = original
  await h.controller.revokeAccount({ accountKey: KEY_A, generation: 1 })
  await h.controller.open({ app: 'moon', route_id: 'readings' })
  expect(h.views).toHaveLength(2)
})

test('the window-close contract binds to the host that exists when a view opens', async () => {
  let closed: (() => void) | null = null

  const h = harness()

  ;(h as unknown as { host?: unknown }).host = undefined

  const controller = createAppViewController({
    createView: preferences => {

      const view: FakeView = {
        webContents: fakeGuest(),
        bounds: null,
        visible: false,
        partition: preferences.partition,
        setBounds: b => {
          view.bounds = b
        },
        setVisible: v => {
          view.visible = v
        }
      }

      h.views.push(view)

      return view
    },
    sessionFromPartition: partition =>
      h.sessions.get(partition) ??
      (() => {
        const s = {
          partition,
          cleared: 0,
          cacheCleared: 0,
          before: null,
          headers: null,
          downloads: [],
          webRequest: { onBeforeRequest: () => undefined, onHeadersReceived: () => undefined },
          setPermissionCheckHandler: () => undefined,
          setPermissionRequestHandler: () => undefined,
          on: () => undefined,
          clearStorageData: async () => undefined,
          clearCache: async () => undefined
        } as unknown as FakeSession

        h.sessions.set(partition, s)

        return s
      })(),
    hostWindow: () => ({
      isDestroyed: () => false,
      getContentBounds: () => ({ width: 800, height: 600 }),
      contentView: { addChildView: () => undefined, removeChildView: () => undefined },
      webContents: { id: 1, send: () => undefined },
      once: (_event: 'closed', listener: () => void) => {
        closed = listener
      }
    }),
    ipcMain: { handle: () => undefined, removeHandler: () => undefined },
    surfaces: () => h.surfaces,
    account: () => ({ accountKey: KEY_A, generation: 1 }),
    knownAppIds: ['moon'],
    userDataPath: '/ud',
    readDirectory: async () => null,
    openExternal: async () => undefined,
    createEgress: () => ({ ready: Promise.resolve(), close: () => undefined }),
    randomId: () => 'view-x',
    sleep: async () => undefined
  })

  await controller.open({ app: 'moon', route_id: 'readings' })
  expect(closed).not.toBeNull()
  closed!()
  await h.settle()
  expect(h.views.at(-1)!.webContents.destroyed).toBe(true)
  expect(controller.states()).toEqual([])
})

test('network preparation completes before creating a guest and cannot outlive revocation', async () => {
  let release!: () => void
  const close = vi.fn()

  const h = harness({
    createEgress: () => ({
      ready: new Promise<void>(resolve => {
        release = resolve
      }),
      close
    })
  })

  const opened = h.controller.open({ app: 'moon', route_id: 'readings' })
  const rejected = assert.rejects(opened, /account_unavailable/)
  await h.settle()
  expect(h.views).toHaveLength(0)
  await h.controller.revokeAccount({ accountKey: KEY_A, generation: 1 })
  expect(close).toHaveBeenCalledOnce()
  release()
  await rejected
  expect(h.views).toHaveLength(0)
})

test('network setup failure never creates an unguarded guest', async () => {
  const h = harness({
    createEgress: () => ({ ready: Promise.reject(Error('app_egress_unavailable')), close: vi.fn() })
  })

  await assert.rejects(h.controller.open({ app: 'moon', route_id: 'readings' }), /app_egress_unavailable/)
  expect(h.views).toHaveLength(0)
})

test('a partition created by cleanup gets its complete permission policy on first open', async () => {
  const h = harness()
  await h.controller.revokeApp({ accountKey: KEY_A, generation: 1, app: 'moon' })
  const target = h.sessions.get(`persist:atum-app-${KEY_A}-moon`)!
  expect(target.setPermissionRequestHandler).not.toHaveBeenCalled()
  await h.controller.open({ app: 'moon', route_id: 'readings' })
  expect(target.setPermissionCheckHandler).toHaveBeenCalledOnce()
  expect(target.setPermissionRequestHandler).toHaveBeenCalledOnce()
  expect(target.headers).not.toBeNull()
})

test('a partition is never rebound to a new origin while a guest is live', async () => {
  const h = harness()
  await h.controller.open({ app: 'moon', route_id: 'readings' })
  const session = h.sessions.get(`persist:atum-app-${KEY_A}-moon`)!

  // The request filter is session-wide. Re-pointing it under a painted guest
  // would change that guest's network policy, so the second open is refused.
  h.surfaces!.manifest = vi.fn(async () => ({ ...(await manifest()), web_origin: 'https://elsewhere.example' }))
  await assert.rejects(h.controller.open({ app: 'moon', route_id: 'pricing' }), /app_view_partition_policy_conflict/)

  const decide = (url: string) =>
    new Promise<boolean>(resolve =>
      session.before!({ url, resourceType: 'xhr' }, response => resolve(!response.cancel))
    )

  assert.equal(await decide(`${WEB_ORIGIN}/api/x`), true)
  assert.equal(await decide('https://elsewhere.example/api/x'), false)
})

const CONNECT_ORIGIN = 'https://data.example'

function withConnectOrigin() {
  return harness({
    surfaces: {
      manifest: vi.fn(async () =>
        manifest(
          {},
          {
            network_origins: [{ origin: CONNECT_ORIGIN, kinds: ['connect'] }]
          }
        )
      )
    }
  })
}

/**
 * A declared origin is data connectivity, nothing else. The classification is
 * a positive list: written as "anything but a main frame" it would admit
 * scripts, subframes, workers, images, media, beacons and CSP reports, and
 * every ambiguous class Chromium reports as `other`.
 */
test('a declared connect origin is reachable for data and for nothing else', async () => {
  const h = withConnectOrigin()
  await h.controller.open({ app: 'moon', route_id: 'readings' })
  const session = h.sessions.get(`persist:atum-app-${KEY_A}-moon`)!

  const decide = (url: string, resourceType: string) =>
    new Promise<boolean>(resolve => session.before!({ url, resourceType }, response => resolve(!response.cancel)))

  assert.equal(await decide(`${CONNECT_ORIGIN}/auth/v1/user`, 'xhr'), true)
  assert.equal(await decide('wss://data.example/realtime', 'webSocket'), true)

  for (const resourceType of [
    'mainFrame',
    'subFrame',
    'script',
    'stylesheet',
    'image',
    'font',
    'media',
    'object',
    'ping',
    'cspReport',
    'other'
  ]) {
    assert.equal(await decide(`${CONNECT_ORIGIN}/x`, resourceType), false, resourceType)
  }
})

/**
 * Moon renders its payment QR as a `data:` URL — a server-rendered PNG, or one
 * the page generates itself from the transfer payload. That is the primary way
 * a purchase is paid for inside an app view, and it reaches the filter as an
 * image whose URL matches no declared origin, because it is not an origin at
 * all. Refusing it would blank the QR with no error anywhere: the panel just
 * renders a payment the user cannot complete. Documents stay excluded, so a
 * `data:` or `blob:` URL still cannot become the top-level page.
 */
test('a page-generated resource is reachable, but can never become the document', async () => {
  const h = harness()
  await h.controller.open({ app: 'moon', route_id: 'readings' })
  const session = h.sessions.get(`persist:atum-app-${KEY_A}-moon`)!

  const decide = (url: string, resourceType: string) =>
    new Promise<boolean>(resolve => session.before!({ url, resourceType }, response => resolve(!response.cancel)))

  const qr = 'data:image/png;base64,iVBORw0KGgo='

  assert.equal(await decide(qr, 'image'), true)
  assert.equal(await decide('blob:https://moon.atumplatform.com/8f2c', 'image'), true)
  assert.equal(await decide('about:blank', 'subFrame'), true)

  assert.equal(await decide(qr, 'mainFrame'), false)
  assert.equal(await decide('blob:https://moon.atumplatform.com/8f2c', 'mainFrame'), false)
  // Only these three schemes are page-generated. Anything else is still a URL
  // the app fetched from somewhere, and is judged as one.
  assert.equal(await decide('file:///etc/passwd', 'image'), false)
})

test('an undeclared origin stays unreachable, and the app origin is unchanged', async () => {
  const h = withConnectOrigin()
  await h.controller.open({ app: 'moon', route_id: 'readings' })
  const session = h.sessions.get(`persist:atum-app-${KEY_A}-moon`)!

  const decide = (url: string, resourceType: string) =>
    new Promise<boolean>(resolve => session.before!({ url, resourceType }, response => resolve(!response.cancel)))

  assert.equal(await decide('https://elsewhere.example/api', 'xhr'), false)
  assert.equal(await decide('https://data.example.evil/api', 'xhr'), false)
  // http is never declarable, so a matching hostname on http is still refused.
  assert.equal(await decide('http://data.example/api', 'xhr'), false)
  // The app's own origin keeps every class it had, including documents.
  assert.equal(await decide(`${WEB_ORIGIN}/page`, 'mainFrame'), true)
  assert.equal(await decide(`${WEB_ORIGIN}/api/x`, 'xhr'), true)
})

test('one egress boundary owns the app and declared connect origins and is revoked on dispose', async () => {
  let origins!: () => ReadonlySet<string> | null
  const close = vi.fn()

  const h = harness({
    createEgress: (_session, current) => {
      origins = current

      return { ready: Promise.resolve(), close }
    },
    surfaces: {
      manifest: vi.fn(async () =>
        manifest(
          {},
          {
            network_origins: [{ origin: CONNECT_ORIGIN, kinds: ['connect'] }]
          }
        )
      )
    }
  })

  await h.controller.open({ app: 'moon', route_id: 'readings' })
  expect(origins()).toEqual(new Set([WEB_ORIGIN, CONNECT_ORIGIN]))
  expect(h.views[0].webContents.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp')
  h.controller.dispose()
  expect(close).toHaveBeenCalledOnce()
  expect(origins()).toBeNull()
})

/**
 * A view is bound to the reach it opened under. Otherwise a repin that
 * narrows an app's origins would leave an already-open view running the new
 * code with the old grant, which is exactly what version binding exists to
 * prevent.
 */
test('a reload refuses a manifest that grants differently than the view opened under', async () => {
  for (const changed of [
    { network_origins: [] },
    { network_origins: [{ origin: 'https://other.example', kinds: ['connect'] as Array<'connect'> }] }
  ]) {
    const h = withConnectOrigin()
    const { viewId } = await h.controller.open({ app: 'moon', route_id: 'readings' })

    h.surfaces!.manifest = vi.fn(async () => manifest({}, changed))
    await h.controller.reload(viewId!)
    await h.settle()

    assert.equal(h.sent.at(-1)?.error, 'app_unavailable', JSON.stringify(changed))
  }
})

test('a reload refuses a manifest whose app version changed, even with the same reach', async () => {
  const h = withConnectOrigin()
  const { viewId } = await h.controller.open({ app: 'moon', route_id: 'readings' })

  h.surfaces!.manifest = vi.fn(async () => {
    const response = manifest({}, { network_origins: [{ origin: CONNECT_ORIGIN, kinds: ['connect'] }] })

    return {
      ...response,
      manifest: {
        ...response.manifest,
        app: { ...response.manifest.app, app_version_id: '00000000-0000-4000-8000-f2da1f9533d4' }
      }
    }
  })

  await h.controller.reload(viewId!)
  await h.settle()
  assert.equal(h.sent.at(-1)?.error, 'app_unavailable')
})

test('a reload proceeds when the manifest grants exactly what the view opened under', async () => {
  const h = withConnectOrigin()
  const { viewId } = await h.controller.open({ app: 'moon', route_id: 'readings' })

  await h.controller.reload(viewId!)
  await h.settle()
  assert.notEqual(h.sent.at(-1)?.error, 'app_unavailable')
})

const panelStatus = (state: 'pending' | 'linked' | 'unlinked' | 'expired', revision = 0) => ({
  profile: 'atum.bot-panel-status/1' as const,
  attempt_id: '00000000-0000-4000-8000-bd7662a5eeb4', state, binding_revision: revision
})

const unknownManifest = () => {
  const value = manifest({ launch: { profile: 'atum.app-launch/2', path: '/atum/launch' } })
  value.manifest.app.slug = 'unknown-orchid'

  return value
}

function refuseGuest(h: ReturnType<typeof harness>) {
  const guest = h.views[0].webContents
  h.sessions.get(h.views[0].partition)!.headers!({
    url: guest.loaded[0], resourceType: 'mainFrame', statusCode: 409,
    responseHeaders: { 'Atum-Launch-Error': ['not_linked'] }, webContentsId: guest.id
  }, () => {})
}

test('an unknown v2 app spends a launch in its partition, then completion relaunches once', async () => {
  const panelLink = vi.fn().mockResolvedValueOnce(panelStatus('pending')).mockResolvedValue(panelStatus('linked', 1))
  const h = harness({ knownAppIds: ['unknown-orchid'], surfaces: { manifest: async () => unknownManifest(), panelLink } })
  await h.controller.open({ app: 'unknown-orchid', route_id: 'readings' })
  await h.settle()
  expect(h.views[0].partition).toBe(`persist:atum-app-${KEY_A}-unknown-orchid`)
  expect(h.surfaces!.launch).toHaveBeenCalledTimes(1)
  refuseGuest(h)
  await h.settle()
  expect(panelLink.mock.calls).toEqual([['unknown-orchid', true], ['unknown-orchid', false]])
  expect(h.surfaces!.launch).toHaveBeenCalledTimes(2)
  expect(h.views[0].webContents.loaded).toHaveLength(2)
  h.controller.dispose()
})

for (const change of ['account', 'unlink', 'close'] as const) {
  test(`completion after ${change} cannot relaunch the outgoing unknown app`, async () => {
    let complete!: (value: ReturnType<typeof panelStatus>) => void
    const panelLink = vi.fn().mockResolvedValueOnce(panelStatus('pending')).mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const h = harness({ knownAppIds: ['unknown-orchid'], surfaces: { manifest: async () => unknownManifest(), panelLink } })
    const { viewId } = await h.controller.open({ app: 'unknown-orchid', route_id: 'readings' })
    await h.settle()
    refuseGuest(h)
    await h.settle()

    if (change === 'account') {h.setAccount({ accountKey: KEY_B, generation: 2 })}

    if (change === 'unlink') {await h.controller.revokeApp({ accountKey: KEY_A, generation: 1, app: 'unknown-orchid' })}

    if (change === 'close') {await h.controller.close(viewId)}
    complete(panelStatus('linked', 1))
    await h.settle()
    expect(h.surfaces!.launch).toHaveBeenCalledTimes(1)
    h.controller.dispose()
  })
}

for (const status of [panelStatus('unlinked', 1), panelStatus('linked', 0), { ...panelStatus('linked', 1), attempt_id: '00000000-0000-4000-8000-b454f82c5857' }]) {
  test(`a nonmatching completion cannot authorize a relaunch: ${JSON.stringify(status)}`, async () => {
    const panelLink = vi.fn().mockResolvedValueOnce(panelStatus('pending')).mockResolvedValue(status)
    const h = harness({ knownAppIds: ['unknown-orchid'], surfaces: { manifest: async () => unknownManifest(), panelLink } })
    await h.controller.open({ app: 'unknown-orchid', route_id: 'readings' })
    await h.settle()
    refuseGuest(h)
    await h.settle()
    expect(h.surfaces!.launch).toHaveBeenCalledTimes(1)
    h.controller.dispose()
  })
}

test('v2 external links open externally without changing the signed-in panel state', async () => {
  const h = harness({ knownAppIds: ['unknown-orchid'], surfaces: { manifest: async () => unknownManifest() } })
  await h.controller.open({ app: 'unknown-orchid', route_id: 'readings' })
  await h.settle()
  const guest = h.views[0].webContents
  guest.emit('did-finish-load')
  const states = [...h.sent]
  expect(h.controller.states()).toEqual([{ viewId: 'view-1', status: 'ready' }])

  const local = { preventDefault: vi.fn() }
  guest.emit('will-navigate', local, `${WEB_ORIGIN}/api/auth/otp/verify`)
  expect(local.preventDefault).not.toHaveBeenCalled()

  const navigationLinks = ['https://news.example/article', 'http://docs.example/guide', 'mailto:hello@example.com']

  for (const url of navigationLinks) {
    const event = { preventDefault: vi.fn() }
    guest.emit('will-navigate', event, url)
    expect(event.preventDefault).toHaveBeenCalled()
  }

  const popupLinks = ['https://news.example/popup', 'http://docs.example/popup']

  for (const url of popupLinks) {
    expect(guest.windowOpen!({ url })).toEqual({ action: 'deny' })
  }

  expect(h.external).toEqual([...navigationLinks, ...popupLinks])
  expect(h.sent).toEqual(states)
  expect(h.controller.states()).toEqual([{ viewId: 'view-1', status: 'ready' }])
  expect(guest.loaded).toHaveLength(1)
  expect(h.surfaces!.launch).toHaveBeenCalledTimes(1)
  h.controller.dispose()
})

test('embed relay binds nonce, main-frame origin and live guest; it cannot authenticate', async () => {
  const value = unknownManifest()
  value.manifest.embed = { profile: 'atum.panel/1', chrome: 'host' }
  const h = harness({ panelPreload: '/isolated/preload.js', knownAppIds: ['unknown-orchid'], surfaces: { manifest: async () => value } })
  const { viewId } = await h.controller.open({ app: 'unknown-orchid', route_id: 'readings' })
  await h.settle()
  const guest = h.views[0].webContents
  guest.send = vi.fn()
  const nonce = h.preferencesSeen[0].additionalArguments![0].split('=')[1]
  const ready = { profile: 'atum.panel/1', type: 'ready', nonce }
  const event = { senderFrame: { url: `${WEB_ORIGIN}/readings`, parent: null } }
  guest.emit('ipc-message', event, 'atum:panel:guest', { ...ready, nonce: 'wrong' })
  guest.emit('ipc-message', { senderFrame: { url: 'https://evil.example', parent: null } }, 'atum:panel:guest', ready)
  guest.emit('ipc-message', { senderFrame: { url: `${WEB_ORIGIN}/readings`, parent: {} } }, 'atum:panel:guest', ready)
  expect(guest.send).not.toHaveBeenCalled()
  guest.emit('ipc-message', event, 'atum:panel:guest', ready)
  expect(guest.send).toHaveBeenCalledWith('atum:panel:host', { ...ready, type: 'host-context', surface: 'panel', route_id: 'readings', chrome: 'host' })
  expect(h.surfaces!.launch).toHaveBeenCalledTimes(1)
  await h.controller.close(viewId)
  guest.emit('ipc-message', event, 'atum:panel:guest', ready)
  expect(guest.send).toHaveBeenCalledTimes(1)
  h.controller.dispose()
})

for (const profile of ['atum.app-launch/1', 'atum.app-launch/2'] as const) {
  test(`${profile} uses the main-proven plain-page path only for v1`, async () => {
    const plainPage = vi.fn(() => true)

    const h = harness({
      openRouteWithoutSession: plainPage,
      surfaces: { manifest: async () => manifest({ launch: { profile, path: '/atum/launch' } }) }
    })

    await h.controller.open({ app: 'moon', route_id: 'readings' })
    await h.settle()
    expect(h.views[0].webContents.loaded).toEqual([
      profile === 'atum.app-launch/1' ? `${WEB_ORIGIN}/readings` : launchIssue().launchUrl
    ])
    expect(h.surfaces!.launch).toHaveBeenCalledTimes(profile === 'atum.app-launch/1' ? 0 : 1)
    expect(plainPage).toHaveBeenCalledTimes(profile === 'atum.app-launch/1' ? 1 : 0)
    h.controller.dispose()
  })
}

test('a refused v2 launch never falls back to the session-less Bot API page', async () => {
  const plainPage = vi.fn(() => true)

  const h = harness({
    openRouteWithoutSession: plainPage,
    surfaces: {
      manifest: async () => manifest({ launch: { profile: 'atum.app-launch/2', path: '/atum/launch' } }),
      launch: vi.fn(async () => { throw new MessagingHttpError('not_linked', 409, false, null, null, null) })
    }
  })

  await h.controller.open({ app: 'moon', route_id: 'readings' })
  await h.settle()
  expect(h.views[0].webContents.loaded).toEqual([])
  expect(plainPage).not.toHaveBeenCalled()
  expect(h.sent).toContainEqual(expect.objectContaining({ status: 'error', error: 'not_linked' }))
  h.controller.dispose()
})

test('panel route matching uses longest whole-segment prefixes and ignores query and fragment', async () => {
  const { matchAppPanelRoute } = await import('./controller')

  const routes = [
    { id: 'library', path: '/library' },
    { id: 'saved', path: '/library/saved' }
  ]

  assert.deepEqual(matchAppPanelRoute('https://app.test/library?x=1#top', 'https://app.test', routes), {
    id: 'library',
    root: true
  })
  assert.deepEqual(matchAppPanelRoute('https://app.test/library/saved/42', 'https://app.test', routes), {
    id: 'saved',
    root: false
  })
  assert.equal(matchAppPanelRoute('https://app.test/library-other', 'https://app.test', routes), null)
  assert.equal(matchAppPanelRoute('https://other.test/library', 'https://app.test', routes), null)
})

test('committed URLs publish only route IDs and history, and Back delegates to native history', async () => {
  const h = harness()
  const { viewId } = await h.controller.open({ app: 'moon', route_id: 'readings' })
  const guest = h.views[0]!.webContents
  const goBack = vi.fn()
  guest.navigationHistory = { canGoBack: () => true, goBack }
  guest.emit('did-navigate', {}, `${WEB_ORIGIN}/readings/detail?secret=private`)
  assert.deepEqual(h.sent.at(-1), { viewId, status: 'launching', canGoBack: true, matchedRouteId: 'readings', atRouteRoot: false })
  assert.equal(JSON.stringify(h.sent).includes('private'), false)
  h.controller.back(viewId)
  expect(goBack).toHaveBeenCalledOnce()
  guest.emit('did-navigate-in-page', {}, `${WEB_ORIGIN}/pricing?filter=1`, true)
  assert.equal(h.sent.at(-1)?.matchedRouteId, 'pricing')
  assert.equal(h.sent.at(-1)?.atRouteRoot, true)
  h.controller.dispose()
})

test('Open in browser uses a declared page root and drops launch URL secrets', async () => {
  const h = harness()
  const { viewId } = await h.controller.open({ app: 'moon', route_id: 'readings' })
  h.views[0]!.webContents.getURL = () => `${WEB_ORIGIN}/atum/launch?code=private`
  await h.controller.external(viewId)
  assert.deepEqual(h.external, [`${WEB_ORIGIN}/readings`])
  h.controller.dispose()
})

test('panel keys opt in explicitly while standalone views retain provider keys', async () => {
  const h = harness()
  await h.controller.open({ app: 'moon', route_id: 'readings', panelNavigation: true })
  const prevented = vi.fn()
  h.views[0]!.webContents.emit('before-input-event', { preventDefault: prevented }, { type: 'keyDown', key: '2', meta: true })
  assert.equal(h.sent.at(-1)?.panelCommand, 1)
  expect(prevented).toHaveBeenCalledOnce()
  h.views[0]!.webContents.emit('before-input-event', { preventDefault: prevented }, { type: 'keyDown', key: 'Escape' })
  assert.equal(h.sent.at(-1)?.panelCommand, 'focus-chat')
  h.controller.dispose()
})
