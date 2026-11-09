import { createClient, EventType, MatrixEvent, Room } from 'matrix-js-sdk'
import { expect, it, vi } from 'vitest'

import { MATRIX_APP_GROUP_TYPE } from '../../shared/matrix-app-room'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'
import type * as PetIntents from '../../shared/matrix-pet-intent'
vi.mock('../../shared/matrix-pet-intent', async original => {
  const api = await original<typeof PetIntents>()

  return { ...api, matrixPetReplyMixin: (value: unknown, privateRoom: boolean) => api.matrixPetReplyMixin(value, privateRoom, true) }
})
import { publishMatrixNotice, publishMatrixResult } from './publish-result'

function fixture(type: string | undefined) {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@agent:test' })
  const room = new Room('!pet:test', client, client.getSafeUserId())
  room.currentState.setStateEvents([
    new MatrixEvent({ type: EventType.RoomCreate, state_key: '', room_id: room.roomId, event_id: '$create', sender: '@owner:test', content: type ? { type } : {} }),
    new MatrixEvent({ type: EventType.RoomEncryption, state_key: '', room_id: room.roomId, event_id: '$encryption', sender: '@owner:test', content: { algorithm: 'm.megolm.v1.aes-sha2' } }),
    ...['@owner:test', '@agent:test'].map(userId => new MatrixEvent({ type: EventType.RoomMember, state_key: userId, room_id: room.roomId, event_id: '$member-' + userId, sender: userId, content: { membership: 'join' } }))
  ])
  room.updateMyMembership('join')
  client.store.storeRoom(room)
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$answer' })

  return { client, room, send }
}

const pet = { v: 1 as const, intents: [{ action: 'wave' as const }] }
const command = { kind: 'publishResult' as const, roomId: '!pet:test', eventId: '$question', body: 'Answer', invocationId: 'synthetic', transactionId: 'transaction', pet }

it('ordinary private encrypted replies publish the same mixin and transaction twice', async () => {
  const f = fixture(MATRIX_ASSISTANT_ROOM_TYPE)
  await publishMatrixResult(f.client, command)
  await publishMatrixResult(f.client, command)
  expect(f.send.mock.calls[0][2]).toMatchObject({ msgtype: 'm.text', body: 'Answer', 'io.atum.pet': pet })
  expect(f.send.mock.calls[1]).toEqual(f.send.mock.calls[0])
})
it.each([undefined, MATRIX_APP_GROUP_TYPE, 'company'])('excludes other room types %s', async type => {
  const f = fixture(type)
  await publishMatrixResult(f.client, command)
  expect(f.send.mock.calls[0][2]).not.toHaveProperty('io.atum.pet')
})
it('group replies and status notices omit forced cosmetic data', async () => {
  const f = fixture(undefined)
  await publishMatrixResult(f.client, { ...command, group: true })
  await publishMatrixNotice(f.client, { kind: 'publishNotice', roomId: command.roomId, eventId: command.eventId, body: 'Status', pet } as Parameters<typeof publishMatrixNotice>[1])

  for (const call of f.send.mock.calls) { expect(call[2]).not.toHaveProperty('io.atum.pet') }
})
it('a typed assistant room with an extra current or former member has no pet mixin', async () => {
  for (const membership of ['join', 'leave']) {
    const f = fixture(MATRIX_ASSISTANT_ROOM_TYPE)
    f.room.currentState.setStateEvents([new MatrixEvent({ type: EventType.RoomMember, state_key: '@other:test', room_id: f.room.roomId, event_id: '$other', sender: '@other:test', content: { membership } })])
    await publishMatrixResult(f.client, command)
    expect(f.send.mock.calls[0][2]).not.toHaveProperty('io.atum.pet')
  }
})
it('bad cosmetic data preserves the text reply', async () => {
  const f = fixture(MATRIX_ASSISTANT_ROOM_TYPE)
  await publishMatrixResult(f.client, { ...command, pet: { ...pet, freeText: 'untrusted' } } as typeof command)
  expect(f.send.mock.calls[0][2]).toMatchObject({ msgtype: 'm.text', body: 'Answer' })
  expect(f.send.mock.calls[0][2]).not.toHaveProperty('io.atum.pet')
})
