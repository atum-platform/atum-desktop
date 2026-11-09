import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixRoom, MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'

import { MatrixMembers } from './conversation-controls'
import { MatrixChatMenu } from './conversation-menu'
import { RosterMenuHost, RosterRoomMenu } from './roster-context-menu'

// Preserve user-visible identity, state and recovery behavior across connection changes.
// "we should have all basic functionalities of chat from Matrix right?"

const owner = '@owner:test'

const linh: MatrixRoom = {
  id: '!linh:test',
  name: 'Linh',
  membership: 'join',
  encrypted: true,
  direct: true,
  participants: [
    { userId: owner, membership: 'join' },
    { userId: '@linh:test', membership: 'join' }
  ]
}

const group: MatrixRoom = {
  id: '!group:test',
  name: 'Friends',
  membership: 'join',
  encrypted: false,
  participants: [
    { userId: owner, membership: 'join' },
    { userId: '@bob:test', membership: 'join' },
    { userId: '@atum:test', membership: 'join' }
  ]
}

const assistant: MatrixRoom = {
  id: '!assistant:test',
  name: 'Atum',
  membership: 'join',
  encrypted: true,
  assistant: true,
  roomType: 'io.atum.assistant',
  participants: [
    { userId: owner, membership: 'join' },
    { userId: '@atum:test', membership: 'join' }
  ]
}

function snapshotFor(room: MatrixRoom, patch: Partial<MatrixSnapshot> = {}): MatrixSnapshot {
  return {
    state: 'ready',
    identity: { userId: owner, deviceId: 'OWNER' },
    assistant: { userId: '@atum:test' },
    rooms: [linh, group, assistant].map(value => (value.id === room.id ? room : value)),
    roomId: room.id,
    messages: [],
    error: null,
    ...patch
  } as MatrixSnapshot
}

function setup(node: ReactNode, command = vi.fn<MatrixUiBridge['command']>().mockResolvedValue(null)) {
  window.atumMatrix = { command } as unknown as MatrixUiBridge
  render(
    <I18nProvider configClient={null} initialLocale="en">
      {node}
    </I18nProvider>
  )

  return command
}

const header = (room: MatrixRoom, patch?: Partial<MatrixSnapshot>) => (
  <MatrixChatMenu fail={vi.fn()} room={room} snapshot={snapshotFor(room, patch)} title={room.name} />
)

