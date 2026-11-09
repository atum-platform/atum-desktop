import { describe, expect, it, vi } from 'vitest'

import type { MatrixGoogleServices } from '../../shared/matrix-google-tools'

import type { MatrixAgentContentHelper } from './agent-content/helper'
import { syncMatrixAgentMemory } from './agent-content/memory'
import { createMatrixGoogleConnectionIpcHandler } from './google-connection-boundary'
import { MacSourcesConsentStore } from './mac-sources/consent'
import { MatrixGoogleAssistant, type MatrixGoogleAssistantDeps } from './main-google'

const ALL: MatrixGoogleServices = { gmail: true, send: true, calendar: true, drive: true }
const NONE: MatrixGoogleServices = { gmail: false, send: false, calendar: false, drive: false }

function memoryStore() {
  const items = new Map<string, string>()

  return {
    items,
    getItem: vi.fn((key: string) => items.get(key) ?? null),
    setItems: vi.fn((entries: Record<string, string>) => {
      for (const [key, value] of Object.entries(entries)) {
        items.set(key, value)
      }
    }),
    failureCode: vi.fn(() => null as string | null)
  }
}

function setup(
  overrides: Partial<{
    served: boolean | null
    services: MatrixGoogleServices | null
    ownModel: boolean
    configured: boolean
    proxy: string | undefined
    agent: string
    executor: string
    fullPower: boolean
    toolsRunning: boolean
  }> = {}
) {
  const store = memoryStore()

  const state = {
    served: 'served' in overrides ? overrides.served! : true,
    services: 'services' in overrides ? overrides.services! : ALL,
    ownModel: overrides.ownModel ?? false,
    configured: overrides.configured ?? true,
    proxy: 'proxy' in overrides ? overrides.proxy : 'http://127.0.0.1:43123/v1',
    agent: overrides.agent ?? 'agent-principal-1',
    executor: overrides.executor ?? 'exec-1',
    fullPower: overrides.fullPower ?? false,
    toolsRunning: overrides.toolsRunning ?? true
  }

  const tools = {
    url: 'http://127.0.0.1:50000',
    get running() {
      return state.toolsRunning
    },
    mint: vi.fn(() => 'k'.repeat(64))
  }

  let now = 1_000_000

  const deps: MatrixGoogleAssistantDeps = {
    store: () => store,
    agentPrincipal: () => state.agent,
    executorId: () => state.executor,
    ownModel: () => state.ownModel,
    connections: () => ({ configured: state.configured, services: () => state.services }),
    servesProtected: vi.fn(async () => state.served),
    proxyBaseUrl: () => state.proxy,
    tools: () => tools,
    fullPower: () => state.fullPower,
    now: () => now
  }

  return { google: new MatrixGoogleAssistant(deps), deps, state, store, tools, advance: (ms: number) => (now += ms) }
}

