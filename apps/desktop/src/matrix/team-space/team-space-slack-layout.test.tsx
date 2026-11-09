import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { matrixAgo } from '../message-time'

import {
  TeamSpaceDayDivider,
  teamSpaceDayLabel,
  teamSpaceFirstUnreadMessageId,
  teamSpaceNewDay,
  TeamSpaceNewMessagesDivider,
  TeamSpaceThreadSummary
} from './message-parts'
import {
  CHANNEL_IDS,
  channelRoom,
  CONVERSATION_IDS,
  conversationRoom,
  platform,
  renderTeamSpace,
  resetTeamSpace,
  type ScriptedConversation,
  TestResizeObserver
} from './test-support'

vi.stubGlobal('ResizeObserver', TestResizeObserver)

beforeEach(() => resetTeamSpace())
afterEach(cleanup)

const general = { id: CHANNEL_IDS.general, name: 'general', systemKey: 'default' as const, actions: ['update_metadata' as const] }
const withBao: ScriptedConversation = { id: CONVERSATION_IDS.dm, others: ['admin'] }
const withBaoAndLan: ScriptedConversation = { id: CONVERSATION_IDS.group, others: ['admin', 'member'] }

const channelsSection = () => window.document.querySelector('[data-matrix-company-channels]') as HTMLElement
const conversationsSection = () => window.document.querySelector('[data-matrix-company-conversations]') as HTMLElement

const conversationsReady = async () => {
  await waitFor(() => expect(conversationsSection()).toBeTruthy())

  return conversationsSection()
}