function openHeaderMenu() {
  fireEvent.keyDown(screen.getByRole('button', { name: 'Conversation options' }), { key: 'Enter' })
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('low priority', () => {
  it('marks and unmarks a chat with the m.lowpriority tag from the header menu', async () => {
    const command = setup(header(linh))
    openHeaderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark as low priority' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'lowPriority', roomId: linh.id, lowPriority: true })
    )

    cleanup()
    const again = setup(header({ ...linh, lowPriority: true }))
    openHeaderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove low priority' }))
    await waitFor(() =>
      expect(again).toHaveBeenCalledExactlyOnceWith({ kind: 'lowPriority', roomId: linh.id, lowPriority: false })
    )
  })

  it('is offered on a row’s right-click menu beside Pin', async () => {
    const command = setup(
      <RosterMenuHost>
        <RosterRoomMenu fail={vi.fn()} room={group} snapshot={snapshotFor(group)} title="Friends">
          <div data-row>Friends</div>
        </RosterRoomMenu>
      </RosterMenuHost>
    )

    fireEvent.contextMenu(screen.getByText('Friends'))
    const menu = screen.getByRole('menu')
    const items = within(menu).getAllByRole('menuitem').map(item => item.textContent)
    expect(items.indexOf('Mark as low priority')).toBe(items.indexOf('Pin') + 1)
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Mark as low priority' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'lowPriority', roomId: group.id, lowPriority: true })
    )
  })

  it('is not offered on an assistant’s chat, which its own section orders', () => {
    setup(header(assistant))
    openHeaderMenu()
    expect(screen.getByRole('menuitem', { name: 'Pin' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Mark as low priority' })).toBeNull()
  })
})

describe('report a person', () => {
  it('reports the other person in a DM after one short confirmation with an optional reason', async () => {
    const command = setup(header(linh))
    openHeaderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Report person' }))
    const dialog = screen.getByRole('dialog', { name: 'Report this person?' })
    expect(within(dialog).getByText('Atum’s moderators get the report. They aren’t blocked.')).toBeTruthy()
    expect(command).not.toHaveBeenCalled()

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Reason (optional)' }), {
      target: { value: '  sends scam links ' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Report' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledExactlyOnceWith({
        kind: 'reportUser',
        roomId: linh.id,
        userId: '@linh:test',
        reason: 'sends scam links'
      })
    )
    // Reporting is not blocking.
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'ignore' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('sends no reason when none is given, and keeps a failure in the dialog to try again', async () => {
    const command = setup(
      header(linh),
      vi.fn<MatrixUiBridge['command']>().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(null)
    )

    openHeaderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Report person' }))
    const dialog = screen.getByRole('dialog', { name: 'Report this person?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Report' }))
    expect(await within(dialog).findByRole('alert')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Report' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
    expect(command).toHaveBeenLastCalledWith({ kind: 'reportUser', roomId: linh.id, userId: '@linh:test' })
  })

  it('is offered from a person’s row menu, not from a group’s (no single person) or an assistant’s', async () => {
    const command = setup(
      <RosterMenuHost>
        <RosterRoomMenu fail={vi.fn()} room={linh} snapshot={snapshotFor(linh)} title="Linh">
          <div>Linh row</div>
        </RosterRoomMenu>
        <RosterRoomMenu fail={vi.fn()} room={group} snapshot={snapshotFor(group)} title="Friends">
          <div>Friends row</div>
        </RosterRoomMenu>
        <RosterRoomMenu fail={vi.fn()} room={assistant} snapshot={snapshotFor(assistant)} title="Atum">
          <div>Atum row</div>
        </RosterRoomMenu>
      </RosterMenuHost>
    )

    for (const row of ['Friends row', 'Atum row']) {
      fireEvent.contextMenu(screen.getByText(row))
      expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: 'Report person' })).toBeNull()
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    }

    fireEvent.contextMenu(screen.getByText('Linh row'))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Report person' }))
    const dialog = await screen.findByRole('dialog', { name: 'Report this person?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Report' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'reportUser', roomId: linh.id, userId: '@linh:test' })
    )
  })

  it('is offered for people in a group’s member list, never for its assistant', async () => {
    const command = setup(
      <MatrixMembers
        onOpenChange={() => {}}
        open
        room={group}
        snapshot={snapshotFor(group, {
          members: [
            { userId: owner, name: 'You', membership: 'join', canRemove: false },
            { userId: '@bob:test', name: 'Bob', membership: 'join', canRemove: false },
            { userId: '@atum:test', name: 'Atum', membership: 'join', canRemove: false }
          ]
        })}
      />
    )

    fireEvent.keyDown(screen.getByRole('button', { name: /Atum/u }), { key: 'Enter' })
    expect(screen.queryByRole('menuitem', { name: 'Report person' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    fireEvent.keyDown(screen.getByRole('button', { name: /Bob/u }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Report person' }))
    const dialog = await screen.findByRole('dialog', { name: 'Report this person?' })
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'spam' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Report' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledExactlyOnceWith({
        kind: 'reportUser',
        roomId: group.id,
        userId: '@bob:test',
        reason: 'spam'
      })
    )
  })

  it('the Founder is never offered it in the Founder chat', () => {
    setup(
      header(linh, {
        founder: { userId: owner, roomId: linh.id },
        officialAccounts: [{ userId: owner, role: 'founder', tier: 'official' }]
      } as Partial<MatrixSnapshot>)
    )
    openHeaderMenu()
    expect(screen.queryByRole('menuitem', { name: 'Report person' })).toBeNull()
  })
})
