import { EventType, type MatrixClient, MsgType } from 'matrix-js-sdk'

import { MATRIX_PLAIN_SENDER_DEVICE, type MatrixInvocationMessage } from '../../shared/matrix'
import { WORK_REQUEST_KEY, workAnswer } from '../../shared/work-question'

import { readMatrixInvocation } from './read-invocation'

export function trustedWorkReply(m: MatrixInvocationMessage, room: string, agent: string, root: string): boolean {
  return (
    m.roomId === room &&
    m.sender === agent &&
    m.senderVerified &&
    m.content.msgtype === 'm.text' &&
    m.content.replyTo === root &&
    !m.thread &&
    !m.content.forwarded &&
    (m.roomPlain === true
      ? m.wireType === 'm.room.message' && m.senderDevice === MATRIX_PLAIN_SENDER_DEVICE
      : m.wireType === 'm.room.encrypted' && !!m.senderDevice && m.senderDevice !== MATRIX_PLAIN_SENDER_DEVICE)
  )
}

export async function sendWorkQuestion(
  client: MatrixClient,
  q: {
    roomId: string
    agentId: string
    question: string
    requestId: string
    threadId: string
    transactionId: string
  }
): Promise<string> {
  const content = {
    msgtype: MsgType.Text as const,
    body: q.question,
    'm.mentions': { user_ids: [q.agentId] },
    [WORK_REQUEST_KEY]: { v: 1, request_id: q.requestId, source: 'work', intent: 'question', thread_id: q.threadId }
  }

  return (await client.sendEvent(q.roomId, EventType.RoomMessage, content, q.transactionId)).event_id
}

export async function readWorkAnswer(
  client: MatrixClient,
  q: {
    roomId: string
    agentId: string
    eventId: string
    requestId: string
  }
): Promise<{ body: string; dataClass: 'non_google' | 'google' | 'unknown' } | undefined> {
  const room = client.getRoom(q.roomId)

  if (room?.getMyMembership() !== 'join') {
    throw new Error('work_room_unavailable')
  }

  const history = await client.roomInitialSync(q.roomId, 100)

  const ids = [
    ...new Set([
      ...(history.messages?.chunk ?? []).map(e => e.event_id),
      ...room
        .getLiveTimeline()
        .getEvents()
        .map(e => e.getId())
    ])
  ]

  for (const id of ids.reverse()) {
    if (!id) {
      continue
    }

    let m: MatrixInvocationMessage
    try {
      m = await readMatrixInvocation(client, { roomId: q.roomId, eventId: id })
    } catch {
      // Unrelated notices or undecryptable events must not hide a valid correlated answer.
      continue
    }
    const terminal = workAnswer(m.content.workAnswer)

    if (!trustedWorkReply(m, q.roomId, q.agentId, q.eventId) || !terminal || terminal.request_id !== q.requestId) {
      continue
    }

    const parts = terminal.parts ?? [id]

    if (!parts.includes(id) || new Set(parts).size !== parts.length) {
      continue
    }

    const messages = await Promise.all(
      parts.map(eventId => readMatrixInvocation(client, { roomId: q.roomId, eventId }))
    )

    if (messages.some(part => !trustedWorkReply(part, q.roomId, q.agentId, q.eventId))) {
      continue
    }

    // Every piece must be certified clean. A terminal marker never sanitizes protected parts.
    const dataClass = messages.some(part => part.content.googleProtected)
      ? 'google'
      : messages.every(part => {
            const marker = workAnswer(part.content.workAnswer)

            return marker?.request_id === q.requestId && marker.data_class === 'non_google'
          })
        ? 'non_google'
        : terminal.data_class === 'google'
          ? 'google'
          : 'unknown'

    return { body: messages.map(part => part.content.body).join('\n'), dataClass }
  }
}
