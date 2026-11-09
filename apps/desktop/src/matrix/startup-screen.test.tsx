import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $appViewOverlayCount } from '@/store/app-view-overlay'

import { MatrixReadinessMonitor } from '../../electron/matrix/readiness'
import type { MatrixAgentView, MatrixReadiness, MatrixSnapshot } from '../../shared/matrix'

import { $matrixDesktopServices } from './desktop-services'
import {
  MATRIX_LAUNCH_HOLD_MS,
  MATRIX_LAUNCH_START_WAIT_MS,
  matrixChatReady,
  matrixLaunchAccountStep,
  matrixLaunchAgentReadiness,
  matrixLaunchAgents,
  matrixLaunchUnreachable,
  matrixStartupBlocking,
  MatrixStartupScreen
} from './startup-screen'

const base: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@owner:test', deviceId: 'D' },
  rooms: [],
  roomId: null,
  messages: [],
  error: null,
  agentRoster: { state: 'ready', since: 0 }
}

afterEach(cleanup)

describe('cold-start scope during an enrollment cooldown', () => {
  it('opens after the normal launch moment while the readiness monitor waits in the background', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-02T12:00:00Z'))
    const retryAt = Date.UTC(2026, 9, 3)
    const setup = vi.fn(async () => ({ ok: false as const, code: 'rate_limited', retryAt }))
    const hermes = vi.fn(async () => ({ ok: true as const }))
    const onDone = vi.fn()

    const monitor = new MatrixReadinessMonitor({
      gate: [
        { step: 'assistant', check: setup },
        { step: 'hermes', check: hermes }
      ],
      watch: [],
      onChange: () => {},
      random: () => 0.5
    })

    const draw = (state: MatrixSnapshot['state']) => (
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixStartupScreen onDone={onDone} snapshot={{ ...base, state, readiness: monitor.current }} />
      </I18nProvider>
    )

    const view = render(draw('connecting'))

    try {
      expect(view.container.querySelector('[data-slot="matrix-startup"]')).not.toBeNull()
      monitor.start()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      view.rerender(draw('connecting'))
      expect(matrixStartupBlocking({ ...base, state: 'connecting', readiness: monitor.current })).toBe(true)
      expect(onDone).not.toHaveBeenCalled()
      view.rerender(draw('ready'))
      // The person's chats are ready. A platform wait belongs to the assistant's row/chat and
      // its monitor, so it cannot turn the launch into a recovery screen.
      expect(matrixStartupBlocking({ ...base, readiness: monitor.current })).toBe(false)
      expect(view.container.querySelector('[data-phase="lit"]')).toBeNull()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MATRIX_LAUNCH_HOLD_MS)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100)
      })
      expect(onDone).toHaveBeenCalledOnce()
      expect(view.container.querySelector('[data-slot="matrix-startup"]')).toBeNull()
      expect(view.container.querySelector('[data-phase="lit"]')).toBeNull()
      expect(monitor.current).toMatchObject({ phase: 'starting', code: 'rate_limited', retryAt })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60 * 60_000)
      })
      expect(setup).toHaveBeenCalledOnce()
      expect(hermes).not.toHaveBeenCalled()
    } finally {
      monitor.stop()
      view.unmount()
      vi.useRealTimers()
    }

    expect($appViewOverlayCount.get()).toBe(0)
  })

  it('keeps only a normal assistant start as the brief wait once chats are ready', () => {
    const starting = { phase: 'starting' as const, step: 'assistant' as const, since: 1 }
    const readiness = { phase: 'starting' as const, step: 'assistant' as const, code: 'rate_limited', since: 1 }

    expect(matrixStartupBlocking({ ...base, readiness: starting })).toBe(true)
    expect(matrixStartupBlocking({ ...base, readiness })).toBe(false)
    expect(matrixStartupBlocking({ ...base, readiness: { ...readiness, retryAt: 60_000, step: 'hermes' } })).toBe(
      false
    )
    expect(
      matrixStartupBlocking({
        ...base,
        readiness: { phase: 'blocked', step: 'assistant', code: 'agent_trust_failed', since: 1 }
      })
    ).toBe(false)
    expect(
      matrixStartupBlocking({
        ...base,
        readiness: { phase: 'degraded', step: 'ai', code: 'ai_unavailable', since: 1 }
      })
    ).toBe(false)
    // Still connecting: nothing to open to yet.
    expect(matrixStartupBlocking({ ...base, state: 'connecting', readiness })).toBe(true)
  })

  it('bounds the brief wait: a start that never answers opens the app after MATRIX_LAUNCH_START_WAIT_MS', () => {
    const starting = { phase: 'starting' as const, step: 'hermes' as const, since: 1 }

    expect(matrixStartupBlocking({ ...base, readiness: starting })).toBe(true)
    expect(matrixStartupBlocking({ ...base, readiness: starting }, MATRIX_LAUNCH_START_WAIT_MS - 1)).toBe(true)
    expect(matrixStartupBlocking({ ...base, readiness: starting }, MATRIX_LAUNCH_START_WAIT_MS)).toBe(false)
    // The genuine gates are not time-bounded: chats not ready yet still hold.
    expect(
      matrixStartupBlocking({ ...base, state: 'connecting', readiness: starting }, MATRIX_LAUNCH_START_WAIT_MS * 10)
    ).toBe(true)
  })
})

