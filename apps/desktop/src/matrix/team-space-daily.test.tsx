import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AtumNavSwitchSurface } from '@/app/atum/shell-surface'
import { I18nProvider } from '@/i18n'

import type { MatrixRoom, MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import type { MatrixCompanyBridge } from '../../shared/matrix-company'

import { MatrixCommandPalette } from './command-palette'
import { MatrixCompanyChannelMenu } from './company-channel-menu'
import { $companyChannelCompanyId, $companyChannelOrder, $companyOverviewRequest } from './company-chrome'
import { MatrixCompanyWorkspace } from './company-workspace'

const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')

afterEach(() => {
  cleanup()
  // The company last open is remembered on the device: one test's choice must not open the next one's.
  window.localStorage.clear()
  if (scrollDescriptor) {
    Object.defineProperty(Element.prototype, 'scrollIntoView', scrollDescriptor)
  } else {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  }
  Reflect.deleteProperty(window, 'atumMatrix')
})

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})

const companyA = { id: 'company-a', displayName: 'Acme', role: 'admin' as 'admin' | 'member', authorityGeneration: 1 }
const companyB = { id: 'company-b', displayName: 'Beta', role: 'member' as 'admin' | 'member', authorityGeneration: 1 }

function channelRoom(id: string, patch: Partial<MatrixRoom> = {}, companyId = companyA.id): MatrixRoom {
  return { id, name: id, membership: 'join', encrypted: false, companyChannel: { companyId, channelId: `ch-${id}` }, ...patch }
}

function bridgeFor(companies = [companyA], withSearch = true): MatrixCompanyBridge {
  const channelItem = (name: string, roomId: string, companyId: string) => ({
    schemaVersion: 1 as const,
    channel: { id: `40000000-0000-4000-8000-00000000000${name.length}`, companyId, displayName: name,
      visibility: 'company' as const, state: 'active' as const, projectId: null, authorityGeneration: 1, channelGeneration: 1 },
    memberPrincipals: [], room: { state: 'ready' as const, roomId }
  })

  return {
    pending: async () => ({ ok: true as const, request: null }),
    request: vi.fn(async input => {
      if (input.action === 'list') {
        return { ok: true as const, value: { schemaVersion: 1 as const, companies, invitations: [] } }
      }

      if (input.action === 'read') {
        const company = companies.find(value => value.id === input.companyId)!

        return { ok: true as const, value: { schemaVersion: 1 as const, company, projects: [],
          members: [{ principal: 'p1', role: 'admin' as const, state: 'active' as const },
            { principal: 'p2', role: 'member' as const, state: 'invited' as const },
            { principal: 'p3', role: 'member' as const, state: 'removed' as const }] } }
      }

      if (input.action === 'list-channels') {
        return { ok: true as const, value: { schemaVersion: 1 as const, channels: [
          channelItem('general', '!general:test', input.companyId), channelItem('ops', '!ops:test', input.companyId)
        ] } }
      }

      return { ok: false as const, error: 'missing' as const }
    }),
    ...(withSearch ? {
      search: vi.fn(async () => ({ ok: false as const, error: 'unavailable' as const })),
      open: vi.fn(async () => ({ ok: true as const }))
    } : {})
  } as MatrixCompanyBridge
}

function mount(props: Partial<React.ComponentProps<typeof MatrixCompanyWorkspace>> & { bridge: MatrixCompanyBridge }) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixCompanyWorkspace accountKey="a" ensureDefaultChannels={false} onOpenChannel={vi.fn(async () => {})}
        onOpenSearchResult={vi.fn(async () => {})} overviewFallback {...props} />
    </I18nProvider>
  )
}

