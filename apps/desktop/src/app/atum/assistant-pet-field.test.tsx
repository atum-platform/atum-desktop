import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FREE } from '@/lib/atum-price'
import type { AtumStoreCatalogWire, AtumStoreItemWire } from '@/lib/atum-store-items'
import type * as PetGallery from '@/store/pet-gallery'

import type * as AssistantDirectory from './assistant-directory'
import type * as EditAgent from './edit-agent'

/**
 * The pet picker in the assistant editor.
 *
 * The contract that matters is that the choice is *staged*: the sheet has a
 * Cancel button, so a picker that adopted on click would leave the assistant's
 * pet changed after the person backed out — the one outcome the button promises
 * will not happen.
 */

const editAtumAgent = vi.fn()
const loadAtumAgentInstructions = vi.fn()
const adoptPetFor = vi.fn()
const renameAtumMasterAssistant = vi.fn()
const loadPetGallery = vi.fn()
const loadPetThumb = vi.fn()
const refreshPetInfoFor = vi.fn()

vi.mock('./edit-agent', async importOriginal => ({
  ...(await importOriginal<typeof EditAgent>()),
  editAtumAgent,
  loadAtumAgentInstructions
}))

vi.mock('./assistant-directory', async importOriginal => ({
  ...(await importOriginal<typeof AssistantDirectory>()),
  renameAtumMasterAssistant
}))

vi.mock('@/store/pet-gallery', async importOriginal => ({
  ...(await importOriginal<typeof PetGallery>()),
  adoptPetFor,
  loadPetGallery,
  loadPetThumb,
  refreshPetInfoFor
}))

const { I18nProvider } = await import('@/i18n')
const { $atumAssistantDirectory } = await import('./assistant-directory')
const { $discoverShelf, $railDestination, resetAtumShellState } = await import('@/store/atum-shell')
const { $atumStoreCatalog, clearAtumStoreCatalog } = await import('@/store/atum-store-catalog')
const { $petGallery, $petGalleryStatus } = await import('@/store/pet-gallery')
const { $petInfoByAgent } = await import('@/store/pet')
const { $gatewayState } = await import('@/store/session')
const { AtumEditAgentDialog } = await import('./edit-agent-dialog')
const { AtumAssistantPetField } = await import('./assistant-pet-field')

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

/** A store catalog row claiming one gallery pet by slug. */
const catalogPet = (id: string, slug: string, priceProtons: number): AtumStoreItemWire => ({
  accent: 'var(--atum-sunk)',
  detail: { description: { en: 'Pet', vi: 'Thú cưng' }, needs: [], try_prompt: { en: 'Try', vi: 'Thử' } },
  featured: true,
  glyph: '🐾',
  hashes: [],
  id,
  kind: 'pet',
  offer: { id: '00000000-0000-4000-8000-a28c50c0e7e8', price_protons: priceProtons, version: 1 },
  sort_order: 1,
  source: { slug, type: 'bundled' },
  summary: { en: 'Pet', vi: 'Thú cưng' },
  title: { en: 'Pet', vi: 'Thú cưng' }
})

const catalogWithPet = (items: AtumStoreItemWire[]): AtumStoreCatalogWire => ({
  available_protons: 0,
  entitlements: [],
  items
})

function renderDialog() {
  const onClose = vi.fn()

  const view = render(
    <I18nProvider configClient={null} initialLocale="en">
      {/* The pet field's browse affordance goes through the storefront opener,
          which needs the router the app always provides. */}
      <MemoryRouter>
        <AtumEditAgentDialog agent={marketing} onClose={onClose} />
      </MemoryRouter>
    </I18nProvider>
  )

  return { ...view, onClose }
}

/** Open the picker and choose Gigi. */
async function pickGigi() {
  fireEvent.click(screen.getByRole('button', { name: 'Choose a pet' }))
  await waitFor(() => expect(screen.getByRole('button', { name: /Gigi/u })).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: /Gigi/u }))
}

beforeEach(() => {
  resetAtumShellState()
  clearAtumStoreCatalog()
  $atumAssistantDirectory.set({ accountId: null, entries: [], state: 'empty' })
  $petInfoByAgent.set({})
  $gatewayState.set('open')
  $petGalleryStatus.set('ready')
  $petGallery.set({
    active: '',
    enabled: false,
    pets: [
      { displayName: 'Gigi', installed: true, price: FREE, slug: 'gigi' },
      { displayName: 'Boba', installed: false, price: FREE, slug: 'boba' }
    ]
  })
  editAtumAgent.mockReset().mockResolvedValue(undefined)
  loadAtumAgentInstructions.mockReset().mockResolvedValue({ job: 'Plans campaigns.', persona: 'Warm.' })
  adoptPetFor.mockReset().mockResolvedValue(true)
  renameAtumMasterAssistant.mockReset().mockResolvedValue(undefined)
  loadPetGallery.mockReset().mockResolvedValue(undefined)
  loadPetThumb.mockReset().mockResolvedValue(null)
  refreshPetInfoFor.mockReset().mockResolvedValue(undefined)
})

afterEach(cleanup)

