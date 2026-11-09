import { createClient, EventType } from 'matrix-js-sdk'
import { expect, it, vi } from 'vitest'

import { CONVERSATION_STATE_TYPE } from '../../shared/agent-conversation'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import { findAssistantRoom, readAssistantRoom, readConversationMarker } from './assistant-room'

vi.mock('../../shared/agent-conversation/enabled', () => ({ AGENT_ONE_CONVERSATION: false }))

it('rolls back turn refusal and first-valid discovery while retaining marker data', async () => {
  const ownerId = '@owner:test'
  const agentId = '@agent:test'
  const roomId = '!a:test'
  const main = '!z:test'
  const client = createClient({ baseUrl: 'https://matrix.test', userId: ownerId })

  const state = [
    { type: EventType.RoomCreate, state_key: '', content: { type: MATRIX_ASSISTANT_ROOM_TYPE } },
    { type: EventType.RoomEncryption, state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'joined' } },
    { type: EventType.RoomMember, state_key: ownerId, content: { membership: 'join' } },
    { type: EventType.RoomMember, state_key: agentId, content: { membership: 'join' } },
    { type: CONVERSATION_STATE_TYPE, state_key: '', content: { v: 1, role: 'earlier', main, at: 1 } }
  ].map(event => ({ ...event, sender: ownerId, room_id: roomId, event_id: '$state', origin_server_ts: 1 }))

  const http = vi.spyOn(client.http, 'authedRequest').mockImplementation(async (_method, path) => {
    if (path === '/joined_rooms') {return { joined_rooms: [main, roomId] }}

    if (path.includes(encodeURIComponent(roomId))) {return state}
    throw new Error('transient later-room failure')
  })

  await expect(readAssistantRoom(client, { roomId, ownerId, agentId, forTurn: true })).resolves.toBeUndefined()
  expect(await findAssistantRoom(client, { ownerId, agentId })).toBe(roomId)
  expect(await readConversationMarker(client, { roomId, ownerId, agentId })).toEqual({ role: 'earlier', main, at: 1 })
  expect(http.mock.calls.some(([, path]) => path.includes(encodeURIComponent(main)))).toBe(false)
})
