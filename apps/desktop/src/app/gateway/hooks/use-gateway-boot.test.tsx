import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { atumStartupOwnsWindow } from '@/app/atum/startup-ownership'
import { $privateAdvisoryTasks, type PrivateAdvisoryTask } from '@/app/dm/private-advisory-runner'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $desktopBoot } from '@/store/boot'
import { activeGateway, closeSecondaryGateways, gatewayForProfile, openGatewayForProfile } from '@/store/gateway'
import { $notifications } from '@/store/notifications'
import { $gatewayState, $sessions } from '@/store/session'
import { clearAllSessionStates, publishSessionState } from '@/store/session-states'
import type { RpcEvent, SessionInfo } from '@/types/hermes'

import { takeGatewaySurvivor } from './gateway-hmr-survivor'
import { useGatewayBoot } from './use-gateway-boot'

// End-to-end-ish repro of the "remote VPS → stuck on CONNECTING, no Settings"
// bug that drives the REAL useGatewayBoot hook + REAL HermesGateway through a
// fake WebSocket we fully control. No Docker / no real port: from the desktop's
// point of view a "remote VPS" is just a WebSocket that opens once and later
// refuses to reopen, so that is exactly (and only) what we fake.
//
// The previous test (gateway-connecting-overlay.test.tsx) hand-set the stores
// and asserted the overlays; this one proves the HOOK actually PRODUCES that
// stuck store combo — closing the "inferred by reading code" gap on the
// post-boot reconnect loop.

type Listener = (ev: unknown) => void
let connectionApplied: null | (() => void) = null

// Minimal WebSocket stand-in implementing only what json-rpc-gateway.connect()
// touches: readyState, add/removeEventListener('open'|'error'|'close'), close().
class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  // Flipped by the test: 'open' = next socket connects; 'fail' = next socket
  // errors (a dead remote). Mirrors a VPS going away after the first connect.
  static mode: 'open' | 'fail' = 'open'
  static instances: FakeWebSocket[] = []

  readyState = 0
  private listeners: Record<string, Set<Listener>> = {}

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
    const willOpen = FakeWebSocket.mode === 'open'
    // Resolve on the next microtask/macrotask so connect()'s promise wiring is
    // in place before open/error fires (matches real async socket handshake).
    setTimeout(() => {
      if (willOpen) {
        this.readyState = FakeWebSocket.OPEN
        this.emit('open', {})
      } else {
        this.readyState = FakeWebSocket.CLOSED
        this.emit('error', {})
      }
    }, 0)
  }

  addEventListener(type: string, fn: Listener) {
    ;(this.listeners[type] ??= new Set()).add(fn)
  }

  removeEventListener(type: string, fn: Listener) {
    this.listeners[type]?.delete(fn)
  }

  send = vi.fn() // Native peer-request capability advertisement; ordinary RPCs are mocked below.

  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', {})
  }

  // Force-drop an open socket, as a sleeping laptop / restarted remote would.
  drop() {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', {})
  }

  receive(event: RpcEvent) {
    if (this.readyState === FakeWebSocket.OPEN) {
      this.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: event }) })
    }
  }

  private emit(type: string, ev: unknown) {
    for (const fn of this.listeners[type] ?? []) {
      fn(ev)
    }
  }
}

function fakeDesktop() {
  const conn = {
    authMode: 'token' as const,
    baseUrl: 'https://vps.example.com',
    profile: 'default',
    token: 't',
    wsUrl: 'wss://vps.example.com/api/ws?token=t'
  }

  return {
    getConnection: vi.fn(async () => conn),
    getGatewayWsUrl: vi.fn(async () => conn.wsUrl),
    getBootProgress: vi.fn(async () => ({
      error: null,
      fakeMode: false,
      message: '',
      phase: 'init',
      progress: 0,
      running: true,
      timestamp: Date.now()
    })),
    onBootProgress: vi.fn(() => () => undefined),
    onBackendExit: vi.fn(() => () => undefined),
    onConnectionApplied: vi.fn(callback => {
      connectionApplied = callback

      return () => {
        connectionApplied = null
      }
    }),
    onPowerResume: vi.fn(() => () => undefined),
    onWindowStateChanged: vi.fn(() => () => undefined),
    touchBackend: vi.fn(async () => undefined),
    profile: { get: vi.fn(async () => ({ profile: 'default' })) }
  }
}

