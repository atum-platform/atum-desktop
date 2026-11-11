import { Direction, EventType, type MatrixClient, MatrixEvent, MsgType } from 'matrix-js-sdk'

import { matrixRoomTextTooLong } from '../../shared/matrix'
import { isMatrixAgentClosedStatusCode } from '../../shared/matrix-agent-status-copy'
import { plainAgentRoom } from '../../shared/matrix-assistant-room'
import {
  MATRIX_CONTINUITY,
  type MatrixContinuityRead,
  type MatrixContinuityTarget
} from '../../shared/matrix-continuity'
import { matrixInterimMarker } from '../../shared/matrix-interim-marker'
import { matrixCronMarker, matrixTurnId, matrixTurnMarker } from '../../shared/matrix-turn'
import { matrixReplyWords } from '../../shared/matrix-turn-intake'

import { readAssistantRoom } from './assistant-room'
import { knownPlainRoom } from './plain-room'
import { matrixReplyRoot } from './reply-relation'
import { trustedMatrixSender } from './sender-trust'

/** Fresh server order, not timestamps or a renderer's currently visible list.
 * This read has no path to invocation hints, dispatch, tools or app providers.
 *
 * In the agent's plain chat (0.20) the owner's and the agent's messages arrive as sent and are
 * read like decrypted ones, with no device check (the homeserver authenticated the sender, owner
 * decision D1). In an encrypted chat a plaintext message stays a gap, as before. */
