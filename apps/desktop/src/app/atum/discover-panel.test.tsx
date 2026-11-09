import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom, computed } from 'nanostores'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'
import type { AtumAccountStatus } from '@/lib/atum-account-client'
import type * as AppSurfacesModule from '@/lib/atum-app-surfaces'
import type { AtumMessagingConversation, AtumSocialProjection } from '@/lib/atum-messaging-client'
import { type AtumStoreItemWire, projectSkillEntry } from '@/lib/atum-store-items'
import type * as PetGallery from '@/store/pet-gallery'

import type { AtumSkillRow } from './skills'

vi.mock('./discover-agents-section', () => ({ DiscoverAgentsSection: () => <div data-testid="discover-agents" /> }))

const agents = [
  { id: 'default', title: 'Atum', avatarUrl: null, hostedId: '00000000-0000-4000-8000-303617b97302', localProfileId: 'default', identityId: '00000000-0000-4000-8000-50d86b120e98' },
  { id: 'helper', title: 'An', avatarUrl: null, hostedId: '00000000-0000-4000-8000-00f765af1c54', localProfileId: 'helper', identityId: '00000000-0000-4000-8000-0bb5de138389' }
]

const $atumAgents = atom(agents)

/** The skills shelf's fixtures are store catalog rows now — the shelves read
 *  `$atumStoreCatalog`, not a constant compiled into the app. */
const skillItem = (id: string, identifier: string, featured: boolean, order: number): AtumStoreItemWire => ({
  accent: 'var(--atum-sunk)',
  detail: {
    description: { en: `${id} details`, vi: `Chi tiết ${id}` },
    needs: [],
    try_prompt: { en: `Try ${id}`, vi: `Thử ${id}` }
  },
  featured,
  glyph: '🔷',
  hashes: [],
  id,
  kind: 'skill',
  offer: { id: '00000000-0000-4000-8000-11e594f48195', price_protons: 0, version: 1 },
  sort_order: order,
  source: { identifier, type: 'hermes_optional' },
  summary: { en: `${id} summary`, vi: `Tóm tắt ${id}` },
  title: { en: id, vi: id }
})

const SKILL_ITEMS = [
  skillItem('concept-diagrams', 'official/creative/concept-diagrams', true, 1),
  skillItem('meme-generation', 'official/creative/meme-generation', true, 2),
  skillItem('stocks', 'official/finance/stocks', false, 3)
]

const SKILL_ENTRIES = SKILL_ITEMS.map(item => projectSkillEntry(item, false)!)

const skillRows = () =>
  SKILL_ENTRIES.map(entry => ({
    assistants: agents.map(agent => ({
      action: 'idle' as const,
      agentId: agent.id,
      installedName: null,
      lastLogLine: null
    })),
    entry,
    installedFor: [] as string[]
  }))

const $atumSkillRows = atom<AtumSkillRow[]>(skillRows())
const $atumSkillRefresh = atom({ error: null as null | string, state: 'ready' as const })
const addAtumSkill = vi.fn()
const loadAtumSkillPreview = vi.fn().mockResolvedValue({ files: ['SKILL.md'] })
const refreshAtumSkills = vi.fn().mockResolvedValue(undefined)
const removeAtumSkill = vi.fn()
const tryAtumSkill = vi.fn()

vi.mock('./agents', () => ({ $atumAgents, ATUM_AGENT_ID: 'default' }))
vi.mock('@/store/pet-gallery', async importOriginal => ({
  ...(await importOriginal<typeof PetGallery>()),
  loadPetGallery: vi.fn(async () => undefined),
  loadPetThumb: vi.fn(async () => null)
}))
vi.mock('./skills', () => ({
  $atumSkillRefresh,
  $atumSkillRows,
  addAtumSkill,
  loadAtumSkillPreview,
  refreshAtumSkills,
  removeAtumSkill,
  tryAtumSkill
}))

/** The store bridge's renderer side: the tests drive the catalog view and the
 *  purchase outcomes directly. */
vi.mock('@/store/atum-store-catalog', async () => {
  const { atom } = await import('nanostores')

  return {
    $atumStoreCatalog: atom({ accountId: 'a', catalog: null, state: 'ready' }),
    refreshAtumStoreCatalog: vi.fn(async () => null)
  }
})
vi.mock('@/store/atum-store-purchase', () => ({ recoverStorePurchase: vi.fn(), runStorePurchase: vi.fn() }))

