// @vitest-environment node
import { createClient, EventType, MatrixEvent, Room } from 'matrix-js-sdk'
import { UserVerificationStatus } from 'matrix-js-sdk/lib/crypto-api'
import { expect, it, vi } from 'vitest'

import { matrixContinueChangedPeer, matrixPeerIdentityReview, requireMatrixRoomPeerTrust } from './peer-identity'

function fixture(status = new UserVerificationStatus(false, true, true, true), encrypted = true) {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@owner:test' })
  const peer = '@friend:test'
  const room = new Room('!room:test', client, client.getSafeUserId())
  room.updateMyMembership('join')
  room.currentState.setStateEvents([
    ...(encrypted
      ? [
          new MatrixEvent({
            room_id: room.roomId,
            event_id: '$encryption',
            type: EventType.RoomEncryption,
            state_key: '',
            content: { algorithm: 'm.megolm.v1.aes-sha2' }
          })
        ]
      : []),
    new MatrixEvent({
      room_id: room.roomId,
      event_id: '$member',
      type: EventType.RoomMember,
      state_key: peer,
      sender: peer,
      content: { membership: 'join' }
    })
  ])
  client.store.storeRoom(room)

  const crypto = {
    getUserDeviceInfo: vi.fn(async () => new Map()),
    getUserVerificationStatus: vi.fn(async () => status),
    withdrawVerificationRequirement: vi.fn(async () => {})
  }

  vi.spyOn(client, 'getCrypto').mockReturnValue(crypto as never)

  return { client, room, peer, crypto }
}

it('only identifies an actual changed joined peer and keeps own-identity recovery separate', async () => {
  const f = fixture()
  expect(await matrixPeerIdentityReview(f.client, f.room.roomId, f.peer)).toBe('changed')
  expect(f.crypto.getUserDeviceInfo).toHaveBeenCalledWith([f.peer], true)
  await expect(matrixPeerIdentityReview(f.client, f.room.roomId, '@owner:test')).rejects.toThrow(
    'matrix_identity_review_invalid'
  )
  expect(f.crypto.withdrawVerificationRequirement).not.toHaveBeenCalled()
})
it.each([
  new UserVerificationStatus(false, false, false),
  new UserVerificationStatus(true, true, true),
  new UserVerificationStatus(false, false, true)
])('does not withdraw for an unknown, already verified, or unchanged peer', async status => {
  const f = fixture(status)
  await expect(matrixContinueChangedPeer(f.client, f.room.roomId, f.peer)).rejects.toThrow(
    'matrix_identity_review_stale'
  )
  expect(f.crypto.withdrawVerificationRequirement).not.toHaveBeenCalled()
})
it('explicit continue calls only the public SDK withdrawal and never sends a message', async () => {
  const f = fixture()
  const send = vi.spyOn(f.client, 'sendEvent')
  await matrixContinueChangedPeer(f.client, f.room.roomId, f.peer)
  expect(f.crypto.withdrawVerificationRequirement).toHaveBeenCalledOnce()
  expect(f.crypto.withdrawVerificationRequirement).toHaveBeenCalledWith(f.peer)
  expect(send).not.toHaveBeenCalled()
})
it('rechecks membership after key refresh before accepting the action', async () => {
  const f = fixture()
  f.crypto.getUserDeviceInfo.mockImplementationOnce(async () => {
    f.room.updateMyMembership('leave')

    return new Map()
  })
  await expect(matrixContinueChangedPeer(f.client, f.room.roomId, f.peer)).rejects.toThrow(
    'matrix_identity_review_invalid'
  )
  expect(f.crypto.withdrawVerificationRequirement).not.toHaveBeenCalled()
})

it('does not call an unchanged peer a new identity when our own verification was lost', async () => {
  const f = fixture(new UserVerificationStatus(false, true, true, false))
  expect(await matrixPeerIdentityReview(f.client, f.room.roomId, f.peer)).toBe('verification_required')
  expect(f.crypto.withdrawVerificationRequirement).not.toHaveBeenCalled()
})

it('does not withdraw when its SDK host stops during the identity read', async () => {
  const f = fixture()
  let live = true
  f.crypto.getUserVerificationStatus.mockImplementationOnce(async () => {
    live = false
    return new UserVerificationStatus(false, true, true, true)
  })
  await expect(matrixContinueChangedPeer(f.client, f.room.roomId, f.peer, () => live)).rejects.toThrow('matrix_identity_review_invalid')
  expect(f.crypto.withdrawVerificationRequirement).not.toHaveBeenCalled()
})


it('maps actual changed or lost-verification SDK facts before a strict send and leaves legacy untouched', async () => {
  for (const status of [new UserVerificationStatus(false, true, true, true), new UserVerificationStatus(false, true, true, false)]) {
    const f = fixture(status)
    await expect(requireMatrixRoomPeerTrust(f.client, f.room.roomId, 'signed', () => true)).rejects.toThrow('matrix_identity_review_required')
    f.crypto.getUserVerificationStatus.mockClear()
    await requireMatrixRoomPeerTrust(f.client, f.room.roomId, 'all', () => true)
    expect(f.crypto.getUserVerificationStatus).not.toHaveBeenCalled()
    expect(f.crypto.withdrawVerificationRequirement).not.toHaveBeenCalled()
  }
})

it('never classifies transport failure as changed identity and rechecks the host after its read', async () => {
  const f = fixture(new UserVerificationStatus(true, true, true))
  const failure = new Error('network_fixture_failure')
  f.crypto.getUserVerificationStatus.mockRejectedValueOnce(failure)
  await expect(requireMatrixRoomPeerTrust(f.client, f.room.roomId, 'signed', () => true)).rejects.toBe(failure)
  let live = true
  f.crypto.getUserVerificationStatus.mockImplementationOnce(async () => { live = false; return new UserVerificationStatus(false, true, true, true) })
  await expect(requireMatrixRoomPeerTrust(f.client, f.room.roomId, 'signed', () => live)).rejects.toThrow('matrix_identity_review_stale')
})

// 0.20: people, group, agent and bot chats are plain; a plain room shares no keys.
it('lets a send into a room without encryption through under strict isolation, with no identity read', async () => {
  const f = fixture(new UserVerificationStatus(false, true, true, true), false)
  await expect(requireMatrixRoomPeerTrust(f.client, f.room.roomId, 'signed', () => true)).resolves.toBeUndefined()
  expect(f.crypto.getUserVerificationStatus).not.toHaveBeenCalled()
  // The same changed peer in an encrypted room still stops the send.
  const encrypted = fixture(new UserVerificationStatus(false, true, true, true))
  await expect(
    requireMatrixRoomPeerTrust(encrypted.client, encrypted.room.roomId, 'signed', () => true)
  ).rejects.toThrow('matrix_identity_review_required')
})
