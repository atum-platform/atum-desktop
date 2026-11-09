import { describe, expect, it } from 'vitest'

import type { MatrixRoom } from '../../../shared/matrix'
import { matrixRosterBadgeCount } from '../roster-preview'

import { companyBadge, companyUnread } from './company-badge'

const ALPHA = 'company-alpha'
const BETA = 'company-beta'

const channel = (companyId: string, over: Partial<MatrixRoom> = {}): MatrixRoom => ({
  id: `!${Math.random().toString(36).slice(2)}:atum.example`,
  name: 'ops',
  membership: 'join',
  encrypted: false,
  companyChannel: { companyId, channelId: 'channel' },
  ...over
})

/**
 * These vectors are the rule the phone's company sheet mirrors: a mention is a number (99+ past 99), anything
 * else unread is a dot, and the company on screen shows neither.
 */
describe('the one company badge rule', () => {
  it.each([
    { name: 'nothing waiting', counts: { mentions: 0, unread: false }, badge: null },
    { name: 'unread messages only', counts: { mentions: 0, unread: true }, badge: { kind: 'dot', tone: 'activity' } },
    { name: 'one mention', counts: { mentions: 1, unread: false }, badge: { kind: 'mention', count: 1 } },
    { name: 'mentions win over unread', counts: { mentions: 3, unread: true }, badge: { kind: 'mention', count: 3 } },
    { name: 'a hundred mentions', counts: { mentions: 100, unread: true }, badge: { kind: 'mention', count: 100 } }
  ])('$name', ({ badge, counts }) => {
    expect(companyBadge(counts)).toEqual(badge)
  })

  it('prints a mention count as a number up to 99 and as 99+ beyond it', () => {
    expect(matrixRosterBadgeCount(1)).toBe('1')
    expect(matrixRosterBadgeCount(99)).toBe('99')
    expect(matrixRosterBadgeCount(100)).toBe('99+')
    expect(matrixRosterBadgeCount(4_000)).toBe('99+')
  })

  it('shows neither a mention nor a dot on the company that is on screen', () => {
    expect(companyBadge({ mentions: 5, unread: true }, true)).toBeNull()
    expect(companyBadge({ mentions: 0, unread: true }, true)).toBeNull()
  })
})

describe('what a company adds up to', () => {
  it('sums mentions across its joined channels and ignores every other company, room and membership', () => {
    const rooms = [
      channel(ALPHA, { highlights: 2 }),
      channel(ALPHA, { highlights: 3 }),
      channel(BETA, { highlights: 40, unread: true }),
      channel(ALPHA, { highlights: 9, membership: 'invite' }),
      { id: '!dm:atum.example', name: 'dm', membership: 'join', encrypted: true, highlights: 8, unread: true }
    ] satisfies MatrixRoom[]

    expect(companyUnread(rooms, ALPHA)).toEqual({ mentions: 5, unread: false })
    expect(companyUnread(rooms, BETA)).toEqual({ mentions: 40, unread: true })
    expect(companyUnread(rooms, 'nobody')).toEqual({ mentions: 0, unread: false })
  })

  it.each([
    { name: 'unread messages', over: { unread: true } },
    { name: 'a notification count', over: { unreadNotifications: 4 } },
    { name: 'a channel marked unread', over: { markedUnread: true } }
  ])('reads $name as unread', ({ over }) => {
    expect(companyUnread([channel(ALPHA, over)], ALPHA)).toEqual({ mentions: 0, unread: true })
  })

  it('counts only the mentions of a muted channel: its ordinary messages are quiet', () => {
    const muted = channel(ALPHA, { muted: true, unread: true, unreadNotifications: 6, highlights: 1 })

    expect(companyUnread([muted], ALPHA)).toEqual({ mentions: 1, unread: false })
    expect(companyBadge(companyUnread([muted], ALPHA))).toEqual({ kind: 'mention', count: 1 })
    expect(companyBadge(companyUnread([channel(ALPHA, { muted: true, unread: true })], ALPHA))).toBeNull()
  })

  it('surfaces a board assignment delivery through the existing company attention badge', () => {
    const assignmentDelivery = channel(ALPHA, { highlights: 1, unread: true, unreadNotifications: 1 })

    expect(companyBadge(companyUnread([assignmentDelivery], ALPHA))).toEqual({ kind: 'mention', count: 1 })
    expect(companyBadge(companyUnread([assignmentDelivery], ALPHA), true)).toBeNull()
  })

  it('never lets a negative count subtract from another channel', () => {
    expect(companyUnread([channel(ALPHA, { highlights: -4 }), channel(ALPHA, { highlights: 2 })], ALPHA).mentions).toBe(2)
  })
})
