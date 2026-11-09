import { describe, expect, it } from 'vitest'

import type { MatrixRoom } from '../../shared/matrix'

import {
  companyPaletteChannels,
  companyRoomBadge,
  companyRoomsBadge,
  isCompanyRoom,
  neighbouringCompanyChannel
} from './company-chrome'

function room(id: string, patch: Partial<MatrixRoom> = {}): MatrixRoom {
  return {
    id,
    name: id,
    membership: 'join',
    encrypted: false,
    companyChannel: { companyId: 'c1', channelId: `ch-${id}` },
    ...patch
  }
}

describe('company chrome helpers', () => {
  it('knows a company room only by its authority-projected binding', () => {
    expect(isCompanyRoom(room('a'))).toBe(true)
    expect(isCompanyRoom({ companyChannel: undefined })).toBe(false)
    expect(isCompanyRoom(undefined)).toBe(false)
  })

  it('badges a channel by the personal roster rules: mention over count over quiet', () => {
    expect(companyRoomBadge(room('a'))).toBeNull()
    expect(companyRoomBadge(room('a', { unreadNotifications: 3 }))).toEqual({ kind: 'count', count: 3 })
    expect(companyRoomBadge(room('a', { unreadNotifications: 3, highlights: 1 }))).toEqual({ kind: 'mention', count: 3 })
    expect(companyRoomBadge(room('a', { unread: true }))).toEqual({ kind: 'dot', tone: 'activity' })
    expect(companyRoomBadge(room('a', { muted: true, unreadNotifications: 4 }))).toEqual({ kind: 'dot', tone: 'activity' })
  })

  it('sums a company, ignores other companies, personal rooms and rooms not joined', () => {
    const rooms = [
      room('a', { unreadNotifications: 2 }),
      room('b', { unreadNotifications: 1, highlights: 1 }),
      room('c', { unreadNotifications: 9, companyChannel: { companyId: 'c2', channelId: 'x' } }),
      room('d', { unreadNotifications: 5, membership: 'leave' }),
      { id: 'p', name: 'p', membership: 'join', encrypted: false, unreadNotifications: 7 } satisfies MatrixRoom
    ]

    expect(companyRoomsBadge(rooms, 'c1')).toEqual({ kind: 'mention', count: 3 })
    expect(companyRoomsBadge(rooms, 'c2')).toEqual({ kind: 'count', count: 9 })
    expect(companyRoomsBadge(rooms)).toEqual({ kind: 'mention', count: 12 })
    expect(companyRoomsBadge([rooms[4]!], 'c1')).toBeNull()
  })

  it('walks channels in sidebar order with wrapping, and skips read ones for next-unread', () => {
    const rooms = [room('a'), room('b', { unreadNotifications: 1 }), room('c'), room('d', { unread: true })]
    const order = ['a', 'b', 'c', 'd']

    expect(neighbouringCompanyChannel(order, rooms, 'a', 1)).toBe('b')
    expect(neighbouringCompanyChannel(order, rooms, 'a', -1)).toBe('d')
    expect(neighbouringCompanyChannel(order, rooms, 'd', 1)).toBe('a')
    expect(neighbouringCompanyChannel(order, rooms, 'a', 1, true)).toBe('b')
    expect(neighbouringCompanyChannel(order, rooms, 'b', 1, true)).toBe('d')
    expect(neighbouringCompanyChannel(order, rooms, 'd', 1, true)).toBe('b')
    expect(neighbouringCompanyChannel(order, rooms, 'a', -1, true)).toBe('d')
    expect(neighbouringCompanyChannel(order, [room('a'), room('b')], 'a', 1, true)).toBeUndefined()
    expect(neighbouringCompanyChannel(order, rooms, null, 1)).toBe('a')
    expect(neighbouringCompanyChannel(order, rooms, null, -1)).toBe('d')
    expect(neighbouringCompanyChannel([], rooms, 'a', 1)).toBeUndefined()
  })
})

describe('palette channels are scoped to the active company', () => {
  const rooms = [
    room('!a1:test', { companyChannel: { companyId: 'c1', channelId: 'a1' } }),
    room('!a2:test', { companyChannel: { companyId: 'c1', channelId: 'a2' } }),
    room('!b1:test', { companyChannel: { companyId: 'c2', channelId: 'b1' } }),
    room('!b-left:test', { companyChannel: { companyId: 'c2', channelId: 'b2' }, membership: 'leave' })
  ]

  it('offers only the selected company’s listed channels, and changes with the company', () => {
    const ids = (companyId: string | undefined, order: string[]) =>
      companyPaletteChannels(rooms, companyId, order).map(value => value.id)

    expect(ids('c1', ['!a1:test', '!a2:test'])).toEqual(['!a1:test', '!a2:test'])
    expect(ids('c2', ['!b1:test', '!b-left:test'])).toEqual(['!b1:test'])
    // The directory is the authority: a joined room it does not list is not offered.
    expect(ids('c1', ['!a1:test'])).toEqual(['!a1:test'])
    // Another company's directory never lets this company's rooms in, and vice versa.
    expect(ids('c1', ['!b1:test'])).toEqual([])
    expect(ids(undefined, ['!a1:test', '!b1:test'])).toEqual([])
  })
})
