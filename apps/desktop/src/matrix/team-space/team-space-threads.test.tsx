import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { MatrixCompanyThread, MatrixMessage } from '../../../shared/matrix'

import {
  CHANNEL_IDS,
  channelRoom,
  COMPANY_ID,
  CONVERSATION_IDS,
  conversationRoom,
  platform,
  renderTeamSpace,
  rerenderTeamSpace,
  resetTeamSpace,
  TestResizeObserver
} from './test-support'

beforeAll(() => vi.stubGlobal('ResizeObserver', TestResizeObserver))

afterEach(() => {
  cleanup()
  resetTeamSpace()
})

function root(id: string, body: string): MatrixMessage {
  return {
    id,
    sender: '@linh:test',
    body,
    timestamp: 10,
    own: false,
    encrypted: true,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false
  }
}

function thread(
  roomId: string,
  id: string,
  body: string,
  over: Partial<MatrixCompanyThread> = {}
): MatrixCompanyThread {
  return {
    companyId: COMPANY_ID,
    roomId,
    root: root(id, body),
    replies: [],
    participantIds: [],
    replyCount: 2,
    lastActivityAt: 20,
    unread: false,
    highlights: 0,
    followed: false,
    ...over
  }
}

describe('Team Space company Threads inbox', () => {
  it('opens from its own sidebar row (Slack, Mattermost), covers channels and company DMs, and routes existing actions', async () => {
    const source = platform({
      conversationsOn: true,
      conversations: [{ id: CONVERSATION_IDS.dm, others: ['admin'] }]
    })

    const channel = channelRoom(CHANNEL_IDS.general, 'general')
    const dm = conversationRoom(CONVERSATION_IDS.dm)
    const launch = thread(channel.id, '$launch', 'Launch checklist', { highlights: 2 })
    const budget = thread(dm.id, '$budget', 'Budget note', { followed: true, unread: true, lastActivityAt: 30 })

    const restricted = thread('!restricted:atum.example', '$restricted', 'Restricted roadmap', {
      unread: true,
      lastActivityAt: 40
    })

    const onFollowCompanyThread = vi.fn(async () => {})
    const onOpenCompanyThread = vi.fn(async () => {})
    const onReadCompanyThread = vi.fn(async () => {})

    renderTeamSpace(source, {
      onFollowCompanyThread,
      onOpenCompanyThread,
      onReadCompanyThread,
      rooms: [channel, dm],
      threads: [restricted, budget, launch]
    })

    const entry = await screen.findByRole('button', { name: 'Threads' })
    expect(within(entry).getByLabelText('Mentions you: 2')).toBeTruthy()

    fireEvent.click(entry)
    const view = await screen.findByRole('region', { name: 'Threads' })
    expect(within(view).getByText('Launch checklist')).toBeTruthy()
    expect(within(view).getByText('Budget note')).toBeTruthy()
    expect(within(view).getByText('Bảo')).toBeTruthy()
    expect(within(view).queryByText('Restricted roadmap')).toBeNull()

    fireEvent.click(within(view).getByRole('button', { name: 'Mark read' }))
    await waitFor(() => expect(onReadCompanyThread).toHaveBeenCalledExactlyOnceWith(budget, expect.any(Function)))

    fireEvent.click(within(view).getByRole('button', { name: 'Follow' }))
    await waitFor(() => expect(onFollowCompanyThread).toHaveBeenCalledExactlyOnceWith(
      launch,
      true,
      expect.any(Function)
    ))

    fireEvent.click(within(view).getByRole('button', { name: /Open thread in Bảo: Budget note/ }))
    await waitFor(() =>
      expect(onOpenCompanyThread).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ roomId: budget.roomId, root: expect.objectContaining({ id: '$budget' }) }),
        expect.any(Function)
      )
    )
  })

  it('does not open a detached row after its room leaves the live authorized directory', async () => {
    const source = platform()
    const channel = channelRoom(CHANNEL_IDS.general, 'general')
    const launch = thread(channel.id, '$launch', 'Launch checklist')
    const onOpenCompanyThread = vi.fn(async () => {})
    const view = renderTeamSpace(source, { onOpenCompanyThread, rooms: [channel], threads: [launch] })

    fireEvent.click(await screen.findByRole('button', { name: 'Threads' }))
    const staleOpen = await screen.findByRole('button', { name: /Open thread in general: Launch checklist/ })

    rerenderTeamSpace(view, source, { onOpenCompanyThread, rooms: [], threads: [launch] })
    await waitFor(() => expect(screen.queryByText('Launch checklist')).toBeNull())
    fireEvent.click(staleOpen)

    expect(onOpenCompanyThread).not.toHaveBeenCalled()
  })

  it('does not mark or follow a detached target after the company selection changes', async () => {
    const source = platform({
      companies: [
        { id: COMPANY_ID, displayName: 'Atum Studio' },
        { id: '00000000-0000-4000-8000-4ddf7748f9cd', displayName: 'Beta Works' }
      ]
    })
    const channel = channelRoom(CHANNEL_IDS.general, 'general')
    const launch = thread(channel.id, '$launch', 'Launch checklist', { unread: true })
    const onFollowCompanyThread = vi.fn(async () => {})
    const onReadCompanyThread = vi.fn(async () => {})

    const view = renderTeamSpace(source, {
      onFollowCompanyThread, onReadCompanyThread, rooms: [channel], threads: [launch]
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Threads' }))
    const staleRead = await screen.findByRole('button', { name: 'Mark read' })
    const staleFollow = screen.getByRole('button', { name: 'Follow' })

    fireEvent.keyDown(view.container.querySelector('[data-matrix-company-menu-trigger]')!, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^Beta Works · /u }))
    await waitFor(() =>
      expect(view.container.querySelector('[data-matrix-company-title] h1')?.textContent).toBe('Beta Works'))

    fireEvent.click(staleRead)
    fireEvent.click(staleFollow)

    expect(onReadCompanyThread).not.toHaveBeenCalled()
    expect(onFollowCompanyThread).not.toHaveBeenCalled()
  })
})
