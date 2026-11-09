import { afterEach, expect, it } from 'vitest'

import type { MatrixRoom } from '../../shared/matrix'

import { roomSelection, sortConversations } from './room-navigation'

afterEach(() => localStorage.clear())

it('extends the same account/device pointer without a second navigation store or any launch', () => {
  const selection = roomSelection(localStorage, '@alice:test', 'ONE')
  selection.write('!legacy:test')
  expect(selection.readDestination()).toEqual({ kind: 'room', roomId: '!legacy:test' })
  const app = { kind: 'app' as const, appId: '00000000-0000-4000-8000-bd7662a5eeb4' }
  selection.writeDestination(app)
  expect(selection.readDestination()).toEqual(app)
  selection.writeDestination({ kind: 'app', appId: '00000000-0000-4000-8000-5619996CCF0D' })
  expect(selection.readDestination()).toEqual({ kind: 'app', appId: '00000000-0000-4000-8000-5619996ccf0d' })
  expect(localStorage.length).toBe(1)
  expect(roomSelection(localStorage, '@other:test', 'ONE').readDestination()).toBeNull()
  selection.writeDestination({ kind: 'discover' })
  expect(selection.readDestination()).toEqual({ kind: 'discover' })
  selection.write('!next:test')
  expect(selection.readDestination()).toEqual({ kind: 'room', roomId: '!next:test' })
})

it('orders standard favourites before assistant history and recent chats without mutating SDK data', () => {
  const room = (id: string, extra: Partial<MatrixRoom> = {}): MatrixRoom => ({
    id,
    name: id,
    encrypted: true,
    membership: 'join',
    ...extra
  })

  const rooms = [
    room('!old', { lastActiveAt: 1 }),
    room('!recent', { lastActiveAt: 5 }),
    room('!assistant', { assistant: true }),
    room('!unordered', { favourite: true, lastActiveAt: 10 }),
    room('!second', { favourite: true, favouriteOrder: 0.9 }),
    room('!first', { favourite: true, favouriteOrder: 0.1 })
  ]

  expect(sortConversations(rooms).map(room => room.id)).toEqual([
    '!first',
    '!second',
    '!unordered',
    '!assistant',
    '!recent',
    '!old'
  ])
  expect(rooms[0].id).toBe('!old')
  expect(sortConversations([room('!b'), room('!a')]).map(room => room.id)).toEqual(['!a', '!b'])
})

it('stores only a room pointer isolated by Matrix user and device', () => {
  const alice = roomSelection(localStorage, '@alice:test', 'ONE')
  alice.write('!private:test')
  expect(roomSelection(localStorage, '@alice:test', 'ONE').read()).toBe('!private:test')
  expect(roomSelection(localStorage, '@bob:test', 'ONE').read()).toBeNull()
  expect(roomSelection(localStorage, '@alice:test', 'TWO').read()).toBeNull()
  alice.write(null)
  expect(alice.read()).toBeNull()
  expect(localStorage.length).toBe(0)
})

it('invalid or unavailable local storage cannot block navigation', () => {
  for (const value of ['untrusted', '!'.repeat(1025), null]) {
    expect(roomSelection({ getItem: () => value, setItem() {}, removeItem() {} }, 'a', 'd').read()).toBeNull()
  }

  const unavailable = () => {
    throw new Error('storage unavailable')
  }

  const selection = roomSelection({ getItem: unavailable, setItem: unavailable, removeItem: unavailable }, 'a', 'd')
  expect(selection.read()).toBeNull()
  expect(() => selection.write('!r:test')).not.toThrow()
  expect(() => selection.write(null)).not.toThrow()
})
