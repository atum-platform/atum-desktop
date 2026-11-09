import { describe, expect, it } from 'vitest'

import type { MatrixRoom } from '../../shared/matrix'

import { matrixRosterCopy } from './roster-copy'
import {
  matrixAgentConversationRoom,
  matrixAgentCounts,
  matrixRoomCounts,
  matrixRoomHasUnread,
  matrixRosterBadge,
  matrixRosterBadgeCount,
  matrixRosterPreview
} from './roster-preview'

const room = (extra: Partial<MatrixRoom> = {}): MatrixRoom => ({
  id: '!room:test',
  name: 'Room',
  membership: 'join',
  encrypted: true,
  ...extra
})

const en = matrixRosterCopy('en')

describe('the chat list badge (Element’s rules)', () => {
  it('ranks a mention over a count, a count over a mark, and a mark over quiet activity', () => {
    const badge = (extra: Partial<MatrixRoom>) => matrixRosterBadge(matrixRoomCounts(room(extra)))

    // A mention is the strong badge and carries the whole count.
    expect(badge({ unreadNotifications: 4, highlights: 1, markedUnread: true, unread: true })).toEqual({
      kind: 'mention',
      count: 4
    })
    expect(badge({ unreadNotifications: 2, markedUnread: true, unread: true })).toEqual({ kind: 'count', count: 2 })
    expect(badge({ markedUnread: true, unread: true })).toEqual({ kind: 'dot', tone: 'marked' })
    expect(badge({ unread: true })).toEqual({ kind: 'dot', tone: 'activity' })
    expect(badge({})).toBeNull()
  })

  it('counts only mentions in a muted chat; its other messages are quiet activity', () => {
    const muted = (extra: Partial<MatrixRoom>) => matrixRosterBadge(matrixRoomCounts(room({ muted: true, ...extra })))

    expect(muted({ unreadNotifications: 6 })).toEqual({ kind: 'dot', tone: 'activity' })
    expect(muted({ unreadNotifications: 6, highlights: 2 })).toEqual({ kind: 'mention', count: 2 })
    expect(muted({ unread: true })).toEqual({ kind: 'dot', tone: 'activity' })
  })

  it('sums an assistant’s chats into one badge, a muted chat adding activity rather than a count', () => {
    const counts = matrixAgentCounts([
      room({ id: '!a', unreadNotifications: 3 }),
      room({ id: '!b', unreadNotifications: 5, muted: true }),
      room({ id: '!c', markedUnread: true })
    ])

    expect(counts).toMatchObject({ notifications: 3, activity: true, marked: true, muted: false })
    expect(matrixRosterBadge(counts)).toEqual({ kind: 'count', count: 3 })
    expect(matrixRosterBadge(matrixAgentCounts([room({ unreadNotifications: 2, muted: true })]))).toEqual({
      kind: 'dot',
      tone: 'activity'
    })
  })

  it('caps a count at 99+', () => {
    expect(matrixRosterBadgeCount(9)).toBe('9')
    expect(matrixRosterBadgeCount(99)).toBe('99')
    expect(matrixRosterBadgeCount(100)).toBe('99+')
  })

  it('treats any badge as waiting for the person', () => {
    expect(matrixRoomHasUnread(room({ unread: true }))).toBe(true)
    expect(matrixRoomHasUnread(room({ markedUnread: true }))).toBe(true)
    expect(matrixRoomHasUnread(room({ unreadNotifications: 0, highlights: 0 }))).toBe(false)
  })
})

describe('the chat list preview line', () => {
  const said = (extra: Partial<MatrixRoom['preview']> & Pick<NonNullable<MatrixRoom['preview']>, 'kind'>) => ({
    own: false,
    at: 1,
    ...extra
  })

  it('names who wrote it only where it helps: you everywhere, others in a group', () => {
    const text = said({ kind: 'text', text: 'See you at 7', sender: 'Lan' })

    expect(matrixRosterPreview(room({ preview: { ...text, own: true, sender: undefined } }), en, 'Message deleted')).toBe(
      'You: See you at 7'
    )
    expect(matrixRosterPreview(room({ preview: text }), en, 'Message deleted')).toBe('Lan: See you at 7')
    expect(matrixRosterPreview(room({ direct: true, preview: text }), en, 'Message deleted')).toBe('See you at 7')
    expect(matrixRosterPreview(room({ assistant: true, preview: text }), en, 'Message deleted')).toBe('See you at 7')
    expect(matrixRosterPreview(room(), en, 'Message deleted')).toBeUndefined()
  })

  it('says what a file, a photo or a deleted message is, in the window’s language', () => {
    const vi = matrixRosterCopy('vi')

    expect(matrixRosterPreview(room({ preview: said({ kind: 'file', text: 'menu.pdf', sender: 'Quân' }) }), vi, 'x')).toBe(
      'Quân: 📎 menu.pdf'
    )
    expect(matrixRosterPreview(room({ direct: true, preview: said({ kind: 'image' }) }), vi, 'x')).toBe('📷 Ảnh')
    expect(matrixRosterPreview(room({ preview: { ...said({ kind: 'image' }), own: true } }), vi, 'x')).toBe('Bạn: 📷 Ảnh')
    // What happened to a message carries no name.
    expect(matrixRosterPreview(room({ preview: said({ kind: 'deleted', sender: 'Lan' }) }), vi, 'Tin nhắn đã bị xóa')).toBe(
      'Tin nhắn đã bị xóa'
    )
    expect(matrixRosterPreview(room({ preview: said({ kind: 'unreadable', sender: 'Lan' }) }), vi, 'x')).toBe(vi.waiting)
    // Chinese writes its own colon.
    expect(
      matrixRosterPreview(room({ preview: { ...said({ kind: 'text', text: '好' }), own: true } }), matrixRosterCopy('zh'), 'x')
    ).toBe('你：好')
  })
})

describe('an assistant’s one conversation', () => {
  const rooms = Array.from({ length: 4 }, (_, index) => room({ id: `!h${index}` }))

  it('is the marked main room, even when another room waits unread', () => {
    const waiting = rooms.map((value, index) => (index === 0 ? { ...value, unreadNotifications: 2 } : value))

    expect(matrixAgentConversationRoom(waiting, '!h2')?.id).toBe('!h2')
  })

  it('without marks, is the room waiting unread, else the newest', () => {
    const waiting = rooms.map((value, index) => (index === 3 ? { ...value, markedUnread: true } : value))

    expect(matrixAgentConversationRoom(waiting, undefined)?.id).toBe('!h3')
    expect(matrixAgentConversationRoom(rooms, undefined)?.id).toBe('!h0')
    expect(matrixAgentConversationRoom([], undefined)).toBeUndefined()
  })
})
