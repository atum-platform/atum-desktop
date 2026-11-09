import {EventType, type MatrixClient, MatrixEvent, type Room} from 'matrix-js-sdk'
import {describe, expect, it, vi} from 'vitest'

import assignments from '../../contracts/atum-company-ai-v1/fixtures/assignment-work.response.json'
import {MATRIX_COMPANY_CHANNEL_BINDING, MATRIX_COMPANY_CHANNEL_TYPE} from '../../shared/matrix-company-channel-room'

import {companyAIMentionMatch, companyAIMentionUserIds, insertCompanyAIMention} from './company-ai-mention'
import {readCompanyAIEvent, watchCompanyAI} from './company-ai-sdk'
import {sendMatrixText} from './message-commands'

const assignment = assignments.items[0]!
const binding = {owner: assignment.owner, agentUserId: assignment.agentUserId, agentPrincipal: assignment.agentPrincipal}
const companyId = binding.owner.companyId
const channelId = '00000000-0000-4000-8000-9d7f33689e72'
const roomId = '!composer:atum.example'
const eventId = '$composer'

// Use the exact picker -> mention-id builder -> Matrix send path used by app.tsx.
// SDK/network responses are local fixtures; no model or production calls.
async function fixture(target = binding.agentUserId) {
  const text = insertCompanyAIMention('@Chief', companyAIMentionMatch('@Chief')!) + 'synthetic question'
  const mentions = companyAIMentionUserIds(text, {schemaVersion: 1, companyId,
    agent: {principal: binding.agentPrincipal, userId: target, displayName: 'Chief of Staff'},
    enabled: true, revision: 1, state: 'ready', canManage: false})
  let content: Record<string, unknown> = {}
  const sendEvent = vi.fn(async (_room: string, _type: string, value: Record<string, unknown>) => {
    content = value
    return {event_id: eventId}
  })
  const room = {roomId, getMyMembership: () => 'join', getType: () => MATRIX_COMPANY_CHANNEL_TYPE,
    getLiveTimeline: () => ({getEvents: () => []}), currentState: {
      getStateEvents: (type: string) => type === EventType.RoomCreate ? {
        getContent: () => ({type: MATRIX_COMPANY_CHANNEL_TYPE, room_version: '11',
          [MATRIX_COMPANY_CHANNEL_BINDING]: {companyId, channelId}}),
        getSender: () => '@manager:atum.example', getRoomId: () => roomId
      } : null
    }} as unknown as Room
  await sendMatrixText({sendEvent} as unknown as MatrixClient, room, text, mentions)
  const event = new MatrixEvent({type: EventType.RoomMessage, room_id: roomId, event_id: eventId,
    sender: '@human:atum.example', origin_server_ts: 2_000, content})
  const client = {getRooms: () => [room], getRoom: () => room,
    fetchRoomEvent: async () => event.getEffectiveEvent(),
    createMessagesRequest: async () => ({start: 'before', end: 'after', chunk: [event.getEffectiveEvent()]})
  } as unknown as MatrixClient
  const scan = await watchCompanyAI(client, {companyId, agentUserId: binding.agentUserId,
    catchupAfterMs: 1_000, checkpoint: {positions: [{roomId, token: 'before'}]}})
  return {client, content, scan}
}

describe('Team Space composer event -> mention send -> watch hint', () => {
  it('sends the real MXID, discovers it and reads the canonical event', async () => {
    const {client, content, scan} = await fixture()
    expect(content).toEqual({msgtype: 'm.text', body: '@Chief of Staff synthetic question',
      'm.mentions': {user_ids: [binding.agentUserId]}})
    expect(content).not.toHaveProperty('formatted_body')
    expect(scan.hints).toEqual([{roomId, eventId, atMs: 2_000}])
    expect(scan.diagnostics).toMatchObject({bound: 1, pages: 1, scanned: 1, matched: 1, checkpointMoved: 1})
    await expect(readCompanyAIEvent(client, {companyId, roomId, eventId})).resolves.toMatchObject({eventId})
  })

  it('rejects a display alias even when the visible body is identical', async () => {
    const {scan} = await fixture('@display-alias:atum.example')
    expect(scan.hints).toEqual([])
    expect(scan.diagnostics).toMatchObject({scanned: 1, matched: 0, notMentioned: 1})
  })
})
