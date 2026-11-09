import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { atom, computed } from 'nanostores'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtumAccountStatus } from '@/lib/atum-account-client'
import type * as AppSurfacesModule from '@/lib/atum-app-surfaces'
import type { AtumMessagingConversation } from '@/lib/atum-messaging-client'
import type { AtumDiscoverShelf } from '@/store/atum-shell'
import type * as PetGallery from '@/store/pet-gallery'

/**
 * Re-entering a shelf: an entry point that finds Discover already showing must
 * retarget it even when the shelf it names is the one already seeded. The seed
 * value cannot carry that (nanostores skips an unchanged set); the nonce can.
 */

const $atumAgents = atom([{ id: 'default', title: 'Atum', avatarUrl: null }])

vi.mock('./agents', () => ({ $atumAgents, ATUM_AGENT_ID: 'default' }))
vi.mock('@/store/pet-gallery', async importOriginal => ({
  ...(await importOriginal<typeof PetGallery>()),
  loadPetGallery: vi.fn(async () => undefined),
  loadPetThumb: vi.fn(async () => null)
}))
vi.mock('./skills', () => ({
  $atumSkillRefresh: atom({ error: null, state: 'ready' }),
  $atumSkillRows: atom([]),
  addAtumSkill: vi.fn(),
  loadAtumSkillPreview: vi.fn(async () => ({ files: ['SKILL.md'] })),
  refreshAtumSkills: vi.fn(async () => undefined),
  removeAtumSkill: vi.fn(),
  tryAtumSkill: vi.fn()
}))
vi.mock('@/store/atum-store-catalog', async () => {
  const { atom: makeAtom } = await import('nanostores')

  return {
    $atumStoreCatalog: makeAtom({ accountId: 'a', catalog: null, state: 'ready' }),
    refreshAtumStoreCatalog: vi.fn(async () => null)
  }
})
vi.mock('@/store/atum-store-purchase', () => ({ recoverStorePurchase: vi.fn(), runStorePurchase: vi.fn() }))

const $atumAccountStatus = atom<AtumAccountStatus>({
  state: 'signed_in',
  configured: true,
  account: { id: 'a', displayName: 'Minh' },
  errorCode: null,
  providers: { google: true, password: true }
})

const $atumSortedRoster = atom<AtumMessagingConversation[]>([])

// Spread the real module and pin only what the panel drives: a hand-picked
// partial mock breaks each time the store chain reaches one more export.
vi.mock('@/store/atum-messaging', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  $atumAccountScopeId: computed($atumAccountStatus, status => status.account?.id ?? null),
  $atumAccountStatus,
  $atumSortedRoster,
  ensureAtumSpecialistConversation: vi.fn(),
  lookupAtumSocial: vi.fn(),
  mutateAtumSocial: vi.fn()
}))

const catalog = vi.fn()
vi.mock('@/lib/atum-app-surfaces', async importOriginal => ({
  ...(await importOriginal<typeof AppSurfacesModule>()),
  atumAppSurfaceClient: () => ({ connectStart: vi.fn(), connectStatus: vi.fn() })
}))

const { $discoverShelf, $railDestination, resetAtumShellState, setDiscoverShelf } = await import('@/store/atum-shell')
const { clearAtumAppCatalog } = await import('@/lib/atum-app-catalog')
const { AtumDiscoverPanel } = await import('./discover-panel')
const { useOpenStorefront } = await import('./use-open-storefront')

/** An entry point — the account menu's "Pet Store…", the floating pet's — as it
 *  really calls the opener. */
function EntryPoint({ shelf }: { shelf: AtumDiscoverShelf }) {
  const openStorefront = useOpenStorefront()

  return <button data-testid="entry" onClick={() => openStorefront(shelf)} type="button">open</button>
}

function renderDiscoverWithEntry(shelf: AtumDiscoverShelf = 'pets') {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AtumDiscoverPanel />
      <EntryPoint shelf={shelf} />
    </MemoryRouter>
  )
}

const currentShelf = () => document.querySelector('[data-atum-shelf][aria-current="page"]')?.getAttribute('data-atum-shelf')

beforeEach(() => {
  resetAtumShellState()
  clearAtumAppCatalog()
  catalog.mockReset().mockResolvedValue({ apps: [] })
  ;(window as unknown as { hermesDesktop: { appSurface: { catalog: typeof catalog } } }).hermesDesktop = { appSurface: { catalog } }
})

afterEach(cleanup)

describe('an entry point that finds Discover already showing', () => {
  it('re-opens the seeded shelf after the user switched away from it', () => {
    // Arrival on pets; the user then switches to the Skills shelf. The seed
    // still holds 'pets', so the old code's no-op set notified nobody.
    act(() => $railDestination.set('discover'))
    act(() => setDiscoverShelf('pets'))
    renderDiscoverWithEntry('pets')

    expect(currentShelf()).toBe('pets')

    fireEvent.click(document.querySelector('[data-atum-shelf="skills"]')!)
    expect(currentShelf()).toBe('skills')

    fireEvent.click(screen.getByTestId('entry'))

    expect(currentShelf()).toBe('pets')
  })

  it('works repeatedly: arrival, switch away, entry again', () => {
    act(() => $railDestination.set('discover'))
    renderDiscoverWithEntry('pets')

    expect(currentShelf()).toBe('featured')

    fireEvent.click(screen.getByTestId('entry'))
    expect(currentShelf()).toBe('pets')

    fireEvent.click(document.querySelector('[data-atum-shelf="apps"]')!)
    expect(currentShelf()).toBe('apps')

    // The seed never moved off 'pets' — the second entry is the same no-op
    // set that used to look dead.
    expect($discoverShelf.get()).toBe('pets')
    fireEvent.click(screen.getByTestId('entry'))
    expect(currentShelf()).toBe('pets')
  })
})
