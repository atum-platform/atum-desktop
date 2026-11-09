import { createClient, EventType } from 'matrix-js-sdk'
import type { IStateEventWithRoomId } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'

import { CONVERSATION_STATE_TYPE, EarlierConversationError } from '../../shared/agent-conversation'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import { findAssistantRoom, readAssistantRoom, readConversationMarker } from './assistant-room'
import {
  conversationMainInstead,
  conversationMarkerFromState,
  conversationReadFailure,
  resolveProjectedConversation
} from './conversation-marker'
import type { ConversationRoomProjection } from './conversation-marker'
import { agentRoomId } from './room-agent'

const OWNER = '@owner:test'
const AGENT = '@agent:test'
const A = '!a:test'
const B = '!b:test'
const C = '!c:test'

function events(roomId: string, role?: 'main' | 'earlier', at = 1, main = B, sender = OWNER): IStateEventWithRoomId[] {
  const state = (type: string, key: string, content: Record<string, unknown>) => ({
    type, state_key: key, room_id: roomId, sender: OWNER, content,
    event_id: `$${type}-${key}`, origin_server_ts: 1
  })

  const values = [
    state(EventType.RoomCreate, '', { type: MATRIX_ASSISTANT_ROOM_TYPE }),
    state(EventType.RoomEncryption, '', { algorithm: 'm.megolm.v1.aes-sha2' }),
    state(EventType.RoomHistoryVisibility, '', { history_visibility: 'joined' }),
    state(EventType.RoomMember, OWNER, { membership: 'join' }),
    state(EventType.RoomMember, AGENT, { membership: 'join' })
  ]

  if (role) {
    values.push({ ...state(CONVERSATION_STATE_TYPE, '', { v: 1, role, main: role === 'main' ? roomId : main, at }), sender })
  }

  return values
}

/** Real MatrixClient methods with only the HTTP service replaced. */
function server(rooms: Record<string, IStateEventWithRoomId[]>) {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: OWNER })
  const failures = new Map<string, unknown>()
  const joined = { rooms: Object.keys(rooms), error: undefined as unknown }

  const http = vi.spyOn(client.http, 'authedRequest').mockImplementation(async (_method, path) => {
    if (path === '/joined_rooms') {
      if (joined.error) {throw joined.error}

      return { joined_rooms: joined.rooms }
    }

    const room = decodeURIComponent(path.split('/')[2]!)

    if (failures.has(room)) {throw failures.get(room)}

    return rooms[room]
  })

  return { client, failures, joined, http }
}

function projection(roomId: string, marker?: ConversationRoomProjection['conversation']): ConversationRoomProjection {
  return {
    id: roomId, name: roomId, membership: 'join', encrypted: true, roomType: MATRIX_ASSISTANT_ROOM_TYPE,
    agentPrincipal: 'agent', participants: [{ userId: OWNER, membership: 'join' }, { userId: AGENT, membership: 'join' }],
    conversation: marker, conversationOwnerId: OWNER
  }
}

