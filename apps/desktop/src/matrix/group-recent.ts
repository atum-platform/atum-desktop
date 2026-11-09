import { Direction, EventType, type MatrixClient, MatrixEvent, MsgType } from 'matrix-js-sdk'

import { MATRIX_GOOGLE_PROVENANCE_KEY } from '../../shared/matrix-google-tools'
import { matrixGroupMode } from '../../shared/matrix-group-room'
import { matrixReplyWords } from '../../shared/matrix-turn-intake'
import { type ContextEvent, projectRecentContext, type RoomMember } from '../../shared/room-participation'
import type { GroupRecentRead, GroupRecentTarget } from '../../shared/room-participation/recent'

import { readGroupRoom } from './assistant-room'
import { knownPlainRoom } from './plain-room'
import { matrixReplyRoot } from './reply-relation'
import { trustedMatrixSender } from './sender-trust'

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export async function readGroupRecent(
  client: MatrixClient,
  input: GroupRecentTarget,
  active: () => boolean = () => true
): Promise<GroupRecentRead> {
  if (input.window !== 'meeting' || !input.ownAgentIds.includes(input.viewerAgentId)) {
    throw new Error('matrix_group_room_required')
  }

  // Validate the frozen limits before any network read.
  projectRecentContext(input, 'meeting', [])
  const deadline = Date.now() + input.limits.deadlineMs
  let done = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const live = () => !done && active() && Date.now() < deadline

  const check = () => {
    if (!live()) {
      throw new Error(Date.now() >= deadline ? 'matrix_context_timeout' : 'matrix_room_unreadable')
    }
  }

  const members = async () => {
    check()

    const room = await readGroupRoom(
      client,
      { roomId: input.roomId, ownerId: input.ownerId, agentId: input.viewerAgentId },
      live
    )

    check()

    if (matrixGroupMode(room.members, input.ownerId, input.ownAgentIds) !== 'meeting') {
      throw new Error('matrix_group_room_required')
    }

    return room.members
  }

  const work = async (): Promise<GroupRecentRead> => {
    const initial = await members()
    const joined = new Set(initial.filter(member => member.membership === 'join').map(member => member.userId))
    const crypto = client.getCrypto()
    // Plain only when the crypto store agrees too (plain-room.ts). No answer in time fails the
    // read: a plain group read as encrypted would hand the turn a context with nothing in it.
    const synced = client.getRoom(input.roomId)
    const plain = Boolean(synced && (await knownPlainRoom(client, synced, 'matrix_room_unreadable')))
    const wireType = plain ? EventType.RoomMessage : EventType.RoomMessageEncrypted

    if (!crypto && !plain) {
      throw new Error('matrix_room_unreadable')
    }

    const devices = crypto && !plain ? await crypto.getUserDeviceInfo([...joined], true) : new Map()
    check()

    const displayName = (userId: string) => {
      const name = client.getRoom(input.roomId)?.getMember(userId)?.name

      return [...(name?.trim() && name !== userId ? name : userId === input.ownerId ? 'Owner' : 'Assistant')]
        .slice(0, 255)
        .join('')
    }

    const events: ContextEvent[] = []
    const seen = new Set<string>()
    const tokens = new Set<string>()
    let from: string | null = null
    let stop = false
    let foundTrigger = input.purpose !== 'routing'

    for (let page = 0; page < input.limits.pages && !stop; page++) {
      check()
      const batch = await client.createMessagesRequest(input.roomId, from, 50, Direction.Backward)
      check()

      if (!Array.isArray(batch.chunk) || batch.chunk.length > 50) {
        throw new Error('matrix_room_unreadable')
      }

      for (const raw of batch.chunk) {
        check()

        if (raw.room_id !== input.roomId || typeof raw.event_id !== 'string' || !raw.event_id.startsWith('$')) {
          throw new Error('matrix_room_unreadable')
        }

        if (seen.has(raw.event_id)) {
          continue
        }

        seen.add(raw.event_id)

        if (!foundTrigger) {
          if (raw.event_id === input.excludeEventId) {
            foundTrigger = true
          }

          continue
        }

        if (raw.event_id === input.excludeEventId || !joined.has(raw.sender)) {
          continue
        }

        if (raw.type !== EventType.RoomMessageEncrypted && raw.type !== EventType.RoomMessage) {
          continue
        }

        if (
          raw.type === EventType.RoomMessage &&
          ((raw.content?.msgtype !== MsgType.Text && raw.content?.msgtype !== MsgType.Notice) ||
            raw.content?.['m.relates_to']?.rel_type)
        ) {
          continue
        }

        const event = new MatrixEvent(raw)

        const fact: ContextEvent = {
          eventId: raw.event_id,
          senderRef: raw.sender,
          displayName: displayName(raw.sender),
          trust: raw.sender === input.ownerId ? 'owner' : raw.sender === input.viewerAgentId ? 'self' : 'own_assistant',
          text: '',
          at: event.getTs(),
          msgtype: 'm.text',
          verified: false,
          decrypted: false
        }

        try {
          if (raw.type !== wireType || event.isRedacted()) {
            throw new Error('unreadable')
          }

          if (!plain) {
            await client.decryptEventIfNeeded(event)
            check()
          }

          if (event.isDecryptionFailure() || event.isRedacted()) {
            throw new Error('unreadable')
          }

          const content = event.getContent()

          // Filter non-text before sender checks: these are not context gaps.
          if (
            event.getType() !== EventType.RoomMessage ||
            (content.msgtype !== MsgType.Text && content.msgtype !== MsgType.Notice) ||
            content['m.relates_to']?.rel_type ||
            typeof content.body !== 'string' ||
            !content.body.trim()
          ) {
            continue
          }

          const device = plain
            ? undefined
            : [...(devices.get(raw.sender)?.values() ?? [])].find(
                item =>
                  item.getIdentityKey() === event.getSenderKey() &&
                  item.getFingerprint() === event.getClaimedEd25519Key()
              )

          const trust = device ? await crypto!.getDeviceVerificationStatus(raw.sender, device.deviceId) : null

          if (
            (!plain && !trustedMatrixSender(trust, await crypto!.getEncryptionInfoForEvent(event))) ||
            !Number.isSafeInteger(fact.at) ||
            fact.at < 0
          ) {
            throw new Error('unverified')
          }

          check()
          fact.verified = true
          fact.decrypted = true
          fact.msgtype = content.msgtype as 'm.text' | 'm.notice'
          fact.text = matrixReplyRoot(content) ? matrixReplyWords(content.body) : content.body

          if (!fact.text.trim()) {
            continue
          }

          if (input.purpose === 'routing' && googleProvenance(content)) {
            // Treat protected Google-derived text as an unreadable gap. It must influence neither
            // routing state nor a model prompt, while preserving the fact that room history has a hole.
            fact.verified = false
            fact.decrypted = false
            fact.text = ''
            events.push(fact)

            continue
          }

          events.push(fact)

          if (input.purpose !== 'routing' && raw.sender === input.viewerAgentId) {
            stop = true

            break
          }
        } catch {
          check()
          events.push(fact)
        }
      }

      if (stop || !batch.end) {
        break
      }

      if (tokens.has(batch.end)) {
        throw new Error('matrix_room_unreadable')
      }

      tokens.add(batch.end)
      from = batch.end
    }

    if (!foundTrigger) {
      throw new Error('matrix_room_unreadable')
    }

    const final = await members()

    // Encryption was turned on while the group was read: what was read as plain no longer counts.
    const after = client.getRoom(input.roomId)

    if (plain && !(after && (await knownPlainRoom(client, after, 'matrix_room_unreadable')))) {
      throw new Error('matrix_room_unreadable')
    }

    const signature = (rows: typeof final) =>
      rows
        .map(row => `${row.userId}:${row.membership}`)
        .sort()
        .join('\n')

    if (signature(initial) !== signature(final)) {
      throw new Error('matrix_room_unreadable')
    }

    const context = projectRecentContext(input, 'meeting', events.reverse())

    if (context.status !== 'ok') {
      throw new Error('matrix_group_room_required')
    }

    return {
      roomId: input.roomId,
      viewerAgentId: input.viewerAgentId,
      members: final.map(member => ({
        userId: member.userId,
        displayName: displayName(member.userId),
        membership: member.membership as RoomMember['membership']
      })),
      context
    }
  }

  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('matrix_context_timeout')), input.limits.deadlineMs)
      })
    ])
  } catch (error) {
    if (
      error instanceof Error &&
      ['matrix_group_room_required', 'matrix_room_unreadable', 'matrix_context_timeout'].includes(error.message)
    ) {
      throw error
    }

    throw new Error('matrix_room_unreadable')
  } finally {
    done = true
    clearTimeout(timer)
  }
}

function googleProvenance(content: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(content, MATRIX_GOOGLE_PROVENANCE_KEY)
}
