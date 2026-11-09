import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FREE } from '@/lib/atum-price'
import type * as PetGallery from '@/store/pet-gallery'
import type * as ProfileStore from '@/store/profile'

import type * as Agents from './agents'
import type * as AssistantDirectory from './assistant-directory'
import type * as CreateAgent from './create-agent'
import type * as RegisterAgents from './register-agents'

const createAtumAgent = vi.fn()
const newSessionInProfile = vi.fn()
const captureAtumAssistantDirectoryScope = vi.fn()
const isAtumAssistantDirectoryScopeCurrent = vi.fn()
const registerAtumAgents = vi.fn()
const adoptPetFor = vi.fn()
const loadPetGallery = vi.fn()
const loadPetThumb = vi.fn()
const refreshPetInfoFor = vi.fn()

vi.mock('./create-agent', async importOriginal => ({
  ...(await importOriginal<typeof CreateAgent>()),
  createAtumAgent
}))

vi.mock('@/store/profile', async importOriginal => ({
  ...(await importOriginal<typeof ProfileStore>()),
  newSessionInProfile
}))

vi.mock('./assistant-directory', async importOriginal => ({
  ...(await importOriginal<typeof AssistantDirectory>()),
  captureAtumAssistantDirectoryScope,
  isAtumAssistantDirectoryScopeCurrent
}))

vi.mock('@/store/pet-gallery', async importOriginal => ({
  ...(await importOriginal<typeof PetGallery>()),
  adoptPetFor,
  loadPetGallery,
  loadPetThumb,
  refreshPetInfoFor
}))

vi.mock('./register-agents', async importOriginal => ({
  ...(await importOriginal<typeof RegisterAgents>()),
  registerAtumAgents
}))

vi.mock('./agents', async importOriginal => ({
  ...(await importOriginal<typeof Agents>()),
  $atumAgents: atom([
    {
      id: 'default',
      identityId: '',
      lifecycleRevision: 0,
      title: '',
      avatar: '',
      description: '',
      isDefault: true,
      isManaged: true,
      pinned: false
    }
  ])
}))

const { I18nProvider } = await import('@/i18n')
const { $petGallery, $petGalleryStatus } = await import('@/store/pet-gallery')
const { $gatewayState } = await import('@/store/session')
const { AtumCreateAgentDialog } = await import('./create-agent-dialog')

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

function renderDialog(locale: 'en' | 'vi' = 'en') {
  const onOpenChange = vi.fn()

  const view = render(
    <MemoryRouter initialEntries={['/somewhere']}>
      <I18nProvider configClient={null} initialLocale={locale}>
        <AtumCreateAgentDialog onOpenChange={onOpenChange} open />
        <LocationProbe />
      </I18nProvider>
    </MemoryRouter>
  )

  return { ...view, onOpenChange }
}

beforeEach(() => {
  cleanup()
  createAtumAgent.mockReset()
  newSessionInProfile.mockReset()
  captureAtumAssistantDirectoryScope.mockReset().mockReturnValue({ accountId: 'account-a', generation: 1 })
  isAtumAssistantDirectoryScopeCurrent.mockReset().mockReturnValue(true)
  registerAtumAgents.mockReset().mockResolvedValue({})
  adoptPetFor.mockReset().mockResolvedValue(true)
  loadPetGallery.mockReset().mockResolvedValue(undefined)
  loadPetThumb.mockReset().mockResolvedValue(null)
  refreshPetInfoFor.mockReset().mockResolvedValue(undefined)
  $gatewayState.set('open')
  $petGalleryStatus.set('ready')
  $petGallery.set({
    active: '',
    enabled: false,
    pets: [{ displayName: 'Gigi', installed: true, price: FREE, slug: 'gigi' }]
  })
})

afterEach(cleanup)

