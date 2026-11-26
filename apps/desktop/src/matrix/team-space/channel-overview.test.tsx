import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { type TeamSpaceChannelFacts, TeamSpaceChannelOverview } from './channel-overview'
import type { CompanyChannelView } from './views'

afterEach(cleanup)

const wrap = (value: React.ReactNode) => (
  <I18nProvider configClient={null} initialLocale="en">
    {value}
  </I18nProvider>
)

const channel = {
  id: 'ch-1',
  companyId: 'co-1',
  displayName: 'design',
  visibility: 'public',
  state: 'active',
  topic: '',
  purpose: 'Where the Kit is decided.',
  memberCount: 9,
  room: { state: 'ready', roomId: '!design:test' },
  projectId: null,
  channelGeneration: 1,
  wire: '1.4',
  actions: null
} as unknown as CompanyChannelView

const message = (id: string, sender: string, body: string, threadRootId?: string) => ({
  id,
  sender,
  body,
  timestamp: Date.UTC(2026, 10, 24, 4, 30),
  own: false,
  encrypted: false,
  decryptionFailed: false,
  pending: false,
  failed: false,
  attachment: false,
  ...(threadRootId ? { threadRootId } : {})
})

const facts = (pinned: TeamSpaceChannelFacts['pinned']): TeamSpaceChannelFacts => ({
  roomId: '!design:test',
  selfId: '@me:test',
  members: [
    { userId: '@me:test', name: 'Minh', membership: 'join', canRemove: false },
    { userId: '@an:test', name: 'An', membership: 'join', canRemove: false },
    { userId: '@gone:test', name: 'Gone', membership: 'leave', canRemove: false }
  ],
  pinned
})

describe('Team Space channel overview', () => {
  it('shows the joined members as faces, with the rest of the count after them', () => {
    render(wrap(<TeamSpaceChannelOverview channel={channel} facts={facts([])} onClose={vi.fn()} onOpenBoard={vi.fn()} />))

    const faces = document.querySelector('[data-team-space-channel-faces]')!
    expect(faces.getAttribute('data-team-space-channel-faces')).toBe('2')
    expect(faces.textContent).toContain('+7')
    // Nothing pinned: no empty pinned section.
    expect(document.querySelector('[data-team-space-channel-pins]')).toBeNull()
  })

  it('lists pinned messages and jumps to one, in its thread when it has one', () => {
    const open = vi.fn()

    render(
      wrap(
        <TeamSpaceChannelOverview
          channel={channel}
          facts={facts([
            { eventId: '$a', message: message('$a', '@an:test', 'Plus menus, never a pencil.', '$root') },
            { eventId: '$b', message: message('$b', '@me:test', 'Phosphor stays.') },
            { eventId: '$gone' }
          ])}
          onClose={vi.fn()}
          onOpenBoard={vi.fn()}
          onOpenPinned={open}
        />
      )
    )

    expect(screen.getByText('Pinned · 3')).toBeTruthy()
    expect(screen.getByText('An')).toBeTruthy()
    expect(screen.getByText('You')).toBeTruthy()
    expect(screen.getByText('Unavailable')).toBeTruthy()

    fireEvent.click(screen.getByText('Plus menus, never a pencil.'))
    expect(open).toHaveBeenCalledWith('$a', '$root')
  })
})
