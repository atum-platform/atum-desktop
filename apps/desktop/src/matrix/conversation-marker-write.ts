import { EventType, type MatrixClient, Method } from 'matrix-js-sdk'

import {
  buildConversationMarker,
  CONVERSATION_STATE_TYPE,
  conversationAppVersionType,
  parseConversationAppVersion
} from '../../shared/agent-conversation'
import { AGENT_ONE_CONVERSATION } from '../../shared/agent-conversation/enabled'
import type { ConversationState, ConversationWrite } from '../../shared/agent-conversation/types'
import type { ConversationCandidateRead } from '../../shared/agent-conversation/view'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import { readAssistantRoom } from './assistant-room'
import { conversationMarkerFromState, conversationReadFailure } from './conversation-marker'

declare module 'matrix-js-sdk' {
  interface StateEvents {
    'io.atum.conversation': ConversationState | Record<string, never>
  }
  interface AccountDataEvents {
    [key: `io.atum.app_version.${string}`]: { v: 1; version: string; at: number }
  }
}

interface ConversationOwnerRoom {
  roomId: string
  ownerId: string
  agentId: string
}

/** Native composition supplies these SDK-observed room IDs, never renderer input. */
export interface ConversationCandidateInput {
  ownerId: string
  agentId: string
  knownMain?: string
  knownRooms?: readonly string[]
}

/** The owner SDK is the only writer; preflight uses current server authority. */
export async function preflightConversationRoom(
  client: MatrixClient,
  input: ConversationOwnerRoom,
  active = () => true
): Promise<boolean> {
  requireOwner(client, input.ownerId, active)
  await readAssistantRoom(client, { ...input, allowInvite: true }, active)
  const state = await client.roomState(input.roomId)
  requireOwner(client, input.ownerId, active)
  const power = state.find(event => event.type === EventType.RoomPowerLevels && event.state_key === '')?.content
  const creator = state.find(event => event.type === EventType.RoomCreate && event.state_key === '')?.sender
  const level = power?.users?.[input.ownerId] ?? power?.users_default ?? (creator === input.ownerId ? 100 : 0)
  const required = power?.events?.[CONVERSATION_STATE_TYPE] ?? power?.state_default ?? 50

  return (
    typeof level === 'number' &&
    typeof required === 'number' &&
    Number.isFinite(level) &&
    Number.isFinite(required) &&
    level >= required
  )
}

export async function writeConversationMarker(
  client: MatrixClient,
  input: ConversationOwnerRoom & ConversationWrite,
  active = () => true
): Promise<void> {
  if (!AGENT_ONE_CONVERSATION) {
    throw new Error('matrix_conversation_disabled')
  }
  const state = input.content as ConversationState

  const content =
    Object.keys(input.content).length === 0
      ? {}
      : buildConversationMarker({ roomId: input.roomId, role: state.role, main: state.main, at: state.at })

  if (!(await preflightConversationRoom(client, input, active))) {
    throw new Error('matrix_conversation_not_writable')
  }
  requireOwner(client, input.ownerId, active)
  await client.sendStateEvent(input.roomId, CONVERSATION_STATE_TYPE, content, '')
  requireOwner(client, input.ownerId, active)
}

/** Each enrolled Mac writes its own record; main supplies the trusted device ID. */
export async function conversationAppVersions(
  client: MatrixClient,
  input: {
    ownerId: string
    devices: string[]
    own?: { deviceServiceId: string; version: string; at: number }
  },
  active = () => true
) {
  requireOwner(client, input.ownerId, active)

  if (input.own) {
    const content = parseConversationAppVersion({ v: 1, version: input.own.version, at: input.own.at })

    if (!content) {
      throw new Error('matrix_invalid_conversation_version')
    }
    await client.setAccountDataRaw(
      conversationAppVersionType(input.own.deviceServiceId) as `io.atum.app_version.${string}`,
      content
    )
    requireOwner(client, input.ownerId, active)
  }

  return Promise.all(
    input.devices.map(async id => {
      const content = await client.getAccountDataFromServer(
        conversationAppVersionType(id) as `io.atum.app_version.${string}`
      )
      requireOwner(client, input.ownerId, active)

      return parseConversationAppVersion(content)
    })
  )
}

/** Owner-message ranking reads server metadata, including encrypted event senders.
 * No message body leaves this command or enters unencrypted room state. */
