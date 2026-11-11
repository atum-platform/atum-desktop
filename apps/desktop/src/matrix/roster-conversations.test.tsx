import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { en } from '@/i18n/en'
import { vi as viCopy } from '@/i18n/vi'

import { rankConversationCandidates } from '../../shared/agent-conversation'
import type { AppDescriptor } from '../../shared/app-catalog'
import { ACME, ACME_GUEST, botApp, botUserOf, Demoza } from '../../shared/app-catalog.test-support'
import type { MatrixExecutionPolicyView } from '../../shared/execution-policy'
import { parseExecutionPolicySnapshot, parseExecutionStatusSnapshot } from '../../shared/execution-policy'
import policyFixture from '../../shared/execution-policy/fixtures/execution-policy/v1/fixtures/policy-saved.response.json'
import statusFixture from '../../shared/execution-policy/fixtures/execution-policy/v1/fixtures/status-working.response.json'
import type { MatrixRoom, MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import { matrixActionCopy } from '../../shared/matrix-action-copy'
import { appChatCopy } from '../../shared/matrix-app-chat-copy'
import { PRIMARY_ASSISTANT_KEEPS_NAME } from '../../shared/matrix-assistant-name'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'
import { MATRIX_COMPANY_CHANNEL_TYPE } from '../../shared/matrix-company-channel-room'
import { MATRIX_NOTES_SELF_ROOM_TYPE } from '../../shared/matrix-notes-self'

import { matrixAppCopy } from './app-copy'
import { type ConversationRoomProjection, resolveProjectedConversation } from './conversation-marker'
import { $founderDraftOpen, closeFounderDraft } from './founder/founder-store'
import { $matrixMemberAvatars } from './member-avatars'
import { bindMatrixHandleOwner, rememberMatrixHandle, resetMatrixHandlesForTest } from './person-handles'
import { matrixAgentDot, matrixListenerStatus, MatrixRosterConversations } from './roster-conversations'
import { matrixAgentConversationRoom } from './roster-preview'

const owner = '@owner:test'

afterEach(() => {
  cleanup()
  closeFounderDraft()
  resetMatrixHandlesForTest()
  Reflect.deleteProperty(window, 'atumMatrix')
})

function privateRoom(id: string, agentId: string, extra: Partial<MatrixRoom> = {}): MatrixRoom {
  return {
    id,
    name: id,
    membership: 'join',
    encrypted: true,
    roomType: MATRIX_ASSISTANT_ROOM_TYPE,
    participants: [
      { userId: owner, membership: 'join' },
      { userId: agentId, membership: 'join' }
    ],
    ...extra
  }
}

function readySnapshot(): MatrixSnapshot {
  return {
    state: 'ready',
    identity: { userId: owner, deviceId: 'OWNER' },
    ownProfile: { userId: owner, displayName: 'Minh', avatarMxc: null },
    assistant: { userId: '@atum:test', deviceId: 'ATUM' },
    agents: [
      { principal: 'default', userId: '@atum:test', isDefault: true, ready: true, hermes: 'ready', atumModel: true },
      {
        principal: 'moon',
        userId: '@moon:test',
        name: 'Moon',
        isDefault: false,
        ready: true,
        hermes: 'ready',
        atumModel: true
      }
    ],
    rooms: [
      privateRoom('!atum-old:test', '@atum:test', { name: 'Atum old', lastActiveAt: 1 }),
      privateRoom('!atum-new:test', '@atum:test', { name: 'Atum newest', lastActiveAt: 5 }),
      privateRoom('!moon:test', '@moon:test', { name: 'Moon chat', agentPrincipal: 'moon', lastActiveAt: 2 }),
      {
        id: '!people:test',
        name: '@eve:matrix.test',
        membership: 'join',
        encrypted: true,
        participants: [{ userId: owner, membership: 'join' }]
      }
    ],
    roomId: null,
    messages: [],
    error: null
  }
}

function setup(
  snapshot = readySnapshot(),
  query = '',
  locale: 'en' | 'vi' = 'en',
  external: { count: number; searching: boolean } = { count: 0, searching: false },
  cloudOnly?: boolean
) {
  const command = vi.fn<MatrixUiBridge['command']>().mockResolvedValue(null)
  const openAssistant = vi.fn()
  const openAgentChat = vi.fn()
  const onEditAgent = vi.fn()
  const onOpen = vi.fn()
  const fail = vi.fn()
  window.atumMatrix = { command } as unknown as MatrixUiBridge

  const content = (snapshot: MatrixSnapshot, query: string) => (
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixRosterConversations
        agentActions={<button type="button">New agent</button>}
        assistantOpening={false}
        cloudOnly={cloudOnly}
        externalResultCount={external.count}
        externalSearching={external.searching}
        fail={fail}
        onEditAgent={onEditAgent}
        onOpen={onOpen}
        openAgentChat={openAgentChat}
        openAssistant={openAssistant}
        query={query}
        snapshot={snapshot}
      >
        <button type="button">App catalog</button>
      </MatrixRosterConversations>
    </I18nProvider>
  )

  const view = render(content(snapshot, query))

  return {
    command,
    fail,
    onOpen,
    openAssistant,
    openAgentChat,
    onEditAgent,
    view,
    search: (query: string, next = snapshot) => view.rerender(content(next, query))
  }
}

const roomRow = (id: string) => window.document.querySelector<HTMLElement>(`[data-matrix-room="${id}"]`)!
const rowButton = (id: string) => within(roomRow(id)).getByRole('button')

const histories = (section: HTMLElement) =>
  [...section.querySelectorAll('[data-matrix-room]')].map(row => row.getAttribute('data-matrix-room'))

/** A right-click on a row: its context menu, at the pointer. */
function rightClick(element: HTMLElement) {
  fireEvent.contextMenu(element)

  return screen.getByRole('menu')
}

describe('MatrixRosterConversations', () => {
  it('shows an assistant handle below its name in search and finds it by handle', () => {
    bindMatrixHandleOwner(owner)
    rememberMatrixHandle('@moon:test', 'wendy_helper_bot')
    const snapshot = readySnapshot()
    snapshot.agents![1]!.name = 'Wendy'
    snapshot.rooms[2]!.preview = { kind: 'text', text: 'Private preview', own: false, at: 1 }
    const roster = setup(snapshot, 'wendy')
    expect(screen.getByText('@wendy_helper_bot')).toBeTruthy()
    expect(screen.queryByText('Private preview')).toBeNull()
    roster.search('wendy_helper_bot')
    expect(screen.getByText('@wendy_helper_bot')).toBeTruthy()
    roster.search('')
    expect(screen.queryByText('@wendy_helper_bot')).toBeNull()
  })

  it('requests handles for assistants that have no chat yet', async () => {
    const request = vi.fn(async (..._args: unknown[]) => ({ ok: true, value: { kind: 'contacts', contacts: [] } }))
    const snapshot = readySnapshot()
    snapshot.domainEnabled = true
    snapshot.rooms = []
    setup(snapshot)
    window.atumMatrix.aliases = { request } as unknown as NonNullable<MatrixUiBridge['aliases']>
    await waitFor(() => expect(request).toHaveBeenCalled(), { timeout: 1500 })
    expect(request.mock.calls[0]).toEqual([{ action: 'contacts', matrixUsers: ['@atum:test', '@moon:test'], schemaVersion:2 }])
  })

  it('keeps the personal notes room off Home without listing its backing room as an ordinary chat', () => {
    const snapshot = readySnapshot()
    const notes: MatrixRoom = {
      id: '!notes:test',
      name: 'Spoofable room name',
      membership: 'join',
      encrypted: false,
      roomType: MATRIX_NOTES_SELF_ROOM_TYPE,
      participants: [{ userId: owner, membership: 'join' }]
    }
    snapshot.rooms.push(notes)
    snapshot.notesSelf = {
      state: 'ready',
      roomId: notes.id,
      duplicates: [],
      quarantinedRoomIds: [],
      retiredRoomIds: [],
      pointerWritable: true
    }

    setup(snapshot)

    expect(window.document.querySelector('[data-matrix-notes-self-row]')).toBeNull()
    expect(window.document.querySelector(`[data-matrix-room="${notes.id}"]`)).toBeNull()
  })

  it('finds a direct chat by its verified handle and shows that handle under its display name', () => {
    const snapshot = readySnapshot()
    const personId = '@user-opaque:test'
    snapshot.rooms = [
      {
        id: '!poon:test',
        name: 'Poon Nguyen',
        membership: 'join',
        encrypted: false,
        direct: true,
        participants: [
          { userId: owner, membership: 'join' },
          { userId: personId, membership: 'join' }
        ]
      }
    ]
    bindMatrixHandleOwner(owner)
    rememberMatrixHandle(personId, 'poon')

    setup(snapshot, '@poon')

    const row = screen.getByRole('button', { name: 'Poon Nguyen' })
    expect(within(row).getByText('@poon')).toBeTruthy()
  })

  it('shows a direct chat\'s latest message and no handle once anyone has written', () => {
    const snapshot = readySnapshot()
    const personId = '@user-4c65aa0b1c2d3e4f5a6b7c8d9e0f1a2b:test'
    const nobodyId = '@user-9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f:test'
    const direct = (id: string, name: string, userId: string): MatrixRoom => ({
      id,
      name,
      membership: 'join',
      encrypted: false,
      direct: true,
      preview: { kind: 'text', text: 'See you tomorrow', own: false, sender: name, at: 1 },
      participants: [
        { userId: owner, membership: 'join' },
        { userId, membership: 'join' }
      ]
    })
    snapshot.rooms = [direct('!poon:test', 'Poon Nguyen', personId), direct('!nobody:test', 'Lan', nobodyId)]
    bindMatrixHandleOwner(owner)
    rememberMatrixHandle(personId, 'poon')

    setup(snapshot)

    // You have talked: you know them. The line is the conversation's, like any other chat.
    const poon = screen.getByRole('button', { name: 'Poon Nguyen' })
    expect(poon.querySelector('[data-roster-preview]')?.textContent).toBe('See you tomorrow')
    expect(poon.querySelector('[data-person-handle]')).toBeNull()
    expect(poon.textContent).not.toContain('@poon')
    const lan = screen.getByRole('button', { name: 'Lan' })
    expect(lan.querySelector('[data-person-handle]')).toBeNull()
    expect(lan.textContent).not.toMatch(/user-[0-9a-f]{8}/)
  })

  it('puts the verified handle under the name, never beside it, while a direct chat is empty', () => {
    const snapshot = readySnapshot()
    const personId = '@user-4c65aa0b1c2d3e4f5a6b7c8d9e0f1a2b:test'
    const nobodyId = '@user-9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f:test'
    const empty = (id: string, name: string, userId: string): MatrixRoom => ({
      id,
      name,
      membership: 'join',
      encrypted: false,
      direct: true,
      participants: [
        { userId: owner, membership: 'join' },
        { userId, membership: 'join' }
      ]
    })
    snapshot.rooms = [empty('!poon:test', 'Poon Nguyen', personId), empty('!nobody:test', 'Lan', nobodyId)]
    bindMatrixHandleOwner(owner)
    rememberMatrixHandle(personId, 'poon')

    setup(snapshot)

    const poon = screen.getByRole('button', { name: 'Poon Nguyen' })
    const line = poon.querySelector('[data-roster-preview]')
    expect(line?.textContent).toBe('@poon')
    expect(line?.hasAttribute('data-person-handle')).toBe(true)
    expect(poon.querySelector('[data-roster-name] [data-person-handle]')).toBeNull()
    // No handle to give: no second line at all, and never the Matrix ID.
    const lan = screen.getByRole('button', { name: 'Lan' })
    expect(lan.querySelector('[data-person-handle]')).toBeNull()
    expect(lan.querySelector('[data-roster-preview]')).toBeNull()
    expect(lan.textContent).not.toMatch(/user-[0-9a-f]{8}/)
  })

  it('shows the paused hire banner and Gia hạn action from the roster snapshot', () => {
    const snapshot = readySnapshot()
    snapshot.agents![1] = {
      ...snapshot.agents![1]!,
      assistantId: '00000000-0000-4000-8000-c7f28d560f2e',
      hire: { state: 'paused', price_protons: 60_000, renewal_error: 'insufficient_protons' }
    }
    const { view } = setup(snapshot, '', 'vi')

    expect(view.container.textContent).toContain('Trợ lý này đang tạm dừng.')
    expect(screen.getByRole('button', { name: 'Gia hạn' })).toBeTruthy()
  })

  it('keeps company channels out of the personal chat roster', () => {
    const snapshot = readySnapshot()
    snapshot.companyWorkspaceEnabled = true
    snapshot.rooms.push({
      id: '!channel:test',
      name: 'chung',
      membership: 'join',
      encrypted: false,
      roomType: MATRIX_COMPANY_CHANNEL_TYPE,
      companyChannel: { companyId: 'c1', channelId: '00000000-0000-4000-8000-676a3a34ff0f' },
      lastActiveAt: 9
    })
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixRosterConversations
          assistantOpening={false}
          fail={vi.fn()}
          onOpen={vi.fn()}
          openAgentChat={vi.fn()}
          openAssistant={vi.fn()}
          snapshot={snapshot}
        />
      </I18nProvider>
    )

    expect(window.document.querySelector('[data-matrix-room="!channel:test"]')).toBeNull()
    expect(screen.queryByText('chung')).toBeNull()
  })

  it('sums an assistant’s unread chats on its row and keeps its actions in its context menu', async () => {
    const snapshot = readySnapshot()
    snapshot.rooms[0]!.unreadNotifications = 7
    snapshot.rooms[1]!.unreadNotifications = 105
    snapshot.rooms[2]!.unreadNotifications = 4
    snapshot.agents![0]!.content = { state: 'differs' }
    snapshot.agents![1]!.content = { state: 'incomplete' }
    snapshot.agents![0]!.listening = {
      state: 'listening',
      mode: 'continuous',
      roomId: '!atum-new:test',
      expiresAt: 100,
      queued: 0
    }
    snapshot.agents![1]!.listening = {
      state: 'paused',
      reason: 'lease_elsewhere',
      mode: 'continuous',
      roomId: '!moon:test',
      expiresAt: 100,
      queued: 0
    }
    const { command, onOpen, openAgentChat, onEditAgent, view } = setup(snapshot)

    expect(within(screen.getByLabelText('Unread notifications: 112')).getByText('99+')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Atum', description: /112/ })).toBeTruthy()
    expect(
      within(within(screen.getByRole('button', { name: 'Moon' })).getByLabelText('Unread notifications: 4')).getByText(
        '4'
      )
    ).toBeTruthy()
    // Folded, an assistant lists none of its histories: its row carries their badge and
    // opens the one it points at. There is no chevron and no "…" anywhere.
    expect(screen.queryByText('Atum newest')).toBeNull()
    expect(screen.queryByText('Atum old')).toBeNull()
    expect(screen.queryByRole('button', { name: /Show chats|Hide chats|Options for/ })).toBeNull()

    for (const row of view.container.querySelectorAll('[data-matrix-agent]')) {
      // At most one listener dot, attached to the avatar, irrespective of content health; a
      // ready assistant draws none (Atum Kit: colour is rare).
      expect(row.querySelectorAll('span.inline-block.rounded-full').length).toBeLessThanOrEqual(1)
      expect(within(row as HTMLElement).queryByRole('button', { name: /Content on this Mac/ })).toBeNull()
    }

    const moon = screen.getByRole('button', { name: 'Moon' })
    rightClick(moon)
    expect(screen.queryByRole('menuitem', { name: 'New chat: Moon' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Delete Moon' })).toBeTruthy()
    // What an assistant has on this Mac lives in its edit sheet now, not this menu.
    expect(screen.queryByRole('menuitem', { name: /Content on this Mac/ })).toBeNull()
    expect(command).not.toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
    expect(openAgentChat).not.toHaveBeenCalled()

    rightClick(moon)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit assistant… Moon' }))
    expect(onEditAgent).toHaveBeenCalledExactlyOnceWith(snapshot.agents![1])
    rightClick(moon)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename… Moon' }))
    expect(onEditAgent).toHaveBeenLastCalledWith(snapshot.agents![1], 'name')
    // ⌘I on the row is Get Info: the same card.
    fireEvent.keyDown(moon, { key: 'i', metaKey: true })
    expect(onEditAgent).toHaveBeenLastCalledWith(snapshot.agents![1])
    expect(onEditAgent).toHaveBeenCalledTimes(3)
    expect(command).not.toHaveBeenCalled()

    // From the keyboard: Shift-F10 opens the same menu under the row, and Escape gives focus back.
    const atum = screen.getByRole('button', { name: 'Atum' })
    atum.focus()
    fireEvent.keyDown(atum, { key: 'F10', shiftKey: true })
    expect(screen.queryByRole('menuitem', { name: 'Start a new Atum chat' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /Delete/ })).toBeNull()
    // The primary's card opens; it is renamed like any assistant unless owner decision D1 locks it.
    expect(screen.getByRole('menuitem', { name: 'Edit assistant… Atum' })).toBeTruthy()

    if (PRIMARY_ASSISTANT_KEEPS_NAME) {
      expect(screen.queryByRole('menuitem', { name: /Rename…/ })).toBeNull()
    } else {
      expect(screen.getByRole('menuitem', { name: 'Rename… Atum' })).toBeTruthy()
    }

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await waitFor(() => expect(window.document.activeElement).toBe(atum))
  })

  it('opens the context menu with the context-menu key too, and never navigates by opening it', () => {
    const { command, onOpen } = setup()
    const eve = rowButton('!people:test')

    fireEvent.keyDown(eve, { key: 'ContextMenu' })
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
    expect(command).not.toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('opens a row’s menu on a long press, and the tap that ends the press does not open the chat', () => {
    vi.useFakeTimers()

    try {
      const { command, onOpen } = setup()
      const eve = rowButton('!people:test')

      fireEvent.pointerDown(eve, { pointerType: 'touch', clientX: 20, clientY: 20 })
      act(() => {
        vi.advanceTimersByTime(800)
      })
      expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
      fireEvent.pointerUp(eve, { pointerType: 'touch' })
      fireEvent.click(eve)
      expect(command).not.toHaveBeenCalled()
      expect(onOpen).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders each agent once as one row that opens its one conversation, never a list of its chats', () => {
    const { command, onOpen, openAssistant, view } = setup()

    expect(screen.getAllByText('Atum')).toHaveLength(1)
    expect(screen.getAllByText('Moon')).toHaveLength(1)
    expect(screen.getByText('@eve:matrix.test')).toBeTruthy()
    expect(screen.getByText('App catalog')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Assistants' })).toBeTruthy()
    const newAgent = screen.getByRole('button', { name: 'New agent' })
    const chats = screen.getByRole('heading', { name: 'Chats' })
    expect(newAgent.compareDocumentPosition(chats) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const moon = screen.getByRole('button', { name: 'Moon' })
    expect(moon.hasAttribute('aria-expanded')).toBe(false)
    fireEvent.click(moon)
    expect(onOpen).toHaveBeenCalledOnce()
    expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: '!moon:test' })

    // Several chats: still one row, opening the newest; nothing opens under it.
    const atum = screen.getByRole('button', { name: 'Atum' })
    expect(atum.hasAttribute('aria-expanded')).toBe(false)
    fireEvent.click(atum)
    expect(openAssistant).toHaveBeenCalledExactlyOnceWith(false, '!atum-new:test')
    const section = view.container.querySelector<HTMLElement>('[data-matrix-agent="default"]')!
    expect(histories(section)).toEqual([])
    expect(screen.queryByText('Atum old')).toBeNull()
    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).toBeNull()
  })

  it('stands for the chat on screen, and opens its one conversation from any of its chats', () => {
    const snapshot = readySnapshot()
    const { openAssistant, search, view } = setup(snapshot)
    const section = () => view.container.querySelector<HTMLElement>('[data-matrix-agent="default"]')!

    search('', { ...snapshot, roomId: '!atum-old:test' })
    expect(histories(section())).toEqual([])
    expect(screen.getByRole('button', { name: 'Atum' }).getAttribute('aria-current')).toBe('page')

    fireEvent.click(screen.getByRole('button', { name: 'Atum' }))
    expect(openAssistant).toHaveBeenCalledExactlyOnceWith(false, '!atum-new:test')
  })

  it('shows a marked main conversation alone: no earlier rooms, no Earlier menu, and only its own badge', () => {
    const snapshot = readySnapshot()
    const marked = { role: 'main' as const, main: '!atum-old:test', at: 2 }
    snapshot.rooms = snapshot.rooms.map(room =>
      room.id === '!atum-old:test'
        ? { ...room, conversation: marked, conversationOwnerId: owner }
        : room.id === '!atum-new:test'
          ? { ...room, unreadNotifications: 6 }
          : room
    )
    snapshot.agents![0] = {
      ...snapshot.agents![0]!,
      conversation: {
        state: 'marked',
        main: '!atum-old:test',
        replaceable: true,
        candidates: ['!atum-old:test', '!atum-new:test'],
        earlier: ['!atum-new:test'],
        skipped: [],
        jobs: null
      }
    }
    const { openAssistant, view } = setup({ ...snapshot, roomId: '!atum-new:test' })
    const atum = screen.getByRole('button', { name: 'Atum' })

    expect(histories(view.container.querySelector<HTMLElement>('[data-matrix-agent="default"]')!)).toEqual([])
    // The earlier room's unread messages are not this row's: it is not the conversation.
    expect(within(atum).queryByLabelText(/Unread notifications/)).toBeNull()
    expect(atum.hasAttribute('aria-current')).toBe(false)
    fireEvent.click(atum)
    expect(openAssistant).toHaveBeenCalledExactlyOnceWith(false, '!atum-old:test')

    rightClick(atum)
    expect(screen.queryByRole('menuitem', { name: /Earlier conversations/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Main conversation' })).toBeNull()
  })

  it('never asks which of an assistant’s conversations is its main: no menu item and no dialog', () => {
    const snapshot = readySnapshot()
    snapshot.rooms = [
      ...snapshot.rooms,
      privateRoom('!moon-old:test', '@moon:test', { name: 'Moon old', agentPrincipal: 'moon', lastActiveAt: 1 })
    ]
    snapshot.agents![1] = {
      ...snapshot.agents![1]!,
      conversation: {
        state: 'legacy',
        proposed: '!moon:test',
        candidates: ['!moon:test', '!moon-old:test'],
        earlier: [],
        skipped: [],
        jobs: 0
      }
    }
    const { command } = setup(snapshot)

    const menu = rightClick(screen.getByRole('button', { name: 'Moon' }))
    expect(within(menu).queryByRole('menuitem', { name: 'Main conversation' })).toBeNull()
    expect(within(menu).queryByRole('menuitem', { name: /conversation/i })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(command).not.toHaveBeenCalled()
  })

  it('says nothing in the roster when an automatic move stopped after its retries', () => {
    const snapshot = readySnapshot()
    snapshot.agents![1] = {
      ...snapshot.agents![1]!,
      conversation: {
        state: 'retry',
        main: '!moon:test',
        candidates: ['!moon:test'],
        earlier: [],
        skipped: [],
        jobs: null,
        reason: 'failed'
      }
    }
    setup(snapshot)

    const menu = rightClick(screen.getByRole('button', { name: 'Moon' }))
    expect(within(menu).queryByRole('menuitem', { name: 'Main conversation' })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens the current default conversation and never offers a fresh-chat menu action', () => {
    const { openAssistant, onOpen } = setup()

    fireEvent.click(screen.getByRole('button', { name: 'Atum' }))
    rightClick(screen.getByRole('button', { name: 'Atum' }))
    expect(screen.queryByRole('menuitem', { name: 'Start a new Atum chat' })).toBeNull()

    expect(openAssistant).toHaveBeenNthCalledWith(1, false, '!atum-new:test')
    // The owning callback already performs navigation and closes the compact drawer.
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('shows the default by the name its owner gave it, and as Atum until it has one', () => {
    const snapshot = readySnapshot()
    snapshot.agents![0] = { ...snapshot.agents![0]!, name: '  Điều phối  ' }
    const { search } = setup(snapshot)

    // Owner decision D1: the primary is renameable, so its record's name is what it is called.
    expect(screen.getByRole('button', { name: 'Điều phối' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Atum' })).toBeNull()
    search('ATUM')
    expect(screen.getByRole('button', { name: 'Điều phối' })).toBeTruthy()
    expect(screen.queryByText('Atum old')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Moon' })).toBeNull()

    search('', { ...snapshot, agents: snapshot.agents!.map(agent => ({ ...agent, name: undefined })) })
    expect(screen.getByRole('button', { name: 'Atum' })).toBeTruthy()
  })

  it('shows named Main once as the first Atum row, with primary actions and independent former-default history', () => {
    const snapshot = readySnapshot()
    snapshot.assistant = { userId: '@main:test', deviceId: 'MAIN' }
    snapshot.agents = [
      { ...snapshot.agents![0]!, name: 'Original assistant', isDefault: false },
      { ...snapshot.agents![1]!, principal: 'main', userId: '@main:test', name: 'Atum Main', isDefault: true }
    ]
    snapshot.rooms = [
      ...snapshot.rooms
        .filter(room => room.id !== '!moon:test')
        .map(room => (room.id.startsWith('!atum') ? { ...room, agentPrincipal: 'default' } : room)),
      privateRoom('!main:test', '@main:test', { name: 'Main retained chat', agentPrincipal: 'main' })
    ]
    const { command, openAssistant, view } = setup(snapshot)
    const rows = view.container.querySelectorAll('[data-matrix-agent]')
    expect([...rows].map(row => row.getAttribute('data-matrix-agent'))).toEqual(['main', 'default'])
    // The promoted primary goes by its record's name (D1), and still wears the Atum mark,
    // drawn inside its tile like an initial in its square.
    expect(screen.getAllByRole('button', { name: /^Atum Main$/ })).toHaveLength(1)
    const mark = rows[0]!.querySelector('[data-atum-assistant-avatar]')!
    expect(mark.hasAttribute('data-atum-eclipse-face')).toBe(true)
    expect(mark.getAttribute('data-atum-eclipse-inset')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /^Atum Main$/ }))
    rightClick(screen.getByRole('button', { name: /^Atum Main$/ }))
    expect(screen.queryByRole('menuitem', { name: /Delete/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Start a new Atum chat' })).toBeNull()
    expect(openAssistant).toHaveBeenNthCalledWith(1, false, '!main:test')
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: /^Original assistant$/ }))
    expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'select', roomId: '!atum-new:test' })
    // One chat is the row itself: nothing to open under Atum.
    expect(screen.getByRole('button', { name: /^Atum Main$/ }).hasAttribute('aria-expanded')).toBe(false)
    // Only the chat with people has a row of its own: each assistant is its one row.
    expect(view.container.querySelectorAll('[data-matrix-room]')).toHaveLength(1)
    expect(within(rows[0] as HTMLElement).queryByText('Main retained chat')).toBeNull()
    expect(within(rows[1] as HTMLElement).queryByText('Atum newest')).toBeNull()
  })

  it('finds an assistant by a chat of its own without listing that chat, and keeps its whole badge', () => {
    const snapshot = readySnapshot()
    snapshot.roomId = '!moon-new:test'
    snapshot.agents![1] = {
      ...snapshot.agents![1]!,
      readiness: { phase: 'degraded', since: 1 }
    }
    snapshot.rooms = [
      ...snapshot.rooms.filter(room => room.agentPrincipal !== 'moon'),
      privateRoom('!moon-old:test', '@moon:test', {
        name: 'Bản kê tháng',
        agentPrincipal: 'moon',
        lastActiveAt: 1,
        unreadNotifications: 3,
        favourite: true
      }),
      privateRoom('!moon-new:test', '@moon:test', {
        name: 'Latest work',
        agentPrincipal: 'moon',
        lastActiveAt: 10,
        unreadNotifications: 4
      })
    ]
    const { command, onOpen, search, view } = setup(snapshot)

    search('  BAN KE   THANG ')
    const moon = view.container.querySelector<HTMLElement>('[data-matrix-agent="moon"]')!
    const row = within(moon).getByRole('button', { name: 'Moon' })
    expect(row.getAttribute('aria-current')).toBe('page')
    expect(within(row).getByLabelText('Unread notifications: 7')).toBeTruthy()
    expect(within(moon).getByText('Unavailable')).toBeTruthy()
    expect(histories(moon)).toEqual([])
    expect(screen.queryByRole('button', { name: 'Bản kê tháng' })).toBeNull()
    expect(command).not.toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()

    // The row opens its conversation: the newest chat waiting unread.
    fireEvent.click(row)
    expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'select', roomId: '!moon-new:test' })
    search('')
    expect(histories(moon)).toEqual([])
  })

  it('opens the chat its unread badge points at, else the newest', () => {
    const snapshot = readySnapshot()
    snapshot.rooms = [
      ...snapshot.rooms.filter(room => room.agentPrincipal !== 'moon'),
      ...Array.from({ length: 7 }, (_, index) =>
        privateRoom(`!moon-${index}:test`, '@moon:test', {
          name: `Moon history ${index}`,
          agentPrincipal: 'moon',
          lastActiveAt: index,
          unreadNotifications: index === 1 ? 2 : undefined
        })
      )
    ]
    snapshot.rooms.find(room => room.id === '!atum-old:test')!.unreadNotifications = 5
    const { command, openAssistant, search, view } = setup(snapshot)
    const moon = view.container.querySelector<HTMLElement>('[data-matrix-agent="moon"]')!
    const atum = view.container.querySelector<HTMLElement>('[data-matrix-agent="default"]')!

    expect(histories(moon)).toEqual([])
    expect(within(moon).getByLabelText('Unread notifications: 2')).toBeTruthy()

    // The agent row goes where its badge points: the newest chat with unread messages, not the newest chat.
    fireEvent.click(within(moon).getByRole('button', { name: 'Moon' }))
    expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'select', roomId: '!moon-1:test' })
    expect(histories(moon)).toEqual([])
    expect(within(moon).getByLabelText('Unread notifications: 2')).toBeTruthy()

    fireEvent.click(within(atum).getByRole('button', { name: 'Atum' }))
    expect(openAssistant).toHaveBeenCalledExactlyOnceWith(false, '!atum-old:test')

    // With nothing unread, the row opens the newest chat.
    command.mockClear()
    search('', { ...snapshot, rooms: snapshot.rooms.map(room => ({ ...room, unreadNotifications: undefined })) })
    fireEvent.click(within(moon).getByRole('button', { name: 'Moon' }))
    expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'select', roomId: '!moon-6:test' })
    fireEvent.click(within(atum).getByRole('button', { name: 'Atum' }))
    expect(openAssistant).toHaveBeenLastCalledWith(false, '!atum-new:test')
  })

  it('lists an assistant once while searching, never its chats', () => {
    const snapshot = readySnapshot()
    snapshot.rooms = [
      ...snapshot.rooms.filter(room => room.agentPrincipal !== 'moon'),
      ...Array.from({ length: 7 }, (_, index) =>
        privateRoom(`!moon-${index}:test`, '@moon:test', {
          name: `Moon history ${index}`,
          agentPrincipal: 'moon',
          lastActiveAt: index
        })
      )
    ]
    const { search, view } = setup(snapshot)
    const moon = () => view.container.querySelector<HTMLElement>('[data-matrix-agent="moon"]')!
    const count = () => moon().querySelectorAll('[data-matrix-room]').length

    expect(count()).toBe(0)
    search('moon')
    expect(count()).toBe(0)
    search('history 0')
    expect(within(moon()).getByRole('button', { name: 'Moon' })).toBeTruthy()
    expect(count()).toBe(0)
    expect(view.container.querySelector('[data-matrix-roster-results]')!.textContent).toBe('1 results')
  })

  it('walks the rows with the arrow keys', () => {
    setup()
    const atum = screen.getByRole('button', { name: 'Atum' })
    const moon = screen.getByRole('button', { name: 'Moon' })

    atum.focus()
    fireEvent.keyDown(atum, { key: 'ArrowDown' })
    expect(window.document.activeElement).toBe(moon)
    fireEvent.keyDown(window.document.activeElement!, { key: 'End' })
    expect(window.document.activeElement).toBe(rowButton('!people:test'))
    fireEvent.keyDown(window.document.activeElement!, { key: 'ArrowUp' })
    expect(window.document.activeElement).toBe(moon)
    fireEvent.keyDown(window.document.activeElement!, { key: 'Home' })
    expect(window.document.activeElement).toBe(atum)
  })

  it('announces displayed results, keeps search name-only, and restores actions on clear', () => {
    const snapshot = readySnapshot()
    snapshot.messages = [
      {
        id: '$hidden',
        sender: owner,
        body: 'Transcript needle',
        timestamp: 1,
        own: true,
        encrypted: true,
        decryptionFailed: false,
        pending: false,
        failed: false,
        attachment: false
      }
    ]
    const { command, search, view } = setup(snapshot, 'old')
    const announcement = view.container.querySelector('[data-matrix-roster-results]')!

    // Atum, found by its old chat, is one result: its row, never the chat itself.
    expect(announcement.getAttribute('aria-live')).toBe('polite')
    expect(announcement.textContent).toBe('1 results')
    expect(screen.queryByRole('button', { name: 'New agent' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'App catalog' })).toBeNull()
    search('Transcript needle')
    expect(announcement.textContent).toBe('0 results')
    expect(screen.getByText('No results found')).toBeTruthy()
    expect(screen.getByText('Try another keyword.')).toBeTruthy()
    expect(view.container.querySelector('[data-matrix-agent]')).toBeNull()
    expect(view.container.querySelector('[data-matrix-room]')).toBeNull()
    expect(command).not.toHaveBeenCalled()

    search('   ')
    expect(announcement.textContent).toBe('')
    expect(screen.queryByText('No results found')).toBeNull()
    expect(screen.getByRole('button', { name: 'New agent' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'App catalog' })).toBeTruthy()
  })

  it('counts account-wide results and does not show a chat-only empty state while they load', () => {
    const loaded = setup(readySnapshot(), 'poon', 'en', { count: 1, searching: false })
    expect(loaded.view.container.querySelector('[data-matrix-roster-results]')?.textContent).toBe('1 results')
    expect(screen.queryByText('No results found')).toBeNull()
    cleanup()

    setup(readySnapshot(), 'poon', 'en', { count: 0, searching: true })
    expect(screen.queryByText('No results found')).toBeNull()
  })

  it('keeps the account-wide pin limit while only matching conversations are visible', () => {
    const snapshot = readySnapshot()
    snapshot.rooms = [
      ...snapshot.rooms,
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `!pin-${index}:test`,
        name: `Pinned ${index}`,
        membership: 'join',
        encrypted: true,
        favourite: true
      }))
    ]
    const { command } = setup(snapshot, 'eve')
    rightClick(rowButton('!people:test'))
    const pin = screen.getByRole('menuitem', { name: 'Pin up to 5 chats' })

    expect(pin.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(pin)
    expect(command).not.toHaveBeenCalled()
  })

  it('gives every assistant a dot: live when it can answer, needs-you when the person can mend it, off otherwise', () => {
    const base = readySnapshot().agents![0]!
    const ready = { ...base, readiness: { phase: 'ready' as const, since: 1 } }

    // The catalog's readiness words, with the dot's own words made locale-independent.
    const shell = {
      ...en.matrixShell,
      agentSettingUp: 'setting up',
      agentDotReady: 'ready',
      agentDotNeedsYou: 'needs you',
      agentDotOffline: 'offline',
      agentDotUnreachable: "can't connect"
    }

    const listening = (state: 'listening' | 'paused' | 'stopped', extra = {}) => ({
      roomId: '!r',
      expiresAt: 1,
      queued: 0,
      state,
      ...extra
    })

    const blocked = (code: string) => ({ ...ready, readiness: { phase: 'blocked' as const, code, since: 1 } })

    const cases: [Parameters<typeof matrixAgentDot>[0], ReturnType<typeof matrixAgentDot>['dot'], string][] = [
      [ready, 'live', 'ready'],
      [{ ...ready, listening: listening('listening') }, 'live', matrixActionCopy.en.listening],
      // Up on another of your Macs, even while this one is starting: ready, with no word of where.
      [{ ...base, listening: listening('paused', { reason: 'lease_elsewhere' }) }, 'live', 'ready'],
      [{ ...ready, setup: 'failed' as const }, 'needs_you', 'needs you'],
      [{ ...ready, setup: 'action_required' as const }, 'off', 'setting up'],
      // Trouble the person can mend says what it is, not only that it needs them.
      [blocked('out_of_protons'), 'off', 'setting up'],
      [blocked('sign_in_required'), 'off', 'setting up'],
      [
        { ...ready, readiness: { phase: 'degraded' as const, code: 'setup_failed', since: 1 } },
        'needs_you',
        en.matrixShell.startupAssistantFailed
      ],
      [
        { ...ready, listening: listening('stopped', { result: 'publication_pending' }) },
        'off',
        matrixActionCopy.en.listeningStopped
      ],
      // A Stop this Mac could not save asks for the person...
      [
        { ...ready, listening: listening('paused', { reason: 'storage', mode: 'continuous' }) },
        'needs_you',
        matrixActionCopy.en.continuousListeningPaused
      ],
      [
        { ...ready, listening: listening('paused', { reason: 'document', mode: 'continuous' }) },
        'off',
        matrixActionCopy.en.continuousListeningPaused
      ],
      [
        { ...ready, listening: listening('paused', { reason: 'room_changed', mode: 'continuous' }) },
        'off',
        matrixActionCopy.en.continuousListeningPaused
      ],
      // ...one that recovers by itself (0.20) says so quietly...
      [
        { ...ready, listening: listening('paused', { reason: 'overflow', mode: 'continuous' }) },
        'off',
        matrixActionCopy.en.continuousListeningPaused
      ],
      // ...and the ones the app passes through on its own say nothing.
      [
        { ...ready, listening: listening('paused', { reason: 'renewing', mode: 'continuous' }) },
        'live',
        matrixActionCopy.en.continuousListening
      ],
      [
        { ...ready, listening: listening('paused', { reason: 'busy', mode: 'continuous' }) },
        'live',
        matrixActionCopy.en.continuousListening
      ],
      [{ ...base, listening: listening('paused', { reason: 'renewing', mode: 'continuous' }) }, 'off', 'setting up'],
      [{ ...ready, readiness: { phase: 'degraded' as const, code: 'offline', since: 1 } }, 'off', 'offline'],
      [{ ...ready, listening: listening('paused', { reason: 'offline' }) }, 'off', 'offline'],
      [blocked('chat_unreachable'), 'off', "can't connect"],
      [blocked('ai_unavailable'), 'off', "can't connect"],
      [{ ...ready, setup: 'working' as const }, 'off', 'setting up'],
      [{ ...ready, readiness: { phase: 'starting' as const, since: 1 } }, 'off', 'setting up'],
      [base, 'off', 'setting up']
    ]

    for (const [agent, dot, label] of cases) {
      expect(matrixAgentDot(agent, 'en', shell, 'opening')).toEqual({ dot, label })
    }
  })

  it('reads a cloud answerer’s dot from the destination that answers, not this Mac’s runtime', () => {
    const base = readySnapshot().agents![0]!

    const shell = {
      ...en.matrixShell,
      agentSettingUp: 'setting up',
      agentDotReady: 'ready',
      agentDotNeedsYou: 'needs you',
      agentDotOffline: 'offline',
      agentDotUnreachable: "can't connect"
    }

    const policy = parseExecutionPolicySnapshot(policyFixture)!
    const status = parseExecutionStatusSnapshot(statusFixture)!

    const policyView = (patch: Partial<MatrixExecutionPolicyView> = {}): MatrixExecutionPolicyView => ({
      policy,
      status,
      stale: false,
      ...patch
    })

    // The fixture answers on another Mac while the cloud is ready.
    const answeredElsewhere = policyView()
    const paused = policyView({ status: { ...status, state: 'paused' } })

    const allDown = policyView({
      status: {
        ...status,
        current: null,
        desired: null,
        destinations: {
          'mac:00000000-0000-4000-8000-b454f82c5857': { state: 'offline', reason: 'not_present', observedAt: 1 },
          cloud: { state: 'degraded', reason: 'server_down', observedAt: 1 },
          'mac:00000000-0000-4000-8000-f6222a1106ee': { state: 'disabled', reason: 'owner_disabled', observedAt: 1 }
        }
      }
    })

    const cloudOnly = { ...base, answering: 'cloud' as const }
    const localBlip = { readiness: { phase: 'degraded' as const, code: 'platform_unavailable', since: 1 } }

    // A cloud answerer stays green through this Mac's own runtime blips, including a standby
    // Mac whose local authority watch lost the platform for a moment.
    expect(matrixAgentDot({ ...cloudOnly, ...localBlip }, 'en', shell, 'opening')).toEqual({
      dot: 'live',
      label: 'ready'
    })
    expect(
      matrixAgentDot(
        {
          ...cloudOnly,
          macRole: 'standby',
          readiness: { phase: 'degraded', code: 'assistant_unreachable', since: 1 },
          executionPolicy: answeredElsewhere
        },
        'en',
        shell,
        'opening'
      )
    ).toEqual({ dot: 'live', label: 'ready' })

    // Grey only when the cloud's destination cannot answer anywhere, with the reason in words.
    expect(matrixAgentDot({ ...cloudOnly, ...localBlip, executionPolicy: paused }, 'en', shell, 'opening')).toEqual({
      dot: 'off',
      label: 'Paused'
    })
    expect(matrixAgentDot({ ...cloudOnly, ...localBlip, executionPolicy: allDown }, 'en', shell, 'opening')).toEqual({
      dot: 'off',
      label: "can't connect"
    })

    // The Mac that answers for a cloud agent is not exempt from its own runtime going down.
    expect(
      matrixAgentDot(
        { ...cloudOnly, macRole: 'answering', ...localBlip, executionPolicy: answeredElsewhere },
        'en',
        shell,
        'opening'
      )
    ).toEqual({ dot: 'off', label: "can't connect" })
  })

  it('keeps a cloud answerer green while the policy cache is stale, never reading unknown as down', () => {
    const base = readySnapshot().agents![0]!
    const shell = { ...en.matrixShell, agentDotReady: 'ready' }
    const policy = parseExecutionPolicySnapshot(policyFixture)!

    // `unknown` is no fact (a stale cache, or no status yet). The availability contract says it is
    // never "down", so the dot stays green; the title bar's muted loading icon owns that state.
    const views: MatrixExecutionPolicyView[] = [
      { policy, stale: true },
      { policy, stale: false }
    ]

    for (const executionPolicy of views) {
      expect(matrixAgentDot({ ...base, answering: 'cloud', executionPolicy }, 'en', shell, 'opening')).toEqual({
        dot: 'live',
        label: 'ready'
      })
    }
  })

  it('keeps a cloud answerer’s dot and its auto-picked main in agreement across projections', () => {
    const base = readySnapshot().agents![0]!
    const agent = { ...base, answering: 'cloud' as const, macRole: 'standby' as const }
    const rooms = readySnapshot().rooms.filter(
      room => room.roomType === MATRIX_ASSISTANT_ROOM_TYPE && room.participants?.some(m => m.userId === agent.userId)
    )
    const pickNow = 10

    // The automatic pick ranks the owner's last conversation; every Mac computes the same
    // `proposed`, so two consecutive projections of the same rooms pick the same room.
    const candidates = rooms.map(room => ({
      roomId: room.id,
      activityAt: room.lastActiveAt,
      createdAt: room.lastActiveAt
    }))
    const firstPick = rankConversationCandidates(candidates, pickNow)[0]
    const secondPick = rankConversationCandidates([...candidates].reverse(), pickNow)[0]
    expect(firstPick).toBe('!atum-new:test')
    expect(secondPick).toBe(firstPick)

    // The projection after the pick: the picked room is main and the other is Earlier, already
    // converged. Reading it twice is not a new migration.
    const marked: ConversationRoomProjection[] = rooms.map(room => ({
      ...room,
      conversationOwnerId: owner,
      conversation:
        room.id === firstPick
          ? { role: 'main', main: firstPick!, at: pickNow }
          : { role: 'earlier', main: firstPick!, at: pickNow }
    }))
    const projections = [
      resolveProjectedConversation(marked, owner, agent.userId),
      resolveProjectedConversation(
        marked.map(room => ({ ...room, conversation: room.conversation && { ...room.conversation } })),
        owner,
        agent.userId
      )
    ]

    const shell = {
      ...en.matrixShell,
      agentSettingUp: 'setting up',
      agentDotReady: 'ready',
      agentDotNeedsYou: 'needs you',
      agentDotOffline: 'offline',
      agentDotUnreachable: "can't connect"
    }
    const policy = parseExecutionPolicySnapshot(policyFixture)!
    const status = parseExecutionStatusSnapshot(statusFixture)!
    const policyView = (patch: Partial<MatrixExecutionPolicyView> = {}): MatrixExecutionPolicyView => ({
      policy,
      status,
      stale: false,
      ...patch
    })
    const reachable = policyView()
    const paused = policyView({ status: { ...status, state: 'paused' } })
    const allDown = policyView({
      status: {
        ...status,
        current: null,
        desired: null,
        destinations: {
          'mac:00000000-0000-4000-8000-b454f82c5857': { state: 'offline', reason: 'not_present', observedAt: 1 },
          cloud: { state: 'degraded', reason: 'server_down', observedAt: 1 },
          'mac:00000000-0000-4000-8000-f6222a1106ee': { state: 'disabled', reason: 'owner_disabled', observedAt: 1 }
        }
      }
    })

    for (const projection of projections) {
      // One main, the same room, twice: the row opens the conversation the pick wrote.
      expect(projection.source).toBe('marked')
      expect(projection.main).toBe(firstPick)
      expect(projection.earlier).toEqual(['!atum-old:test'])
      expect(matrixAgentConversationRoom(rooms, projection.main)?.id).toBe(firstPick)

      // Every non-main room already says Earlier under that main, so the sweep has nothing to
      // write: the second projection cannot start another migration.
      expect(
        projection.earlier.filter(roomId => {
          const marker = marked.find(room => room.id === roomId)?.conversation
          return marker?.role !== 'earlier' || marker.main !== projection.main
        })
      ).toEqual([])

      // The dot's answerer fact follows the destination that answers, never this Mac: live
      // while any enabled destination is reachable, off only when none can take the turn.
      expect(matrixAgentDot({ ...agent, executionPolicy: reachable }, 'en', shell, 'opening')).toEqual({
        dot: 'live',
        label: 'ready'
      })
      expect(matrixAgentDot({ ...agent, executionPolicy: paused }, 'en', shell, 'opening')).toEqual({
        dot: 'off',
        label: 'Paused'
      })
      expect(matrixAgentDot({ ...agent, executionPolicy: allDown }, 'en', shell, 'opening')).toEqual({
        dot: 'off',
        label: "can't connect"
      })
    }
  })

  it("says each assistant's dot in its row's description, in the person's language", () => {
    const snapshot = readySnapshot()
    snapshot.agents![0]!.readiness = { phase: 'ready', since: 1 }
    snapshot.agents![1]!.readiness = { phase: 'degraded', code: 'out_of_protons', since: 1 }
    const { view } = setup(snapshot, '', 'vi')

    expect(screen.getByRole('button', { name: 'Atum', description: /^Sẵn sàng\./ })).toBeTruthy()
    // A shared cause stays quiet; the indicator owns its one action.
    expect(
      screen.getByRole('button', {
        name: 'Moon',
        description: viCopy.matrixShell.agentUnavailable
      })
    ).toBeTruthy()
    expect(
      [...view.container.querySelectorAll('[data-matrix-agent] [data-agent-dot]')].map(dot =>
        dot.getAttribute('data-agent-dot')
      )
    ).toEqual(['off'])
    // People never get one: their presence is not read into the window.
    expect(roomRow('!people:test').querySelector('[data-agent-dot]')).toBeNull()
  })

  it("says a starting assistant's words once, with its hollow dot", () => {
    const snapshot = readySnapshot()
    snapshot.agents![0]!.readiness = { phase: 'ready', since: 1 }
    snapshot.agents![1]!.readiness = { phase: 'starting', step: 'hermes', since: 1 }
    const { view } = setup(snapshot, '', 'vi')

    // The row's line and the dot both mean "setting up": a screen reader hears it once.
    expect(screen.getByRole('button', { name: 'Moon', description: viCopy.matrixShell.agentSettingUp })).toBeTruthy()
    expect(
      view.container.querySelector('[data-matrix-agent="moon"] [data-agent-dot]')?.getAttribute('data-agent-dot')
    ).toBe('off')
  })

  it('reports availability only from the listener state, not a locally-ready agent', () => {
    const ready = readySnapshot().agents![0]!

    expect(matrixListenerStatus(ready, 'en')).toBeNull()
    expect(
      matrixListenerStatus({ ...ready, listening: { roomId: '!r', expiresAt: 1, queued: 0, state: 'listening' } }, 'en')
    ).toMatchObject({ tone: 'good' })
    expect(
      matrixListenerStatus(
        { ...ready, listening: { roomId: '!r', expiresAt: 1, queued: 0, state: 'paused', reason: 'lease_elsewhere' } },
        'en'
      )
    ).toBeNull()
    expect(matrixListenerStatus({ ...ready, setup: 'failed' }, 'en')).toMatchObject({ tone: 'warn' })
    // An answer still being published clears by itself: a quiet ring, not amber.
    expect(
      matrixListenerStatus(
        {
          ...ready,
          listening: { roomId: '!r', expiresAt: 1, queued: 0, state: 'stopped', result: 'publication_pending' }
        },
        'en'
      )
    ).toMatchObject({ tone: 'muted' })
    // An unknown outcome recovers by itself too (0.20): quiet, never amber.
    expect(
      matrixListenerStatus(
        { ...ready, listening: { roomId: '!r', expiresAt: 1, queued: 0, state: 'stopped', result: 'unknown' } },
        'en'
      )
    ).toMatchObject({ tone: 'muted' })
    // Only a Stop this Mac could not save asks for the person.
    expect(
      matrixListenerStatus(
        {
          ...ready,
          listening: { roomId: '!r', expiresAt: 1, queued: 0, state: 'paused', mode: 'continuous', reason: 'storage' }
        },
        'en'
      )
    ).toMatchObject({ tone: 'warn' })
  })

  it('rings every row quietly for a cause they share, and ambers only the assistant that needs the person', () => {
    const ready = readySnapshot().agents![0]!
    const since = Date.now() - 60_000

    for (const code of ['recovery_required', 'out_of_protons', 'sign_in_required', 'device_replaced']) {
      expect(
        matrixListenerStatus({ ...ready, readiness: { phase: 'blocked', step: 'assistant', code, since } }, 'en')
      ).toMatchObject({ tone: 'muted' })
    }

    expect(
      matrixListenerStatus(
        { ...ready, readiness: { phase: 'blocked', step: 'assistant', code: 'agent_reconnect_required', since } },
        'en'
      )
    ).toMatchObject({ tone: 'warn' })
    // A trust step that just failed is still the launch's own business.
    expect(
      matrixListenerStatus(
        { ...ready, readiness: { phase: 'blocked', step: 'assistant', code: 'agent_trust_failed', since: Date.now() } },
        'en'
      )
    ).toMatchObject({ tone: 'muted' })
  })

  it("keeps an assistant's face on a history listed on its own, titled by what it is about", () => {
    // Before Atum is set up on this Mac, its histories are listed with everything else.
    const snapshot = { ...readySnapshot(), assistant: undefined, agents: [] }
    snapshot.rooms = [
      privateRoom('!first:test', '@atum:test', { assistant: true, name: 'Atum', firstLine: 'Plan a trip' })
    ]
    const { view } = setup(snapshot)

    const row = view.container.querySelector<HTMLElement>('[data-matrix-room="!first:test"]')!
    expect(within(row).getByRole('button', { name: 'Plan a trip' })).toBeTruthy()
    expect(row.querySelector('[data-roster-row] > [aria-hidden]')?.textContent).toBe('A')
  })

  it('previews each chat’s latest message as Element does: you, a person in a group, a file, a deletion', () => {
    const snapshot = readySnapshot()
    // A ready assistant: its row's second line is its latest message, not how it is doing.
    snapshot.agents![1]!.readiness = { phase: 'ready', since: 1 }
    snapshot.rooms = [
      ...snapshot.rooms.map(room =>
        room.id === '!moon:test'
          ? {
              ...room,
              assistant: true,
              preview: { own: false, sender: 'Moon', kind: 'text' as const, text: 'Revenue is up 12%.', at: 2 }
            }
          : room
      ),
      {
        id: '!linh:test',
        name: 'Linh',
        membership: 'join',
        encrypted: true,
        direct: true,
        lastActiveAt: 4,
        preview: { own: true, kind: 'text', text: 'Booked for 7pm', at: 4 }
      },
      {
        id: '!team:test',
        name: 'Team',
        membership: 'join',
        encrypted: true,
        lastActiveAt: 3,
        preview: { own: false, sender: 'Quân', kind: 'file', text: 'menu.pdf', at: 3 }
      },
      {
        id: '!hoa:test',
        name: 'Hoa',
        membership: 'join',
        encrypted: true,
        direct: true,
        lastActiveAt: 2,
        preview: { own: false, sender: 'Hoa', kind: 'deleted', at: 2 }
      }
    ]
    setup(snapshot)

    expect(screen.getByRole('button', { name: 'Linh', description: 'You: Booked for 7pm' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Team', description: 'Quân: 📎 menu.pdf' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hoa', description: 'Message deleted' })).toBeTruthy()
    // An assistant's answer needs no name before it: the row is the assistant's.
    // Its dot's words come first.
    expect(screen.getByRole('button', { name: 'Moon', description: 'Ready. Revenue is up 12%.' })).toBeTruthy()
  })

  it('badges a mention strongly, a count plainly, a mark and a muted chat’s news with dots, and bolds them all', () => {
    const snapshot = readySnapshot()

    const chat = (id: string, extra: Partial<MatrixRoom>): MatrixRoom => ({
      id,
      name: id.slice(1, -5),
      membership: 'join',
      encrypted: true,
      lastActiveAt: 1,
      ...extra
    })

    snapshot.rooms = [
      chat('!mention:test', { unreadNotifications: 3, highlights: 1 }),
      chat('!count:test', { direct: true, unreadNotifications: 120 }),
      chat('!marked:test', { direct: true, markedUnread: true }),
      chat('!quiet:test', { muted: true, unread: true, unreadNotifications: 4 }),
      chat('!read:test', { direct: true })
    ]
    setup(snapshot)
    const badge = (id: string) => roomRow(id).querySelector('[data-roster-unread]')?.getAttribute('data-roster-unread')

    expect(badge('!mention:test')).toBe('mention')
    expect(within(roomRow('!mention:test')).getByLabelText('Mentions you: 3')).toBeTruthy()
    expect(badge('!count:test')).toBe('count')
    expect(within(roomRow('!count:test')).getByText('99+')).toBeTruthy()
    expect(badge('!marked:test')).toBe('marked')
    // Muted: no count, a quiet dot and the bell that says why.
    expect(badge('!quiet:test')).toBe('activity')
    expect(within(roomRow('!quiet:test')).getByText('Notifications off')).toBeTruthy()
    expect(within(roomRow('!quiet:test')).queryByText('4')).toBeNull()
    expect(badge('!read:test')).toBeUndefined()

    for (const id of ['!mention:test', '!count:test', '!marked:test', '!quiet:test']) {
      expect(within(roomRow(id)).getByText(id.slice(1, -5)).className).toContain('font-semibold')
    }

    expect(within(roomRow('!read:test')).getByText('read').className).not.toContain('font-semibold')
  })

  it('renames, mutes and leaves a chat from its context menu, leaving only after a confirmation', async () => {
    const snapshot = readySnapshot()
    const { command } = setup(snapshot)
    const row = () => rowButton('!people:test')

    rightClick(row())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const field = await screen.findByRole('textbox', { name: 'Name' })
    expect((field as HTMLInputElement).value).toBe('@eve:matrix.test')
    expect(screen.getByText('Only you see this name.')).toBeTruthy()
    fireEvent.change(field, { target: { value: '  Eve from work  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ kind: 'chatTitle', roomId: '!people:test', title: 'Eve from work' })
    )
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull())

    rightClick(row())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mute notifications' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'mute', roomId: '!people:test', muted: true }))

    rightClick(row())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Leave group' }))
    expect(command).not.toHaveBeenCalledWith({ kind: 'forget', roomId: '!people:test' })
    expect(screen.getByRole('dialog', { name: 'Leave this chat?' })).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Leave group' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'forget', roomId: '!people:test' }))
  })

  it('offers Delete chat for a person and Leave group for a group', async () => {
    const snapshot = readySnapshot()
    snapshot.rooms = [
      ...snapshot.rooms.filter(room => room.id !== '!people:test'),
      { id: '!eve:test', name: 'Eve', membership: 'join', encrypted: true, direct: true, lastActiveAt: 3 },
      { id: '!team:test', name: 'Team', membership: 'join', encrypted: true, lastActiveAt: 4 }
    ]
    const { command } = setup(snapshot)

    rightClick(rowButton('!eve:test'))
    expect(screen.queryByRole('menuitem', { name: 'Leave group' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete chat' }))
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Delete this chat?' })).getByRole('button', { name: 'Delete' })
    )
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'forget', roomId: '!eve:test' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    rightClick(rowButton('!team:test'))
    expect(screen.queryByRole('menuitem', { name: 'Delete chat' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Leave group' }))
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Leave this chat?' })).getByRole('button', { name: 'Leave group' })
    )
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'forget', roomId: '!team:test' }))
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'leave' }))
  })

  it('marks a chat unread from its context menu, reads it as unread everywhere, and marks it read again', async () => {
    const snapshot = readySnapshot()
    snapshot.rooms = [
      ...snapshot.rooms,
      { id: '!eve:test', name: 'Eve', membership: 'join', encrypted: true, direct: true, lastActiveAt: 3 }
    ]
    const { command, search } = setup(snapshot)
    const row = () => roomRow('!eve:test')

    rightClick(rowButton('!eve:test'))
    expect(screen.queryByRole('menuitem', { name: 'Mark as read' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark as unread' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'markUnread', roomId: '!eve:test', unread: true }))

    // Sync brings the mark back: the row reads as unread, with a dot where a count would be.
    const marked = {
      ...snapshot,
      rooms: snapshot.rooms.map(room => (room.id === '!eve:test' ? { ...room, markedUnread: true } : room))
    }

    search('', marked)
    expect(within(row()).getByText('Marked as unread')).toBeTruthy()
    expect(within(row()).getByText('Eve').className).toContain('font-semibold')

    rightClick(rowButton('!eve:test'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark as read' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ kind: 'markUnread', roomId: '!eve:test', unread: false })
    )
  })

  it("counts an assistant chat marked unread on the assistant's row, and opens that chat from it", () => {
    const snapshot = readySnapshot()
    snapshot.rooms = snapshot.rooms.map(room => (room.id === '!moon:test' ? { ...room, markedUnread: true } : room))
    const { command } = setup(snapshot)
    const moon = screen.getByRole('button', { name: 'Moon' })

    expect(moon.getAttribute('aria-describedby')).toContain('matrix-agent-unread-moon')
    expect(within(moon).getByText('Marked as unread')).toBeTruthy()
    fireEvent.click(moon)
    expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: '!moon:test' })
  })

  it("drops a deleted history from its assistant's list, its count and where the row opens", () => {
    const snapshot = readySnapshot()
    snapshot.rooms = snapshot.rooms.map(room =>
      room.id === '!atum-new:test' ? { ...room, unreadNotifications: 3 } : room
    )
    const { search, openAssistant } = setup(snapshot)
    expect(screen.getByRole('button', { name: 'Atum', description: /3/ })).toBeTruthy()

    // Deleted (left and forgotten): sync no longer lists the room at all.
    const deleted = { ...snapshot, rooms: snapshot.rooms.filter(room => room.id !== '!atum-new:test') }
    search('', deleted)
    expect(window.document.querySelector('[data-matrix-room="!atum-new:test"]')).toBeNull()
    expect(screen.queryByLabelText(/Unread notifications/)).toBeNull()
    // One history left: the row is that chat, with nothing to open under it.
    expect(screen.getByRole('button', { name: 'Atum' }).hasAttribute('aria-expanded')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Atum' }))
    expect(openAssistant).toHaveBeenCalledExactlyOnceWith(false, '!atum-old:test')
  })

  it('never offers Mark as unread on the chat you are reading', () => {
    const snapshot = readySnapshot()
    snapshot.rooms = [
      ...snapshot.rooms,
      { id: '!eve:test', name: 'Eve', membership: 'join', encrypted: true, direct: true, lastActiveAt: 3 }
    ]
    snapshot.roomId = '!eve:test'
    setup(snapshot)
    rightClick(rowButton('!eve:test'))
    expect(screen.queryByRole('menuitem', { name: 'Mark as unread' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Mark as read' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Delete chat' })).toBeTruthy()
  })

  it('starts a chat with a named assistant that has none yet, rather than a row that does nothing', () => {
    const snapshot = readySnapshot()
    snapshot.rooms = snapshot.rooms.filter(room => room.agentPrincipal !== 'moon')
    const { command, openAgentChat } = setup(snapshot)

    const moon = screen.getByRole('button', { name: 'Moon' }) as HTMLButtonElement
    expect(moon.disabled).toBe(false)
    fireEvent.click(moon)
    expect(openAgentChat).toHaveBeenCalledExactlyOnceWith(snapshot.agents![1])
    expect(command).not.toHaveBeenCalled()
  })

  it('offers Try again on an assistant that is not ready, with its reason, and sets the default up again', async () => {
    const snapshot = readySnapshot()
    snapshot.agents![1] = {
      ...snapshot.agents![1]!,
      readiness: { phase: 'blocked', step: 'ai', code: 'ai_unavailable', since: 1 }
    }
    snapshot.agents![0] = { ...snapshot.agents![0]!, setup: 'failed' }
    const retryReadiness = vi.fn(async () => {})
    const setupAssistant = vi.fn(async () => {})
    const { view } = setup(snapshot)
    Object.assign(window.atumMatrix, { retryReadiness, setupAssistant })

    const moon = view.container.querySelector<HTMLElement>('[data-matrix-agent="moon"]')!
    fireEvent.click(within(moon).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(retryReadiness).toHaveBeenCalledOnce())

    const atum = view.container.querySelector<HTMLElement>('[data-matrix-agent="default"]')!
    fireEvent.click(within(atum).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(setupAssistant).toHaveBeenCalledOnce())
  })

  it.each([
    ['blocked', 'agent_trust_failed'],
    ['degraded', 'ai_unavailable']
  ] as const)('keeps a %s primary visible on its own row with retry', async (phase, code) => {
    const snapshot = readySnapshot()
    snapshot.agents![0] = {
      ...snapshot.agents![0]!,
      readiness: { phase, step: phase === 'blocked' ? 'assistant' : 'ai', code, since: 1 }
    }
    const retryReadiness = vi.fn(async () => {})
    const { view } = setup(snapshot)
    Object.assign(window.atumMatrix, { retryReadiness })

    const atum = view.container.querySelector<HTMLElement>('[data-matrix-agent="default"]')!
    expect(within(atum).getByText('Unavailable')).toBeTruthy()
    fireEvent.click(within(atum).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(retryReadiness).toHaveBeenCalledOnce())
  })

  it('says an assistant waits for this Mac to unlock, never “unavailable”, and offers Reconnect when it needs one', async () => {
    const snapshot = readySnapshot()
    snapshot.agents![0] = {
      ...snapshot.agents![0]!,
      readiness: { phase: 'blocked', step: 'assistant', code: 'recovery_required', since: 1 }
    }
    snapshot.agents![1] = {
      ...snapshot.agents![1]!,
      readiness: { phase: 'blocked', step: 'assistant', code: 'agent_reconnect_required', since: 1 }
    }
    const reconnectAgent = vi.fn(async () => {})
    const retryReadiness = vi.fn(async () => {})
    const { view } = setup(snapshot, '', 'vi')
    Object.assign(window.atumMatrix, { reconnectAgent, retryReadiness })

    const atum = view.container.querySelector<HTMLElement>('[data-matrix-agent="default"]')!
    expect(within(atum).getByText('Chờ mở khóa Mac này')).toBeTruthy()
    expect(within(atum).queryByText('Chưa sẵn sàng')).toBeNull()

    const moon = view.container.querySelector<HTMLElement>('[data-matrix-agent="moon"]')!
    expect(within(moon).getByText('Cần kết nối lại')).toBeTruthy()
    fireEvent.click(within(moon).getByRole('button', { name: 'Kết nối lại' }))
    await waitFor(() => expect(reconnectAgent).toHaveBeenCalledWith('moon'))
    expect(retryReadiness).not.toHaveBeenCalled()
  })

  it('hides Mac reconnect copy and action for a cloud assistant with a stale standby role', () => {
    const snapshot = readySnapshot()
    snapshot.agents![1] = {
      ...snapshot.agents![1]!,
      ready: false,
      answering: 'cloud',
      macRole: 'standby',
      readiness: { phase: 'blocked', step: 'assistant', code: 'agent_reconnect_required', since: 1 }
    }
    const { view } = setup(snapshot, '', 'vi')
    const moon = view.container.querySelector<HTMLElement>('[data-matrix-agent="moon"]')!

    expect(within(moon).queryByText('Cần kết nối lại')).toBeNull()
    expect(within(moon).queryByRole('button', { name: 'Kết nối lại' })).toBeNull()
    expect(moon.querySelector('[data-roster-preview]')).toBeNull()
  })

  it("shows Atum's atom on an assistant's row while it is at work", () => {
    const snapshot = readySnapshot()
    snapshot.agents = snapshot.agents!.map(agent =>
      agent.principal === 'moon' ? { ...agent, hermes: 'running' } : agent
    )
    snapshot.hermesActivity = {
      roomId: '!atum-old:test',
      invocationId: 'turn',
      state: 'running',
      text: 'Checking guesthouses…',
      tools: []
    }
    snapshot.agentTurns = [
      {
        roomId: '!people:test',
        activity: { roomId: '!people:test', invocationId: 'group', state: 'running', text: '', tools: [] }
      }
    ]
    snapshot.rooms = snapshot.rooms.map(room => (room.id === '!people:test' ? { ...room, lastActiveAt: 3 } : room))
    const { view } = setup(snapshot)
    const row = (principal: string) => view.container.querySelector<HTMLElement>(`[data-matrix-agent="${principal}"]`)!

    // Each assistant is its row: the row says it is at work, whichever of its chats it works in.
    const moon = within(row('moon')).getByRole('button', { name: 'Moon' })
    expect(moon.getAttribute('aria-describedby')).toContain('matrix-agent-working-moon')
    expect(window.document.getElementById('matrix-agent-working-moon')?.textContent).toBe('Moon is working')
    expect(row('default').querySelectorAll('[data-roster-working]')).toHaveLength(1)
    expect(within(row('default')).getByText('Checking guesthouses…')).toBeTruthy()
    fireEvent.click(within(row('default')).getByRole('button', { name: 'Atum' }))
    expect(row('default').querySelector('[data-matrix-room]')).toBeNull()

    // A chat with people where an assistant answers says so in place of its time.
    const people = view.container.querySelector<HTMLElement>('[data-matrix-room="!people:test"]')!
    expect(within(people).getByText('Your assistant is working')).toBeTruthy()
    expect(people.querySelector('[data-roster-time]')).toBeNull()
  })

  it('shows no time on a row (Atum Kit: name, one line and a badge)', () => {
    const snapshot = readySnapshot()
    snapshot.rooms = [{ ...snapshot.rooms[3]!, lastActiveAt: Date.now() - 30_000 }]
    render(
      <I18nProvider configClient={null} initialLocale="vi">
        <MatrixRosterConversations
          assistantOpening={false}
          fail={vi.fn()}
          onOpen={vi.fn()}
          openAgentChat={vi.fn()}
          openAssistant={vi.fn()}
          snapshot={snapshot}
        />
      </I18nProvider>
    )

    expect(window.document.querySelector('[data-roster-time]')).toBeNull()
  })
})

describe('the Founder row', () => {
  const founderId = '@user-0f1e2d3c4b5a69788796a5b4c3d2e1f0:test'

  const founderChat: MatrixRoom = {
    id: '!founder:test',
    name: 'Founder',
    membership: 'join',
    encrypted: true,
    direct: true,
    lastActiveAt: 1,
    participants: [
      { userId: owner, membership: 'join' },
      { userId: founderId, membership: 'invite' }
    ]
  }

  const person = (id: string, name: string, userId: string, lastActiveAt: number): MatrixRoom => ({
    id,
    name,
    membership: 'join',
    encrypted: true,
    direct: true,
    lastActiveAt,
    participants: [
      { userId: owner, membership: 'join' },
      { userId, membership: 'join' }
    ]
  })

  /** Atum as the only assistant, the Founder chat, and people more recent than it. */
  function founderSnapshot(extra: Partial<MatrixSnapshot> = {}): MatrixSnapshot {
    const base = readySnapshot()

    return {
      ...base,
      agents: base.agents!.filter(agent => agent.isDefault),
      rooms: [
        privateRoom('!atum-new:test', '@atum:test', { name: 'Atum newest', lastActiveAt: 5 }),
        person('!lan:test', 'Lan', '@lan:test', 90),
        person('!partner:test', 'River team', '@river:test', 80),
        founderChat
      ],
      founder: { userId: founderId, verification: 'official', roomId: '!founder:test', handle: 'founder' },
      officialAccounts: [
        { userId: founderId, tier: 'official', role: 'founder', handle: 'founder' },
        { userId: '@river:test', tier: 'verified' }
      ],
      ...extra
    }
  }

  const rowOrder = () =>
    [...window.document.querySelectorAll('h2, [data-matrix-room], [data-matrix-agent]')].map(
      node => node.getAttribute('data-matrix-room') ?? node.getAttribute('data-matrix-agent') ?? node.textContent
    )

  it('is pinned first under Chats, below Atum, with the raven, the filled mark and who they are', () => {
    setup(founderSnapshot())

    expect(rowOrder()).toEqual(['Assistants', 'default', 'Chats', '!founder:test', '!lan:test', '!partner:test'])
    const row = roomRow('!founder:test')
    expect(row.hasAttribute('data-matrix-founder-row')).toBe(true)
    expect(row.querySelector('[data-founder-avatar]')).toBeTruthy()
    expect(within(row).getByRole('img', { name: 'Official Atum account' }).getAttribute('data-verified-mark')).toBe(
      'official'
    )
    expect(rowButton('!founder:test').getAttribute('aria-label')).toBe('Founder')
    // Empty, it says who they are; once written in, its latest message.
    expect(row.querySelector('[data-roster-preview]')?.textContent).toBe('Atum founder')
    // That line is no one's message, so no time sits beside it (the chat was made, not written in).
    expect(row.querySelector('[data-roster-time]')).toBeNull()
  })

  it('shows its latest message once there is one, and is never reordered by activity', () => {
    setup(
      founderSnapshot({
        rooms: [
          person('!lan:test', 'Lan', '@lan:test', 90),
          { ...founderChat, lastActiveAt: 10, preview: { own: true, kind: 'text', text: 'Hello Founder', at: 10 } }
        ]
      })
    )

    expect(roomRow('!founder:test').querySelector('[data-roster-preview]')?.textContent).toContain('Hello Founder')
    expect(rowOrder().indexOf('!founder:test')).toBeLessThan(rowOrder().indexOf('!lan:test'))
  })

  it("marks a direct chat by its person's tier, and nobody by a name", () => {
    setup(
      founderSnapshot({
        rooms: [
          person('!partner:test', 'River team', '@river:test', 80),
          person('!impostor:test', 'Founder', '@founder:elsewhere.test', 70),
          founderChat
        ]
      })
    )

    expect(roomRow('!partner:test').querySelector('[data-verified-mark]')?.getAttribute('data-verified-mark')).toBe(
      'verified'
    )
    // A look-alike: no mark and no slot.
    expect(roomRow('!impostor:test').querySelector('[data-verified-mark]')).toBeNull()
    expect(roomRow('!impostor:test').hasAttribute('data-matrix-founder-row')).toBe(false)
  })

  it('is hidden on the founder account, and when either of them left', () => {
    const own = setup(founderSnapshot({ identity: { userId: founderId, deviceId: 'FOUNDER' } }))
    expect(window.document.querySelector('[data-matrix-founder-row]')).toBeNull()
    own.view.unmount()

    const left = setup(founderSnapshot({ rooms: [{ ...founderChat, membership: 'leave' }] }))
    expect(window.document.querySelector('[data-matrix-founder-row]')).toBeNull()
    left.view.unmount()

    setup(
      founderSnapshot({
        rooms: [
          { ...founderChat, participants: [founderChat.participants![0]!, { userId: founderId, membership: 'leave' }] }
        ]
      })
    )
    expect(window.document.querySelector('[data-matrix-founder-row]')).toBeNull()
  })

  it('offers a local draft while no chat exists, and opening it asks for nothing', () => {
    const draft = founderSnapshot({
      rooms: [person('!lan:test', 'Lan', '@lan:test', 90)],
      founder: { userId: founderId, verification: 'official', handle: 'founder', offer: true }
    })
    const roster = setup(draft)

    const row = window.document.querySelector<HTMLElement>('[data-matrix-founder-draft="true"]')!

    expect(row).toBeTruthy()
    expect(row.querySelector('[data-founder-avatar]')).toBeTruthy()
    expect(within(row).getByRole('button').getAttribute('aria-label')).toBe('Founder')
    expect(window.document.querySelector('[data-matrix-founder-row]')).toBeNull()

    fireEvent.click(within(row).getByRole('button'))
    expect(roster.onOpen).toHaveBeenCalled()
    expect(roster.command).not.toHaveBeenCalled()
    expect($founderDraftOpen.get()).toBe(true)

    // A chat that exists is the Founder row, never a draft.
    roster.view.unmount()
    setup(founderSnapshot())
    expect(window.document.querySelector('[data-matrix-founder-draft="true"]')).toBeNull()
    expect(window.document.querySelector('[data-matrix-founder-row]')).toBeTruthy()
  })

  it('is found by search, opens its chat, and offers View profile first in its menu', async () => {
    const roster = setup(founderSnapshot())

    roster.search('nha sang', founderSnapshot())
    expect(window.document.querySelector('[data-matrix-founder-row]')).toBeNull()
    roster.search('atum founder', founderSnapshot())
    expect(window.document.querySelector('[data-matrix-founder-row]')).toBeTruthy()
    roster.search('', founderSnapshot())

    fireEvent.click(rowButton('!founder:test'))
    expect(roster.onOpen).toHaveBeenCalled()
    expect(roster.command).toHaveBeenCalledWith({ kind: 'select', roomId: '!founder:test' })

    const menu = rightClick(rowButton('!founder:test'))
    const items = within(menu).getAllByRole('menuitem')
    expect(items[0]?.textContent).toContain('View profile')
    fireEvent.click(items[0]!)

    const sheet = await screen.findByRole('dialog', { name: /Founder/ })
    expect(within(sheet).getByText('Atum founder')).toBeTruthy()
    expect(within(sheet).getByText('@founder')).toBeTruthy()
  })
})

describe('an official bot in the roster', () => {
  const moonBot = '@app-moon:test'
  const NATIVE_AVATAR = 'data:image/png;base64,iVBORw0KGgo='

  const moonApp: AppDescriptor = {
    app: 'moon',
    app_id: '00000000-0000-4000-8000-e79acd97ac88',
    app_version_id: '00000000-0000-4000-8000-5ba39b7cfa53',
    name: { en: 'Moon', vi: 'Moon' },
    subtitle: null,
    description: null,
    icon: null,
    accent: null,
    affiliation: 'first_party',
    verified: true,
    availability: 'available',
    roster_default: true,
    roster_order: 1,
    supported_modes: [],
    matrix_room_context: 'addressed_only',
    has_surface: true,
    link: { mode: 'external_account', state: 'linked' },
    bot: {
      v: 1,
      user_id: moonBot,
      handle: 'moon_bot',
      display_name: 'Moon',
      avatar: { url: '', sha256: '0'.repeat(64) },
      device_generation: 1,
      device: { device_id: 'MOON_1', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
      state: 'active',
      groups: true,
      consent: 'accepted',
      disclosure_version: 1,
      open_route_id: 'chat',
      open_shared_memory: true,
      purchase_route_id: 'chat'
    }
  }

  function moonChat(
    extra: Partial<MatrixRoom> = {},
    appBot: Partial<NonNullable<MatrixRoom['appBot']>> = {}
  ): MatrixRoom {
    return {
      id: '!moon-chat:test',
      name: 'Moon',
      membership: 'join',
      encrypted: true,
      direct: true,
      participants: [
        { userId: owner, membership: 'join' },
        { userId: moonBot, membership: 'join' }
      ],
      preview: { own: false, kind: 'text', text: 'Your reading is ready', at: 100 },
      lastActiveAt: 100,
      unreadNotifications: 2,
      appBot: { appId: moonApp.app_id, botUserId: moonBot, current: true, ...appBot },
      ...extra
    }
  }

  function moonSnapshot(chat: MatrixRoom | null = moonChat(), extra: Partial<MatrixSnapshot> = {}): MatrixSnapshot {
    const base = readySnapshot()

    return {
      ...base,
      // Only the primary assistant: no assistant of the owner's own is also called Moon here.
      agents: base.agents!.slice(0, 1),
      rooms: [...base.rooms.filter(room => room.id !== '!moon:test'), ...(chat ? [chat] : [])],
      apps: { state: 'ready', apps: [moonApp], connections: {} },
      appShortcuts: { [moonApp.app_id]: { visibility: 'default', status: 'ready' } },
      ...extra
    }
  }

  /** The snapshot fields that carry a changed Moon descriptor. */
  function moonSnapshotWith(change: Partial<AppDescriptor>): Partial<MatrixSnapshot> {
    return { apps: { state: 'ready', apps: [{ ...moonApp, ...change }], connections: {} } }
  }

  function renderRoster(
    snapshot: MatrixSnapshot,
    options: {
      query?: string
      locale?: 'en' | 'vi'
      opening?: string
      profiles?: Pick<NonNullable<MatrixUiBridge['profiles']>, 'member'>
    } = {}
  ) {
    const command = vi.fn<MatrixUiBridge['command']>().mockResolvedValue(null)
    const onOpenApp = vi.fn()
    window.atumMatrix = {
      command,
      ...(options.profiles ? { profiles: options.profiles } : {})
    } as unknown as MatrixUiBridge

    const view = render(
      <I18nProvider configClient={null} initialLocale={options.locale ?? 'en'}>
        <MatrixRosterConversations
          assistantOpening={false}
          fail={vi.fn()}
          onOpen={vi.fn()}
          onOpenApp={onOpenApp}
          openAgentChat={vi.fn()}
          openAssistant={vi.fn()}
          openingApp={options.opening ?? null}
          query={options.query}
          snapshot={snapshot}
        />
      </I18nProvider>
    )

    return { command, onOpenApp, view }
  }

  const moonRow = () => window.document.querySelector<HTMLElement>(`[data-matrix-app-bot="${moonApp.app_id}"]`)

  it('is one row carrying its chat’s latest message and unread count, never a second chat row', () => {
    const { command, onOpenApp } = renderRoster(moonSnapshot())

    expect(screen.getAllByRole('button', { name: 'Moon' })).toHaveLength(1)
    expect(moonRow()?.textContent).toContain('Your reading is ready')
    expect(moonRow()?.querySelector('[data-roster-unread]')?.textContent).toContain('2')
    expect(window.document.querySelector('[data-matrix-room="!moon-chat:test"]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Moon' }))
    expect(onOpenApp).toHaveBeenCalledWith(moonApp)
    expect(command).not.toHaveBeenCalled()
  })

  it('lights only its own row while its chat is open', () => {
    const { view } = renderRoster(moonSnapshot(moonChat(), { roomId: '!moon-chat:test' }))

    const current = view.container.querySelectorAll('[aria-current="page"]')
    expect(current).toHaveLength(1)
    expect(current[0]?.getAttribute('aria-label')).toBe('Moon')
  })

  it('uses the native Matrix avatar for Moon’s canonical DM when no catalog row is available', async () => {
    $matrixMemberAvatars.set({})
    const member = vi.fn(async (userId: string) => ({ userId, avatarUrl: NATIVE_AVATAR }))
    const snapshot = moonSnapshot(moonChat({ peerAvatarMxc: 'mxc://matrix.test/moon' }))
    delete snapshot.apps

    renderRoster(snapshot, { profiles: { member } })

    const row = screen.getByRole('button', { name: 'Moon' })
    await waitFor(() => expect(row.querySelector('img')?.getAttribute('src')).toBe(NATIVE_AVATAR))
    expect(member).toHaveBeenCalledWith(moonBot)
  })

  it('keeps the initial when Moon’s native profile has no photo', async () => {
    $matrixMemberAvatars.set({})
    const member = vi.fn(async (userId: string) => ({ userId, avatarUrl: null }))
    const snapshot = moonSnapshot(moonChat({ peerAvatarMxc: 'mxc://matrix.test/moon-empty' }))
    delete snapshot.apps

    renderRoster(snapshot, { profiles: { member } })

    const row = screen.getByRole('button', { name: 'Moon' })
    await waitFor(() => expect(member).toHaveBeenCalledWith(moonBot))
    expect(row.querySelector('img')).toBeNull()
    expect(row.querySelector('span.atum-avatar')?.textContent).toBe('M')
  })

  it('uses the bot’s native Matrix avatar in its catalog row', async () => {
    $matrixMemberAvatars.set({})
    const member = vi.fn(async (userId: string) => ({ userId, avatarUrl: NATIVE_AVATAR }))

    renderRoster(moonSnapshot(moonChat({ peerAvatarMxc: 'mxc://matrix.test/moon-row' })), {
      profiles: { member }
    })

    const row = moonRow()
    await waitFor(() => expect(row?.querySelector('img')?.getAttribute('src')).toBe(NATIVE_AVATAR))
    expect(member).toHaveBeenCalledWith(moonBot)
  })

  it('keeps the row, without the deleted chat’s message or count, after Delete chat', () => {
    renderRoster(moonSnapshot(moonChat({}, { hidden: true })))

    expect(screen.getAllByRole('button', { name: 'Moon' })).toHaveLength(1)
    expect(moonRow()?.textContent).not.toContain('Your reading is ready')
    expect(moonRow()?.querySelector('[data-roster-unread]')).toBeNull()
  })

  it('is there before Moon has a chat, and search identifies its display name and public handle', () => {
    const { view } = renderRoster(moonSnapshot(null), { query: 'moon_bot' })

    expect(screen.getAllByRole('button', { name: 'Moon' })).toHaveLength(1)
    expect(within(moonRow()!).getByText('@moon_bot')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Chats' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Apps' })).toBeNull()
    // The count a screen reader hears includes the bot's row.
    expect(view.container.querySelector('[data-matrix-roster-results]')?.textContent).toBe(en.atum.roster.results(1))
  })

  it('orders an app chat by recency with the other chats under one Chats heading', () => {
    const appChat = moonChat({ lastActiveAt: 100 })
    const recentPerson: MatrixRoom = {
      id: '!recent-person:test',
      name: 'Recent person',
      membership: 'join',
      encrypted: false,
      lastActiveAt: 200
    }
    const olderPerson: MatrixRoom = {
      id: '!older-person:test',
      name: 'Older person',
      membership: 'join',
      encrypted: false,
      lastActiveAt: 50
    }
    const state = moonSnapshot(appChat, { rooms: [recentPerson, appChat, olderPerson] })
    const { view } = renderRoster(state)

    expect(screen.getAllByRole('heading', { name: 'Chats' })).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: 'Apps' })).toBeNull()
    expect(
      [...view.container.querySelectorAll('[data-matrix-room], [data-matrix-app-bot]')].map(
        row => row.getAttribute('data-matrix-room') ?? row.getAttribute('data-matrix-app-bot')
      )
    ).toEqual(['!recent-person:test', moonApp.app_id, '!older-person:test'])
  })

  it.each([
    ['Moon is paused', moonSnapshotWith({ bot: { ...moonApp.bot!, state: 'paused' } })],
    ['Moon is starting', moonSnapshotWith({ bot: { ...moonApp.bot!, state: 'starting', device: null } })],
    ['the catalog is unavailable', { apps: { state: 'unavailable' as const, apps: [moonApp], connections: {} } }]
  ])('still opens the chat it has, to read, while %s', async (_case, extra) => {
    const { command, onOpenApp } = renderRoster(moonSnapshot(moonChat(), extra))

    const row = screen.getByRole('button', { name: 'Moon' })
    expect(row.hasAttribute('disabled')).toBe(false)
    fireEvent.click(row)

    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: '!moon-chat:test' }))
    expect(onOpenApp).not.toHaveBeenCalled()
  })

  it('is off while Moon is paused and it has no chat, or only one the person deleted', () => {
    const paused = moonSnapshotWith({ bot: { ...moonApp.bot!, state: 'paused' } })

    renderRoster(moonSnapshot(null, paused))
    expect(screen.getByRole('button', { name: 'Moon' }).hasAttribute('disabled')).toBe(true)
    cleanup()

    renderRoster(moonSnapshot(moonChat({}, { hidden: true }), paused))
    expect(screen.getByRole('button', { name: 'Moon' }).hasAttribute('disabled')).toBe(true)
  })

  it('says it is opening, in Vietnamese, and waits', () => {
    renderRoster(moonSnapshot(), { locale: 'vi', opening: moonApp.app_id })

    const row = screen.getByRole('button', { name: 'Moon' })
    expect(row.textContent).toContain(matrixAppCopy.vi.openingChat)
    expect(row.textContent).not.toContain(matrixAppCopy.en.openingChat)
    expect(row.getAttribute('aria-busy')).toBe('true')
    expect(row.hasAttribute('disabled')).toBe(true)
  })
})

