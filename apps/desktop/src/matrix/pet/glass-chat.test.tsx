import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { MatrixPetChatInput } from '../../../shared/matrix-pet'
import type { AtumPetChatReply, AtumPetChatTurn } from '../../../shared/pet-chat/atum-pet-chat'

import { PetGlassChat } from './glass-chat'

const ref = { kind: 'bundled' as const, slug: 'gigi' as const }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  window.document.body.innerHTML = ''
})

function anchor() {
  const host = window.document.createElement('main')
  host.dataset.petStage = ''
  const element = window.document.createElement('div')
  host.appendChild(element)
  window.document.body.appendChild(host)

  return element
}

function turn(role: 'user' | 'pet', text: string): AtumPetChatTurn {
  return { role, text, at: '2026-10-27T02:00:00.000Z' }
}

function reply(value: Partial<AtumPetChatReply> = {}): { ok: true; reply: AtumPetChatReply } {
  return {
    ok: true,
    reply: {
      v: 1,
      reply: 'Mình nghe nè.',
      action: null,
      recent: [turn('user', 'hello'), turn('pet', 'Mình nghe nè.')],
      messages_today: 2,
      daily_cap: 200,
      ...value
    }
  }
}

it('loads the pet own history on open and renders its newest turns', async () => {
  const history = vi.fn(async () => ({
    ok: true as const,
    history: {
      v: 1 as const,
      pet_key: 'bundled:gigi',
      display_name: 'Gigi',
      personality: 'Poised.',
      memory_summary: '',
      recent: [turn('user', 'are you hungry?'), turn('pet', 'Mình đói.')],
      messages_today: 1,
      daily_cap: 200 as const
    }
  }))

  render(<PetGlassChat anchor={anchor()} chatRef={ref} close={() => {}} history={history} name="Gigi" />)

  await waitFor(() => expect(screen.getByText('Mình đói.')).toBeTruthy())
  expect(screen.getByText('are you hungry?')).toBeTruthy()
  expect(history).toHaveBeenCalledExactlyOnceWith(ref)
})

function historyOf(recent: AtumPetChatTurn[]) {
  return {
    ok: true as const,
    history: {
      v: 1 as const,
      pet_key: 'bundled:gigi',
      display_name: 'Gigi',
      personality: 'Poised.',
      memory_summary: '',
      recent,
      messages_today: recent.length,
      daily_cap: 200 as const
    }
  }
}

function send(text: string) {
  const input = screen.getByRole('textbox', { name: 'Say hi to Gigi' })
  fireEvent.change(input, { target: { value: text } })
  fireEvent.submit(input.closest('form')!)

  return input as HTMLTextAreaElement
}

function shown(role: 'user' | 'pet') {
  return [...window.document.querySelectorAll(`[data-pet-turn="${role}"]`)].map(node => node.textContent)
}

it('sends one message with a fresh uuid, shows it at once and the pet thinking, then the answer', async () => {
  let accept: (value: ReturnType<typeof reply>) => void = () => {}
  const onAction = vi.fn()

  const chat = vi.fn(
    (_input: MatrixPetChatInput) =>
      new Promise<ReturnType<typeof reply>>(resolve => {
        accept = resolve
      })
  )

  render(<PetGlassChat anchor={anchor()} chat={chat} chatRef={ref} close={() => {}} name="Gigi" onAction={onAction} />)
  const input = send('  gigi sit  ')
  fireEvent.submit(input.closest('form')!)
  expect(chat).toHaveBeenCalledOnce()
  expect(chat.mock.calls[0]![0]).toMatchObject({ ref, locale: 'en', message: 'gigi sit' })
  expect(chat.mock.calls[0]![0].message_id).toMatch(UUID)
  // A regular chat: your words leave the box and sit in the thread while the pet thinks.
  expect(input.value).toBe('')
  expect(shown('user')).toEqual(['gigi sit'])
  expect(screen.getByRole('status', { name: 'Gigi is thinking…' })).toBeTruthy()
  await act(async () =>
    accept(reply({ action: { action: 'sit' }, recent: [turn('user', 'gigi sit'), turn('pet', 'Mình nghe nè.')] }))
  )
  expect(screen.queryByRole('status', { name: 'Gigi is thinking…' })).toBeNull()
  expect(shown('user')).toEqual(['gigi sit'])
  expect(shown('pet')).toEqual(['Mình nghe nè.'])
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: 'sit' })
})

it('shows the answer when the reply carries no history (a first chat, or the fallback)', async () => {
  const chat = vi.fn(async () => reply({ reply: 'Gâu! Mình ở đây.', recent: [] }))
  render(<PetGlassChat anchor={anchor()} chat={chat} chatRef={ref} close={() => {}} name="Gigi" />)
  send('hello')
  await waitFor(() => expect(shown('pet')).toEqual(['Gâu! Mình ở đây.']))
  expect(shown('user')).toEqual(['hello'])
  expect(screen.queryByRole('alert')).toBeNull()
})

it('shows the answer after the history could not load', async () => {
  const history = vi.fn(async () => {
    throw new Error('offline')
  })

  const chat = vi.fn(async () => reply({ reply: 'Mình nghe nè.', recent: [] }))
  render(<PetGlassChat anchor={anchor()} chat={chat} chatRef={ref} close={() => {}} history={history} name="Gigi" />)
  // No history is the empty chat, not an error; the box still talks.
  await waitFor(() => expect(screen.getByText('Gigi is listening.')).toBeTruthy())
  send('are you there?')
  await waitFor(() => expect(shown('pet')).toEqual(['Mình nghe nè.']))
  expect(shown('user')).toEqual(['are you there?'])
})

