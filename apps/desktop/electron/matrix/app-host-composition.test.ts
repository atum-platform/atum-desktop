import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppDescriptor } from '../../shared/app-catalog'
import { createAppViewController, type GuestContentsLike, type SessionLike } from '../app-view/controller'

import { MatrixAccount } from './account'
import { createMatrixApps } from './app-workspace'

const initiationId = '00000000-0000-4000-8000-232a373eb43a'
const returnCode = 'c'.repeat(43)
const ticket = 't'.repeat(43)
const attempt = 'a'.repeat(43)
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(done => {
    resolve = done
  })

  return { promise, resolve }
}

/** Actual fixed-route HTTP, native callback and view/egress composition. Only
 * account admission and Electron's OS objects are fixtures; no provider runs. */
async function fixture(slug = 'river', launchProfile = 'atum.app-launch/1', botApiRoom = false) {
  let scope = { accountKey: 'a'.repeat(64), generation: 1 }
  let link: AppDescriptor['link']['state'] = 'never_linked'
  let readiness = 'not_linked'
  let available = true
  let consent = 'accepted'
  let disclosure = 1
  let version = '00000000-0000-4000-8000-dd7df1164681'
  let failure: string | undefined
  let held: { action: string; response: ReturnType<typeof deferred<void>> } | undefined
  let redirectUri = ''
  const requests: Array<{ method?: string; action: string; body: Record<string, unknown>; generation: number; launchProfile?: string }> = []
  const opened: string[] = []
  const restored: string[][] = []
  const withdrawn = vi.fn(async (_slug: string) => {})
  const stopped = vi.fn(async (_slug?: string) => {})

  const descriptor = (): AppDescriptor => ({
    app: slug,
    app_id: '00000000-0000-4000-8000-11e594f48195',
    app_version_id: version,
    name: { en: slug, vi: slug },
    subtitle: null,
    description: null,
    icon: null,
    accent: null,
    affiliation: 'partner',
    verified: true,
    availability: available ? 'available' : 'unavailable',
    roster_default: true,
    roster_order: 0,
    supported_modes: [],
    matrix_room_context: 'addressed_only',
    has_surface: true,
    link: { mode: 'external_account', state: link }
  })

  const workspace = () => {
    const app = descriptor()

    return {
      profile: 'atum.app-workspace/1',
      descriptor: app,
      web_origin: `https://${slug}.provider.test`,
      network_origins: [],
      manifest: {
        profile: 'atum.remote-app-manifest/1',
        manifest_version: '1.0.0',
        app: {
          id: app.app_id,
          slug,
          app_version_id: app.app_version_id,
          name: app.name,
          verified: app.verified,
          availability: app.availability
        },
        link: app.link,
        launch: { profile: launchProfile, path: '/atum/launch' },
        routes: [
          {
            id: 'library',
            label: { en: 'Library', vi: 'Thư viện' },
            icon: 'books',
            path: '/library',
            placements: ['menu'],
            session: 'required'
          },
          {
            id: 'prepare',
            label: { en: 'Prepare', vi: 'Chuẩn bị' },
            icon: 'edit',
            path: '/prepare',
            placements: ['composer'],
            session: 'none'
          }
        ]
      }
    }
  }

  const authority = createServer(async (request, response) => {
    const action = request.url!.split('/').at(-1)!
    let bytes = ''

    for await (const chunk of request) {
      bytes += chunk
    }

    const body = bytes ? JSON.parse(bytes) : {}
    requests.push({ method: request.method, action, body, generation: scope.generation, launchProfile: request.headers['atum-app-launch-profile'] as string | undefined })
    response.setHeader('Content-Type', 'application/json')
    const connection = { state: link, connectionRequired: true, available, readiness }
    let result: unknown

    if (action === 'apps') {
      result = { profile: 'atum.app-catalog/1', apps: [descriptor()] }
    } else if (failure === action) {
      response.writeHead(503).end(JSON.stringify({ error: 'fixture authority offline' }))

      return
    } else if (action === 'connection') {
      result = { connection }
    } else if (action === 'bot') {
      result = {
        profile: 'atum.app-bot-status/1',
        consent: { state: consent, disclosure_version: disclosure },
        link: { state: link, ready: readiness === 'ready', available }
      }
    } else if (action === 'connect') {
      redirectUri = body.redirect_uri
      result = { authorize_url: `${origin}/link/start?t=${ticket}&a=${attempt}`, initiation_id: initiationId }
    } else if (action === 'confirm') {
      if (body.initiation_id !== initiationId || body.return_code !== returnCode || body.confirmation !== true) {
        response.writeHead(400).end('{}')

        return
      }

      link = 'linked'
      readiness = 'pending'
      result = { status: 'confirmed' }
    } else if (action === 'disconnect') {
      link = 'unlinked'
      readiness = 'not_linked'
      result = { status: 'unlinked' }
    } else if (action === 'manifest') {
      result = workspace()
    } else if (action === 'launch') {
      if (link !== 'linked' || readiness !== 'ready' || !available) {
        response.writeHead(409).end(JSON.stringify({ details: { launch_error: 'not_linked' } }))

        return
      }

      result = {
        launch_url: `https://${slug}.provider.test/atum/launch?code=${'l'.repeat(43)}`,
        expires_at: new Date(Date.now() + 60_000).toISOString()
      }
    } else {
      response.writeHead(404).end('{}')

      return
    }

    if (held?.action === action) {
      await held.response.promise
    }

    response.end(JSON.stringify(result))
  })

  await new Promise<void>(resolve => authority.listen(0, '127.0.0.1', resolve))
  const address = authority.address()

  if (!address || typeof address === 'string') {
    throw new Error('fixture listener unavailable')
  }

  const origin = `http://127.0.0.1:${address.port}`
  const resource = `${origin}/api/matrix/v1`

  // Reuse MatrixAccount.appRequest itself, including no mutation replay and
  // generation/session checks. MAS admission/vault are intentionally outside
  // this disposable host test; the domain grant here is synthetic.
  const account: MatrixAccount = Object.assign(Object.create(MatrixAccount.prototype), {
    config: { domain: { resource } },
    generation: scope.generation,
    readDomain: async () => undefined,
    appScope: () => scope,
    domainOwner: () => ({
      domain: { accessToken: 'synthetic-domain-fixture', sessionId: `fixture-${scope.generation}` }
    })
  })

  const guests: Array<GuestContentsLike & { loaded: string[] }> = []
  const sessions = new Map<string, SessionLike>()
  const publications: unknown[] = []
  let apps!: ReturnType<typeof createMatrixApps>

  const views = createAppViewController({
    account: () => apps.account(),
    knownAppIds: () => apps.knownAppIds(),
    surfaces: () => apps.surfaces,
    openRouteWithoutSession: () => botApiRoom,
    userDataPath: '/disposable-app-host-fixture',
    readDirectory: async () => null,
    openExternal: async url => {
      opened.push(url)
    },
    ipcMain: { handle: () => {}, removeHandler: () => {} },
    hostWindow: () => ({
      isDestroyed: () => false,
      getContentBounds: () => ({ width: 1200, height: 800 }),
      contentView: { addChildView: () => {}, removeChildView: () => {} },
      webContents: { id: 1, send: (_channel, value) => publications.push(value) },
      once: () => {}
    }),
    createView: preferences => {
      const events = new EventEmitter()
      let destroyed = false

      const guest = {
        id: guests.length + 100,
        loaded: [] as string[],
        isDestroyed: () => destroyed,
        loadURL: async (url: string) => {
          guest.loaded.push(url)
          events.emit('did-finish-load')
        },
        close: () => {
          destroyed = true
          events.emit('destroyed')
        },
        focus: () => {},
        setWebRTCIPHandlingPolicy: () => {},
        on: events.on.bind(events),
        once: events.once.bind(events),
        setWindowOpenHandler: () => {}
      }

      expect(preferences).toMatchObject({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false
      })
      guests.push(guest)

      return { webContents: guest, setBounds: () => {}, setVisible: () => {} }
    },
    sessionFromPartition: partition => {
      if (!sessions.has(partition)) {
        let proxy = ''
        sessions.set(partition, {
          setProxy: async options => {
            proxy = `PROXY ${new URL(options.proxyRules).host}`
          },
          resolveProxy: async () => proxy,
          closeAllConnections: vi.fn(async () => {}),
          clearStorageData: vi.fn(async () => {}),
          clearCache: vi.fn(async () => {}),
          webRequest: { onBeforeRequest: vi.fn(), onHeadersReceived: vi.fn() },
          setPermissionCheckHandler: vi.fn(),
          setPermissionRequestHandler: vi.fn(),
          on: () => {}
        })
      }

      return sessions.get(partition)!
    }
  })

  apps = createMatrixApps({
    account,
    views: () => views,
    resource,
    openExternal: async url => {
      opened.push(url)
    },
    changed: () => publications.push(apps.snapshot()),
    catalogChanged: async () => {},
    // As main wires it: the fixed bot-status route through MatrixAccount itself.
    botStatus: appSlug => account.appBotRequest(appSlug, 'read'),
    stopParticipants: stopped,
    withdrawParticipant: withdrawn,
    reconcileParticipants: async (catalog, active) => {
      if (active()) {
        restored.push(catalog.filter(app => app.link.state === 'linked').map(app => app.app))
      }
    }
  })
  cleanups.push(async () => {
    held?.response.resolve()
    await apps.reset()
    views.dispose()
    authority.closeAllConnections()
    await new Promise<void>((resolve, reject) => authority.close(error => (error ? reject(error) : resolve())))
  })

  return {
    apps,
    views,
    account,
    guests,
    sessions,
    opened,
    requests,
    publications,
    restored,
    withdrawn,
    stopped,
    descriptor,
    getScope: () => scope,
    callback: (code = returnCode, id = initiationId) => fetch(`${redirectUri}?code=${code}&initiation_id=${id}`),
    setFailure: (action?: string) => {
      failure = action
    },
    acknowledge: () => {
      readiness = 'ready'
    },
    unavailable: () => {
      available = false
    },
    revokeConsent: () => {
      consent = 'revoked'
    },
    newerDisclosure: () => {
      disclosure = 2
    },
    changeVersion: () => {
      version = '00000000-0000-4000-8000-8cca3400b26b'
    },
    switchAccount: () => {
      scope = { accountKey: 'b'.repeat(64), generation: scope.generation + 1 }
      Object.assign(account, { generation: scope.generation })
    },
    hold: (action: string) => {
      held = { action, response: deferred<void>() }

      return held.response
    }
  }
}

