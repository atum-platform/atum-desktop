import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { atom, computed } from 'nanostores'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtumAccountStatus } from '@/lib/atum-account-client'
import type { AtumMessagingConversation, AtumSocialProjection } from '@/lib/atum-messaging-client'
import type * as ProfileStore from '@/store/profile'
import type { ProfileInfo } from '@/types/hermes'

// The real one opens the agent's backend over a socket, which a DOM test has
// no business doing. What the roster owes the user is the pointer: the next
// chat belongs to this agent.
const newSessionInProfile = vi.fn()

vi.mock('@/store/profile', async importOriginal => ({
  ...(await importOriginal<typeof ProfileStore>()),
  newSessionInProfile
}))

const $atumAccountStatus = atom<AtumAccountStatus>({
  state: 'signed_in',
  configured: true,
  account: { id: 'a', displayName: 'Minh' },
  errorCode: null,
  providers: { google: true, password: true }
})

const $atumConnectivity = atom('online')
const $atumSortedRoster = atom<AtumMessagingConversation[]>([])
const $atumSocialRelationships = atom<AtumSocialProjection[]>([])
const refreshAtumRoster = vi.fn()
const refreshAtumStatus = vi.fn()
const ensureAtumSpecialistConversation = vi.fn()

vi.mock('@/store/atum-messaging', async () => ({
  $atumAccountScopeId: computed($atumAccountStatus, status => status.account?.id ?? null),
  $atumAccountStatus,
  $atumConnectivity,
  $atumSocialRelationships,
  $atumSortedRoster,
  $atumRoster: $atumSortedRoster,
  $atumIsAuthenticated: computed($atumAccountStatus, status => status.state === 'signed_in'),
  ensureAtumSpecialistConversation,
  refreshAtumRoster,
  refreshAtumStatus
}))

const { $atumDmArtifactByConversation } = await import('@/store/atum-dm-workspace')
const { $sessions, $unreadFinishedSessionIds } = await import('@/store/session')
const { $newChatProfile, $profiles } = await import('@/store/profile')
const { $discoverShelf, $railDestination, resetAtumShellState } = await import('@/store/atum-shell')
const { $atumAppCatalog } = await import('@/lib/atum-app-catalog')

const { $atumAgentOrder, $atumAgentPins, reorderAtumAgents, resetAtumAgentArrangement, setAtumAgentPinned } =
  await import('./agents')

const { AtumRosterPanel } = await import('./roster-panel')
const { $appViewOverlayCount } = await import('@/store/app-view-overlay')

const agentProfile = (name: string, displayName: string, avatar = ''): ProfileInfo =>
  ({
    avatar,
    display_name: displayName,
    has_env: true,
    is_default: false,
    managed_by: 'atum',
    model: 'm',
    name,
    path: `/h/profiles/${name}`,
    provider: null,
    skill_count: 1
  }) as ProfileInfo

const masterProfile: ProfileInfo = {
  has_env: true,
  is_default: true,
  model: 'm',
  name: 'default',
  path: '/h',
  provider: null,
  skill_count: 1
}

/** Radix opens a dropdown on pointer down, not on click. */
function openMenu(trigger: Element) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
}

const conversation = (overrides: Partial<AtumMessagingConversation> = {}): AtumMessagingConversation => ({
  id: 'c1',
  title: 'moon',
  kind: 'specialist',
  participantIds: ['moon'],
  updatedAt: '2026-08-12T00:00:00.000Z',
  lastMessageAt: '2026-08-12T00:00:00.000Z',
  unreadCount: 0,
  payload: { specialist: 'moon' },
  ...overrides
})

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

function renderPanel(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AtumRosterPanel />
      <LocationProbe />
    </MemoryRouter>
  )
}

afterEach(cleanup)

it.each(['agent', 'account'] as const)('closes the %s portal on hide and layout change without reopening it', async kind => {
  $profiles.set([masterProfile, agentProfile('marketing', 'Marketing')])

  const element = (visible: boolean, drawer = false) => <MemoryRouter>
    <AtumRosterPanel drawer={drawer} visible={visible} />
  </MemoryRouter>

  const view = render(element(true))
  const trigger = view.container.querySelector(kind === 'agent' ? '[data-agent-group="marketing"] [data-atum-agent-menu]' : '[data-atum-account-trigger]')!
  const baseline = $appViewOverlayCount.get()
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  expect(await screen.findByRole('menu')).toBeTruthy()
  expect($appViewOverlayCount.get()).toBeGreaterThan(baseline)
  view.rerender(element(false))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  await waitFor(() => expect($appViewOverlayCount.get()).toBe(baseline))
  view.rerender(element(true))
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  expect(await screen.findByRole('menu')).toBeTruthy()
  view.rerender(element(true, true))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  await waitFor(() => expect($appViewOverlayCount.get()).toBe(baseline))
})

it('keeps a modal draft and its native-overlay hold through roster hide and resize', async () => {
  const element = (visible: boolean, drawer = false) => <MemoryRouter>
    <AtumRosterPanel drawer={drawer} visible={visible} />
  </MemoryRouter>

  const view = render(element(true))
  const baseline = $appViewOverlayCount.get()
  fireEvent.click(view.container.querySelector('[data-atum-create-agent]')!)
  const dialog = await screen.findByRole('dialog')
  const name = within(dialog).getByLabelText('Name') as HTMLInputElement
  fireEvent.change(name, { target: { value: 'Retained assistant draft' } })
  view.rerender(element(false))
  view.rerender(element(true, true))
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(name.value).toBe('Retained assistant draft')
  expect($appViewOverlayCount.get()).toBeGreaterThan(baseline)
  fireEvent.keyDown(dialog, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect($appViewOverlayCount.get()).toBe(baseline))
})

