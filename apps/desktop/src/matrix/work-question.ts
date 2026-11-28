import { Direction, EventType, type MatrixClient, MsgType } from 'matrix-js-sdk'

import { MATRIX_PLAIN_SENDER_DEVICE, type MatrixInvocationMessage } from '../../shared/matrix'
import { MATRIX_FIND_TURN } from '../../shared/matrix-turn'
import { WORK_LEARNING_MSGTYPE, WORK_REQUEST_KEY, type WorkLearningRequest, workAnswer } from '../../shared/work-question'

import { confirmedPlainRoom } from './plain-room'
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
    learning?: WorkLearningRequest
  }
): Promise<string> {
  const content = {
    msgtype: q.learning ? WORK_LEARNING_MSGTYPE : MsgType.Text,
    body: q.question,
    'm.mentions': { user_ids: [q.agentId] },
    [WORK_REQUEST_KEY]: {
      v: 1, request_id: q.requestId, source: 'work',
      intent: q.learning ? 'learning' : 'question', thread_id: q.threadId,
      ...q.learning
    }
  }

  // Matrix permits custom message types. Older assistants ignore this Work-only message.
  return (await client.sendEvent(q.roomId, EventType.RoomMessage, content as { msgtype: MsgType.Text; body: string }, q.transactionId)).event_id
}

interface WorkAnswerQuery {
  roomId: string
  agentId: string
  eventId: string
  requestId: string
}

interface WorkAnswerBody {
  body: string
  dataClass: 'non_google' | 'google' | 'unknown'
  learning?: unknown
}

export async function readWorkAnswer(client: MatrixClient, q: WorkAnswerQuery): Promise<WorkAnswerBody | undefined> {
  const deadline = Date.now() + MATRIX_FIND_TURN.deadlineMs
  let timer: number | ReturnType<typeof setTimeout> | undefined

  const expired = new Promise<undefined>(resolve => {
    timer = setTimeout(resolve, MATRIX_FIND_TURN.deadlineMs)
  })

  try {
    return await Promise.race([scanWorkAnswer(client, q, deadline), expired])
  } catch {
    // Offline, a missing room or a pending decryption can recover on a later poll.
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

async function scanWorkAnswer(
  client: MatrixClient,
  q: WorkAnswerQuery,
  deadline: number
): Promise<WorkAnswerBody | undefined> {
  const room = client.getRoom(q.roomId)

  if (room?.getMyMembership() !== 'join') {
    return undefined
  }

  const plain = await confirmedPlainRoom(client, room)
  const wireType = plain ? EventType.RoomMessage : EventType.RoomMessageEncrypted
  const seen = new Set<string>()
  const pieces = new Map<number, WorkAnswerBody>()
  let total: number | undefined
  let conflict = false

  const inspect = async (id: string | undefined, sender: string | undefined, type: string) => {
    if (!id?.startsWith('$') || seen.has(id) || sender !== q.agentId || type !== wireType || Date.now() >= deadline) {
      return
    }

    seen.add(id)
    let message: MatrixInvocationMessage

    try {
      message = await readMatrixInvocation(client, { roomId: q.roomId, eventId: id })
    } catch {
      return
    }

    const marker = workAnswer(message.content.workAnswer)

    if (!marker || marker.request_id !== q.requestId || !trustedWorkReply(message, q.roomId, q.agentId, q.eventId)) {
      return
    }

    if ((total !== undefined && total !== marker.parts) || pieces.has(marker.part)) {
      conflict = true

      return
    }

    total = marker.parts

    // Unknown runtime outcomes carry a positive protection marker too. Preserve
    // that classification without ever letting a marker certify a clean answer.
    const dataClass =
      message.content.googleProtected && marker.data_class === 'non_google' ? 'google' : marker.data_class

    pieces.set(marker.part, { body: message.content.body, dataClass,
      ...(marker.parts === 1 && marker.learning !== undefined ? { learning: marker.learning } : {}) })
  }

  for (const event of [...room.getLiveTimeline().getEvents()].reverse().slice(0, MATRIX_FIND_TURN.pageSize)) {
    if (event.getId() === q.eventId) {
      break
    }

    await inspect(event.getId(), event.getSender(), event.getWireType())
  }

  // Rich replies need not be indexed by the relations API. Follow the same
  // bounded server-tail strategy as readMatrixResult.
  let from: string | null = null
  const tokens = new Set<string>()
  let reachedRoot = false

  for (let page = 0; page < MATRIX_FIND_TURN.pages && !reachedRoot && !conflict && pieces.size !== total; page++) {
    if (Date.now() >= deadline) {
      return undefined
    }

    const batch = await client.createMessagesRequest(q.roomId, from, MATRIX_FIND_TURN.pageSize, Direction.Backward)

    if (batch.chunk.length > MATRIX_FIND_TURN.pageSize) {
      return undefined
    }

    for (const event of batch.chunk) {
      if (event.event_id === q.eventId) {
        reachedRoot = true

        break
      }

      await inspect(event.event_id, event.sender, event.type)
    }

    if (!batch.end || tokens.has(batch.end)) {
      break
    }

    tokens.add(batch.end)
    from = batch.end
  }

  const currentRoom = client.getRoom(q.roomId)

  if (
    conflict ||
    total === undefined ||
    pieces.size !== total ||
    currentRoom?.getMyMembership() !== 'join' ||
    (await confirmedPlainRoom(client, currentRoom)) !== plain
  ) {
    return undefined
  }

  const ordered = [...pieces.entries()].sort(([a], [b]) => a - b).map(([, part]) => part)

  const dataClass = ordered.some(part => part.dataClass === 'google')
    ? 'google'
    : ordered.some(part => part.dataClass === 'unknown')
      ? 'unknown'
      : 'non_google'

  const learning = ordered.length === 1 ? ordered[0]?.learning : undefined

  return { body: ordered.map(part => part.body).join('\n'), dataClass,
    ...(learning === undefined ? {} : { learning }) }
}
