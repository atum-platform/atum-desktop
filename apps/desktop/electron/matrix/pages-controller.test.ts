import { pathToFileURL } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import type { PlanAcknowledgment } from '../../shared/connection-catalog'
import { MATRIX_PAGES_IPC } from '../../shared/matrix-pages'

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (event: any, ...args: any[]) => unknown>()
  const guests: any[] = []

  class WebContentsView {
    webContents: any
    bounds: unknown
    visible = false

    constructor(readonly options: any) {
      const listeners = new Map<string, Array<(...args: any[]) => void>>()

      const guest: any = {
        destroyed: false,
        loaded: [] as string[],
        mainFrame: { url: 'file:///tmp/atum-pages/index.html' },
        session: {
          check: undefined as unknown,
          request: undefined as unknown,
          setPermissionCheckHandler: (handler: unknown) => {
            guest.session.check = handler
          },
          setPermissionRequestHandler: (handler: unknown) => {
            guest.session.request = handler
          }
        },
        isDestroyed: () => guest.destroyed,
        getURL: () => guest.mainFrame.url,
        loadURL: vi.fn(async (url: string) => {
          guest.loaded.push(url)
          await electron.onLoad?.(guest)
        }),
        close: vi.fn(() => {
          guest.destroyed = true
          guest.emit('destroyed')
        }),
        focus: vi.fn(),
        on: (event: string, listener: (...args: any[]) => void) => {
          listeners.set(event, [...(listeners.get(event) ?? []), listener])
        },
        emit: (event: string, ...args: any[]) => {
          for (const listener of [...(listeners.get(event) ?? [])]) {
            listener(...args)
          }
        },
        setWindowOpenHandler: (handler: unknown) => {
          guest.windowOpen = handler
        },
        windowOpen: undefined as unknown
      }

      this.webContents = guest
      guests.push(this)
    }

    setBounds(bounds: unknown) {
      this.bounds = bounds
    }

    setVisible(visible: boolean) {
      this.visible = visible
    }
  }

  return {
    guests,
    handlers,
    onLoad: undefined as undefined | ((guest: any) => Promise<void> | void),
    ipcMain: {
      handle: (channel: string, listener: (event: any, ...args: any[]) => unknown) => handlers.set(channel, listener),
      removeHandler: (channel: string) => handlers.delete(channel)
    },
    WebContentsView
  }
})

vi.mock('electron', () => ({
  ipcMain: electron.ipcMain,
  WebContentsView: electron.WebContentsView
}))

import type { MatrixHermesConnection } from './hermes-runtime'
import { MatrixPagesController, type Scope } from './pages-controller'
import { MatrixPagesManagementTransport } from './pages-management-transport'
import { MatrixPagesMcpScope } from './pages-mcp'
import { MatrixPagesProvidersScope } from './pages-providers'
import { MatrixHermesTurnLock } from './turn-lock'

const UI_URL = 'atum-matrix://ui/matrix.html'

const scope = (principal = '@agent:atum'): Scope => ({
  key: `account:1:${principal}`,
  context: {
    page: 'scheduled',
    agentPrincipal: principal,
    agentName: 'Hermes',
    locale: 'vi',
    appearance: 'dark',
    local: true,
    jobsRunHere: true
  }
})

function harness(
  options: {
    resolve?: (input: any) => Promise<Scope> | Scope
    current?: (scope: Scope) => boolean
    zoom?: number
    retired?: (scope: Scope) => void
    request?: (scope: Scope, request: any) => Promise<unknown>
    opened?: (input: any, result: unknown, ms: number) => void
  } = {}
) {
  electron.handlers.clear()
  electron.guests.length = 0
  electron.onLoad = undefined
  const sent: unknown[] = []
  const attached: any[] = []
  let uiDestroyed = false

  const ui = {
    mainFrame: { url: UI_URL },
    isDestroyed: () => uiDestroyed,
    getURL: () => UI_URL,
    getZoomFactor: () => options.zoom ?? 1,
    send: (_channel: string, value: unknown) => sent.push(value)
  }

  const window = {
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 1200, height: 800 }),
    contentView: {
      addChildView: (view: any) => attached.push(view),
      removeChildView: (view: any) => {
        const index = attached.indexOf(view)

        if (index >= 0) {
          attached.splice(index, 1)
        }
      }
    },
    once: vi.fn()
  }

  const controller = new MatrixPagesController({
    window: () => window as any,
    uiContents: () => ui as any,
    uiUrl: UI_URL,
    pagesFile: '/tmp/atum-pages/index.html',
    preload: '/tmp/atum-pages/preload.mjs',
    resolve: options.resolve ?? (() => scope()),
    isCurrent: options.current ?? (() => true),
    retired: options.retired,
    request: options.request ?? vi.fn(async () => ({ ok: true })),
    readMedia: vi.fn(async () => 'data:image/png;base64,AA=='),
    openExternal: vi.fn(async () => undefined),
    opened: options.opened
  })

  controller.register()
  const call = (channel: string, event: any, ...args: any[]) => electron.handlers.get(channel)!(event, ...args)

  return { attached, call, controller, sent, ui, window, setUiDestroyed: (value: boolean) => (uiDestroyed = value) }
}