// A catalog app's bot is a row, not code: `acme` has none of its own, and Demoza is the guest-enabled
// shape production sends. Neither has a chat with the person yet, which is the state of a first launch.
describe.each([
  ['an app the client has no code for', ACME],
  ['a guest-enabled bot, as production sends Demoza', Demoza],
  ['a guest-enabled bot nobody has named in code', ACME_GUEST]
])('the roster row of %s', (_label, seed) => {
  const app = botApp(seed)

  function snapshotWith(
    change: Partial<AppDescriptor> = {},
    chat: MatrixRoom | null = null,
    extra: Partial<MatrixSnapshot> = {}
  ) {
    const base = readySnapshot()

    return {
      ...base,
      rooms: chat ? [...base.rooms, chat] : base.rooms,
      apps: { state: 'ready', apps: [{ ...app, ...change }], connections: {} },
      appShortcuts: { [app.app_id]: { visibility: 'default', status: 'ready' } },
      ...extra
    } as MatrixSnapshot
  }

  function renderRoster(snapshot: MatrixSnapshot, query = '') {
    const command = vi.fn<MatrixUiBridge['command']>().mockResolvedValue(null)
    const onOpenApp = vi.fn()
    window.atumMatrix = { command } as unknown as MatrixUiBridge

    const view = render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixRosterConversations
          assistantOpening={false}
          fail={vi.fn()}
          onOpen={vi.fn()}
          onOpenApp={onOpenApp}
          openAgentChat={vi.fn()}
          openAssistant={vi.fn()}
          query={query}
          snapshot={snapshot}
        />
      </I18nProvider>
    )

    return { command, onOpenApp, view }
  }

  const row = () => window.document.querySelector<HTMLElement>(`[data-matrix-app-bot="${app.app_id}"]`)

  it('is in the list before the person has any chat with the bot, and opens its chat on a click', () => {
    const { command, onOpenApp } = renderRoster(snapshotWith())

    expect(row()).not.toBeNull()
    const button = screen.getByRole('button', { name: seed.name })
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)

    expect(onOpenApp).toHaveBeenCalledExactlyOnceWith(app)
    expect(command).not.toHaveBeenCalled()
  })

  it('carries its chat once there is one, instead of listing that chat on its own', () => {
    const chat: MatrixRoom = {
      id: '!bot-chat:test',
      name: seed.name,
      membership: 'join',
      encrypted: false,
      direct: true,
      participants: [
        { userId: owner, membership: 'join' },
        { userId: botUserOf(seed), membership: 'join' }
      ],
      preview: { own: false, kind: 'text', text: 'Hello from the bot', at: 100 },
      lastActiveAt: 100,
      appBot: { appId: app.app_id, botUserId: botUserOf(seed), current: true }
    }

    renderRoster(snapshotWith({}, chat))

    expect(screen.getAllByRole('button', { name: seed.name })).toHaveLength(1)
    expect(row()?.textContent).toContain('Hello from the bot')
    expect(window.document.querySelector('[data-matrix-room="!bot-chat:test"]')).toBeNull()
  })

  it('is found by its name, and is off — saying why — while its bot cannot answer', () => {
    renderRoster(snapshotWith(), seed.name.toLowerCase())
    expect(row()).not.toBeNull()
    cleanup()

    const paused = botApp(seed, {}, { state: 'paused' })
    renderRoster(snapshotWith({ bot: paused.bot }))
    expect(screen.getByRole('button', { name: seed.name }).hasAttribute('disabled')).toBe(true)
    expect(row()?.textContent).toContain(appChatCopy('en').botRowState.paused)
  })

  it('is not drawn when the person took it off the roster', () => {
    renderRoster(snapshotWith({}, null, { appShortcuts: { [app.app_id]: { visibility: 'hidden', status: 'ready' } } }))

    expect(row()).toBeNull()
  })
})