export async function readMatrixContinuity(
  client: MatrixClient,
  target: MatrixContinuityTarget
): Promise<MatrixContinuityRead> {
  const read: MatrixContinuityRead = {
    roomId: target.roomId,
    ownerId: target.ownerId,
    agentId: target.agentId,
    entries: [],
    reachedStop: false,
    gaps: 0,
    uncertainAgent: false
  }

  const deadline = Date.now() + MATRIX_CONTINUITY.deadlineMs
  let done = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const live = () => !done && Date.now() < deadline

  const check = () => {
    if (!live()) {
      throw new Error('matrix_continuity_unavailable')
    }
  }

  // A bounded read only seeds a new session (MatrixContinuityTarget.bounded). Once its first page
  // is in, paging ends this far before the deadline, so the newest dialogue it read still arrives
  // with the room re-checked in time; everything kept passed the same checks.
  const pagingEnds = target.bounded ? deadline - MATRIX_CONTINUITY.settleMs : Infinity
  const pagingOver = () => Date.now() >= pagingEnds

  /** The next page, or nothing once paging time is over (a late page is left unread). */
  const nextPage = async (request: ReturnType<MatrixClient['createMessagesRequest']>) => {
    if (!Number.isFinite(pagingEnds)) {
      return request
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    request.catch(() => undefined)

    try {
      return await Promise.race([
        request,
        new Promise<undefined>(resolve => {
          timer = setTimeout(resolve, Math.max(0, pagingEnds - Date.now()), undefined)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  const work = async () => {
    // Either participant's client may read the pair's room: the owner's Mac, or the agent's own
    // account (the cloud controller, whose only Matrix client is the agent's). Anyone else is refused.
    const reader = client.getUserId()

    if (reader !== target.ownerId && reader !== target.agentId) {
      throw new Error('matrix_continuity_unavailable')
    }

    await readAssistantRoom(client, target, live)
    const synced = client.getRoom(target.roomId)
    // Plain only when the crypto store agrees too (plain-room.ts). No answer in time fails the
    // read: a plain chat read as encrypted would look empty and drop the resumed conversation.
    const plain = Boolean(
      synced && plainAgentRoom(synced) && (await knownPlainRoom(client, synced, 'matrix_continuity_unavailable'))
    )

    const wireType = plain ? EventType.RoomMessage : EventType.RoomMessageEncrypted
    const crypto = client.getCrypto()

    if (!crypto && !plain) {
      throw new Error('matrix_continuity_unavailable')
    }

    const devices =
      crypto && !plain ? await crypto.getUserDeviceInfo([target.ownerId, target.agentId], true) : new Map()
    let before = !target.before
    let from: string | null = null
    const tokens = new Set<string>()
    const seen = new Set<string>()
    let stop = false

    for (let page = 0; page < MATRIX_CONTINUITY.pages && !stop; page++) {
      check()

      // Paging can end only after this question was found: the rest is what came before it.
      const clippable = page > 0 && before

      if (clippable && pagingOver()) {
        read.clipped = true

        break
      }

      const request = client.createMessagesRequest(target.roomId, from, MATRIX_CONTINUITY.pageSize, Direction.Backward)
      const batch = clippable ? await nextPage(request) : await request

      if (!batch) {
        read.clipped = true

        break
      }

      check()

      if (!Array.isArray(batch.chunk) || batch.chunk.length > MATRIX_CONTINUITY.pageSize) {
        throw new Error('matrix_continuity_unavailable')
      }

      for (const raw of batch.chunk) {
        check()

        if (clippable && pagingOver()) {
          read.clipped = true

          break
        }

        if (!before) {
          if (raw.event_id === target.before && raw.room_id === target.roomId) {
            before = true
          }

          continue
        }

        const sender = raw.sender

        if (sender !== target.ownerId && sender !== target.agentId) {
          continue
        }

        if (raw.type !== wireType) {
          // A message that did not arrive the way this room sends is never read (no downgrade).
          if (raw.type === EventType.RoomMessage || raw.type === EventType.RoomMessageEncrypted) {
            read.gaps++

            if (sender === target.agentId) {
              read.uncertainAgent = true
            }
          }

          continue
        }

        const event = new MatrixEvent(raw)
        const id = event.getId()

        if (event.getRoomId() !== target.roomId || !id?.startsWith('$') || seen.has(id)) {
          throw new Error('matrix_continuity_unavailable')
        }

        seen.add(id)

        try {
          if (event.isRedacted()) {
            throw new Error('redacted')
          }

          if (!plain) {
            await client.decryptEventIfNeeded(event)
            check()

            if (event.isDecryptionFailure() || event.isRedacted()) {
              throw new Error('unreadable')
            }

            const device = [...(devices.get(sender)?.values() ?? [])].find(
              item =>
                item.getIdentityKey() === event.getSenderKey() && item.getFingerprint() === event.getClaimedEd25519Key()
            )

            const trust = device ? await crypto!.getDeviceVerificationStatus(sender, device.deviceId) : null

            if (!trustedMatrixSender(trust, await crypto!.getEncryptionInfoForEvent(event))) {
              throw new Error('unverified')
            }
          }

          check()
          const content = event.getContent()

          if (target.excludeTurn && matrixTurnMarker(content) === target.excludeTurn) {
            continue
          }

          const relation = content['m.relates_to']

          if (
            event.getType() !== EventType.RoomMessage ||
            content.msgtype !== MsgType.Text ||
            relation?.rel_type === 'm.replace' ||
            typeof content.body !== 'string' ||
            !content.body.trim() ||
            matrixRoomTextTooLong(content.body)
          ) {
            read.gaps++

            continue
          }

          // The agent's own notice that closed a message without an answer ("couldn't confirm",
          // "failed", a limit) is not a turn and the session never saw it: neither dialogue nor an
          // answer another session gave, so it does not make the conversation's stored session
          // unusable (the cached prefix is kept). Only the agent's own, and only a closing code: an
          // answer carries codes of its own (saved_to_drive...), and progress (resuming_on_device)
          // is not a close, so neither is read past.
          if (
            sender === target.agentId &&
            id !== target.stopAt &&
            isMatrixAgentClosedStatusCode(content['io.atum.result']?.status)
          ) {
            continue
          }

          // The agent's interim remark (agent-turns/1.4) is its own words inside a turn the session
          // already ran: neither another turn nor a gap, so the stored session stays usable.
          if (sender === target.agentId && matrixInterimMarker(content)) {
            continue
          }

          // 1.7 file answers keep the legacy result invocation; chip identity alone is
          // presentation metadata and must never manufacture a continuity turn.
          const invocationId = matrixReplyRoot(content) && matrixTurnId(content['io.atum.result']?.invocation)

          if (sender === target.agentId && !invocationId && !matrixCronMarker(content)) {
            read.gaps++
            read.uncertainAgent = true

            continue
          }

          // Rich-reply fallback quotes are presentation, not another prior turn.
          const text = matrixReplyRoot(content) ? matrixReplyWords(content.body) : content.body

          if (!text.trim()) {
            read.gaps++

            continue
          }

          read.entries.push({
            eventId: id,
            role: sender === target.ownerId ? 'user' : 'assistant',
            text,
            ...(invocationId && sender === target.agentId ? { invocationId } : {})
          })

          if (id === target.stopAt) {
            read.reachedStop = true
            stop = true

            break
          }
        } catch {
          check()
          read.gaps++

          if (sender === target.agentId) {
            read.uncertainAgent = true
          }
        }
      }

      if (read.clipped) {
        break
      }

      if (!batch.end) {
        read.reachedStop = !target.stopAt || read.reachedStop

        break
      }

      if (tokens.has(batch.end)) {
        throw new Error('matrix_continuity_unavailable')
      }

      tokens.add(batch.end)
      from = batch.end
    }

    if (!before) {
      throw new Error('matrix_continuity_unavailable')
    }

    check()
    await readAssistantRoom(client, target, live)
    check()

    // Encryption was turned on while the history was read: what was read as plain no longer counts.
    const after = client.getRoom(target.roomId)

    if (plain && !(after && (await knownPlainRoom(client, after, 'matrix_continuity_unavailable')))) {
      throw new Error('matrix_continuity_unavailable')
    }

    return read
  }

  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('matrix_continuity_unavailable')), MATRIX_CONTINUITY.deadlineMs)
      })
    ])
  } finally {
    done = true
    clearTimeout(timer)
  }
}
