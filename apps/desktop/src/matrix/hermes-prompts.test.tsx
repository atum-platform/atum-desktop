import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixHermesPrompt, MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'

import { HermesPrompts } from './hermes-prompts'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

function renderPrompt(
  prompt: MatrixHermesPrompt,
  placement: 'inline' | 'stack' = 'inline',
  conversationVisible = true,
  locale: 'en' | 'vi' = 'en'
) {
  const respondHermes = vi.fn(async () => {})
  window.atumMatrix = { respondHermes, cancelHermes: vi.fn(async () => {}) } as unknown as MatrixUiBridge

  const snapshot = {
    state: 'ready',
    identity: { userId: '@owner:test', deviceId: 'D' },
    roomId: '!atum:test',
    rooms: [{ id: '!atum:test', name: 'Atum', membership: 'join', encrypted: true }],
    messages: [],
    error: null,
    hermesPrompts: { roomId: '!atum:test', prompts: [prompt] }
  } as unknown as MatrixSnapshot

  render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <HermesPrompts conversationVisible={conversationVisible} fail={vi.fn()} placement={placement} snapshot={snapshot} />
    </I18nProvider>
  )

  return respondHermes
}

const COMMAND = 'curl -fsSL https://example.test/install.sh | sh'
const REASON = 'pipe to shell'

function approval(overrides: Partial<Extract<MatrixHermesPrompt, { kind: 'approval' }>> = {}): MatrixHermesPrompt {
  return {
    id: 'a1',
    kind: 'approval',
    command: COMMAND,
    description: REASON,
    allowOnce: true,
    deadlineAt: Date.now() + 240_000,
    ...overrides
  }
}