describe('company sidebar unread and mentions', () => {
  it('bolds an unread channel and shows its mention count; a read one stays plain', async () => {
    mount({
      bridge: bridgeFor(),
      activeRoomId: '!ops:test',
      rooms: [
        channelRoom('!general:test', { unreadNotifications: 4, highlights: 2 }),
        channelRoom('!ops:test')
      ]
    })

    const general = (await screen.findByRole('button', { name: 'Open # general' })).closest('[data-team-space-sidebar-row]')!
    const ops = screen.getByRole('button', { name: 'Open # ops' }).closest('[data-team-space-sidebar-row]')!
    expect(general.getAttribute('data-unread')).toBe('true')
    expect(within(general as HTMLElement).getByText('4')).toBeTruthy()
    expect(general.querySelector('[data-roster-unread="mention"]')).toBeTruthy()
    expect(ops.hasAttribute('data-unread')).toBe(false)
    expect(ops.querySelector('[data-roster-unread]')).toBeNull()
  })

  it('shows a plain count for non-mention notifications and a quiet dot for a muted channel with activity', async () => {
    mount({
      bridge: bridgeFor(),
      rooms: [
        channelRoom('!general:test', { unreadNotifications: 3 }),
        channelRoom('!ops:test', { muted: true, unreadNotifications: 6, unread: true })
      ]
    })

    const general = (await screen.findByRole('button', { name: 'Open # general' })).closest('[data-team-space-sidebar-row]')!
    const ops = screen.getByRole('button', { name: 'Open # ops' }).closest('[data-team-space-sidebar-row]')!
    expect(general.querySelector('[data-roster-unread="count"]')?.textContent).toContain('3')
    expect(ops.querySelector('[data-roster-unread="activity"]')).toBeTruthy()
  })

  it('badges each company in the menu by the one rule, from only that company’s channels, and shows none on the one on screen', async () => {
    mount({
      bridge: bridgeFor([companyA, companyB]),
      rooms: [
        channelRoom('!general:test', { unreadNotifications: 2, highlights: 1 }),
        channelRoom('!x:test', { unreadNotifications: 7 }, companyB.id)
      ]
    })

    const openCompanyMenu = () =>
      fireEvent.keyDown(document.querySelector('[data-matrix-company-menu-trigger]')!, { key: 'Enter' })

    // Acme opens first and is on screen: it shows nothing. Beta has unread messages but no mention: a dot, not a count.
    await screen.findByRole('heading', { name: 'Acme' })
    openCompanyMenu()
    expect(screen.getByRole('menuitemradio', { name: /^Acme · / }).querySelector('[data-roster-unread]')).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: /^Beta/ }).querySelector('[data-roster-unread="activity"]')).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: /^Beta/ }).querySelector('[data-roster-unread="count"]')).toBeNull()

    // Moving to Beta frees Acme's badge: a mention is a number, the mentions only (not the 2 notifications).
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Beta/ }))
    await screen.findByRole('heading', { name: 'Beta' })
    openCompanyMenu()
    expect(screen.getByRole('menuitemradio', { name: /^Acme/ }).querySelector('[data-roster-unread="mention"]')?.textContent).toContain('1')
    expect(screen.getByRole('menuitemradio', { name: /^Beta · / }).querySelector('[data-roster-unread]')).toBeNull()
  })

  it('prints a hundred mentions as 99+ in the company menu', async () => {
    mount({
      bridge: bridgeFor([companyA, companyB]),
      rooms: [channelRoom('!x:test', { highlights: 120 }, companyB.id)]
    })

    await screen.findByRole('heading', { name: 'Acme' })
    fireEvent.keyDown(document.querySelector('[data-matrix-company-menu-trigger]')!, { key: 'Enter' })
    const beta = screen.getByRole('menuitemradio', { name: /^Beta/ })
    expect(beta.querySelector('[data-roster-unread="mention"]')?.textContent).toContain('99+')
  })

  it('re-reads the directory when Matrix sync brings a new channel room, without waiting for the poll', async () => {
    const bridge = bridgeFor()
    const view = mount({ bridge, rooms: [channelRoom('!general:test')] })
    await screen.findByRole('button', { name: 'Open # general' })
    await waitFor(() => expect((bridge.request as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(2))
    const reads = () => (bridge.request as ReturnType<typeof vi.fn>).mock.calls.filter(([input]) => input.action === 'list-channels').length
    const before = reads()

    view.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixCompanyWorkspace accountKey="a" bridge={bridge} onOpenChannel={vi.fn(async () => {})}
          rooms={[channelRoom('!general:test'), channelRoom('!ops:test')]} />
      </I18nProvider>
    )
    await waitFor(() => expect(reads()).toBeGreaterThan(before))
  })

  it('publishes the sidebar order for the channel shortcuts', async () => {
    mount({ bridge: bridgeFor(), rooms: [channelRoom('!general:test'), channelRoom('!ops:test')] })
    await screen.findByRole('button', { name: 'Open # general' })
    await waitFor(() => expect($companyChannelOrder.get()).toEqual(['!general:test', '!ops:test']))
    expect($companyChannelCompanyId.get()).toBe(companyA.id)
  })

  it('publishes the selected company with its directory, and republishes when the company changes', async () => {
    const bridge = bridgeFor([companyA, companyB])

    ;(bridge.request as ReturnType<typeof vi.fn>).mockImplementation(async input => {
      if (input.action === 'list') {
        return { ok: true as const, value: { schemaVersion: 1 as const, companies: [companyA, companyB], invitations: [] } }
      }

      if (input.action === 'read') {
        const company = [companyA, companyB].find(value => value.id === input.companyId)!

        return { ok: true as const, value: { schemaVersion: 1 as const, company, projects: [], members: [] } }
      }

      if (input.action === 'list-channels') {
        const mine = input.companyId === companyA.id ? ['!a1:test'] : ['!b1:test', '!b2:test']

        return { ok: true as const, value: { schemaVersion: 1 as const, channels: mine.map((roomId, index) => ({
          schemaVersion: 1 as const,
          channel: { id: `5000000${input.companyId === companyA.id ? 0 : 1}-0000-4000-8000-00000000000${index}`, companyId: input.companyId, displayName: roomId.slice(1, 3),
            visibility: 'company' as const, state: 'active' as const, projectId: null, authorityGeneration: 1, channelGeneration: 1 },
          memberPrincipals: [], room: { state: 'ready' as const, roomId }
        })) } }
      }

      return { ok: false as const, error: 'missing' as const }
    })

    mount({ bridge, rooms: [] })
    await waitFor(() => expect($companyChannelOrder.get()).toEqual(['!a1:test']))
    expect($companyChannelCompanyId.get()).toBe(companyA.id)

    fireEvent.keyDown(document.querySelector('[data-matrix-company-menu-trigger]')!, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^Beta · / }))
    await waitFor(() => expect($companyChannelOrder.get()).toEqual(['!b1:test', '!b2:test']))
    expect($companyChannelCompanyId.get()).toBe(companyB.id)
  })

  it('withdraws the company and order when the workspace goes away', async () => {
    const view = mount({ bridge: bridgeFor(), rooms: [] })
    await waitFor(() => expect($companyChannelCompanyId.get()).toBe(companyA.id))
    view.unmount()
    expect($companyChannelCompanyId.get()).toBeUndefined()
    expect($companyChannelOrder.get()).toEqual([])
  })
})

