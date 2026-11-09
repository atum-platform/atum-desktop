import { expect, it } from 'vitest'

import type { ConversationCandidateRead } from '../../../shared/agent-conversation/view'

import { conversationRemovalAllowed } from './removal'

it('preserves legacy removal but protects the main and unswept strays after owner migration', () => {
  const rooms: ConversationCandidateRead[] = ['!a:test', '!b:test', '!c:test'].map(roomId => ({
    roomId,
    read: 'readable',
    writable: true
  }))
  for (const room of rooms) {
    expect(conversationRemovalAllowed(rooms, room.roomId)).toBe(true)
  }
  rooms[0].marker = { role: 'main', main: rooms[0].roomId, at: 1 }
  rooms[1].marker = { role: 'earlier', main: rooms[0].roomId, at: 1 }
  expect(conversationRemovalAllowed(rooms, rooms[0].roomId)).toBe(false)
  expect(conversationRemovalAllowed(rooms, rooms[1].roomId)).toBe(true)
  expect(conversationRemovalAllowed(rooms, rooms[2].roomId)).toBe(false)
})

it('refuses removal from incomplete reads or an unknown room', () => {
  const rooms: ConversationCandidateRead[] = [
    { roomId: '!a:test', read: 'readable', writable: true },
    { roomId: '!b:test', read: 'transient', writable: false }
  ]
  expect(conversationRemovalAllowed(rooms, rooms[0].roomId)).toBe(false)
  expect(conversationRemovalAllowed(rooms, '!unknown:test')).toBe(false)
})