describe('AtumCreateAgentDialog', () => {
  it('asks for three things and nothing about profiles, models, or folders', () => {
    renderDialog()

    expect(screen.getByLabelText('Name')).toBeTruthy()
    expect(screen.getByLabelText('Who they are')).toBeTruthy()
    expect(screen.getByLabelText('What they do')).toBeTruthy()

    // Everything else is derived. None of the engine's vocabulary appears.
    const text = document.body.textContent ?? ''

    for (const noun of ['profile', 'Profile', 'model', 'Model', 'workspace', 'Workspace', 'Hermes', 'approval']) {
      expect(text, `${noun} must not reach the person making an assistant`).not.toContain(noun)
    }
  })

  it('gives the new assistant the pet that was picked for it', async () => {
    // The pet can only be adopted once the profile exists, so the id it is
    // addressed to comes from the creation call — not from anything on screen.
    createAtumAgent.mockResolvedValueOnce({ id: 'tro-ly-marketing' })
    renderDialog()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Trợ lý Marketing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Choose a pet' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Gigi/u })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Gigi/u }))

    expect(adoptPetFor, 'the assistant does not exist yet — nothing to adopt for').not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(adoptPetFor).toHaveBeenCalledWith(expect.anything(), 'gigi', 'tro-ly-marketing', expect.any(String))
    )
  })

  it('creates the agent and lands the user in a chat with it', async () => {
    createAtumAgent.mockResolvedValueOnce({ id: 'tro-ly-marketing' })
    const { onOpenChange } = renderDialog()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Trợ lý Marketing' } })
    fireEvent.change(screen.getByLabelText('Who they are'), { target: { value: 'Warm.' } })
    fireEvent.change(screen.getByLabelText('What they do'), { target: { value: 'Plans campaigns.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(createAtumAgent).toHaveBeenCalledOnce())
    expect(createAtumAgent.mock.calls[0]![0]).toMatchObject({
      job: 'Plans campaigns.',
      name: 'Trợ lý Marketing',
      persona: 'Warm.'
    })

    // Straight into a chat with the assistant that was just made.
    await waitFor(() => expect(newSessionInProfile).toHaveBeenCalledWith('tro-ly-marketing'))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('will not submit without a name, and never calls the backend', () => {
    renderDialog()

    expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(true)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(true)
    expect(createAtumAgent).not.toHaveBeenCalled()
  })

  it('uses the registration limit and will not submit a longer programmatic value', () => {
    renderDialog()
    const input = screen.getByLabelText('Name') as HTMLInputElement

    expect(input.maxLength).toBe(40)
    fireEvent.change(input, { target: { value: 'x'.repeat(41) } })
    expect(screen.getByRole('alert').textContent).toBe('Shorten the name to 40 characters or fewer to register this assistant.')
    expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(true)
    expect(createAtumAgent).not.toHaveBeenCalled()
  })

  it('an assistant with only a name is allowed: instructions can come later', async () => {
    createAtumAgent.mockResolvedValueOnce({ id: 'alfred' })
    renderDialog()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Alfred' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(createAtumAgent).toHaveBeenCalledOnce())
    expect(createAtumAgent.mock.calls[0]![0]).toMatchObject({ job: '', name: 'Alfred', persona: '' })
  })

  it('says so when creation fails, keeps what was typed, and stays open', async () => {
    createAtumAgent.mockRejectedValueOnce(new Error('profile exists'))
    const { onOpenChange } = renderDialog()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Marketing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/Couldn't create the assistant/)).toBeTruthy()
    // The user's typing survives so they can retry without redoing the form.
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Marketing')
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(newSessionInProfile).not.toHaveBeenCalled()
  })

  it('does not retarget a deferred local creation after the account changes', async () => {
    let release!: (value: { id: string }) => void
    createAtumAgent.mockImplementationOnce(() => new Promise(resolve => {
      release = resolve
    }))
    const { onOpenChange } = renderDialog()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Marketing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    isAtumAssistantDirectoryScopeCurrent.mockReturnValue(false)
    release({ id: 'marketing' })

    await screen.findByRole('alert')
    expect(registerAtumAgents).not.toHaveBeenCalled()
    expect(newSessionInProfile).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect((screen.getByLabelText('Name') as HTMLInputElement).disabled).toBe(true)
  })

  it('creates with no preset symbol; a photo is optional', async () => {
    createAtumAgent.mockResolvedValueOnce({ id: 'mkt' })
    renderDialog()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Marketing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(createAtumAgent).toHaveBeenCalledOnce())
    expect(createAtumAgent.mock.calls[0]![0].avatar).toBe('')
    expect(screen.queryByRole('radio')).toBeNull()
  })

  it('shows the public/private switch disabled and says public is coming, and never sends it', async () => {
    // Owner decision: the switch states the direction without promising the
    // capability. It must be visibly off, unreachable, and absent from what
    // is sent to the backend.
    createAtumAgent.mockResolvedValueOnce({ id: 'mkt' })
    renderDialog()

    const toggle = screen.getByRole('switch', { name: 'Who can reach them' })

    expect(toggle.hasAttribute('disabled')).toBe(true)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('Only you')).toBeTruthy()
    expect(screen.getByText(/coming soon/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Marketing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(createAtumAgent).toHaveBeenCalledOnce())
    expect(Object.keys(createAtumAgent.mock.calls[0]![0])).not.toContain('visibility')
  })

  it('speaks Vietnamese, including the example name', () => {
    renderDialog('vi')

    expect(screen.getByText('Trợ lý mới')).toBeTruthy()
    expect(screen.getByLabelText('Tên')).toBeTruthy()
    expect(screen.getByPlaceholderText('Tiếp thị')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Hermes/iu)
  })
})
