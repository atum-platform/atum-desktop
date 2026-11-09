import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixSnapshot, MatrixUiBridge } from '../../../shared/matrix'
import type { MatrixFounderContactResult } from '../../../shared/matrix-founder'
import { $matrixStoreDraft } from '../store/store-try'

import { createFounderDraft } from './founder-draft'
import { FounderDraftChat } from './founder-draft-chat'
import { $founderDraftOpen, closeFounderDraft, openFounderDraft } from './founder-store'

const OWNER = '@owner:test'
const FOUNDER = '@founder:test'

afterEach(() => {
  cleanup()
  closeFounderDraft()
  $matrixStoreDraft.set(null)
  Reflect.deleteProperty(window, 'atumMatrix')
})

function snapshot(): MatrixSnapshot {
  return {
    state: 'ready',
    identity: { userId: OWNER, deviceId: 'OWNER' },
    rooms: [],
    roomId: null,
    messages: [],
    error: null,
    founder: { userId: FOUNDER, verification: 'official', offer: true }
  }
}

function bridge(contact: () => Promise<MatrixFounderContactResult>) {
  const founder = { contact: vi.fn(contact) }
  const command = vi.fn(async () => null)
  window.atumMatrix = { command, founder } as unknown as MatrixUiBridge

  return { command, founder }
}

function inLocale(node: React.ReactNode) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      {node}
    </I18nProvider>
  )
}

describe('the Founder draft', () => {
  it('opens an empty chat and asks for nothing: no room, no invitation', () => {
    const ports = bridge(async () => ({ roomId: '!founder:test' }))

    inLocale(<FounderDraftChat snapshot={snapshot()} />)

    expect(window.document.querySelector('[data-founder-draft]')).toBeTruthy()
    expect(window.document.querySelector('[data-founder-intro]')).toBeTruthy()
    expect(ports.founder.contact).not.toHaveBeenCalled()
    expect(ports.command).not.toHaveBeenCalled()
  })

  it('makes the one chat on the first message and sends into it, then gives way', async () => {
    const ports = bridge(async () => ({ roomId: '!founder:test' }))
    openFounderDraft()

    inLocale(<FounderDraftChat snapshot={snapshot()} />)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(ports.command).toHaveBeenCalledTimes(1))
    expect(ports.founder.contact).toHaveBeenCalledTimes(1)
    expect(ports.command).toHaveBeenCalledWith({ kind: 'send', roomId: '!founder:test', body: 'Hello' })
    expect($founderDraftOpen.get()).toBe(false)
  })

  it('shares one creation between a rapid double send, and sends both messages into it', async () => {
    let answer!: (value: MatrixFounderContactResult) => void

    const contact = vi.fn(
      () =>
        new Promise<MatrixFounderContactResult>(resolve => {
          answer = resolve
        })
    )

    const sent: Array<[string, string]> = []

    const draft = createFounderDraft({
      contact,
      send: async (roomId, body) => {
        sent.push([roomId, body])
      }
    })

    const first = draft.send('one')
    const second = draft.send('two')
    answer({ roomId: '!founder:test' })

    await expect(first).resolves.toEqual({ outcome: 'sent' })
    await expect(second).resolves.toEqual({ outcome: 'sent' })
    expect(contact).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([
      ['!founder:test', 'one'],
      ['!founder:test', 'two']
    ])
  })

  it('sends nothing and says so when the chat cannot be made', async () => {
    const ports = bridge(async () => ({ unavailable: true }))

    inLocale(<FounderDraftChat snapshot={snapshot()} />)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(ports.command).not.toHaveBeenCalled()
    // The words stay in the draft for another try.
    expect(screen.getByRole('textbox')).toHaveProperty('value', 'Hello')
  })

  it('keeps the words for the real chat when the room is made but the send fails', async () => {
    const ports = bridge(async () => ({ roomId: '!founder:test' }))
    ports.command.mockRejectedValueOnce(new Error('offline'))
    openFounderDraft()

    inLocale(<FounderDraftChat snapshot={snapshot()} />)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect($matrixStoreDraft.get()).toEqual({ roomId: '!founder:test', text: 'Hello' }))
    // The chat exists now, so the draft gives way to it with the words waiting in its box.
    expect($founderDraftOpen.get()).toBe(false)
  })
})
