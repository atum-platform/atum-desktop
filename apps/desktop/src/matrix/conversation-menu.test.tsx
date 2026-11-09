import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { en } from '@/i18n/en'
import { vi as viLocale } from '@/i18n/vi'

import type { MatrixRoom, MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'

import { matrixChatCopy } from './chat-copy'
import { MatrixChatMenu } from './conversation-menu'

const linh: MatrixRoom = { id: '!linh:test', name: 'Linh', membership: 'join', encrypted: true, direct: true }
const team: MatrixRoom = { id: '!team:test', name: 'Team', membership: 'join', encrypted: true }

function snapshotFor(room: MatrixRoom): MatrixSnapshot {
  return {
    state: 'ready',
    identity: { userId: '@owner:test', deviceId: 'OWNER' },
    rooms: [linh, team].map(value => (value.id === room.id ? room : value)),
    roomId: room.id,
    messages: [],
    error: null
  }
}

// The header's menu: one component whose chat can change under it.
function setup(room: MatrixRoom) {
  const command = vi.fn<MatrixUiBridge['command']>().mockResolvedValue(null)
  const onBackground = vi.fn()
  window.atumMatrix = { command } as unknown as MatrixUiBridge

  const content = (current: MatrixRoom) => (
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixChatMenu
        fail={vi.fn()}
        onBackground={onBackground}
        room={current}
        snapshot={snapshotFor(current)}
        title={current.title ?? current.name}
      />
    </I18nProvider>
  )

  const view = render(content(room))

  return { command, onBackground, show: (next: MatrixRoom) => view.rerender(content(next)) }
}

function choose(item: string) {
  fireEvent.keyDown(screen.getByRole('button', { name: 'Conversation options' }), { key: 'Enter' })
  fireEvent.click(screen.getByRole('menuitem', { name: item }))
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe("a chat's menu acts on the chat it opened for", () => {
  it('opens the personal background sheet from every ordinary chat menu', () => {
    const { onBackground } = setup(linh)
    choose('Background')
    expect(onBackground).toHaveBeenCalledOnce()
  })
  it('closes a confirmation, sending nothing, when another chat takes its place', async () => {
    const { command, show } = setup(team)
    choose('Leave group')
    expect(screen.getByRole('dialog', { name: 'Leave this chat?' })).toBeTruthy()

    show(linh)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(command).not.toHaveBeenCalled()

    // The new chat's own menu works on the new chat.
    choose('Delete chat')
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Delete this chat?' })).getByRole('button', { name: 'Delete' })
    )
    await waitFor(() => expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'forget', roomId: linh.id }))
  })

  it('leaves the chat it asked about, through a sync that changes that chat', async () => {
    const { command, show } = setup(team)
    choose('Leave group')
    // The same chat, renamed by sync while the question is open.
    show({ ...team, name: 'Team (renamed)' })

    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Leave this chat?' })).getByRole('button', { name: 'Leave group' })
    )
    await waitFor(() => expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'forget', roomId: team.id }))
  })

  it('renames the chat it opened for, keeping what you typed through a sync', async () => {
    const { command, show } = setup(team)
    choose('Rename')
    const field = await screen.findByRole('textbox', { name: 'Name' })
    expect((field as HTMLInputElement).value).toBe('Team')
    fireEvent.change(field, { target: { value: 'Launch crew' } })

    show({ ...team, name: 'Team', title: 'Set on another device' })
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Launch crew')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'chatTitle', roomId: team.id, title: 'Launch crew' })
    )
  })

  it('closes the rename, saving nothing, when another chat takes its place', async () => {
    const { command, show } = setup(team)
    choose('Rename')
    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: 'Launch crew' } })

    show(linh)
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull())
    expect(command).not.toHaveBeenCalled()
  })
})

