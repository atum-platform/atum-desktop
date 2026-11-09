import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'

import { IgnoredPeople, ignoredPersonName } from './ignored-people'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

const snapshot: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@alice:test', deviceId: 'A' },
  rooms: [
    {
      id: '!bob:test',
      name: 'Bob',
      encrypted: true,
      direct: true,
      membership: 'join',
      participants: [
        { userId: '@alice:test', membership: 'join' },
        { userId: '@bob:test', membership: 'join' }
      ]
    }
  ],
  roomId: null,
  messages: [],
  error: null
}

function setup(child: React.ReactNode, command = vi.fn<MatrixUiBridge['command']>().mockResolvedValue(null)) {
  window.atumMatrix = { command } as unknown as MatrixUiBridge

  const wrap = (node: React.ReactNode) => (
    <I18nProvider configClient={null} initialLocale="en">
      {node}
    </I18nProvider>
  )

  const view = render(wrap(child))

  return { command, ...view, rerender: (node: React.ReactNode) => view.rerender(wrap(node)) }
}

describe('ignored people in Settings', () => {
  it('shows a count only when someone is ignored, and says where ignoring happens', () => {
    const { rerender } = setup(<IgnoredPeople snapshot={snapshot} />)
    expect(screen.getByText('Blocked people')).toBeTruthy()
    expect(screen.queryByText(/\(0\)/)).toBeNull()
    expect(screen.getByText(/Choose Block person in a chat’s menu/)).toBeTruthy()
    // No raw ID to type: ignoring happens beside the person.
    expect(screen.queryByRole('textbox')).toBeNull()

    rerender(<IgnoredPeople snapshot={{ ...snapshot, ignoredUsers: ['@bob:test'] }} />)
    expect(screen.getByText('Blocked people (1)')).toBeTruthy()
  })

  it('names people as the chats know them and takes an ignore back', async () => {
    const { command } = setup(
      <IgnoredPeople snapshot={{ ...snapshot, ignoredUsers: ['@bob:test', '@zed:other.test'] }} />
    )

    expect(screen.getByText('Bob')).toBeTruthy()
    // No verified handle: a readable ID reads as a name, never shown as an @handle or in full.
    expect(screen.getByText('zed')).toBeTruthy()
    expect(screen.queryByText('@zed:other.test')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Unblock Bob' }))
    await waitFor(() =>
      expect(command).toHaveBeenLastCalledWith({ kind: 'ignore', userId: '@bob:test', ignored: false })
    )
  })

  it('disables writes offline and drops an old account’s pending error after a keyed switch', async () => {
    let fail!: (error: Error) => void
    const command = vi.fn<MatrixUiBridge['command']>(() => new Promise((_resolve, reject) => (fail = reject)))

    const { rerender } = setup(
      <IgnoredPeople key="old" snapshot={{ ...snapshot, ignoredUsers: ['@bob:test'] }} />,
      command
    )

    fireEvent.click(screen.getByRole('button', { name: 'Unblock Bob' }))
    rerender(
      <IgnoredPeople
        key="new"
        snapshot={{
          ...snapshot,
          state: 'offline',
          identity: { userId: '@carol:test', deviceId: 'C' },
          ignoredUsers: ['@bob:test']
        }}
      />
    )
    await act(async () => fail(new Error('old account failed')))
    expect(screen.queryByRole('alert')).toBeNull()
    expect((screen.getByRole('button', { name: 'Unblock Bob' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('without a direct chat, names them by their verified handle and never by their ID', () => {
    const lone = { ...snapshot, rooms: [] }
    const opaque = '@user-0123456789abcdef0123456789abcdef:test'

    expect(ignoredPersonName(lone, opaque, { handles: { [opaque]: 'bob' }, unnamed: 'Atum user' })).toBe('@bob')
    expect(ignoredPersonName(lone, opaque, { handles: {}, unnamed: 'Atum user' })).toBe('Atum user')
    // An early, readable ID still reads as a name, but is not presented as a handle.
    expect(ignoredPersonName(lone, '@bob:test', { handles: {}, unnamed: 'Atum user' })).toBe('bob')
  })
})
