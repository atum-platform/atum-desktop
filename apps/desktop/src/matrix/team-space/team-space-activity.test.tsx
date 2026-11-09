import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { MatrixCompanyActivityItem } from '../../../shared/matrix-company-activity'
import { companyAIStatusText } from '../../../shared/matrix-company-ai-status'
import type { CompanyAIView } from '../company-desktop-adapter'
import { $companyAIStatuses, companySpaceScope } from '../company-space-store'

import {
  channelRoom,
  COMPANY_ID,
  platform,
  renderTeamSpace,
  resetTeamSpace,
  TestResizeObserver
} from './test-support'

beforeAll(() => vi.stubGlobal('ResizeObserver', TestResizeObserver))

afterEach(() => {
  cleanup()
  resetTeamSpace()
  $companyAIStatuses.set({})
})

const mention: MatrixCompanyActivityItem = {
  companyId: COMPANY_ID,
  roomId: '!general:atum.example',
  eventId: '$mention',
  kind: 'mention',
  body: 'Can you review the launch note?',
  senderId: '@linh:test',
  senderName: 'Linh',
  sentAt: Date.UTC(2026, 9, 30, 3),
  unread: true
}

const reply: MatrixCompanyActivityItem = {
  companyId: COMPANY_ID,
  roomId: '!general:atum.example',
  eventId: '$reply',
  kind: 'thread_reply',
  body: 'The final numbers are ready.',
  senderId: '@minh:test',
  senderName: 'Minh',
  sentAt: Date.UTC(2026, 9, 30, 2),
  unread: true,
  threadRootId: '$root'
}

