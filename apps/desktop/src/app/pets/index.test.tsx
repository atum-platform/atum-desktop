import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Agents from '@/app/atum/agents'
import type { AtumStoreCatalogWire, AtumStoreItemWire } from '@/lib/atum-store-items'
import type * as PetGallery from '@/store/pet-gallery'

import type * as SheetStore from './store'

/**
 * The Pet Store: shelves of living pets, a stage to meet one on, and the hatch
 * when an assistant takes one home.
 *
 * Sheets are what make a card move. `loadPetSheet` is mocked so the shelf can
 * be watched asking for one, and `$petSheets` is written to directly to play
 * the moment it arrives — the request itself is `pet.sheet`'s business.
 */

const adoptPetFor = vi.fn()
const loadPetGallery = vi.fn()
const loadPetThumb = vi.fn()
const loadPetSheet = vi.fn()
const openPetGenerate = vi.fn()

vi.mock('@/store/pet-gallery', async importOriginal => ({
  ...(await importOriginal<typeof PetGallery>()),
  adoptPetFor,
  loadPetGallery,
  loadPetThumb
}))

vi.mock('@/store/pet-generate', () => ({ openPetGenerate }))

vi.mock('./store', async importOriginal => ({
  ...(await importOriginal<typeof SheetStore>()),
  loadPetSheet
}))

const agents = [
  { avatar: '', avatarUrl: null, description: '', id: 'default', identityId: '', isDefault: true, isManaged: true, lifecycleRevision: 0, pinned: false, title: '' },
  { avatar: '📣', avatarUrl: null, description: '', id: 'marketing', identityId: '00000000-0000-4000-8000-50d86b120e98', isDefault: false, isManaged: true, lifecycleRevision: 1, pinned: false, title: 'Marketing' }
]

vi.mock('@/app/atum/agents', async importOriginal => ({
  ...(await importOriginal<typeof Agents>()),
  $atumAgents: atom(agents)
}))

const { I18nProvider } = await import('@/i18n')
const { $atumStoreCatalog, clearAtumStoreCatalog } = await import('@/store/atum-store-catalog')
const { $petGallery, $petGalleryStatus } = await import('@/store/pet-gallery')
const { $petInfoByAgent, syncActivePetViews } = await import('@/store/pet')
const { $activeGatewayProfile } = await import('@/store/profile')
const { $gatewayState } = await import('@/store/session')
const { $petSheets, isPetSheetHeld, loadPetSheet: realLoadPetSheet, resetPetSheets, SHEET_BUDGET } = await import('./store')
const { PetStoreView } = await import('./index')

const GALLERY = {
  active: 'gigi',
  enabled: true,
  pets: [
    { bundled: true, displayName: 'Gigi', installed: true, price: { kind: 'free' as const }, slug: 'gigi' },
    { bundled: true, displayName: 'Mochi', installed: false, price: { kind: 'free' as const }, slug: 'mochi' },
    { curated: true, displayName: 'Boba', installed: false, price: { kind: 'free' as const }, slug: 'boba' },
    { curated: true, displayName: 'Codex Frog', installed: false, price: { kind: 'free' as const }, slug: 'codex-frog' },
    { displayName: 'Nukey', installed: false, price: { kind: 'free' as const }, slug: 'nukey' }
  ]
}

/** A sheet as `pet.sheet` returns it: enough for the sprite to size itself. */
const SHEET = { displayName: 'Boba', enabled: true, frameH: 208, frameW: 192, framesPerState: 8, mime: 'image/webp', scale: 1, slug: 'boba', spritesheetBase64: 'AA==' }

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

function LocationProbe() {
  const { pathname, search } = useLocation()

  return <span data-testid="location">{pathname}{search}</span>
}

function renderStore() {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      {/* The store is Discover's Pets shelf (and a dockable pane): both render
          under a router, and the shelf's "Manage installed →" link navigates. */}
      <MemoryRouter>
        <PetStoreView />
        <LocationProbe />
      </MemoryRouter>
    </I18nProvider>
  )
}

const cards = (container: HTMLElement, shelf: string) =>
  Array.from(container.querySelectorAll(`[data-testid="${shelf}"] [data-pet-card]`)).map(el => el.getAttribute('data-pet-card'))

beforeEach(() => {
  $gatewayState.set('open')
  $activeGatewayProfile.set('default')
  $petInfoByAgent.set({})
  syncActivePetViews()
  $petGalleryStatus.set('ready')
  $petGallery.set(structuredClone(GALLERY))
  clearAtumStoreCatalog()
  resetPetSheets()
  adoptPetFor.mockReset().mockResolvedValue(true)
  loadPetGallery.mockReset().mockResolvedValue(undefined)
  loadPetThumb.mockReset().mockResolvedValue(null)
  loadPetSheet.mockReset().mockResolvedValue(null)
  openPetGenerate.mockReset()
})

afterEach(cleanup)

