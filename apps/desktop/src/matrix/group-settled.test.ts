// @vitest-environment node
import { EventType, type MatrixClient, MatrixEvent } from 'matrix-js-sdk'
import { EventShieldColour } from 'matrix-js-sdk/lib/crypto-api'
import { expect, it, vi } from 'vitest'

import { readGroupSettled } from './group-settled'

const target = {
  roomId: '!room:test',
  ownerId: '@owner:test',
  agentId: '@one:test',
  eventId: '$owner',
  agentIds: ['@one:test', '@two:test']
}

function fixture(encrypted = true) {
  const events: MatrixEvent[] = []
  // `stored`: whether the crypto store has recorded the room as encrypted (never turns off).
  const state = { encrypted, stored: encrypted }

  const room = {
    roomId: target.roomId,
    getMyMembership: () => 'join',
    hasEncryptionStateEvent: () => state.encrypted,
    getType: () => undefined,
    getMember: () => ({ membership: 'join' }),
    getLiveTimeline: () => ({ getEvents: () => events })
  }

  const crypto = {
    isEncryptionEnabledInRoom: vi.fn(async () => state.stored),
    getUserDeviceInfo: vi.fn(
      async () =>
        new Map(
          target.agentIds.map(id => [
            id,
            new Map([['D', { deviceId: 'D', getIdentityKey: () => 'curve', getFingerprint: () => 'ed' }]])
          ])
        )
    ),
    getDeviceVerificationStatus: vi.fn(async () => ({ isVerified: (): boolean => true })),
    getEncryptionInfoForEvent: vi.fn(async () => ({ shieldColour: EventShieldColour.NONE, shieldReason: null }))
  }

  const client = {
    getUserId: () => target.ownerId,
    getRoom: () => room,
    getCrypto: () => crypto,
    fetchRoomEvent: vi.fn(),
    decryptEventIfNeeded: vi.fn(),
    createMessagesRequest: vi.fn()
  } as unknown as MatrixClient

  function reply(sender: string, patch: Record<string, unknown> = {}) {
    const event = new MatrixEvent({
      type: EventType.RoomMessage,
      sender,
      room_id: target.roomId,
      event_id: `$${events.length}`,
      origin_server_ts: 1000,
      content: {
        msgtype: 'm.text',
        body: 'answer',
        'm.relates_to': { 'm.in_reply_to': { event_id: target.eventId } },
        ...patch
      }
    })

    if (state.encrypted || patch.wire === 'encrypted') {
      event.makeEncrypted(EventType.RoomMessageEncrypted, {}, 'curve', 'ed')
    }

    events.push(event)

    return event
  }

  return { events, room, crypto, client, reply, state }
}

it('recognizes verified text and notice rich replies, without backfill or decrypting', async () => {
  const f = fixture()
  f.reply('@one:test')
  f.reply('@two:test', { msgtype: 'm.notice' })
  await expect(readGroupSettled(f.client, target, () => true)).resolves.toEqual(target.agentIds)
  expect(f.crypto.getUserDeviceInfo).toHaveBeenCalledWith(target.agentIds, false)
  expect(f.client.fetchRoomEvent).not.toHaveBeenCalled()
  expect(f.client.decryptEventIfNeeded).not.toHaveBeenCalled()
  expect(f.client.createMessagesRequest).not.toHaveBeenCalled()
})

it.each(['foreign', 'unverified', 'file', 'thread', 'edit', 'other-origin', 'redacted', 'pending', 'left', 'stopped'])(
  'does not settle a floor from %s',
  async fault => {
    const f = fixture()
    const event = f.reply(fault === 'foreign' ? '@foreign:test' : '@one:test')

    if (fault === 'unverified') {f.crypto.getDeviceVerificationStatus.mockResolvedValue({ isVerified: () => false })}

    if (fault === 'file') {event.getContent().msgtype = 'm.file'}

    if (fault === 'thread') {event.getContent()['m.relates_to']!.rel_type = 'm.thread'}

    if (fault === 'edit') {event.getContent()['m.relates_to']!.rel_type = 'm.replace'}

    if (fault === 'other-origin') {event.getContent()['m.relates_to']!['m.in_reply_to']!.event_id = '$other'}

    if (fault === 'redacted') {vi.spyOn(event, 'isRedacted').mockReturnValue(true)}

    if (fault === 'pending') {event.status = 'sending' as never}

    if (fault === 'left') {f.room.getMember = () => ({ membership: 'leave' })}

    if (fault === 'stopped') {
      await expect(readGroupSettled(f.client, target, () => false)).rejects.toThrow('matrix_group_changed')
    } else {await expect(readGroupSettled(f.client, target, () => true)).resolves.toEqual([])}
  }
)

// Preserve user-visible identity, state and recovery behavior across connection changes.
it('recognizes an assistant\u2019s plain answer in a plain group, with no device read', async () => {
  const f = fixture(false)
  f.reply('@one:test')
  f.reply('@two:test', { msgtype: 'm.notice' })
  await expect(readGroupSettled(f.client, target, () => true)).resolves.toEqual(target.agentIds)
  expect(f.crypto.getUserDeviceInfo).not.toHaveBeenCalled()
})

it('never counts a ciphertext in a plain group, or a plaintext answer in an encrypted group', async () => {
  const plain = fixture(false)
  plain.reply('@one:test', { wire: 'encrypted' })
  await expect(readGroupSettled(plain.client, target, () => true)).resolves.toEqual([])

  const encrypted = fixture()
  encrypted.state.encrypted = false
  encrypted.reply('@one:test')
  encrypted.state.encrypted = true
  await expect(readGroupSettled(encrypted.client, target, () => true)).resolves.toEqual([])
})

it('fails when a plain group turns encryption on while it is read', async () => {
  const f = fixture(false)
  f.reply('@one:test')
  f.crypto.getUserDeviceInfo.mockImplementation(async () => new Map())
  let reads = 0
  vi.spyOn(f.room, 'hasEncryptionStateEvent').mockImplementation(() => reads++ > 1)
  await expect(readGroupSettled(f.client, target, () => true)).rejects.toThrow('matrix_group_changed')
})

// No downgrade: the synced view can lag the crypto store after a restart or a new join.
it('reads a group as encrypted when the crypto store knows it is, though no encryption state has synced', async () => {
  const f = fixture()
  f.state.encrypted = false
  f.reply('@one:test')
  await expect(readGroupSettled(f.client, target, () => true)).resolves.toEqual([])

  f.reply('@two:test', { wire: 'encrypted' })
  await expect(readGroupSettled(f.client, target, () => true)).resolves.toEqual(['@two:test'])
  expect(f.crypto.getUserDeviceInfo).toHaveBeenCalled()
})

it('reads a group as encrypted when the crypto store cannot answer, or there is no crypto', async () => {
  const failing = fixture(false)
  failing.crypto.isEncryptionEnabledInRoom.mockRejectedValue(new Error('store'))
  failing.reply('@one:test')
  await expect(readGroupSettled(failing.client, target, () => true)).resolves.toEqual([])

  const none = fixture(false)
  none.reply('@one:test')
  ;(none.client as unknown as { getCrypto: () => undefined }).getCrypto = () => undefined
  await expect(readGroupSettled(none.client, target, () => true)).rejects.toThrow('matrix_group_changed')
})