describe('the default assistant and Google (main policy)', () => {
  it('gives the default assistant Google tools from launch, before Google is connected, without latching', async () => {
    for (const services of [ALL, NONE, null]) {
      const { google, tools, store } = setup({ services })

      expect(await google.launch('agent:alfred')).toEqual({ env: {}, tools: false, fence: false })

      const launch = await google.launch('agent')

      expect(launch.tools).toBe(true)
      // Connecting later needs no restart: the tool is already in the list, behind the fence.
      expect(launch.env).toEqual({
        ATUM_GOOGLE_FENCE_ROUTE: 'http://127.0.0.1:43123/v1',
        ATUM_GOOGLE_TOOLS_URL: 'http://127.0.0.1:50000',
        ATUM_GOOGLE_TOOLS_TOKEN: 'k'.repeat(64)
      })
      expect(tools.mint).toHaveBeenCalledWith('agent')
      expect(store.items.size).toBe(0)
      expect(google.latched()).toBe(false)
      expect(google.route('agent')).toBe('open')
    }
  })

  it('gives no tools when the route is not served, on a model the person brought, or without a Google client or proxy', async () => {
    for (const change of [{ served: false }, { served: null }, { ownModel: true }, { configured: false }, { proxy: undefined }]) {
      const { google, store } = setup(change)

      expect(await google.launch('agent')).toEqual({ env: {}, tools: false, fence: false })
      expect(store.items.size).toBe(0)
    }
  })

  it('latches the home at the first call that could reach Google, before anything is read', async () => {
    const { google, store } = setup()
    await google.launch('agent')

    expect(google.gate('agent:alfred')).toBe('not_available')
    expect(store.items.size).toBe(0)

    expect(google.gate('agent')).toBe('ok')
    expect(store.items.get('matrix-google-agent-latch:agent-principal-1')).toBe('1')
    expect(store.items.get('matrix-google-latch:exec-1')).toBe('1')
    expect(google.latched()).toBe(true)
    expect(google.route('agent')).toBe('protected')
  })

  it('falls back to the executor latch without treating a missing key as already latched', async () => {
    const { google, store } = setup({ agent: '' })
    await google.refreshRoute()

    expect(google.latched()).toBe(false)
    expect(google.gate('agent')).toBe('ok')
    expect(store.items.get('matrix-google-latch:exec-1')).toBe('1')
    expect([...store.items.keys()].some(key => key.startsWith('matrix-google-agent-latch:'))).toBe(false)
  })

  it('keeps the latch across executor replacement and migrates an older executor-only proof', () => {
    const current = setup()
    current.store.items.set('matrix-google-agent-latch:agent-principal-1', '1')
    expect(current.google.latched()).toBe(true)
    expect(current.store.items.get('matrix-google-latch:exec-1')).toBe('1')
    current.state.executor = 'exec-2'
    expect(current.google.latched()).toBe(true)
    expect(current.store.items.get('matrix-google-latch:exec-2')).toBe('1')

    const legacy = setup()
    legacy.store.items.set('matrix-google-latch:exec-1', '1')
    expect(legacy.google.latched()).toBe(true)
    expect(legacy.store.items.get('matrix-google-agent-latch:agent-principal-1')).toBe('1')
  })

  it('atomically keeps both stable and rollback-build latch keys before Google data can flow', async () => {
    const { google, store } = setup()
    await google.refreshRoute()

    store.setItems.mockImplementation(() => {
      throw new Error('auth_storage_write_failed')
    })
    expect(google.gate('agent')).toBe('fence')
    expect(store.items.has('matrix-google-agent-latch:agent-principal-1')).toBe(false)
    expect(store.items.has('matrix-google-latch:exec-1')).toBe(false)

    // A crash/older non-atomic build may have left only the stable proof. Keep this run fenced,
    // but do not permit broker data until the rollback-build key can be healed too.
    store.items.set('matrix-google-agent-latch:agent-principal-1', '1')
    expect(google.latched()).toBe(true)
    expect(google.gate('agent')).toBe('fence')
    expect(store.items.has('matrix-google-latch:exec-1')).toBe(false)

    store.setItems.mockImplementation(entries => {
      for (const [key, value] of Object.entries(entries)) {
        store.items.set(key, value)
      }
    })
    expect(google.gate('agent')).toBe('ok')
    expect(store.items.get('matrix-google-agent-latch:agent-principal-1')).toBe('1')
    expect(store.items.get('matrix-google-latch:exec-1')).toBe('1')
  })

  it('does not latch a call that cannot return Google data, and latches when the grants cannot be read', async () => {
    const nothing = setup({ services: NONE })
    await nothing.google.refreshRoute()

    // Nothing connected: the broker answers "not connected", so no Google data can flow.
    expect(nothing.google.gate('agent')).toBe('ok')
    expect(nothing.google.latched()).toBe(false)

    const unreadable = setup({ services: null })
    await unreadable.google.refreshRoute()
    expect(unreadable.google.gate('agent')).toBe('ok')
    expect(unreadable.google.latched()).toBe(true)
  })

  it('refuses the call when the latch cannot be saved, so nothing is read', async () => {
    const { google, store } = setup()
    await google.refreshRoute()

    store.setItems.mockImplementation(() => {
      throw new Error('auth_storage_unavailable')
    })

    expect(google.gate('agent')).toBe('fence')
    expect(google.latched()).toBe(false)
  })

  it('opens the broker only for the default assistant on Atum’s model with the route known to be served', async () => {
    const { google, state, advance } = setup()

    // Before the first answer from the gateway, nothing is read.
    expect(google.gate('agent')).toBe('protected_route_unavailable')
    await google.refreshRoute()
    expect(google.gate('agent')).toBe('ok')

    state.ownModel = true
    expect(google.gate('agent')).toBe('not_available')
    state.ownModel = false

    state.served = false
    advance(11 * 60_000)
    await google.refreshRoute()
    expect(google.gate('agent')).toBe('protected_route_unavailable')
  })

  it('keeps the fence on a latched home for good, even with no tools (disconnected, route gone, own model)', async () => {
    const { google, state, advance } = setup()
    await google.launch('agent')
    google.gate('agent')

    state.services = NONE
    // Latched: the next launch says so, and its tool list is the same after a disconnect.
    expect(await google.launch('agent')).toEqual({
      env: {
        ATUM_GOOGLE_FENCE_ROUTE: 'http://127.0.0.1:43123/v1',
        ATUM_GOOGLE_LATCHED: '1',
        ATUM_GOOGLE_TOOLS_URL: 'http://127.0.0.1:50000',
        ATUM_GOOGLE_TOOLS_TOKEN: 'k'.repeat(64)
      },
      tools: true,
      fence: true
    })

    state.ownModel = true
    expect(await google.launch('agent')).toEqual({
      env: { ATUM_GOOGLE_FENCE_ROUTE: 'http://127.0.0.1:43123/v1', ATUM_GOOGLE_LATCHED: '1' },
      tools: false,
      fence: true
    })

    state.ownModel = false
    state.served = false
    advance(11 * 60_000)
    expect((await google.launch('agent')).tools).toBe(false)

    state.proxy = undefined
    // No proxy: an impossible route, so the latched home may use no model at all.
    expect((await google.launch('agent')).env).toEqual({ ATUM_GOOGLE_FENCE_ROUTE: 'none', ATUM_GOOGLE_LATCHED: '1' })
  })

  it('routes a latched assistant to the protected alias and refuses when the gateway says it is not served', async () => {
    const { google, state, advance } = setup()

    expect(google.route('agent')).toBe('open')
    await google.launch('agent')
    google.gate('agent')
    expect(google.route('agent')).toBe('protected')
    expect(google.route('agent:alfred')).toBe('open')

    state.served = false
    advance(11 * 60_000)
    await google.refreshRoute()
    expect(google.route('agent')).toBe('refused')
  })

  it('marks what the latched default assistant posts, and nothing else', async () => {
    const { google } = setup()

    await google.launch('agent')
    expect(google.marks('agent')).toBe(false)
    google.gate('agent')
    expect(google.marks('agent')).toBe(true)
    expect(google.marks('agent:alfred')).toBe(false)
  })

  it('treats an unreadable latch as latched, never as permission', async () => {
    const { google, store } = setup()
    await google.refreshRoute()

    store.getItem.mockReturnValue(null)
    store.failureCode.mockReturnValue('auth_storage_unavailable')

    expect(google.latched()).toBe(true)
    expect(google.marks('agent')).toBe(true)
    expect(google.gate('agent')).toBe('fence')
  })

  it('asks the gateway once for concurrent callers and keeps a served answer for 10 minutes', async () => {
    const { google, deps, state, advance } = setup()

    await Promise.all([google.refreshRoute(), google.refreshRoute(), google.refreshRoute()])
    expect(deps.servesProtected).toHaveBeenCalledTimes(1)

    advance(9 * 60_000)
    await google.refreshRoute()
    expect(deps.servesProtected).toHaveBeenCalledTimes(1)

    // An unknown answer (offline) never overturns a known one while it is fresh.
    state.served = null
    expect(await google.refreshRoute(undefined, true)).toBe(true)
    expect(deps.servesProtected).toHaveBeenCalledTimes(2)

    // Once stale, the last answer is no longer trusted.
    advance(11 * 60_000)
    expect(await google.refreshRoute()).toBeNull()
  })

  it('tells the first-run card and Settings what the assistant can do', async () => {
    expect(setup({ configured: false }).google.view()).toEqual({ state: 'unavailable', reason: 'not_configured' })
    expect(setup({ ownModel: true }).google.view()).toEqual({ state: 'unavailable', reason: 'own_model' })

    // Before the gateway has answered, nothing is offered.
    expect(setup({ services: NONE }).google.view()).toEqual({ state: 'unavailable', reason: 'route' })

    const unserved = setup({ served: false })
    await unserved.google.refreshRoute()
    expect(unserved.google.view()).toEqual({ state: 'unavailable', reason: 'route' })

    const fresh = setup({ services: NONE })
    await fresh.google.refreshRoute()
    expect(fresh.google.view()).toEqual({ state: 'connect' })

    const ready = setup({ services: { gmail: false, send: false, calendar: true, drive: false } })
    await ready.google.refreshRoute()
    expect(ready.google.view()).toEqual({ state: 'ready', services: { gmail: false, send: false, calendar: true, drive: false } })

    // A latched assistant whose route went away is paused, not "unavailable".
    const paused = setup()
    await paused.google.launch('agent')
    paused.google.gate('agent')
    paused.state.served = false
    paused.advance(11 * 60_000)
    await paused.google.refreshRoute()
    expect(paused.google.view()).toEqual({ state: 'paused', reason: 'route' })
    paused.state.ownModel = true
    expect(paused.google.view()).toEqual({ state: 'paused', reason: 'own_model' })
  })

  it('wants a restart only when the route or the model changes, never for connecting Google', async () => {
    const { google, state, advance } = setup({ services: NONE })

    expect(google.wantsTools()).toBe(false)
    await google.refreshRoute()
    expect(google.wantsTools()).toBe(true)

    state.services = ALL
    expect(google.wantsTools()).toBe(true)
    state.services = NONE
    expect(google.wantsTools()).toBe(true)

    state.ownModel = true
    expect(google.wantsTools()).toBe(false)
    state.ownModel = false

    // A served answer is trusted for 10 minutes; the next probe says it's gone.
    state.served = false
    advance(11 * 60_000)
    await google.refreshRoute()
    expect(google.wantsTools()).toBe(false)
  })
})

