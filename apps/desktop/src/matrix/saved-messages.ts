import { EventType, type MatrixClient, MatrixEvent, Method, type Room } from 'matrix-js-sdk'

import type { MatrixIdentity } from '../../shared/matrix'
import {
  companyChannelRoomBinding,
  companyConversationRoomBinding
} from '../../shared/matrix-company-channel-room'
import {
  MATRIX_SAVED_MESSAGE_SNIPPET_MAX,
  MATRIX_SAVED_MESSAGES_ACCOUNT_DATA,
  type MatrixSavedMessageOpenResult,
  type MatrixSavedMessagePointer,
  type MatrixSavedMessagesContent,
  type MatrixSavedMessagesSnapshot,
  type MatrixSavedMessageView,
  parseMatrixSavedMessages,
  updateMatrixSavedMessages
} from '../../shared/matrix-saved-messages'

import { historyMessageText } from './history-message-text'
import { matrixMessage } from './message'
import { matrixReadableRoomName } from './person-name'

declare module 'matrix-js-sdk' {
  interface AccountDataEvents {
    'com.atum.saved_messages': MatrixSavedMessagesContent
  }
}

const batchSize = 8
const eventIdPattern = /^\$[!-~]{1,1023}$/u

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function roomBinding(room: Room): { companyId: string; roomKind: 'channel' | 'conversation' } | null {
  if (room.getMyMembership() !== 'join') {
    return null
  }

  const creation = room.currentState.getStateEvents(EventType.RoomCreate, '')

  if (!creation || Array.isArray(creation)) {
    return null
  }

  const channel = companyChannelRoomBinding(creation.getContent(), creation.getSender())

  if (channel) {
    return { companyId: channel.companyId, roomKind: 'channel' }
  }

  const conversation = companyConversationRoomBinding(creation.getContent(), creation.getSender())

  return conversation ? { companyId: conversation.companyId, roomKind: 'conversation' } : null
}

function snippet(value: string): string {
  const text = historyMessageText(value).trim()
  const characters = [...text]

  return characters.length > MATRIX_SAVED_MESSAGE_SNIPPET_MAX
    ? `${characters.slice(0, MATRIX_SAVED_MESSAGE_SNIPPET_MAX).join('')}…`
    : text
}

async function exactMessage(client: MatrixClient, room: Room, eventId: string): Promise<MatrixEvent | null> {
  let event = room.findEventById(eventId)

  if (!event) {
    event = new MatrixEvent(await client.fetchRoomEvent(room.roomId, eventId))
  }

  if (event.isEncrypted()) {
    await client.decryptEventIfNeeded(event)
  }

  return event.getId() === eventId && event.getRoomId() === room.roomId &&
    event.getType() === EventType.RoomMessage && !event.isRedacted() && !event.isDecryptionFailure()
    ? event
    : null
}

function current(active: () => boolean, client: MatrixClient, identity: MatrixIdentity): boolean {
  return active() && client.getUserId() === identity.userId && client.getDeviceId() === identity.deviceId
}