function Harness({
  beforeConnectionSwitch = () => undefined,
  handleGatewayEvent = () => undefined,
  refreshSessions
}: {
  beforeConnectionSwitch?: () => void
  handleGatewayEvent?: (event: RpcEvent) => void
  refreshSessions?: () => Promise<void>
} = {}) {
  useGatewayBoot({
    beforeConnectionSwitch,
    handleGatewayEvent,
    onConnectionReady: () => undefined,
    onGatewayReady: () => undefined,
    refreshHermesConfig: async () => undefined,
    refreshSessions: refreshSessions ?? (async () => undefined)
  })

  return null
}

const originalWebSocket = globalThis.WebSocket

beforeEach(() => {
  // Drop any parked gateway left by a prior file/case (globalThis slot).
  const leftover = takeGatewaySurvivor()

  if (leftover) {
    try {
      leftover.gateway.close()
    } catch {
      // ignore
    }
  }

  vi.useFakeTimers()
  FakeWebSocket.mode = 'open'
  FakeWebSocket.instances = []
  connectionApplied = null
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket
  ;(window as { hermesDesktop?: unknown }).hermesDesktop = fakeDesktop()
  $gatewayState.set('idle')
  $notifications.set([])
  $desktopBoot.set({
    error: null,
    fakeMode: false,
    message: '',
    phase: 'init',
    progress: 0,
    running: true,
    timestamp: Date.now(),
    visible: true
  })
})