const LATCH_KEYS = ['matrix-google-agent-latch:agent-principal-1', 'matrix-google-latch:exec-1']

/** An assistant whose home is already latched on this Mac, as the owner's default assistant is. */
function latchedHome(overrides: Parameters<typeof setup>[0] = {}) {
  const home = setup(overrides)

  for (const key of LATCH_KEYS) {
    home.store.items.set(key, '1')
  }

  home.store.setItems.mockClear()

  return home
}

describe('Google full power (public-launch decision 2026-10-25)', () => {
  it('keeps a sticky latch inert while launching the broker tool without a fence or protected route', async () => {
    const { google, store, deps, tools } = latchedHome({ fullPower: true })

    expect(google.latched()).toBe(false)
    expect(google.route('agent')).toBe('open')
    expect(google.marks('agent')).toBe(false)
    expect(google.wantsTools()).toBe(true)
    expect(await google.launch('agent')).toEqual({
      env: {
        ATUM_GOOGLE_TOOLS_URL: 'http://127.0.0.1:50000',
        ATUM_GOOGLE_TOOLS_TOKEN: 'k'.repeat(64)
      },
      tools: true,
      fence: false
    })
    expect(tools.mint).toHaveBeenCalledWith('agent')
    expect(google.gate('agent')).toBe('ok')
    expect(google.view()).toEqual({ state: 'ready', services: ALL })
    // Nothing asked the gateway about a route this assistant does not use.
    expect(deps.servesProtected).not.toHaveBeenCalled()
    expect(await google.refreshRoute(undefined, true)).toBeNull()
    expect(deps.servesProtected).not.toHaveBeenCalled()
    // Keeps the stored latch exactly as it was: nothing cleared, nothing rewritten.
    expect(store.setItems).not.toHaveBeenCalled()
    expect(LATCH_KEYS.map(key => store.items.get(key))).toEqual(['1', '1'])
  })

  it('offers Google before connection and lets the broker call through without writing a latch', async () => {
    const { google, store } = setup({ fullPower: true, services: NONE })

    expect(google.view()).toEqual({ state: 'connect' })
    expect((await google.launch('agent')).tools).toBe(true)
    expect(google.gate('agent')).toBe('ok')
    expect(google.latched()).toBe(false)
    expect(store.items.size).toBe(0)
    expect(store.setItems).not.toHaveBeenCalled()
  })

  it('keeps Google connectable and ready with a model the person brought', async () => {
    const { google, state } = setup({
      fullPower: true,
      ownModel: true,
      proxy: undefined,
      served: false,
      services: NONE
    })

    expect(google.view()).toEqual({ state: 'connect' })
    expect(await google.launch('agent')).toMatchObject({ tools: true, fence: false })
    expect(google.gate('agent')).toBe('ok')

    state.services = { gmail: false, send: false, calendar: true, drive: false }
    expect(google.view()).toEqual({ state: 'ready', services: state.services })
  })

  it('does not offer a connection when the full-power broker failed to start', () => {
    const { google, state } = setup({ fullPower: true, services: NONE, toolsRunning: false })

    expect(google.view()).toEqual({ state: 'unavailable', reason: 'not_configured' })

    state.toolsRunning = true
    expect(google.view()).toEqual({ state: 'connect' })
  })

  it('wants exactly the broker tool its full-power launch receives', async () => {
    const { google, state } = setup({
      fullPower: true,
      ownModel: true,
      proxy: undefined,
      served: false,
      services: null
    })

    expect(google.wantsBroker()).toBe(true)
    expect(google.wantsTools()).toBe(true)
    expect((await google.launch('agent')).tools).toBe(true)

    state.toolsRunning = false
    expect(google.wantsBroker()).toBe(true)
    expect(google.wantsTools()).toBe(false)
    expect(await google.launch('agent')).toEqual({ env: {}, tools: false, fence: false })

    state.toolsRunning = true
    state.configured = false
    expect(google.wantsBroker()).toBe(false)
    expect(google.wantsTools()).toBe(false)
    expect(await google.launch('agent')).toEqual({ env: {}, tools: false, fence: false })
  })

  it('does not depend on the stored latch being readable', () => {
    const { google, store } = latchedHome({ fullPower: true })
    store.getItem.mockReturnValue(null)
    store.failureCode.mockReturnValue('auth_storage_unavailable')

    // Protected, this would read as latched ("never as permission"); with full power the store is not consulted.
    expect(google.latched()).toBe(false)
    expect(google.marks('agent')).toBe(false)
    expect(google.route('agent')).toBe('open')
    expect(store.getItem).not.toHaveBeenCalled()
  })

  it('gives every owner agent on the Mac the same unfenced capability, each under its own key, and nothing to app or human hosts', async () => {
    const { google, tools } = latchedHome({ fullPower: true })

    // No latch, fence or mark for another agent: it is the default assistant's protected-path concern only.
    expect(google.route('agent:alfred')).toBe('open')
    expect(google.marks('agent:alfred')).toBe(false)

    const launch = await google.launch('agent:alfred')

    expect(launch).toMatchObject({ tools: true, fence: false })
    expect(Object.keys(launch.env).sort()).toEqual(['ATUM_GOOGLE_TOOLS_TOKEN', 'ATUM_GOOGLE_TOOLS_URL'])
    expect(tools.mint).toHaveBeenCalledWith('agent:alfred')
    expect(google.gate('agent:alfred')).toBe('ok')
    expect(google.wantsTools('agent:alfred')).toBe(true)

    for (const role of ['human', 'app:demoza', 'agent:', 'agentx']) {
      expect(await google.launch(role)).toEqual({ env: {}, tools: false, fence: false })
      expect(google.gate(role)).toBe('not_available')
    }
  })

  it('keeps the protected path the default assistant\'s alone: another agent gets nothing when full power is off', async () => {
    const { google } = setup({ fullPower: false })

    expect(await google.launch('agent:alfred')).toEqual({ env: {}, tools: false, fence: false })
    expect(google.gate('agent:alfred')).toBe('not_available')
    expect(google.wantsTools('agent:alfred')).toBe(false)
  })

  it('respects the owner\'s source switch for every agent', () => {
    const { google, deps } = setup({ fullPower: true })
    const off = new MatrixGoogleAssistant({ ...deps, sourceEnabled: () => false })

    expect(google.gate('agent:alfred')).toBe('ok')
    expect(off.gate('agent:alfred')).toBe('not_available')
    expect(off.gate('agent')).toBe('not_available')
  })

  it('is one switch read at every decision: turning it off brings the stored latch and its fence back', async () => {
    const { google, state, store } = latchedHome({ fullPower: true })
    await google.refreshRoute()
    expect(google.latched()).toBe(false)

    state.fullPower = false
    expect(google.latched()).toBe(true)
    expect(google.marks('agent')).toBe(true)
    expect(google.route('agent')).toBe('protected')
    expect((await google.launch('agent')).env).toMatchObject({
      ATUM_GOOGLE_FENCE_ROUTE: 'http://127.0.0.1:43123/v1',
      ATUM_GOOGLE_LATCHED: '1'
    })
    expect(store.items.get(LATCH_KEYS[0])).toBe('1')

    state.fullPower = true
    expect(google.latched()).toBe(false)
    expect(await google.launch('agent')).toEqual({
      env: {
        ATUM_GOOGLE_TOOLS_URL: 'http://127.0.0.1:50000',
        ATUM_GOOGLE_TOOLS_TOKEN: 'k'.repeat(64)
      },
      tools: true,
      fence: false
    })
  })

  it('keeps the protected design when the caller never names the switch', () => {
    const { deps } = latchedHome()
    const { fullPower: _switch, ...withoutSwitch } = deps

    expect(new MatrixGoogleAssistant(withoutSwitch).latched()).toBe(true)
  })

  it('keeps protected broker startup dependent on its managed-model proxy', () => {
    expect(setup().google.wantsBroker()).toBe(true)
    expect(setup({ proxy: undefined }).google.wantsBroker()).toBe(false)
    expect(setup({ configured: false }).google.wantsBroker()).toBe(false)
  })

  it('lets the portable memory sync on a latched home that main used to keep local', async () => {
    const snapshot = { memory: ['Remembered'], user: ['Owner'] }
    const assistant = { assistantId: 'assistant-1', revision: 1, enabled: true, snapshot }

    const sync = async (google: MatrixGoogleAssistant) => {
      const memory = vi.fn(async () => assistant)

      const helper: MatrixAgentContentHelper = vi.fn(async (_runtime, _home, operation) =>
        operation === 'memory-read'
          ? { ok: true, snapshot, receipt: { revision: 1, snapshot } }
          : { ok: true, result: { success: true, snapshot } }
      )

      const state = await syncMatrixAgentMemory(
        {
          home: '/profiles/home',
          runtime: { python: '/unused/python', source: '/unused/source', profiles: '/unused/profiles' },
          live: () => true,
          // As main composes it for the default assistant (agentContentTarget).
          memoryAllowed: () => !google.latched(),
          memory,
          writeMemory: vi.fn(async () => assistant)
        },
        new AbortController().signal,
        helper
      )

      return { state, memory, helper }
    }

    const protectedHome = await sync(latchedHome().google)
    expect(protectedHome.state).toBe('local_only')
    expect(protectedHome.memory).not.toHaveBeenCalled()
    expect(protectedHome.helper).not.toHaveBeenCalled()

    const fullPower = await sync(latchedHome({ fullPower: true }).google)
    expect(fullPower.state).toBe('synced')
    expect(fullPower.memory).toHaveBeenCalled()
  })
})

