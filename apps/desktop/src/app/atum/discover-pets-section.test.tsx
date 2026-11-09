import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtumStoreCatalogWire, AtumStoreItemWire } from '@/lib/atum-store-items'
import type * as PetGallery from '@/store/pet-gallery'

import type * as Agents from './agents'

/**
 * Pets in Discover: the shop window — what ships with the app, adoptable on
 * the spot, and the door to the Pet Store — plus the question the skills
 * section never has to ask: for which assistant?
 */

const adoptPetFor = vi.fn()
const loadPetGallery = vi.fn()
const loadPetThumb = vi.fn()

vi.mock('@/store/pet-gallery', async importOriginal => ({
  ...(await importOriginal<typeof PetGallery>()),
  adoptPetFor,
  loadPetGallery,
  loadPetThumb
}))

const agents = [
  { avatar: '', avatarUrl: null, description: '', id: 'default', identityId: '', isDefault: true, isManaged: true, lifecycleRevision: 0, pinned: false, title: '' },
  { avatar: '📣', avatarUrl: null, description: '', id: 'marketing', identityId: '00000000-0000-4000-8000-50d86b120e98', isDefault: false, isManaged: true, lifecycleRevision: 1, pinned: false, title: 'Marketing' }
]

vi.mock('./agents', async importOriginal => ({
  ...(await importOriginal<typeof Agents>()),
  $atumAgents: atom(agents)
}))

const { I18nProvider } = await import('@/i18n')
const { $discoverShelf, $railDestination } = await import('@/store/atum-shell')
const { $atumStoreCatalog, clearAtumStoreCatalog } = await import('@/store/atum-store-catalog')
const { $petGallery, $petGalleryStatus } = await import('@/store/pet-gallery')
const { $petInfoByAgent, syncActivePetViews } = await import('@/store/pet')
const { $activeGatewayProfile } = await import('@/store/profile')
const { $gatewayState } = await import('@/store/session')
const { DiscoverPetsSection } = await import('./discover-pets-section')

const GALLERY = {
  active: 'gigi',
  enabled: true,
  pets: [
    { bundled: true, displayName: 'Gigi', installed: true, price: { kind: 'free' as const }, slug: 'gigi' },
    { bundled: true, displayName: 'Nova', installed: false, price: { kind: 'free' as const }, slug: 'nova' },
    { curated: true, displayName: 'Boba', installed: false, price: { kind: 'free' as const }, slug: 'boba' },
    { curated: true, displayName: 'Codex Frog', installed: false, price: { kind: 'free' as const }, slug: 'codex-frog' },
    { displayName: 'Nukey', installed: false, price: { kind: 'free' as const }, slug: 'nukey' }
  ]
}

/** A store catalog row claiming one gallery pet by slug. */
const catalogPet = (id: string, slug: string, priceProtons: number): AtumStoreItemWire => ({
  accent: 'var(--atum-sunk)',
  detail: { description: { vi: 'Thú cưng' }, needs: [], try_prompt: { vi: 'Thử' } },
  featured: true,
  glyph: '🐾',
  hashes: [],
  id,
  kind: 'pet',
  offer: { id: '00000000-0000-4000-8000-a28c50c0e7e8', price_protons: priceProtons, version: 1 },
  sort_order: 1,
  source: { slug, type: 'bundled' },
  summary: { vi: 'Thú cưng' },
  title: { vi: 'Thú cưng' }
})

const catalogWithPet = (items: AtumStoreItemWire[], entitlements: AtumStoreCatalogWire['entitlements'] = []): AtumStoreCatalogWire => ({
  available_protons: 12000,
  entitlements,
  items
})

function renderSection() {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <MemoryRouter initialEntries={['/discover']}>
        <Routes>
          <Route element={<DiscoverPetsSection />} path="/discover" />
          <Route element={<div data-testid="pet-store-page" />} path="/pets" />
        </Routes>
      </MemoryRouter>
    </I18nProvider>
  )
}

beforeEach(() => {
  $gatewayState.set('open')
  $activeGatewayProfile.set('default')
  $petInfoByAgent.set({})
  syncActivePetViews()
  $petGalleryStatus.set('ready')
  $petGallery.set(structuredClone(GALLERY))
  clearAtumStoreCatalog()
  adoptPetFor.mockReset().mockResolvedValue(true)
  loadPetGallery.mockReset().mockResolvedValue(undefined)
  loadPetThumb.mockReset().mockResolvedValue(null)
})

afterEach(cleanup)