describe('the launch waits for the complete agent roster', () => {
  afterEach(() => vi.useRealTimers())

  const at = (
    phase: 'starting' | 'blocked',
    step: NonNullable<MatrixSnapshot['readiness']>['step'],
    code?: string
  ) => ({
    ...base,
    readiness: { phase, step, code, since: 1 }
  })

  it('shows the approved quiet Getting ready state for a first run, without checks or percentages', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixStartupScreen
          onDone={vi.fn()}
          snapshot={{
            ...base,
            firstRunWelcome: 'open',
            readiness: { phase: 'starting', step: 'assistant', since: 1 }
          }}
        />
      </I18nProvider>
    )

    expect(screen.getByRole('status').textContent).toBe('Getting Atum ready')
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(window.document.querySelector('[data-slot="matrix-startup-steps"]')).toBeNull()
    expect(window.document.querySelector('[data-slot="matrix-startup-agents"]')).toBeNull()
  })

  it('leaves the roster unnamed until chats are ready to publish it', () => {
    const waitingForChats = {
      ...base,
      agentRoster: undefined,
      readiness: { phase: 'starting' as const, step: 'signed_in' as const, since: 1 }
    }

    expect(matrixLaunchAgents(waitingForChats)).toEqual([])
    expect(matrixStartupBlocking(waitingForChats)).toBe(true)
  })

  it('holds cold start until chats and every assistant step are ready', () => {
    expect(matrixStartupBlocking(at('starting', 'signed_in'))).toBe(true)
    expect(matrixChatReady(at('starting', 'signed_in'))).toBe(false)

    for (const step of ['assistant', 'hermes', 'ai', 'authority'] as const) {
      expect(matrixStartupBlocking(at('starting', step))).toBe(true)
      expect(matrixChatReady(at('starting', step))).toBe(true)
    }
  })

  it('does not wait for the app catalog or an assistant that stopped, but briefly waits for normal preparation', () => {
    const ready = { ...base, readiness: { phase: 'ready' as const, since: 1 } }
    expect(matrixStartupBlocking({ ...ready, apps: { state: 'loading', apps: [], connections: {} } })).toBe(false)
    const agent = {
      principal: 'second',
      userId: '@second:test',
      isDefault: false,
      ready: false,
      atumModel: true,
      hermes: 'unavailable' as const,
      readiness: { phase: 'starting' as const, step: 'hermes' as const, since: 1 }
    }

    const primary = {
      ...agent,
      principal: 'atum',
      userId: '@atum:test',
      isDefault: true,
      ready: true,
      hermes: 'ready' as const,
      readiness: ready.readiness
    }

    expect(matrixStartupBlocking({ ...ready, agents: [primary, agent] })).toBe(true)
    // Another agent that stopped shows it on its own row and retries in the background.
    expect(
      matrixStartupBlocking({
        ...ready,
        agents: [primary, { ...agent, readiness: { phase: 'blocked', code: 'runtime_invalid', since: 1 } }]
      })
    ).toBe(false)
    expect(matrixStartupBlocking({ ...ready, apps: { state: 'unavailable', apps: [], connections: {} } })).toBe(false)
  })

  it('leaves the account shell usable when one or every assistant only needs optional ChatGPT auth', () => {
    const planSignIn = {
      phase: 'blocked' as const,
      step: 'assistant' as const,
      code: 'plan_sign_in',
      since: 1
    }
    const agent = (principal: string, isDefault: boolean): MatrixAgentView => ({
      principal,
      userId: `@${principal}:test`,
      isDefault,
      ready: false,
      atumModel: false,
      hermes: 'unavailable',
      readiness: planSignIn
    })
    const allPlans = { ...base, readiness: planSignIn, agents: [agent('atum', true), agent('alfred', false)] }

    expect(matrixLaunchAgents(allPlans)).toEqual([])
    expect(matrixStartupBlocking(allPlans)).toBe(false)
    expect(matrixStartupBlocking({ ...base, readiness: planSignIn, agents: undefined })).toBe(false)

    const onePlan = {
      ...base,
      readiness: { phase: 'ready' as const, since: 1 },
      agents: [
        {
          ...agent('atum', true),
          ready: true,
          atumModel: true,
          hermes: 'ready' as const,
          readiness: { phase: 'ready' as const, since: 1 }
        },
        agent('alfred', false)
      ]
    }

    expect(matrixLaunchAgents(onePlan)).toEqual([])
    expect(matrixStartupBlocking(onePlan)).toBe(false)
  })

  it('opens through an AI outage, damaged assistant install, empty wallet, or assistant sign-in', () => {
    expect(matrixStartupBlocking(at('blocked', 'ai', 'ai_unavailable'))).toBe(false)
    expect(matrixStartupBlocking(at('blocked', 'ai', 'out_of_protons'))).toBe(false)
    expect(matrixStartupBlocking(at('blocked', 'hermes', 'runtime_invalid'))).toBe(false)
    expect(matrixStartupBlocking(at('blocked', 'ai', 'sign_in_required'))).toBe(false)
  })

  it('never interprets a roster read in progress or failure as an empty roster', () => {
    const ready = { ...base, readiness: { phase: 'ready' as const, since: 1 } }

    expect(matrixStartupBlocking({ ...ready, agentRoster: undefined })).toBe(true)
    expect(matrixStartupBlocking({ ...ready, agentRoster: { state: 'loading', since: 10 } })).toBe(true)
    expect(matrixStartupBlocking({ ...ready, agentRoster: { state: 'unavailable', since: 10 } })).toBe(false)
    expect(matrixStartupBlocking({ ...ready, agentRoster: { state: 'ready', since: 10 }, agents: [] })).toBe(false)
  })

  it('names every rostered assistant with its live state and elapsed wait', () => {
    vi.useFakeTimers()
    vi.setSystemTime(31_000)
    const onDone = vi.fn()
    const ready = { phase: 'ready' as const, since: 1_000 }
    const starting = { phase: 'starting' as const, step: 'hermes' as const, since: 1_000 }

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixStartupScreen
          onDone={onDone}
          snapshot={{
            ...base,
            readiness: ready,
            agentRoster: { state: 'ready', since: 1_000 },
            agents: [
              {
                principal: 'atum',
                userId: '@atum:test',
                name: 'Atum',
                isDefault: true,
                ready: true,
                atumModel: true,
                hermes: 'ready',
                readiness: ready
              },
              {
                principal: 'moon',
                userId: '@moon:test',
                name: 'Moon',
                isDefault: false,
                ready: false,
                atumModel: true,
                hermes: 'unavailable',
                readiness: starting
              }
            ]
          }}
        />
      </I18nProvider>
    )

    const roster = screen.getByRole('list', { name: 'Loading your assistants…' })
    expect(roster.textContent).toContain('AtumReady')
    expect(roster.textContent).toContain('MoonPreparing its workspace…30s')
    expect(onDone).not.toHaveBeenCalled()
  })

  it('stays in front for chats that cannot load and for the account steps that finish a sign-in', () => {
    expect(matrixStartupBlocking(at('blocked', 'signed_in', 'chat_unreachable'))).toBe(true)
    expect(matrixStartupBlocking(at('blocked', 'assistant', 'recovery_required'))).toBe(true)
    expect(matrixStartupBlocking(at('blocked', 'assistant', 'action_required'))).toBe(true)
  })
})

