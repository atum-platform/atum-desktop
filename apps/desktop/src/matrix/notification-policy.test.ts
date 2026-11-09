import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'

import { MATRIX_COMPANY_CHANNEL_TYPE } from '../../shared/matrix-company-channel-room'
import {
  defaultMatrixNotificationPolicy,
  MATRIX_NOTIFICATION_POLICY_ACCOUNT_DATA
} from '../../shared/matrix-notification-policy'

import { matrixNotificationPolicy } from './notification-policy'

const identity = { userId: '@alice:test', deviceId: 'ONE' }

function fixture() {
  const server = new Map<string, unknown>()
  const synced = new Map<string, { getContent: () => unknown }>()
  let active = true
  const root = {
    getRoomId: () => '!launch:test',
    getType: () => 'm.room.message',
    getOriginalContent: () => ({}),
    isRedacted: () => false,
    isDecryptionFailure: () => false,
    status: null
  } as unknown as MatrixEvent
  const room = {
    roomId: '!launch:test',
    getMyMembership: () => 'join',
    getType: () => MATRIX_COMPANY_CHANNEL_TYPE,
    findEventById: (id: string) => id === '$budget' ? root : undefined
  } as unknown as Room
  const write = vi.fn(async (type: string, value: unknown) => {
    server.set(type, value)
  })
  const client = {
    getUserId: () => identity.userId,
    getSafeUserId: () => identity.userId,
    getRoom: (id: string) => id === '!launch:test' ? room : null,
    store: { accountData: synced },
    getAccountData: (type: string) => synced.get(type),
    http: {
      authedRequest: vi.fn(async (_method: unknown, path: string) => {
        const type = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))
        if (!server.has(type)) {
          throw { errcode: 'M_NOT_FOUND' }
        }

        return server.get(type)
      })
    },
    setAccountDataRaw: write
  } as unknown as MatrixClient
  const policy = matrixNotificationPolicy(client, identity, () => active, 'Asia/Ho_Chi_Minh')

  return {
    policy,
    write,
    server: () => server,
    sync: () => {
      synced.clear()
      for (const [type, value] of server) {
        synced.set(type, { getContent: () => value })
      }
    },
    setServer: (value: unknown) => { server.set(MATRIX_NOTIFICATION_POLICY_ACCOUNT_DATA, value) },
    stop: () => { active = false }
  }
}

describe('Matrix notification account-data persistence', () => {
  it('fresh-reads and merges account, channel and thread changes without fabricating a sync echo', async () => {
    const f = fixture()
    const before = f.policy.snapshot(true)

    await f.policy.change({ kind: 'notificationPolicy', identity, scope: 'account', level: 'all' } as never)
    await f.policy.change({
      kind: 'notificationPolicy', identity, scope: 'channel', roomId: '!launch:test', level: 'nothing'
    } as never)
    await f.policy.change({
      kind: 'notificationPolicy', identity, scope: 'thread', roomId: '!launch:test', rootId: '$budget', level: 'mentions'
    } as never)

    expect(f.policy.snapshot(true)).toEqual(before)
    f.sync()
    expect(f.policy.snapshot(true)).toMatchObject({
      accountLevel: 'all',
      channelOverrides: { '!launch:test': 'nothing' },
      threadOverrides: { '!launch:test': { '$budget': 'mentions' } },
      writable: true
    })
    expect(f.write).toHaveBeenCalledTimes(3)
  })

  it('preserves two devices changing unrelated preferences after concurrent reads', async () => {
    const f = fixture()
    // Both simulated devices share the same homeserver account-data map.
    const shared = f.server()

    // Build the second policy over the same server with a read barrier.
    let reads = 0
    let release!: () => void
    const bothRead = new Promise<void>(resolve => { release = resolve })
    const synced = new Map<string, { getContent: () => unknown }>()
    const client = {
      getUserId: () => identity.userId,
      getSafeUserId: () => identity.userId,
      getRoom: (id: string) => id === '!launch:test' ? ({
        roomId: '!launch:test', getMyMembership: () => 'join', getType: () => MATRIX_COMPANY_CHANNEL_TYPE,
        findEventById: () => undefined
      }) : null,
      getAccountData: (type: string) => synced.get(type),
      store: { accountData: synced },
      http: { authedRequest: vi.fn(async (_method: unknown, path: string) => {
        reads += 1
        if (reads === 2) {release()}
        await bothRead
        const type = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))
        if (!shared.has(type)) {throw { errcode: 'M_NOT_FOUND' }}
        return shared.get(type)
      }) },
      setAccountDataRaw: vi.fn(async (type: string, value: unknown) => { shared.set(type, value) })
    } as unknown as MatrixClient
    const first = matrixNotificationPolicy(client, identity, () => true, 'UTC')
    const second = matrixNotificationPolicy(client, { ...identity, deviceId: 'TWO' }, () => true, 'UTC')

    await Promise.all([
      first.change({ kind: 'notificationPolicy', identity, scope: 'account', level: 'all' } as never),
      second.change({ kind: 'notificationPolicy', identity: { ...identity, deviceId: 'TWO' }, scope: 'channel', roomId: '!launch:test', level: 'nothing' } as never)
    ])
    for (const [type, value] of shared) {synced.set(type, { getContent: () => value })}

    expect(first.snapshot(true)).toMatchObject({ accountLevel: 'all', channelOverrides: { '!launch:test': 'nothing' } })
  })

  it('refuses future schema, stale identity and non-Team-space targets before writing', async () => {
    const f = fixture()
    f.setServer({ ...defaultMatrixNotificationPolicy('UTC'), version: 2 })
    await expect(f.policy.change({
      kind: 'notificationPolicy', identity, scope: 'account', level: 'all'
    } as never)).rejects.toThrow('readonly')
    await expect(f.policy.change({
      kind: 'notificationPolicy', identity: { ...identity, deviceId: 'STALE' }, scope: 'account', level: 'all'
    } as never)).rejects.toThrow('stale')
    await expect(f.policy.change({
      kind: 'notificationPolicy', identity, scope: 'channel', roomId: '!other:test', level: 'all'
    } as never)).rejects.toThrow('unavailable')
    expect(f.write).not.toHaveBeenCalled()
  })

  it('preserves version-one extensions written by another client', async () => {
    const f = fixture()
    f.setServer({ ...defaultMatrixNotificationPolicy('UTC'), phoneExtension: { keep: true } })
    await f.policy.change({
      kind: 'notificationPolicy', identity, scope: 'account', level: 'all'
    } as never)
    expect(f.server().get(MATRIX_NOTIFICATION_POLICY_ACCOUNT_DATA)).toMatchObject({ phoneExtension: { keep: true } })
  })

  it('fences a retired account before a write', async () => {
    const f = fixture()
    f.stop()
    await expect(f.policy.change({
      kind: 'notificationPolicy', identity, scope: 'quietHours', quietHours: {
        enabled: true, startMinute: 1_320, endMinute: 420, timeZone: 'Asia/Ho_Chi_Minh'
      }
    } as never)).rejects.toThrow('stale')
    expect(f.write).not.toHaveBeenCalled()
  })
})
