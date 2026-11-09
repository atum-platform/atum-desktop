import { createClient, EventType, type IStateEventWithRoomId, MatrixEvent } from 'matrix-js-sdk'
import { expect, it, vi } from 'vitest'

import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import {
  conversationAppVersions,
  preflightConversationRoom,
  readConversationCandidates,
  writeConversationMarker
} from './conversation-marker-write'

const input = { roomId: '!room:test', ownerId: '@owner:test', agentId: '@agent:test' }

function fixture(
  userId = input.ownerId,
  power: Record<string, unknown> = { users: { [input.ownerId]: 100 }, state_default: 50 }
) {
  const state: IStateEventWithRoomId[] = [
    [EventType.RoomCreate, '', { type: MATRIX_ASSISTANT_ROOM_TYPE }],
    [EventType.RoomEncryption, '', { algorithm: 'm.megolm.v1.aes-sha2' }],
    [EventType.RoomHistoryVisibility, '', { history_visibility: 'joined' }],
    [EventType.RoomMember, input.ownerId, { membership: 'join' }],
    [EventType.RoomMember, input.agentId, { membership: 'join' }],
    [EventType.RoomPowerLevels, '', power]
  ].map(([type, state_key, content]) => ({
    type,
    state_key,
    content,
    sender: input.ownerId,
    room_id: input.roomId,
    event_id: '$state',
    origin_server_ts: 1
  })) as IStateEventWithRoomId[]

  const client = createClient({ baseUrl: 'https://matrix.test', userId })
  vi.spyOn(client, 'roomState').mockResolvedValue(state)
  const send = vi.spyOn(client, 'sendStateEvent').mockResolvedValue({ event_id: '$write' })

  return { client, state, send }
}

it('writes only canonical pointer state through the owner SDK after server preflight', async () => {
  const f = fixture()
  await writeConversationMarker(f.client, {
    ...input,
    content: { v: 1, role: 'main', main: input.roomId, at: 1, body: 'do not send' } as never
  })
  expect(f.send).toHaveBeenCalledWith(
    input.roomId,
    'io.atum.conversation',
    { v: 1, role: 'main', main: input.roomId, at: 1 },
    ''
  )
  await writeConversationMarker(f.client, { ...input, content: {} })
  expect(f.send).toHaveBeenLastCalledWith(input.roomId, 'io.atum.conversation', {}, '')
})
it('refuses assistant authority, insufficient power, a group and stale host before sending', async () => {
  const agent = fixture(input.agentId)
  await expect(writeConversationMarker(agent.client, { ...input, content: {} })).rejects.toThrow('owner_required')
  expect(agent.send).not.toHaveBeenCalled()
  const low = fixture(input.ownerId, { users: { [input.ownerId]: 1 }, state_default: 50 })
  expect(await preflightConversationRoom(low.client, input)).toBe(false)
  await expect(writeConversationMarker(low.client, { ...input, content: {} })).rejects.toThrow('not_writable')
  const group = fixture()
  group.state[0].content = {}
  await expect(writeConversationMarker(group.client, { ...input, content: {} })).rejects.toThrow(
    'private_assistant_room_required'
  )
  const stale = fixture()
  await expect(writeConversationMarker(stale.client, { ...input, content: {} }, () => false)).rejects.toThrow(
    'owner_required'
  )
  expect(stale.send).not.toHaveBeenCalled()
})
it('reads one report per Mac and writes only this trusted Mac version record', async () => {
  const f = fixture()
  const set = vi.spyOn(f.client, 'setAccountDataRaw').mockResolvedValue({})
  vi.spyOn(f.client, 'getAccountDataFromServer').mockResolvedValue({ v: 1, version: '0.19.0', at: 1 } as never)
  expect(
    await conversationAppVersions(f.client, {
      ownerId: input.ownerId,
      devices: ['one', 'two'],
      own: { deviceServiceId: 'one', version: '0.19.0', at: 1 }
    })
  ).toHaveLength(2)
  expect(set).toHaveBeenCalledWith('io.atum.app_version.one', { v: 1, version: '0.19.0', at: 1 })
})

it('retains native-known rooms, classifies explicit server denial as unreachable, and ranks only server timestamps', async () => {
  const f = fixture()
  vi.spyOn(f.client, 'getJoinedRooms').mockResolvedValue({ joined_rooms: [input.roomId] })
  vi.spyOn(f.client.http, 'authedRequest')
    .mockResolvedValueOnce({ chunk: [{ origin_server_ts: 20 }] })
    .mockResolvedValueOnce({ chunk: [{ origin_server_ts: 30 }] })
  vi.spyOn(f.client, 'roomState').mockImplementation(async roomId => {
    if (roomId === '!known:test') {
      throw Object.assign(new Error('forbidden'), { errcode: 'M_FORBIDDEN' })
    }

    return f.state
  })

  await expect(readConversationCandidates(f.client, { ...input, knownRooms: ['!known:test'] })).resolves.toEqual([
    { roomId: '!known:test', read: 'unreachable', writable: false },
    expect.objectContaining({ roomId: input.roomId, read: 'readable', writable: true, ownerAt: 20, activityAt: 30 })
  ])
})