describe('MatrixPagesController', () => {
  it('does not reload Hermes when a real page closes during MCP confirmation', async () => {
    const original = scope()
    let approve!: (value: boolean) => void

    const confirmation = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          approve = resolve
        })
    )

    const reload = vi.fn(async () => ({ status: 'reloaded' }))

    const connection = {
      signal: new AbortController().signal,
      pages: vi.fn(),
      gateway: { request: reload }
    } as unknown as MatrixHermesConnection

    const h = harness({
      resolve: () => original,
      retired: () => {
        transport.retire()
        mcp.stop()
      },
      request: (_scope, request) => mcp.request(request)
    })

    const transport = new MatrixPagesManagementTransport({
      isCurrent: () => h.controller.ownsScope(original),
      connection: () => connection,
      connect: vi.fn(),
      busy: () => false,
      lock: new MatrixHermesTurnLock()
    })

    const mcp = new MatrixPagesMcpScope({
      isCurrent: () => transport.current(),
      forward: request => transport.forward(request),
      confirm: confirmation,
      reload: () => transport.reload(),
      openExternal: vi.fn()
    })

    await h.controller.open({ page: 'mcp', locale: 'en', appearance: 'light' })
    const guest = electron.guests[0].webContents

    const pending = h.call(
      MATRIX_PAGES_IPC.api,
      { sender: guest, senderFrame: guest.mainFrame },
      {
        path: '/api/mcp/reload',
        method: 'POST'
      }
    )

    await vi.waitFor(() => expect(confirmation).toHaveBeenCalledOnce())
    await h.call(MATRIX_PAGES_IPC.dismiss, { sender: guest, senderFrame: guest.mainFrame })
    approve(true)
    await pending
    expect(reload).not.toHaveBeenCalled()
    expect(transport.current()).toBe(false)
  })
  it.each(['dismiss', 'clear', 'replaced', 'crash', 'destroyed'] as const)(
    'revokes a pending management operation before retiring its view on %s',
    async reason => {
      const original = scope()
      const observations: boolean[] = []

      const retired = vi.fn((value: Scope) => {
        expect(value).toBe(original)
        observations.push(h.controller.ownsScope(value))
      })

      const h = harness({ resolve: () => original, retired })
      await h.controller.open({ page: 'runtime', locale: 'en', appearance: 'light' })
      expect(h.controller.ownsScope(original)).toBe(true)
      const guest = electron.guests[0].webContents

      if (reason === 'dismiss') {
        await h.call(MATRIX_PAGES_IPC.dismiss, { sender: guest, senderFrame: guest.mainFrame })
      } else if (reason === 'replaced') {
        await h.controller.open({ page: 'skills', locale: 'en', appearance: 'light' })
      } else if (reason === 'crash') {
        guest.emit('render-process-gone')
      } else if (reason === 'destroyed') {
        guest.destroyed = true
        guest.emit('destroyed')
      } else {
        h.controller.clearAll()
      }

      expect(retired).toHaveBeenCalledOnce()
      expect(observations).toEqual([false])
      expect(guest.destroyed).toBe(true)
    }
  )
  it.each([0.9, 1.1])('converts actual shell CSS bounds at %s zoom into native DIPs before clamping', async zoom => {
    const h = harness({ zoom })
    const event = { sender: h.ui, senderFrame: h.ui.mainFrame }

    const opened = (await h.call(MATRIX_PAGES_IPC.open, event, {
      page: 'scheduled',
      locale: 'en',
      appearance: 'light'
    })) as { viewId: string }

    await h.call(MATRIX_PAGES_IPC.bounds, event, {
      viewId: opened.viewId,
      bounds: { x: 100, y: 100, width: 600, height: 500 }
    })
    await h.call(MATRIX_PAGES_IPC.visibility, event, { viewId: opened.viewId, visible: true, overlayActive: false })
    expect(electron.guests[0].bounds).toEqual({
      x: Math.round(100 * zoom),
      y: Math.round(100 * zoom),
      width: Math.round(600 * zoom),
      height: Math.round(500 * zoom)
    })
  })
  it('rejects a failed document load rather than resolving a usable view', async () => {
    const h = harness()

    electron.onLoad = async () => {
      throw new Error('fixture load failure')
    }

    await expect(
      h.call(
        MATRIX_PAGES_IPC.open,
        { sender: h.ui, senderFrame: h.ui.mainFrame },
        {
          page: 'scheduled',
          locale: 'en',
          appearance: 'light'
        }
      )
    ).resolves.toEqual({ error: 'matrix_pages_load_failed' })
    expect(electron.guests[0].webContents.destroyed).toBe(true)
    expect(h.attached).toEqual([])
  })
  // 0.19.4: an open that failed left nothing in main.log. Every open reports its result.
  it('reports every open, success or the refusal code, without changing the reply', async () => {
    const opened = vi.fn()

    const refusing = harness({
      opened,
      resolve: () => {
        throw new Error('pages_agent_cloud')
      }
    })

    const input = { page: 'connections', agentPrincipal: 'agent-cloud', locale: 'vi', appearance: 'light' }

    await expect(refusing.call(MATRIX_PAGES_IPC.open, { sender: refusing.ui, senderFrame: refusing.ui.mainFrame }, input)).resolves.toEqual({
      error: 'pages_agent_cloud'
    })
    expect(opened).toHaveBeenLastCalledWith(input, { error: 'pages_agent_cloud' }, expect.any(Number))

    const working = harness({ opened })
    const reply = await working.call(MATRIX_PAGES_IPC.open, { sender: working.ui, senderFrame: working.ui.mainFrame }, input)
    expect(reply).toEqual({ viewId: expect.any(String) })
    expect(opened).toHaveBeenLastCalledWith(input, reply, expect.any(Number))
  })

  it('uses an isolated bundled page and hides it while a shell overlay is active', async () => {
    const h = harness()

    const opened = (await h.call(
      MATRIX_PAGES_IPC.open,
      { sender: h.ui, senderFrame: h.ui.mainFrame },
      {
        page: 'scheduled',
        locale: 'vi',
        appearance: 'dark'
      }
    )) as { viewId: string }

    const view = electron.guests[0]!

    expect(opened).toEqual({ viewId: expect.any(String) })
    expect(view.options.webPreferences).toMatchObject({
      partition: expect.stringMatching(/^matrix-pages-/),
      preload: '/tmp/atum-pages/preload.mjs',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false
    })
    expect(view.webContents.loaded).toEqual([pathToFileURL('/tmp/atum-pages/index.html').href])
    expect((view.webContents.session.check as () => boolean)()).toBe(false)

    let granted = true

    ;(
      view.webContents.session.request as (
        _contents: unknown,
        permission: string,
        callback: (value: boolean) => void
      ) => void
    )(view.webContents, 'notifications', value => (granted = value))
    expect(granted).toBe(false)
    expect((view.webContents.windowOpen as () => { action: string })()).toEqual({ action: 'deny' })
    const prevented = vi.fn()
    view.webContents.emit(
      'will-frame-navigate',
      { preventDefault: prevented },
      'https://attacker.invalid/',
      false,
      false
    )
    expect(prevented).toHaveBeenCalledOnce()

    await h.call(
      MATRIX_PAGES_IPC.bounds,
      { sender: h.ui, senderFrame: h.ui.mainFrame },
      {
        viewId: opened.viewId,
        bounds: { x: 0, y: 0, width: 1200, height: 800 }
      }
    )
    await h.call(
      MATRIX_PAGES_IPC.visibility,
      { sender: h.ui, senderFrame: h.ui.mainFrame },
      {
        viewId: opened.viewId,
        visible: true,
        overlayActive: false
      }
    )
    expect(view.bounds).toEqual({ x: 0, y: 48, width: 1200, height: 752 })
    expect(h.attached).toEqual([view])

    await h.call(
      MATRIX_PAGES_IPC.visibility,
      { sender: h.ui, senderFrame: h.ui.mainFrame },
      {
        viewId: opened.viewId,
        visible: true,
        overlayActive: true
      }
    )
    expect(h.attached).toEqual([])
    expect(view.visible).toBe(false)
    expect(h.sent).toContainEqual({ viewId: opened.viewId, status: 'loading' })
    expect(h.sent).toContainEqual({ viewId: opened.viewId, status: 'ready' })
  })

  it('accepts management capabilities only from the exact owned top frame', async () => {
    const h = harness()
    await h.call(
      MATRIX_PAGES_IPC.open,
      { sender: h.ui, senderFrame: h.ui.mainFrame },
      { page: 'scheduled', locale: 'vi', appearance: 'dark' }
    )
    const guest = electron.guests[0]!.webContents

    await expect(h.call(MATRIX_PAGES_IPC.context, { sender: guest, senderFrame: guest.mainFrame })).resolves.toEqual(
      scope().context
    )
    await expect(
      h.call(MATRIX_PAGES_IPC.context, { sender: guest, senderFrame: { url: guest.mainFrame.url } })
    ).resolves.toEqual({
      error: 'matrix_pages_sender_invalid'
    })
    await expect(h.call(MATRIX_PAGES_IPC.context, { sender: h.ui, senderFrame: h.ui.mainFrame })).resolves.toEqual({
      error: 'matrix_pages_sender_invalid'
    })
    await expect(
      h.call(
        MATRIX_PAGES_IPC.open,
        { sender: guest, senderFrame: guest.mainFrame },
        { page: 'scheduled', locale: 'vi', appearance: 'dark' }
      )
    ).resolves.toEqual({
      error: 'matrix_pages_sender_invalid'
    })
    await expect(
      h.call(
        MATRIX_PAGES_IPC.open,
        { sender: h.ui, senderFrame: { url: UI_URL } },
        { page: 'scheduled', locale: 'vi', appearance: 'dark' }
      )
    ).resolves.toEqual({ error: 'matrix_pages_sender_invalid' })

    await expect(
      h.call(MATRIX_PAGES_IPC.dismiss, { sender: guest, senderFrame: guest.mainFrame })
    ).resolves.toBeUndefined()
    expect(guest.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
  })

  it('accepts page context from the pinned main frame while its initial bundled load is still in flight', async () => {
    const h = harness()
    let context: unknown

    electron.onLoad = async guest => {
      context = await h.call(MATRIX_PAGES_IPC.context, { sender: guest, senderFrame: guest.mainFrame })
    }

    await h.call(
      MATRIX_PAGES_IPC.open,
      { sender: h.ui, senderFrame: h.ui.mainFrame },
      {
        page: 'scheduled',
        locale: 'vi',
        appearance: 'dark'
      }
    )
    expect(context).toEqual(scope().context)
  })

  it('invalidates an older pending open and rechecks scope after privileged awaits', async () => {
    let releaseFirst: ((value: Scope) => void) | undefined
    const first = new Promise<Scope>(resolve => (releaseFirst = resolve))
    let requestRelease: ((value: unknown) => void) | undefined
    const pendingRequest = new Promise<unknown>(resolve => (requestRelease = resolve))
    const request = vi.fn(() => pendingRequest)

    const h = harness({
      resolve: input => (input.agentPrincipal === '@old:atum' ? first : scope('@new:atum'))
    })

    ;(h.controller as any).deps.request = request

    const older = h.controller.open({
      page: 'scheduled',
      agentPrincipal: '@old:atum',
      locale: 'vi',
      appearance: 'dark'
    })

    const newer = h.controller.open({
      page: 'scheduled',
      agentPrincipal: '@new:atum',
      locale: 'vi',
      appearance: 'dark'
    })

    await expect(newer).resolves.toEqual({ viewId: expect.any(String) })
    releaseFirst!(scope('@old:atum'))
    await expect(older).rejects.toThrow('matrix_pages_unavailable')
    expect(electron.guests).toHaveLength(1)

    const guest = electron.guests[0]!.webContents
    const api = h.call(MATRIX_PAGES_IPC.api, { sender: guest, senderFrame: guest.mainFrame }, { path: '/api/cron' })
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    h.controller.clearAgent('@new:atum')
    requestRelease!({ ok: true })
    await expect(api).resolves.toEqual({ error: 'matrix_pages_unavailable' })
  })

  it('removes every IPC handler on disposal and rejects controls from other chat contents', async () => {
    const h = harness()
    await expect(
      h.call(MATRIX_PAGES_IPC.open, { sender: {} }, { page: 'scheduled', locale: 'vi', appearance: 'dark' })
    ).resolves.toEqual({ error: 'matrix_pages_sender_invalid' })
    h.controller.dispose()
    expect(electron.handlers.size).toBe(0)
  })
})