beforeEach(() => {
  const apps = [
    { app: 'moon', app_id: '00000000-0000-0000-0000-000000000001', app_version_id: '00000000-0000-0000-0000-000000000002', name: { en: 'Moon', vi: 'Moon' }, subtitle: { en: 'Astrology specialist', vi: 'Chuyên gia chiêm tinh' }, icon: null, verified: true, availability: 'available' as const, supported_modes: ['direct' as const], link: { mode: 'none' as const, state: 'never_linked' as const } },
    { app: 'andy', app_id: '00000000-0000-0000-0000-000000000003', app_version_id: '00000000-0000-0000-0000-000000000004', name: { en: 'Andy', vi: 'Andy' }, subtitle: { en: 'Mental & emotional guide', vi: 'Người đồng hành tinh thần' }, icon: null, verified: true, availability: 'unavailable' as const, supported_modes: ['direct' as const], link: { mode: 'none' as const, state: 'never_linked' as const } },
    { app: 'taylor', app_id: '00000000-0000-0000-0000-000000000005', app_version_id: '00000000-0000-0000-0000-000000000006', name: { en: 'Taylor', vi: 'Taylor' }, subtitle: { en: 'Financial research specialist', vi: 'Chuyên gia tài chính' }, icon: null, verified: true, availability: 'unavailable' as const, supported_modes: ['direct' as const], link: { mode: 'none' as const, state: 'never_linked' as const } }
  ]

  $atumAppCatalog.set({ accountId: 'a', apps, state: 'ready' })
  ;(window as unknown as { hermesDesktop: { appSurface: { catalog: () => Promise<{ apps: typeof apps }> } } }).hermesDesktop = { appSurface: { catalog: async () => ({ apps }) } }
  resetAtumShellState()
  resetAtumAgentArrangement()
  $profiles.set([])
  $newChatProfile.set(null)
  newSessionInProfile.mockReset()
  newSessionInProfile.mockImplementation((name: string) => $newChatProfile.set(name))
  $sessions.set([])
  $unreadFinishedSessionIds.set([])
  refreshAtumRoster.mockClear()
  refreshAtumStatus.mockClear()
  ensureAtumSpecialistConversation.mockReset()
  ensureAtumSpecialistConversation.mockResolvedValue('moon-conversation')
  $atumConnectivity.set('online')
  $atumSortedRoster.set([])
  $atumSocialRelationships.set([])
  $atumDmArtifactByConversation.set({})
  $atumAccountStatus.set({
    state: 'signed_in',
    configured: true,
    account: { id: 'a', displayName: 'Minh' },
    errorCode: null,
    providers: { google: true, password: true }
  })
  $atumAppCatalog.set({ accountId: 'a', apps, state: 'ready' })
})

