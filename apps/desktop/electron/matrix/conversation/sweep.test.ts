import { expect, it } from 'vitest'

import { resolveConversationRoom } from '../../../shared/agent-conversation'
import type { ConversationMarker } from '../../../shared/agent-conversation/types'
import { CONVERSATION_PLAIN_FLOOR } from '../../../shared/agent-conversation/version'

import { conversationMacFleetReady } from './app-version'
import { conversationSweepWrites } from './sweep'

it('two Macs converge raced/stray rooms with only Earlier writes and stop once pointers match', () => {
  const markers = new Map<string, ConversationMarker | null>([
    ['!a:test', { role: 'main', main: '!a:test', at: 1 }],
    ['!b:test', { role: 'main', main: '!b:test', at: 2 }],
    ['!c:test', null]
  ])
  const resolution = resolveConversationRoom(
    [...markers].map(([roomId, marker]) => ({ roomId, marker, read: 'readable' }))
  )
  const a = conversationSweepWrites({ resolution, markers, transient: false, at: 3 })
  const b = conversationSweepWrites({ resolution, markers, transient: false, at: 4 })
  expect(a.map(write => write.roomId)).toEqual(b.map(write => write.roomId))
  expect(a.every(write => write.content.role === 'earlier')).toBe(true)
  for (const write of b) {
    markers.set(write.roomId, write.content as ConversationMarker)
  }
  expect(conversationSweepWrites({ resolution, markers, transient: false, at: 5 })).toEqual([])
  expect(conversationSweepWrites({ resolution, markers, transient: true, at: 5 })).toEqual([])
  expect(
    conversationSweepWrites({ resolution: resolveConversationRoom([]), markers, transient: false, at: 5 })
  ).toEqual([])
})

it('a missing Mac is old even when every reported Mac is current; empty enumeration is unknown', () => {
  const reports = new Map([['one', { v: 1, version: '0.19.0', at: 1 }]])
  expect(conversationMacFleetReady(['one'], reports)).toBe(true)
  expect(conversationMacFleetReady(['one', 'two'], reports)).toBe(false)
  expect(conversationMacFleetReady([], reports)).toBe(false)
  expect(conversationMacFleetReady(undefined, reports)).toBe(false)
})

it('the plain-room move needs every Mac, offline ones included, on 0.20', () => {
  const reports = new Map([
    ['mini', { v: 1, version: '0.20.0', at: 1 }],
    ['book', { v: 1, version: '0.19.3', at: 1 }]
  ])

  expect(conversationMacFleetReady(['mini', 'book'], reports)).toBe(true)
  expect(conversationMacFleetReady(['mini', 'book'], reports, CONVERSATION_PLAIN_FLOOR)).toBe(false)
  expect(conversationMacFleetReady(['mini'], reports, CONVERSATION_PLAIN_FLOOR)).toBe(true)
  // A Mac with no report yet (never launched 0.20) holds the move too.
  expect(conversationMacFleetReady(['mini', 'new'], reports, CONVERSATION_PLAIN_FLOOR)).toBe(false)
  reports.set('book', { v: 1, version: '0.21.4', at: 2 })
  expect(conversationMacFleetReady(['mini', 'book'], reports, CONVERSATION_PLAIN_FLOOR)).toBe(true)
})
