import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixReadiness, MatrixSnapshot } from '../../shared/matrix'

import { ATUM_LINKS } from './atum-links'
import { MatrixLaunchNotice, matrixLaunchNoticeKind } from './launch-notice'

const base: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@owner:test', deviceId: 'D' },
  rooms: [],
  roomId: null,
  messages: [],
  error: null
}

function bridge() {
  const value = {
    command: vi.fn(async () => null),
    retryReadiness: vi.fn(async () => {}),
    setupAssistant: vi.fn(async () => {}),
    openTopUp: vi.fn(async () => {}),
    openLink: vi.fn(async () => {}),
    readDomain: vi.fn(async () => ({ issuer: 'i', subject: 's', principal: 'p' })),
    signIn: vi.fn(async () => {})
  }

  Object.defineProperty(window, 'atumMatrix', { configurable: true, value })

  return value
}

function draw(
  readiness: MatrixReadiness,
  extra: Partial<MatrixSnapshot> = {},
  props: {
    onBackToAtum?: () => Promise<unknown> | void
    onOwnModel?: () => void
    onPlanSignIn?: () => void
    variant?: 'band' | 'panel' | 'line'
  } = {}
) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixLaunchNotice name="Atum" snapshot={{ ...base, readiness, ...extra }} {...props} />
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('the assistant’s launch, in its own chat', () => {
  it.each(['line', 'panel'] as const)('opens account sign-in without a parent callback on the %s surface', async variant => {
    const native = bridge()
    let connected!: () => void
    const startChatGpt = vi.fn(() => new Promise<{ status: 'connected' }>(resolve => {
      connected = () => resolve({ status: 'connected' })
    }))

    Object.defineProperty(window, 'atumMatrix', { configurable: true, value: {
      ...native, subscriptions: { startChatGpt, pollChatGpt: vi.fn(), cancelChatGpt: vi.fn() }
    } })
    draw({ phase: 'blocked', step: 'ai', code: 'plan_sign_in', since: 1 }, {}, { variant })
    fireEvent.click(screen.getByRole('button', { name: 'Connect ChatGPT' }))
    await waitFor(() => expect(startChatGpt).toHaveBeenCalledOnce())
    expect(native.retryReadiness).not.toHaveBeenCalled()
    await act(async () => connected())
    await waitFor(() => expect(native.retryReadiness).toHaveBeenCalledOnce())
  })

  it('says nothing in its chat while the assistant starts as usual: the message box says it', () => {
    bridge()
    draw({ phase: 'starting', step: 'assistant', since: Date.now() })

    expect(screen.queryByText('Atum is getting ready…')).toBeNull()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('says nothing in its chat however long a start takes, in any step (no "getting ready" lines)', () => {
    bridge()

    for (const step of ['assistant', 'hermes', 'ai', 'authority'] as const) {
      const view = draw({ phase: 'starting', step, since: Date.now() - 5 * 60_000 })

      expect(window.document.querySelector('[data-matrix-launch-notice]')).toBeNull()
      expect(screen.queryByRole('progressbar')).toBeNull()
      view.unmount()
    }
  })

  it('still says a slow start where no chat is open yet, which step it is on, and how far along', () => {
    bridge()
    draw({ phase: 'starting', step: 'assistant', since: Date.now() - 31_000 }, {}, { variant: 'panel' })

    expect(screen.getByText('Atum is getting ready…')).toBeTruthy()
    expect(screen.getByText(/Waking your assistant…/)).toBeTruthy()
    const bar = screen.getByRole('progressbar', { name: 'Atum is getting ready…' })
    expect(Number(bar.getAttribute('aria-valuenow'))).toBeLessThan(100)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('names an AI outage plainly and retries the checks', () => {
    const native = bridge()
    draw({ phase: 'blocked', step: 'ai', code: 'ai_unavailable', since: 1 })

    expect(screen.getByText('Atum’s AI isn’t responding')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(native.retryReadiness).toHaveBeenCalledOnce()
  })

  it.each(['blocked', 'degraded'] as const)(
    'offers a top-up and a model of their own when %s out of Protons',
    phase => {
      const native = bridge()
      const onOwnModel = vi.fn()
      draw({ phase, step: 'ai', code: 'out_of_protons', since: 1 }, {}, { onOwnModel, variant: 'panel' })

      expect(screen.getByText("You're out of Protons.")).toBeTruthy()
      // What a Proton is and why it ran out, once, whether the launch stopped or only paused.
      expect(screen.getByText('Protons are what Atum spends to answer, and your free trial has run out.')).toBeTruthy()
      expect(screen.queryByText(/paused/i)).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Top up Protons' }))
      expect(native.openTopUp).toHaveBeenCalledOnce()
      fireEvent.click(screen.getByRole('button', { name: 'Use your own model' }))
      expect(onOwnModel).toHaveBeenCalledOnce()
      expect(screen.queryByRole('button', { name: 'About Protons' })).toBeNull()
    }
  )

  it('offers the latest Atum, never a retry, for a damaged install', () => {
    const native = bridge()
    draw({ phase: 'blocked', step: 'hermes', code: 'runtime_invalid', since: 1 }, {}, { variant: 'panel' })

    expect(screen.getByText('Part of Atum is missing on this Mac')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Download latest Atum' }))
    expect(native.openLink).toHaveBeenCalledWith(ATUM_LINKS.download)
  })

  it('signs in again through the Atum account when its AI no longer accepts it', async () => {
    const native = bridge()
    draw({ phase: 'blocked', step: 'ai', code: 'sign_in_required', since: 1 }, {}, { variant: 'panel' })

    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    expect(native.readDomain).toHaveBeenCalledOnce()
    await waitFor(() => expect(native.retryReadiness).toHaveBeenCalledOnce())
    expect(native.signIn).not.toHaveBeenCalled()
  })

  // 2026-10-05: withdrawn is no longer a dead end. Reconnect asks the platform for a new
  // executor on this Mac for exactly this chat's agent; the platform still decides.
  it('explains withdrawn permission and offers to reconnect this chat’s agent', async () => {
    const native = { ...bridge(), reconnectAgent: vi.fn(async () => {}) }
    Object.defineProperty(window, 'atumMatrix', { configurable: true, value: native })
    draw(
      { phase: 'blocked', step: 'authority', code: 'authority_withdrawn', since: 1 },
      {
        assistant: { userId: '@moon:test', deviceId: 'ATUM_AGENT_1' },
        agents: [
          {
            principal: 'agent-default',
            userId: '@atum:test',
            isDefault: true,
            ready: true,
            hermes: {},
            atumModel: true
          },
          { principal: 'agent-moon', userId: '@moon:test', isDefault: false, ready: false, hermes: {}, atumModel: true }
        ] as unknown as MatrixSnapshot['agents']
      }
    )

    expect(screen.getByText('This Mac can no longer run this assistant.')).toBeTruthy()
    expect(screen.getByText(/Reconnect to set it up on this Mac again/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(native.reconnectAgent).toHaveBeenCalledWith('agent-moon'))
    expect(native.retryReadiness).not.toHaveBeenCalled()
  })

  it('asks to connect ChatGPT without claiming why the native credential is unavailable', () => {
    const native = bridge()
    const onBackToAtum = vi.fn()
    const onPlanSignIn = vi.fn()
    draw(
      { phase: 'blocked', step: 'assistant', code: 'plan_sign_in', since: 1 },
      { assistantSetup: 'failed' },
      { onBackToAtum, onPlanSignIn }
    )

    expect(screen.getByText('Connect ChatGPT on this Mac')).toBeTruthy()
    expect(screen.getByText(/set to use your ChatGPT plan/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Connect ChatGPT' }))
    expect(onPlanSignIn).toHaveBeenCalledOnce()
    expect(onBackToAtum).not.toHaveBeenCalled()
    expect(native.retryReadiness).not.toHaveBeenCalled()
    expect(native.setupAssistant).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Switch back to Atum’s AI' }))
    expect(onBackToAtum).toHaveBeenCalledOnce()
  })

  it('shows an agent being reconnected as progress, with nothing to press', () => {
    bridge()
    draw({ phase: 'blocked', step: 'assistant', code: 'agent_reconnecting', since: 1 })

    expect(screen.getByText('Reconnecting…')).toBeTruthy()
    expect(screen.getByText(/setting your assistant up again on this Mac/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('signs out and in again, keeping the recovery key, when this Mac’s own device lost its keys', async () => {
    const native = { ...bridge(), signOut: vi.fn(async () => {}) }
    Object.defineProperty(window, 'atumMatrix', { configurable: true, value: native })
    draw({ phase: 'blocked', step: 'assistant', code: 'device_replaced', since: 1 }, {}, { variant: 'panel' })

    expect(screen.getByText('This device needs to be re-verified')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    await waitFor(() => expect(native.signIn).toHaveBeenCalledOnce())
    // Never "forget the key": signing in again must unlock by itself.
    expect(native.signOut).toHaveBeenCalledWith()
  })

  it('asks for the recovery key in the main panel when the window was opened past that step', () => {
    bridge()
    draw(
      { phase: 'blocked', step: 'assistant', code: 'recovery_required', since: 1 },
      { security: { recovery: 'idle', storage: 'present' } },
      { variant: 'panel' }
    )

    expect(screen.getByText('Unlock your assistant on this Mac')).toBeTruthy()
    expect(screen.getByLabelText('Recovery key')).toBeTruthy()
  })

  // 2026-10-06 check: a cause every agent shares is one item in the title bar's indicator; the
  // open chat says nothing more about it (its message box names it), never the same thing twice.
  it.each([
    ['blocked', 'assistant', 'recovery_required'],
    ['blocked', 'ai', 'out_of_protons'],
    ['degraded', 'ai', 'out_of_protons'],
    ['blocked', 'ai', 'sign_in_required'],
    ['blocked', 'hermes', 'runtime_invalid'],
    ['blocked', 'assistant', 'device_replaced'],
    ['blocked', 'assistant', 'action_required']
  ] as const)('says nothing in an open chat when %s on %s with %s, which the indicator holds', (phase, step, code) => {
    bridge()
    draw({ phase, step, code, since: 1 }, { security: { recovery: 'idle', storage: 'present' } })

    expect(window.document.querySelector('[data-matrix-launch-notice]')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says nothing in an open chat while its setup waits for one click the indicator holds', () => {
    bridge()
    draw(
      { phase: 'blocked', step: 'assistant', code: 'hermes_unavailable', since: 1 },
      { assistantSetup: 'action_required' }
    )

    expect(window.document.querySelector('[data-matrix-launch-notice]')).toBeNull()
  })

  it('leaves a setup waiting out a platform limit, and a ready assistant, to say nothing here', () => {
    expect(matrixLaunchNoticeKind({ phase: 'ready', since: 1 })).toBeNull()
    expect(
      matrixLaunchNoticeKind({ phase: 'starting', step: 'assistant', code: 'rate_limited', retryAt: 60_000, since: 1 })
    ).toBeNull()
    expect(matrixLaunchNoticeKind(undefined)).toBeNull()
    expect(matrixLaunchNoticeKind({ phase: 'starting', step: 'hermes', since: 1 })).toBe('starting')
  })

  it('stands in for "No chat open" while the assistant starts, saying the chats are ready', () => {
    bridge()
    draw({ phase: 'starting', step: 'hermes', since: Date.now() }, {}, { variant: 'panel' })

    expect(screen.getByText('Atum is getting ready…')).toBeTruthy()
    expect(screen.getByText('Your chats are ready. Your assistant will be in a moment.')).toBeTruthy()
  })
})