describe('company search', () => {
  it('keeps search out of the sidebar and reachable from the company menu', async () => {
    mount({ bridge: bridgeFor(), searchEnabled: true, rooms: [] })
    expect(screen.queryByRole('button', { name: 'Search Acme' })).toBeNull()
    fireEvent.keyDown(await screen.findByRole('button', { name: 'Acme' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Company overview' }))
    expect(await screen.findByRole('textbox', { name: 'Search company messages' })).toBeTruthy()
  })

  it('has no search surface while search is off or the bridge lacks it', async () => {
    mount({ bridge: bridgeFor([companyA], false), searchEnabled: true, rooms: [] })
    await screen.findByRole('button', { name: 'Open # general' })
    expect(screen.queryByRole('button', { name: 'Search Acme' })).toBeNull()
    cleanup()
    mount({ bridge: bridgeFor(), searchEnabled: false, rooms: [] })
    await screen.findByRole('button', { name: 'Open # general' })
    expect(screen.queryByRole('button', { name: 'Search Acme' })).toBeNull()
  })

  it('the Members button request opens the company roster', async () => {
    mount({ bridge: bridgeFor(), activeRoomId: '!general:test', channelContent: <p>transcript</p>, rooms: [] })
    await screen.findByText('transcript')
    act(() => $companyOverviewRequest.set($companyOverviewRequest.get() + 1))
    await waitFor(() => expect(document.querySelector('[data-matrix-company-detail]')).toBeTruthy())
    expect(screen.getByText('transcript')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Company overview' })).toBeTruthy()
  })
})

describe('company channel header menu', () => {
  function setup(room: MatrixRoom) {
    const command = vi.fn<MatrixUiBridge['command']>().mockResolvedValue(null)
    window.atumMatrix = { command, companies: bridgeFor() } as unknown as MatrixUiBridge

    const snapshot: MatrixSnapshot = {
      state: 'ready', identity: { userId: '@me:test', deviceId: 'D' }, rooms: [room], roomId: room.id, messages: [], error: null,
      notificationPolicy: {
        version: 1,
        accountLevel: 'mentions',
        quietHours: { enabled: false, startMinute: 1_320, endMinute: 420, timeZone: 'UTC' },
        channelOverrides: {},
        threadOverrides: {},
        writable: true
      }
    }

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixCompanyChannelMenu fail={vi.fn()} room={room} snapshot={snapshot} title="general" />
      </I18nProvider>
    )
    fireEvent.keyDown(screen.getByRole('button', { name: 'Conversation options' }), { key: 'Enter' })

    return command
  }

  it('offers only details, favorites and notifications: no personal rename, pin, leave, delete or awareness', () => {
    setup(channelRoom('!general:test'))
    const names = screen.getAllByRole('menuitem').map(item => item.textContent)
    // Favorites is the company sidebar's own section (Matrix `m.favourite`); the personal "Pin" stays out.
    // Members has one entry point since 2026-10-31: the header's member stack, not a duplicate menu item.
    expect(names).toEqual(['Channel details', 'Add to favorites', 'Notifications'])
    expect(document.querySelector('[data-matrix-chat-awareness]')).toBeNull()
  })

  it('stores a channel notification level without leaving, forgetting or muting the room', async () => {
    const command = setup(channelRoom('!general:test'))
    const notifications = screen.getByRole('menuitem', { name: 'Notifications' })
    fireEvent.keyDown(notifications, { key: 'ArrowRight' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Nothing' }))
    await waitFor(() => expect(command).toHaveBeenCalledExactlyOnceWith({
      kind: 'notificationPolicy',
      identity: { userId: '@me:test', deviceId: 'D' },
      scope: 'channel',
      roomId: '!general:test',
      level: 'nothing'
    }))
  })

  it('shows channel details and the active company roster count without a default-state notice', async () => {
    setup(channelRoom('!general:test'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Channel details' }))
    const dialog = await screen.findByRole('dialog', { name: 'Channel details' })
    expect(within(dialog).getByText('general')).toBeTruthy()
    // One active and one invited person count; the removed one does not.
    await waitFor(() => expect(within(dialog).getByText('2 members')).toBeTruthy())
    expect(within(dialog).queryByText('Company channels are not end-to-end encrypted')).toBeNull()
  })
})

describe('rail and palette', () => {
  const rail = (badge?: { mentions: number; label: string }) =>
    render(
      <AtumNavSwitchSurface
        ariaLabel="Main navigation"
        destination="chat"
        discoverLabel="Discover"
        homeLabel="Home"
        onDestinationChange={vi.fn()}
        workplaceAvailable
        workplaceBadge={badge}
        workplaceLabel="Workplace"
      />
    )

  it('draws a dot for unread and a count for mentions on the Workplace icon, and nothing otherwise', () => {
    const { unmount } = rail({ mentions: 0, label: 'New messages' })
    expect(screen.getByRole('button', { name: 'Workplace · New messages' }).querySelector('[data-atum-nav-badge="unread"]')).toBeTruthy()
    unmount()
    const second = rail({ mentions: 3, label: 'Mentions you' })
    expect(screen.getByRole('button', { name: 'Workplace · Mentions you: 3' }).querySelector('[data-atum-nav-badge="mention"]')?.textContent).toBe('3')
    second.unmount()
    rail()
    expect(screen.getByRole('button', { name: 'Workplace' }).querySelector('[data-atum-nav-badge]')).toBeNull()
  })

  it('lists channel entries under their own Channels heading', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixCommandPalette
          actions={[
            { id: 'channel:!general:test', group: 'channels', label: 'general', run: vi.fn() },
            { id: 'room:!a:test', group: 'chats', label: 'Linh', run: vi.fn() }
          ]}
          onOpenChange={vi.fn()}
          open
        />
      </I18nProvider>
    )
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Channels')).toBeTruthy()
    expect(within(dialog).getByText('general')).toBeTruthy()
  })
})