const { $atumStoreCatalog: $storeView } = await import('@/store/atum-store-catalog')
const runStorePurchase = vi.mocked((await import('@/store/atum-store-purchase')).runStorePurchase)
const recoverStorePurchase = vi.mocked((await import('@/store/atum-store-purchase')).recoverStorePurchase)

const $atumAccountStatus = atom<AtumAccountStatus>({
  state: 'signed_in',
  configured: true,
  account: { id: 'a', displayName: 'Sample Member' },
  errorCode: null,
  providers: { google: true, password: true }
})

const $atumSortedRoster = atom<AtumMessagingConversation[]>([])
const ensureAtumSpecialistConversation = vi.fn()
const lookupAtumSocial = vi.fn()
const mutateAtumSocial = vi.fn()

vi.mock('@/store/atum-messaging', async () => ({
  $atumAccountScopeId: computed($atumAccountStatus, status => status.account?.id ?? null),
  $atumAccountStatus,
  $atumSortedRoster,
  ensureAtumSpecialistConversation,
  lookupAtumSocial,
  mutateAtumSocial
}))

const connectStatus = vi.fn()
const connectStart = vi.fn()
const catalog = vi.fn()
vi.mock('@/lib/atum-app-surfaces', async importOriginal => ({
  ...(await importOriginal<typeof AppSurfacesModule>()),
  atumAppSurfaceClient: () => ({ connectStatus, connectStart })
}))
const { clearAppConnectionState } = await import('./app-connection-state')
const { $atumAppCatalog, clearAtumAppCatalog, refreshAtumAppCatalog } = await import('@/lib/atum-app-catalog')

const { $discoverShelf, $railDestination, resetAtumShellState, setDiscoverShelf } = await import('@/store/atum-shell')
const { AtumDiscoverPanel } = await import('./discover-panel')

const person = (overrides: Record<string, unknown> = {}): AtumSocialProjection =>
  ({
    availability: 'available',
    profile: { profileId: 'p1', displayName: 'Lan', handle: 'lan', verified: false },
    state: 'none',
    version: 1,
    canMessage: false,
    directThreadId: null,
    ...overrides
  }) as AtumSocialProjection

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

function renderDiscover() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AtumDiscoverPanel />
      <LocationProbe />
    </MemoryRouter>
  )
}

beforeEach(() => {
  resetAtumShellState()
  clearAppConnectionState()
  clearAtumAppCatalog()
  connectStatus.mockReset().mockImplementation(async (app: string) => ({
    status: 'never_linked',
    connectionRequired: true,
    available: app === 'moon',
    readiness: 'not_linked'
  }))
  connectStart.mockReset().mockResolvedValue({ opened: true })
  catalog.mockReset().mockResolvedValue({ apps: [
    { app: 'moon', app_id: '00000000-0000-0000-0000-000000000001', app_version_id: '00000000-0000-0000-0000-000000000002', name: { en: 'Moon', vi: 'Moon' }, subtitle: { en: 'Astrology specialist', vi: 'Chiêm tinh' }, icon: null, verified: true, availability: 'available', supported_modes: ['direct'], link: { mode: 'none', state: 'never_linked' } },
    { app: 'andy', app_id: '00000000-0000-0000-0000-000000000003', app_version_id: '00000000-0000-0000-0000-000000000004', name: { en: 'Andy', vi: 'Andy' }, subtitle: { en: 'Emotional guide', vi: 'Đồng hành cảm xúc' }, icon: null, verified: true, availability: 'unavailable', supported_modes: ['direct'], link: { mode: 'none', state: 'never_linked' } }
  ] })
  ;(window as unknown as { hermesDesktop: { appSurface: { catalog: typeof catalog } } }).hermesDesktop = { appSurface: { catalog } }
  $atumSortedRoster.set([])
  ensureAtumSpecialistConversation.mockReset().mockResolvedValue('moon-conversation')
  lookupAtumSocial.mockReset()
  mutateAtumSocial.mockReset()
  addAtumSkill.mockReset().mockResolvedValue(undefined)
  refreshAtumSkills.mockReset().mockResolvedValue(undefined)
  tryAtumSkill.mockReset()
  runStorePurchase.mockReset().mockResolvedValue({ kind: 'completed' })
  recoverStorePurchase.mockReset().mockResolvedValue({ kind: 'failed' })
  $storeView.set({ accountId: 'a', catalog: null, state: 'ready' })
  $atumAgents.set(agents)
  $atumSkillRows.set(skillRows())
  $atumSkillRefresh.set({ error: null, state: 'ready' })
  $atumAccountStatus.set({
    state: 'signed_in',
    configured: true,
    account: { id: 'a', displayName: 'Sample Member' },
    errorCode: null,
    providers: { google: true, password: true }
  })
})
afterEach(cleanup)

