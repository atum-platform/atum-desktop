import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { atom } from 'nanostores'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtumStoreCatalogWire } from '@/lib/atum-store-items'
import type * as PetGallery from '@/store/pet-gallery'

import type * as Agents from './agents'

/**
 * AdoptPetDialog: "for which assistant?" plus, when the store prices the pet,
 * the purchase that comes first (plan 2026-09-10-atum-store.md, W5.4).
 */

const adoptPetFor = vi.fn()
const runStorePurchase = vi.fn()
const recoverStorePurchase = vi.fn()

vi.mock('@/store/pet-gallery', async importOriginal => ({
  ...(await importOriginal<typeof PetGallery>()),
  adoptPetFor
}))

const agents = [
  { avatar: '', avatarUrl: null, description: '', id: 'default', identityId: '', isDefault: true, isManaged: true, lifecycleRevision: 0, pinned: false, title: '' },
  { avatar: '📣', avatarUrl: null, description: '', id: 'marketing', identityId: '00000000-0000-4000-8000-50d86b120e98', isDefault: false, isManaged: true, lifecycleRevision: 1, pinned: false, title: 'Marketing' }
]

vi.mock('./agents', async importOriginal => ({
  ...(await importOriginal<typeof Agents>()),
  $atumAgents: atom(agents)
}))

const CATALOG: AtumStoreCatalogWire = {
  available_protons: 12000,
  entitlements: [],
  items: []
}

// Spread the real module and pin only the account scope: a hand-picked partial
// mock breaks every time the store chain reaches one more of its exports.
vi.mock('@/store/atum-messaging', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  const { atom: makeAtom } = await import('nanostores')

  return { ...actual, $atumAccountScopeId: makeAtom<string | null>('account-a') }
})
vi.mock('@/store/atum-store-catalog', async () => {
  const { atom: makeAtom } = await import('nanostores')

  return {
    $atumStoreCatalog: makeAtom({ accountId: 'account-a', catalog: CATALOG, state: 'ready' }),
    refreshAtumStoreCatalog: vi.fn(async () => null)
  }
})
vi.mock('@/store/atum-store-purchase', () => ({ recoverStorePurchase, runStorePurchase }))

const { $petInfoByAgent, syncActivePetViews } = await import('@/store/pet')
const { $activeGatewayProfile } = await import('@/store/profile')
const { AdoptPetDialog } = await import('./adopt-pet-dialog')
const { FREE } = await import('@/lib/atum-price')

type StorePetRow = PetGallery.StorePetRow

const MOCHI_OFFER = { id: '00000000-0000-4000-8000-dd7df1164681', priceProtons: 3000, version: 1 }

const petRow = (overrides: Partial<StorePetRow> = {}): StorePetRow => ({
  bundled: true,
  displayName: 'Mochi',
  installed: false,
  owned: false,
  price: FREE,
  slug: 'mochi',
  storeItemId: null,
  storeOffer: null,
  ...overrides
})

const PRICED = petRow({ price: { amount: 3000, kind: 'protons' }, storeItemId: 'mochi', storeOffer: MOCHI_OFFER })

function LocationProbe() {
  const { pathname, search } = useLocation()

  return <span data-testid="location">{pathname}{search}</span>
}

function renderDialog(pet: StorePetRow) {
  return render(
    <MemoryRouter>
      <AdoptPetDialog onOpenChange={vi.fn()} pet={pet} />
      <LocationProbe />
    </MemoryRouter>
  )
}

const confirmAdopt = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Adopt', hidden: false }))
  })
}

beforeEach(() => {
  $activeGatewayProfile.set('default')
  $petInfoByAgent.set({})
  syncActivePetViews()
  adoptPetFor.mockReset().mockResolvedValue(true)
  runStorePurchase.mockReset().mockResolvedValue({ kind: 'completed' })
  recoverStorePurchase.mockReset().mockResolvedValue({ kind: 'failed' })
})

afterEach(cleanup)

