import { EventType, MatrixEvent, RelationType, type Room } from 'matrix-js-sdk'
import { describe, expect, it } from 'vitest'

import { matrixEventAttentionKind } from './attention'

const SELF = '@alice:test'

function event(id: string, sender: string, content: Record<string, unknown>) {
  return new MatrixEvent({
    event_id: id,
    room_id: '!launch:test',
    type: EventType.RoomMessage,
    sender,
    content
  })
}

describe('shared Activity/notification attention classification', () => {
  it('classifies direct mentions, authorized @channel and replies to threads the viewer started', () => {
    const root = event('$root', SELF, { msgtype: 'm.text', body: 'Budget' })
    const reply = event('$reply', '@linh:test', {
      msgtype: 'm.text',
      body: 'Updated',
      'm.relates_to': { rel_type: RelationType.Thread, event_id: '$root' }
    })
    const direct = event('$direct', '@linh:test', {
      msgtype: 'm.text', body: 'Alice', 'm.mentions': { user_ids: [SELF] }
    })
    const channel = event('$channel', '@admin:test', {
      msgtype: 'm.text', body: 'Everyone', 'm.mentions': { room: true }
    })
    const thread = { rootEvent: root, events: [reply], hasCurrentUserParticipated: false }
    const room = {
      getMyMembership: () => 'join',
      findEventById: (id: string) => id === '$root' ? root : undefined,
      getThread: (id: string) => id === '$root' ? thread : null,
      getMember: (id: string) => ({ powerLevel: id === '@admin:test' ? 50 : 0 }),
      currentState: {
        getStateEvents: () => new MatrixEvent({
          type: EventType.RoomPowerLevels,
          state_key: '',
          content: { notifications: { room: 50 } }
        })
      }
    } as unknown as Room

    expect(matrixEventAttentionKind(direct, room, SELF)).toBe('mention')
    expect(matrixEventAttentionKind(channel, room, SELF)).toBe('mention')
    expect(matrixEventAttentionKind(reply, room, SELF)).toBe('thread_reply')
  })

  it('rejects unauthorized @channel and replies to threads the viewer did not join', () => {
    const root = event('$root', '@linh:test', { msgtype: 'm.text', body: 'Budget' })
    const reply = event('$reply', '@minh:test', {
      msgtype: 'm.text',
      body: 'Updated',
      'm.relates_to': { rel_type: RelationType.Thread, event_id: '$root' }
    })
    const channel = event('$channel', '@linh:test', {
      msgtype: 'm.text', body: 'Everyone', 'm.mentions': { room: true }
    })
    const room = {
      getMyMembership: () => 'join',
      findEventById: () => root,
      getThread: () => ({ rootEvent: root, events: [reply], hasCurrentUserParticipated: false }),
      getMember: () => ({ powerLevel: 0 }),
      currentState: {
        getStateEvents: () => new MatrixEvent({
          type: EventType.RoomPowerLevels,
          state_key: '',
          content: { notifications: { room: 50 } }
        })
      }
    } as unknown as Room

    expect(matrixEventAttentionKind(channel, room, SELF)).toBeUndefined()
    expect(matrixEventAttentionKind(reply, room, SELF)).toBeUndefined()
  })
})
