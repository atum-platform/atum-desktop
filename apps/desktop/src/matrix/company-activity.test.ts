import { EventType, MatrixEvent, RelationType, type Room } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'

import type { MatrixMessage, MatrixRoom } from '../../shared/matrix'

import {
  aggregateMatrixCompanyActivity,
  MATRIX_COMPANY_ACTIVITY_MAX,
  matrixCompanyActivity,
  type MatrixCompanyActivitySourceMessage,
  type MatrixCompanyActivitySourceRoom
} from './company-activity'

const SELF = '@me:test'

function event(id: string, sender: string, content: Record<string, unknown>, timestamp: number): MatrixEvent {
  return new MatrixEvent({
    type: EventType.RoomMessage,
    room_id: '!room:test',
    event_id: id,
    sender,
    origin_server_ts: timestamp,
    content
  })
}

function message(id: string, extra: Partial<MatrixMessage> = {}): MatrixMessage {
  return {
    id,
    sender: '@linh:test',
    body: id,
    timestamp: Number(id.replace(/\D/gu, '')) || 1,
    own: false,
    encrypted: true,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false,
    ...extra
  }
}

function source(value: MatrixMessage, extra: Partial<MatrixCompanyActivitySourceMessage> = {}) {
  return { message: value, unread: true, threadParticipated: false, ...extra }
}

function room(messages: MatrixCompanyActivitySourceMessage[], extra: Partial<MatrixCompanyActivitySourceRoom> = {}) {
  return { companyId: 'company-1', membership: 'join', roomId: '!room:test', messages, ...extra }
}

