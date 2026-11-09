import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixCompanyActivityItem } from '../../../shared/matrix-company-activity'

import { authorizedCompanyActivity, CompanyActivityView } from './activity'
import { activityCopy } from './activity-copy'

afterEach(cleanup)

const rooms = [
  { roomId: '!launch:test', kind: 'channel' as const, name: 'launch' },
  { roomId: '!linh:test', kind: 'conversation' as const, name: 'Linh' }
]

const items: MatrixCompanyActivityItem[] = [
  {
    companyId: 'company-1',
    roomId: '!launch:test',
    eventId: '$mention',
    kind: 'mention',
    body: 'Can you review this?',
    senderId: '@minh:test',
    senderName: 'Minh',
    sentAt: Date.UTC(2026, 9, 30, 3),
    unread: true
  },
  {
    companyId: 'company-1',
    roomId: '!linh:test',
    eventId: '$reply',
    kind: 'thread_reply',
    body: 'I added the final note.',
    senderId: '@linh:test',
    senderName: 'Linh',
    sentAt: Date.UTC(2026, 9, 30, 2),
    unread: false,
    threadRootId: '$root'
  },
  {
    companyId: 'company-1',
    roomId: '!restricted:test',
    eventId: '$restricted',
    kind: 'mention',
    body: 'Never show this',
    senderId: '@restricted:test',
    sentAt: Date.UTC(2026, 9, 30, 4),
    unread: true
  },
  {
    companyId: 'company-2',
    roomId: '!other:test',
    eventId: '$other-company',
    kind: 'mention',
    body: 'Wrong company',
    senderId: '@other:test',
    sentAt: Date.UTC(2026, 9, 30, 5),
    unread: true
  }
]

function draw(
  locale = 'en',
  onOpen = vi.fn(async () => {}),
  pageSize = 25,
  displayItems: readonly MatrixCompanyActivityItem[] = items
) {
  return {
    onOpen,
    ...render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <CompanyActivityView
          companyId="company-1"
          items={displayItems}
          onOpen={onOpen}
          pageSize={pageSize}
          rooms={rooms}
        />
      </I18nProvider>
    )
  }
}

describe('Team Space Activity view', () => {
  it('filters against the company-authorized room list before content or counts can render', () => {
    expect(authorizedCompanyActivity(items, 'company-1', rooms).map(item => item.eventId)).toEqual([
      '$mention',
      '$reply'
    ])

    draw()
    expect(screen.getByText('Can you review this?')).toBeTruthy()
    expect(screen.getByText('I added the final note.')).toBeTruthy()
    expect(screen.queryByText('Never show this')).toBeNull()
    expect(screen.queryByText('Wrong company')).toBeNull()
  })

  it('switches between All and Mentions and announces unread rows', () => {
    draw()
    const view = screen.getByRole('region', { name: 'Activity' })
    expect(within(view).getByText('Thread reply')).toBeTruthy()
    expect(within(view).getByText('Unread')).toBeTruthy()

    fireEvent.click(within(view).getByRole('radio', { name: 'Mentions' }))
    expect(within(view).getByText('Can you review this?')).toBeTruthy()
    expect(within(view).queryByText('I added the final note.')).toBeNull()
  })

  it('opens a thread reply with its room, event and thread root intact', async () => {
    const onOpen = vi.fn(async () => {})
    draw('en', onOpen)

    fireEvent.click(screen.getByRole('button', { name: /Open in Linh/ }))
    await waitFor(() => expect(onOpen).toHaveBeenCalledExactlyOnceWith(items[1]))
  })

  it('loads the bounded list in pages and uses Vietnamese copy', () => {
    draw('vi', vi.fn(async () => {}), 1)
    const view = screen.getByRole('region', { name: 'Hoạt động' })
    expect(within(view).getAllByRole('listitem')).toHaveLength(1)
    fireEvent.click(within(view).getByRole('button', { name: 'Xem thêm' }))
    expect(within(view).getAllByRole('listitem')).toHaveLength(2)
    expect(within(view).getByRole('radio', { name: 'Lượt nhắc' })).toBeTruthy()
  })

  it('provides the Activity surface in every desktop locale', () => {
    expect(activityCopy('ja').title).toBe('アクティビティ')
    expect(activityCopy('zh').title).toBe('活动')
    expect(activityCopy('zh-Hant').title).toBe('活動')
  })

  it('bounds the message excerpt in a row accessible name without truncating visible text', () => {
    const body = `Long update ${'x'.repeat(220)}`
    draw('en', vi.fn(async () => {}), 25, [{ ...items[0]!, body }])

    expect(screen.getByText(body)).toBeTruthy()
    const row = screen.getByRole('button', { name: /Open in launch/u })
    const label = row.getAttribute('aria-label')!

    expect(label).toContain('…')
    expect(label).not.toContain(body)
    expect(label.length).toBeLessThan(170)
  })
})
