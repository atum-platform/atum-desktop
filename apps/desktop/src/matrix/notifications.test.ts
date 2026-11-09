import {
  createClient,
  EventType,
  MatrixEvent,
  MatrixEventEvent,
  NotificationCountType,
  PushRuleActionName,
  Room,
  RoomEvent,
  TweakName
} from 'matrix-js-sdk'
import { expect, it, vi } from 'vitest'

import { MATRIX_COMPANY_CHANNEL_TYPE } from '../../shared/matrix-company-channel-room'
import { MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT } from '../../shared/matrix-company-private-cos-claim'
import { defaultMatrixNotificationPolicy } from '../../shared/matrix-notification-policy'

import { watchMatrixNotifications } from './notifications'

function fixture() {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@alice:test' })
  const room = new Room('!room:test', client, '@alice:test')
  room.updateMyMembership('join')
  client.store.storeRoom(room)
  client.pushRules = {
    global: {
      override: [
        {
          rule_id: 'fixture',
          default: false,
          enabled: true,
          conditions: [],
          actions: [PushRuleActionName.Notify, { set_tweak: TweakName.Sound, value: 'default' }]
        }
      ]
    }
  }
  let ready = true
  const offer = vi.fn()
  const watcher = watchMatrixNotifications(client, () => ready, offer)

  const event = (
    id = '$fresh',
    fields = {},
    content: Record<string, unknown> = { msgtype: 'm.text', body: 'private' }
  ) =>
    new MatrixEvent({
      event_id: id,
      room_id: room.roomId,
      type: EventType.RoomMessage,
      sender: '@bob:test',
      content,
      ...fields
    })

  const timeline = (e: MatrixEvent, liveEvent = true, toStart = false, removed = false) =>
    client.emit(RoomEvent.Timeline, e, room, toStart, removed, { liveEvent, timeline: room.getLiveTimeline() })

  return { client, room, offer, watcher, event, timeline, ready: (value: boolean) => (ready = value) }
}

it('uses the actual SDK push processor, including mute and no-sound actions, without copying private message content', () => {
  const f = fixture()
  f.timeline(f.event())
  expect(f.offer).toHaveBeenCalledExactlyOnceWith({ roomId: '!room:test', eventId: '$fresh', sound: true })
  f.client.pushRules!.global.override![0]!.actions = [PushRuleActionName.DontNotify]
  f.timeline(f.event('$muted'))
  expect(f.offer).toHaveBeenCalledOnce()
  f.client.pushRules!.global.override![0]!.actions = [PushRuleActionName.Notify]
  f.timeline(f.event('$silent'))
  expect(f.offer).toHaveBeenLastCalledWith({ roomId: '!room:test', eventId: '$silent', sound: false })
  f.watcher.stop()
})

it.each(['', 'unexpected-state-key'])(
  'suppresses a private-CoS notification claim under state key %j before offering it to native main',
  stateKey => {
    const f = fixture()
    f.room.currentState.setStateEvents([new MatrixEvent({
      type: MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT,
      state_key: stateKey,
      sender: '@manager:test',
      room_id: f.room.roomId,
      content: {
        v: 1,
        classification: 'company_private_cos',
        companyId: '00000000-0000-4000-8000-87c6455cae48',
        membershipIncarnation: '00000000-0000-4000-8000-f6c6b8bb709f',
        executorId: '00000000-0000-4000-8000-8a4e23bab81e'
      }
    })])

    f.timeline(f.event(`$private-${stateKey || 'exact'}`))
    expect(f.offer).not.toHaveBeenCalled()
    f.watcher.stop()
  }
)