describe('Team Space Activity inbox', () => {
  it('opens from the sidebar, counts only authorized rooms and preserves thread context', async () => {
    const restricted = { ...mention, roomId: '!restricted:atum.example', eventId: '$restricted', body: 'Hidden' }
    const onOpenActivityItem = vi.fn(async () => {})

    renderTeamSpace(platform(), {
      activity: [restricted, mention, reply],
      onOpenActivityItem,
      rooms: [channelRoom('00000000-0000-4000-8000-576f18824476', 'general')]
    })

    const entry = await screen.findByRole('button', { name: 'Activity' })
    // The strong badge counts mentions only; unread thread replies do not inflate that label.
    expect(within(entry).getByLabelText('Mentions you: 1')).toBeTruthy()
    fireEvent.click(entry)

    const view = await screen.findByRole('region', { name: 'Activity' })
    expect(within(view).getByText('Can you review the launch note?')).toBeTruthy()
    expect(within(view).getByText('The final numbers are ready.')).toBeTruthy()
    expect(within(view).queryByText('Hidden')).toBeNull()

    fireEvent.click(within(view).getByRole('button', { name: /Can you review the launch note/ }))
    await waitFor(() => expect(onOpenActivityItem).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: '$mention' }),
      expect.any(Function)
    ))

    fireEvent.click(entry)
    const reopened = await screen.findByRole('region', { name: 'Activity' })
    fireEvent.click(within(reopened).getByRole('button', { name: /The final numbers are ready/ }))
    await waitFor(() => expect(onOpenActivityItem).toHaveBeenLastCalledWith(reply, expect.any(Function)))
  })

  it('leaves out the Chief of Staff’s status-only line, but never a reply that carries an answer', async () => {
    const COS = '@chief-of-staff:atum.example'
    const uncertain = companyAIStatusText('couldnt_confirm')
    $companyAIStatuses.set({
      [companySpaceScope('account-a', COMPANY_ID)]: {
        schemaVersion: 1,
        companyId: COMPANY_ID,
        agent: { principal: '00000000-0000-4000-8000-9896148e0625', userId: COS, displayName: 'Chief of Staff' },
        enabled: true,
        revision: 1,
        state: 'ready',
        canManage: true
      } as CompanyAIView
    })

    const statusOnly = { ...reply, eventId: '$status', senderId: COS, senderName: 'Chief of Staff', body: uncertain }
    const answered = { ...statusOnly, eventId: '$answer', sentAt: reply.sentAt + 1, companyAIAnswer: true as const }
    // The same words outside a thread are not the thread's status reply: they stay.
    const unthreaded = { ...statusOnly, eventId: '$loose', kind: 'mention' as const, threadRootId: undefined, sentAt: reply.sentAt - 1 }

    const onOpenActivityItem = vi.fn(async () => {})

    renderTeamSpace(platform(), {
      activity: [answered, statusOnly, unthreaded, reply],
      onOpenActivityItem,
      rooms: [channelRoom('00000000-0000-4000-8000-576f18824476', 'general')]
    })

    const entry = await screen.findByRole('button', { name: 'Activity' })
    const opened: string[] = []

    for (const index of [0, 1]) {
      fireEvent.click(entry)
      const view = await screen.findByRole('region', { name: 'Activity' })
      expect(within(view).getByText('The final numbers are ready.')).toBeTruthy()
      const rows = within(view).getAllByRole('button', { name: /couldn.t confirm/ })
      expect(rows).toHaveLength(2)
      fireEvent.click(rows[index]!)
      await waitFor(() => expect(onOpenActivityItem).toHaveBeenCalledTimes(index + 1))
      opened.push((onOpenActivityItem.mock.calls[index] as unknown as [MatrixCompanyActivityItem])[0].eventId)
    }

    // The answer and the unthreaded line are the two rows; the status-only thread reply is not there.
    expect(opened.sort()).toEqual(['$answer', '$loose'])
  })

  it('uses the Vietnamese sidebar and view copy', async () => {
    renderTeamSpace(platform(), {
      activity: [mention],
      rooms: [channelRoom('00000000-0000-4000-8000-576f18824476', 'general')]
    }, 'vi')

    fireEvent.click(await screen.findByRole('button', { name: 'Hoạt động' }))
    const view = await screen.findByRole('region', { name: 'Hoạt động' })
    expect(within(view).getByRole('radio', { name: 'Lượt nhắc' })).toBeTruthy()
    expect(within(view).getByText('Đã nhắc đến bạn')).toBeTruthy()
  })

  it('shows an unread thread reply as ordinary activity, not a mention', async () => {
    renderTeamSpace(platform(), {
      activity: [reply],
      rooms: [channelRoom('00000000-0000-4000-8000-576f18824476', 'general')]
    })

    const entry = await screen.findByRole('button', { name: 'Activity' })
    expect(within(entry).getByText('New messages')).toBeTruthy()
    expect(within(entry).queryByText(/Mentions you/u)).toBeNull()
  })

  it('sits beside the company switcher as an icon, not as a sidebar row', async () => {
    renderTeamSpace(platform(), {
      activity: [mention],
      rooms: [channelRoom('00000000-0000-4000-8000-576f18824476', 'general')]
    })

    const entry = await screen.findByRole('button', { name: 'Activity' })
    const header = entry.closest('[data-matrix-company-title]') as HTMLElement
    expect(header).toBeTruthy()
    // Same row as the switcher's trigger, after it.
    const trigger = header.querySelector('[data-matrix-company-menu-trigger]')!
    expect(trigger.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(window.document.querySelector('[data-matrix-company-activity-entry]')).toBeNull()
    expect(entry.closest('[data-team-space-sidebar-row]')).toBeNull()
    expect(entry.getAttribute('aria-describedby')).toBeTruthy()
    expect(entry.getAttribute('aria-pressed')).toBe('false')

    // Keyboard reachable: an ordinary button in the tab order.
    entry.focus()
    expect(window.document.activeElement).toBe(entry)

    fireEvent.click(entry)
    await screen.findByRole('region', { name: 'Activity' })
    expect(entry.getAttribute('aria-pressed')).toBe('true')
  })

  it('stays in place with no activity, without a badge, and opens the empty inbox', async () => {
    renderTeamSpace(platform(), {
      activity: [],
      rooms: [channelRoom('00000000-0000-4000-8000-576f18824476', 'general')]
    })

    const entry = await screen.findByRole('button', { name: 'Activity' })
    expect(entry.getAttribute('aria-describedby')).toBeNull()
    expect(entry.querySelector('[data-roster-unread]')).toBeNull()
    fireEvent.click(entry)
    const view = await screen.findByRole('region', { name: 'Activity' })
    expect(within(view).getByText('No activity yet')).toBeTruthy()
  })
})