it('enforces the owner source switch on every broker call, including full power', () => {
  const { deps } = setup({ fullPower: true })
  let enabled = false
  const assistant = new MatrixGoogleAssistant({ ...deps, sourceEnabled: () => enabled })
  expect(assistant.gate('agent')).toBe('not_available')
  enabled = true
  expect(assistant.gate('agent')).toBe('ok')
  enabled = false
  expect(assistant.gate('agent')).toBe('not_available')
})


it.each(['first-run', 'existing', 'v1', 'v2', 'v2-closed'])('keeps %s Google access automatic and honors later revocation', async kind => {
  const accountKey = 'a'.repeat(64)
  const values = new Map<string, string>()

  if (kind === 'v1') {
    values.set(`matrix-mac-sources-consent.${accountKey}`, JSON.stringify({
      version: 1, messages: false, browser: false, location: false
    }))
  }

  if (kind === 'v2' || kind === 'v2-closed') {
    values.set(`matrix-mac-sources-consent.${accountKey}`, JSON.stringify({
      version: 2, google: kind !== 'v2-closed', folders: false, messages: false, browser: false, location: false, teamSpaces: false
    }))
  }

  const store = new MacSourcesConsentStore({
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) }
  }, () => ({ accountKey, generation: 1 }))

  if (kind === 'first-run') {store.initializeFirstRunDefaults()}
  else {store.initializeExistingOpen()}

  store.initializeConnectedGoogle(true)
  const { deps } = setup({ fullPower: true })
  const assistant = new MatrixGoogleAssistant({ ...deps, sourceEnabled: () => store.read().google })
  const connected = async () => ({ status: { available: true, sources: [], accountState: 'ready' as const } })

  const handler = createMatrixGoogleConnectionIpcHandler({
    assertSender: () => {},
    connections: () => ({ status: connected, connect: connected, disconnect: connected, setSourcePreferences: connected })
  })

  const result = await handler({}, { kind: 'connect', grant: 'google', context: { origin: 'first_run', locale: 'en' } })
  expect(result.status?.accountState).toBe('ready')
  expect(assistant.gate('agent')).toBe('ok')
  store.set('google', false)
  expect(assistant.gate('agent')).toBe('not_available')
})
