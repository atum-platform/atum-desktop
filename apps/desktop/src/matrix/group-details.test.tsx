import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixRoom, MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'

import { MatrixMembers } from './conversation-controls'
import { MatrixChatMenu } from './conversation-menu'
import { MatrixGroupHeaderTopic } from './group-details'
import { personalGroupDetails } from './roster-model'

// Preserve user-visible identity, state and recovery behavior across connection changes.
// standard m.room.name / m.room.topic, offered by the room's power levels, in personal groups only.

const owner = '@owner:test'

const group: MatrixRoom = {
  id: '!group:test',
  name: 'Friends',
  membership: 'join',
  encrypted: false,
  participants: [
    { userId: owner, membership: 'join' },
    { userId: '@bob:test', membership: 'join' },
    { userId: '@cara:test', membership: 'join' }
  ]
}

const allowed: MatrixRoom = { ...group, canName: true, canTopic: true }

function snapshotFor(room: MatrixRoom, patch: Partial<MatrixSnapshot> = {}): MatrixSnapshot {
  return {
    state: 'ready',
    identity: { userId: owner, deviceId: 'OWNER' },
    rooms: [room],
    roomId: room.id,
    messages: [],
    error: null,
    members: [{ userId: '@bob:test', name: 'Bob', membership: 'join', canRemove: false }],
    ...patch
  }
}

function setup(child: (room: MatrixRoom) => React.ReactNode, room: MatrixRoom) {
  const command = vi.fn<MatrixUiBridge['command']>().mockResolvedValue(null)
  window.atumMatrix = { command } as unknown as MatrixUiBridge

  const wrap = (current: MatrixRoom) => (
    <I18nProvider configClient={null} initialLocale="en">
      {child(current)}
    </I18nProvider>
  )

  const view = render(wrap(room))

  return { command, show: (next: MatrixRoom) => view.rerender(wrap(next)) }
}

const sheet = (room: MatrixRoom) => (
  <MatrixMembers onOpenChange={() => {}} open room={room} snapshot={snapshotFor(room)} />
)

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('who may change a group’s name and topic', () => {
  it.each([
    ['a personal group, allowed', {}, { name: true, topic: true }],
    ['a personal group, name only', { canTopic: undefined }, { name: true, topic: false }],
    ['a personal group, neither', { canName: undefined, canTopic: undefined }, { name: false, topic: false }],
    ['a one-to-one chat', { direct: true }, null],
    ['an assistant’s chat', { assistant: true }, null],
    ['an agent’s history', { agentPrincipal: 'agent' }, null],
    ['an app’s chat', { appBot: { appId: 'moon', botUserId: '@moon:test' } }, null],
    ['a typed room', { roomType: 'io.atum.app_group' }, null],
    ['a Team Space channel', { companyChannel: { companyId: 'c', channelId: 'ch' } }, null],
    ['a Team Space conversation', { companyConversation: { companyId: 'c', conversationId: 'dm' } }, null],
    ['an invitation', { membership: 'invite' }, null]
  ] as const)('%s', (_name, patch, expected) => {
    const room = { ...allowed, ...patch } as MatrixRoom
    expect(personalGroupDetails(room, snapshotFor(room))).toEqual(expected)
  })

  it('never the Founder chat', () => {
    const founder = { ...allowed, direct: true }
    expect(personalGroupDetails(founder, snapshotFor(founder, { founder: { userId: '@bob:test', roomId: founder.id } } as never))).toBeNull()
  })
})