describe('Team Space’s Slack sidebar', () => {
  it('pins the company name over a kit search field that filters channels and conversations', async () => {
    const source = platform({ channels: [general] })
    source.bridge.search = vi.fn()
    source.bridge.open = vi.fn()
    renderTeamSpace(source, { onOpenSearchResult: vi.fn(async () => {}), rooms: [channelRoom(general.id, 'general')],
      searchEnabled: true })

    await screen.findByRole('button', { name: 'Open # general' })
    const header = window.document.querySelector('[data-team-space-sidebar-header]') as HTMLElement
    expect(within(header).getByRole('heading', { name: 'Atum Studio' })).toBeTruthy()
    const search = screen.getByRole('textbox', { name: 'Search Atum Studio' })
    expect(search.closest('.ak-field--search')).toBeTruthy()
    fireEvent.change(search, { target: { value: 'missing' } })
    expect(screen.queryByRole('button', { name: 'Open # general' })).toBeNull()
    fireEvent.change(search, { target: { value: 'general' } })
    expect(screen.getByRole('button', { name: 'Open # general' })).toBeTruthy()
    // Release B does not explain the default encryption state in the sidebar,
    // and nothing anywhere in the layout renders the default-state notice.
    expect(window.document.querySelector('[data-matrix-company-sidebar] [data-matrix-company-not-encrypted]')).toBeNull()
    expect(window.document.querySelector('[data-matrix-company-not-encrypted]')).toBeNull()
  })

  it('does not invent a direct-message placeholder for the channel Chief of Staff', async () => {
    const source = platform({ conversationsOn: false })
    renderTeamSpace(source)

    await screen.findByRole('button', { name: 'Open # general' })
    expect(screen.queryByRole('button', { name: 'Atum Studio Assistant' })).toBeNull()
    expect(window.document.querySelector('[data-matrix-company-bot-placeholder]')).toBeNull()
  })

  it('never creates a default channel client-side', async () => {
    const source = platform({ channels: [general] })
    renderTeamSpace(source, { ensureDefaultChannels: true, rooms: [channelRoom(general.id, 'general')] })

    await screen.findByRole('button', { name: 'Open # general' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(source.calls('channel-command').filter(call =>
      call.action === 'channel-command' && call.command.operation === 'create')).toHaveLength(0)
  })

  it('puts the add control in the Channels header and offers to create or browse', async () => {
    const source = platform({ channels: [general] })
    renderTeamSpace(source, { rooms: [channelRoom(general.id, 'general')] })

    await screen.findByRole('button', { name: 'Open # general' })
    expect(channelsSection().querySelector('[data-team-space-sidebar-add-row]')).toBeNull()
    const add = within(channelsSection()).getByRole('button', { name: 'Add channels' })
    expect(add.closest('[data-team-space-section-action]')).toBeTruthy()

    fireEvent.keyDown(add, { key: 'Enter' })
    expect((await screen.findAllByRole('menuitem')).map(item => item.textContent)).toEqual(['Create a channel', 'Browse channels'])
  })

  it('shows a DM’s person as a face and a group as overlapping faces', async () => {
    const source = platform({ conversationsOn: true, conversations: [withBao, withBaoAndLan] })
    renderTeamSpace(source, { rooms: [withBao, withBaoAndLan].map(item => conversationRoom(item.id)) })

    await within(await conversationsReady()).findByRole('button', { name: 'Open conversation with Bảo' })
    const [dm, group] = [...conversationsSection().querySelectorAll('[data-matrix-company-conversation-row]')]
    expect(dm!.querySelector('.atum-avatar')?.textContent).toBe('B')
    expect([...group!.querySelectorAll('[data-conversation-group-avatar] .atum-avatar')].map(face => face.textContent)).toEqual([
      'B',
      'L'
    ])
  })

  it('pins "Invite teammates" in the sidebar footer for someone who may invite, and it opens the invite', async () => {
    const source = platform({ conversationsOn: true, conversations: [withBao] })
    renderTeamSpace(source, { rooms: [conversationRoom(withBao.id)] })

    await conversationsReady()
    expect(within(conversationsSection()).queryByRole('button', { name: 'Invite teammates' })).toBeNull()
    const add = screen.getByRole('button', { name: 'Invite teammates' })
    expect(add.hasAttribute('data-team-space-invite-teammates')).toBe(true)
    fireEvent.click(add)
    expect(await screen.findByRole('dialog', { name: /^Add people to / })).toBeTruthy()
  })

  it('offers no pinned invite control to a member who may not invite', async () => {
    const source = platform({ viewer: 'member', conversationsOn: true, conversations: [withBao] })
    renderTeamSpace(source, { rooms: [conversationRoom(withBao.id)] })

    await within(await conversationsReady()).findByRole('button', { name: /Open conversation with/ })
    expect(screen.queryByRole('button', { name: 'Invite teammates' })).toBeNull()
  })
})

describe('Team Space’s day lines', () => {
  const at = (day: number, hour: number) => new Date(2026, 9, day, hour).getTime()

  it('starts a day line where the calendar day changes, and on the first message', () => {
    expect(teamSpaceNewDay(undefined, at(25, 9))).toBe(true)
    expect(teamSpaceNewDay(at(25, 1), at(25, 23))).toBe(false)
    expect(teamSpaceNewDay(at(24, 23), at(25, 0))).toBe(true)
  })

  it('says Today and Yesterday in words, and an older day by its date', () => {
    const now = at(26, 10)
    expect(teamSpaceDayLabel(at(26, 8), 'en', now)).toBe('Today')
    expect(teamSpaceDayLabel(at(25, 8), 'en', now)).toBe('Yesterday')
    expect(teamSpaceDayLabel(at(26, 8), 'vi', now)).toBe('Hôm nay')
    expect(teamSpaceDayLabel(at(20, 8), 'en', now)).toBe('Tuesday, October 20')
  })
})

describe('Team Space’s thread line (Slack, owner 2026-11-03)', () => {
  const faces = [
    { id: '@cos:test', name: 'Chief of Staff', companyAIPrincipal: '00000000-0000-4000-8000-de1333e5ebbe' },
    { id: '@linh:test', name: 'Linh' }
  ]
  const renderThreadLine = (
    lastReplyAt: number | undefined,
    { locale = 'en', unread = true, onOpen = () => {}, lineFaces = faces }:
      { locale?: string; unread?: boolean; onOpen?: () => void; lineFaces?: typeof faces } = {}
  ) =>
    render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <TeamSpaceThreadSummary
          faces={lineFaces}
          lastReplyAt={lastReplyAt}
          messageId="$root"
          onOpen={onOpen}
          replyCount={2}
          unread={unread}
        />
      </I18nProvider>
    )

  it('reads faces, the count, then when the last reply came, as one button that opens the thread', () => {
    const open = vi.fn()
    renderThreadLine(Date.now() - 3 * 60_000, { onOpen: open })

    const line = screen.getByRole('button', { name: '2 replies, Unread, Last reply 3 minutes ago' })
    const order = [...line.querySelectorAll('[data-thread-summary-faces], [data-thread-summary-count], [data-team-space-last-reply]')]
      .map(element => (element.hasAttribute('data-thread-summary-faces') ? 'faces' : element.textContent?.trim()))
    expect(order).toEqual(['faces', '2 replies', 'Last reply 3 minutes ago'])
    // Round faces (people and assistants are circles), presence dots hidden at this size.
    expect(line.querySelectorAll('[data-thread-summary-faces] .ak-avatar, [data-thread-summary-faces] .atum-avatar').length)
      .toBeGreaterThanOrEqual(2)
    expect(line.querySelector('[data-team-space-thread-unread]')).toBeTruthy()
    // Slack swaps in "View thread" on hover; it is in the line, shown by the hover style only.
    expect(line.querySelector('[data-team-space-view-thread]')?.className).toContain('hidden')
    expect(line.querySelector('[data-team-space-view-thread]')?.className).toContain('group-hover/thread-line:inline')

    fireEvent.click(line)
    expect(open).toHaveBeenCalledOnce()
  })

  it('caps the faces at five repliers and drops the dot once read', () => {
    renderThreadLine(Date.now() - 2 * 3_600_000, {
      unread: false,
      lineFaces: Array.from({ length: 7 }, (_, index) => ({ id: `@p${index}:test`, name: `P${index}` })) as typeof faces
    })

    const line = screen.getByRole('button')
    expect(line.querySelectorAll('[data-thread-summary-faces] [data-person-avatar]')).toHaveLength(5)
    expect(line.querySelector('[data-team-space-thread-unread]')).toBeNull()
    expect(line.querySelector('[data-team-space-last-reply]')?.textContent).toBe('Last reply 2 hours ago')
  })

  it('says the last reply in the reader’s language and moves on with the clock', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })

    try {
      renderThreadLine(Date.now() - 60_000, { locale: 'vi' })
      expect(screen.getByRole('button').querySelector('[data-team-space-last-reply]')?.textContent)
        .toBe('Trả lời gần nhất 1 phút trước')
      expect(screen.getByRole('button').querySelector('[data-thread-summary-count]')?.textContent).toBe('2 câu trả lời')

      act(() => void vi.advanceTimersByTime(5 * 60_000))
      expect(screen.getByRole('button').querySelector('[data-team-space-last-reply]')?.textContent)
        .toBe('Trả lời gần nhất 6 phút trước')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows "View thread" in place of a time it cannot know', () => {
    renderThreadLine(undefined, { unread: false })

    const line = screen.getByRole('button', { name: '2 replies' })
    expect(line.querySelector('[data-team-space-last-reply]')).toBeNull()
    expect(line.querySelector('[data-team-space-view-thread]')?.className).not.toMatch(/(^| )hidden( |$)/u)
  })
})