describe('AtumRosterPanel — people', () => {
  const directThread = (overrides: Partial<AtumMessagingConversation> = {}): AtumMessagingConversation =>
    conversation({
      id: 'thread-1',
      kind: 'direct',
      title: null,
      participantIds: ['a', 'peer'],
      payload: {
        participants: [
          { type: 'user', id: 'a', display_name: 'Minh' },
          { type: 'user', id: 'peer', display_name: 'Lan' }
        ]
      },
      ...overrides
    })

  it('lists a direct thread under the peer name, never a placeholder', () => {
    $atumSortedRoster.set([directThread()])

    const { container } = renderPanel()

    const labels = Array.from(container.querySelectorAll('[data-roster-list] [data-roster-row]')).map(row =>
      row.getAttribute('aria-label')
    )

    expect(labels[1]).toBe('Lan')
    expect(labels.join('\n')).not.toContain('Conversation')
  })

  it('places agent and chat sections in order and puts creation actions beside search', async () => {
    const { container } = renderPanel()
    expect(Array.from(container.querySelectorAll('[data-atum-section-label]')).map(node => node.textContent)).toEqual(['Assistants', 'Chats'])
    expect(container.querySelector('[data-atum-new-conversation]')).toBeNull()

    // The plus opens the directory — who you can talk to — rather than a menu
    // whose headline item duplicated the master's own row.
    fireEvent.click(container.querySelector('[data-atum-create-menu]')!)
    const picker = await screen.findByRole('dialog')
    expect(picker.textContent).toContain('Start a chat')
    expect(within(picker).getByTestId('atum-start-chat-friends')).toBeTruthy()
    expect(within(picker).getByTestId('atum-start-chat-agent')).toBeTruthy()
    expect(within(picker).getAllByText('Atum').length).toBeGreaterThan(0)
  })

  it('points the composer at the assistant picked from the plus directory', async () => {
    $profiles.set([
      { has_env: true, is_default: true, model: 'm', name: 'default', path: '/h', provider: null, skill_count: 1 },
      {
        display_name: 'Marketing',
        has_env: true,
        is_default: false,
        managed_by: 'atum',
        model: 'm',
        name: 'marketing',
        path: '/h/profiles/marketing',
        provider: null,
        skill_count: 1
      } as ProfileInfo
    ])

    const { container } = renderPanel('/somewhere')

    fireEvent.click(container.querySelector('[data-atum-create-menu]')!)
    const picker = await screen.findByRole('dialog')
    fireEvent.click(within(picker).getByText('Marketing').closest('[data-atum-start-chat-row]')!)

    // Picking WHO closes the directory and aims the composer at them, which is
    // the whole of what "start a chat" means here.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(newSessionInProfile).toHaveBeenCalledWith('marketing')
    expect(screen.getByTestId('location').textContent).toBe('/')
  })

  it('does not list a direct thread whose peer cannot be named', () => {
    $atumSortedRoster.set([directThread({ payload: {} })])

    const { container } = renderPanel()

    const labels = Array.from(container.querySelectorAll('[data-roster-list] [data-roster-row]')).map(row =>
      row.getAttribute('aria-label')
    )

    expect(labels).toEqual(['Atum, Start a new chat', expect.stringMatching(/^Moon, Atum app/)])
    expect(container.textContent).not.toContain('Conversation')
  })

  it('no longer owns discovery: no compass, no catalog, no people search in the roster', () => {
    const { container } = renderPanel()

    // Discovery moved to its own rail destination. The roster is one list of
    // conversations again, and its search filters that list only.
    expect(container.querySelector('[data-roster-discover]')).toBeNull()
    expect(screen.queryByTestId('discover-catalog')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Find people on Atum' })).toBeNull()
    expect(screen.getByPlaceholderText('Search everything')).toBeTruthy()
  })

  it('keeps a way out when a roster search finds nothing, pointing at Discover', () => {
    const { container } = renderPanel()

    fireEvent.change(screen.getByPlaceholderText('Search everything'), { target: { value: 'nobodyhere' } })

    expect(screen.getByText('No results found')).toBeTruthy()
    const escape = container.querySelector<HTMLButtonElement>('[data-roster-empty-discover]')!
    expect(escape.textContent).toBe('Find people on Atum')

    // The button says "Find people on Atum", so it must land on the People
    // shelf. It used to flip the rail bare and take whatever the arrival
    // reseed gave it — Featured — and this assertion pinned that as if it were
    // the intent. A stale seed from an earlier visit still does not survive.
    $discoverShelf.set('pets')
    fireEvent.click(escape)
    expect($railDestination.get()).toBe('discover')
    expect($discoverShelf.get()).toBe('people')
  })
})

describe('AtumRosterPanel — directory shape', () => {
  it('opens Moon for a brand-new account by ensuring its hosted conversation first', async () => {
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: /^Moon, Atum app/ }))

    await waitFor(() => expect(ensureAtumSpecialistConversation).toHaveBeenCalledWith('moon'))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/dm/moon-conversation'))
  })

  it('returns the plate to chat when a roster row is opened from Discover', async () => {
    // The roster stays on screen while Discover owns the chat plate. Without
    // this, clicking a row changed the route under a surface still showing
    // Discover: the URL and the selection moved, the conversation did not.
    $railDestination.set('discover')
    $discoverShelf.set('pets')
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: /^Moon, Atum app/ }))

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/dm/moon-conversation'))
    expect($railDestination.get()).toBe('chat')
    // Leaving Discover is not an arrival: the seed is the NEXT visit's to
    // reset, not this panel's to consume.
    expect($discoverShelf.get()).toBe('pets')
  })

  it('makes the available fresh-account Moon catalog row clickable', async () => {
    ensureAtumSpecialistConversation.mockResolvedValue('moon-conversation')
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: /^Moon, Atum app/ }))

    await waitFor(() => expect(ensureAtumSpecialistConversation).toHaveBeenCalledWith('moon'))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/dm/moon-conversation'))
  })

  it('renders the pinned assistant with its separator description and without app or trailing metadata', () => {
    const { container } = renderPanel()
    const pinned = container.querySelector('[data-pinned-assistant="true"]')!
    const row = pinned.querySelector('[data-roster-row]')!

    // Atum Shell v2: groups are flat rows on the glass plate — no dividers.
    expect(pinned.className).not.toContain('after:border')
    expect(row.getAttribute('aria-describedby')).toBe('atum-roster-pinned')
    expect(globalThis.document.getElementById('atum-roster-pinned')?.textContent).toBe('Pinned')
    expect(row.getAttribute('aria-label')).toBe('Atum, Start a new chat')
    expect(row.getAttribute('aria-current')).toBe('page')
    expect(pinned.querySelector('[data-roster-unread]')).toBeNull()
    expect(pinned.querySelector('[data-roster-time]')).toBeNull()
  })

  it('nests assistant chats under the pinned row as compact indented lines, newest first, routing each to its durable id', () => {
    $sessions.set([
      {
        id: 'sess-old',
        title: 'Đặt vé',
        preview: 'Đặt vé đi Đà Nẵng',
        last_active: 1_756_800_000,
        started_at: 1_756_800_000
      } as never,
      {
        id: 'tip-2',
        _lineage_root_id: 'root-2',
        title: null,
        preview: 'Viết email cho khách',
        last_active: 1_756_900_000,
        started_at: 1_756_900_000
      } as never
    ])

    const { container } = renderPanel('/tip-2')
    fireEvent.click(container.querySelector('[data-pinned-assistant] [data-atum-agent-toggle]')!)
    const rows = Array.from(container.querySelectorAll('[data-roster-list] [data-roster-row]'))

    expect(rows.slice(0, 3).map(row => row.getAttribute('aria-label'))).toEqual([
      'Atum, Start a new chat',
      'Viết email cho khách',
      'Đặt vé, Đặt vé đi Đà Nẵng'
    ])
    expect(rows[3]!.getAttribute('aria-label')).toContain('Moon')

    // The chats live INSIDE the pinned group, under Atum, not beside it as
    // peer contacts: no avatar, an indent that aligns with Atum's title, a
    // short line, and the group divider under the whole thread.
    const pinned = container.querySelector('[data-pinned-assistant]')!
    const chatRows = Array.from(pinned.querySelectorAll('[data-roster-chats] [data-roster-chat]'))

    expect(chatRows).toHaveLength(2)
    expect(chatRows[0]).toBe(rows[1])
    expect(chatRows[1]).toBe(rows[2])
    expect(pinned.querySelectorAll('[data-atum-assistant-avatar]')).toHaveLength(1)
    expect(chatRows[0]!.querySelector('img, svg[data-atum-assistant-avatar]')).toBeNull()
    expect(chatRows[0]!.className).toContain('h-8')
    expect(chatRows[0]!.className).toContain('ps-[calc(0.5rem+var(--atum-avatar-md)+0.625rem)]')
    expect(container.querySelector('[data-pinned-assistant] > [data-roster-chats]')).not.toBeNull()
    expect(container.querySelectorAll('[data-roster-list] > [data-roster-row]')).toHaveLength(0)

    // The routed tip id resolves to the row keyed by its lineage root.
    expect(rows[1]!.getAttribute('aria-current')).toBe('page')
    expect(rows[2]!.getAttribute('aria-current')).toBeNull()

    fireEvent.click(rows[2]!)
    expect(screen.getByTestId('location').textContent).toBe('/sess-old')
  })

  it('opens a chat with a named agent when its row is clicked', () => {
    // The reported bug, end to end: a person made a "Marketing" assistant and
    // clicking its row did nothing at all, because the row carried no route.
    $profiles.set([
      { has_env: true, is_default: true, model: 'm', name: 'default', path: '/h', provider: null, skill_count: 1 },
      {
        display_name: 'Marketing',
        has_env: true,
        is_default: false,
        managed_by: 'atum',
        model: 'm',
        name: 'marketing',
        path: '/h/profiles/marketing',
        provider: null,
        skill_count: 1
      } as ProfileInfo
    ])

    const { container } = renderPanel('/somewhere')
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-roster-list] [data-roster-row]'))

    expect(rows[1]!.getAttribute('aria-label')).toBe('Marketing')

    fireEvent.click(rows[1]!)

    // The next chat belongs to Marketing, and the user is standing in it.
    expect(newSessionInProfile).toHaveBeenCalledWith('marketing')
    expect(screen.getByTestId('location').textContent).toBe('/')
  })

  it('shows which agent the composer is pointed at, not whichever row owns the route', () => {
    // Every agent row leads to the same new-chat route, so the pathname alone
    // would light up all of them — and would have kept Atum lit while the user
    // was in fact about to write to someone else.
    $profiles.set([
      { has_env: true, is_default: true, model: 'm', name: 'default', path: '/h', provider: null, skill_count: 1 },
      {
        display_name: 'Marketing',
        has_env: true,
        is_default: false,
        managed_by: 'atum',
        model: 'm',
        name: 'marketing',
        path: '/h/profiles/marketing',
        provider: null,
        skill_count: 1
      } as ProfileInfo
    ])

    const { container } = renderPanel('/')
    const rows = () => Array.from(container.querySelectorAll<HTMLElement>('[data-roster-list] [data-roster-row]'))

    // Nothing chosen yet: the master owns the composer.
    expect(rows()[0]!.getAttribute('aria-current')).toBe('page')
    expect(rows()[1]!.getAttribute('aria-current')).toBeNull()

    fireEvent.click(rows()[1]!)

    expect(rows()[0]!.getAttribute('aria-current')).toBeNull()
    expect(rows()[1]!.getAttribute('aria-current')).toBe('page')

    // Coming back to Atum re-points the composer at it, rather than silently
    // sending the next message to the agent that was made last.
    fireEvent.click(rows()[0]!)

    expect(newSessionInProfile).toHaveBeenLastCalledWith('default')
    expect(rows()[0]!.getAttribute('aria-current')).toBe('page')
    expect(rows()[1]!.getAttribute('aria-current')).toBeNull()
  })

  it('leaves a draft alone when the agent you are already writing to is tapped again', () => {
    // Pointing the composer at an agent starts a fresh chat. Doing that to the
    // agent already holding the composer would throw away what was typed.
    const { container } = renderPanel('/')
    const master = container.querySelector<HTMLElement>('[data-roster-list] [data-roster-row]')!

    fireEvent.click(master)

    expect(newSessionInProfile).not.toHaveBeenCalled()
    expect(screen.getByTestId('location').textContent).toBe('/')
  })

  it('gives a named agent its display-name initial instead of a legacy symbol', () => {
    $profiles.set([
      { has_env: true, is_default: true, model: 'm', name: 'default', path: '/h', provider: null, skill_count: 1 },
      {
        avatar: '📣',
        display_name: 'Marketing',
        has_env: true,
        is_default: false,
        managed_by: 'atum',
        model: 'm',
        name: 'marketing',
        path: '/h/profiles/marketing',
        provider: null,
        skill_count: 1
      } as ProfileInfo
    ])

    const { container } = renderPanel()
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-roster-list] [data-roster-row]'))

    expect(rows[0]!.querySelector('[data-atum-assistant-avatar]')).toBeTruthy()
    expect(rows[1]!.querySelector('[data-atum-assistant-avatar]')!.textContent).toBe('M')
    expect(rows[1]!.querySelector('[data-atum-agent-avatar]')).toBeNull()
  })

  it('calls only the master pinned, once, however many agents there are', () => {
    // Every agent row carried the same element id and told a screen reader it
    // was pinned — of an assistant the user can remove, in a product with no
    // pins at all.
    $profiles.set([
      { has_env: true, is_default: true, model: 'm', name: 'default', path: '/h', provider: null, skill_count: 1 },
      {
        display_name: 'Marketing',
        has_env: true,
        is_default: false,
        managed_by: 'atum',
        model: 'm',
        name: 'marketing',
        path: '/h/profiles/marketing',
        provider: null,
        skill_count: 1
      } as ProfileInfo,
      {
        display_name: 'Nhà',
        has_env: true,
        is_default: false,
        managed_by: 'atum',
        model: 'm',
        name: 'nha',
        path: '/h/profiles/nha',
        provider: null,
        skill_count: 1
      } as ProfileInfo
    ])

    const { container } = renderPanel()

    expect(container.querySelectorAll('#atum-roster-pinned')).toHaveLength(1)
    // And the word itself appears once: a named agent must not carry a hidden,
    // id-less "Pinned" either.
    expect(screen.getAllByText('Pinned')).toHaveLength(1)

    // Chats belong to an agent; a group with no agent row renders none.
    for (const chats of container.querySelectorAll('[data-roster-chats]')) {
      expect(chats.closest('[data-agent-group]')!.querySelector('[data-roster-row]')).toBeTruthy()
    }

    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-roster-list] [data-roster-row]'))

    expect(rows[0]!.getAttribute('aria-describedby')).toBe('atum-roster-pinned')
    expect(rows[1]!.getAttribute('aria-describedby')).toBeNull()
    expect(rows[2]!.getAttribute('aria-describedby')).toBeNull()
  })

  it('hands the composer to the agent whose chat you open', () => {
    // After making an assistant the composer is aimed at it. Reading one of
    // Atum's own chats used to leave that aim untouched, so the roster showed
    // the new assistant as current and the next message went to it.
    $sessions.set([
      {
        id: 'sess-atum',
        profile: 'default',
        title: 'Báo cáo',
        preview: '',
        last_active: 1,
        started_at: 1,
        archived: false
      } as never
    ])
    $newChatProfile.set('marketing')

    const { container } = renderPanel()

    fireEvent.click(container.querySelector('[data-pinned-assistant] [data-atum-agent-toggle]')!)
    const chat = container.querySelector<HTMLElement>('[data-roster-chat]')!

    fireEvent.click(chat)

    // Cleared, not re-pointed: resuming the chat moves the app to its owner and
    // the composer follows, rather than staying aimed at the last pick.
    expect($newChatProfile.get()).toBeNull()
    expect(screen.getByTestId('location').textContent).toBe('/sess-atum')
  })

  it('closes the assistants section with a full-width create button that opens the new-assistant sheet', async () => {
    $profiles.set([masterProfile, agentProfile('marketing', 'Marketing')])

    const { container } = renderPanel()
    const create = container.querySelector<HTMLButtonElement>('[data-roster-list] [data-atum-create-agent]')!

    expect(create).not.toBeNull()
    expect(create.textContent).toBe('Create a new assistant')
    // No longer a plus beside Atum: it sits under the last assistant, above
    // the apps and people, as the way to grow that section.
    expect(create.closest('[data-pinned-assistant]')).toBeNull()
    expect(container.querySelector('[data-pinned-assistant] [data-atum-create-agent]')).toBeNull()
    // The button is not a roster row, so arrow-key navigation skips it.
    expect(create.hasAttribute('data-roster-row')).toBe(false)

    // The drag context adds hidden live-region nodes to the list; they are
    // not rows and do not count for order.
    const children = Array.from(container.querySelector('[data-roster-list]')!.children).filter(
      child => !child.id.startsWith('Dnd')
    )

    const foot = children.findIndex(child => child.hasAttribute('data-atum-agents-foot'))

    // The foot follows the user's own assistants block and precedes the
    // "Chuyên gia" label that opens the hosted rows.
    expect(children[foot - 1]!.hasAttribute('data-atum-own-agents')).toBe(true)
    expect(children[foot - 1]!.querySelector('[data-agent-group="marketing"]')).not.toBeNull()
    expect(children[foot + 1]!.hasAttribute('data-atum-section-label')).toBe(true)
    expect(children[foot + 2]!.querySelector('[data-roster-row]')!.getAttribute('aria-label')).toMatch(/^Moon/)

    fireEvent.click(create)

    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getByLabelText('Name')).toBeTruthy()
  })

  it('shows a direct Rename action for a legacy name that cannot be registered', async () => {
    $profiles.set([masterProfile, agentProfile('marketing', 'x'.repeat(41))])

    const { container } = renderPanel()
    const warning = container.querySelector<HTMLElement>('[data-atum-agent-name-too-long]')!

    expect(warning.textContent).toContain('Shorten the name to 40 characters or fewer')
    fireEvent.click(warning.querySelector('[data-atum-agent-rename]')!)

    expect(((await screen.findByLabelText('Name')) as HTMLInputElement).value).toBe('x'.repeat(41))
  })

  it("furls every agent's chats by default and unfurls only the one you disclose", () => {
    $profiles.set([masterProfile, agentProfile('marketing', 'Marketing')])
    $sessions.set([
      { id: 'sess-atum', profile: 'default', title: 'Báo cáo', preview: '', last_active: 2, started_at: 2 } as never,
      { id: 'sess-mkt', profile: 'marketing', title: 'Chiến dịch', preview: '', last_active: 1, started_at: 1 } as never
    ])

    const { container } = renderPanel()

    // Nothing open: the roster reads as agents, not as every chat ever had.
    expect(container.querySelectorAll('[data-roster-chat]')).toHaveLength(0)

    const toggles = container.querySelectorAll<HTMLButtonElement>('[data-atum-agent-toggle]')

    expect(toggles).toHaveLength(2)
    expect(toggles[1]!.getAttribute('aria-label')).toBe('Show chats (1)')
    expect(toggles[1]!.getAttribute('aria-expanded')).toBe('false')
    expect(toggles[1]!.hasAttribute('data-roster-row')).toBe(false)

    fireEvent.click(toggles[1]!)

    const chats = container.querySelectorAll('[data-roster-chat]')

    expect(chats).toHaveLength(1)
    expect(chats[0]!.closest('[data-agent-group]')!.getAttribute('data-agent-group')).toBe('marketing')
    expect(
      container.querySelector('[data-agent-group="marketing"] [data-atum-agent-toggle]')!.getAttribute('aria-label')
    ).toBe('Hide chats')

    fireEvent.click(container.querySelector('[data-agent-group="marketing"] [data-atum-agent-toggle]')!)
    expect(container.querySelectorAll('[data-roster-chat]')).toHaveLength(0)
  })

  it('starts closed on restored chats and expands only the clicked agent row', () => {
    $profiles.set([masterProfile, agentProfile('marketing', 'Marketing')])
    $sessions.set([
      { id: 'sess-atum', profile: 'default', title: 'Báo cáo', preview: '', last_active: 2, started_at: 2 } as never,
      { id: 'sess-mkt', profile: 'marketing', title: 'Chiến dịch', preview: '', last_active: 1, started_at: 1 } as never
    ])

    const { container } = renderPanel('/sess-mkt')
    expect(container.querySelectorAll('[data-roster-chat]')).toHaveLength(0)
    fireEvent.click(container.querySelector('[data-agent-group="marketing"] [data-roster-row]')!)
    expect(container.querySelectorAll('[data-roster-chat]')).toHaveLength(1)
    expect(container.querySelector('[data-roster-chat]')!.closest('[data-agent-group]')!.getAttribute('data-agent-group')).toBe('marketing')
    fireEvent.click(container.querySelector('[data-pinned-assistant] [data-roster-row]')!)
    expect(container.querySelectorAll('[data-roster-chat]')).toHaveLength(1)
    expect(container.querySelector('[data-roster-chat]')!.closest('[data-agent-group]')!.getAttribute('data-agent-group')).toBe('default')

  })

  it('gives every agent a new-chat control that always starts fresh, master included', () => {
    $profiles.set([masterProfile, agentProfile('marketing', 'Marketing')])

    const { container } = renderPanel('/')
    const buttons = container.querySelectorAll<HTMLButtonElement>('[data-atum-new-chat]')

    expect(buttons).toHaveLength(2)
    expect(buttons[0]!.getAttribute('aria-label')).toBe('New chat')
    expect(buttons[0]!.hasAttribute('data-roster-row')).toBe(false)

    // Tapping the master's ROW while it holds the composer leaves a draft
    // alone; the explicit control is a fresh start every time.
    fireEvent.click(buttons[0]!)
    expect(newSessionInProfile).toHaveBeenLastCalledWith('default')

    fireEvent.click(buttons[1]!)
    expect(newSessionInProfile).toHaveBeenLastCalledWith('marketing')
    expect(screen.getByTestId('location').textContent).toBe('/')
  })

  it('offers profile editing for every assistant, while only named assistants can be pinned', async () => {
    $profiles.set([masterProfile, agentProfile('alpha', 'Alpha'), agentProfile('beta', 'Beta')])

    const { container } = renderPanel()

    const master = container.querySelector('[data-pinned-assistant] [data-atum-agent-menu]')!
    openMenu(master)
    expect(await screen.findByRole('menuitem', { name: 'Edit' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Pin to top' })).toBeNull()
    fireEvent.keyDown(document.body, { key: 'Escape' })

    const beta = container.querySelector('[data-agent-group="beta"] [data-atum-agent-menu]')!

    expect(beta.getAttribute('aria-label')).toBe('More')
    openMenu(beta)

    expect(await screen.findByRole('menuitem', { name: 'Edit' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin to top' }))

    expect($atumAgentPins.get()).toEqual(['local:beta'])

    // Pinned means first among the user's own assistants: still under Atum,
    // never above it, and still above the apps.
    const groups = () =>
      Array.from(container.querySelectorAll('[data-agent-group]')).map(group => group.getAttribute('data-agent-group'))

    expect(groups()).toEqual(['default', 'beta', 'alpha'])

    openMenu(container.querySelector('[data-agent-group="beta"] [data-atum-agent-menu]')!)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin' }))

    expect($atumAgentPins.get()).toEqual([])
    // Unpinning keeps the place it was pinned into; the user can drag it back.
    expect(groups()).toEqual(['default', 'beta', 'alpha'])
  })

  it("opens the edit sheet from the more menu with the assistant's current name and photo control", async () => {
    $profiles.set([masterProfile, agentProfile('marketing', 'Marketing', '📣')])

    const { container } = renderPanel()

    openMenu(container.querySelector('[data-agent-group="marketing"] [data-atum-agent-menu]')!)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }))

    const dialog = await screen.findByRole('dialog')

    expect(dialog.textContent).toContain('Edit assistant')
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Marketing')
    expect(screen.getByLabelText('Photo')).toBeTruthy()
    expect(screen.queryByRole('radio')).toBeNull()
  })

  it("lists the user's own assistants in the order they were dragged into, by grabbing those rows without a grip", () => {
    $profiles.set([
      masterProfile,
      agentProfile('alpha', 'Alpha'),
      agentProfile('beta', 'Beta'),
      agentProfile('gamma', 'Gamma')
    ])

    const { container } = renderPanel()

    const groups = () =>
      Array.from(container.querySelectorAll('[data-agent-group]')).map(group => group.getAttribute('data-agent-group'))

    // Unplaced assistants read in name order.
    expect(groups()).toEqual(['default', 'alpha', 'beta', 'gamma'])
    expect(container.querySelector('[data-pinned-assistant] [data-atum-agent-grip]')).toBeNull()
    expect(container.querySelectorAll('[data-atum-agent-grip]')).toHaveLength(0)
    expect(container.querySelector('[data-agent-group="alpha"] [data-roster-row]')!.getAttribute('aria-roledescription')).toBe('sortable')

    act(() => reorderAtumAgents(['gamma', 'alpha', 'beta']))
    expect(groups()).toEqual(['default', 'gamma', 'alpha', 'beta'])
    expect($atumAgentOrder.get()).toEqual(['local:gamma', 'local:alpha', 'local:beta'])

    // A pin outranks the manual order, and pinning moves to the very top.
    act(() => setAtumAgentPinned('beta', true))
    expect(groups()).toEqual(['default', 'beta', 'gamma', 'alpha'])

    // Searching shows the same order with nothing to drag.
    fireEvent.change(screen.getByRole('textbox', { name: 'Search everything' }), { target: { value: 'a' } })
    expect(groups()).toEqual(['default', 'beta', 'gamma', 'alpha'])
    expect(container.querySelectorAll('[data-atum-agent-grip]')).toHaveLength(0)
  })

  it('folds the thread past five chats behind one quiet toggle, and searching unfolds it', () => {
    $sessions.set(
      Array.from({ length: 7 }, (_, index) => ({
        id: `sess-${index}`,
        title: `Chat ${index}`,
        preview: '',
        last_active: 1_756_900_000 - index,
        started_at: 1_756_900_000 - index
      })) as never[]
    )

    const { container } = renderPanel()
    const pinned = container.querySelector('[data-pinned-assistant]')!

    // Furled until disclosed; then the first handful, then the rest on ask.
    expect(pinned.querySelectorAll('[data-roster-chat]')).toHaveLength(0)
    expect(pinned.querySelector('[data-atum-agent-toggle]')!.getAttribute('aria-label')).toBe('Show chats (7)')
    fireEvent.click(pinned.querySelector('[data-atum-agent-toggle]')!)

    expect(pinned.querySelectorAll('[data-roster-chat]')).toHaveLength(5)
    expect(pinned.querySelectorAll('[data-roster-chat]')[0]!.getAttribute('aria-label')).toBe('Chat 0')

    const toggle = pinned.querySelector<HTMLButtonElement>('[data-roster-chats-toggle]')!
    expect(toggle.textContent).toBe('Show 2 more')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // The toggle is not a roster row, so arrow-key navigation skips it.
    expect(toggle.hasAttribute('data-roster-row')).toBe(false)

    fireEvent.click(toggle)
    expect(pinned.querySelectorAll('[data-roster-chat]')).toHaveLength(7)
    expect(pinned.querySelector('[data-roster-chats-toggle]')!.textContent).toBe('Show fewer')

    fireEvent.click(pinned.querySelector('[data-roster-chats-toggle]')!)
    expect(pinned.querySelectorAll('[data-roster-chat]')).toHaveLength(5)

    fireEvent.change(screen.getByRole('textbox', { name: 'Search everything' }), { target: { value: 'Chat' } })
    expect(container.querySelectorAll('[data-roster-chat]')).toHaveLength(7)
    expect(container.querySelector('[data-roster-chats-toggle]')).toBeNull()
    // A search that finds chats still lands them under Atum.
    expect(container.querySelector('[data-pinned-assistant] [data-atum-assistant-avatar]')).not.toBeNull()
  })

  it('marks a chat whose turn finished in the background and starts a fresh draft from the pinned row', () => {
    $sessions.set([
      {
        id: 'sess-1',
        title: 'Báo cáo',
        preview: 'Soạn báo cáo quý',
        last_active: 1_756_800_000,
        started_at: 1_756_800_000
      } as never
    ])
    $unreadFinishedSessionIds.set(['sess-1'])

    const { container } = renderPanel('/sess-1')
    fireEvent.click(container.querySelector('[data-pinned-assistant] [data-atum-agent-toggle]')!)
    const rows = Array.from(container.querySelectorAll('[data-roster-list] [data-roster-row]'))

    expect(rows[1]!.getAttribute('aria-label')).toBe('Báo cáo, Soạn báo cáo quý, Atum finished')
    expect(rows[1]!.querySelector('[data-testid="roster-attention-complete"]')).not.toBeNull()
    expect(rows[1]!.querySelector('[data-roster-unread]')).toBeNull()
    expect(rows[1]!.hasAttribute('data-roster-chat')).toBe(true)

    fireEvent.click(rows[0]!)
    expect(screen.getByTestId('location').textContent).toBe('/')
  })

  it('coalesces duplicate clicks while the Moon conversation is being ensured', async () => {
    let resolveEnsure!: (conversationId: string) => void

    const pending = new Promise<string>(resolve => {
      resolveEnsure = resolve
    })

    ensureAtumSpecialistConversation.mockReturnValue(pending)
    renderPanel()

    const moon = screen.getByRole('button', { name: /^Moon, Atum app/ })
    fireEvent.click(moon)
    fireEvent.click(moon)

    expect(ensureAtumSpecialistConversation).toHaveBeenCalledTimes(1)
    resolveEnsure('moon-conversation')
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/dm/moon-conversation'))
  })

  it('shows an inline ensure failure and retries the same catalog entry', async () => {
    ensureAtumSpecialistConversation
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('moon-conversation')

    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: /^Moon, Atum app/ }))

    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't open this app")
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(ensureAtumSpecialistConversation).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/dm/moon-conversation'))
  })

  it('does not paint an obsolete ensure failure after the Atum account changes', async () => {
    ensureAtumSpecialistConversation.mockRejectedValue(new Error('atum_account_changed'))
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: /^Moon, Atum app/ }))

    await waitFor(() => expect(ensureAtumSpecialistConversation).toHaveBeenCalledOnce())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('location').textContent).toBe('/')
  })
  it('announces completion independently from unread state and does not consume it on navigation', () => {
    $atumSortedRoster.set([conversation({ id: 'c1', title: 'moon', unreadCount: 2 })])
    $atumDmArtifactByConversation.set({
      c1: {
        activeResourceId: 'moon.laso:complete',
        closedRefs: [],
        tabs: [
          {
            attention: 'complete',
            ref: {
              kind: 'artifact',
              resourceId: 'moon.laso:complete',
              status: 'ready',
              title: 'Lá số',
              type: 'reading'
            },
            state: 'ready',
            target: null,
            targetExpiresAt: null
          }
        ]
      }
    })
    renderPanel()

    const row = screen.getByRole('button', {
      name: 'Moon, Atum app, Astrology specialist, 2 unread, Finished'
    })

    expect(screen.getByTestId('roster-attention-complete')).toBeTruthy()
    fireEvent.click(row)
    expect(screen.getByTestId('location').textContent).toBe('/dm/c1')
    expect(
      screen.getByRole('button', { name: 'Moon, Atum app, Astrology specialist, 2 unread, Finished' })
    ).toBeTruthy()
  })

  it('renders terminal failure as a distinct attention badge', () => {
    $atumSortedRoster.set([conversation({ id: 'c1', title: 'andy', participantIds: ['andy'], payload: { specialist: 'andy' } })])
    $atumDmArtifactByConversation.set({
      c1: {
        activeResourceId: 'andy.receipt:failed',
        closedRefs: [],
        tabs: [
          {
            attention: 'failed',
            ref: {
              kind: 'artifact',
              resourceId: 'andy.receipt:failed',
              status: 'ready',
              title: 'Receipt',
              type: 'receipt'
            },
            state: 'denied',
            target: null,
            targetExpiresAt: null
          }
        ]
      }
    })
    renderPanel()

    expect(
      screen.getByRole('button', { name: 'Andy, Atum app, Mental & emotional guide, Needs attention' })
    ).toBeTruthy()
    expect(screen.getByTestId('roster-attention-failed')).toBeTruthy()
  })

  it('renders one flat list with available catalog apps, hosted unavailable apps, then people', () => {
    $atumSortedRoster.set([
      conversation({ id: 'c1', title: 'moon' }),
      conversation({ id: 'c2', title: 'andy', participantIds: ['andy'], payload: { specialist: 'andy' } }),
      conversation({ id: 'c3', title: 'Lan', kind: 'direct', participantIds: ['lan'] })
    ])
    const { container } = renderPanel()

    expect(container.querySelectorAll('[data-roster-row]')).toHaveLength(4)
    expect(
      Array.from(container.querySelectorAll('[data-roster-row]')).map(row => row.getAttribute('aria-label'))
    ).toEqual([
      'Atum, Start a new chat',
      'Moon, Atum app, Astrology specialist',
      'Andy, Atum app, Mental & emotional guide',
      'Lan'
    ])
    expect(container.querySelectorAll('[data-roster-list]')).toHaveLength(1)
    expect(screen.queryByText('Apps')).toBeNull()
    expect(screen.queryByText('People')).toBeNull()
    // Hosted lowercase ids render as proper display names.
    expect(screen.getByText('Moon')).toBeTruthy()
    expect(screen.getByText('Andy')).toBeTruthy()
    expect(screen.getByText('Lan')).toBeTruthy()
  })

  it('keeps search visible and useful: plain query narrows, unaccented query matches diacritics', () => {
    $atumSortedRoster.set([
      conversation({ id: 'c1', title: 'moon' }),
      conversation({ id: 'c2', title: 'Trò chuyện nhóm', participantIds: ['andy'], payload: {} })
    ])
    const { container } = renderPanel()

    const search = screen.getByRole('textbox', { name: 'Search everything' })

    fireEvent.change(search, { target: { value: 'moon' } })
    expect(container.querySelectorAll('[data-roster-row]')).toHaveLength(1)

    fireEvent.change(search, { target: { value: 'tro chuyen' } })
    expect(container.querySelectorAll('[data-roster-row]')).toHaveLength(1)
    expect(screen.getByText('Trò chuyện nhóm')).toBeTruthy()
  })

  it('shows the unread pill instead of the timestamp, and presence only when reported', () => {
    $atumSortedRoster.set([
      conversation({ id: 'c1', title: 'moon', unreadCount: 2, payload: { specialist: 'moon', presence: 'online' } }),
      conversation({ id: 'c2', title: 'andy', participantIds: ['andy'], payload: { specialist: 'andy' } })
    ])
    const { container } = renderPanel()

    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Moon, Atum app, Astrology specialist, 2 unread' })).toBeTruthy()
    // Exactly one presence dot — the row whose payload reports it.
    const rows = container.querySelectorAll('[data-roster-row]')
    expect(rows[1]!.querySelectorAll('[aria-hidden="true"].size-\\(--atum-presence-dot\\)')).toHaveLength(1)
    expect(rows[2]!.querySelector('.size-\\(--atum-presence-dot\\)')).toBeNull()
  })

  it('integrates the badge into a clamped secondary line and caps the unread pill at 99+', () => {
    $atumSortedRoster.set([conversation({ title: 'taylor', unreadCount: 120, payload: { specialist: 'taylor' } })])
    const { container } = renderPanel()

    const row = screen.getByRole('button', {
      name: 'Taylor, Atum app, Financial research specialist, 120 unread'
    })

    const secondary = row.querySelector('[data-roster-secondary]')!

    // Atum Shell v2 drops the ownership chip from the row: the role is the
    // whole second line, one line, and the badge survives in the label.
    expect(secondary.textContent).toBe('Financial research specialist')
    expect(secondary.className).toContain('truncate')
    expect(container.querySelector('[data-roster-unread]')?.textContent).toBe('99+')
  })
})