// Plan 7 decides on this one fact whether a main is replaced by a plain room (0.20 shave-down).
it('says whether each readable candidate has end-to-end encryption, from its server state', async () => {
  const encryptedRoom = fixture()
  vi.spyOn(encryptedRoom.client, 'getJoinedRooms').mockResolvedValue({ joined_rooms: [input.roomId] })
  vi.spyOn(encryptedRoom.client.http, 'authedRequest').mockResolvedValue({ chunk: [] })
  await expect(readConversationCandidates(encryptedRoom.client, input)).resolves.toEqual([
    expect.objectContaining({ roomId: input.roomId, read: 'readable', encrypted: true })
  ])

  const plain = fixture()
  plain.state.splice(
    plain.state.findIndex(event => event.type === EventType.RoomEncryption),
    1
  )
  plain.state.find(event => event.type === EventType.RoomHistoryVisibility)!.content = { history_visibility: 'invited' }
  vi.spyOn(plain.client, 'getJoinedRooms').mockResolvedValue({ joined_rooms: [input.roomId] })
  vi.spyOn(plain.client.http, 'authedRequest').mockResolvedValue({ chunk: [] })
  await expect(readConversationCandidates(plain.client, input)).resolves.toEqual([
    expect.objectContaining({ roomId: input.roomId, read: 'readable', encrypted: false })
  ])
})

it('excludes a denied unknown room from private migration and job-origin inputs', async () => {
  const f = fixture()
  vi.spyOn(f.client, 'getJoinedRooms').mockResolvedValue({ joined_rooms: ['!unknown:test', input.roomId] })
  vi.spyOn(f.client.http, 'authedRequest').mockResolvedValue({ chunk: [] })
  vi.spyOn(f.client, 'roomState').mockImplementation(async roomId => {
    if (roomId === '!unknown:test') {
      throw Object.assign(new Error('forbidden'), { errcode: 'M_FORBIDDEN' })
    }
    return f.state
  })
  const candidates = await readConversationCandidates(f.client, input)
  expect(candidates.map(candidate => candidate.roomId)).toEqual([input.roomId])
  expect(f.send).not.toHaveBeenCalled()
})

it('marks a known main unreachable only after the SDK reports definitive lost backup keys', async () => {
  const f = fixture()
  const encrypted = new MatrixEvent({ type: EventType.RoomMessageEncrypted, room_id: input.roomId, content: {} })
  vi.spyOn(encrypted, 'isDecryptionFailure').mockReturnValue(true)
  Object.defineProperty(encrypted, 'decryptionFailureReason', { value: 'HISTORICAL_MESSAGE_NO_KEY_BACKUP' })
  vi.spyOn(f.client, 'getJoinedRooms').mockResolvedValue({ joined_rooms: [input.roomId] })
  vi.spyOn(f.client, 'getRoom').mockReturnValue({
    currentState: { getStateEvents: () => undefined },
    getType: () => MATRIX_ASSISTANT_ROOM_TYPE,
    getLiveTimeline: () => ({ getEvents: () => [encrypted] })
  } as never)
  const decrypt = vi.spyOn(f.client, 'decryptEventIfNeeded').mockResolvedValue()

  await expect(readConversationCandidates(f.client, { ...input, knownMain: input.roomId })).resolves.toEqual([
    { roomId: input.roomId, read: 'unreachable', writable: false, encrypted: true }
  ])
  expect(decrypt).toHaveBeenCalledWith(encrypted)
})

it('keeps waiting-for-key SDK outcomes transient rather than inferring room key loss', async () => {
  const f = fixture()
  const encrypted = new MatrixEvent({ type: EventType.RoomMessageEncrypted, room_id: input.roomId, content: {} })
  vi.spyOn(encrypted, 'isDecryptionFailure').mockReturnValue(true)
  Object.defineProperty(encrypted, 'decryptionFailureReason', { value: 'MEGOLM_UNKNOWN_INBOUND_SESSION_ID' })
  vi.spyOn(f.client, 'getJoinedRooms').mockResolvedValue({ joined_rooms: [input.roomId] })
  vi.spyOn(f.client, 'getRoom').mockReturnValue({
    currentState: { getStateEvents: () => undefined },
    getType: () => MATRIX_ASSISTANT_ROOM_TYPE,
    getLiveTimeline: () => ({ getEvents: () => [encrypted] })
  } as never)
  vi.spyOn(f.client, 'decryptEventIfNeeded').mockResolvedValue()

  await expect(readConversationCandidates(f.client, { ...input, knownMain: input.roomId })).resolves.toEqual([
    { roomId: input.roomId, read: 'transient', writable: false, encrypted: true }
  ])
})

it('refuses malformed marker content before any SDK write', async () => {
  const malformed = fixture()
  await expect(
    writeConversationMarker(malformed.client, {
      ...input,
      content: { v: 1, role: 'other', main: input.roomId, at: 1 } as never
    })
  ).rejects.toThrow()
  expect(malformed.send).not.toHaveBeenCalled()
})

it('returns a transient observation when the joined-room enumeration fails, without replacing a known answer', async () => {
  const f = fixture()
  vi.spyOn(f.client, 'getJoinedRooms').mockRejectedValue(new Error('synthetic transport failure'))
  await expect(readConversationCandidates(f.client, { ...input, knownMain: input.roomId })).resolves.toEqual([
    { roomId: input.roomId, read: 'transient', writable: false }
  ])
  expect(f.send).not.toHaveBeenCalled()
})
