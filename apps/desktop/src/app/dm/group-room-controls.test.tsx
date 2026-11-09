import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { type ComponentProps, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { GroupOperationInput, GroupOperationResult, GroupRoom } from '../../../shared/atum-group-conversations'

import { GroupRoomControls, type GroupRoomManagementOperation } from './group-room-controls'

const room: GroupRoom = {
  conversationId: 'room-1',
  title: 'Weekend',
  revision: 1,
  retiredAt: null,
  membershipEpoch: 4,
  updatedAt: '2026-09-06T00:00:00.000Z',
  members: [
    { userId: 'owner', displayName: 'Minh', handle: 'minh', role: 'owner', membershipEpoch: 4 },
    { userId: 'member', displayName: 'Lan', handle: 'lan', role: 'member', membershipEpoch: 4 }
  ]
}

const ownedAssistant = {
  assistantId: 'owned-agent',
  displayName: 'Owner agent',
  avatar: '◌',
  ownerUserId: 'owner',
  ownerDisplayName: 'Minh',
  membershipEpoch: 4,
  availability: 'available' as const
}

const foreignAssistant = {
  assistantId: 'foreign-agent',
  displayName: 'Lan agent',
  avatar: '◒',
  ownerUserId: 'member',
  ownerDisplayName: 'Lan',
  membershipEpoch: 4,
  availability: 'assistant_not_owned' as const
}

const sharedCapabilities = {
  available: true,
  creationEnabled: true,
  humanMemberLimit: 32,
  sharedAgents: {
    enabled: true,
    assistantMemberLimit: 4,
    ownAssistantOnly: true as const,
    assistantCatalog: [ownedAssistant, foreignAssistant]
  }
}

function renderControls(overrides: Partial<ComponentProps<typeof GroupRoomControls>> = {}) {
  const onOperate = vi
    .fn<(input: GroupOperationInput) => Promise<GroupOperationResult>>()
    .mockResolvedValue({ operationId: 'op-1', state: 'sent', conversationId: 'room-1', errorCode: null })

  const onRequestReport = vi.fn()

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <GroupRoomControls
        capabilities={{ available: true, creationEnabled: true, humanMemberLimit: 32 }}
        contacts={[{ userId: 'contact', displayName: 'Hà', handle: 'ha' }]}
        createOperationId={() => 'op-1'}
        onOperate={onOperate}
        onRequestReport={onRequestReport}
        room={room}
        viewerUserId="owner"
        {...overrides}
      />
    </I18nProvider>
  )

  return { onOperate, onRequestReport }
}

function ControlsUnmountHarness({
  createOperationId,
  onOperate
}: {
  createOperationId: () => string
  onOperate: (input: GroupOperationInput) => Promise<GroupOperationResult>
}) {
  const [mounted, setMounted] = useState(true)
  const [pendingOperation, setPendingOperation] = useState<GroupRoomManagementOperation | null>(null)

  return (
    <I18nProvider configClient={null} initialLocale="en">
      <button onClick={() => setMounted(false)} type="button">
        Close controls
      </button>
      <button onClick={() => setMounted(true)} type="button">
        Reopen controls
      </button>
      {mounted && (
        <GroupRoomControls
          capabilities={{ available: true, creationEnabled: true, humanMemberLimit: 32 }}
          contacts={[{ userId: 'contact', displayName: 'Hà', handle: 'ha' }]}
          createOperationId={createOperationId}
          onOperate={onOperate}
          onPendingOperationChange={setPendingOperation}
          onRequestReport={vi.fn()}
          pendingOperation={pendingOperation}
          room={room}
          viewerUserId="owner"
        />
      )}
    </I18nProvider>
  )
}

afterEach(cleanup)