describe('the assistant editor’s pet picker', () => {
  it('adopts nothing until the sheet is saved', async () => {
    renderDialog()
    await pickGigi()

    expect(adoptPetFor).not.toHaveBeenCalled()
  })

  it('discards the choice when the sheet is cancelled', async () => {
    const { onClose } = renderDialog()
    await pickGigi()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(adoptPetFor).not.toHaveBeenCalled()
  })

  it('adopts for the assistant being edited, on save', async () => {
    const { onClose } = renderDialog()
    await pickGigi()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(adoptPetFor).toHaveBeenCalledWith(expect.anything(), 'gigi', 'marketing', expect.any(String))
  })

  it('shows the pet this assistant already has, not the active one’s', () => {
    // The sheet is nearly always opened on someone other than the assistant in
    // front of you, so reading the active `$petInfo` would show the wrong pet.
    $petInfoByAgent.set({
      default: { displayName: 'Boba', enabled: true, slug: 'boba' },
      marketing: { displayName: 'Gigi', enabled: true, slug: 'gigi' }
    })
    renderDialog()

    const field = globalThis.document.querySelector('[data-atum-agent-pet-field]')

    expect(field?.textContent).toContain('Gigi')
    expect(field?.textContent).not.toContain('Boba')
    expect(screen.getByRole('button', { name: 'Change pet' })).toBeTruthy()
  })

  it('gives the master a pet even when its name is unavailable', async () => {
    // Signed out, the master's name comes from a hosted directory that is not
    // there, so the Name field is empty. That must not stand between the master
    // and a pet, which is written to its own local profile.
    const onClose = vi.fn()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MemoryRouter>
          <AtumEditAgentDialog agent={{ ...marketing, id: 'default', isDefault: true, title: '' }} onClose={onClose} />
        </MemoryRouter>
      </I18nProvider>
    )
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)

    await pickGigi()
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(adoptPetFor).toHaveBeenCalledWith(expect.anything(), 'gigi', 'default', expect.any(String))
    expect(renameAtumMasterAssistant, 'nothing to rename the master to').not.toHaveBeenCalled()
  })

  it('does not touch the pet when the person only renamed the assistant', async () => {
    renderDialog()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Growth' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })

    await waitFor(() => expect(editAtumAgent).toHaveBeenCalled())
    expect(adoptPetFor).not.toHaveBeenCalled()
  })

  it('says so when the pet could not be set, instead of closing as if it worked', async () => {
    adoptPetFor.mockResolvedValue(false)
    const { onClose } = renderDialog()
    await pickGigi()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not set the pet.'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('never stages a catalog-priced pet as if free — buying lives in the store', async () => {
    // The store catalog prices Boba; the picker must label the price and
    // refuse the choice, not hand it to pet.select on save (review B10).
    $atumStoreCatalog.set({
      accountId: 'account-1',
      catalog: catalogWithPet([catalogPet('bundled/boba', 'boba', 4000)]),
      state: 'ready'
    })
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Choose a pet' }))
    const boba = (await screen.findByRole('button', { name: /Boba/u })) as HTMLButtonElement

    expect(boba.disabled).toBe(true)
    expect(boba.textContent).toContain('4,000 Protons')

    fireEvent.click(boba)
    await Promise.resolve()

    // A disabled row cannot be staged: the picker stays open and nothing was chosen.
    expect(screen.getByLabelText('Search pets')).toBeTruthy()

    // Gigi, unclaimed by the catalog, is still a free choice.
    fireEvent.click(screen.getByRole('button', { name: /Gigi/u }))
    await waitFor(() => expect(screen.queryByLabelText('Search pets')).toBeNull())
  })

  it('marks a bundled pet unavailable while the catalog has not answered — never free', async () => {
    // An account is in scope but the catalog read is still out: a bundled
    // pet's price is UNKNOWN, and unknown is unavailable.
    $atumStoreCatalog.set({ accountId: 'account-1', catalog: null, state: 'loading' })
    $petGallery.set({
      active: '',
      enabled: false,
      pets: [{ bundled: true, displayName: 'Mochi', installed: false, price: FREE, slug: 'mochi' }]
    })
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Choose a pet' }))
    const mochi = (await screen.findByRole('button', { name: /Mochi/u })) as HTMLButtonElement

    expect(mochi.disabled).toBe(true)
    expect(mochi.textContent).not.toContain('Free')
  })

  it('"Open the Pet Store" closes the sheet between the shell state and the navigation', async () => {
    const { onClose } = renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Choose a pet' }))
    const browse = await waitFor(() => globalThis.document.querySelector('[data-atum-agent-pet-browse]')!)
    fireEvent.click(browse)

    // The modal sheet is gone — it must not float over the storefront (and a
    // collapsing roster must not unmount it without its own close running).
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect($railDestination.get()).toBe('discover')
    expect($discoverShelf.get()).toBe('pets')
  })

  it('cannot leave for the Pet Store while the sheet is saving', async () => {
    // A saving sheet makes its own close a no-op, so leaving would strand the
    // Preserve the recovery and user-visible behavior covered by this path.
    const field = (disabled: boolean) => (
      <I18nProvider configClient={null} initialLocale="en">
        <MemoryRouter>
          <AtumAssistantPetField agentId="agent-1" disabled={disabled} onChange={vi.fn()} onClose={vi.fn()} value={null} />
        </MemoryRouter>
      </I18nProvider>
    )

    // The picker is opened first — then Save starts, which is the window the
    // defect lived in.
    const { rerender } = render(field(false))

    fireEvent.click(screen.getByRole('button', { name: 'Choose a pet' }))
    await waitFor(() => expect(globalThis.document.querySelector('[data-atum-agent-pet-browse]')).toBeTruthy())

    rerender(field(true))

    const browse = globalThis.document.querySelector('[data-atum-agent-pet-browse]') as HTMLButtonElement

    expect(browse.disabled).toBe(true)
  })
})