afterEach(() => {
  cleanup()
  closeSecondaryGateways()
  $privateAdvisoryTasks.set({})
  clearAllSessionStates()
  $sessions.set([])
  // Vitest keeps import.meta.hot truthy, so the boot effect's cleanup parks an
  // open gateway instead of tearing it down (the real HMR path). Drain + close
  // that survivor so the next test boots a fresh socket instead of adoptBoot().
  const survivor = takeGatewaySurvivor()

  if (survivor) {
    try {
      survivor.gateway.close()
    } catch {
      // ignore
    }
  }

  vi.useRealTimers()
  ;(globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

it.each([
  'atum_runtime_account_required',
  "Error invoking remote method 'hermes:connection': Error: atum_runtime_account_required"
])('shows login without starting or retrying an unowned backend: %s', async message => {
  const desktop = window.hermesDesktop!
  const connection = await desktop.getConnection()
  vi.mocked(desktop.getConnection).mockReset().mockRejectedValue(new Error(message))
  const staleProgress = await desktop.getBootProgress()
  let resolveSnapshot!: (value: typeof staleProgress) => void
  vi.mocked(desktop.getBootProgress).mockImplementation(() => new Promise(resolve => { resolveSnapshot = resolve }))

  render(<Harness />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })

  const boot = $desktopBoot.get()
  expect(boot).toMatchObject({ error: null, phase: 'renderer.account', running: false, visible: false })
  expect(atumStartupOwnsWindow({
    bootError: boot.error, bootProgress: boot.progress, bootRunning: boot.running,
    bootVisible: boot.visible, coldBootDone: !boot.running && boot.progress >= 100 && !boot.error,
    gatewayState: 'idle', gatewaySwitching: false
  })).toBe(false)
  expect(FakeWebSocket.instances).toHaveLength(0)

  await act(async () => {
    // Delayed native startup messages must not take the window back from login.
    resolveSnapshot(staleProgress)
    vi.mocked(desktop.onBootProgress).mock.calls[0][0](staleProgress)
    await vi.advanceTimersByTimeAsync(0)
  })
  expect($desktopBoot.get()).toEqual(boot)

  await act(async () => {
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(120_000)
  })
  expect(desktop.getConnection).toHaveBeenCalledTimes(1)

  // Main publishes the existing connection-applied event only after activating
  // the signed-in account's Hermes home. Resume through the same soft switch.
  vi.mocked(desktop.getConnection).mockResolvedValue(connection)
  await act(async () => {
    connectionApplied?.()
    await vi.advanceTimersByTimeAsync(10)
  })
  expect(FakeWebSocket.instances).toHaveLength(1)
  expect($gatewayState.get()).toBe('open')
  expect($desktopBoot.get()).toMatchObject({ error: null, phase: 'renderer.ready', visible: false })
})

it('stops reconnecting after account revocation and resumes when another account activates', async () => {
  const desktop = window.hermesDesktop!
  const connection = await desktop.getConnection()
  vi.mocked(desktop.getConnection).mockClear()
  render(<Harness />)
  await act(async () => { await vi.advanceTimersByTimeAsync(10) })
  expect($gatewayState.get()).toBe('open')

  vi.mocked(desktop.getConnection).mockRejectedValue(new Error('atum_runtime_account_required'))
  await act(async () => {
    FakeWebSocket.instances[0].drop()
    await vi.advanceTimersByTimeAsync(1_100)
  })
  expect($desktopBoot.get()).toMatchObject({ error: null, phase: 'renderer.account', visible: false })
  const callsWhileSignedOut = vi.mocked(desktop.getConnection).mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
  expect(desktop.getConnection).toHaveBeenCalledTimes(callsWhileSignedOut)

  vi.mocked(desktop.getConnection).mockResolvedValue(connection)
  await act(async () => {
    connectionApplied?.()
    await vi.advanceTimersByTimeAsync(10)
  })
  expect($gatewayState.get()).toBe('open')
  expect($desktopBoot.get().error).toBeNull()
})

it.each(['publishing', 'completed', 'cancelled', 'failed'] as const)(
  'keeps an unlisted advisory profile connected through startup and input, then releases it when %s',
  async terminalState => {
    const runtimeId = 'advisory-runtime'
    const storedId = 'advisory-stored'

    const task: PrivateAdvisoryTask = {
      jobId: 'advisory-job', conversationId: 'meeting', accountId: 'owner', profile: 'marketing',
      runtimeSessionId: null, durableSessionId: null, state: 'starting'
    }

    const updateTask = (patch: Partial<PrivateAdvisoryTask>) => {
      Object.assign(task, patch)
      $privateAdvisoryTasks.set({ [task.jobId]: { ...task } })
    }

    render(<Harness handleGatewayEvent={event => {
      if (event.type === 'session.info' && event.session_id === runtimeId) {
        // The global event consumer publishes running before the advisory
        // listener sees the frame. Its durable ID has no ordinary sidebar row.
        publishSessionState(runtimeId, { ...createClientSessionState(storedId), busy: true })
      }
    }} />)
    await flushAsync()
    const foreground = activeGateway()
    updateTask({})
    const opening = openGatewayForProfile('marketing')
    await flushAsync()
    await opening
    const advisoryGateway = gatewayForProfile('marketing')
    const socket = FakeWebSocket.instances.at(-1)!
    expect(advisoryGateway).not.toBeNull()
    expect($sessions.get()).toEqual([])

    const completed = vi.fn()

    const off = advisoryGateway!.onEvent(event => {
      if (event.type === 'message.complete') {completed(event.payload)}
    })

    act(() => socket.receive({ type: 'session.info', session_id: runtimeId, payload: { running: true, stored_session_id: storedId } }))
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
    expect(gatewayForProfile('marketing')).toBe(advisoryGateway)
    updateTask({ state: 'running', runtimeSessionId: runtimeId, durableSessionId: storedId })
    updateTask({ state: 'needs_input' })
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
    expect(activeGateway()).toBe(foreground)

    act(() => socket.receive({ type: 'message.complete', session_id: runtimeId, payload: { text: 'canonical answer' } }))
    expect(completed).toHaveBeenCalledWith({ text: 'canonical answer' })
    off()
    updateTask({ state: terminalState })
    expect(gatewayForProfile('marketing')).toBeNull()
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
    expect(activeGateway()).toBe(foreground)
  }
)

// Let pending microtasks (awaits) AND the queued 0ms socket open/error fire.
async function flushAsync() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

// Drive the exponential backoff forward by its full cap so the next scheduled
// reconnect attempt actually runs (1s,2s,4s,8s,15s,15s…). Returns after the
// attempt's async work settles.
async function advanceBackoff() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000)
  })
}