export async function readConversationCandidates(
  client: MatrixClient,
  input: ConversationCandidateInput,
  active = () => true
): Promise<ConversationCandidateRead[]> {
  requireOwner(client, input.ownerId, active)
  let joined: string[]
  try {
    joined = (await client.getJoinedRooms()).joined_rooms
  } catch {
    requireOwner(client, input.ownerId, active)
    return [{ roomId: input.knownMain ?? '', read: 'transient', writable: false }]
  }
  const candidates: ConversationCandidateRead[] = []
  const known = [input.knownMain, ...(input.knownRooms ?? [])].filter(
    (roomId): roomId is string => typeof roomId === 'string' && roomId.length > 0
  )

  for (const roomId of [...new Set([...joined, ...known])].sort()) {
    requireOwner(client, input.ownerId, active)
    const synced = client.getRoom(roomId)

    if (
      synced?.currentState.getStateEvents(EventType.RoomCreate, '') &&
      synced.getType() !== MATRIX_ASSISTANT_ROOM_TYPE
    ) {
      continue
    }

    let privateValidated = false
    try {
      await readAssistantRoom(client, { ...input, roomId, allowInvite: true }, active)
      privateValidated = true
      const state = await client.roomState(roomId)
      const encrypted = state.some(event => event.type === EventType.RoomEncryption && event.state_key === '')
      const writable = await preflightConversationRoom(client, { ...input, roomId }, active)
      const decryption =
        roomId === input.knownMain ? await knownMainDecryptionRead(client, roomId, input.ownerId, active) : null

      if (decryption) {
        candidates.push({ roomId, read: decryption, writable: false, encrypted })

        continue
      }

      const readAt = async (senders?: string[]) => {
        const result = await client.http.authedRequest<{ chunk?: Array<{ origin_server_ts?: number }> }>(
          Method.Get,
          `/rooms/${encodeURIComponent(roomId)}/messages`,
          {
            dir: 'b',
            limit: 1,
            filter: JSON.stringify({ types: ['m.room.message', 'm.room.encrypted'], ...(senders ? { senders } : {}) })
          }
        )

        requireOwner(client, input.ownerId, active)

        return result.chunk?.[0]?.origin_server_ts
      }

      const ownerAt = await readAt([input.ownerId])
      const activityAt = await readAt()
      const createdAt = state.find(
        event => event.type === EventType.RoomCreate && event.state_key === ''
      )?.origin_server_ts
      requireOwner(client, input.ownerId, active)
      candidates.push({
        roomId,
        read: 'readable',
        writable,
        encrypted,
        marker: conversationMarkerFromState(state, { roomId, ownerId: input.ownerId }),
        ...(ownerAt !== undefined ? { ownerAt } : {}),
        ...(activityAt !== undefined ? { activityAt } : {}),
        ...(createdAt !== undefined ? { createdAt } : {})
      })
    } catch (error) {
      requireOwner(client, input.ownerId, active)

      if (error instanceof Error && error.message === 'matrix_private_assistant_room_required') {
        continue
      }
      const read = conversationReadFailure(error)
      // A denied unknown room may be a human/group room. It must not become an
      // assistant migration input or have its scheduled-job origins moved.
      if (read === 'unreachable' && !privateValidated && !known.includes(roomId)) {
        continue
      }
      candidates.push({ roomId, read, writable: false })
    }
  }

  return candidates
}

/**
 * We only inspect the SDK's classified decryption result for the native-known
 * main room. Server ranking requests keep using encrypted envelopes and never
 * expose message content. Waiting-for-key outcomes stay transient.
 */
async function knownMainDecryptionRead(
  client: MatrixClient,
  roomId: string,
  ownerId: string,
  active: () => boolean
): Promise<'unreachable' | 'transient' | null> {
  const event = client
    .getRoom(roomId)
    ?.getLiveTimeline()
    .getEvents()
    .slice()
    .reverse()
    .find(candidate => candidate.getWireType() === EventType.RoomMessageEncrypted)

  if (!event) {
    return null
  }
  let failure: unknown

  try {
    await client.decryptEventIfNeeded(event)
  } catch (error) {
    failure = error
  }

  requireOwner(client, ownerId, active)
  if (!event.isDecryptionFailure() && !failure) {
    return null
  }
  const code = event.decryptionFailureReason ?? decryptionFailureCode(failure)

  if (!code) {
    return null
  }

  return lostBackupKey(code) ? 'unreachable' : 'transient'
}

function decryptionFailureCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

function lostBackupKey(code: unknown): boolean {
  return code === 'HISTORICAL_MESSAGE_NO_KEY_BACKUP' || code === 'HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED'
}

function requireOwner(client: MatrixClient, ownerId: string, active: () => boolean) {
  if (!active() || !ownerId || client.getUserId() !== ownerId) {
    throw new Error('matrix_conversation_owner_required')
  }
}
