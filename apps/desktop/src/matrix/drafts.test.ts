import { EventType } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'

import {
  MATRIX_COMPANY_CHANNEL_BINDING,
  MATRIX_COMPANY_CHANNEL_TYPE
} from '../../shared/matrix-company-channel-room'
import {
  MATRIX_DRAFTS_ACCOUNT_DATA,
  matrixDraftText
} from '../../shared/matrix-drafts'

import { matrixDrafts } from './drafts'

const owner = '@owner:test'
const companyId = '00000000-0000-4000-8000-9dfd00e61274'
const channelId = '00000000-0000-4000-8000-b3913a0775b9'

function joinedRoom(roomId: string) {
  const creation = {
    getContent: () => ({
      type: MATRIX_COMPANY_CHANNEL_TYPE,
      room_version: '11',
      [MATRIX_COMPANY_CHANNEL_BINDING]: { companyId, channelId }
    }),
    getSender: () => '@manager:test'
  }

  return {
    roomId,
    getMyMembership: () => 'join',
    currentState: {
      getStateEvents: (type: string, key: string) => type === EventType.RoomCreate && key === '' ? creation : null
    }
  }
}

function device(
  account: { values: Map<string, unknown>; beforeGet?: () => Promise<void> },
  deviceId: string,
  rooms = [joinedRoom('!launch:test')],
  userId = owner,
  additionalRoom: (room: ReturnType<typeof joinedRoom>) => boolean = () => false
) {
  const cached = new Map<string, { getContent: () => unknown }>()
  const sync = () => {
    cached.clear()
    for (const [type, value] of account.values) {
      cached.set(type, { getContent: () => value })
    }
  }
  sync()
  const setAccountDataRaw = vi.fn(async (type: string, value: unknown) => {
    account.values.set(type, value)
  })
  const client = {
    getUserId: () => userId,
    getSafeUserId: () => userId,
    getDeviceId: () => deviceId,
    getRoom: (roomId: string) => rooms.find(room => room.roomId === roomId) ?? null,
    getRooms: () => rooms,
    store: { accountData: cached },
    getAccountData: (type: string) => cached.get(type),
    setAccountDataRaw,
    http: {
      authedRequest: vi.fn(async (_method: unknown, path: string) => {
        await account.beforeGet?.()
        const type = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))

        return account.values.has(type)
          ? account.values.get(type)
          : Promise.reject(Object.assign(new Error('missing'), { errcode: 'M_NOT_FOUND' }))
      })
    }
  }

  return {
    client,
    drafts: matrixDrafts(client as never, { userId, deviceId }, () => true, () => 100, additionalRoom as never),
    setAccountDataRaw,
    sync
  }
}

describe('Matrix synced drafts', () => {
  it('persists on one simulated device and restores on another through account data', async () => {
    const account = { values: new Map<string, unknown>() }
    const mac = device(account, 'MAC')
    const phone = device(account, 'PHONE')

    await mac.drafts.change({ roomId: '!launch:test', threadRootId: '$root' }, 'Ship Tuesday')
    phone.sync()

    expect(matrixDraftText(phone.drafts.snapshot(true), {
      roomId: '!launch:test',
      threadRootId: '$root'
    })).toBe('Ship Tuesday')
  })

  it('preserves two devices editing different draft targets after concurrent reads', async () => {
    let reads = 0
    let release!: () => void
    const bothRead = new Promise<void>(resolve => { release = resolve })
    const account = {
      values: new Map<string, unknown>(),
      beforeGet: async () => {
        reads += 1
        if (reads === 2) {release()}
        await bothRead
      }
    }
    const mac = device(account, 'MAC', [joinedRoom('!launch:test'), joinedRoom('!budget:test')])
    const phone = device(account, 'PHONE', [joinedRoom('!launch:test'), joinedRoom('!budget:test')])

    await Promise.all([
      mac.drafts.change({ roomId: '!launch:test' }, 'Launch plan'),
      phone.drafts.change({ roomId: '!budget:test' }, 'Budget notes')
    ])
    mac.sync()

    expect(matrixDraftText(mac.drafts.snapshot(true), { roomId: '!launch:test' })).toBe('Launch plan')
    expect(matrixDraftText(mac.drafts.snapshot(true), { roomId: '!budget:test' })).toBe('Budget notes')
  })

  it('hides and purges drafts after room membership is lost', async () => {
    const account = {
      values: new Map<string, unknown>([[MATRIX_DRAFTS_ACCOUNT_DATA, {
        version: 1,
        drafts: [
          { room_id: '!launch:test', text: 'keep', updated_at: 2 },
          { room_id: '!gone:test', text: 'purge', updated_at: 1 }
        ]
      }]])
    }
    const mac = device(account, 'MAC')

    await mac.drafts.prune()

    mac.sync()
    expect(matrixDraftText(mac.drafts.snapshot(true), { roomId: '!launch:test' })).toBe('keep')
    expect(matrixDraftText(mac.drafts.snapshot(true), { roomId: '!gone:test' })).toBe('')
  })

  it('uses the same notes room and draft key from two company shortcuts', async () => {
    const notes = joinedRoom('!notes:test')
    const account = { values: new Map<string, unknown>() }
    const fromAcme = device(account, 'MAC', [notes], owner, room => room.roomId === notes.roomId)
    const fromBeta = device(account, 'PHONE', [notes], owner, room => room.roomId === notes.roomId)

    await fromAcme.drafts.change({ roomId: notes.roomId }, 'One account-wide scratch pad')
    fromBeta.sync()

    expect(matrixDraftText(fromBeta.drafts.snapshot(true), { roomId: notes.roomId }))
      .toBe('One account-wide scratch pad')
    expect(account.values.size).toBe(1)
  })

  it('fences writes to the active account and device', async () => {
    const account = { values: new Map<string, unknown>() }
    const other = device(account, 'MAC', [joinedRoom('!launch:test')], '@other:test')
    const drafts = matrixDrafts(
      other.client as never,
      { userId: owner, deviceId: 'MAC' },
      () => true,
      () => 100
    )

    await expect(drafts.change({ roomId: '!launch:test' }, 'must not cross')).rejects.toThrow('matrix_drafts_stale')
    expect(account.values.size).toBe(0)
  })
})
