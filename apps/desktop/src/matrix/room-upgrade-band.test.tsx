import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixRoom, MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'

import { RoomUpgradeBand } from './room-upgrade-band'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

const base: MatrixRoom = { id: '!old:test', name: 'Friends', encrypted: true, membership: 'join' }

const snapshot = {
  state: 'ready',
  identity: { userId: '@alice:test', deviceId: 'A' },
  rooms: [base],
  roomId: base.id,
  messages: [],
  error: null
} as MatrixSnapshot

function setup(room: MatrixRoom, command = vi.fn<MatrixUiBridge['command']>().mockResolvedValue(null)) {
  window.atumMatrix = { command } as unknown as MatrixUiBridge

  const view = render(
    <I18nProvider configClient={null} initialLocale="en">
      <RoomUpgradeBand room={room} snapshot={snapshot} />
    </I18nProvider>
  )

  return Object.assign(command, { container: view.container })
}

describe('the upgraded-room band', () => {
  it('says the chat moved and offers one action; joining is the person’s click, not a render', async () => {
    const command = setup({ ...base, successor: { roomId: '!new:test', state: 'join', backlink: 'pending' } })

    expect(screen.getByText('This chat moved to a new room.')).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(command).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Join new room' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'joinSuccessor', roomId: base.id }))
  })

  it('offers to open a replacement that is already joined and confirmed', async () => {
    const command = setup({ ...base, successor: { roomId: '!new:test', state: 'open' } })

    fireEvent.click(screen.getByRole('button', { name: 'Open new room' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'joinSuccessor', roomId: base.id }))
  })

  it('shows one line and no action for a replacement that cannot be confirmed', () => {
    setup({ ...base, successor: { roomId: '!new:test', state: 'unconfirmed' } })

    expect(screen.getByText('This chat moved, but the new room can’t be confirmed.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('turns into one line, no action, when the replacement cannot be reached', async () => {
    const command = vi.fn<MatrixUiBridge['command']>().mockRejectedValue(new Error('matrix_room_upgrade_unconfirmed'))
    setup({ ...base, successor: { roomId: '!new:test', state: 'join', backlink: 'pending' } }, command)

    fireEvent.click(screen.getByRole('button', { name: 'Join new room' }))
    await waitFor(() => expect(screen.getByText('The new room isn’t available. Earlier messages stay here.')).toBeTruthy())
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('on the new room, links to the earlier messages and opens them on request', async () => {
    const command = setup({ ...base, id: '!new:test', predecessor: { roomId: '!old:test' } })

    expect(screen.getByText('This room continues an earlier one.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'See earlier messages' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: '!old:test' }))
  })

  it('is absent from a room that was never upgraded', () => {
    const { container } = setup(base)

    expect(container.querySelector('[data-room-upgrade]')).toBeNull()
  })
})
