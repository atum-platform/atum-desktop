import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixPinnedMessages } from '../../../shared/matrix'

import { PinnedMessageMarker, PinnedMessagesButton, PinnedMessagesPanel } from './pinned-panel'

afterEach(cleanup)

const wrap = (value: React.ReactNode) => (
  <I18nProvider configClient={null} initialLocale="en">
    {value}
  </I18nProvider>
)

const pinned: MatrixPinnedMessages = {
  canChange: true,
  entries: [
    {
      eventId: '$decision',
      message: {
        id: '$decision',
        sender: '@alice:test',
        body: 'Ship the smaller release first.',
        timestamp: Date.UTC(2026, 9, 29, 4, 30),
        own: false,
        encrypted: false,
        decryptionFailed: false,
        pending: false,
        failed: false,
        attachment: false
      }
    },
    { eventId: '$missing' }
  ]
}

describe('Team Space pinned messages', () => {
  it('keeps a header control visible with the shared count', () => {
    render(wrap(<PinnedMessagesButton count={2} onClick={vi.fn()} open />))

    expect(screen.getByRole('button', { name: '2 pinned messages', expanded: true })).toBeTruthy()
  })

  it('lists readable pins and honest unavailable tombstones, then jumps by immutable event id', () => {
    const onJump = vi.fn()
    render(
      wrap(
        <PinnedMessagesPanel compact={false} nameOf={() => 'Alice'} onClose={vi.fn()} onJump={onJump} pinned={pinned} />
      )
    )

    expect(screen.getByText('Ship the smaller release first.')).toBeTruthy()
    expect(screen.getByText('This pinned message is unavailable.')).toBeTruthy()
    fireEvent.click(screen.getAllByText('Jump to message')[0]!)
    expect(onJump).toHaveBeenCalledExactlyOnceWith('$decision', undefined)
  })

  it('shows a compact empty state and the message marker', () => {
    const { container } = render(
      wrap(
        <>
          <PinnedMessagesPanel
            compact
            nameOf={value => value}
            onClose={vi.fn()}
            onJump={vi.fn()}
            pinned={{ canChange: false, entries: [] }}
          />
          <PinnedMessageMarker />
        </>
      )
    )

    expect(screen.getByText('No pinned messages yet.')).toBeTruthy()
    expect(container.querySelector('[data-matrix-pinned-marker]')).toBeTruthy()
  })
})