describe('Discover — apps are a real list', () => {
  // Apps are a shelf of the storefront now: seed the arrival intent so the
  // panel opens on it (the switcher's state initializes from `$discoverShelf`).
  beforeEach(() => setDiscoverShelf('apps'))

  it('uses a newly registered third app without a client name branch', async () => {
    catalog.mockResolvedValue({ apps: [{ app: 'third-provider', app_id: '00000000-0000-0000-0000-000000000005', app_version_id: '00000000-0000-0000-0000-000000000006', name: { en: 'Third Provider', vi: 'Nhà cung cấp thứ ba' }, subtitle: { en: 'Direct help', vi: 'Hỗ trợ trực tiếp' }, icon: null, verified: false, availability: 'available', supported_modes: ['direct'], link: { mode: 'none', state: 'never_linked' } }] })
    ensureAtumSpecialistConversation.mockResolvedValue('andy-conversation')
    renderDiscover()
    await waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-discover-app="third-provider"]')).toBeTruthy())
    const card = document.querySelector<HTMLButtonElement>('[data-discover-app="third-provider"]')!
    expect(card.disabled).toBe(false)
    fireEvent.click(card)
    expect(ensureAtumSpecialistConversation).toHaveBeenCalledWith('third-provider')
  })

  it('lists the server catalog and marks unavailable registrations distinctly', async () => {
    const { container } = renderDiscover()
    await waitFor(() => expect(screen.getByText('Moon').closest('button')!.disabled).toBe(false))
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-discover-app]'))

    // Preserve the recovery and user-visible behavior covered by this path.
    expect(rows.length).toBe(2)
    expect(rows[0]!.getAttribute('data-discover-app')).toBe('moon')

    const unavailable = rows.filter(row => row.disabled)
    expect(unavailable.length).toBeGreaterThan(0)

    for (const row of unavailable) {
      expect(row.textContent).toContain('Coming soon')
    }

    // A control that promises nothing must do nothing.
    expect(rows[0]!.disabled).toBe(false)
    expect(rows[0]!.textContent).toContain('Open')
    expect(connectStart).not.toHaveBeenCalled()
  })

  it('keeps loading, empty, stale, and failed catalog states distinct', async () => {
    catalog.mockResolvedValueOnce({ apps: [] })
    renderDiscover()
    await waitFor(() => expect(screen.getByText('No apps are available for this account.')).toBeTruthy())
    cleanup()

    $atumAppCatalog.set({
      accountId: 'a',
      apps: [{ app: 'moon', app_id: '00000000-0000-0000-0000-000000000001', app_version_id: '00000000-0000-0000-0000-000000000002', name: { en: 'Moon', vi: 'Moon' }, subtitle: null, icon: null, verified: true, availability: 'available', supported_modes: ['direct'], link: { mode: 'none', state: 'never_linked' } }],
      state: 'ready'
    })
    catalog.mockImplementationOnce(() => new Promise(() => {}))
    renderDiscover()
    await waitFor(() => expect(screen.getByText('Showing saved app registrations while reconnecting.')).toBeTruthy())
    cleanup()

    clearAtumAppCatalog()
    catalog.mockRejectedValueOnce(new Error('catalog unavailable'))
    renderDiscover()
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  })

  it('does not let an old A request revive A after an A-to-B-to-A account handoff', async () => {
    let resolveOldA!: (value: { apps: Array<Record<string, unknown>> }) => void
    catalog.mockImplementationOnce(() => new Promise(resolve => { resolveOldA = resolve }))
    const oldA = refreshAtumAppCatalog('a', true)
    await Promise.resolve()
    clearAtumAppCatalog()
    catalog.mockResolvedValueOnce({ apps: [{ app: 'provider-b', app_id: '00000000-0000-0000-0000-000000000007', app_version_id: '00000000-0000-0000-0000-000000000008', name: { en: 'Provider B', vi: 'Nhà cung cấp B' }, subtitle: null, icon: null, verified: false, availability: 'available', supported_modes: ['direct'], link: { mode: 'none', state: 'never_linked' } }] })
    await refreshAtumAppCatalog('b', true)
    clearAtumAppCatalog()
    catalog.mockResolvedValueOnce({ apps: [{ app: 'fresh-a', app_id: '00000000-0000-0000-0000-000000000009', app_version_id: '00000000-0000-0000-0000-000000000010', name: { en: 'Fresh A', vi: 'A mới' }, subtitle: null, icon: null, verified: false, availability: 'available', supported_modes: ['direct'], link: { mode: 'none', state: 'never_linked' } }] })
    await refreshAtumAppCatalog('a', true)
    resolveOldA({ apps: [{ app: 'old-a', app_id: '00000000-0000-0000-0000-000000000011', app_version_id: '00000000-0000-0000-0000-000000000012', name: { en: 'Old A', vi: 'A cũ' }, subtitle: null, icon: null, verified: false, availability: 'available', supported_modes: ['direct'], link: { mode: 'none', state: 'never_linked' } }] })

    await expect(oldA).resolves.toEqual([])
    expect($atumAppCatalog.get()).toMatchObject({ accountId: 'a', apps: [expect.objectContaining({ app: 'fresh-a' })], state: 'ready' })
  })

  it('starts an app chat and hands the shell back to chat so the conversation is visible', async () => {
    // Rail first, shelf second — arriving at Discover reseeds Featured (the
    // `$railDestination.listen`), so the intent has to be planted after the flip.
    $railDestination.set('discover')
    setDiscoverShelf('apps')
    renderDiscover()

    await waitFor(() => expect(screen.getByText('Moon').closest('button')!.disabled).toBe(false))
    fireEvent.click(screen.getByText('Moon').closest('button')!)

    await waitFor(() => expect(ensureAtumSpecialistConversation).toHaveBeenCalledWith('moon'))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/dm/moon-conversation'))
    expect($railDestination.get()).toBe('chat')
    expect(connectStart).not.toHaveBeenCalled()
  })

  it('does not create a conversation or open a provider when registration is unavailable', async () => {
    catalog.mockResolvedValue({ apps: [{ app: 'moon', app_id: '00000000-0000-0000-0000-000000000001', app_version_id: '00000000-0000-0000-0000-000000000002', name: { en: 'Moon', vi: 'Moon' }, subtitle: null, icon: null, verified: true, availability: 'unavailable', supported_modes: ['direct'], link: { mode: 'none', state: 'never_linked' } }] })
    renderDiscover()
    await waitFor(() => expect(screen.getByText('Moon').closest('button')!.textContent).toContain('Coming soon'))
    fireEvent.click(screen.getByText('Moon').closest('button')!)
    expect(connectStart).not.toHaveBeenCalled()
    expect(ensureAtumSpecialistConversation).not.toHaveBeenCalled()
  })

  it('shows an already-connected app as connected and opens it without provisioning again', async () => {
    $atumSortedRoster.set([
      {
        id: 'c1',
        title: 'moon',
        kind: 'specialist',
        participantIds: ['moon'],
        updatedAt: '',
        lastMessageAt: '',
        unreadCount: 0,
        payload: { specialist: 'moon' }
      } as AtumMessagingConversation
    ])
    renderDiscover()

    await waitFor(() => expect(screen.getByText('Moon')).toBeTruthy())
    const moon = screen.getByText('Moon').closest('button')!
    expect(moon.textContent).toContain('Open')

    fireEvent.click(moon)

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/dm/c1'))
    expect(ensureAtumSpecialistConversation).not.toHaveBeenCalled()
  })
})

