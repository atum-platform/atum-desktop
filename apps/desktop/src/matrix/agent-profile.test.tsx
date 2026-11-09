import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixAgentView, MatrixUiBridge } from '../../shared/matrix'

import { NewAssistantButton, NewAssistantDialog } from './agent-roster'

const principal = '00000000-0000-4000-8000-bd7662a5eeb4'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

/** The roster's button and the dialog it opens, as MatrixRoster composes them. */
function NewAssistant({ onCreated }: { onCreated?(): void }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <NewAssistantButton onClick={() => setOpen(true)} />
      <NewAssistantDialog onCreated={onCreated} onOpenChange={setOpen} open={open} ready />
    </>
  )
}

it('does not hand an unmounted account a late created identity or navigate it into another account', async () => {
  let finish!: (result: { principal: string; roomId: string }) => void

  const createAgent = vi.fn<MatrixUiBridge['createAgent']>().mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )

  const onCreated = vi.fn()
  const command = vi.fn()
  window.atumMatrix = { createAgent, command } as unknown as MatrixUiBridge

  const view = render(
    <I18nProvider configClient={null} initialLocale="en">
      <NewAssistant onCreated={onCreated} />
    </I18nProvider>
  )

  fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Studio' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create assistant' }))
  view.unmount()
  finish({ principal, roomId: '!created:test' })
  await waitFor(() => expect(createAgent).toHaveBeenCalledOnce())
  expect(onCreated).not.toHaveBeenCalled()
  expect(command).not.toHaveBeenCalled()
})

it('refuses one of Atum’s own names before creating anything', async () => {
  const createAgent = vi.fn<MatrixUiBridge['createAgent']>()
  window.atumMatrix = { createAgent, command: vi.fn().mockResolvedValue(null) } as unknown as MatrixUiBridge

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <NewAssistant />
    </I18nProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'New assistant' }))
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Mòon' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create assistant' }))

  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(createAgent).not.toHaveBeenCalled()
})

it('refuses a name another of the owner’s assistants already has, or a look-alike of Atum’s, with the reason', async () => {
  const createAgent = vi.fn<MatrixUiBridge['createAgent']>()
  window.atumMatrix = { createAgent, command: vi.fn().mockResolvedValue(null) } as unknown as MatrixUiBridge
  const agents = [{ principal: 'agent-lan', name: 'Lan', isDefault: false }] as unknown as MatrixAgentView[]

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <NewAssistantDialog agents={agents} onOpenChange={() => {}} open ready />
    </I18nProvider>
  )
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'lan' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create assistant' }))
  expect((await screen.findByRole('alert')).textContent).toBe('You already have an assistant named lan.')

  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'AncIy' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create assistant' }))
  expect((await screen.findByRole('alert')).textContent).toBe('This name belongs to an Atum assistant.')

  // Another script's look-alike letter is refused by name, with what a name may use.
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: '\u0410ndy' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create assistant' }))
  expect((await screen.findByRole('alert')).textContent).toBe(
    "“\u0410” is from another alphabet. Names use Latin or Vietnamese letters, Chinese, Japanese, Korean, numbers, emoji and ' - . & ,"
  )
  expect(createAgent).not.toHaveBeenCalled()
})