describe('AdoptPetDialog — store purchases', () => {
  it('shows the authoritative offer, its version and the wallet balance before charging', async () => {
    renderDialog(PRICED)
    await confirmAdopt()

    const offer = document.querySelector('[data-atum-store-offer]')!

    expect(offer.getAttribute('data-atum-offer-version')).toBe('1')
    expect(offer.textContent).toContain('3,000 Protons')
    // The version travels with the purchase, never as customer-facing text.
    expect(offer.textContent).not.toMatch(/Offer v\d/u)
    expect(offer.textContent).toContain('You have 12,000 Protons')
    expect(adoptPetFor).not.toHaveBeenCalled()
    expect(runStorePurchase).not.toHaveBeenCalled()
  })

  it('buys at the confirmed offer, then adopts for the chosen assistant', async () => {
    renderDialog(PRICED)
    fireEvent.click(screen.getAllByRole('radio')[1]!)
    await confirmAdopt()

    fireEvent.click(screen.getByRole('button', { name: /Buy · 3,000 Protons/ }))

    await waitFor(() => expect(runStorePurchase).toHaveBeenCalledWith({
      accountId: 'account-a',
      itemId: 'mochi',
      kind: 'pet',
      offer: MOCHI_OFFER
    }))
    await waitFor(() => expect(adoptPetFor).toHaveBeenCalledWith(expect.anything(), 'mochi', 'marketing', expect.any(String)))
    expect(await screen.findByText('Now with Marketing.')).toBeTruthy()
  })

  it('offer_changed re-prompts at the new authoritative price and never charges the old one', async () => {
    const newOffer = { id: MOCHI_OFFER.id, priceProtons: 4500, version: 2 }
    runStorePurchase.mockResolvedValueOnce({ kind: 'offer_changed', offer: newOffer })
    renderDialog(PRICED)
    await confirmAdopt()

    fireEvent.click(screen.getByRole('button', { name: /Buy/ }))

    await waitFor(() => expect(screen.getByText(/price changed/)).toBeTruthy())
    expect(document.querySelector('[data-atum-store-offer]')!.getAttribute('data-atum-offer-version')).toBe('2')
    expect(adoptPetFor).not.toHaveBeenCalled()

    runStorePurchase.mockResolvedValueOnce({ kind: 'completed' })
    fireEvent.click(screen.getByRole('button', { name: /Buy · 4,500 Protons/ }))

    await waitFor(() => expect(runStorePurchase).toHaveBeenLastCalledWith({
      accountId: 'account-a',
      itemId: 'mochi',
      kind: 'pet',
      offer: newOffer
    }))
    await waitFor(() => expect(adoptPetFor).toHaveBeenCalled())
  })

  it('insufficient_protons says so in the offer card and offers no legacy top-up', async () => {
    const wallet = vi.fn(async () => ({ spending_enabled: true, available_protons: 0, held_protons: 0,
      trial_protons: 0, ai_protons_per_usd: 40_500, balance_protons: 0, funded: false }))

    Object.assign(window, { hermesDesktop: { ...window.hermesDesktop, protons: { wallet } } })
    runStorePurchase.mockResolvedValueOnce({ kind: 'insufficient_protons' })
    renderDialog(PRICED)
    await confirmAdopt()

    fireEvent.click(screen.getByRole('button', { name: /Buy · 3,000 Protons/ }))

    await waitFor(() => expect(screen.getByText('Not enough Protons for this.')).toBeTruthy())
    const offer = document.querySelector('[data-atum-store-offer]')!
    expect(within(offer as HTMLElement).queryByRole('button', { name: 'Buy 100,000 Protons' })).toBeNull()
    expect(offer.querySelector('[data-atum-store-topup], [data-atum-proton-packs]')).toBeNull()
    expect(screen.getByTestId('location').textContent).toBe('/')
    expect(adoptPetFor).not.toHaveBeenCalled()
  })

  it('purchase succeeded but adoption failed → "Owned · Retry install", never a second purchase', async () => {
    adoptPetFor.mockResolvedValue(false)
    renderDialog(PRICED)
    await confirmAdopt()
    fireEvent.click(screen.getByRole('button', { name: /Buy/ }))

    await waitFor(() => expect(adoptPetFor).toHaveBeenCalledTimes(1))

    const retry = await screen.findByRole('button', { name: 'Owned · Retry install' })
    fireEvent.click(retry)

    await waitFor(() => expect(adoptPetFor).toHaveBeenCalledTimes(2))
    expect(runStorePurchase).toHaveBeenCalledTimes(1)
  })

  it('an ambiguous answer offers status recovery instead of a blind retry', async () => {
    runStorePurchase.mockResolvedValueOnce({ kind: 'uncertain' })
    recoverStorePurchase.mockResolvedValueOnce({ kind: 'completed' })
    renderDialog(PRICED)
    await confirmAdopt()
    fireEvent.click(screen.getByRole('button', { name: /Buy/ }))

    await waitFor(() => expect(screen.getByText(/don’t know if your Protons were used/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }))

    await waitFor(() => expect(recoverStorePurchase).toHaveBeenCalledWith({
      accountId: 'account-a',
      itemId: 'mochi',
      kind: 'pet'
    }))
    await waitFor(() => expect(adoptPetFor).toHaveBeenCalled())
  })

  it('adopts an owned pet with one action — the entitlement is the purchase', async () => {
    renderDialog(petRow({ owned: true, price: { amount: 3000, kind: 'protons' }, storeItemId: 'mochi', storeOffer: MOCHI_OFFER }))
    await confirmAdopt()

    await waitFor(() => expect(adoptPetFor).toHaveBeenCalledWith(expect.anything(), 'mochi', 'default', expect.any(String)))
    expect(runStorePurchase).not.toHaveBeenCalled()
  })

  it('adopts a pet no catalog row claims exactly as today — free by source class', async () => {
    renderDialog(petRow())
    await confirmAdopt()

    await waitFor(() => expect(adoptPetFor).toHaveBeenCalledWith(expect.anything(), 'mochi', 'default', expect.any(String)))
    expect(runStorePurchase).not.toHaveBeenCalled()
  })

  it('acquires a free catalog pet through the purchase path — price 0 writes an entitlement too', async () => {
    const free = petRow({ storeItemId: 'mochi', storeOffer: { ...MOCHI_OFFER, priceProtons: 0 } })
    renderDialog(free)
    await confirmAdopt()

    await waitFor(() => expect(runStorePurchase).toHaveBeenCalledWith({
      accountId: 'account-a',
      itemId: 'mochi',
      kind: 'pet',
      offer: { ...MOCHI_OFFER, priceProtons: 0 }
    }))
    await waitFor(() => expect(adoptPetFor).toHaveBeenCalled())
  })

  it('never adopts a pet whose price is unknown — the catalog has not answered', async () => {
    // A bundled pet while the store catalog is idle/loading/error: no row
    // claims it YET, so it carries no storeItemId — but its price is unknown,
    // and unknown is unavailable, never free (review B10).
    renderDialog(petRow({ price: { kind: 'unavailable' } }))

    const confirm = screen.getByRole('button', { name: 'Adopt', hidden: false }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)

    fireEvent.click(confirm)
    await Promise.resolve()

    expect(adoptPetFor).not.toHaveBeenCalled()
    expect(runStorePurchase).not.toHaveBeenCalled()
  })
})