async function consent(f: Awaited<ReturnType<typeof fixture>>) {
  const appId = f.descriptor().app_id
  await f.apps.connection(appId, 'begin')
  expect((await f.callback()).status).toBe(200)
  await f.apps.connection(appId, 'confirm')
  f.acknowledge()
  await f.apps.connection(appId, 'read')
}

describe('generic native app host seam', () => {
  it.each(['atum.app-launch/1', 'atum.app-launch/2'])(
    'negotiates v2 over real HTTP and preserves the Bot API panel path for %s',
    async profile => {
      const f = await fixture('unknown-orchid', profile, true)
      await f.apps.refresh()
      if (profile === 'atum.app-launch/2') {
        await consent(f)
      }
      const opened = await f.views.open({ app: 'unknown-orchid', route_id: 'library' })
      await vi.waitFor(() => expect(f.guests[0].loaded).toHaveLength(1))
      const reads = f.requests.filter(request => request.action === 'manifest')
      expect(reads.length).toBeGreaterThan(0)
      expect(reads.every(request => request.launchProfile === 'atum.app-launch/2')).toBe(true)
      expect(f.requests.filter(request => !['manifest', 'launch'].includes(request.action))
        .every(request => request.launchProfile === undefined)).toBe(true)
      const launches = f.requests.filter(request => request.action === 'launch')
      if (profile === 'atum.app-launch/2') {
        expect(launches).toHaveLength(1)
        expect(launches[0]).toMatchObject({ launchProfile: 'atum.app-launch/2', body: {
          app_version_id: f.descriptor().app_version_id, route_id: 'library'
        } })
        expect(f.guests[0].loaded[0]).toContain('/atum/launch?code=')
      } else {
        expect(launches).toHaveLength(0)
        expect(f.guests[0].loaded[0]).toBe('https://unknown-orchid.provider.test/library')
      }
      expect(f.views.states()).toContainEqual(expect.objectContaining({ viewId: opened.viewId, status: 'ready' }))
    }
  )

  it.each(['river', 'moon', 'andy'])(
    'connects, confirms, launches and withdraws %s using declarations only',
    async slug => {
      const f = await fixture(slug)
      const appId = f.descriptor().app_id
      await f.apps.refresh()
      expect(f.apps.snapshot().apps[0]).toMatchObject({ app: slug, roster_default: true, affiliation: 'partner' })
      expect(f.requests.map(request => request.action)).toEqual(['apps'])
      const menu = await f.apps.menu(appId)
      expect(menu.routes).toEqual([
        { id: 'library', label: { en: 'Library', vi: 'Thư viện' }, icon: 'books', session: 'required' }
      ])
      expect(JSON.stringify(menu)).not.toContain('provider.test')

      await f.apps.connection(appId, 'begin')
      expect(f.apps.snapshot().connections[slug].phase).toBe('waiting')
      expect((await f.callback(returnCode, '00000000-0000-4000-8000-db8055e0e030')).status).toBe(400)
      const returned = await f.callback()
      expect(returned.status).toBe(200)
      expect(returned.headers.get('cache-control')).toBe('no-store')
      expect(returned.headers.get('referrer-policy')).toBe('no-referrer')
      expect(await returned.text()).not.toContain(returnCode)
      expect(f.requests.some(request => request.action === 'confirm')).toBe(false)
      expect(() => f.apps.participant(appId)).toThrow('matrix_app_unavailable')

      await f.apps.connection(appId, 'confirm')
      expect(f.apps.snapshot().connections[slug]).toMatchObject({
        phase: 'idle',
        connection: { state: 'linked', readiness: 'pending' }
      })
      f.acknowledge()
      await f.apps.connection(appId, 'read')
      expect(f.apps.participant(appId).app).toBe(slug)
      const opened = await f.views.open({ app: slug, route_id: 'library' })
      await vi.waitFor(() => expect(f.guests[0].loaded).toHaveLength(1))
      expect(f.guests[0].loaded[0]).toBe(`https://${slug}.provider.test/atum/launch?code=${'l'.repeat(43)}`)
      expect(f.requests.filter(request => request.action === 'launch')).toMatchObject([
        { method: 'POST', body: { app_version_id: f.descriptor().app_version_id, route_id: 'library' } }
      ])
      expect(f.views.states()).toContainEqual(expect.objectContaining({ viewId: opened.viewId, status: 'ready' }))
      const projection = JSON.stringify(f.publications)

      for (const secret of [
        returnCode,
        ticket,
        attempt,
        initiationId,
        'l'.repeat(43),
        'synthetic-domain-fixture',
        '/atum/app-link/'
      ]) {
        expect(projection).not.toContain(secret)
      }

      await f.apps.connection(appId, 'disconnect')
      expect(f.guests[0].isDestroyed()).toBe(true)
      expect(f.views.states()).toEqual([])
      const session = [...f.sessions.values()][0]
      expect(session.clearStorageData).toHaveBeenCalled()
      expect(session.clearCache).toHaveBeenCalled()
      const filter = vi.mocked(session.webRequest.onBeforeRequest).mock.calls.at(-1)![1]
      filter({ url: `https://${slug}.provider.test/library`, resourceType: 'mainFrame' }, result => {
        expect(result.cancel).toBe(true)
      })
      expect(f.withdrawn).toHaveBeenCalledWith(slug)
      expect(f.apps.snapshot().connections[slug]).toMatchObject({ connection: { state: 'unlinked' } })
      expect(() => f.apps.participant(appId)).toThrow('matrix_app_unavailable')
      expect(f.requests.filter(request => request.action === 'disconnect')).toHaveLength(1)
      await consent(f)
      expect(f.apps.participant(appId).app).toBe(slug)
      await expect(f.views.open({ app: slug, route_id: 'library' })).resolves.toHaveProperty('viewId')
    }
  )

  it('keeps local withdrawal closed through remote failure and stale Ready until a new confirmation is acknowledged', async () => {
    const f = await fixture()
    const appId = f.descriptor().app_id
    await f.apps.refresh()
    await consent(f)
    await f.views.open({ app: 'river', route_id: 'library' })
    await vi.waitFor(() => expect(f.guests[0].loaded).toHaveLength(1))
    f.setFailure('disconnect')
    await f.apps.connection(appId, 'disconnect')
    expect(f.guests[0].isDestroyed()).toBe(true)
    expect(f.apps.snapshot().connections.river).toMatchObject({ phase: 'failed', error: 'unavailable' })
    await f.apps.connection(appId, 'read')
    await f.apps.refresh()
    expect(f.restored.at(-1)).toEqual([])
    expect(() => f.apps.participant(appId)).toThrow('matrix_app_unavailable')
    await expect(f.views.open({ app: 'river', route_id: 'library' })).rejects.toMatchObject({ code: 'unlinked' })
    expect(f.requests.filter(request => request.action === 'disconnect')).toHaveLength(1)

    f.setFailure()
    await f.apps.connection(appId, 'begin')
    expect((await f.callback()).status).toBe(200)
    await f.apps.connection(appId, 'confirm')
    expect(() => f.apps.participant(appId)).toThrow('matrix_app_unavailable')
    f.acknowledge()
    await f.apps.connection(appId, 'read')
    expect(f.apps.participant(appId).app).toBe('river')
  })

  it('rejects account-late launch bytes and clears the outgoing view/partition without replay', async () => {
    const f = await fixture()
    await f.apps.refresh()
    await consent(f)
    const pending = f.hold('launch')
    await f.views.open({ app: 'river', route_id: 'library' })
    await vi.waitFor(() => expect(f.requests.filter(request => request.action === 'launch')).toHaveLength(1))
    f.switchAccount()
    pending.resolve()
    await vi.waitFor(() => expect(f.apps.account()).toBeNull())
    await vi.waitFor(() => expect(f.guests[0].isDestroyed()).toBe(true))
    expect(f.guests[0].loaded).toEqual([])
    expect(f.requests.filter(request => request.action === 'launch')).toHaveLength(1)
    await f.apps.refresh()
    expect(f.apps.account()).toEqual(f.getScope())
  })

  it('rejects an outgoing account callback before it can confirm for the incoming account', async () => {
    const f = await fixture()
    const appId = f.descriptor().app_id
    await f.apps.refresh()
    await f.apps.connection(appId, 'begin')
    f.switchAccount()
    expect((await f.callback()).status).toBe(400)
    await f.apps.refresh()
    await f.apps.connection(appId, 'confirm')
    expect(f.requests.some(request => request.action === 'confirm')).toBe(false)
    expect(f.apps.account()).toEqual(f.getScope())
  })

  it('does not redeem a late launch after local disconnect even when the authority is offline', async () => {
    const f = await fixture()
    await f.apps.refresh()
    await consent(f)
    const pending = f.hold('launch')
    await f.views.open({ app: 'river', route_id: 'library' })
    await vi.waitFor(() => expect(f.requests.filter(request => request.action === 'launch')).toHaveLength(1))
    f.setFailure('disconnect')
    await f.apps.connection(f.descriptor().app_id, 'disconnect')
    pending.resolve()
    await vi.waitFor(() => expect(f.guests[0].isDestroyed()).toBe(true))
    expect(f.guests[0].loaded).toEqual([])
    expect(f.requests.filter(request => request.action === 'launch')).toHaveLength(1)
  })

  // 2026-10-10: the setup card's flow confirms on the gated browser return, with no tap. The
  // workspace must settle it exactly as it settles a tapped confirm.
  it('confirms a setup-card flow on the return alone and settles it like a tapped confirm', async () => {
    const f = await fixture('moon')
    const appId = f.descriptor().app_id
    await f.apps.refresh()

    const autoConsent = async () => {
      const catalogs = f.requests.filter(request => request.action === 'apps').length
      await f.apps.connection(appId, 'begin', { autoConfirm: true })
      const returned = await f.callback()
      expect(returned.status).toBe(200)
      expect(await returned.text()).not.toContain(returnCode)
      await vi.waitFor(() =>
        expect(f.apps.snapshot().connections.moon).toMatchObject({
          phase: 'idle',
          connection: { state: 'linked', readiness: 'pending' }
        })
      )
      // The settle a tapped confirm runs: the roster's descriptor is refreshed.
      await vi.waitFor(() =>
        expect(f.requests.filter(request => request.action === 'apps').length).toBeGreaterThan(catalogs)
      )
      await vi.waitFor(() => expect(f.apps.snapshot().state).toBe('ready'))
    }

    await autoConsent()
    expect(f.requests.filter(request => request.action === 'confirm')).toEqual([
      expect.objectContaining({
        body: {
          initiation_id: initiationId,
          return_code: returnCode,
          confirmation: true,
          consent_provenance: {
            chat: { state: 'accepted', disclosure_version: 1 },
            exact_pair: { state: 'accepted', source: 'provider_page' }
          }
        }
      })
    ])
    f.acknowledge()
    await f.apps.connection(appId, 'read')
    expect(f.apps.participant(appId).app).toBe('moon')

    // After a withdrawal, only a fresh confirmed link that is ready releases it.
    await f.apps.connection(appId, 'disconnect')
    expect(() => f.apps.participant(appId)).toThrow('matrix_app_unavailable')
    await autoConsent()
    expect(() => f.apps.participant(appId)).toThrow('matrix_app_unavailable')
    f.acknowledge()
    await f.apps.connection(appId, 'read')
    expect(f.apps.participant(appId).app).toBe('moon')
    expect(f.requests.filter(request => request.action === 'confirm')).toHaveLength(2)
    expect(JSON.stringify(f.publications)).not.toMatch(new RegExp(`${returnCode}|${initiationId}|/atum/app-link/`))
  })

  it('confirms nothing for the incoming account when the outgoing account’s flow returns', async () => {
    const f = await fixture('moon')
    const appId = f.descriptor().app_id
    await f.apps.refresh()
    await f.apps.connection(appId, 'begin', { autoConfirm: true })
    f.switchAccount()
    expect((await f.callback()).status).toBe(400)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.requests.some(request => request.action === 'confirm')).toBe(false)
  })

  // Consult §10(g): main reads consent itself at the return; the renderer's autoConfirm at begin
  // is not enough. A revoke on another device, or a disclosure this Atum cannot show, during
  // the wait sends nothing.
  it.each([
    ['consent was withdrawn elsewhere', (f: Awaited<ReturnType<typeof fixture>>) => f.revokeConsent()],
    ['the disclosure moved on', (f: Awaited<ReturnType<typeof fixture>>) => f.newerDisclosure()]
  ])('confirms nothing on the return when %s during the wait', async (_label, change) => {
    const f = await fixture('moon')
    const appId = f.descriptor().app_id
    await f.apps.refresh()
    await f.apps.connection(appId, 'begin', { autoConfirm: true })
    change(f)
    expect((await f.callback()).status).toBe(200)
    await vi.waitFor(() => expect(f.apps.snapshot().connections.moon).toMatchObject({ phase: 'failed' }))
    expect(f.requests.some(request => request.action === 'bot')).toBe(true)
    expect(f.requests.some(request => request.action === 'confirm')).toBe(false)
  })

  // What withdrawing consent in Settings does first (main.ts appBotRevoke): cancel the flow.
  it('leaves a late return nothing to confirm once the open flow is cancelled', async () => {
    const f = await fixture('moon')
    const appId = f.descriptor().app_id
    await f.apps.refresh()
    await f.apps.connection(appId, 'begin', { autoConfirm: true })
    await f.apps.connection(appId, 'cancel')
    await expect(f.callback()).rejects.toThrow()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.requests.some(request => request.action === 'confirm')).toBe(false)
    expect(f.apps.snapshot().connections.moon).toMatchObject({ phase: 'idle', connection: { state: 'never_linked' } })
  })

  it.each(['version', 'unavailable'])('cancels a native callback when the app becomes %s', async change => {
    const f = await fixture()
    const appId = f.descriptor().app_id
    await f.apps.refresh()
    await f.apps.connection(appId, 'begin')
    change === 'version' ? f.changeVersion() : f.unavailable()
    await f.apps.refresh()
    await expect(f.callback()).rejects.toThrow()

    if (change === 'version') {
      await f.apps.connection(appId, 'confirm')
    } else {
      await expect(f.apps.connection(appId, 'confirm')).rejects.toMatchObject({ code: 'app_unavailable' })
    }

    expect(f.requests.some(request => request.action === 'confirm')).toBe(false)
  })
})
