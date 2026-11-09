import { createClient, EventType } from 'matrix-js-sdk'
import { expect, it, vi } from 'vitest'

import {
  admitPrivateConversationPublication,
  attentionConversationRoom,
  CONVERSATION_STATE_TYPE,
  ConversationUnavailableError,
  EarlierConversationError,
  firstRunConversationRoom,
  requireAssistantConversation,
  rosterConversationRoom,
  taskFilesConversationStatus
} from '../../shared/agent-conversation'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'
import { readAssistantRoom } from '../../src/matrix/assistant-room'

import { sendAssistantMessage } from './assistant-send'
import { ConversationRequestActivity } from './conversation/activity'

const ownerId = '@owner:test'
const agentId = '@agent:test'
const A = '!a:test'
const B = '!b:test'
const C = '!c:test'

type ReadCommand = Parameters<typeof readAssistantRoom>[1] & { kind: 'readAssistantRoom' }

function assistantRead() {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: ownerId })
  vi.spyOn(client.http, 'authedRequest').mockImplementation(async (_method, path) => {
    if (path === '/joined_rooms') {
      return { joined_rooms: [A, C, B] }
    }

    const roomId = decodeURIComponent(path.split('/')[2]!)

    const state: Array<{ type: string; state_key: string; content: Record<string, unknown> }> = [
      { type: EventType.RoomCreate, state_key: '', content: { type: MATRIX_ASSISTANT_ROOM_TYPE } },
      { type: EventType.RoomEncryption, state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
      { type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'joined' } },
      { type: EventType.RoomMember, state_key: ownerId, content: { membership: 'join' } },
      { type: EventType.RoomMember, state_key: agentId, content: { membership: 'join' } }
    ]

    if (roomId !== C) {
      state.push({ type: CONVERSATION_STATE_TYPE, state_key: '', content: { v: 1, role: roomId === B ? 'main' : 'earlier', main: B, at: 1 } })
    }

    return state.map(event => ({ ...event, sender: ownerId, room_id: roomId, event_id: '$state', origin_server_ts: 1 }))
  })

  const command = vi.fn((input: ReadCommand) => readAssistantRoom(client, input))

  const requireRoom = (roomId: string, options?: { forTurn?: boolean }) =>
    requireAssistantConversation(
      () => command({ kind: 'readAssistantRoom', roomId, ownerId, agentId, ...options }),
      () => true
    )

  return { command, requireRoom }
}

it('reads the current Matrix room before admitting a turn, preserving typed earlier-room refusals', async () => {
  const reader = assistantRead()

  for (const roomId of [A, C]) {
    await expect(reader.requireRoom(roomId, { forTurn: true })).rejects.toMatchObject({
      code: 'matrix_earlier_conversation', roomId, main: B
    })
    await expect(reader.requireRoom(roomId)).resolves.toBeUndefined()
  }

  await expect(reader.requireRoom(B, { forTurn: true })).resolves.toBeUndefined()
  expect(reader.command).toHaveBeenCalledWith(expect.objectContaining({ kind: 'readAssistantRoom', forTurn: true, ownerId, agentId }))
})

it('rejects a host that changed while the private room read was in flight', async () => {
  let current = true

  await expect(
    requireAssistantConversation(
      async () => {
        current = false
      },
      () => current
    )
  ).rejects.toThrow('matrix_not_ready')
})

it.each(['before', 'during'] as const)('refuses a question before publication when migration becomes pending %s the room read', async timing => {
  let pending = timing === 'before'
  const read = vi.fn(async () => { pending = true })
  const send = vi.fn(async () => '$question')
  const invoke = vi.fn(async () => ({ state: 'unknown' as const }))
  const release = vi.fn()
  await expect(sendAssistantMessage({
    check: () => requireAssistantConversation(read, () => true, () => pending), send, invoke, release
  })).rejects.toBeInstanceOf(ConversationUnavailableError)
  expect(read).toHaveBeenCalledTimes(timing === 'before' ? 0 : 1)
  expect(send).not.toHaveBeenCalled()
  expect(invoke).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalledOnce()
})

