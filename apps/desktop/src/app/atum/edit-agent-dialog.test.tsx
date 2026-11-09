import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as EditAgent from './edit-agent'

const editAtumAgent = vi.fn()
const loadAtumAgentInstructions = vi.fn()

vi.mock('./edit-agent', async importOriginal => ({
  ...(await importOriginal<typeof EditAgent>()),
  editAtumAgent,
  loadAtumAgentInstructions
}))

const { I18nProvider } = await import('@/i18n')
const { $atumAssistantDirectory } = await import('./assistant-directory')
const { AtumEditAgentDialog } = await import('./edit-agent-dialog')

const marketing = {
  avatar: '📣',
  description: '',
  id: 'marketing',
  identityId: '00000000-0000-4000-8000-50d86b120e98',
  lifecycleRevision: 1,
  isDefault: false,
  isManaged: true,
  pinned: false,
  title: 'Marketing'
}

function renderDialog(locale: 'en' | 'vi' = 'en', subject = marketing) {
  const onClose = vi.fn()

  const view = render(
    <I18nProvider configClient={null} initialLocale={locale}>
      {/* The pet field's browse affordance goes through the storefront opener,
          which needs the router the app always provides. */}
      <MemoryRouter>
        <AtumEditAgentDialog agent={subject} onClose={onClose} />
      </MemoryRouter>
    </I18nProvider>
  )

  return { ...view, onClose }
}

beforeEach(() => {
  $atumAssistantDirectory.set({ accountId: null, entries: [], state: 'empty' })
  editAtumAgent.mockReset().mockResolvedValue(undefined)
  loadAtumAgentInstructions.mockReset().mockResolvedValue({ job: 'Plans campaigns.', persona: 'Warm.' })
})

afterEach(cleanup)

describe('AtumEditAgentDialog', () => {
  it('starts from what the assistant is now and saves only what changed', async () => {
    const { onClose } = renderDialog()

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Marketing')
    expect(screen.queryByRole('radio')).toBeNull()
    await waitFor(() => expect((screen.getByLabelText('Who they are') as HTMLTextAreaElement).value).toBe('Warm.'))
    expect((screen.getByLabelText('What they do') as HTMLTextAreaElement).value).toBe('Plans campaigns.')

    // None of the engine's vocabulary appears.
    const text = globalThis.document.body.textContent ?? ''

    for (const noun of ['profile', 'Profile', 'model', 'Model', 'Hermes', 'SOUL']) {
      expect(text, `${noun} must not reach the person editing an assistant`).not.toContain(noun)
    }

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Growth' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(editAtumAgent).toHaveBeenCalledWith({ id: 'marketing', instructions: null, name: 'Growth' })
  })

  it('preserves a typed master name when the hosted directory changes', async () => {
    const entry = { id: 'hosted-master', identityId: marketing.identityId, isDefault: true,
      avatarUrl: null, displayName: 'Mai', lifecycleRevision: 1, status: 'active' as const }

    $atumAssistantDirectory.set({ accountId: 'account-a', entries: [entry], state: 'ready' })
    renderDialog('en', { ...marketing, id: 'default', title: '', isDefault: true })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My draft' } })
    act(() => $atumAssistantDirectory.set({ accountId: 'account-a', entries: [{ ...entry, displayName: 'Remote rename', lifecycleRevision: 2 }], state: 'ready' }))
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('My draft')
  })

  it('rewrites the instructions when an answer changed', async () => {
    renderDialog()
    await waitFor(() => expect((screen.getByLabelText('What they do') as HTMLTextAreaElement).value).toBe('Plans campaigns.'))

    fireEvent.change(screen.getByLabelText('What they do'), { target: { value: 'Plans launches.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(editAtumAgent).toHaveBeenCalledOnce())
    expect(editAtumAgent.mock.calls[0]![0]).toMatchObject({ instructions: { job: 'Plans launches.', persona: 'Warm.' } })
  })

  it('edits identity only when the instructions were written by hand', async () => {
    loadAtumAgentInstructions.mockResolvedValue(null)
    renderDialog()

    await screen.findByText('Its instructions were written by hand, so they are edited outside Atum.')
    expect(screen.queryByLabelText('Who they are')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(editAtumAgent).toHaveBeenCalledOnce())
    expect(editAtumAgent.mock.calls[0]![0]).toMatchObject({ instructions: null })
  })

  it('keeps the sheet open and says so when saving fails', async () => {
    editAtumAgent.mockRejectedValue(new Error('offline'))
    const { onClose } = renderDialog('vi')

    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }))

    expect((await screen.findByRole('alert')).textContent).toBe('Không lưu được thay đổi. Hãy thử lại.')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows a legacy overlong name as a rename-required state instead of trying to save it', async () => {
    renderDialog('en', { ...marketing, title: 'x'.repeat(41) })

    await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('x'.repeat(41)))
    expect((screen.getByLabelText('Name') as HTMLInputElement).maxLength).toBe(40)
    expect(screen.getByRole('alert').textContent).toBe('Shorten the name to 40 characters or fewer to register this assistant.')
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
    expect(editAtumAgent).not.toHaveBeenCalled()
  })
})
