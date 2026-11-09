import { EventType, type MatrixClient } from 'matrix-js-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { confirmedPlainRoom, knownPlainRoom, PLAIN_ANSWER_MS, plainRoomAnswer, withJoinedWireType } from './plain-room'

afterEach(() => {
  vi.useRealTimers()
})

/** A joined room as this client's synced view shows it, and the crypto store's record of it. */
function fixture(synced: 'plain' | 'encrypted', store: () => Promise<boolean>) {
  const room = {
    roomId: '!room:test',
    hasEncryptionStateEvent: () => synced === 'encrypted',
    getMyMembership: () => 'join'
  }

  const isEncryptionEnabledInRoom = vi.fn(store)

  const client = {
    getCrypto: () => ({ isEncryptionEnabledInRoom }),
    getRoom: () => room
  } as unknown as Pick<MatrixClient, 'getCrypto' | 'getRoom'>

  return { client, room, isEncryptionEnabledInRoom }
}

describe('the crypto store’s word on a plain room', () => {
  it('is plain only when the synced view and the store agree', async () => {
    const plain = fixture('plain', async () => false)
    await expect(plainRoomAnswer(plain.client, plain.room)).resolves.toBe(true)
    await expect(confirmedPlainRoom(plain.client, plain.room)).resolves.toBe(true)

    // An encrypted room whose encryption state has not synced: the store knows.
    const lagging = fixture('plain', async () => true)
    await expect(plainRoomAnswer(lagging.client, lagging.room)).resolves.toBe(false)
    await expect(confirmedPlainRoom(lagging.client, lagging.room)).resolves.toBe(false)

    // A room that shows its encryption is encrypted without asking.
    const encrypted = fixture('encrypted', async () => false)
    await expect(plainRoomAnswer(encrypted.client, encrypted.room)).resolves.toBe(false)
    expect(encrypted.isEncryptionEnabledInRoom).not.toHaveBeenCalled()
  })

  it('has no answer without crypto or on an error, which counts as encrypted', async () => {
    const failing = fixture('plain', async () => {
      throw new Error('store unavailable')
    })

    await expect(plainRoomAnswer(failing.client, failing.room)).resolves.toBeUndefined()
    await expect(confirmedPlainRoom(failing.client, failing.room)).resolves.toBe(false)

    const none = { getCrypto: () => undefined } as unknown as Pick<MatrixClient, 'getCrypto'>
    await expect(plainRoomAnswer(none, failing.room)).resolves.toBeUndefined()
    await expect(confirmedPlainRoom(none, failing.room)).resolves.toBe(false)
  })

  it('stops waiting for a store that does not answer: encrypted for a one-off decision, unknown for one that lasts', async () => {
    vi.useFakeTimers()

    const silent = fixture('plain', () => new Promise<boolean>(() => {}))
    const answer = plainRoomAnswer(silent.client, silent.room)
    const confirmed = confirmedPlainRoom(silent.client, silent.room)
    const known = knownPlainRoom(silent.client, silent.room, 'fixture_try_again')
    known.catch(() => {})
    const wireTypes: Array<string | null | undefined> = []
    withJoinedWireType(silent.client, silent.room.roomId, wireType => void wireTypes.push(wireType))

    await vi.advanceTimersByTimeAsync(PLAIN_ANSWER_MS)

    await expect(answer).resolves.toBeUndefined()
    await expect(confirmed).resolves.toBe(false)
    await expect(known).rejects.toThrow('fixture_try_again')
    // A live watch hears "not known": it passes the hint on to the read that re-asks.
    expect(wireTypes).toEqual([undefined])

    // The next decision asks again.
    silent.isEncryptionEnabledInRoom.mockResolvedValue(false)
    await expect(plainRoomAnswer(silent.client, silent.room)).resolves.toBe(true)
    await expect(knownPlainRoom(silent.client, silent.room, 'fixture_try_again')).resolves.toBe(true)
    expect(silent.isEncryptionEnabledInRoom).toHaveBeenCalledTimes(6)
  })

  it('gives a live watch the room’s wire type when the store answers', async () => {
    const wireTypes: Array<string | null | undefined> = []
    const plain = fixture('plain', async () => false)
    const lagging = fixture('plain', async () => true)
    withJoinedWireType(plain.client, plain.room.roomId, wireType => void wireTypes.push(wireType))
    withJoinedWireType(lagging.client, lagging.room.roomId, wireType => void wireTypes.push(wireType))
    await vi.waitFor(() => expect(wireTypes).toHaveLength(2))
    expect(wireTypes).toEqual([EventType.RoomMessage, EventType.RoomMessageEncrypted])
  })
})