describe('Team Space company activity aggregation', () => {
  it('keeps direct and room mentions, but not unrelated messages', () => {
    const result = aggregateMatrixCompanyActivity([
      room([
        source(message('$1', { mentions: { userIds: [SELF], room: false } })),
        source(message('$2', { mentions: { userIds: [], room: true } })),
        source(message('$3'))
      ])
    ], SELF)

    expect(result.map(item => [item.eventId, item.kind])).toEqual([
      ['$2', 'mention'],
      ['$1', 'mention']
    ])
  })

  it('includes replies only when the viewer takes part in that thread and lets mentions win', () => {
    const result = aggregateMatrixCompanyActivity([
      room([
        source(message('$11', { thread: true, threadRootId: '$root' }), { threadParticipated: true }),
        source(message('$12', { thread: true, threadRootId: '$other' })),
        source(message('$13', {
          thread: true,
          threadRootId: '$other',
          mentions: { userIds: [SELF], room: false }
        }))
      ])
    ], SELF)

    expect(result.map(item => [item.eventId, item.kind, item.threadRootId])).toEqual([
      ['$13', 'mention', '$other'],
      ['$11', 'thread_reply', '$root']
    ])
  })

  it('marks a reply that carries a Chief of Staff answer, so it is never taken for a status line', () => {
    const answer = { schemaVersion: 1, companyId: 'company-1', channelId: 'channel-1', citations: [], coverage: { state: 'live' } }

    const result = aggregateMatrixCompanyActivity([
      room([
        source(message('$21', { thread: true, threadRootId: '$root', companyAIAnswer: answer } as Partial<MatrixMessage>), {
          threadParticipated: true
        }),
        source(message('$22', { thread: true, threadRootId: '$root' }), { threadParticipated: true })
      ])
    ], SELF)

    expect(result.map(item => [item.eventId, item.companyAIAnswer])).toEqual([
      ['$22', undefined],
      ['$21', true]
    ])
  })

  it('drops invited, left, unbound, own, unreadable and deleted content', () => {
    const mention = (id: string, extra: Partial<MatrixMessage> = {}) =>
      source(message(id, { mentions: { userIds: [SELF], room: false }, ...extra }))

    const result = aggregateMatrixCompanyActivity([
      room([mention('$1')], { membership: 'invite' }),
      room([mention('$2')], { membership: 'leave' }),
      room([mention('$3')], { companyId: undefined }),
      room([
        mention('$4', { own: true }),
        mention('$5', { decryptionFailed: true }),
        mention('$6', { redacted: true }),
        mention('$7', { body: '' }),
        mention('$8')
      ])
    ], SELF)

    expect(result.map(item => item.eventId)).toEqual(['$8'])
  })

  it('orders newest first with a stable event-id tie break and preserves read state', () => {
    const result = aggregateMatrixCompanyActivity([
      room([
        source(message('$b', { timestamp: 20, mentions: { userIds: [SELF], room: false } }), { unread: false }),
        source(message('$c', { timestamp: 30, mentions: { userIds: [], room: true } })),
        source(message('$a', { timestamp: 20, mentions: { userIds: [SELF], room: false } }))
      ])
    ], SELF)

    expect(result.map(item => [item.eventId, item.unread])).toEqual([
      ['$c', true],
      ['$a', true],
      ['$b', false]
    ])
  })

  it('hard caps the merged projection at 200 most recent items', () => {
    const messages = Array.from({ length: MATRIX_COMPANY_ACTIVITY_MAX + 25 }, (_, index) =>
      source(message(`$${index + 1}`, {
        timestamp: index + 1,
        mentions: { userIds: [SELF], room: false }
      })))

    const result = aggregateMatrixCompanyActivity([room(messages)], SELF, 1_000)

    expect(result).toHaveLength(MATRIX_COMPANY_ACTIVITY_MAX)
    expect(result[0]?.eventId).toBe('$225')
    expect(result.at(-1)?.eventId).toBe('$26')
  })

  it('projects only joined company rooms and keeps SDK thread/read context', () => {
    const mention = event('$mention', '@linh:test', {
      msgtype: 'm.text',
      body: 'Can you review this?',
      'm.mentions': { user_ids: [SELF] }
    }, 30)

    const unrelated = event('$other', '@linh:test', { msgtype: 'm.text', body: 'Morning' }, 40)
    const root = event('$root', SELF, { msgtype: 'm.text', body: 'Plan' }, 10)
    const edited = event('$edited', '@linh:test', { msgtype: 'm.text', body: 'No mention yet' }, 50)
    const edit = event('$edit', '@linh:test', {
      msgtype: 'm.text',
      body: '* Now mentioning you',
      'm.new_content': {
        msgtype: 'm.text',
        body: 'Now mentioning you',
        'm.mentions': { user_ids: [SELF] }
      },
      'm.relates_to': { rel_type: RelationType.Replace, event_id: '$edited' }
    }, 60)
    edited.makeReplaced(edit)

    const reply = event('$reply', '@minh:test', {
      msgtype: 'm.text',
      body: 'I added the final note.',
      'm.relates_to': {
        rel_type: RelationType.Thread,
        event_id: '$root',
        'm.in_reply_to': { event_id: '$root' }
      }
    }, 20)

    const thread = {
      events: [reply],
      hasCurrentUserParticipated: true,
      hasUserReadEvent: (_userId: string, eventId: string) => eventId !== '$reply'
    }

    const nativeRoom = {
      getMyMembership: () => 'join',
      getLiveTimeline: () => ({ getEvents: () => [root, mention, unrelated, edited, edit] }),
      getThreads: () => [thread],
      getThread: (rootId: string) => rootId === '$root' ? thread : null,
      hasUserReadEvent: (_userId: string, eventId: string) => eventId === '$mention',
      getMember: (userId: string) => ({ name: userId === '@linh:test' ? 'Linh' : 'Minh' })
    } as unknown as Room

    const leftRoom = {
      ...nativeRoom,
      getMyMembership: () => 'leave'
    } as unknown as Room

    const projected = (id: string, membership: MatrixRoom['membership'] = 'join'): MatrixRoom => ({
      id,
      name: 'launch',
      membership,
      encrypted: true,
      companyChannel: { companyId: 'company-1', channelId: `channel-${id}` }
    })

    const project = (candidate: MatrixEvent): MatrixMessage | null => {
      const id = candidate.getId()!

      if (id === '$mention') {
        return message(id, {
          sender: candidate.getSender()!,
          body: 'Can you review this?',
          timestamp: candidate.getTs(),
          mentions: { userIds: [SELF], room: false }
        })
      }

      if (id === '$edited') {
        return message(id, {
          sender: candidate.getSender()!,
          body: 'Now mentioning you',
          timestamp: candidate.getTs(),
          mentions: { userIds: [SELF], room: false }
        })
      }

      if (id === '$reply') {
        return message(id, {
          sender: candidate.getSender()!,
          body: 'I added the final note.',
          timestamp: candidate.getTs(),
          thread: true,
          threadRootId: '$root'
        })
      }

      return message(id, { sender: candidate.getSender()!, body: String(candidate.getContent().body ?? '') })
    }

    const result = matrixCompanyActivity(
      [projected('!room:test'), projected('!left:test'), projected('!invite:test', 'invite')],
      roomId => roomId === '!room:test' ? nativeRoom : roomId === '!left:test' ? leftRoom : null,
      SELF,
      project
    )

    expect(result).toEqual([
      expect.objectContaining({
        eventId: '$edited',
        kind: 'mention',
        senderName: 'Linh',
        unread: true
      }),
      expect.objectContaining({
        eventId: '$mention',
        kind: 'mention',
        senderName: 'Linh',
        unread: false
      }),
      expect.objectContaining({
        eventId: '$reply',
        kind: 'thread_reply',
        senderName: 'Minh',
        threadRootId: '$root',
        unread: true
      })
    ])
  })

  it('accepts @channel only from a sender with Matrix room-mention power', () => {
    const unauthorized = event('$unauthorized', '@linh:test', {
      msgtype: 'm.text', body: 'Everyone should see this', 'm.mentions': { room: true }
    }, 10)
    const authorized = event('$authorized', '@admin:test', {
      msgtype: 'm.text', body: 'Authorized announcement', 'm.mentions': { room: true }
    }, 20)
    const power = new MatrixEvent({
      type: EventType.RoomPowerLevels,
      room_id: '!room:test',
      event_id: '$power',
      sender: '@owner:test',
      state_key: '',
      origin_server_ts: 1,
      content: { notifications: { room: 50 } }
    })
    const nativeRoom = {
      getMyMembership: () => 'join',
      getLiveTimeline: () => ({ getEvents: () => [unauthorized, authorized] }),
      getThreads: () => [],
      getThread: () => null,
      hasUserReadEvent: () => false,
      getMember: (userId: string) => ({
        name: userId,
        powerLevel: userId === '@admin:test' ? 50 : 0
      }),
      currentState: { getStateEvents: () => power }
    } as unknown as Room
    const projectedRoom: MatrixRoom = {
      id: '!room:test', name: 'launch', membership: 'join', encrypted: false,
      companyChannel: { companyId: 'company-1', channelId: 'channel-1' }
    }
    const project = (candidate: MatrixEvent) => message(candidate.getId()!, {
      sender: candidate.getSender()!,
      body: String(candidate.getContent().body),
      timestamp: candidate.getTs(),
      mentions: { userIds: [], room: true }
    })

    expect(matrixCompanyActivity([projectedRoom], () => nativeRoom, SELF, project).map(item => item.eventId))
      .toEqual(['$authorized'])
  })

  it('finds participation from an older in-memory root and treats an unknown thread receipt as unread', () => {
    const root = event('$old-root', SELF, { msgtype: 'm.text', body: 'Old plan' }, 1)
    const filler = Array.from({ length: 200 }, (_, index) =>
      event(`$filler-${index}`, '@linh:test', { msgtype: 'm.text', body: 'Routine update' }, index + 2))
    const reply = event('$recent-reply', '@linh:test', {
      msgtype: 'm.text',
      body: 'The plan changed',
      'm.relates_to': {
        rel_type: RelationType.Thread,
        event_id: '$old-root',
        'm.in_reply_to': { event_id: '$old-root' }
      }
    }, 202)
    const nativeRoom = {
      getMyMembership: () => 'join',
      getLiveTimeline: () => ({ getEvents: () => [root, ...filler, reply] }),
      getThreads: () => [],
      getThread: () => null,
      findEventById: (eventId: string) => eventId === '$old-root' ? root : undefined,
      // A room-level receipt must not mark an unmaterialized thread reply read.
      hasUserReadEvent: () => true,
      getMember: () => ({ name: 'Linh' })
    } as unknown as Room
    const projectedRoom: MatrixRoom = {
      id: '!room:test', name: 'launch', membership: 'join', encrypted: false,
      companyChannel: { companyId: 'company-1', channelId: 'channel-1' }
    }
    const project = (candidate: MatrixEvent) => candidate === reply
      ? message('$recent-reply', {
          body: 'The plan changed', timestamp: 202, thread: true, threadRootId: '$old-root'
        })
      : null

    expect(matrixCompanyActivity([projectedRoom], () => nativeRoom, SELF, project)).toEqual([
      expect.objectContaining({ eventId: '$recent-reply', kind: 'thread_reply', unread: true })
    ])
  })

  it('reuses an unchanged room projection and refreshes it when the timeline advances', () => {
    const first = event('$first', '@linh:test', {
      msgtype: 'm.text', body: 'First', 'm.mentions': { user_ids: [SELF] }
    }, 1)
    const second = event('$second', '@linh:test', {
      msgtype: 'm.text', body: 'Second', 'm.mentions': { user_ids: [SELF] }
    }, 2)
    const events = [first]
    const timeline = { getEvents: vi.fn(() => events) }
    const nativeRoom = {
      getMyMembership: () => 'join',
      getLiveTimeline: () => timeline,
      getThreads: () => [],
      getThread: () => null,
      hasUserReadEvent: () => false,
      getMember: () => ({ name: 'Linh' })
    } as unknown as Room
    const projectedRoom: MatrixRoom = {
      id: '!room:test', name: 'launch', membership: 'join', encrypted: false,
      companyChannel: { companyId: 'company-1', channelId: 'channel-1' }
    }
    const project = vi.fn((candidate: MatrixEvent) => message(candidate.getId()!, {
      body: String(candidate.getContent().body),
      timestamp: candidate.getTs(),
      mentions: { userIds: [SELF], room: false }
    }))

    expect(matrixCompanyActivity([projectedRoom], () => nativeRoom, SELF, project)).toHaveLength(1)
    expect(matrixCompanyActivity([projectedRoom], () => nativeRoom, SELF, project)).toHaveLength(1)
    expect(project).toHaveBeenCalledTimes(1)

    events.push(second)
    expect(matrixCompanyActivity([projectedRoom], () => nativeRoom, SELF, project).map(item => item.eventId))
      .toEqual(['$second', '$first'])
    expect(project).toHaveBeenCalledTimes(3)
  })
})
