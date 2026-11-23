import { Direction, type MatrixClient } from 'matrix-js-sdk'

import { confirmedPlainRoom } from './plain-room'

/** Bounded background SDK paging; never selects a room or scrolls its UI timeline. */
export async function readWorkHistory(
  client: MatrixClient,
  input: { boundaryOnly?: boolean; roomId: string; before: string; after: string | null; floor: string | null }
) {
  const room = client.getRoom(input.roomId)

  if (!room || !(await confirmedPlainRoom(client, room))) {
    throw new Error('work_history_not_plain')
  }

  const owner = client.getUserId()
  const members = room.getJoinedMembers().map(member => member.userId)

  if (!owner || members.length !== 2 || !members.includes(owner)) {
    throw new Error('work_history_not_dm')
  }

  if (input.boundaryOnly) {
    const page = await client.createMessagesRequest(input.roomId, null, 1, Direction.Backward)
    const boundary = page.chunk[0]?.event_id

    if (!boundary) {throw new Error('work_history_boundary_unavailable')}

    return { messages: [], omittedMessages: 0, omittedBytes: 0, truncated: false, boundary }
  }

  const agent = members.find(id => id !== owner)!
  let cursor: string | null = null
  let upper = false
  let lower = false

  const result: {
    itemId: string
    role: 'user' | 'assistant'
    text: string
    kind: string
    threadId: string
    runId: null
    providerThreadId: null
    status: string
    replyTo?: string
  }[] = []

  const seen = new Set<string>()
  let bytes = 0
  let omittedMessages = 0
  let omittedBytes = 0
  let truncated = false

  for (let n = 0; n < 20; n++) {
    const page = await client.createMessagesRequest(input.roomId, cursor, 100, Direction.Backward)

    for (const event of page.chunk) {
      const id = event.event_id

      if (!id || seen.has(id)) {
        continue
      }

      seen.add(id)

      if (id === input.before) {
        upper = true

        if (id === input.floor || id === input.after) { lower = true;

 break }

        continue
      }

      if (!upper) {
        continue
      }

      if (id === input.after || id === input.floor) {
        lower = true

        break
      }

      if (
        event.type !== 'm.room.message' ||
        event.unsigned?.redacted_because ||
        !['m.text', 'm.notice'].includes(String(event.content?.msgtype)) ||
        typeof event.content?.body !== 'string' ||
        event.content?.['m.relates_to']?.rel_type === 'm.replace'
      ) {
        continue
      }

      if (event.sender !== owner && event.sender !== agent) {
        continue
      }

      bytes += new TextEncoder().encode(event.content.body).byteLength

      if (bytes > 1_000_000) {
        omittedMessages++
        omittedBytes += new TextEncoder().encode(event.content.body).byteLength
        truncated = true

        continue
      }

      result.push({
        itemId: id,
        ...(event.content['m.relates_to']?.['m.in_reply_to']?.event_id
          ? { replyTo: String(event.content['m.relates_to']['m.in_reply_to'].event_id) } : {}),
        role: event.sender === owner ? 'user' : 'assistant',
        text: event.content.body,
        kind: 'message',
        threadId: input.roomId,
        runId: null,
        providerThreadId: null,
        status: 'completed'
      })
    }

    if (upper && lower) {
      break
    }

    if (!page.end || page.end === cursor || !page.chunk.length) {
      if (!input.after && !input.floor) {
        lower = true
      }

      break
    }

    cursor = page.end

    if (n === 19 && upper) {truncated = true}
  }

  // The upper cutoff proves this bounded suffix precedes the request.

  if (!upper || (!lower && !truncated)) {
    throw new Error('work_history_boundary_unavailable')
  }

  return { messages: result.reverse(), omittedMessages, omittedBytes, truncated }
}