/** Private Saved messages: sync projects the pointers; every mutation and open revalidates server state. */
export function matrixSavedMessages(
  client: MatrixClient,
  identity: MatrixIdentity,
  active: () => boolean,
  now: () => number = Date.now
) {
  let pending = false

  const fresh = () => client.http
    .authedRequest<unknown>(
      Method.Get,
      `/user/${encodeURIComponent(client.getSafeUserId())}/account_data/${MATRIX_SAVED_MESSAGES_ACCOUNT_DATA}`
    )
    .catch(error => {
      if (error?.errcode === 'M_NOT_FOUND') {
        return undefined
      }

      throw error
    })

  const cached = () => client.getAccountData(MATRIX_SAVED_MESSAGES_ACCOUNT_DATA)?.getContent()

  const requireCurrent = () => {
    if (!current(active, client, identity)) {
      throw new Error('matrix_saved_messages_stale')
    }
  }

  const requireContent = (raw: unknown) => {
    const parsed = parseMatrixSavedMessages(raw)

    if (!parsed) {
      throw new Error('matrix_saved_messages_readonly')
    }

    return parsed
  }

  const resolve = async (saved: MatrixSavedMessagePointer): Promise<MatrixSavedMessageView> => {
    try {
      requireCurrent()
      const room = client.getRoom(saved.room_id)
      const binding = room ? roomBinding(room) : null

      if (!room || !binding) {
        return { ...saved, available: false }
      }

      const event = await exactMessage(client, room, saved.event_id)

      requireCurrent()

      if (!event || !roomBinding(room)) {
        return { ...saved, available: false }
      }

      const projected = matrixMessage(
        event,
        identity.userId,
        new Set(client.getIgnoredUsers()),
        room,
        false,
        !room.hasEncryptionStateEvent()
      )

      const body = projected && !projected.redacted && !projected.decryptionFailed
        ? snippet(projected.body)
        : ''

      if (!projected || !body) {
        return { ...saved, available: false }
      }

      return {
        ...saved,
        available: true,
        companyId: binding.companyId,
        roomName: matrixReadableRoomName(room.name),
        roomKind: binding.roomKind,
        senderName: room.getMember(projected.sender)?.name ?? projected.sender,
        own: projected.own,
        body,
        sentAt: projected.timestamp,
        ...(projected.threadRootId ? { threadRootId: projected.threadRootId } : {})
      }
    } catch {
      return { ...saved, available: false }
    }
  }

  return {
    snapshot(ready: boolean): MatrixSavedMessagesSnapshot {
      const parsed = parseMatrixSavedMessages(cached())

      return { records: parsed?.messages ?? [], writable: ready && parsed !== null }
    },

    async change(input: { roomId: string; eventId: string; saved: boolean }): Promise<void> {
      requireCurrent()

      if (pending) {
        throw new Error('matrix_saved_messages_pending')
      }

      pending = true

      try {
        if (input.saved) {
          const room = client.getRoom(input.roomId)
          const event = room && roomBinding(room) ? await exactMessage(client, room, input.eventId) : null

          if (!room || !event || !roomBinding(room)) {
            throw new Error('matrix_saved_message_unavailable')
          }

          requireCurrent()
        }

        const raw = await fresh()
        const content = requireContent(raw)

        const next = updateMatrixSavedMessages(content, {
          room_id: input.roomId,
          event_id: input.eventId
        }, input.saved, now())

        requireCurrent()

        if (next !== content) {
          await client.setAccountDataRaw(MATRIX_SAVED_MESSAGES_ACCOUNT_DATA, {
            ...(record(raw) ? raw : {}),
            version: 1,
            messages: next.messages
          })
          requireCurrent()
        }
      } finally {
        pending = false
      }
    },

    async read(): Promise<MatrixSavedMessageView[]> {
      requireCurrent()
      const content = requireContent(await fresh())
      const results: MatrixSavedMessageView[] = []

      for (let index = 0; index < content.messages.length; index += batchSize) {
        results.push(...await Promise.all(content.messages.slice(index, index + batchSize).map(resolve)))
      }

      requireCurrent()

      return results
    },

    async open(input: { roomId: string; eventId: string }): Promise<MatrixSavedMessageOpenResult> {
      requireCurrent()
      const content = requireContent(await fresh())

      if (!content.messages.some(saved => saved.room_id === input.roomId && saved.event_id === input.eventId)) {
        throw new Error('matrix_saved_message_unavailable')
      }

      const room = client.getRoom(input.roomId)

      if (!room || !roomBinding(room)) {
        throw new Error('matrix_saved_message_unavailable')
      }

      const event = await exactMessage(client, room, input.eventId)

      requireCurrent()

      if (!event || !roomBinding(room)) {
        throw new Error('matrix_saved_message_unavailable')
      }

      const currentContent = requireContent(await fresh())

      requireCurrent()

      if (!currentContent.messages.some(saved => saved.room_id === input.roomId && saved.event_id === input.eventId)) {
        throw new Error('matrix_saved_message_unavailable')
      }

      const thread = event.getContent()['m.relates_to']

      const threadRootId = record(thread) && thread.rel_type === 'm.thread' &&
        typeof thread.event_id === 'string' && eventIdPattern.test(thread.event_id)
        ? thread.event_id
        : undefined

      if (threadRootId === input.eventId) {
        throw new Error('matrix_saved_message_unavailable')
      }

      return threadRootId ? { threadRootId } : {}
    }
  }
}