describe('real private-room conversation reader', () => {
  it('selects marked main, refuses Earlier and stray turns, and preserves display reads', async () => {
    const { client } = server({ [A]: events(A, 'earlier'), [C]: events(C), [B]: events(B, 'main') })
    expect(await findAssistantRoom(client, { ownerId: OWNER, agentId: AGENT })).toBe(B)
    await expect(readAssistantRoom(client, { roomId: B, ownerId: OWNER, agentId: AGENT, forTurn: true })).resolves.toBeUndefined()

    for (const roomId of [A, C]) {
      await expect(readAssistantRoom(client, { roomId, ownerId: OWNER, agentId: AGENT, forTurn: true }))
        .rejects.toMatchObject({ code: 'matrix_earlier_conversation', roomId, main: B })
      await expect(readAssistantRoom(client, { roomId, ownerId: OWNER, agentId: AGENT })).resolves.toBeUndefined()
    }

    expect(await readConversationMarker(client, { roomId: A, ownerId: OWNER, agentId: AGENT }))
      .toEqual({ role: 'earlier', main: B, at: 1 })
  })

  it('refuses explicit Earlier even if its main is not reachable (frozen v1 rule)', async () => {
    const { client } = server({ [A]: events(A, 'earlier') })
    await expect(readAssistantRoom(client, { roomId: A, ownerId: OWNER, agentId: AGENT, forTurn: true }))
      .rejects.toBeInstanceOf(EarlierConversationError)
    expect(await findAssistantRoom(client, { ownerId: OWNER, agentId: AGENT })).toBe(A)
  })

  it('keeps legacy sorted discovery when all rooms are unmarked', async () => {
    const { client } = server({ [C]: events(C), [B]: events(B), [A]: events(A) })
    expect(await findAssistantRoom(client, { ownerId: OWNER, agentId: AGENT })).toBe(A)
    await expect(readAssistantRoom(client, { roomId: C, ownerId: OWNER, agentId: AGENT, forTurn: true })).resolves.toBeUndefined()
  })

  it('elects greatest timestamp, then lowest room ID, and refuses raced losers', async () => {
    const rooms = { [A]: events(A, 'main', 2), [B]: events(B, 'main', 3), [C]: events(C, 'main', 3) }
    const { client } = server(rooms)
    expect(await findAssistantRoom(client, { ownerId: OWNER, agentId: AGENT })).toBe(B)
    await expect(readAssistantRoom(client, { roomId: C, ownerId: OWNER, agentId: AGENT, forTurn: true }))
      .rejects.toMatchObject({ code: 'matrix_earlier_conversation', main: B })
  })

  it('checks membership and room policy before trusting an owner-sent marker', async () => {
    const group = events(A, 'main', 100)
    group[0]!.content = {}
    const former = events(B, 'main', 100)
    former.push({ ...former[3]!, state_key: '@former:test', content: { membership: 'leave' } })
    const { client } = server({ [A]: group, [B]: former, [C]: events(C) })
    expect(await findAssistantRoom(client, { ownerId: OWNER, agentId: AGENT })).toBe(C)
    await expect(readConversationMarker(client, { roomId: B, ownerId: OWNER, agentId: AGENT }))
      .rejects.toThrow('matrix_private_assistant_room_required')
  })

  it('treats forged/invalid/empty markers as unmarked and strips extra reader fields', async () => {
    const forged = events(A, 'main', 100, A, AGENT)
    const valid = events(B, 'main', 2)
    Object.assign(valid.at(-1)!.content, { title: 'ignored reader field', thread: 'future' })
    const { client } = server({ [A]: forged, [B]: valid, [C]: events(C) })
    expect(await readConversationMarker(client, { roomId: A, ownerId: OWNER, agentId: AGENT })).toBeNull()
    expect(await readConversationMarker(client, { roomId: B, ownerId: OWNER, agentId: AGENT }))
      .toEqual({ role: 'main', main: B, at: 2 })
    expect(await findAssistantRoom(client, { ownerId: OWNER, agentId: AGENT })).toBe(B)

    for (const content of [{}, { v: 1, role: 'main', main: C, at: NaN }, { v: 1, role: 'main', main: A, at: 1 }]) {
      expect(conversationMarkerFromState([{ ...valid.at(-1)!, content }], { roomId: B, ownerId: OWNER })).toBeNull()
    }
  })

  it.each(['M_FORBIDDEN', 'M_NOT_FOUND'])('excludes a definitively unreachable main (%s)', async errcode => {
    const { client, failures } = server({ [A]: events(A), [B]: events(B, 'main', 2) })
    failures.set(B, { errcode })
    expect(await findAssistantRoom(client, { ownerId: OWNER, agentId: AGENT })).toBe(A)
  })

  it('does not return null or legacy after an initial transient read', async () => {
    const { client, failures } = server({ [A]: events(A), [B]: events(B, 'main', 2) })
    failures.set(B, new TypeError('fetch failed'))
    await expect(findAssistantRoom(client, { ownerId: OWNER, agentId: AGENT }))
      .rejects.toMatchObject({ code: 'matrix_conversation_unavailable' })
  })

  it('keeps the whole previous election on partial reads and changes it only after a successful retry', async () => {
    const rooms = { [A]: events(A), [B]: events(B, 'main', 2), [C]: events(C) }
    const { client, failures } = server(rooms)
    expect(await findAssistantRoom(client, { ownerId: OWNER, agentId: AGENT })).toBe(B)
    rooms[C] = events(C, 'main', 3)
    failures.set(B, new TypeError('fetch failed'))
    expect(await findAssistantRoom(client, { ownerId: OWNER, agentId: AGENT })).toBe(B)
    await expect(readAssistantRoom(client, { roomId: A, ownerId: OWNER, agentId: AGENT, forTurn: true }))
      .rejects.toMatchObject({ code: 'matrix_earlier_conversation', main: B })
    failures.clear()
    expect(await findAssistantRoom(client, { ownerId: OWNER, agentId: AGENT })).toBe(C)
  })

  it('keeps the previous legacy choice when a joined-room read fails; a fresh client fails closed', async () => {
    const { client, joined } = server({ [B]: events(B), [A]: events(A) })
    expect(await findAssistantRoom(client, { ownerId: OWNER, agentId: AGENT })).toBe(A)
    joined.error = new TypeError('fetch failed')
    expect(await findAssistantRoom(client, { ownerId: OWNER, agentId: AGENT })).toBe(A)
    const fresh = server({ [A]: events(A) })
    fresh.joined.error = new TypeError('fetch failed')
    await expect(findAssistantRoom(fresh.client, { ownerId: OWNER, agentId: AGENT }))
      .rejects.toMatchObject({ code: 'matrix_conversation_unavailable' })
  })

  it('does not turn a raw marker read failure into null', async () => {
    const { client, failures } = server({ [A]: events(A) })
    failures.set(A, new TypeError('fetch failed'))
    await expect(readConversationMarker(client, { roomId: A, ownerId: OWNER, agentId: AGENT })).rejects.toThrow('fetch failed')
  })
})