describe('the group’s sheet', () => {
  it('renames the group in place, for everyone, with the standard room name', async () => {
    const { command } = setup(sheet, allowed)
    const dialog = screen.getByRole('dialog', { name: 'Friends' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename group' }))

    const field = within(dialog).getByRole('textbox', { name: 'Rename group' }) as HTMLInputElement
    expect(field.value).toBe('Friends')
    fireEvent.change(field, { target: { value: '  Weekend   trip ' } })
    fireEvent.submit(field.form!)

    await waitFor(() =>
      expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'groupName', roomId: allowed.id, name: 'Weekend trip' })
    )
    await waitFor(() => expect(within(dialog).queryByRole('textbox')).toBeNull())
  })

  it('never sends an empty name, and closes an unchanged one without a send', () => {
    const { command } = setup(sheet, allowed)
    fireEvent.click(screen.getByRole('button', { name: 'Rename group' }))
    const field = screen.getByRole('textbox', { name: 'Rename group' }) as HTMLInputElement
    fireEvent.change(field, { target: { value: '   ' } })
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(field.form!)
    expect(command).not.toHaveBeenCalled()

    fireEvent.change(field, { target: { value: 'Friends' } })
    fireEvent.submit(field.form!)
    expect(command).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('adds a topic, then clears it, with the standard room topic', async () => {
    const { command, show } = setup(sheet, allowed)
    fireEvent.click(screen.getByRole('button', { name: 'Add a topic' }))
    const field = screen.getByRole('textbox', { name: 'Topic' })
    fireEvent.change(field, { target: { value: 'Plans for Saturday' } })
    fireEvent.submit((field as HTMLInputElement).form!)
    await waitFor(() =>
      expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'groupTopic', roomId: allowed.id, topic: 'Plans for Saturday' })
    )

    // Sync brings the topic back as the room's state.
    show({ ...allowed, topic: 'Plans for Saturday' })
    expect(screen.getByText('Plans for Saturday')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit topic' }))
    const again = screen.getByRole('textbox', { name: 'Topic' })
    fireEvent.change(again, { target: { value: '' } })
    fireEvent.submit((again as HTMLInputElement).form!)
    await waitFor(() => expect(command).toHaveBeenLastCalledWith({ kind: 'groupTopic', roomId: allowed.id, topic: '' }))
  })

  it('puts an edit back on Escape, keeping the sheet open', () => {
    const { command } = setup(sheet, allowed)
    fireEvent.click(screen.getByRole('button', { name: 'Rename group' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename group' }), { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Friends' })).toBeTruthy()
    expect(command).not.toHaveBeenCalled()
  })

  it('shows the name and topic read-only to someone the room does not allow', () => {
    setup(sheet, { ...group, topic: 'Plans for Saturday' })
    const dialog = screen.getByRole('dialog', { name: 'Friends' })
    expect(within(dialog).getByText('Plans for Saturday')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Rename group' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Edit topic' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Add a topic' })).toBeNull()
  })

  it('closes an edit when the room takes the power away, and follows a rename from sync', () => {
    const { show } = setup(sheet, allowed)
    fireEvent.click(screen.getByRole('button', { name: 'Rename group' }))
    show({ ...group, name: 'Renamed elsewhere' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Renamed elsewhere' })).toBeTruthy()
  })

  it('keeps the plain Members sheet for a chat that is not a personal group', () => {
    const app = { ...allowed, roomType: 'io.atum.app_group' }
    setup(sheet, app)
    expect(screen.getByRole('dialog', { name: 'Members (1)' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Rename group' })).toBeNull()
  })
})

describe('the chat’s menu', () => {
  const menu = (room: MatrixRoom) => (
    <MatrixChatMenu fail={vi.fn()} room={room} snapshot={snapshotFor(room)} title={room.title ?? room.name} />
  )

  const rename = (name: string) => {
    fireEvent.keyDown(screen.getByRole('button', { name: 'Conversation options' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const field = screen.getByRole('textbox', { name: 'Name' })
    fireEvent.change(field, { target: { value: name } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  }

  it('renames a group you may rename for everyone', async () => {
    const { command } = setup(menu, allowed)
    rename('Weekend trip')
    expect(screen.getByRole('dialog', { name: 'Rename group' })).toBeTruthy()
    await waitFor(() =>
      expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'groupName', roomId: allowed.id, name: 'Weekend trip' })
    )
  })

  it('keeps your own private name for a group you may not rename', async () => {
    const { command } = setup(menu, group)
    rename('Mine')
    expect(screen.getByRole('dialog', { name: 'Rename chat' })).toBeTruthy()
    await waitFor(() =>
      expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'chatTitle', roomId: group.id, title: 'Mine' })
    )
  })
})

describe('the chat’s header', () => {
  it('shows a personal group’s topic, and nothing for other chats', () => {
    const { show } = setup(room => <MatrixGroupHeaderTopic room={room} snapshot={snapshotFor(room)} />, {
      ...group,
      topic: 'Plans for Saturday'
    })

    expect(screen.getByText('Plans for Saturday')).toBeTruthy()
    show({ ...group, topic: 'Plans for Sunday' })
    expect(screen.getByText('Plans for Sunday')).toBeTruthy()
    show({ ...group, topic: 'Plans for Sunday', direct: true })
    expect(screen.queryByText('Plans for Sunday')).toBeNull()
  })
})