describe('a Mac that is not ready while the policy answers elsewhere', () => {
  const policyView = (): MatrixExecutionPolicyView => ({
    policy: parseExecutionPolicySnapshot(policyFixture)!,
    status: parseExecutionStatusSnapshot(statusFixture)!,
    stale: false,
    deviceNames: { '00000000-0000-4000-8000-b454f82c5857': { displayName: 'Mac mini', thisMac: false } }
  })

  it('uses the normal status line under cloud-only instead of naming a Mac', () => {
    const snapshot = readySnapshot()
    // A runtime that needs downloading offers no Try again: nothing contradicts the line.
    snapshot.agents![1] = {
      ...snapshot.agents![1]!,
      ready: false,
      readiness: { phase: 'blocked', step: 'ai', code: 'runtime_unavailable', since: 1 },
      executionPolicy: policyView()
    }
    const { view } = setup(snapshot, '', 'vi')

    const moon = view.container.querySelector<HTMLElement>('[data-matrix-agent="moon"]')!
    expect(within(moon).queryByText('Trên Mac mini')).toBeNull()
    expect(within(moon).getByText('Chưa sẵn sàng')).toBeTruthy()
  })

  it('says where it answers, briefly, with cloud-only switched off (§9.6)', () => {
    const snapshot = readySnapshot()
    snapshot.agents![1] = {
      ...snapshot.agents![1]!,
      ready: false,
      readiness: { phase: 'blocked', step: 'ai', code: 'runtime_unavailable', since: 1 },
      executionPolicy: policyView()
    }
    const { view } = setup(snapshot, '', 'vi', undefined, false)

    const moon = view.container.querySelector<HTMLElement>('[data-matrix-agent="moon"]')!
    expect(within(moon).getByText('Trên Mac mini')).toBeTruthy()
    expect(within(moon).queryByText('Chưa sẵn sàng')).toBeNull()
  })

  it('lets the error win while the row offers Try again: never “Trên Mac mini” beside the button', () => {
    const snapshot = readySnapshot()
    snapshot.agents![1] = {
      ...snapshot.agents![1]!,
      ready: false,
      readiness: { phase: 'blocked', step: 'ai', code: 'offline', since: 1 },
      executionPolicy: policyView()
    }
    const { view } = setup(snapshot, '', 'vi')

    const moon = view.container.querySelector<HTMLElement>('[data-matrix-agent="moon"]')!
    expect(moon.querySelector('[data-matrix-agent-retry]')).toBeTruthy()
    expect(within(moon).queryByText('Trên Mac mini')).toBeNull()
    expect(within(moon).getByText('Chưa sẵn sàng')).toBeTruthy()
  })

  it('keeps “Chưa sẵn sàng” when the assistant has no policy to answer through', () => {
    const snapshot = readySnapshot()
    snapshot.agents![1] = {
      ...snapshot.agents![1]!,
      ready: false,
      readiness: { phase: 'blocked', step: 'ai', code: 'offline', since: 1 }
    }
    const { view } = setup(snapshot, '', 'vi')

    const moon = view.container.querySelector<HTMLElement>('[data-matrix-agent="moon"]')!
    expect(within(moon).getByText('Chưa sẵn sàng')).toBeTruthy()
  })

  it('still names a specific readiness need above the policy line', () => {
    const snapshot = readySnapshot()
    snapshot.agents![1] = {
      ...snapshot.agents![1]!,
      ready: false,
      readiness: { phase: 'blocked', step: 'assistant', code: 'recovery_required', since: 1 },
      executionPolicy: policyView()
    }
    const { view } = setup(snapshot, '', 'vi')

    const moon = view.container.querySelector<HTMLElement>('[data-matrix-agent="moon"]')!
    expect(within(moon).getByText('Chờ mở khóa Mac này')).toBeTruthy()
    expect(within(moon).queryByText('Trên Mac mini')).toBeNull()
  })
})