describe('pets in Discover', () => {
  it('fetches the catalog when it is shown and leads the strip with what ships with the app', () => {
    const { container } = renderSection()

    expect(loadPetGallery).toHaveBeenCalledOnce()
    const featured = Array.from(container.querySelectorAll('[data-featured-pet]')).map(el => el.getAttribute('data-featured-pet'))

    // Ours first — by the gallery's `bundled` flag, not by anyone's name, and
    // whether or not this profile has installed them — then petdex's curated
    // picks; never the uncurated tail.
    expect(featured.slice(0, 2).sort()).toEqual(['gigi', 'nova'])
    expect(featured).toHaveLength(3)
    expect(featured[2]).toBe('boba')
    expect(featured).not.toContain('nukey')
    // The catalog itself lives in the Pet Store; Discover shows the window.
    expect(container.querySelectorAll('[data-pet-row]')).toHaveLength(0)
  })

  it('reads the price on the pill until somebody has the pet, then the verb — like a skill', () => {
    $petInfoByAgent.set({ marketing: { displayName: 'Boba', enabled: true, slug: 'boba' } })
    const { container } = renderSection()

    expect(container.querySelector('[data-featured-pet="nova"] [data-atum-adopt]')?.textContent).toBe('Free')
    expect(container.querySelector('[data-featured-pet="boba"] [data-atum-adopt]')?.textContent).toBe('Adopt')
  })

  it('opens the Pet Store shelf without leaving Discover — the rail stays, the shelf intent is seeded', () => {
    $railDestination.set('discover')
    const { container } = renderSection()

    fireEvent.click(container.querySelector('[data-atum-open-pet-store]')!)

    // The store is a shelf of Discover now, not a workspace page: no eject, no
    // /pets in the address bar.
    expect($railDestination.get()).toBe('discover')
    expect($discoverShelf.get()).toBe('pets')
    expect(screen.queryByTestId('pet-store-page')).toBeNull()
  })

  it('asks which assistant should have the pet, preselecting the one in front', async () => {
    const { container } = renderSection()

    fireEvent.click(container.querySelector('[data-featured-pet="boba"] [data-atum-adopt]')!)
    const dialog = await screen.findByRole('dialog')

    expect(dialog.textContent).toContain('Give Boba to…')
    const radios = screen.getAllByRole('radio') as HTMLInputElement[]

    expect(radios).toHaveLength(2)
    expect(radios[0]!.checked).toBe(true)
    expect(adoptPetFor).not.toHaveBeenCalled()
  })

  it('adopts for the chosen assistant, not the active one', async () => {
    const { container } = renderSection()
    fireEvent.click(container.querySelector('[data-featured-pet="boba"] [data-atum-adopt]')!)
    await screen.findByRole('dialog')

    fireEvent.click(screen.getAllByRole('radio')[1]!)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Adopt', hidden: false }))
    })

    await waitFor(() => expect(adoptPetFor).toHaveBeenCalledWith(expect.anything(), 'boba', 'marketing', expect.any(String)))
    expect(screen.getByText('Now with Marketing.')).toBeTruthy()
    // The confirm is gone; only Done remains.
    expect(screen.queryByRole('button', { name: 'Adopt', hidden: false })).toBeNull()
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
  })

  it('says so and stays open when adoption fails', async () => {
    adoptPetFor.mockResolvedValue(false)
    const { container } = renderSection()
    fireEvent.click(container.querySelector('[data-featured-pet="gigi"] [data-atum-adopt]')!)
    await screen.findByRole('dialog')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Adopt', hidden: false }))
    })

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not adopt this pet.'))
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it("lets the catalog's offer price its own rows while source class keeps the rest free", () => {
    $atumStoreCatalog.set({
      accountId: 'a',
      catalog: catalogWithPet([catalogPet('nova', 'nova', 4000)]),
      state: 'ready'
    })
    const { container } = renderSection()

    // The catalog's price wins for its own row…
    expect(container.querySelector('[data-featured-pet="nova"] [data-atum-adopt]')?.textContent).toBe('4,000 Protons')
    // …and every pet no catalog row claims is free by source class, whatever a manifest says.
    expect(container.querySelector('[data-featured-pet="boba"] [data-atum-adopt]')?.textContent).toBe('Free')
  })

  it('badges an entitled pet as Owned and offers adoption; a bundled pet is installed, never owned', () => {
    $atumStoreCatalog.set({
      accountId: 'a',
      catalog: catalogWithPet(
        [catalogPet('nova', 'nova', 4000)],
        [{ assistant_id: null, assistant_identity_id: null, granted_at: '2026-09-10T00:00:00Z', id: 'nova', kind: 'pet', state: 'active' }]
      ),
      state: 'ready'
    })
    const { container } = renderSection()

    const nova = container.querySelector('[data-featured-pet="nova"]')!
    expect(nova.querySelector('[data-atum-owned-badge]')?.textContent).toBe('Owned')
    expect(nova.querySelector('[data-atum-adopt]')?.textContent).toBe('Adopt')

    // Bundled pets ship with the app: installed, not owned — no badge, ever.
    expect(container.querySelector('[data-featured-pet="gigi"] [data-atum-owned-badge]')).toBeNull()
    expect(container.querySelector('[data-featured-pet="boba"] [data-atum-owned-badge]')).toBeNull()
  })
})