it('native Connections navigation pins the same agent and retires old scope requests before Advanced', async () => {
  let release!: (value: unknown) => void

  const pendingResponse = new Promise(resolve => {
    release = resolve
  })

  const resolved: Scope[] = []
  const retired = vi.fn()

  const resolve = vi.fn((input: any) => {
    const next = { ...scope(input.agentPrincipal ?? '@agent:atum'), context: { ...scope().context, ...input } }
    resolved.push(next)

    return next
  })

  const h = harness({ resolve, retired, request: () => pendingResponse })
  await h.controller.open({ page: 'connections', agentPrincipal: '@agent:atum', locale: 'vi', appearance: 'dark' })
  const guest = electron.guests[0]!.webContents
  const event = { sender: guest, senderFrame: guest.mainFrame }
  const pending = h.call(MATRIX_PAGES_IPC.api, event, { path: '/api/provider-settings/snapshot' })
  await Promise.resolve()
  const context = await h.call(MATRIX_PAGES_IPC.navigateConnections, event, 'providers')
  expect(context).toMatchObject({ page: 'providers', agentPrincipal: '@agent:atum', locale: 'vi', appearance: 'dark' })
  expect(retired).toHaveBeenCalledWith(resolved[0])
  expect(h.controller.ownsScope(resolved[0]!)).toBe(false)
  expect(h.controller.ownsScope(resolved[1]!)).toBe(true)
  expect(guest.loaded).toHaveLength(1)
  release({ native_old_scope: true })
  await expect(pending).resolves.toEqual({ error: 'matrix_pages_unavailable' })
  await expect(h.call(MATRIX_PAGES_IPC.navigateConnections, event, 'connections')).resolves.toMatchObject({
    page: 'connections'
  })
  await expect(h.call(MATRIX_PAGES_IPC.navigateConnections, event, 'runtime')).resolves.toEqual({
    error: 'matrix_pages_request_forbidden'
  })
  await expect(
    h.call(MATRIX_PAGES_IPC.navigateConnections, { sender: h.ui, senderFrame: h.ui.mainFrame }, 'providers')
  ).resolves.toEqual({ error: 'matrix_pages_sender_invalid' })
  h.controller.dispose()
})