describe('Delete chat on an official bot’s chat', () => {
  const moonId = '00000000-0000-4000-8000-e79acd97ac88'

  const moonChat: MatrixRoom = {
    id: '!moon:test',
    name: 'Moon',
    membership: 'join',
    encrypted: true,
    direct: true,
    appBot: { appId: moonId, botUserId: '@app-moon:test', current: true }
  }

  function renderIn(locale: 'en' | 'vi', room: MatrixRoom) {
    const command = vi.fn<MatrixUiBridge['command']>().mockResolvedValue({ outcome: 'hidden', appId: moonId })
    window.atumMatrix = { command } as unknown as MatrixUiBridge

    const snapshot = {
      ...snapshotFor(linh),
      rooms: [room],
      roomId: room.id,
      apps: { state: 'ready', apps: [{ app_id: moonId, bot: { display_name: 'Moon' } }], connections: {} }
    } as unknown as MatrixSnapshot

    render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <MatrixChatMenu fail={vi.fn()} room={room} snapshot={snapshot} title={room.name} />
      </I18nProvider>
    )

    return command
  }

  it('does not offer Delete chat for an app bot', () => {
    const copy = matrixChatCopy('vi')
    const command = renderIn('vi', moonChat)
    fireEvent.keyDown(screen.getByRole('button', { name: copy.conversationOptions }), { key: 'Enter' })
    expect(screen.queryByRole('menuitem', { name: copy.deleteChat })).toBeNull()
    expect(command).not.toHaveBeenCalled()
  })

  it('keeps the ordinary sentence for a chat with a person', () => {
    const en = matrixChatCopy('en')
    renderIn('en', linh)
    choose(en.deleteChat)

    const dialog = screen.getByRole('dialog', { name: en.deleteChatTitle })
    expect(dialog.textContent).toContain(en.deleteChatBody)
    expect(dialog.textContent).not.toContain(en.deleteBotChatBody('Moon'))
  })
})

describe('the room awareness disclosure', () => {
  const plainDm: MatrixRoom = { id: '!plain-dm:test', name: 'Mai', membership: 'join', encrypted: false, direct: true }
  const plainGroup: MatrixRoom = { id: '!plain-group:test', name: 'Family', membership: 'join', encrypted: false }
  const assistantRoom: MatrixRoom = {
    id: '!assistant:test',
    name: 'Atum',
    membership: 'join',
    encrypted: false,
    assistant: true,
    plainAgent: true
  }
  const appRoom: MatrixRoom = {
    id: '!app:test',
    name: 'Moon',
    membership: 'join',
    encrypted: false,
    direct: true,
    appBot: { appId: '00000000-0000-4000-8000-e79acd97ac88', botUserId: '@app-moon:test', current: true }
  }

  function renderWith(room: MatrixRoom, locale: 'en' | 'vi' = 'en') {
    const awareness = { read: vi.fn(), change: vi.fn() }
    window.atumMatrix = { command: vi.fn(), awareness } as unknown as MatrixUiBridge

    render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <MatrixChatMenu fail={vi.fn()} room={room} snapshot={snapshotFor(room)} title={room.name} />
      </I18nProvider>
    )

    return awareness
  }

  function open(locale: 'en' | 'vi' = 'en') {
    fireEvent.keyDown(screen.getByRole('button', { name: matrixChatCopy(locale).conversationOptions }), {
      key: 'Enter'
    })
  }

  it.each([
    ['person', plainDm],
    ['group', plainGroup],
    ['assistant', assistantRoom],
    ['app', appRoom]
  ] as const)('uses the same readable-message disclosure for a plain %s room', (_kind, room) => {
    const awareness = renderWith(room)
    open()

    expect(screen.getByText(en.atum.awareness.roomInfo.title)).toBeTruthy()
    expect(screen.getByText(en.atum.awareness.roomInfo.plain)).toBeTruthy()
    expect(screen.queryByRole('menuitemcheckbox')).toBeNull()
    expect(awareness.read).not.toHaveBeenCalled()
    expect(awareness.change).not.toHaveBeenCalled()
  })

  it('shows metadata-only access for an encrypted room', () => {
    renderWith({ ...plainGroup, encrypted: true })
    open()

    expect(screen.getByText(en.atum.awareness.roomInfo.encrypted)).toBeTruthy()
    expect(screen.queryByText(en.atum.awareness.roomInfo.plain)).toBeNull()
  })

  it('uses the approved Vietnamese room-info line and points to encryption', () => {
    renderWith(plainGroup, 'vi')
    open('vi')

    expect(screen.getByText(viLocale.atum.awareness.roomInfo.title)).toBeTruthy()
    expect(screen.getByText(viLocale.atum.awareness.roomInfo.plain).textContent).toContain('Bật mã hóa')
  })
})