describe('the Pet Store', () => {
  it('shelves what ships with the app, then petdex’s picks, then the hatch — never the uncurated tail', () => {
    const { container } = renderStore()

    expect(loadPetGallery).toHaveBeenCalledOnce()
    expect(cards(container, 'pet-store-atum').sort()).toEqual(['gigi', 'mochi'])
    expect(cards(container, 'pet-store-popular').sort()).toEqual(['boba', 'codex-frog'])
    expect(container.querySelector('[data-pet-card="nukey"]')).toBeNull()
    expect(screen.getByTestId('pet-store-hatch')).toBeTruthy()
  })

  it('asks for each shelved pet’s sheet and goes live when it arrives', async () => {
    const { container } = renderStore()

    // jsdom has no IntersectionObserver, so every card counts as in view.
    await waitFor(() => expect(loadPetSheet).toHaveBeenCalledWith(expect.anything(), 'boba', { displayName: 'Boba', url: undefined }))
    expect(container.querySelector('[data-pet-card="boba"]')?.getAttribute('data-pet-live')).toBe('false')

    act(() => $petSheets.set({ boba: SHEET }))

    expect(container.querySelector('[data-pet-card="boba"]')?.getAttribute('data-pet-live')).toBe('true')
    expect(container.querySelector('[data-pet-card="gigi"]')?.getAttribute('data-pet-live')).toBe('false')
  })

  it('collapses the shelves into results while searching', () => {
    const { container } = renderStore()

    fireEvent.change(screen.getByLabelText('Search pets'), { target: { value: 'frog' } })

    expect(screen.queryByTestId('pet-store-atum')).toBeNull()
    expect(cards(container, 'pet-store-results')).toEqual(['codex-frog'])

    fireEvent.change(screen.getByLabelText('Search pets'), { target: { value: 'zzz' } })
    expect(screen.getByText('No pets match ‘zzz’.')).toBeTruthy()
  })

  it('reads the price on the pill until somebody has the pet, then the verb, and names who has it', () => {
    $petInfoByAgent.set({ marketing: { displayName: 'Boba', enabled: true, slug: 'boba' } })
    const { container } = renderStore()

    expect(container.querySelector('[data-pet-card="mochi"] [data-atum-adopt]')?.textContent).toBe('Free')
    expect(container.querySelector('[data-pet-card="boba"] [data-atum-adopt]')?.textContent).toBe('Adopt')
    expect(container.querySelector('[data-pet-card="boba"]')?.textContent).toContain('Marketing')
  })

  it('hands "Hatch your own" to the generator', () => {
    const { container } = renderStore()

    fireEvent.click(container.querySelector('[data-atum-hatch]')!)

    expect(openPetGenerate).toHaveBeenCalledOnce()
  })

  it('links out to Settings for what is already installed — acquiring lives here, managing stays there', async () => {
    // Imported here, not at the top: a static import would load the shell store
    // before this file's hoisted mocks have their fixtures initialised.
    const { $atumShellEnabled } = await import('@/store/atum-shell')
    const { petSettingsHref } = await import('../settings/pet-settings')
    const { container } = renderStore()

    fireEvent.click(container.querySelector('[data-atum-manage-pets]')!)

    // This line used to assert '/settings?tab=appearance' — a tab no settings
    // shell accepts, so the page silently showed General and this test locked
    // the bug in. Every "Pet settings" link now goes through one helper, whose
    // target the settings-tab-links guard proves resolves.
    expect(screen.getByTestId('location').textContent).toBe(petSettingsHref($atumShellEnabled.get()).split('#')[0])
  })

  it('opens the Meet stage from a card, where the pet performs on command once its sheet is in', async () => {
    const { container } = renderStore()

    fireEvent.click(screen.getByRole('button', { name: 'Boba' }))
    const dialog = await screen.findByRole('dialog')

    expect(dialog.textContent).toContain('Meet Boba')
    const lounge = screen.getByRole('button', { name: 'Lounge' })

    // No sheet yet: nothing to animate, so the tricks wait.
    expect((lounge as HTMLButtonElement).disabled).toBe(true)

    act(() => $petSheets.set({ boba: SHEET }))

    fireEvent.click(screen.getByRole('button', { name: 'Lounge' }))
    expect(container.ownerDocument.querySelector('[data-atum-meet-pose]')?.getAttribute('data-atum-meet-pose')).toBe('lounging')
    expect(screen.getByRole('button', { name: 'Lounge' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('adopts from the stage for the chosen assistant, then hatches', async () => {
    const { container } = renderStore()
    fireEvent.click(screen.getByRole('button', { name: 'Boba' }))
    await screen.findByRole('dialog')

    fireEvent.click(container.ownerDocument.querySelector('[data-atum-meet-adopt]')!)
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('Give Boba to…'))

    fireEvent.click(screen.getAllByRole('radio')[1]!)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Adopt', hidden: false }))
    })

    await waitFor(() => expect(adoptPetFor).toHaveBeenCalledWith(expect.anything(), 'boba', 'marketing', expect.any(String)))
    // The stage and the question both step aside for the hatch.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const celebration = container.ownerDocument.querySelector('[data-atum-adopt-celebration]')

    expect(celebration?.getAttribute('data-atum-adopt-celebration')).toBe('egg')

    // A click dismisses it early; nothing lingers.
    fireEvent.click(celebration!)
    expect(container.ownerDocument.querySelector('[data-atum-adopt-celebration]')).toBeNull()
  })

  it('keeps the pet on the stage, and in the hatch, under cache pressure from the shelf', async () => {
    const { container } = renderStore()
    fireEvent.click(screen.getByRole('button', { name: 'Boba' }))
    await screen.findByRole('dialog')
    act(() => $petSheets.set({ boba: SHEET }))

    // The open stage holds its sheet: a shelf loading a budget of others behind it cannot drop it.
    expect(isPetSheetHeld('boba')).toBe(true)
    const fill = vi.fn(async (_m: string, p: { slug: string }) => ({ ok: true, ...SHEET, slug: p.slug }))

    for (let i = 0; i < SHEET_BUDGET + 5; i += 1) {
      await realLoadPetSheet(fill as never, `filler-${i}`)
    }

    expect($petSheets.get().boba).toBeTruthy()
    expect(container.ownerDocument.querySelector('[data-atum-meet-stage] canvas')).toBeTruthy()

    // Adopt: the hatch keeps the picture it started with even after the stage closes and the cache moves on.
    fireEvent.click(container.ownerDocument.querySelector('[data-atum-meet-adopt]')!)
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('Give Boba to…'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Adopt', hidden: false }))
    })
    await waitFor(() => expect(container.ownerDocument.querySelector('[data-atum-adopt-celebration]')).toBeTruthy())

    // (In jsdom every shelf card is "near", so the boba card still holds its
    // sheet; the hatch must not depend on that — the cache is emptied below.)
    for (let i = 0; i < SHEET_BUDGET + 5; i += 1) {
      await realLoadPetSheet(fill as never, `later-${i}`)
    }

    act(() => $petSheets.set({}))
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(container.ownerDocument.querySelector('[data-atum-adopt-celebration]')?.getAttribute('data-atum-adopt-celebration')).toBe('hatched')
    expect(container.ownerDocument.querySelector('[data-atum-adopt-celebration] canvas')).toBeTruthy()
  })

  it('says so when the catalog is unreachable', () => {
    $petGallery.set(null)
    $petGalleryStatus.set('error')
    renderStore()

    expect(screen.getByText('The pet catalog is unavailable right now.')).toBeTruthy()
  })

  it("lets the store catalog's offer price its own row and badges it Owned once entitled", () => {
    $atumStoreCatalog.set({
      accountId: 'a',
      catalog: catalogWithPet(
        [catalogPet('mochi', 'mochi', 2500), catalogPet('gigi', 'gigi', 1500)],
        [{ assistant_id: null, assistant_identity_id: null, granted_at: '2026-09-10T00:00:00Z', id: 'mochi', kind: 'pet', state: 'active' }]
      ),
      state: 'ready'
    })
    const { container } = renderStore()

    // Owned: the entitlement is the acquisition — the verb, not the price.
    const mochi = container.querySelector('[data-pet-card="mochi"]')!
    expect(mochi.querySelector('[data-atum-adopt]')?.textContent).toBe('Adopt')
    expect(mochi.querySelector('[data-atum-owned-badge]')?.textContent).toBe('Owned')

    // Listed but not owned: the catalog's offer price wins.
    expect(container.querySelector('[data-pet-card="gigi"] [data-atum-adopt]')?.textContent).toBe('1,500 Protons')

    // Petdex pets no catalog row claims: free by source class, and installed
    // never means owned — no badge, ever.
    expect(container.querySelector('[data-pet-card="boba"] [data-atum-adopt]')?.textContent).toBe('Free')
    expect(container.querySelector('[data-pet-card="boba"] [data-atum-owned-badge]')).toBeNull()
  })

  it('narrows every shelf to entitlements only when the Owned chip is on', () => {
    $atumStoreCatalog.set({
      accountId: 'a',
      catalog: catalogWithPet(
        [catalogPet('mochi', 'mochi', 2500)],
        [{ assistant_id: null, assistant_identity_id: null, granted_at: '2026-09-10T00:00:00Z', id: 'mochi', kind: 'pet', state: 'active' }]
      ),
      state: 'ready'
    })
    const { container } = renderStore()

    fireEvent.click(container.querySelector('[data-atum-owned-filter]')!)

    expect(container.querySelector('[data-pet-card="mochi"]')).toBeTruthy()
    expect(container.querySelector('[data-pet-card="gigi"]')).toBeNull()
    expect(container.querySelector('[data-pet-card="boba"]')).toBeNull()

    fireEvent.click(container.querySelector('[data-atum-owned-filter]')!)

    expect(container.querySelector('[data-pet-card="gigi"]')).toBeTruthy()
  })

  it('shows the empty library line when nothing is owned', () => {
    const { container } = renderStore()

    fireEvent.click(container.querySelector('[data-atum-owned-filter]')!)

    expect(screen.getByText('Nothing owned yet — what you buy lands here.')).toBeTruthy()
    expect(container.querySelector('[data-pet-card]')).toBeNull()
  })
})