it('native Advanced resolution cannot revive a closed or switched account scope', async () => {
  let release!: (value: Scope) => void

  const next = new Promise<Scope>(resolve => {
    release = resolve
  })

  const initial = { ...scope(), context: { ...scope().context, page: 'connections' as const } }
  const retired = vi.fn()
  const h = harness({ retired, resolve: vi.fn().mockReturnValueOnce(initial).mockReturnValueOnce(next) })
  await h.controller.open({ page: 'connections', locale: 'vi', appearance: 'dark' })
  const guest = electron.guests[0]!.webContents

  const pending = h.call(
    MATRIX_PAGES_IPC.navigateConnections,
    { sender: guest, senderFrame: guest.mainFrame },
    'providers'
  )

  await Promise.resolve()
  expect(h.controller.ownsScope(initial)).toBe(false)
  h.controller.clearAll()
  release({ ...scope(), context: { ...scope().context, page: 'providers' } })
  await expect(pending).resolves.toEqual({ error: 'matrix_pages_unavailable' })
  expect(guest.close).toHaveBeenCalled()
  expect(h.controller.state()).toBeUndefined()
  h.controller.dispose()
})

function providerNavigationHarness(acknowledged: boolean, confirm = vi.fn(async () => true)) {
  let acknowledgment: PlanAcknowledgment | undefined = acknowledged
    ? { provider: 'openai-codex', policyVersion: '2026-10-27', acknowledgedAt: '2026-10-27' }
    : undefined

  const adapters = new WeakMap<Scope, MatrixPagesProvidersScope>()
  const scopes: Scope[] = []

  const forward = vi.fn(async ({ path }: { path: string }) => {
    const route = path.split('?')[0]

    if (route === '/api/model/options') {return { providers: [] }}

    if (route === '/api/providers/oauth')
      {return { providers: [{ id: 'openai-codex', name: 'Codex', flow: 'device_code', status: { logged_in: false } }] }}

    if (route === '/api/env') {return {}}

    if (route === '/api/providers/custom-endpoints') {return { endpoints: [] }}

    if (route === '/api/model/info') {return {}}

    if (route === '/api/providers/oauth/openai-codex/start')
      {return {
        session_id: 'native-session',
        flow: 'device_code',
        verification_url: 'https://auth.openai.com/codex/device',
        user_code: 'FIXTURE-CODE'
      }}

    throw new Error('Unexpected fixture route')
  })

  // Compose the real controller/adapter at the same object-keyed scope seam as
  // main.ts. Resolving navigation creates a fresh object even when its key is equal.
  const h = harness({
    resolve: input => {
      const next: Scope = { ...scope(), context: { ...scope().context, ...input } }
      scopes.push(next)

      return next
    },
    retired: nativeScope => {
      void adapters.get(nativeScope)?.stop()
    },
    request: (nativeScope, request) => {
      let adapter = adapters.get(nativeScope)

      if (!adapter) {
        adapter = new MatrixPagesProvidersScope({
          surface: nativeScope.context.page === 'providers' ? 'advanced' : 'connections',
          isCurrent: () => h.controller.ownsScope(nativeScope),
          readPlanAcknowledgment: () => acknowledgment,
          savePlanAcknowledgment: value => {
            acknowledgment = value
          },
          today: () => '2026-10-27',
          forward,
          confirm,
          openExternal: vi.fn(),
          cancelOAuth: vi.fn(async () => undefined)
        })
        adapters.set(nativeScope, adapter)
      }

      return adapter.request(request)
    }
  })

  const api = (action: string) => {
    const guest = electron.guests[0]!.webContents

    return h.call(
      MATRIX_PAGES_IPC.api,
      { sender: guest, senderFrame: guest.mainFrame },
      {
        path: `/api/provider-settings/${action}`,
        method: 'POST',
        body: { provider: 'openai-codex' }
      }
    )
  }

  const navigate = (page: 'connections' | 'providers') => {
    const guest = electron.guests[0]!.webContents

    return h.call(MATRIX_PAGES_IPC.navigateConnections, { sender: guest, senderFrame: guest.mainFrame }, page)
  }

  return { ...h, api, navigate, forward, confirm, scopes, adapters, acknowledgment: () => acknowledgment }
}