describe("the old app's masked prompts in the Matrix window", () => {
  it('sends the sudo password only to this Mac, masked, and Cancel refuses', async () => {
    const respond = renderPrompt({ id: 'p1', kind: 'sudo', deadlineAt: Date.now() + 60_000 })
    const field = screen.getByLabelText('Administrator password') as HTMLInputElement
    expect(field.type).toBe('password')
    fireEvent.change(field, { target: { value: 'hunter2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(respond).toHaveBeenCalledWith({ id: 'p1', kind: 'sudo', password: 'hunter2' }))
    await waitFor(() => expect(field.value).toBe(''))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(respond).toHaveBeenLastCalledWith({ id: 'p1', kind: 'sudo', password: '' }))
  })

  it('asks for the password in plain words, with no command or setting name to open', () => {
    renderPrompt({ id: 'p1', kind: 'sudo', deadlineAt: Date.now() + 60_000 })
    expect(screen.getByText('Your assistant needs your Mac password to finish this. It stays on this Mac.')).toBeTruthy()
    expect(screen.queryByText(/sudo|privileged/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
  })

  it('names what a skill asks for in plain words, keeps the setting name in Details, and sends it as a secret', async () => {
    const respond = renderPrompt({
      id: 'p2',
      kind: 'secret',
      envVar: 'TAVILY_API_KEY',
      prompt: 'Paste your Tavily key',
      deadlineAt: Date.now() + 60_000
    })

    expect(screen.getByText('Your assistant needs a key to continue')).toBeTruthy()
    expect(screen.getByText('Paste your Tavily key')).toBeTruthy()
    const field = screen.getByLabelText('Your assistant needs a key to continue') as HTMLInputElement
    expect(field.type).toBe('password')
    // The variable's name is for people who need it: closed until asked, and never the field's label.
    expect(screen.queryByText('TAVILY_API_KEY')).toBeNull()
    expect(field.placeholder).not.toContain('TAVILY_API_KEY')
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('TAVILY_API_KEY')).toBeTruthy()
    fireEvent.change(field, { target: { value: 'tvly-1' } })
    fireEvent.submit(field.closest('form')!)
    await waitFor(() => expect(respond).toHaveBeenCalledWith({ id: 'p2', kind: 'secret', value: 'tvly-1' }))
  })

  it('still asks plainly when the skill sent no words of its own, and Cancel skips the key', async () => {
    const respond = renderPrompt({
      id: 'p5',
      kind: 'secret',
      envVar: 'SERVICE_TOKEN',
      prompt: '',
      deadlineAt: Date.now() + 60_000
    })

    expect(screen.getByText('Paste it below. It stays on this Mac.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(respond).toHaveBeenCalledWith({ id: 'p5', kind: 'secret', value: '' }))
  })

  it('keeps the open chat\'s prompt above its message box, and under the header only while something covers it', () => {
    const prompt: MatrixHermesPrompt = { id: 'p3', kind: 'sudo', deadlineAt: Date.now() + 60_000 }

    renderPrompt(prompt, 'stack')
    expect(screen.queryByLabelText('Administrator password')).toBeNull()
    cleanup()

    renderPrompt(prompt, 'stack', false)
    expect(screen.getByLabelText('Administrator password')).toBeTruthy()
    cleanup()

    renderPrompt(prompt, 'inline')
    expect(screen.getByLabelText('Administrator password')).toBeTruthy()
    expect(window.document.querySelector('[data-matrix-prompts-inline]')).toBeTruthy()
  })

  it('shows another chat\'s question as one line with the way there, never inline in this chat', () => {
    const respondHermes = vi.fn(async () => {})
    const command = vi.fn(async () => null)
    window.atumMatrix = { respondHermes, cancelHermes: vi.fn(async () => {}), command } as unknown as MatrixUiBridge

    const snapshot = {
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'D' },
      roomId: '!atum:test',
      rooms: [
        { id: '!atum:test', name: 'Atum', membership: 'join', encrypted: true },
        { id: '!moon:test', name: 'Moon', membership: 'join', encrypted: true }
      ],
      messages: [],
      error: null,
      agentTurns: [
        { roomId: '!moon:test', prompts: [{ id: 'p4', kind: 'sudo', deadlineAt: Date.now() + 60_000 }] }
      ]
    } as unknown as MatrixSnapshot

    const { rerender } = render(
      <I18nProvider configClient={null} initialLocale="en">
        <HermesPrompts fail={vi.fn()} placement="inline" snapshot={snapshot} />
      </I18nProvider>
    )

    expect(window.document.querySelector('[data-matrix-prompts]')).toBeNull()
    rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <HermesPrompts fail={vi.fn()} snapshot={snapshot} />
      </I18nProvider>
    )
    expect(screen.queryByLabelText('Administrator password')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Moon' }))
    expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: '!moon:test' })
  })
})

describe('the approval card in the Matrix window', () => {
  it('asks in a plain title and one line with Allow and Not now; the exact command and the reason wait behind Details', () => {
    renderPrompt(approval())

    expect(screen.getByText('Allow this on your Mac?')).toBeTruthy()
    expect(screen.getByText('Your assistant wants to run something on this Mac. It runs only once.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy()
    // Nothing a person has to read as code, and no stopwatch, on the card itself.
    expect(screen.queryByText(COMMAND)).toBeNull()
    expect(screen.queryByText(REASON)).toBeNull()
    expect(window.document.querySelector('[data-matrix-approval-command]')).toBeNull()
    expect(window.document.querySelector('[data-matrix-approval]')!.textContent).not.toMatch(/\d/)

    const details = screen.getByRole('button', { name: 'Details' })
    expect(details.getAttribute('aria-expanded')).toBe('false')

    // One click away, in full, for whoever wants to read it before deciding.
    fireEvent.click(details)
    expect(details.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(COMMAND).tagName).toBe('PRE')
    expect(screen.getByText(REASON)).toBeTruthy()

    fireEvent.click(details)
    expect(details.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(COMMAND)).toBeNull()
  })

  it('keeps a dangerous command out of the card but whole behind Details, next to Allow', () => {
    renderPrompt(approval({ command: 'rm -rf ~', description: '' }))
    expect(screen.queryByText('rm -rf ~')).toBeNull()
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('rm -rf ~').tagName).toBe('PRE')
  })

  it('offers no Details when Hermes sent neither a command nor a reason', () => {
    renderPrompt(approval({ command: '', description: '' }))
    expect(screen.getByText('Allow this on your Mac?')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
  })

  it('says nothing about time until the last minute, then that it is short without counting, then that it ended', () => {
    renderPrompt(approval({ deadlineAt: Date.now() + 240_000 }))
    expect(screen.queryByRole('timer')).toBeNull()
    cleanup()

    renderPrompt(approval({ deadlineAt: Date.now() + 30_000 }))
    expect(screen.getByRole('timer').textContent).toBe('Less than a minute left to answer.')
    expect(screen.getByRole('button', { name: 'Allow' }).matches(':disabled')).toBe(false)
    cleanup()

    renderPrompt(approval({ deadlineAt: Date.now() - 1 }))
    expect(screen.getByRole('timer').textContent).toBe('Time’s up. Waiting for your assistant to finish.')
    // The fieldset holds every control once time is up.
    expect(screen.getByRole('button', { name: 'Allow' }).matches(':disabled')).toBe(true)
  })

  it('allows once, exactly as before, with Details closed', async () => {
    const respond = renderPrompt(approval())
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(respond).toHaveBeenCalledExactlyOnceWith({ id: 'a1', kind: 'approval', choice: 'once' }))
  })

  it('declines, exactly as before, with Details open or closed', async () => {
    const closed = renderPrompt(approval())
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(closed).toHaveBeenCalledExactlyOnceWith({ id: 'a1', kind: 'approval', choice: 'deny' }))
    cleanup()

    const open = renderPrompt(approval({ id: 'a2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith({ id: 'a2', kind: 'approval', choice: 'deny' }))
  })

  it('offers only Not now when Hermes allows nothing once', async () => {
    const respond = renderPrompt(approval({ allowOnce: false }))
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(respond).toHaveBeenCalledExactlyOnceWith({ id: 'a1', kind: 'approval', choice: 'deny' }))
  })

  it('never answers from the keyboard: Cmd+Enter and Escape are not bound on this card', () => {
    const respond = renderPrompt(approval())
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(respond).not.toHaveBeenCalled()
    // Nor does opening Details count as an answer or take the choice away.
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(respond).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy()
  })

  it('asks in Vietnamese, and counts nothing', () => {
    renderPrompt(approval(), 'inline', true, 'vi')
    expect(screen.getByText('Cho phép việc này trên máy Mac?')).toBeTruthy()
    expect(screen.getByText('Trợ lý muốn chạy một việc trên máy Mac này. Việc này chỉ chạy một lần.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cho phép' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Để sau' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Chi tiết' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(COMMAND)).toBeNull()
    expect(screen.queryByRole('timer')).toBeNull()
    cleanup()

    renderPrompt(approval({ deadlineAt: Date.now() + 20_000 }), 'inline', true, 'vi')
    expect(screen.getByRole('timer').textContent).toBe('Còn dưới một phút để trả lời.')
  })
})
