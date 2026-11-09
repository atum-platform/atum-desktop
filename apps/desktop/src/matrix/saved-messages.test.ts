import { EventType, MatrixEvent, MsgType } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'

import {
  MATRIX_COMPANY_CHANNEL_BINDING,
  MATRIX_COMPANY_CHANNEL_TYPE
} from '../../shared/matrix-company-channel-room'
import { MATRIX_SAVED_MESSAGES_ACCOUNT_DATA } from '../../shared/matrix-saved-messages'

import { matrixSavedMessages } from './saved-messages'

const companyId = '00000000-0000-4000-8000-9dfd00e61274'
const channelId = '00000000-0000-4000-8000-b3913a0775b9'
const roomId = '!saved:test'
const owner = '@owner:test'
const manager = '@manager:test'

function event(eventId = '$message', content: Record<string, unknown> = { msgtype: MsgType.Text, body: 'Ship the launch plan' }) {
  return new MatrixEvent({
    type: EventType.RoomMessage,
    event_id: eventId,
    room_id: roomId,
    sender: '@linh:test',
    origin_server_ts: 100,
    content
  })
}

function fixture(initial: unknown = undefined) {
  let accountData = initial

  const creation = {
    getContent: () => ({
      type: MATRIX_COMPANY_CHANNEL_TYPE,
      room_version: '11',
      [MATRIX_COMPANY_CHANNEL_BINDING]: { companyId, channelId }
    }),
    getSender: () => manager
  }

  const room = {
    roomId,
    name: 'launch',
    getMyMembership: () => 'join',
    getType: () => MATRIX_COMPANY_CHANNEL_TYPE,
    hasEncryptionStateEvent: () => false,
    findEventById: () => undefined,
    getMember: (userId: string) => ({ name: userId === '@linh:test' ? 'Linh' : userId }),
    currentState: {
      getStateEvents: (type: string, key: string) => type === EventType.RoomCreate && key === '' ? creation : null
    },
    relations: { getChildEventsForEvent: () => null }
  }

  const fetchRoomEvent = vi.fn(async (_roomId: string, eventId: string) => event(eventId).event)

  const setAccountDataRaw = vi.fn(async (_type: string, value: unknown) => {
    accountData = value
  })

  const client = {
    getUserId: () => owner,
    getSafeUserId: () => owner,
    getDeviceId: () => 'A',
    getIgnoredUsers: () => [],
    getRoom: (id: string) => id === roomId ? room : null,
    getAccountData: (type: string) => type === MATRIX_SAVED_MESSAGES_ACCOUNT_DATA && accountData !== undefined
      ? { getContent: () => accountData }
      : undefined,
    fetchRoomEvent,
    decryptEventIfNeeded: vi.fn(async () => {}),
    setAccountDataRaw,
    http: {
      authedRequest: vi.fn(async () => accountData === undefined
        ? Promise.reject(Object.assign(new Error('missing'), { errcode: 'M_NOT_FOUND' }))
        : accountData)
    }
  }

  const saved = matrixSavedMessages(client as never, { userId: owner, deviceId: 'A' }, () => true, () => 200)

  return { client, fetchRoomEvent, saved, setAccountDataRaw, value: () => accountData }
}

describe('Matrix Saved messages', () => {
  it('fresh-reads, validates the exact event, and writes a private bounded pointer', async () => {
    const f = fixture()

    await f.saved.change({ roomId, eventId: '$message', saved: true })

    expect(f.fetchRoomEvent).toHaveBeenCalledWith(roomId, '$message')
    expect(f.setAccountDataRaw).toHaveBeenCalledWith(MATRIX_SAVED_MESSAGES_ACCOUNT_DATA, {
      version: 1,
      messages: [{ room_id: roomId, event_id: '$message', saved_at: 200 }]
    })
  })

  it('resolves accessible rows newest first and leaves missing rooms as removable unavailable rows', async () => {
    const missingRoom = '!gone:test'

    const f = fixture({
      version: 1,
      messages: [
        { room_id: missingRoom, event_id: '$gone', saved_at: 300 },
        { room_id: roomId, event_id: '$message', saved_at: 200 }
      ]
    })

    await expect(f.saved.read()).resolves.toEqual([
      { room_id: missingRoom, event_id: '$gone', saved_at: 300, available: false },
      expect.objectContaining({
        room_id: roomId,
        event_id: '$message',
        saved_at: 200,
        available: true,
        companyId,
        roomName: 'launch',
        senderName: 'Linh',
        body: 'Ship the launch plan'
      })
    ])
  })

  it('lets an unavailable pointer be removed without room access', async () => {
    const f = fixture({
      version: 1,
      messages: [{ room_id: '!gone:test', event_id: '$gone', saved_at: 300 }]
    })

    await f.saved.change({ roomId: '!gone:test', eventId: '$gone', saved: false })

    expect(f.value()).toEqual({ version: 1, messages: [] })
    expect(f.fetchRoomEvent).not.toHaveBeenCalled()
  })

  it('revalidates a saved thread reply before returning its jump target', async () => {
    const f = fixture({
      version: 1,
      messages: [{ room_id: roomId, event_id: '$reply', saved_at: 300 }]
    })

    f.fetchRoomEvent.mockResolvedValue(event('$reply', {
      msgtype: MsgType.Text,
      body: 'Thread answer',
      'm.relates_to': { rel_type: 'm.thread', event_id: '$root' }
    }).event)

    await expect(f.saved.open({ roomId, eventId: '$reply' })).resolves.toEqual({ threadRootId: '$root' })
  })
})
