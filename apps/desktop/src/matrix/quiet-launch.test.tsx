import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetAllBindings } from '@/store/keybinds'

import type { MatrixAgentView, MatrixRoom, MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import { MatrixApp } from './app'

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,ZmFrZQ==') } }))

/**
 * The quiet launch (quiet verification spec, 2026-10-05), through the real window: background
 * work never shows, an agent's trouble stays on its row and in its chat, and the one thing the
 * window asks of the person is the title bar's indicator.
 */

const OWNER = { userId: '@owner:test', deviceId: 'MAC' }
const NAMES = ['Atum', 'Moon', 'Sun', 'Star', 'Comet', 'Tide']

const room = (principal: string, name: string): MatrixRoom => ({
  id: `!${principal}:test`,
  name,
  membership: 'join',
  encrypted: true,
  direct: true,
  assistant: true,
  roomType: MATRIX_ASSISTANT_ROOM_TYPE,
  agentPrincipal: principal,
  lastActiveAt: 1_000,
  participants: [
    { userId: OWNER.userId, membership: 'join' },
    { userId: `@${principal}:test`, membership: 'join' }
  ]
})

const agent = (name: string, readiness: MatrixAgentView['readiness']): MatrixAgentView => {
  const principal = name.toLowerCase()

  return {
    principal,
    userId: `@${principal}:test`,
    deviceId: principal.toUpperCase(),
    name,
    isDefault: principal === 'atum',
    ready: true,
    hermes: 'ready',
    readiness,
    atumModel: true
  }
}

/** Six assistants, each with its chat; Atum's is open. `readiness` per assistant by name. */
function window6(readiness: (name: string) => MatrixAgentView['readiness'], extra: Partial<MatrixSnapshot> = {}) {
  const agents = NAMES.map(name => agent(name, readiness(name)))

  return {
    state: 'ready',
    identity: OWNER,
    assistant: { userId: '@atum:test', deviceId: 'ATUM' },
    domainEnabled: true,
    hermes: 'ready',
    assistantPath: 'local',
    atumModel: true,
    readiness: agents[0]!.readiness,
    agents,
    rooms: agents.map(each => room(each.principal, each.name!)),
    roomId: '!atum:test',
    messages: [],
    error: null,
    security: { recovery: 'idle' },
    ...extra
  } satisfies MatrixSnapshot
}

const ready = (): MatrixAgentView['readiness'] => ({ phase: 'ready', since: Date.now() - 60_000 })

function fixture(first: MatrixSnapshot) {
  window.localStorage.setItem('io.atum.desktop.language', 'en')

  const withLanguage = (state: MatrixSnapshot): MatrixSnapshot => ({
    ...state,
    displayPreferences: {
      appearance: { value: 'system', writable: true },
      textSize: { value: 100, writable: true },
      language: { value: 'en', writable: true }
    }
  })

  let listener: ((state: MatrixSnapshot) => void) | undefined

  const bridge = {
    windowFacts: vi.fn(async () => ({
      platform: 'darwin',
      isFullscreen: false,
      windowButtonPosition: { x: 12, y: 13 },
      overlayWidth: 0
    })),
    subscribeWindow: vi.fn(() => vi.fn()),
    setWindowMode: vi.fn(async () => {}),
    snapshot: async () => withLanguage(first),
    signIn: vi.fn(async () => {}),
    cancelSignIn: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    endDeviceSession: vi.fn(async () => {}),
    document: vi.fn(async () => {}),
    arrangeWord: vi.fn(async () => {}),
    closeDocumentPreview: vi.fn(async () => {}),
    readDomain: vi.fn(async () => ({ issuer: 'https://id.test/', subject: 'alice', principal: 'principal' })),
    cancelDomain: vi.fn(async () => {}),
    enrollment: vi.fn(async () => ({ state: 'absent' as const, identity: null })),
    enrollHermes: vi.fn(async () => ({ state: 'ready' as const, identity: null })),
    setupAssistant: vi.fn(async () => {}),
    revokeHermes: vi.fn(async () => ({ state: 'absent' as const, identity: null })),
    connectHermes: vi.fn(async () => {}),
    invokeHermes: vi.fn(async () => ({ state: 'cancelled' as const })),
    sendAssistant: vi.fn(async () => ({ eventId: '$sent', result: { state: 'published' as const } })),
    recoverHermes: vi.fn(async () => ({ state: 'unknown' as const })),
    sendTurn: vi.fn(async () => ({ turnId: '00000000-0000-4000-8000-11e594f48195' })),
    retryTurn: vi.fn(async () => ({ turnId: '00000000-0000-4000-8000-e79acd97ac88' })),
    retryReadiness: vi.fn(async () => {}),
    reconnectAgent: vi.fn(async () => {}),
    openTopUp: vi.fn(async () => {}),
    cancelHermes: vi.fn(async () => {}),
    createAgent: vi.fn(async () => ({ principal: 'agent-principal', roomId: '!agent:test' })),
    importAgent: vi.fn(async () => ({ principal: 'imported-principal', roomId: '!imported:test' })),
    retireAgent: vi.fn(async () => ({ sessionCleanup: 'complete' as const })),
    listenHermes: vi.fn(async () => {}),
    setContinuousListening: vi.fn(async () => {}),
    stopListeningHermes: vi.fn(async () => {}),
    respondHermes: vi.fn(async () => {}),
    configureHermes: vi.fn(async () => ({ state: 'ready' as const })),
    command: vi.fn(async () => null),
    openLink: vi.fn(async () => {}),
    approval: {
      accept: vi.fn(async () => {}),
      decline: vi.fn(async () => {}),
      pick: vi.fn(async () => {}),
      dismiss: vi.fn(async () => {}),
      retry: vi.fn(async () => {}),
      signOutDevice: vi.fn(async () => {})
    },
    subscribe: (fn: (state: MatrixSnapshot) => void) => {
      listener = fn

      return vi.fn()
    }
  } as unknown as MatrixUiBridge

  window.atumMatrix = bridge
  render(<MatrixApp />)

  return { bridge, emit: (state: MatrixSnapshot) => act(() => listener?.(withLanguage(state))) }
}

/** What sits above the transcript: the stack of bands and cards. */
const stack = () => window.document.querySelector('[data-matrix-status-stack]')
const indicators = () => window.document.querySelectorAll('[data-matrix-attention]')
const row = (principal: string) => window.document.querySelector<HTMLElement>(`[data-matrix-agent="${principal}"]`)!
const amberDots = () => window.document.querySelectorAll('[data-matrix-agent-dot="warn"]')
const chatNotice = () => window.document.querySelector('[data-matrix-launch-notice]')

beforeEach(() => {
  resetAllBindings()
  window.localStorage.setItem('io.atum.welcome.played', '1')
  vi.stubGlobal('innerWidth', 1220)
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

/**
 * Radix's FocusScope defers its unmount hook with `setTimeout(0)` and then builds a `CustomEvent` and
 * dispatches it on the (now detached) dialog container. `cleanup()` unmounts the dialogs a test left open,
 * so without draining that timer here it can fire after the jsdom environment is torn down, where the
 * global `CustomEvent` is Node's and the container is jsdom's: "Failed to execute 'dispatchEvent' on
 * 'EventTarget': parameter 1 is not of type 'Event'", reported as an unhandled error although every test passes.
 */
const settleUnmounts = () => new Promise<void>(resolve => setTimeout(resolve, 0))

afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  await settleUnmounts()
  vi.unstubAllGlobals()
  window.localStorage.clear()
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('a quiet launch', () => {
  it('shows nothing while six assistants check their trust and start, and nothing once they are ready', async () => {
    const starting = window6(name =>
      name === 'Atum'
        ? { phase: 'starting', step: 'hermes', since: Date.now() }
        : { phase: 'starting', step: 'assistant', since: Date.now() }
    )

    const { emit } = fixture({
      ...starting,
      // Another assistant's watch renewing itself at launch: the app's own business.
      agents: starting.agents.map(each =>
        each.principal === 'moon'
          ? {
              ...each,
              listening: {
                roomId: '!moon:test',
                expiresAt: Date.now() + 60_000,
                queued: 0,
                state: 'paused',
                mode: 'continuous',
                reason: 'renewing'
              }
            }
          : each
      )
    })

    await screen.findByRole('button', { name: 'Account: owner' })
    expect(stack()?.children.length).toBe(0)
    expect(indicators().length).toBe(0)
    expect(chatNotice()).toBeNull()
    expect(amberDots().length).toBe(0)
    // The message box says it, quietly.
    expect(screen.getByRole('textbox', { name: /^Message / }).getAttribute('placeholder')).toBe(
      'Atum is starting… You can type ahead.'
    )

    emit(window6(ready))
    expect(stack()?.children.length).toBe(0)
    expect(indicators().length).toBe(0)
    expect(chatNotice()).toBeNull()
    expect(amberDots().length).toBe(0)
  })

  it('keeps an assistant’s passing trouble quiet through the launch’s settling', async () => {
    fixture(
      window6(name =>
        name === 'Moon'
          ? { phase: 'blocked', step: 'assistant', code: 'agent_trust_failed', since: Date.now() }
          : ready()
      )
    )
    await screen.findByRole('button', { name: 'Account: owner' })
    expect(indicators().length).toBe(0)
    expect(amberDots().length).toBe(0)
  })
})

describe('an assistant that needs the person', () => {
  const moonNeedsYou = () =>
    window6(name =>
      name === 'Moon'
        ? { phase: 'blocked', step: 'assistant', code: 'agent_reconnect_required', since: Date.now() }
        : ready()
    )

  it('is one quiet indicator and its own row, nothing in another chat; its chat says what to do; then it all clears', async () => {
    const { bridge, emit } = fixture(moonNeedsYou())
    await screen.findByRole('button', { name: 'Account: owner' })

    // One indicator, naming it.
    await waitFor(() => expect(indicators().length).toBe(1))
    const indicator = screen.getByRole('button', { name: 'Needs you: Moon needs you' })
    // The title bar keeps only the dot; the words are its name and tooltip.
    expect(indicator.textContent).toBe('')

    // Its row says so, in amber; no other row does.
    expect(within(row('moon')).getByText('Needs to reconnect')).toBeTruthy()
    expect(row('moon').querySelector('[data-matrix-agent-dot="warn"]')).toBeTruthy()
    expect(amberDots().length).toBe(1)

    // Atum's chat, open, says nothing about Moon.
    expect(stack()?.children.length).toBe(0)
    expect(chatNotice()).toBeNull()

    // The indicator opens Moon's chat.
    fireEvent.click(indicator)
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith({ kind: 'select', roomId: '!moon:test' }))
    emit({ ...moonNeedsYou(), roomId: '!moon:test' })

    // There, one line with the one action.
    await waitFor(() => expect(chatNotice()?.getAttribute('data-matrix-launch-notice')).toBe('blocked'))
    expect(chatNotice()?.textContent).toContain('needs to reconnect on this Mac')
    expect(stack()?.children.length).toBe(0)
    fireEvent.click(within(chatNotice() as HTMLElement).getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(bridge.reconnectAgent).toHaveBeenCalledWith('moon'))

    // Mended: every trace goes.
    emit({ ...window6(ready), roomId: '!moon:test' })
    await waitFor(() => expect(indicators().length).toBe(0))
    expect(chatNotice()).toBeNull()
    expect(amberDots().length).toBe(0)
    expect(within(row('moon')).queryByText('Needs to reconnect')).toBeNull()
  })

  // 2026-10-06 check: listening the person can lift (0.20: only a Stop this Mac could not save) is
  // pressed again in the reply settings of the room it listens in, so the indicator lands there,
  // not in the agent's latest chat.
  it('opens the room its listening stopped in when that is what needs the person', async () => {
    const group: MatrixRoom = {
      id: '!team:test',
      name: 'Team',
      membership: 'join',
      encrypted: true,
      direct: false,
      lastActiveAt: 500,
      participants: [
        { userId: OWNER.userId, membership: 'join' },
        { userId: '@moon:test', membership: 'join' },
        { userId: '@sun:test', membership: 'join' }
      ]
    }

    const base = window6(ready)

    const stopped = {
      ...base,
      rooms: [...base.rooms, group],
      agents: base.agents.map(each =>
        each.principal === 'moon'
          ? {
              ...each,
              listening: {
                roomId: group.id,
                expiresAt: Date.now() + 60_000,
                queued: 0,
                state: 'paused' as const,
                mode: 'continuous' as const,
                reason: 'storage' as const
              }
            }
          : each
      )
    }

    const { bridge, emit } = fixture(stopped)
    await screen.findByRole('button', { name: 'Account: owner' })
    const indicator = await screen.findByRole('button', { name: 'Needs you: Moon needs you' })
    // Nothing in Atum's chat about it.
    expect(stack()?.children.length).toBe(0)

    fireEvent.click(indicator)
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith({ kind: 'select', roomId: group.id }))
    expect(bridge.command).not.toHaveBeenCalledWith({ kind: 'select', roomId: '!moon:test' })

    // There, too, nothing about listening is said in the chat (0.20): its reply settings say it.
    emit({ ...stopped, roomId: group.id })
    await act(async () => {})
    expect(stack()?.children.length).toBe(0)
  })

  it('is one indicator item for a cause every assistant shares, and no amber row', async () => {
    const { emit } = fixture(
      window6(() => ({ phase: 'degraded', step: 'ai', code: 'out_of_protons', since: Date.now() }))
    )

    await screen.findByRole('button', { name: 'Account: owner' })
    await waitFor(() => expect(indicators().length).toBe(1))
    expect(screen.getByRole('button', { name: 'Needs you: Out of Protons' })).toBeTruthy()
    expect(amberDots().length).toBe(0)
    // Said once (2026-10-06 check): the open chat has no card about it; its message box names it.
    expect(chatNotice()).toBeNull()
    expect(stack()?.children.length).toBe(0)
    expect(screen.getByRole('textbox', { name: /^Message / }).getAttribute('placeholder')).toBe(
      'Top up Protons to continue.'
    )

    emit(window6(ready))
    await waitFor(() => expect(indicators().length).toBe(0))
  })

  it.each([
    ['runtime_invalid', 'hermes', 'Update Atum'],
    ['action_required', 'assistant', 'Connect your Atum account'],
    ['device_replaced', 'assistant', 'Sign in again on this Mac']
  ] as const)('says a shared %s once, in the indicator, and names it in the message box', async (code, step, label) => {
    fixture(window6(() => ({ phase: 'blocked', step, code, since: Date.now() - 60_000 })))

    await screen.findByRole('button', { name: 'Account: owner' })
    await waitFor(() => expect(indicators().length).toBe(1))
    expect(screen.getByRole('button', { name: `Needs you: ${label}` })).toBeTruthy()
    expect(chatNotice()).toBeNull()
    expect(stack()?.children.length).toBe(0)
    expect(screen.getByRole('textbox', { name: /^Message / }).getAttribute('placeholder')).toBe(label)
  })
})

describe('another device asking this one to approve it', () => {
  // The person is at the new device, not this window: the sheet waits for them.
  beforeEach(() => {
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens the comparison by itself only while this window is in front', async () => {
    vi.mocked(window.document.hasFocus).mockReturnValue(true)
    fixture(
      window6(ready, {
        security: { recovery: 'idle', approval: { role: 'approve', state: 'asked', since: Date.now() } }
      })
    )

    expect(await screen.findByRole('dialog', { name: 'Did you just sign in on a new device?' })).toBeTruthy()
  })

  it('opens a still-live comparison when the window returns to the front', async () => {
    fixture(
      window6(ready, {
        security: {
          recovery: 'idle',
          approval: { role: 'approve', state: 'asked', since: Date.now() - 90_000, deviceName: 'iPhone' }
        }
      })
    )

    await screen.findByRole('button', { name: 'Needs you: Confirm new device' })
    expect(screen.queryByRole('dialog', { name: 'Did you just sign in on a new device?' })).toBeNull()

    vi.mocked(window.document.hasFocus).mockReturnValue(true)
    fireEvent(window, new Event('focus'))
    fireEvent(window, new Event('focus'))

    expect(await screen.findByRole('dialog', { name: 'Did you just sign in on a new device?' })).toBeTruthy()
    expect(screen.getAllByRole('dialog', { name: 'Did you just sign in on a new device?' })).toHaveLength(1)
  })

  it('keeps an older live request in the indicator without interrupting on focus', async () => {
    fixture(
      window6(ready, {
        security: {
          recovery: 'idle',
          approval: { role: 'approve', state: 'asked', since: Date.now() - 5 * 60_000 - 1, deviceName: 'iPhone' }
        }
      })
    )

    await screen.findByRole('button', { name: 'Needs you: Confirm new device' })
    vi.mocked(window.document.hasFocus).mockReturnValue(true)
    fireEvent(window, new Event('focus'))

    expect(screen.queryByRole('dialog', { name: 'Did you just sign in on a new device?' })).toBeNull()
  })

  it.each(['done', 'timeout', 'failed'] as const)('never opens a terminal %s request on focus', async state => {
    fixture(
      window6(ready, {
        security: { recovery: 'idle', approval: { role: 'approve', state, since: Date.now(), deviceName: 'iPhone' } }
      })
    )

    vi.mocked(window.document.hasFocus).mockReturnValue(true)
    fireEvent(window, new Event('focus'))

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Did you just sign in on a new device?' })).toBeNull()
    )
  })

  it('waits in the indicator, opens the comparison from it, and goes once the request ends', async () => {
    const asking = window6(ready, {
      security: {
        recovery: 'idle',
        approval: { role: 'approve', state: 'asked', since: Date.now(), deviceName: 'iPhone' }
      }
    })

    const { bridge, emit } = fixture(asking)
    await screen.findByRole('button', { name: 'Account: owner' })
    const indicator = await screen.findByRole('button', { name: 'Needs you: Confirm new device' })
    expect(stack()?.children.length).toBe(0)

    fireEvent.click(indicator)
    expect(await screen.findByRole('dialog', { name: 'Did you just sign in on a new device?' })).toBeTruthy()

    emit({
      ...asking,
      security: { recovery: 'idle', approval: { role: 'approve', state: 'timeout', since: Date.now() } }
    })
    await waitFor(() => expect(indicators().length).toBe(0))

    // Ended unseen: cleared, never left behind.
    emit({ ...asking, security: { recovery: 'idle' } })
    emit({
      ...asking,
      security: { recovery: 'idle', approval: { role: 'approve', state: 'timeout', since: Date.now() } }
    })
    await waitFor(() => expect(bridge.approval!.dismiss).toHaveBeenCalled())
  })

  it('counts two causes in one indicator, most pressing first', async () => {
    fixture(
      window6(ready, {
        disk: { state: 'low', freeGb: 8 },
        security: { recovery: 'idle', approval: { role: 'approve', state: 'asked', since: Date.now() } }
      })
    )

    await screen.findByRole('button', { name: 'Account: owner' })
    const indicator = await screen.findByRole('button', { name: 'Needs you: 2 things need you' })
    expect(indicators().length).toBe(1)
    // A disk almost full is no longer a band.
    expect(stack()?.children.length).toBe(0)
    fireEvent.click(indicator)
    const list = await waitFor(() => window.document.querySelector<HTMLElement>('[data-matrix-attention-list]')!)
    expect(within(list).getByRole('button', { name: /Confirm new device/ })).toBeTruthy()
    expect(list.textContent).toContain('Mac almost full')
    expect(list.textContent!.indexOf('Confirm new device')).toBeLessThan(list.textContent!.indexOf('Mac almost full'))
  })
})

describe('unmounting a dialog', () => {
  it('has its deferred focus-restore dispatched before the test ends, never after teardown', async () => {
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)
    const dispatched = vi.spyOn(EventTarget.prototype, 'dispatchEvent')
    const unmounts = () => dispatched.mock.calls.filter(([event]) => event.type === 'focusScope.autoFocusOnUnmount')

    fixture(
      window6(ready, {
        security: { recovery: 'idle', approval: { role: 'approve', state: 'asked', since: Date.now() } }
      })
    )
    await screen.findByRole('dialog', { name: 'Did you just sign in on a new device?' })

    cleanup()
    // Still queued: this is the work that used to outlive the environment.
    expect(unmounts()).toHaveLength(0)

    await settleUnmounts()
    expect(unmounts().length).toBeGreaterThan(0)
    dispatched.mockRestore()
    vi.restoreAllMocks()
  })
})