// 0.19.4 candidate 2: a Store hire left half-created by a failed purchase ("Nhà nghiên cứu") held
// every cold start on "couldn't finish a security check" while every real assistant was ready.
describe('every assistant follows the same launch rule', () => {
  afterEach(() => vi.useRealTimers())

  const readyNow = { phase: 'ready' as const, since: 1 }

  const view = (
    principal: string,
    readiness: MatrixReadiness,
    extra: Partial<MatrixAgentView> = {}
  ): MatrixAgentView => ({
    principal,
    userId: `@${principal}:test`,
    isDefault: principal === 'atum',
    ready: readiness.phase === 'ready',
    atumModel: true,
    hermes: readiness.phase === 'ready' ? 'ready' : 'unavailable',
    readiness,
    ...extra
  })

  const launch = (agents: MatrixAgentView[]): MatrixSnapshot => ({
    ...base,
    readiness: agents.find(agent => agent.isDefault)?.readiness,
    agents
  })

  const stopped = (code: string): MatrixReadiness => ({ phase: 'blocked', step: 'assistant', code, since: 1 })

  it('leaves the gate open when another agent fails, waits, or is still being set up', () => {
    for (const readiness of [
      stopped('agent_initializing'),
      stopped('agent_trust_failed'),
      { phase: 'starting' as const, step: 'assistant' as const, code: 'rate_limited', retryAt: 60_000, since: 1 },
      { phase: 'degraded' as const, step: 'ai' as const, code: 'ai_unavailable', since: 1 }
    ]) {
      const snapshot = launch([view('atum', readyNow), view('researcher', readiness)])

      expect(matrixLaunchAgents(snapshot)).toEqual([])
      expect(matrixStartupBlocking(snapshot)).toBe(false)
    }
  })

  it('reads a cloud-only primary as ready, even when its skipped local setup left a stale failure', () => {
    const cloud = view('atum', stopped('setup_failed'), {
      answering: 'cloud',
      ready: false,
      hermes: 'unavailable'
    })
    const snapshot = launch([cloud])

    expect(matrixLaunchAgentReadiness(cloud)).toEqual({ phase: 'ready', since: 1 })
    expect(matrixLaunchAgents(snapshot)).toEqual([])
    expect(matrixStartupBlocking(snapshot)).toBe(false)
  })

  it.each(['blocked', 'degraded'] as const)('does not hold for a %s primary', phase => {
    const stoppedPrimary: MatrixReadiness = {
      phase,
      step: phase === 'blocked' ? 'assistant' : 'ai',
      code: phase === 'blocked' ? 'agent_trust_failed' : 'ai_unavailable',
      since: 1
    }
    const snapshot = launch([view('atum', stoppedPrimary), view('researcher', readyNow)])

    expect(matrixStartupBlocking(snapshot)).toBe(false)
    expect(matrixLaunchAgents(snapshot)).toEqual([])
  })

  it('does not resurrect the old primary distinction when an older host has no known primary', () => {
    const snapshot = { ...launch([view('second', stopped('agent_trust_failed'))]), readiness: readyNow }

    expect(matrixStartupBlocking(snapshot)).toBe(false)
  })

  it('opens with the hire still being set up on its own row, without the security wording', async () => {
    vi.useFakeTimers()

    // The hire's real gate: its identity is never made, so its trust step keeps failing.
    const hire = new MatrixReadinessMonitor({
      gate: [{ step: 'assistant', check: async () => ({ ok: false as const, code: 'agent_initializing' }) }],
      watch: [],
      onChange: () => {},
      random: () => 0.5
    })

    hire.start()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(hire.current).toMatchObject({ phase: 'blocked', step: 'assistant', code: 'agent_initializing' })

    const onDone = vi.fn()

    const snapshot = launch([
      view('atum', readyNow, { name: 'Atum' }),
      view('researcher', hire.current, { name: 'Nhà nghiên cứu' }),
      // An older build's code for the same stop on another agent: plain words there too.
      view('analyst', stopped('agent_trust_failed'), { name: 'Analyst' })
    ])

    const draw = (shown: MatrixSnapshot) => (
      <I18nProvider configClient={null} initialLocale="vi">
        <MatrixStartupScreen onDone={onDone} snapshot={shown} />
      </I18nProvider>
    )

    // A cold start begins connecting; the hire's stop arrives once the chats are ready.
    const screenView = render(
      draw({ ...base, state: 'connecting', readiness: { phase: 'starting', step: 'signed_in', since: 1 } })
    )

    screenView.rerender(draw(snapshot))

    try {
      const roster = screen.getByRole('list', { name: 'Đang tải các trợ lý…' })
      expect(roster.textContent).toContain('Nhà nghiên cứuTrợ lý vẫn đang được thiết lập')
      expect(roster.textContent).toContain('AnalystTrợ lý vẫn đang được thiết lập')
      expect(screenView.container.textContent).not.toMatch(/bảo mật|xác minh|thiết bị|khóa/i)
      expect(screen.queryByRole('button', { name: 'Thử lại' })).toBeNull()

      // The window opens once the eclipse has had its moment, without the all-passed flash.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MATRIX_LAUNCH_HOLD_MS)
      })
      expect(screenView.container.querySelector('[data-phase="lit"]')).toBeNull()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100)
      })
      expect(onDone).toHaveBeenCalledOnce()
    } finally {
      hire.stop()
      screenView.unmount()
    }
  })

})