describe('AtumRosterPanel — honest specialists states', () => {
  it('signed out: one assistant row plus an explainer whose action navigates to the auth route', () => {
    $atumAccountStatus.set({
      state: 'unconfigured',
      configured: false,
      account: null,
      errorCode: null,
      providers: { google: false, password: false }
    })
    const { container } = renderPanel()

    expect(container.querySelectorAll('[data-roster-row]')).toHaveLength(1)
    const group = container.querySelector('[data-roster-state="hosted"]')!
    expect(group).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByTestId('location').textContent).toBe('/sign-in')
  })

  it('loading: skeletons stand in for the first sync, never an empty void', () => {
    $atumConnectivity.set('loading')
    const { container } = renderPanel()

    // The curated Moon entry stays discoverable while hosted rows load.
    expect(container.querySelectorAll('[data-roster-row]')).toHaveLength(2)
    expect(container.querySelector('[data-roster-state="hosted"] [aria-hidden="true"]')).toBeTruthy()
  })

  it('error: one line plus a retry that re-fetches status and roster', () => {
    $atumConnectivity.set('error')
    renderPanel()

    expect(screen.getByText("Couldn't load your chats")).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refreshAtumStatus).toHaveBeenCalledTimes(1)
    expect(refreshAtumRoster).toHaveBeenCalledTimes(1)
  })

  it('signed in with zero hosted chats: Moon stays discoverable and the empty state remains honest', () => {
    renderPanel()

    expect(screen.getByText('No other conversations yet')).toBeTruthy()
    // The row title only: the ownership chip no longer repeats "Atum".
    expect(screen.getAllByText('Atum')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /^Moon, Atum app/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Andy, Atum app/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Taylor, Atum app/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Ben, Atum app/ })).toBeNull()
  })
})
