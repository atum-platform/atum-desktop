import { expect, it, vi } from 'vitest'

import type { MatrixMessage } from '../../shared/matrix'

import {
  $matrixHistoryReveal,
  clearExactMatrixHistoryReveal,
  clearMatrixHistoryReveal,
  companyHistoryRevealProjected,
  findHistoryMessage,
  historyMessageText,
  revealMatrixHistoryMessage,
  searchOlderMatrixHistory
} from './history-search'
import { MATRIX_TIMELINE_EVENT_BOUND } from './timeline-history'

function message(index: number, body = `Message ${index}`): MatrixMessage {
  return {
    id: `$message-${index}`,
    sender: '@person:test',
    body,
    timestamp: index,
    own: index % 2 === 0,
    encrypted: true,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false
  }
}

it('finds a word available only in message 20 of a 600-event timeline', async () => {
  const all = Array.from({ length: 600 }, (_, index) =>
    message(index + 1, index === 19 ? 'The hidden orchid' : undefined)
  )
  let first = 400
  let shown = all.slice(first)
  const progress = vi.fn()
  const loadPage = vi.fn(async () => {
    first = Math.max(0, first - 50)
    shown = all.slice(first)

    return { loaded: 50, visible: shown.length, hasMore: first > 0, capped: false }
  })

  const result = await searchOlderMatrixHistory({
    query: 'ORCHID',
    messages: () => shown,
    loadPage,
    progress
  })

  expect(result).toEqual({
    phase: 'found',
    pages: 8,
    searched: 600,
    bound: MATRIX_TIMELINE_EVENT_BOUND,
    eventId: '$message-20'
  })
  expect(loadPage).toHaveBeenCalledTimes(8)
  expect(progress).toHaveBeenLastCalledWith(result)
})

it('never crosses the requested or product page bound', async () => {
  const shown: MatrixMessage[] = Array.from({ length: 200 }, (_, index) => message(index))
  const loadPage = vi.fn(async () => ({ loaded: 50, visible: shown.length, hasMore: true, capped: false }))

  const result = await searchOlderMatrixHistory({
    query: 'absent',
    messages: () => shown,
    loadPage,
    maxPages: 3
  })

  expect(result.phase).toBe('capped')
  expect(result.pages).toBe(3)
  expect(loadPage).toHaveBeenCalledTimes(3)
})

it('matches the words Markdown shows, not formatting marks or link destinations', () => {
  const formatted = message(1, 'Meet in **Đà Lạt** near [the lake](https://secret.example/orchid).')

  expect(historyMessageText(formatted.body)).toBe('Meet in Đà Lạt near the lake.')
  expect(findHistoryMessage([formatted], 'da lat')?.id).toBe(formatted.id)
  expect(findHistoryMessage([formatted], 'orchid')).toBeUndefined()
})

it('keeps a company deep link when the closed in-chat search clears only its own reveal', () => {
  revealMatrixHistoryMessage('!company:test', '$event', 'company', '$root', 'account-a')
  clearMatrixHistoryReveal('!company:test')
  expect($matrixHistoryReveal.get()).toEqual({
    roomId: '!company:test', eventId: '$event', owner: 'company', threadRootId: '$root', accountKey: 'account-a'
  })
  clearMatrixHistoryReveal('!company:test', 'company')
  expect($matrixHistoryReveal.get()).toBeNull()
})

it('projects a company result only in its matching channel or thread transcript', () => {
  const root = message(1, 'Thread root')
  const reply = message(2, 'Thread reply')
  const thread = {
    root,
    replies: [reply],
    participantIds: [reply.sender],
    replyCount: 1,
    lastActivityAt: reply.timestamp,
    unread: false,
    highlights: 0,
    followed: false
  }

  expect(companyHistoryRevealProjected({ roomId: '!room:test', eventId: root.id }, [root], [thread])).toBe(true)
  expect(companyHistoryRevealProjected({ roomId: '!room:test', eventId: reply.id }, [root], [thread])).toBe(false)
  expect(companyHistoryRevealProjected({
    roomId: '!room:test', eventId: reply.id, owner: 'company', threadRootId: root.id
  }, [root], [thread])).toBe(true)
  expect(companyHistoryRevealProjected({
    roomId: '!room:test', eventId: reply.id, owner: 'company', threadRootId: '$other'
  }, [root], [thread])).toBe(false)
})

it('does not let an older async reveal clear a newer company result', () => {
  revealMatrixHistoryMessage('!company:test', '$old', 'company', undefined, 'account-a')
  const old = $matrixHistoryReveal.get()!
  revealMatrixHistoryMessage('!company:test', '$new', 'company', undefined, 'account-a')

  clearExactMatrixHistoryReveal(old)
  expect($matrixHistoryReveal.get()?.eventId).toBe('$new')
  clearMatrixHistoryReveal('!company:test', 'company')
})
