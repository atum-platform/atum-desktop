import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixRoom, MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import { closeFounderDraft } from './founder/founder-store'
import { resetMatrixHandlesForTest } from './person-handles'
import { MatrixRosterConversations } from './roster-conversations'
import { MatrixRosterFilterButton } from './roster-filter-button'

const owner = '@owner:test'

afterEach(() => {
  cleanup()
  closeFounderDraft()
  resetMatrixHandlesForTest()
  Reflect.deleteProperty(window, 'atumMatrix')
})

function room(id: string, name: string, members: string[], extra: Partial<MatrixRoom> = {}): MatrixRoom {
  return {
    id,
    name,
    membership: 'join',
    encrypted: true,
    participants: [owner, ...members].map(userId => ({ userId, membership: 'join' })),
    lastActiveAt: 1,
    ...extra
  }
}

function snapshot(): MatrixSnapshot {
  return {
    state: 'ready',
    identity: { userId: owner, deviceId: 'OWNER' },
    assistant: { userId: '@atum:test', deviceId: 'ATUM' },
    agents: [{ principal: 'default', userId: '@atum:test', isDefault: true, ready: true, hermes: 'ready', atumModel: true }],
    rooms: [
      room('!atum:test', 'Atum chat', ['@atum:test'], { roomType: MATRIX_ASSISTANT_ROOM_TYPE }),
      room('!eve:test', 'Eve', ['@eve:test'], { direct: true }),
      room('!team:test', 'Team', ['@a:test', '@b:test'])
    ],
    roomId: null,
    messages: [],
    error: null
  }
}

describe('Chat roster filter button', () => {
  it('offers All plus the filters with data, and picks one', async () => {
    const onValueChange = vi.fn()

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixRosterFilterButton available={['all', 'people', 'groups']} onValueChange={onValueChange} value="all" />
      </I18nProvider>
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Filter' }), { button: 0, ctrlKey: false, pointerType: 'mouse' })

    const items = (await screen.findAllByRole('menuitemradio')).map(item => item.textContent)

    expect(items).toEqual(['All', 'People', 'Groups'])
    expect(screen.getByRole('menuitemradio', { name: 'All' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Groups' }))
    expect(onValueChange).toHaveBeenCalledWith('groups')
  })

  it('names the active filter on the button', () => {
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixRosterFilterButton available={['all', 'unread']} onValueChange={() => {}} value="unread" />
      </I18nProvider>
    )

    expect(screen.getByRole('button', { name: 'Filter: Unread' }).hasAttribute('data-active')).toBe(true)
  })

  it('filters the roster sections in place', () => {
    window.atumMatrix = { command: vi.fn().mockResolvedValue(null) } as unknown as MatrixUiBridge

    const view = (filter: 'all' | 'people' | 'assistants') => (
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixRosterConversations
          assistantOpening={false}
          fail={vi.fn()}
          filter={filter}
          onOpen={vi.fn()}
          openAgentChat={vi.fn()}
          openAssistant={vi.fn()}
          snapshot={snapshot()}
        />
      </I18nProvider>
    )

    const { rerender } = render(view('people'))

    expect(screen.getByRole('button', { name: /Eve/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Team/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Assistants' })).toBeNull()

    rerender(view('assistants'))
    expect(screen.getByRole('heading', { name: 'Assistants' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Eve/ })).toBeNull()

    rerender(view('all'))
    expect(screen.getByRole('button', { name: /Eve/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Team/ })).toBeTruthy()
  })
})