describe('Discover — the skills shelf reads the store catalog', () => {
  // The full skills list is the Skills shelf's body; Featured keeps only the
  // curated picks. Seed the shelf the way an entry point would.
  beforeEach(() => setDiscoverShelf('skills'))

  it('opens on Featured — the cross-catalog shelf — and renders exactly two featured cards', () => {
    setDiscoverShelf('featured')
    const { container } = renderDiscover()

    // Featured is the one shelf that shows more than one kind of thing:
    // curated skills and the pets teaser. Each other shelf waits its turn.
    expect(screen.getByTestId('discover-featured')).toBeTruthy()
    expect(screen.getByTestId('discover-pets')).toBeTruthy()
    expect(screen.queryByTestId('discover-skills')).toBeNull()
    expect(screen.queryByTestId('discover-apps')).toBeNull()
    expect(screen.queryByTestId('discover-people')).toBeNull()
    expect(container.querySelectorAll('[data-featured-skill]')).toHaveLength(2)
  })

  it('opens the add dialog from Free and confirms the default assistant once', async () => {
    const { container } = renderDiscover()
    const row = container.querySelector(`[data-skill-row="${SKILL_ENTRIES[0]!.identifier}"]`)!
    fireEvent.click(row.querySelector('button:last-child')!)

    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.atum.discover.add }))
    await waitFor(() => expect(addAtumSkill).toHaveBeenCalledWith(SKILL_ENTRIES[0], ['default']))
  })

  it('derives busy, installed and failed pills from assistant state', () => {
    const entry = SKILL_ENTRIES[0]!
    $atumSkillRows.set(
      skillRows().map(row =>
        row.entry === entry
          ? {
              ...row,
              assistants: [
                { action: 'failed', agentId: 'default', installedName: null, lastLogLine: 'Network unavailable' },
                row.assistants[1]!
              ]
            }
          : row
      )
    )
    const { container } = renderDiscover()
    const failedRow = container.querySelector(`[data-skill-row="${entry.identifier}"]`)!
    expect(failedRow.textContent).toContain('Try again')
    expect(failedRow.textContent).toContain('Network unavailable')

    // Store writes outside React's event system must be flushed through act()
    // before the DOM is read, or the assertion races the re-render.
    act(() => {
      $atumSkillRows.set(
        skillRows().map(row =>
          row.entry === entry
            ? {
                ...row,
                assistants: [
                  { action: 'installing', agentId: 'default', installedName: null, lastLogLine: null },
                  row.assistants[1]!
                ]
              }
            : row
        )
      )
    })
    expect(failedRow.querySelector('[aria-busy="true"]')).toBeTruthy()

    act(() => {
      $atumSkillRows.set(
        skillRows().map(row =>
          row.entry === entry
            ? {
                ...row,
                assistants: [
                  { action: 'idle', agentId: 'default', installedName: 'concept-diagrams', lastLogLine: null },
                  row.assistants[1]!
                ],
                installedFor: ['default']
              }
            : row
        )
      )
    })
    expect(failedRow.textContent).toContain('Try')
  })

  it('tries with the localized catalog prompt and installed assistant', () => {
    const entry = SKILL_ENTRIES[0]!
    $atumSkillRows.set(
      skillRows().map(row =>
        row.entry === entry
          ? {
              ...row,
              assistants: [
                { action: 'idle', agentId: 'default', installedName: 'concept-diagrams', lastLogLine: null },
                row.assistants[1]!
              ],
              installedFor: ['default']
            }
          : row
      )
    )
    const { container } = renderDiscover()
    const row = container.querySelector(`[data-skill-row="${entry.identifier}"]`)!
    fireEvent.click(row.querySelector('button:last-child')!)
    expect(tryAtumSkill).toHaveBeenCalledWith(entry.tryPrompt.en, 'default', entry)
  })

  it('refreshes when an assistant is replaced without the count changing', async () => {
    renderDiscover()
    await waitFor(() => expect(refreshAtumSkills).toHaveBeenCalledTimes(1))

    act(() => {
      $atumAgents.set([agents[0]!, { ...agents[1]!, id: 'newcomer', title: 'Bảo' }])
    })

    await waitFor(() => expect(refreshAtumSkills).toHaveBeenCalledTimes(2))
  })

  it('explains a failed install in the product language with the raw line underneath', () => {
    const entry = SKILL_ENTRIES[0]!
    $atumSkillRows.set(
      skillRows().map(row =>
        row.entry === entry
          ? {
              ...row,
              assistants: [
                { action: 'failed', agentId: 'default', installedName: null, lastLogLine: 'Network unavailable' },
                row.assistants[1]!
              ]
            }
          : row
      )
    )
    const { container } = renderDiscover()
    const row = container.querySelector(`[data-skill-row="${entry.identifier}"]`)!

    expect(row.textContent).toContain("Couldn't add for Atum.")
    expect(row.textContent).toContain('Network unavailable')
  })

  it('keeps people search inside People and leaves it unfocused on mount', () => {
    setDiscoverShelf('people')
    renderDiscover()
    const people = screen.getByTestId('discover-people')
    const field = screen.getByRole('textbox', { name: 'Enter an exact @name' })
    expect(people.contains(field)).toBe(true)
    expect(globalThis.document.activeElement).not.toBe(field)
  })
})