it('keeps an answer the history lags behind, and never shows a stored turn twice', async () => {
  const earlier = [turn('user', 'hi'), turn('pet', 'Chào!')]
  const now = () => new Date().toISOString()
  const history = vi.fn(async () => historyOf(earlier))

  const chat = vi
    .fn()
    // The history has not caught up with this answer yet.
    .mockResolvedValueOnce(reply({ reply: 'Mình đói.', recent: earlier }))
    // Now it holds both exchanges.
    .mockImplementationOnce(async () =>
      reply({
        reply: 'Ăn thôi!',
        recent: [
          ...earlier,
          { role: 'user', text: 'hungry?', at: now() },
          { role: 'pet', text: 'Mình đói.', at: now() },
          { role: 'user', text: 'dinner', at: now() },
          { role: 'pet', text: 'Ăn thôi!', at: now() }
        ]
      })
    )

  render(<PetGlassChat anchor={anchor()} chat={chat} chatRef={ref} close={() => {}} history={history} name="Gigi" />)
  await waitFor(() => expect(shown('pet')).toEqual(['Chào!']))
  send('hungry?')
  await waitFor(() => expect(shown('pet')).toEqual(['Chào!', 'Mình đói.']))
  send('dinner')
  await waitFor(() => expect(shown('pet')).toEqual(['Chào!', 'Mình đói.', 'Ăn thôi!']))
  expect(shown('user')).toEqual(['hi', 'hungry?', 'dinner'])
})

it('keeps a message that did not go through in the thread, with one short line and no cost or model copy', async () => {
  const chat = vi.fn(async () => ({ ok: false as const, code: 'insufficient_protons' as const }))
  render(<PetGlassChat anchor={anchor()} chat={chat} chatRef={ref} close={() => {}} name="Gigi" />)
  send('keep me')
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  expect(screen.getByRole('alert').textContent).toBe('Out of Protons.')
  expect(shown('user')).toEqual(['keep me'])
  // Retrying would only fail again: the next step is a top-up, offered when the app has one.
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  expect(window.document.body.textContent).not.toMatch(/model|cost|token/i)
})

it('turns a rate limit into one pet-voiced line, and Try again resends the same message id', async () => {
  const chat = vi
    .fn()
    .mockResolvedValueOnce({ ok: false as const, code: 'rate_limited' as const })
    .mockResolvedValueOnce(reply({ reply: 'Dậy rồi!', recent: [] }))

  render(<PetGlassChat anchor={anchor()} chat={chat} chatRef={ref} close={() => {}} name="Gigi" />)
  send('hello')
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Gigi is dozing. Try again in a moment.'))
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(shown('pet')).toEqual(['Dậy rồi!']))
  expect(chat).toHaveBeenCalledTimes(2)
  expect(chat.mock.calls[1]![0]).toEqual(chat.mock.calls[0]![0])
  expect(shown('user')).toEqual(['hello'])
  expect(screen.queryByRole('alert')).toBeNull()
})

it('says "Not sent." with Try again when the owner is no longer allowed, or the bridge throws', async () => {
  const chat = vi
    .fn()
    .mockResolvedValueOnce({ ok: false as const, code: 'forbidden' as const })
    .mockRejectedValueOnce(new Error('ipc'))

  render(<PetGlassChat anchor={anchor()} chat={chat} chatRef={ref} close={() => {}} name="Gigi" />)
  send('keep me')
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Not sent.'))
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /top up/i })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Gigi is dozing. Try again in a moment.'))
  expect(shown('user')).toEqual(['keep me'])
})

it('handles Escape only in glass and never steals focus during unrelated teardown', () => {
  const element = anchor()
  const composer = window.document.createElement('textarea')
  composer.dataset.slot = 'composer-rich-input'
  element.dataset.atumChat = ''
  element.appendChild(composer)
  const probe = window.document.createElement('input')
  window.document.body.appendChild(probe)
  const close = vi.fn()

  const view = render(
    <PetGlassChat anchor={element} chat={async () => reply()} chatRef={ref} close={close} name="Gigi" />
  )

  probe.focus()
  fireEvent.keyDown(probe, { key: 'Escape' })
  expect(close).not.toHaveBeenCalled()
  expect(window.document.activeElement).toBe(probe)
  const input = screen.getByRole('textbox', { name: 'Say hi to Gigi' })
  input.focus()
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(close).toHaveBeenCalledOnce()
  expect(window.document.activeElement).toBe(composer)
  probe.focus()
  view.unmount()
  expect(window.document.activeElement).toBe(probe)
})

it('has no available send without the companion chat bridge', () => {
  render(<PetGlassChat anchor={anchor()} chatRef={ref} close={() => {}} name="Gigi" />)
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
})

it('floats as the kit frosted popover, not the unblurred pet glass', () => {
  // Preserve user-visible identity, state and recovery behavior across connection changes.
  // just not over the top"). `.atum-pet-chat` is the kit's blurred strong glass; `.atum-pet-glass`
  // is the same tint with no blur.
  render(<PetGlassChat anchor={anchor()} chatRef={ref} close={() => {}} name="Gigi" />)

  const box = screen.getByRole('region', { name: 'Chat with Gigi' })

  expect(box.classList.contains('atum-pet-chat')).toBe(true)
  expect(box.classList.contains('atum-pet-glass')).toBe(false)
})