describe('recovery from a genuine account or chat launch gate', () => {
  const bridge = () => {
    const value = {
      command: vi.fn(async () => null),
      setupAssistant: vi.fn(async () => {}),
      retryReadiness: vi.fn(async () => {}),
      retry: vi.fn(async () => {}),
      signIn: vi.fn(async () => {}),
      signOut: vi.fn(async () => {}),
      cancelDomain: vi.fn(async () => {})
    }

    Object.defineProperty(window, 'atumMatrix', { configurable: true, value })

    return value
  }

  const draw = (snapshot: MatrixSnapshot, onDone = vi.fn()) =>
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixStartupScreen onDone={onDone} snapshot={snapshot} />
      </I18nProvider>
    )

  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'atumMatrix')
    Reflect.deleteProperty(window, 'atumDesktopServices')
    $matrixDesktopServices.set(null)
  })

  it('offers Try again, then feedback and sign out, but never opening a window with no chats', async () => {
    const native = bridge()
    window.atumDesktopServices = { feedback: vi.fn(async () => ({ sent: true })) } as never
    $matrixDesktopServices.set({
      busy: false,
      version: '1.0.0',
      reporting: { configured: true, diagnosticId: 'id', enabled: true },
      update: {
        channel: 'latest',
        progress: null,
        notes: [],
        error: null,
        requiredBelow: null,
        armed: true,
        packaged: true,
        state: 'idle',
        version: null,
        checkedAt: null
      }
    })

    const view = draw({
      ...base,
      readiness: { phase: 'blocked', step: 'signed_in', code: 'chat_unreachable', since: Date.now() }
    })

    expect(screen.queryByRole('button', { name: 'Open Atum anyway' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(native.retryReadiness).toHaveBeenCalledOnce()
    // The step that stopped stays listed, marked.
    const steps = view.container.querySelector('[data-slot="matrix-startup-steps"]')!
    expect(steps.querySelector('li[data-state="failed"]')?.textContent).toContain('Signing you in…')

    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
    expect(screen.getByRole('textbox', { name: 'Send feedback' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(screen.getByText('Sign out of Atum on this Mac?')).toBeTruthy()
    expect(native.signOut).not.toHaveBeenCalled()
    // The chat server is unreachable, so whether the account has a recovery key is unknown:
    // the warning's version.
    expect(screen.getByText(/Make sure you have your recovery key/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out anyway' }))
    await waitFor(() => expect(native.signOut).toHaveBeenCalledOnce())
  })

  it('asks a signed-out account to sign in again, and does so', () => {
    const native = bridge()

    draw({ ...base, readiness: { phase: 'blocked', step: 'signed_in', code: 'signed_out', since: Date.now() } })

    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    expect(native.signIn).toHaveBeenCalledOnce()
  })

  it('stops a saved account whose chats can’t be reached on the launch, with Try again and never a sign-in', async () => {
    const native = bridge()

    // The person's chat engine did not start: the account is still this Mac's.
    const view = draw({
      ...base,
      state: 'error',
      error: 'matrix_sdk_start_failed',
      readiness: { phase: 'starting', step: 'signed_in', since: Date.now() }
    })

    expect(view.container.querySelector('.atum-launch-sun')).not.toBeNull()
    // Its own engine did not start: not the network, and "still signed in" never reads as
    // still signing in.
    expect(screen.getByRole('heading', { name: 'Couldn’t open your chats' })).toBeTruthy()
    expect(
      screen.getByText('You’re still signed in on this Mac. Try again — if it keeps happening, send us feedback.')
    ).toBeTruthy()
    expect(screen.queryByText(/Check your connection/)).toBeNull()
    // No step to mark: "signing you in" would contradict the sentence.
    expect(view.container.querySelector('[data-slot="matrix-startup-steps"]')).toBeNull()
    // No way in to choose again: the account is signed in, it is the session that failed.
    expect(screen.queryByRole('button', { name: /Continue with/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open Atum anyway' })).toBeNull()

    // Try again starts the session over (main's retry), not the assistant's checks.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(native.retry).toHaveBeenCalledOnce())
    expect(native.retryReadiness).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
  })

  it('says a full disk is why the chats stopped on the launch, and that they come back by themselves', async () => {
    const native = bridge()

    draw({
      ...base,
      state: 'error',
      error: 'matrix_disk_full',
      readiness: { phase: 'starting', step: 'signed_in', since: Date.now() }
    })

    expect(screen.getByRole('heading', { name: 'Couldn’t open your chats' })).toBeTruthy()
    expect(screen.getByText('This Mac’s disk is full. Free up some space and Atum reconnects on its own.')).toBeTruthy()
    expect(screen.queryByText(/send us feedback/)).toBeNull()
    expect(screen.queryByText(/Check your connection/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(native.retry).toHaveBeenCalledOnce())
  })

  it('warns before signing out without a recovery key on the account', () => {
    bridge()

    draw({
      ...base,
      readiness: { phase: 'blocked', step: 'signed_in', code: 'chat_unreachable', since: Date.now() },
      security: { recovery: 'idle', storage: 'absent' }
    })

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(screen.getByText(/haven’t saved a recovery key/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign out anyway' })).toBeTruthy()
  })
})

describe('cold-start scope after assistant withdrawal', () => {
  it.each(['blocked', 'degraded'] as const)('opens through %s withdrawn execution', phase => {
    const snapshot: MatrixSnapshot = {
      ...base,
      readiness: { phase, step: 'authority', code: 'authority_withdrawn', since: 1 }
    }

    expect(matrixStartupBlocking(snapshot)).toBe(false)
    expect(matrixStartupBlocking({ ...snapshot, state: 'connecting' })).toBe(true)
    expect(snapshot.readiness?.phase).toBe(phase)
    expect(snapshot.readiness?.code).toBe('authority_withdrawn')
  })

  it.each(['offline', 'agent_trust_failed', 'platform_unavailable', 'setup_failed'])(
    'does not let assistant code %s hold launch',
    code => {
      expect(
        matrixStartupBlocking({
          ...base,
          readiness: { phase: 'blocked', step: 'assistant', code, since: 1 }
        })
      ).toBe(false)
    }
  )

  it('keeps signing in on its own window, never behind a launch plate', () => {
    for (const state of ['signed_out', 'signing_in'] as const) {
      expect(
        matrixStartupBlocking({
          ...base,
          state,
          readiness: { phase: 'blocked', code: 'authority_withdrawn', since: 1 }
        })
      ).toBe(false)
    }

    expect(matrixStartupBlocking({ ...base, identity: null })).toBe(false)
    expect(
      matrixStartupBlocking({
        ...base,
        readiness: { phase: 'starting', step: 'authority', code: 'authority_withdrawn', since: 1 }
      })
    ).toBe(false)
  })

  it('stops the launch for a saved account whose chats were never reachable, and only for that', () => {
    const failed: MatrixSnapshot = {
      ...base,
      state: 'error',
      error: 'matrix_sdk_start_failed',
      readiness: { phase: 'starting', step: 'signed_in', since: 1 }
    }

    expect(matrixLaunchUnreachable(failed)).toBe(true)
    expect(matrixStartupBlocking(failed)).toBe(true)
    // Builds without the readiness gate: an account in error has no chats either.
    expect(matrixLaunchUnreachable({ ...failed, readiness: undefined })).toBe(true)
    // Its chats were ready before the session broke: the window stays open with its notice.
    expect(matrixLaunchUnreachable({ ...failed, readiness: { phase: 'starting', step: 'hermes', since: 1 } })).toBe(
      false
    )
    expect(matrixStartupBlocking({ ...failed, readiness: { phase: 'ready', since: 1 } })).toBe(false)
    // A revoked session or an unfinished sign-out keeps its own handling.
    expect(matrixLaunchUnreachable({ ...failed, error: 'matrix_signed_out' })).toBe(false)
    expect(matrixLaunchUnreachable({ ...failed, error: 'matrix_sign_out_pending' })).toBe(false)
    // No account here at all: that is the sign-in window's to say.
    expect(matrixLaunchUnreachable({ ...failed, identity: null })).toBe(false)
  })

  it('releases a previously shown launch automatically when assistant authority is withdrawn', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const readiness = { phase: 'blocked' as const, step: 'authority' as const, code: 'authority_withdrawn', since: 1 }
    const onDone = vi.fn()

    const draw = (state: MatrixSnapshot['state']) => (
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixStartupScreen onDone={onDone} snapshot={{ ...base, state, readiness }} />
      </I18nProvider>
    )

    const view = render(draw('connecting'))
    expect(view.container.querySelector('[data-slot="matrix-startup"]')).not.toBeNull()
    expect(onDone).not.toHaveBeenCalled()
    expect($appViewOverlayCount.get()).toBe(1)

    view.rerender(draw('ready'))
    expect(view.container.querySelector('[data-phase="lit"]')).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MATRIX_LAUNCH_HOLD_MS)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100)
    })
    expect(onDone).toHaveBeenCalledOnce()
    expect(view.container.querySelector('[data-slot="matrix-startup"]')).toBeNull()
    expect(readiness.phase).toBe('blocked')
    view.unmount()
    expect($appViewOverlayCount.get()).toBe(0)
    vi.useRealTimers()
  })
})

describe('the account steps that finish a sign-in, on the launch in the product window', () => {
  const draw = (snapshot: MatrixSnapshot, onDone = vi.fn()) =>
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixStartupScreen onDone={onDone} snapshot={snapshot} />
      </I18nProvider>
    )

  const bridge = () => {
    const value = {
      command: vi.fn(async () => null),
      setupAssistant: vi.fn(() => new Promise<void>(() => {})),
      cancelDomain: vi.fn(async () => {}),
      retryReadiness: vi.fn(async () => {}),
      openTopUp: vi.fn(async () => {})
    }

    Object.defineProperty(window, 'atumMatrix', { configurable: true, value })

    return value
  }

  // Unmount first: the recovery panel forgets an unsent key through the bridge as it goes.
  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'atumMatrix')
  })

  it('names which account steps stop a launch, and nothing else', () => {
    const blocked = (code: string) => ({ ...base, readiness: { phase: 'blocked' as const, code, since: 1 } })

    expect(matrixLaunchAccountStep(blocked('action_required'))).toBe('connect')
    expect(matrixLaunchAccountStep(blocked('recovery_required'))).toBe('recovery')
    // The assistant's own device check is not the person's account: it waits in its chat.
    expect(matrixLaunchAccountStep(blocked('agent_trust_failed'))).toBeNull()
    expect(matrixLaunchAccountStep(blocked('offline'))).toBeNull()
    expect(
      matrixLaunchAccountStep({ ...base, readiness: { phase: 'starting', code: 'action_required', since: 1 } })
    ).toBeNull()
    expect(matrixLaunchAccountStep({ ...base, startup: { step: 'assistant', state: 'action_required' } })).toBe(
      'connect'
    )
    expect(matrixLaunchAccountStep({ ...blocked('recovery_required'), identity: null })).toBeNull()
  })

  it('asks for the key on a Mac whose account already has one: one field, one Unlock', async () => {
    const native = bridge()

    const view = draw({
      ...base,
      readiness: { phase: 'blocked', step: 'assistant', code: 'recovery_required', since: 1 },
      security: { recovery: 'idle', storage: 'present' }
    })

    // The launch itself, at its size: never the sign-in window's frame.
    expect(view.container.querySelector('[data-atum-auth]')).toBeNull()
    expect(view.container.querySelector('.atum-launch-sun')).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Unlock your messages on this Mac' })).toBeTruthy()
    expect(screen.getByText(/Approve this Mac from your other device, or enter your recovery key\./)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Set up recovery key' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Use my recovery key' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Recovery key'), { target: { value: 'synthetic-recovery' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    await waitFor(() =>
      expect(native.command).toHaveBeenCalledWith({ kind: 'recoveryRestore', key: 'synthetic-recovery' })
    )
  })

  it('keeps account recovery and its way out ahead of the optional Mac enrollment card', () => {
    bridge()

    draw({
      ...base,
      deviceControlRequired: true,
      readiness: { phase: 'blocked', step: 'assistant', code: 'recovery_required', since: 1 },
      security: { recovery: 'idle', storage: 'present' }
    })

    expect(screen.getByRole('heading', { name: 'Unlock your messages on this Mac' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
    expect(screen.queryByText('Let assistants use this Mac')).toBeNull()
  })

  it('makes the key on a first Mac: one Set up action, never a choice', () => {
    bridge()

    draw({
      ...base,
      readiness: { phase: 'blocked', step: 'assistant', code: 'recovery_required', since: 1 },
      security: { recovery: 'idle', storage: 'absent' }
    })

    expect(screen.getByRole('heading', { name: 'Save your recovery key' })).toBeTruthy()
    expect(screen.getByText('You’ll need it to read your messages on another Mac.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Set up recovery key' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Use my recovery key' })).toBeNull()
    expect(screen.queryByLabelText('Recovery key')).toBeNull()
  })

  it('says an unfinished Atum account in one sentence, retries it, and can stop waiting', () => {
    const native = bridge()

    const view = draw({
      ...base,
      readiness: { phase: 'blocked', step: 'assistant', code: 'action_required', since: 1 }
    })

    expect(screen.getByRole('heading', { name: 'Your Atum account didn’t finish connecting' })).toBeTruthy()
    expect(view.container.querySelector('.atum-launch-help')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(native.setupAssistant).toHaveBeenCalledOnce()
    expect((screen.getByRole('button', { name: 'Continue in your browser' }) as HTMLButtonElement).disabled).toBe(true)
    // While the browser is open, Cancel is the one way out.
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(native.cancelDomain).toHaveBeenCalledOnce()
  })
})

describe('the launch’s motion, at the product window’s size', () => {
  const draw = (snapshot: MatrixSnapshot, onDone: () => void) => (
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixStartupScreen onDone={onDone} snapshot={snapshot} />
    </I18nProvider>
  )

  const connecting: MatrixSnapshot = {
    ...base,
    state: 'connecting',
    readiness: { phase: 'starting', step: 'signed_in', since: 1 }
  }

  const preparing: MatrixSnapshot = { ...base, readiness: { phase: 'starting', step: 'assistant', since: 1 } }
  const chatsReady: MatrixSnapshot = {
    ...base,
    readiness: { phase: 'blocked', step: 'assistant', code: 'rate_limited', retryAt: 60_000, since: 1 }
  }
  const allReady: MatrixSnapshot = { ...base, readiness: { phase: 'ready', since: 1 } }
  const stage = (view: ReturnType<typeof render>) => view.container.querySelector('[data-slot="matrix-startup"]')
  const phase = (view: ReturnType<typeof render>) => stage(view)?.getAttribute('data-phase')
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('finishes without the all-passed flash when an assistant defers after chats are ready', async () => {
    vi.useFakeTimers()
    const onDone = vi.fn()
    const view = render(draw(connecting, onDone))

    expect(stage(view)?.hasAttribute('data-revealed')).toBe(true)
    expect(view.container.querySelector('.atum-launch-sun')).not.toBeNull()
    await advance(300)
    // The chats are ready almost at once (the SDK's cache): the launch stays, honestly.
    view.rerender(draw(preparing, onDone))
    await advance(1_000)
    expect(phase(view)).toBe('checking')
    const lines = [...view.container.querySelectorAll('.atum-launch-lines li')]
    expect(lines.map(line => [line.getAttribute('data-state'), line.textContent])).toEqual([
      ['done', 'Signed in'],
      ['current', 'Waking your assistant…']
    ])
    const bar = screen.getByRole('progressbar', { name: 'Opening Atum' })
    expect(Number(bar.getAttribute('aria-valuenow'))).toBeGreaterThan(0)
    expect(Number(bar.getAttribute('aria-valuenow'))).toBeLessThan(100)

    await advance(MATRIX_LAUNCH_HOLD_MS - 1_400)
    expect(phase(view)).toBe('checking')
    expect(onDone).not.toHaveBeenCalled()

    // A deferred platform retry belongs in the assistant's row/chat. Launch finishes its motion
    // without claiming that every check passed.
    view.rerender(draw(chatsReady, onDone))
    await advance(200)
    expect(phase(view)).toBe('leaving')
    expect(view.container.querySelector('[data-phase="lit"]')).toBeNull()
    expect(onDone).not.toHaveBeenCalled()
    await advance(1_100)
    expect(onDone).toHaveBeenCalledOnce()
    expect(stage(view)).toBeNull()
  })

  it('plays the whole finale, the ring’s flash and then the flight, when every check passed', async () => {
    vi.useFakeTimers()
    const onDone = vi.fn()
    const view = render(draw(connecting, onDone))

    view.rerender(draw(allReady, onDone))
    await advance(MATRIX_LAUNCH_HOLD_MS)
    expect(phase(view)).toBe('lit')
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100')
    await advance(550)
    expect(phase(view)).toBe('leaving')
    await advance(1_100)
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('keeps the app covered until the landing ends, then reveals it before unmounting', async () => {
    vi.useFakeTimers()
    const onDone = vi.fn()
    const view = render(draw(connecting, onDone))

    view.rerender(draw(allReady, onDone))
    await advance(MATRIX_LAUNCH_HOLD_MS)
    expect(phase(view)).toBe('lit')
    await advance(550)
    expect(phase(view)).toBe('leaving')

    // The fallback flight lasts 800 ms. The shell underneath remains covered for all of it.
    await advance(799)
    expect(stage(view)?.hasAttribute('data-revealing')).toBe(false)
    expect(onDone).not.toHaveBeenCalled()

    // Only the completed landing starts the cross-fade; the overlay stays through that fade.
    await advance(1)
    expect(stage(view)?.hasAttribute('data-revealing')).toBe(true)
    expect(onDone).not.toHaveBeenCalled()
    await advance(299)
    expect(stage(view)).not.toBeNull()
    expect(onDone).not.toHaveBeenCalled()
    await advance(1)
    expect(onDone).toHaveBeenCalledOnce()
    expect(stage(view)).toBeNull()
  })

  it('keeps reduced motion still and uses the same post-fade reveal boundary', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener() {},
      removeEventListener() {}
    }))
    const onDone = vi.fn()
    const view = render(draw(connecting, onDone))

    expect(stage(view)?.hasAttribute('data-reduced')).toBe(true)
    view.rerender(draw(allReady, onDone))
    await advance(900)
    expect(phase(view)).toBe('leaving')
    expect(stage(view)?.hasAttribute('data-revealing')).toBe(false)

    await advance(300)
    expect(stage(view)?.hasAttribute('data-revealing')).toBe(true)
    expect(onDone).not.toHaveBeenCalled()
    await advance(300)
    expect(onDone).toHaveBeenCalledOnce()
    expect(stage(view)).toBeNull()
  })

  it('opens as soon as every assistant is ready, once the eclipse has had its moment', async () => {
    vi.useFakeTimers()
    const onDone = vi.fn()
    const view = render(draw(connecting, onDone))

    await advance(MATRIX_LAUNCH_HOLD_MS + 4_000)
    expect(phase(view)).toBe('checking')
    expect(Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeLessThan(100)
    view.rerender(draw(allReady, onDone))
    await advance(0)
    expect(phase(view)).toBe('lit')
    await advance(550)
    expect(phase(view)).toBe('leaving')
  })

  it('draws the eclipse only once the window has grown out of the compact sign-in window', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('innerWidth', 460)
    const onDone = vi.fn()
    const view = render(draw(connecting, onDone))

    // The night covers the window at once; the eclipse waits for the product size.
    expect(stage(view)).not.toBeNull()
    expect(stage(view)?.hasAttribute('data-revealed')).toBe(false)
    await advance(200)
    vi.stubGlobal('innerWidth', 1220)
    act(() => void window.dispatchEvent(new Event('resize')))
    expect(stage(view)?.hasAttribute('data-revealed')).toBe(true)

    // Its moment counts from there.
    view.rerender(draw(allReady, onDone))
    await advance(MATRIX_LAUNCH_HOLD_MS - 100)
    expect(phase(view)).toBe('checking')
    await advance(200)
    expect(phase(view)).toBe('lit')
    await advance(550)
    expect(phase(view)).toBe('leaving')
  })

  it('lets a key or a click skip the rest of its moment once every assistant is ready, and not before', async () => {
    vi.useFakeTimers()
    const onDone = vi.fn()
    const view = render(draw(connecting, onDone))

    await advance(300)
    // Still waiting on the chats: nothing skips that.
    fireEvent.keyDown(window, { key: 'Escape' })
    await advance(0)
    expect(phase(view)).toBe('checking')

    view.rerender(draw(allReady, onDone))
    await advance(200)
    // A modifier alone is not a request to skip.
    fireEvent.keyDown(window, { key: 'Shift' })
    await advance(0)
    expect(phase(view)).toBe('checking')
    fireEvent.pointerDown(window)
    await advance(0)
    expect(phase(view)).toBe('lit')
    await advance(550)
    expect(phase(view)).toBe('leaving')
  })

  it('still draws its launch in a window that cannot grow', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('innerWidth', 460)
    const view = render(draw(connecting, vi.fn()))

    expect(stage(view)?.hasAttribute('data-revealed')).toBe(false)
    await advance(700)
    expect(stage(view)?.hasAttribute('data-revealed')).toBe(true)
  })
})