describe('Discover — people are searched, never browsed', () => {
  // People is its own shelf: a rate-limited network lookup, never mixed into
  // another shelf's local filter (per-shelf search is a decision).
  beforeEach(() => setDiscoverShelf('people'))

  it('says plainly that people are found by exact name, and never renders a directory', () => {
    const { container } = renderDiscover()

    expect(screen.getByText('Find someone by their exact @name. Atum does not list its users.')).toBeTruthy()
    // There is no people-listing endpoint; an empty list would read as broken.
    expect(container.querySelectorAll('[data-discover-person]')).toHaveLength(0)
  })

  it('refuses to spend a rate-limited lookup on a query the server would reject', () => {
    renderDiscover()

    fireEvent.change(screen.getByRole('textbox', { name: 'Enter an exact @name' }), { target: { value: 'la' } })

    expect(screen.getByText('Enter at least 3 characters.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Search Atum/ })).toBeNull()
    expect(lookupAtumSocial).not.toHaveBeenCalled()
  })

  it('finds a person and connects, landing in the direct thread once messaging opens', async () => {
    lookupAtumSocial.mockResolvedValue(person())
    mutateAtumSocial.mockResolvedValue(person({ state: 'connected', canMessage: true, directThreadId: 'dm-9' }))
    renderDiscover()

    fireEvent.change(screen.getByRole('textbox', { name: 'Enter an exact @name' }), { target: { value: 'lan' } })
    fireEvent.click(screen.getByRole('button', { name: /Search Atum/ }))

    await waitFor(() => expect(screen.getByText('Lan')).toBeTruthy())
    expect(screen.getByText('@lan')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(mutateAtumSocial).toHaveBeenCalledWith('request', 'p1'))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/dm/dm-9'))
  })

  it('offers accept and decline for an incoming request', async () => {
    lookupAtumSocial.mockResolvedValue(person({ state: 'incoming_pending' }))
    mutateAtumSocial.mockResolvedValue(person({ state: 'none' }))
    renderDiscover()

    fireEvent.change(screen.getByRole('textbox', { name: 'Enter an exact @name' }), { target: { value: 'lan' } })
    fireEvent.click(screen.getByRole('button', { name: /Search Atum/ }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))

    await waitFor(() => expect(mutateAtumSocial).toHaveBeenCalledWith('decline', 'p1'))
  })

  it('reports a rate limit as a wait, and a failure as retryable, without inventing a result', async () => {
    lookupAtumSocial.mockRejectedValue(new Error('rate_limited 429'))
    renderDiscover()

    fireEvent.change(screen.getByRole('textbox', { name: 'Enter an exact @name' }), { target: { value: 'lan' } })
    fireEvent.click(screen.getByRole('button', { name: /Search Atum/ }))

    await waitFor(() => expect(screen.getByText(/searching a bit fast/)).toBeTruthy())
    expect(screen.queryByText('Lan')).toBeNull()

    cleanup()
    lookupAtumSocial.mockRejectedValue(new Error('boom'))
    renderDiscover()
    fireEvent.change(screen.getByRole('textbox', { name: 'Enter an exact @name' }), { target: { value: 'lan' } })
    fireEvent.click(screen.getByRole('button', { name: /Search Atum/ }))

    await waitFor(() => expect(screen.getByText(/Search failed/)).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('hides people search while signed out but still shows the app list', () => {
    $atumAccountStatus.set({
      state: 'signed_out',
      configured: true,
      account: null,
      errorCode: null,
      providers: { google: true, password: true }
    })
    const { container } = renderDiscover()

    expect(screen.queryByRole('textbox', { name: 'Enter an exact @name' })).toBeNull()
    expect(screen.getByText('Sign in to find people on Atum.')).toBeTruthy()
    expect(container.querySelectorAll('[data-discover-app]').length).toBe(0)
  })

  it('lets a connected person be blocked, the one control the roster used to carry', async () => {
    lookupAtumSocial.mockResolvedValue(person({ state: 'connected', canMessage: true, directThreadId: 't1' }))
    mutateAtumSocial.mockResolvedValue(person({ state: 'blocked_by_me', canMessage: false, directThreadId: null }))
    renderDiscover()

    fireEvent.change(screen.getByRole('textbox', { name: 'Enter an exact @name' }), { target: { value: 'lan' } })
    fireEvent.click(screen.getByRole('button', { name: /Search Atum/ }))

    await screen.findByText('Lan')
    fireEvent.click(screen.getByRole('button', { name: 'Block' }))

    await waitFor(() => expect(mutateAtumSocial).toHaveBeenCalledWith('block', 'p1'))
  })

  it('lets the newest lookup win when an older one resolves after it', async () => {
    // "alice" is asked for first but answers last. The user is looking at the
    // result for "bob", and must keep looking at it.
    let settleAlice: (value: AtumSocialProjection) => void = () => {}
    lookupAtumSocial
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            settleAlice = resolve
          })
      )
      .mockResolvedValueOnce(
        person({ profile: { profileId: 'p2', displayName: 'Bob', handle: 'bob', verified: false } })
      )

    renderDiscover()
    const field = screen.getByRole('textbox', { name: 'Enter an exact @name' })

    fireEvent.change(field, { target: { value: 'alice' } })
    fireEvent.click(screen.getByRole('button', { name: /Search Atum/ }))

    fireEvent.change(field, { target: { value: 'bob' } })
    fireEvent.click(screen.getByRole('button', { name: /Search Atum/ }))
    await screen.findByText('Bob')

    settleAlice(person({ profile: { profileId: 'p1', displayName: 'Alice', handle: 'alice', verified: false } }))

    await waitFor(() => expect(screen.queryByText('Alice')).toBeNull())
    expect(screen.getByText('Bob')).toBeTruthy()
  })

  it('does not fire a second lookup while one is still in flight', () => {
    // The search affordance is replaced by the "searching" line once a lookup
    // starts, so the repeat path is the form: Enter, Enter, Enter.
    lookupAtumSocial.mockImplementation(() => new Promise(() => {}))
    const { container } = renderDiscover()
    const form = container.querySelector('form')!

    fireEvent.change(screen.getByRole('textbox', { name: 'Enter an exact @name' }), { target: { value: 'lan' } })
    fireEvent.submit(form)
    fireEvent.submit(form)
    fireEvent.submit(form)

    expect(lookupAtumSocial).toHaveBeenCalledTimes(1)
  })

  it('searches for the @name the field asks for, without the @', () => {
    // The placeholder says "Nhập đúng @tên", so people type the @. It is not
    // part of the handle.
    lookupAtumSocial.mockImplementation(() => new Promise(() => {}))
    const { container } = renderDiscover()

    fireEvent.change(screen.getByRole('textbox', { name: 'Enter an exact @name' }), {
      target: { value: '@sample.member' }
    })
    fireEvent.submit(container.querySelector('form')!)

    expect(lookupAtumSocial).toHaveBeenCalledWith('sample.member')
  })

  it('searches on Enter instead of wiping the field', async () => {
    // SearchField renders a clear button once the field has a value. A bare
    // <button> defaults to type="submit", so it used to become the form's
    // implicit submit target: Enter cleared the query, the query change bumped
    // the request ticket, and the in-flight answer was discarded. Nothing at
    // all appeared.
    lookupAtumSocial.mockResolvedValue(
      person({ profile: { profileId: 'p9', displayName: 'Sample Member', handle: 'sample.member', verified: false } })
    )
    const { container } = renderDiscover()
    const field = screen.getByRole('textbox', { name: 'Enter an exact @name' })

    fireEvent.change(field, { target: { value: '@sample.member' } })
    fireEvent.submit(container.querySelector('form')!)

    expect(await screen.findByText('Sample Member')).toBeTruthy()
    expect((field as HTMLInputElement).value).toBe('@sample.member')
  })
})


describe('Discover — one storefront, one shelf at a time', () => {
  it('lists every shelf in App Store order, Featured current by default', () => {
    const { container } = renderDiscover()
    const tabs = Array.from(container.querySelectorAll('[data-atum-shelf]')).map(el => el.getAttribute('data-atum-shelf'))

    expect(tabs).toEqual(['featured', 'agents', 'skills', 'apps', 'pets', 'people'])
    expect(container.querySelector('[data-atum-shelf="featured"]')!.getAttribute('aria-current')).toBe('page')
  })

  it('opens on the shelf the arrival intent seeded', () => {
    setDiscoverShelf('skills')
    renderDiscover()

    expect(screen.getByTestId('discover-skills')).toBeTruthy()
    expect(screen.queryByTestId('discover-featured')).toBeNull()
    expect(document.querySelector('[data-atum-shelf="skills"]')!.getAttribute('aria-current')).toBe('page')
  })

  it('switches shelves from the switcher without writing the intent atom back', () => {
    // The atom is an arrival intent, not panel truth: a docked pane reads its
    // shelf identity from its path, so a switch here must retarget nothing.
    renderDiscover()

    fireEvent.click(document.querySelector('[data-atum-shelf="people"]')!)

    expect(screen.getByTestId('discover-people')).toBeTruthy()
    expect(screen.queryByTestId('discover-featured')).toBeNull()
    expect($discoverShelf.get()).toBe('featured')
  })

  it('re-reads the seed on a fresh arrival', () => {
    setDiscoverShelf('skills')
    const first = renderDiscover()
    expect(screen.getByTestId('discover-skills')).toBeTruthy()
    first.unmount()

    // Leaving Discover unmounts the panel; the next visit initializes from
    // whatever the new arrival seeded — never from the last visit's switch.
    setDiscoverShelf('people')
    renderDiscover()

    expect(screen.getByTestId('discover-people')).toBeTruthy()
    expect(screen.queryByTestId('discover-skills')).toBeNull()
  })

  it('adopts an intent planted while the panel is already open', () => {
    // The account menu's "Pet Store…" finds Discover already showing: the rail
    // doesn't move, only the seed changes — and the shelf must follow.
    renderDiscover()

    act(() => setDiscoverShelf('skills'))

    expect(screen.getByTestId('discover-skills')).toBeTruthy()
    expect(screen.queryByTestId('discover-featured')).toBeNull()
  })

  it('opens the monthly hiring shelf from Agents', () => {
    const { container } = renderDiscover()
    const agentsTab = container.querySelector('[data-atum-shelf="agents"]')!
    fireEvent.click(agentsTab)
    expect(agentsTab.getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('discover-agents')).toBeTruthy()
    expect(screen.queryByTestId('discover-featured')).toBeNull()
  })

  it('renders the Pet Store as the Pets shelf, in place of the shelf bodies', () => {
    setDiscoverShelf('pets')
    const { container } = renderDiscover()

    expect(container.querySelector('[data-atum-pet-store]')).toBeTruthy()
    expect(screen.queryByTestId('discover-featured')).toBeNull()
    expect(screen.queryByTestId('discover-apps')).toBeNull()
  })

  it('opens the Pets shelf from the Featured teaser without leaving the rail', () => {
    renderDiscover()

    fireEvent.click(document.querySelector('[data-atum-open-pet-store]')!)

    // No eject to a /pets page: the rail is (still) Discover and the store
    // renders in place as the Pets shelf.
    expect(document.querySelector('[data-atum-pet-store]')).toBeTruthy()
    expect($railDestination.get()).toBe('discover')
    expect($discoverShelf.get()).toBe('pets')
  })

  it('links the Skills shelf out to Capabilities — managing stays there', () => {
    setDiscoverShelf('skills')
    renderDiscover()

    fireEvent.click(document.querySelector('[data-atum-manage-skills]')!)

    // Rail first, navigate second: Discover suppresses the workspace while it
    // is the destination, so the link hands the plate back to chat en route.
    expect($railDestination.get()).toBe('chat')
    expect(screen.getByTestId('location').textContent).toBe('/skills')
  })
})
