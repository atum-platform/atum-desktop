import type { ConversationMarker, ConversationRole, ConversationState } from './types'

export const CONVERSATION_STATE_TYPE = 'io.atum.conversation'

const roomIdPattern = /^![A-Za-z0-9_=/+.-]+:[A-Za-z0-9_.:-]+$/

const isRoomId = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 4 && value.length <= 255 && roomIdPattern.test(value)

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Sender identity is the trusted owner from the existing assistant-room policy.
 * Read/network failures must be classified by the adapter, never passed as null. */
export function parseConversationMarker(input: {
  roomId: string
  ownerId: string
  event: unknown
}): ConversationMarker | null {
  const { event, roomId, ownerId } = input

  if (
    !object(event) ||
    event.type !== CONVERSATION_STATE_TYPE ||
    event.state_key !== '' ||
    !ownerId ||
    event.sender !== ownerId ||
    !object(event.content)
  ) {
    return null
  }

  const { v, role, main, at } = event.content

  if (
    v !== 1 ||
    (role !== 'main' && role !== 'earlier') ||
    !isRoomId(main) ||
    typeof at !== 'number' ||
    !Number.isSafeInteger(at) ||
    at < 0 ||
    (role === 'main' && main !== roomId)
  ) {
    return null
  }

  return { role, main, at }
}

export function buildConversationMarker(input: {
  roomId: string
  role: ConversationRole
  main: string
  at: number
}): ConversationState {
  const { role, main, at } = input
  const content: ConversationState = { v: 1, role, main, at }

  if (
    !isRoomId(input.roomId) ||
    !parseConversationMarker({
      roomId: input.roomId,
      ownerId: 'owner',
      event: { type: CONVERSATION_STATE_TYPE, state_key: '', sender: 'owner', content }
    })
  ) {
    throw new Error('matrix_invalid_conversation_marker')
  }

  return content
}