it('admits a main-room question while a read-only preview is in flight, then refuses it during a change', async () => {
  const reader = assistantRead()
  const hold = vi.fn()
  const release = vi.fn(async () => {})
  const activity = new ConversationRequestActivity({ hold, release })
  let complete!: () => void
  const pendingRead = new Promise<void>(resolve => { complete = resolve })
  const preview = activity.run('preview', () => pendingRead)
  await expect(requireAssistantConversation(() => reader.requireRoom(B, { forTurn: true }), () => true, () => activity.changing)).resolves.toBeUndefined()
  expect(hold).not.toHaveBeenCalled()
  complete()
  await preview
  expect(release).not.toHaveBeenCalled()

  let completeChange!: () => void
  const change = activity.run('change', () => new Promise<void>(resolve => { completeChange = resolve }))
  await expect(requireAssistantConversation(() => reader.requireRoom(B, { forTurn: true }), () => true, () => activity.changing)).rejects.toBeInstanceOf(ConversationUnavailableError)
  completeChange()
  await change
  expect(hold.mock.calls).toEqual([[true], [false]])
  expect(release).toHaveBeenCalledOnce()
})

it('refuses sending before question publication or invocation when the real room reader denies the turn', async () => {
  const reader = assistantRead()
  const send = vi.fn(async () => '$question')
  const invoke = vi.fn(async () => ({ state: 'unknown' as const }))
  const release = vi.fn()

  await expect(sendAssistantMessage({ check: () => reader.requireRoom(A, { forTurn: true }), send, invoke, release })).rejects.toBeInstanceOf(EarlierConversationError)
  expect(send).not.toHaveBeenCalled()
  expect(invoke).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalledOnce()
})

function projected() {
  return [A, B, C].map((id, index) => ({
    id,
    agentPrincipal: 'principal',
    lastActiveAt: index + 1,
    membership: 'join' as const
  }))
}

it.each([true, false])('keeps first-run in main and preserves legacy preferred/latest choice when marked=%s', marked => {
  const rooms = projected()
  const main = marked ? B : undefined

  expect(firstRunConversationRoom(rooms, main, A)?.id).toBe(marked ? B : A)
  expect(firstRunConversationRoom(rooms, main)?.id).toBe(marked ? B : C)
  expect(firstRunConversationRoom(rooms.filter(room => room.id !== B), main, A)?.id).toBe(marked ? undefined : A)
})

it.each([true, false])('keeps the marked main ahead of roster selection and legacy recency when marked=%s', marked => {
  const rooms = projected()
  expect(rosterConversationRoom(rooms, A, marked ? B : undefined)?.id).toBe(marked ? B : A)
  expect(rosterConversationRoom(rooms, undefined, marked ? B : undefined)?.id).toBe(marked ? B : C)
})

it.each([true, false])('opens marked main ahead of attention while preserving legacy listening choice when marked=%s', marked => {
  const rooms = projected()
  expect(
    attentionConversationRoom(rooms, { markedMain: marked ? B : undefined, listeningRoom: rooms[0], agentPrincipal: 'principal' })?.id
  ).toBe(marked ? B : A)
})

it.each([new EarlierConversationError(A, B), new ConversationUnavailableError()])('maps only expected task-file read refusals to unavailable: %s', async error => {
  await expect(taskFilesConversationStatus(async () => { throw error })).resolves.toEqual({ state: 'unavailable' })
})

it('keeps unexpected task-file read failures observable', async () => {
  const error = new Error('network failed')
  await expect(taskFilesConversationStatus(async () => { throw error })).rejects.toBe(error)
})

it('checks private result and notice publication, while group publication stays on its group admission path', async () => {
  const refusal = new EarlierConversationError(A, B)
  const check = vi.fn(async () => { throw refusal })

  for (const kind of ['publishResult', 'publishNotice']) {
    await expect(admitPrivateConversationPublication({ kind }, false, check)).rejects.toBe(refusal)
  }

  await expect(admitPrivateConversationPublication({ kind: 'publishResult' }, true, check)).resolves.toBeUndefined()
  expect(check).toHaveBeenCalledTimes(2)
})
