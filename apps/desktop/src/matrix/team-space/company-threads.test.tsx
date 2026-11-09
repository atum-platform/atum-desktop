import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixCompanyThread, MatrixMessage } from '../../../shared/matrix'

import { authorizedCompanyThreads, CompanyThreadsView } from './company-threads'
import { companyThreadsCopy } from './company-threads-copy'

afterEach(cleanup)

const rooms = [
  { roomId: '!launch:test', kind: 'channel' as const, name: 'launch' },
  { roomId: '!linh:test', kind: 'conversation' as const, name: 'Linh' }
]

function root(id: string, body: string, timestamp: number): MatrixMessage {
  return {
    id,
    sender: '@linh:test',
    body,
    timestamp,
    own: false,
    encrypted: true,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false
  }
}

const threads: MatrixCompanyThread[] = [
  {
    companyId: 'company-1',
    roomId: '!launch:test',
    root: root('$launch', 'Launch checklist', 100),
    replies: [],
    participantIds: ['@linh:test'],
    replyCount: 4,
    lastActivityAt: 300,
    unread: false,
    highlights: 0,
    followed: false
  },
  {
    companyId: 'company-1',
    roomId: '!linh:test',
    root: root('$dm', 'Budget note', 90),
    replies: [],
    participantIds: ['@linh:test'],
    replyCount: 2,
    lastActivityAt: 200,
    unread: true,
    highlights: 0,
    followed: true
  },
  {
    companyId: 'company-1',
    roomId: '!restricted:test',
    root: root('$restricted', 'Restricted roadmap', 110),
    replies: [],
    participantIds: [],
    replyCount: 8,
    lastActivityAt: 400,
    unread: true,
    highlights: 0,
    followed: true
  },
  {
    companyId: 'company-2',
    roomId: '!other:test',
    root: root('$other', 'Other company', 120),
    replies: [],
    participantIds: [],
    replyCount: 1,
    lastActivityAt: 500,
    unread: true,
    highlights: 0,
    followed: true
  }
]

function draw({
  locale = 'en',
  onFollow = vi.fn(async () => {}),
  onOpen = vi.fn(async () => {}),
  onRead = vi.fn(async () => {}),
  pageSize = 25
} = {}) {
  return {
    onFollow,
    onOpen,
    onRead,
    ...render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <CompanyThreadsView
          companyId="company-1"
          onFollow={onFollow}
          onOpen={onOpen}
          onRead={onRead}
          pageSize={pageSize}
          rooms={rooms}
          threads={threads}
        />
      </I18nProvider>
    )
  }
}

describe('Team Space company Threads view', () => {
  it('filters through the current company directory before rendering thread metadata', () => {
    expect(authorizedCompanyThreads(threads, 'company-1', rooms).map(thread => thread.root.id)).toEqual([
      '$launch',
      '$dm'
    ])

    draw()
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('Launch checklist')
    expect(rows[1]?.textContent).toContain('Budget note')
    expect(screen.queryByText('Restricted roadmap')).toBeNull()
    expect(screen.queryByText('Other company')).toBeNull()
  })

  it('switches between Recent, Following and Unread without changing stable order', () => {
    draw()
    const view = screen.getByRole('region', { name: 'Threads' })

    fireEvent.click(within(view).getByRole('radio', { name: 'Following' }))
    expect(within(view).queryByText('Launch checklist')).toBeNull()
    expect(within(view).getByText('Budget note')).toBeTruthy()

    fireEvent.click(within(view).getByRole('radio', { name: 'Unread' }))
    expect(within(view).queryByText('Launch checklist')).toBeNull()
    expect(within(view).getByText('Budget note')).toBeTruthy()

    fireEvent.click(within(view).getByRole('radio', { name: 'Recent' }))
    expect(
      within(view)
        .getAllByRole('listitem')
        .map(row => row.textContent)
    ).toEqual([expect.stringContaining('Launch checklist'), expect.stringContaining('Budget note')])
  })

  it('opens, marks read and follows through the existing thread actions', async () => {
    const view = draw()

    fireEvent.click(screen.getByRole('button', { name: /Open thread in launch: Launch checklist/ }))
    await waitFor(() => expect(view.onOpen).toHaveBeenCalledExactlyOnceWith(threads[0]))

    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }))
    await waitFor(() => expect(view.onRead).toHaveBeenCalledExactlyOnceWith(threads[1]))

    fireEvent.click(screen.getByRole('button', { name: 'Follow' }))
    await waitFor(() => expect(view.onFollow).toHaveBeenCalledExactlyOnceWith(threads[0], true))
    const launchRow = screen.getByRole('button', { name: /Open thread in launch/ }).closest('li')!
    expect(within(launchRow).getByRole('button', { name: 'Unfollow' })).toBeTruthy()
  })

  it('rolls back an optimistic follow when the existing action refuses it', async () => {
    draw({ onFollow: vi.fn(async () => Promise.reject(new Error('unavailable'))) })
    fireEvent.click(screen.getByRole('button', { name: 'Follow' }))
    expect(screen.getAllByRole('button', { name: 'Unfollow' })).toHaveLength(2)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Follow' })).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t update this thread')
  })

  it('loads a bounded page at a time and uses Vietnamese copy', () => {
    draw({ locale: 'vi', pageSize: 1 })
    const view = screen.getByRole('region', { name: 'Chuỗi thảo luận' })
    expect(within(view).getAllByRole('listitem')).toHaveLength(1)
    fireEvent.click(within(view).getByRole('button', { name: 'Xem thêm' }))
    expect(within(view).getAllByRole('listitem')).toHaveLength(2)
    expect(within(view).getByRole('radio', { name: 'Đang theo dõi' })).toBeTruthy()
  })

  it('provides the Threads surface in every desktop locale', () => {
    expect(companyThreadsCopy('ja').title).toBe('スレッド')
    expect(companyThreadsCopy('zh').title).toBe('讨论串')
    expect(companyThreadsCopy('zh-Hant').title).toBe('討論串')
  })

  it('disables only the row whose open action is in flight', async () => {
    let release!: () => void
    const onOpen = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    draw({ onOpen })

    const launch = screen.getByRole('button', { name: /Open thread in launch/ })
    const budget = screen.getByRole('button', { name: /Open thread in Linh/ })
    fireEvent.click(launch)

    expect(launch.hasAttribute('disabled')).toBe(true)
    expect(budget.hasAttribute('disabled')).toBe(false)
    expect(within(launch.closest('li')!).getByRole('button', { name: 'Follow' }).hasAttribute('disabled')).toBe(true)
    expect(within(budget.closest('li')!).getByRole('button', { name: 'Mark read' }).hasAttribute('disabled')).toBe(false)

    release()
    await waitFor(() => expect(launch.hasAttribute('disabled')).toBe(false))
  })
})