describe('projected conversation selection', () => {
  it('gives the same main to roster selection as the authoritative reader', () => {
    const rooms = [projection(A), projection(B, { role: 'main', main: B, at: 2 }), projection(C, { role: 'earlier', main: A, at: 1 })]
    expect(resolveProjectedConversation(rooms, OWNER, AGENT).main).toBe(B)
    const snapshot = { rooms, identity: { userId: OWNER, deviceId: 'owner-device' }, agents: [{ principal: 'agent', userId: AGENT }] }
    expect(agentRoomId(snapshot as never, 'agent')).toBe(B)
  })

  it('keeps the existing roster order when unmarked and ignores group marker projections', () => {
    const group = { ...projection(C, { role: 'main', main: C, at: 10 }), roomType: undefined }
    const rooms = [projection(B), projection(A), group]
    const snapshot = { rooms, identity: { userId: OWNER, deviceId: 'owner-device' }, agents: [{ principal: 'agent', userId: AGENT }] }
    expect(resolveProjectedConversation(rooms, OWNER, AGENT).source).toBe('legacy')
    expect(agentRoomId(snapshot as never, 'agent')).toBe(B)
  })

  it('classifies only explicit server denials as unreachable', () => {
    expect(conversationReadFailure({ errcode: 'M_FORBIDDEN' })).toBe('unreachable')
    expect(conversationReadFailure({ errcode: 'M_UNKNOWN', httpStatus: 403 })).toBe('transient')
    expect(conversationReadFailure(new Error('M_FORBIDDEN'))).toBe('transient')
  })

  it('ignores a marker projected by an agent SDK instead of the owner SDK', () => {
    const forged = { ...projection(B, { role: 'main', main: B, at: 1 }), conversationOwnerId: AGENT }
    expect(resolveProjectedConversation([projection(A), forged], OWNER, AGENT).source).toBe('legacy')
  })

  it('opens the main in place of a chat that is no longer it, and nowhere else', () => {
    // The 0.20 move: the old main is marked earlier and the new plain room is the main.
    const moved = [projection(A, { role: 'earlier', main: B, at: 2 }), projection(B, { role: 'main', main: B, at: 2 })]
    expect(conversationMainInstead(moved, OWNER, AGENT, A)).toBe(B)
    expect(conversationMainInstead(moved, OWNER, AGENT, B)).toBeUndefined()
    // An older main whose earlier marker has not arrived yet, and an unmarked chat beside a main.
    const older = [projection(A, { role: 'main', main: A, at: 1 }), projection(B, { role: 'main', main: B, at: 2 })]
    expect(conversationMainInstead(older, OWNER, AGENT, A)).toBe(B)
    expect(conversationMainInstead([projection(C), ...moved], OWNER, AGENT, C)).toBe(B)
    // Before any mark, a group, a forged marker, another agent's view, or no room: stay.
    expect(conversationMainInstead([projection(A), projection(B)], OWNER, AGENT, A)).toBeUndefined()
    const group = { ...projection(C), roomType: undefined }
    expect(conversationMainInstead([group, ...moved], OWNER, AGENT, C)).toBeUndefined()
    const forged = [projection(A), { ...projection(B, { role: 'main', main: B, at: 2 }), conversationOwnerId: AGENT }]
    expect(conversationMainInstead(forged, OWNER, AGENT, A)).toBeUndefined()
    expect(conversationMainInstead(moved, OWNER, '@other:test', A)).toBeUndefined()
    expect(conversationMainInstead(moved, OWNER, AGENT, null)).toBeUndefined()
  })
})