it.each([false, true])(
  'round-trip native navigation pins the actual surface and never carries confirmation (stored consent:%s)',
  async acknowledged => {
    const h = providerNavigationHarness(acknowledged)
    await h.controller.open({ page: 'providers', locale: 'vi', appearance: 'dark' })
    await expect(h.api('oauth/start')).resolves.toEqual({ error: 'provider_terms_blocked' })
    expect(h.forward).not.toHaveBeenCalled()
    await h.navigate('connections')

    if (!acknowledged) {
      await expect(h.api('oauth/start')).resolves.toEqual({ error: 'provider_terms_blocked' })
      expect(h.forward).not.toHaveBeenCalled()
    }

    await expect(h.api('oauth/acknowledge')).resolves.toEqual({ status: 'applied' })
    expect(h.confirm).toHaveBeenCalledOnce()
    await h.navigate('providers')
    await expect(h.api('oauth/start')).resolves.toEqual({ error: 'provider_terms_blocked' })
    expect(h.forward).not.toHaveBeenCalled()
    await h.navigate('connections')
    await expect(h.api('oauth/start')).resolves.toMatchObject({ status: 'pending', provider: 'openai-codex' })
    expect(h.confirm).toHaveBeenCalledTimes(2)
    expect(h.adapters.get(h.scopes[1]!)).not.toBe(h.adapters.get(h.scopes[3]!))
    expect(h.scopes[1]!.key).toBe(h.scopes[3]!.key)
    h.controller.dispose()
  }
)

it('navigation retires a pending native consent while its writer is still busy', async () => {
  let approve!: (value: boolean) => void

  const h = providerNavigationHarness(
    false,
    vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          approve = resolve
        })
    )
  )

  await h.controller.open({ page: 'connections', locale: 'vi', appearance: 'dark' })
  const pending = h.api('oauth/acknowledge')
  await Promise.resolve()
  await expect(h.api('oauth/acknowledge')).resolves.toEqual({ error: 'pages_agent_busy' })
  await h.navigate('providers')
  approve(true)
  await expect(pending).resolves.toEqual({ error: 'matrix_pages_agent_unavailable' })
  expect(h.acknowledgment()).toBeUndefined()
  expect(h.forward).not.toHaveBeenCalled()
  await expect(h.api('oauth/start')).resolves.toEqual({ error: 'provider_terms_blocked' })
  h.controller.dispose()
})