describe('useGatewayBoot remote reconnect loop (real hook, fake socket)', () => {
  it('INITIAL boot against a dead VPS: getConnection hangs (waitForHermes) → app sits in the connecting combo, then fails', async () => {
    // The report's actual path: a fresh launch pointed at an unreachable VPS.
    // startHermes()'s remote branch awaits waitForHermes() for 45s before it
    // throws, so the renderer's `await desktop.getConnection()` stays pending
    // that whole window. During it: gatewayState is still 'idle' (connect was
    // never reached) and boot.error is null → connecting=true → the fullscreen
    // CONNECTING overlay, latched, blocking Settings.
    let rejectConn: (e: Error) => void = () => undefined
    const desktop = fakeDesktop()
    desktop.getConnection = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectConn = reject
        })
    )
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = desktop

    render(<Harness />)
    await flushAsync()

    // getConnection is still pending — the dead-VPS wait. No socket was ever
    // created, gatewayState never left idle, boot.error is null.
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect($gatewayState.get()).not.toBe('open')
    expect($desktopBoot.get().error).toBeNull()
    // ^ connecting === true here → fullscreen CONNECTING, no Settings.

    // After ~45s waitForHermes gives up and getConnection rejects → boot()
    // catch → failDesktopBoot → the BootFailureOverlay recovery surface.
    await act(async () => {
      rejectConn(new Error('Hermes backend did not become ready: timeout'))
      await vi.advanceTimersByTimeAsync(0)
    })

    expect($desktopBoot.get().error).toBeTruthy()
  })

  it('keeps a failed boot’s raw cause in diagnostics only, never in a toast', async () => {
    const desktop = fakeDesktop()
    desktop.getConnection = vi.fn(async () => {
      throw new Error('Hermes backend did not become ready: timeout')
    })
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = desktop

    render(<Harness />)
    await flushAsync()

    // The full-page failure panel owns the message; the raw cause stays in boot state.
    expect($desktopBoot.get().error).toBe('Hermes backend did not become ready: timeout')

    const shown = $notifications
      .get()
      .map(item => `${item.title ?? ''} ${item.message} ${item.detail ?? ''}`)
      .join('\n')

    expect(shown).not.toMatch(/Hermes|backend/)
  })

  it('resets the old machine context before connecting an applied gateway', async () => {
    const beforeConnectionSwitch = vi.fn()
    render(<Harness beforeConnectionSwitch={beforeConnectionSwitch} />)
    await flushAsync()
    expect(connectionApplied).not.toBeNull()

    act(() => connectionApplied?.())
    expect(beforeConnectionSwitch).toHaveBeenCalledTimes(1)
    await flushAsync()
    expect($gatewayState.get()).toBe('open')
  })

  it('a remote that drops post-boot keeps looping with NO boot.error (the dead-end CONNECTING combo)', async () => {
    render(<Harness />)
    await flushAsync()

    // Initial boot connected.
    expect($gatewayState.get()).toBe('open')
    expect($desktopBoot.get().error).toBeNull()
    expect(FakeWebSocket.instances).toHaveLength(1)

    // The remote VPS goes away: drop the live socket, and make every reopen
    // fail from here on.
    FakeWebSocket.mode = 'fail'
    act(() => FakeWebSocket.instances[0].drop())
    await flushAsync()

    // Burn a couple backoff cycles BEFORE the escalation threshold (<6 attempts,
    // ~the first ~15s). This is the window where stock and fixed behave the
    // same: socket down, hook retrying, gatewayState non-open, boot.error still
    // null → CONNECTING covers the screen with no recovery surface. (Past ~45s
    // the fix raises boot.error; that's asserted in the next test.)
    await advanceBackoff()

    expect($gatewayState.get()).not.toBe('open')
    expect($desktopBoot.get().error).toBeNull()
    // It is actively retrying, not idle — more sockets were minted.
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1)
  })

  it('FIX: after the prolonged drop the hook raises a recoverable boot error (the escape hatch)', async () => {
    render(<Harness />)
    await flushAsync()
    expect($desktopBoot.get().error).toBeNull()

    FakeWebSocket.mode = 'fail'
    act(() => FakeWebSocket.instances[0].drop())
    await flushAsync()

    // Walk the backoff past the >=6 attempt threshold (~45s of failures).
    for (let i = 0; i < 8; i += 1) {
      await advanceBackoff()
    }

    // The hook surfaced the recoverable error → BootFailureOverlay (Use local
    // gateway / Sign in / Retry) becomes reachable instead of CONNECTING.
    expect($desktopBoot.get().error).toBeTruthy()
  })

  it('FIX: a successful reconnect clears the recoverable error', async () => {
    render(<Harness />)
    await flushAsync()

    FakeWebSocket.mode = 'fail'
    act(() => FakeWebSocket.instances[0].drop())
    await flushAsync()

    for (let i = 0; i < 8; i += 1) {
      await advanceBackoff()
    }

    expect($desktopBoot.get().error).toBeTruthy()

    // The remote comes back: next reconnect attempt opens.
    FakeWebSocket.mode = 'open'
    await advanceBackoff()

    expect($gatewayState.get()).toBe('open')
    expect($desktopBoot.get().error).toBeNull()
  })

  it('FIX: a failed session-list fetch during boot is non-fatal — the app still boots', async () => {
    // The version-skew report: gateway WS connects fine, but refreshSessions()
    // rejects (e.g. older backend 404s an endpoint the fallback didn't cover,
    // or a transient read error). That must NOT reject boot() into
    // failDesktopBoot's "Hermes couldn't start" overlay — the socket is open
    // and the app is fully usable with an empty sidebar.
    const refreshSessions = vi.fn(async () => {
      throw new Error('404: {"detail":"No such API endpoint: /api/profiles/sessions/sidebar"}')
    })

    render(<Harness refreshSessions={refreshSessions} />)
    await flushAsync()

    expect(refreshSessions).toHaveBeenCalled()
    expect($gatewayState.get()).toBe('open')
    // Boot completed: no error, overlay dismissed.
    expect($desktopBoot.get().error).toBeNull()
    expect($desktopBoot.get().visible).toBe(false)
    expect($desktopBoot.get().phase).toBe('renderer.ready')
  })

  it('repairs a transient initial session-list failure after the boot overlay is down', async () => {
    const refreshSessions = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('transient session DB read failure'))
      .mockResolvedValue(undefined)

    render(<Harness refreshSessions={refreshSessions} />)
    await flushAsync()

    // Session discovery remains non-fatal: the usable shell is visible before
    // the retry fires, rather than putting a sidebar read behind the boot gate.
    expect(refreshSessions).toHaveBeenCalledTimes(1)
    expect($desktopBoot.get()).toMatchObject({ error: null, phase: 'renderer.ready', visible: false })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })

    expect(refreshSessions).toHaveBeenCalledTimes(2)
  })

  it('repairs a successful-but-empty cold-start session discovery without blocking boot', async () => {
    const seeded: SessionInfo = {
      ended_at: null,
      id: 'seeded-existing-session',
      input_tokens: 0,
      is_active: false,
      last_active: 1,
      message_count: 1,
      model: null,
      output_tokens: 0,
      preview: 'Existing work',
      source: 'desktop',
      started_at: 1,
      title: 'Existing work',
      tool_call_count: 0
    }

    const refreshSessions = vi.fn(async () => {
      if (refreshSessions.mock.calls.length === 2) {
        $sessions.set([seeded])
      }
    })

    render(<Harness refreshSessions={refreshSessions} />)
    await flushAsync()

    // The first empty response is non-fatal: the shell is already usable and
    // the existing account is repaired quietly after the short retry delay.
    expect(refreshSessions).toHaveBeenCalledTimes(1)
    expect($desktopBoot.get()).toMatchObject({ error: null, phase: 'renderer.ready', visible: false })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })

    expect(refreshSessions).toHaveBeenCalledTimes(2)
    expect($sessions.get().map(session => session.id)).toEqual(['seeded-existing-session'])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(refreshSessions).toHaveBeenCalledTimes(2)
  })
})