describe('GroupRoomControls', () => {
  it('emits a typed owner rename with a stable supplied operation id', async () => {
    const { onOperate } = renderControls()

    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: '  Picnic  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))

    await waitFor(() =>
      expect(onOperate).toHaveBeenCalledWith({
        action: 'rename',
        clientOperationId: 'op-1',
        conversationId: 'room-1',
        title: 'Picnic'
      })
    )
    expect(screen.getByText('Room updated.')).toBeTruthy()
  })

  it('requires an active owner to transfer before leaving', () => {
    renderControls()

    expect(screen.getByText('Transfer ownership before leaving this room.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Leave room' })).toBeNull()
  })

  it('keeps leave and report available in a retired room while hiding owner mutations', () => {
    renderControls({ room: { ...room, retiredAt: '2026-09-06T01:00:00.000Z' } })

    expect(screen.getByText('This room is read-only. You can still leave or report.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Leave room' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Report' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull()
  })

  it('does not claim a queued operation completed', async () => {
    const { onOperate } = renderControls()
    onOperate.mockResolvedValueOnce({ operationId: 'op-1', state: 'queued', conversationId: 'room-1', errorCode: null })

    fireEvent.click(screen.getByRole('button', { name: 'Hà (@ha)' }))

    expect(await screen.findByText('This action is queued and has not completed yet.')).toBeTruthy()
    expect(screen.queryByText('Room updated.')).toBeNull()
  })

  it('locks room mutations after a queued result instead of minting another operation id', async () => {
    const createOperationId = vi.fn().mockReturnValue('op-1')

    const onOperate = vi
      .fn<(input: GroupOperationInput) => Promise<GroupOperationResult>>()
      .mockResolvedValue({ operationId: 'op-1', state: 'queued', conversationId: 'room-1', errorCode: null })

    renderControls({ createOperationId, onOperate })

    const add = screen.getByRole('button', { name: 'Hà (@ha)' })
    fireEvent.click(add)
    await screen.findByText('This action is queued and has not completed yet.')

    expect((add as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(add)
    expect(onOperate).toHaveBeenCalledTimes(1)
    expect(createOperationId).toHaveBeenCalledTimes(1)
  })

  it('retains a queued operation id when controls unmount and reopen', async () => {
    const createOperationId = vi.fn().mockReturnValue('op-1')

    const onOperate = vi
      .fn<(input: GroupOperationInput) => Promise<GroupOperationResult>>()
      .mockResolvedValue({ operationId: 'op-1', state: 'queued', conversationId: 'room-1', errorCode: null })

    render(<ControlsUnmountHarness createOperationId={createOperationId} onOperate={onOperate} />)

    fireEvent.click(screen.getByRole('button', { name: 'Hà (@ha)' }))
    await screen.findByText('This action is queued and has not completed yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Close controls' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reopen controls' }))

    const add = screen.getByRole('button', { name: 'Hà (@ha)' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    fireEvent.click(add)
    expect(onOperate).toHaveBeenCalledTimes(1)
    expect(createOperationId).toHaveBeenCalledTimes(1)
  })

  it('shows specialist membership and sends the typed owner app admission', async () => {
    const { onOperate } = renderControls({
      capabilities: {
        available: true,
        creationEnabled: true,
        humanMemberLimit: 32,
        addressing: {
          enabled: true,
          mentionCardinality: 8,
          quoteLimit: 4000,
          specialistMemberLimit: 4,
          specialistCatalog: [{ specialist: 'moon', displayName: 'Moon', avatar: '☾', roomSupported: true }]
        }
      }
    })

    fireEvent.click(screen.getByRole('button', { name: /Moon/ }))
    await waitFor(() =>
      expect(onOperate).toHaveBeenCalledWith({
        action: 'add_specialist',
        clientOperationId: 'op-1',
        conversationId: 'room-1',
        specialist: 'moon'
      })
    )
  })

  it('lists a foreign shared agent but only offers the owner’s available agent for admission', async () => {
    const { onOperate } = renderControls({
      capabilities: sharedCapabilities,
      room: { ...room, contextMode: 'shared_group', assistants: [foreignAssistant] }
    })

    expect(screen.getByText('Lan agent')).toBeTruthy()
    expect(screen.getByText("Lan's Lan agent")).toBeTruthy()
    expect(screen.getByText('Only the owner can use this agent')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Owner agent/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Lan agent/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Owner agent/ }))
    await waitFor(() =>
      expect(onOperate).toHaveBeenCalledWith({
        action: 'add_assistant',
        assistantId: 'owned-agent',
        clientOperationId: 'op-1',
        conversationId: 'room-1'
      })
    )
  })

  it('removes an agent and uses the refreshed authoritative room projection before admitting again', async () => {
    const onOperate = vi.fn<(input: GroupOperationInput) => Promise<GroupOperationResult>>()
    const initialRoom = { ...room, contextMode: 'shared_group' as const, assistants: [ownedAssistant] }

    function SharedRoomHarness() {
      const [currentRoom, setCurrentRoom] = useState<GroupRoom>(initialRoom)

      return (
        <I18nProvider configClient={null} initialLocale="en">
          <GroupRoomControls
            capabilities={sharedCapabilities}
            contacts={[]}
            createOperationId={() => 'op-1'}
            onOperate={async input => {
              onOperate(input)

              if (input.action === 'remove_assistant') {
                setCurrentRoom({ ...initialRoom, assistants: [] })
              }

              return { operationId: 'op-1', state: 'sent', conversationId: 'room-1', errorCode: null }
            }}
            onRequestReport={vi.fn()}
            room={currentRoom}
            viewerUserId="owner"
          />
        </I18nProvider>
      )
    }

    render(<SharedRoomHarness />)

    expect(screen.queryByRole('button', { name: /Owner agent/ })).toBeNull()
    fireEvent.click(within(screen.getByText('Owner agent').closest('li')!).getByRole('button', { name: 'Remove' }))

    await waitFor(() =>
      expect(onOperate).toHaveBeenCalledWith({
        action: 'remove_assistant',
        assistantId: 'owned-agent',
        clientOperationId: 'op-1',
        conversationId: 'room-1'
      })
    )
    expect(await screen.findByRole('button', { name: /Owner agent/ })).toBeTruthy()
  })

  it('keeps shared-group controls after the last other person has left', () => {
    renderControls({
      capabilities: sharedCapabilities,
      room: {
        ...room,
        contextMode: 'shared_group',
        members: [room.members[0]!],
        assistants: [ownedAssistant]
      }
    })

    expect(screen.getByText('Owner agent')).toBeTruthy()
    expect(screen.queryByText('Your advisors use what they know about you from your private conversations.')).toBeNull()
  })
})