it('applies Team space levels locally without changing unread or highlight badges', () => {
  const f = fixture()
  f.watcher.stop()
  vi.spyOn(f.room, 'getType').mockReturnValue(MATRIX_COMPANY_CHANNEL_TYPE)
  f.client.pushRules!.global.override![0]!.actions = [PushRuleActionName.DontNotify]
  f.room.setUnreadNotificationCount(NotificationCountType.Total, 7)
  f.room.setUnreadNotificationCount(NotificationCountType.Highlight, 2)
  let policy = defaultMatrixNotificationPolicy('UTC')
  policy.channelOverrides[f.room.roomId] = 'all'
  const watcher = watchMatrixNotifications(f.client, () => true, f.offer, () => policy)

  f.timeline(f.event('$all'))
  expect(f.offer).toHaveBeenCalledExactlyOnceWith({ roomId: '!room:test', eventId: '$all', sound: true })

  policy = { ...policy, channelOverrides: { [f.room.roomId]: 'nothing' } }
  f.timeline(f.event('$nothing'))
  expect(f.offer).toHaveBeenCalledOnce()
  expect(f.room.getUnreadNotificationCount(NotificationCountType.Total)).toBe(7)
  expect(f.room.getUnreadNotificationCount(NotificationCountType.Highlight)).toBe(2)

  policy = { ...policy, channelOverrides: { [f.room.roomId]: 'mentions' } }
  f.timeline(f.event('$ordinary'))
  f.timeline(f.event('$mention', {}, {
    msgtype: 'm.text', body: 'Alice', 'm.mentions': { user_ids: ['@alice:test'] }
  }))
  expect(f.offer).toHaveBeenLastCalledWith({ roomId: '!room:test', eventId: '$mention', sound: true })
  expect(f.offer).toHaveBeenCalledTimes(2)
  watcher.stop()
})

it('excludes initial sync, cached/backfilled/paginated/removed events, own/local echoes, edits and non-messages', () => {
  const f = fixture()
  f.ready(false)
  const initial = f.event('$initial')
  f.timeline(initial)
  f.ready(true)
  f.client.emit(MatrixEventEvent.Decrypted, initial)
  f.timeline(f.event('$cache'), false)
  f.timeline(f.event('$page'), true, true)
  f.timeline(f.event('$removed'), true, false, true)
  f.timeline(f.event('$own', { sender: '@alice:test' }))
  f.timeline(f.event('~local'))
  f.timeline(f.event('$edit', {}, { 'm.relates_to': { rel_type: 'm.replace', event_id: '$old' } }))
  f.timeline(f.event('$state', { type: EventType.RoomName }))
  const redacted = f.event('$redacted')
  vi.spyOn(redacted, 'isRedacted').mockReturnValue(true)
  f.timeline(redacted)
  expect(f.offer).not.toHaveBeenCalled()
  f.watcher.stop()
})

it('checks current ignore and membership at admission and decryption, and removes its listeners on retirement', () => {
  const f = fixture()
  const ignored = vi.spyOn(f.client, 'isUserIgnored').mockReturnValue(true)
  f.timeline(f.event('$ignored'))
  ignored.mockReturnValue(false)
  f.room.updateMyMembership('leave')
  f.timeline(f.event('$left'))
  f.room.updateMyMembership('join')
  f.timeline(f.event('$allowed'))
  expect(f.offer).toHaveBeenCalledOnce()
  f.watcher.stop()
  f.timeline(f.event('$retired'))
  expect(f.offer).toHaveBeenCalledOnce()
  expect(f.client.listenerCount(RoomEvent.Timeline)).toBe(0)
  // The SDK's own decryption listener is not removed by our watcher.
  expect(f.client.listeners(MatrixEventEvent.Decrypted).length).toBe(1)
})

it('finishes delayed live decryption once, never delayed history, and never revives a stopped watcher', async () => {
  const f = fixture()

  const decrypt = async (event: MatrixEvent) =>
    event.attemptDecryption({
      decryptEvent: async () => ({
        clearEvent: { type: EventType.RoomMessage, content: { msgtype: 'm.text', body: 'private' } },
        senderCurve25519Key: 'fixture',
        claimedEd25519Key: 'fixture'
      })
    } as unknown as Parameters<MatrixEvent['attemptDecryption']>[0])

  const live = f.event('$live', { type: EventType.RoomMessageEncrypted })
  f.timeline(live)
  expect(f.offer).not.toHaveBeenCalled()
  await decrypt(live)
  f.client.emit(MatrixEventEvent.Decrypted, live)
  f.client.emit(MatrixEventEvent.Decrypted, live)
  f.timeline(live)
  expect(f.offer).toHaveBeenCalledExactlyOnceWith({ roomId: '!room:test', eventId: '$live', sound: true })
  const old = f.event('$old', { type: EventType.RoomMessageEncrypted })
  f.timeline(old, false)
  await decrypt(old)
  f.client.emit(MatrixEventEvent.Decrypted, old)
  const stopped = f.event('$stopped', { type: EventType.RoomMessageEncrypted })
  f.timeline(stopped)
  f.watcher.stop()
  await decrypt(stopped)
  f.client.emit(MatrixEventEvent.Decrypted, stopped)
  expect(f.offer).toHaveBeenCalledOnce()
})