describe('the thread line’s “ago”', () => {
  const now = Date.UTC(2026, 10, 3, 13, 38)

  it('never says now or the future, and reaches days, months and years', () => {
    expect(matrixAgo(now + 30_000, 'en', now)).toBe('1 minute ago')
    expect(matrixAgo(now - 59 * 60_000, 'en', now)).toBe('59 minutes ago')
    expect(matrixAgo(now - 3 * 3_600_000, 'en', now)).toBe('3 hours ago')
    expect(matrixAgo(now - 26 * 3_600_000, 'en', now)).toBe('yesterday')
    expect(matrixAgo(now - 40 * 86_400_000, 'en', now)).toBe('last month')
    expect(matrixAgo(now - 100 * 86_400_000, 'en', now)).toBe('3 months ago')
    expect(matrixAgo(now - 800 * 86_400_000, 'en', now)).toBe('2 years ago')
  })
})

describe('Team Space unread boundary', () => {
  const message = (id: string, own = false) => ({
    id,
    sender: own ? '@me:test' : '@other:test',
    body: id,
    timestamp: 1,
    own,
    encrypted: false,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false
  })

  it('places the divider before the first loaded received message covered by the unread count', () => {
    expect(teamSpaceFirstUnreadMessageId([
      message('$old'),
      message('$mine', true),
      message('$first'),
      message('$latest')
    ], 2)).toBe('$first')
    expect(teamSpaceFirstUnreadMessageId([message('$old')], 0)).toBeUndefined()
  })

  it('renders the localized divider as the jump-to-first-unread action', () => {
    const jump = vi.fn()
    render(
      <I18nProvider configClient={null} initialLocale="vi">
        <TeamSpaceNewMessagesDivider onJump={jump} />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Tin nhắn mới' }))
    expect(jump).toHaveBeenCalledOnce()
  })

  // Preserve user-visible identity, state and recovery behavior across connection changes.
  // ("New messages" over "Today"). They share one line: the day pill and the unread pill, centred.
  it('joins the unread pill to the day line when both start at the same message', () => {
    const jump = vi.fn()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <TeamSpaceDayDivider onJumpToNew={jump} timestamp={Date.now()} />
      </I18nProvider>
    )

    const separators = screen.getAllByRole('separator')
    expect(separators).toHaveLength(1)
    const line = separators[0]
    expect(line.classList.contains('justify-center')).toBe(true)
    expect(line.hasAttribute('data-divider-emphasis')).toBe(true)
    expect(line.getAttribute('aria-label')).toBe('Today, New messages')
    const pills = line.querySelectorAll(':scope > .atum-divider-pill')
    expect(pills).toHaveLength(2)
    expect(pills[0].hasAttribute('data-divider-plain')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'New messages' }))
    expect(jump).toHaveBeenCalledOnce()
  })

  // Preserve user-visible identity, state and recovery behavior across connection changes.
  // shape (a hairline, a centred pill), with its own emphasis; both take their colours from the
  // shared divider styles, so a chat's look can retint them.
  it.each([true, false])('centres the unread pill like the day pill (flat: %s)', flat => {
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <TeamSpaceDayDivider flat={flat} timestamp={Date.now()} />
        <TeamSpaceNewMessagesDivider flat={flat} onJump={() => {}} />
      </I18nProvider>
    )

    const day = window.document.querySelector<HTMLElement>('[data-team-space-day]')!
    const unread = window.document.querySelector<HTMLElement>('[data-team-space-new-messages]')!

    for (const divider of [day, unread]) {
      expect(divider.classList.contains('atum-divider')).toBe(true)
      expect(divider.classList.contains('justify-center')).toBe(true)
      expect(divider.querySelector(':scope > .atum-divider-line')).toBeTruthy()
      const pill = divider.querySelector<HTMLElement>(':scope > .atum-divider-pill')!
      expect(pill.className).not.toContain('ms-auto')
      expect([...pill.classList].some(name => name.startsWith('bg-') || name.startsWith('text-('))).toBe(false)
    }

    expect(screen.getByRole('button', { name: 'New messages' }).classList.contains('atum-divider-pill')).toBe(true)
    expect(unread.hasAttribute('data-divider-emphasis')).toBe(true)
    expect(day.hasAttribute('data-divider-emphasis')).toBe(false)
  })
})
