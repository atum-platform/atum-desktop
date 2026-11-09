import { createClient, EventType, type MatrixClient, MatrixEvent, ReceiptType, Room } from 'matrix-js-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MATRIX_AGENT_ADMITTED_MAX,
  MATRIX_AGENT_SEEN_ARRIVAL_MS,
  MATRIX_AGENT_TYPING_TIMEOUT_MS,
  sendMatrixAgentSeen,
  sendMatrixAgentTyping
} from './agent-signals'

const owner = '@owner:test'
const agent = '@atum:test'
const roomId = '!assistant:test'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** The agent's real SDK client and Room models; only the receipt and typing requests are replaced. */
function fixture(members: string[] = [owner, agent]) {
  const client: MatrixClient = createClient({ baseUrl: 'https://matrix.test', userId: agent, deviceId: 'ATUM' })
  const room = new Room(roomId, client, agent)
  room.currentState.setStateEvents(
    members.map(
      userId =>
        new MatrixEvent({
          type: EventType.RoomMember,
          state_key: userId,
          room_id: roomId,
          sender: userId,
          content: { membership: 'join' }
        })
    )
  )
  room.updateMyMembership('join')
  client.store.storeRoom(room)
  const receipt = vi.spyOn(client, 'sendReceipt').mockResolvedValue({})
  const typing = vi.spyOn(client, 'sendTyping').mockResolvedValue({})
  let ts = 0

  const add = (id: string, sender: string, content: Record<string, unknown>, type: string = EventType.RoomMessage) => {
    room.addLiveEvents(
      [new MatrixEvent({ type, room_id: roomId, event_id: id, sender, origin_server_ts: ++ts, content })],
      { addToState: false }
    )
  }

  const said = (id: string, body = 'Hi') => add(id, owner, { msgtype: 'm.text', body })

  const answered = (id: string, question: string, msgtype = 'm.text') =>
    add(id, agent, { msgtype, body: 'Answer', 'm.relates_to': { 'm.in_reply_to': { event_id: question } } })

  const readAt = (id: string) =>
    room.addReceipt(
      new MatrixEvent({
        type: EventType.Receipt,
        room_id: roomId,
        content: { [id]: { [ReceiptType.Read]: { [agent]: { ts: 1 } } } }
      })
    )

  const seen = (eventId: string, admitted: string[] = [], active?: () => boolean) =>
    sendMatrixAgentSeen(client, { kind: 'agentSeen', roomId, eventId, ownerId: owner, admitted }, active)

  const joins = (userId: string) =>
    room.currentState.setStateEvents([
      new MatrixEvent({
        type: EventType.RoomMember,
        state_key: userId,
        room_id: roomId,
        sender: userId,
        content: { membership: 'join' }
      })
    ])

  return { client, room, receipt, typing, add, said, answered, readAt, seen, joins }
}

describe("the agent's read receipt (agent-turns v1.1 Presentation signals)", () => {
  it('acknowledges a message it took up with one public, unthreaded m.read on that message', async () => {
    const { said, answered, seen, receipt } = fixture()
    said('$q1')
    answered('$a1', '$q1')
    said('$q2')

    await expect(seen('$q2')).resolves.toBe('$q2')
    expect(receipt).toHaveBeenCalledOnce()
    const [event, type, body, unthreaded] = receipt.mock.calls[0]!
    expect(event.getId()).toBe('$q2')
    expect(type).toBe(ReceiptType.Read)
    expect(body).toEqual({})
    expect(unthreaded).toBe(true)
  })

  it('never places the receipt past an earlier message it declined without a word: it holds just before it', async () => {
    const { said, answered, seen, receipt } = fixture()
    said('$q1')
    answered('$a1', '$q1')
    said('$denied')
    said('$q3')

    // Receipts are cumulative: $q3 would also mark $denied seen, so it stops at the answer before.
    await expect(seen('$q3')).resolves.toBe('$a1')
    expect(receipt.mock.calls[0]![0].getId()).toBe('$a1')
  })

  it('sends nothing when the declined message is the first one after its receipt', async () => {
    const { said, seen, receipt, readAt, answered } = fixture()
    said('$q1')
    answered('$a1', '$q1')
    readAt('$a1')
    said('$denied')
    said('$q3')

    await expect(seen('$q3')).resolves.toBeNull()
    expect(receipt).not.toHaveBeenCalled()
  })

  it('treats a message it has since spoken after as behind it, so an old silent decline never holds Seen forever', async () => {
    const { said, answered, seen } = fixture()
    said('$declinedLongAgo')
    said('$q1')
    answered('$a1', '$q1')
    said('$q2')

    await expect(seen('$q2', ['$q2'])).resolves.toBe('$q2')
  })

  it('moves past a declined message once it has a status line, and past messages this Mac is still answering', async () => {
    const { said, answered, seen, receipt } = fixture()
    said('$held')
    answered('$notice', '$held', 'm.notice')
    said('$running')
    said('$q3')

    await expect(seen('$q3', ['$running'])).resolves.toBe('$q3')
    expect(receipt.mock.calls[0]![0].getId()).toBe('$q3')
  })

  it('advances once the earlier message is answered (main asks again after each answer)', async () => {
    const { said, answered, seen } = fixture()
    said('$q1')
    said('$q2')
    await expect(seen('$q2')).resolves.toBeNull()

    answered('$a1', '$q1')
    await expect(seen('$q2')).resolves.toBe('$q2')
  })

  it("counts an unreadable owner message, but not the owner's edits or reactions", async () => {
    const { add, said, seen } = fixture()
    said('$q1')
    add('$edit', owner, {
      msgtype: 'm.text',
      body: '* fixed',
      'm.relates_to': { rel_type: 'm.replace', event_id: '$q1' }
    })
    add(
      '$react',
      owner,
      { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$q1', key: '👍' } },
      EventType.Reaction
    )
    said('$q2')
    await expect(seen('$q2', ['$q1'])).resolves.toBe('$q2')

    add('$secret', owner, { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x' }, EventType.RoomMessageEncrypted)
    said('$q3')
    await expect(seen('$q3', ['$q1', '$q2'])).resolves.toBe('$q2')
  })

  it('leaves a receipt already at or past the message, and an event outside the live timeline, alone', async () => {
    const { said, seen, readAt, receipt } = fixture()
    said('$q1')
    said('$q2')
    readAt('$q2')

    await expect(seen('$q1')).resolves.toBeNull()
    await expect(seen('$q2')).resolves.toBeNull()

    vi.useFakeTimers()
    const unknown = seen('$unknown')
    await vi.advanceTimersByTimeAsync(MATRIX_AGENT_SEEN_ARRIVAL_MS)
    await expect(unknown).resolves.toBeNull()
    expect(receipt).not.toHaveBeenCalled()
  })

  it("waits for the message to reach the agent's own timeline: main asks the moment the owner's device posted it", async () => {
    const { said, answered, seen, receipt } = fixture()
    said('$q1')
    answered('$a1', '$q1')

    // The owner's device has the event id; the agent's sync has not brought the message yet.
    const pending = seen('$q2', ['$q2'])
    await Promise.resolve()
    expect(receipt).not.toHaveBeenCalled()

    said('$q2')
    await expect(pending).resolves.toBe('$q2')
    expect(receipt).toHaveBeenCalledOnce()
    expect(receipt.mock.calls[0]![0].getId()).toBe('$q2')
  })

  it('gives up quietly when the message never arrives, and names only the addressed message in a chat that became a group meanwhile', async () => {
    vi.useFakeTimers()
    const { said, seen, receipt, joins } = fixture()

    const never = seen('$never')
    await vi.advanceTimersByTimeAsync(MATRIX_AGENT_SEEN_ARRIVAL_MS)
    await expect(never).resolves.toBeNull()

    const pending = seen('$q1', ['$q1'])
    joins('@linh:test')
    said('$q1')
    await expect(pending).resolves.toBe('$q1')
    expect(receipt).toHaveBeenCalledOnce()
    expect(receipt.mock.calls[0]![0].getId()).toBe('$q1')
  })

  it('a stopped SDK sends nothing after its wait', async () => {
    const { said, seen, receipt } = fixture()
    said('$q1')

    await expect(seen('$q1', ['$q1'], () => false)).rejects.toThrow('matrix_sdk_stopped')
    expect(receipt).not.toHaveBeenCalled()
  })

  it('reaches a question once its answer is posted, even past an earlier message declined without a word', async () => {
    const { said, answered, seen, receipt } = fixture()
    said('$q1')
    answered('$a1', '$q1')
    said('$declined')
    said('$q2')

    // Taken up: the silent decline holds the receipt at the answer before it.
    await expect(seen('$q2', ['$q2'])).resolves.toBe('$a1')

    // Answered: the agent has spoken after the decline, so it is behind the conversation
    // (agent-turns v1.1 P2), and the receipt reaches the question, never past it.
    answered('$a2', '$q2')
    await expect(seen('$q2', ['$q2'])).resolves.toBe('$q2')
    expect(receipt.mock.calls.map(([event]) => event.getId())).toEqual(['$a1', '$q2'])
  })

  it('in a group acknowledges only the owner message addressed to it, never an earlier unrelated one', async () => {
    const group = fixture([owner, agent, '@linh:test'])
    group.add('$linh1', '@linh:test', { msgtype: 'm.text', body: 'Lunch?' })
    group.said('$unrelated')
    group.said('$addressed', '@Atum what is on today?')
    group.add('$linh2', '@linh:test', { msgtype: 'm.text', body: 'later' })

    await expect(group.seen('$addressed')).resolves.toBe('$addressed')
    expect(group.receipt).toHaveBeenCalledOnce()
    const [event, type, body, unthreaded] = group.receipt.mock.calls[0]!
    expect(event.getId()).toBe('$addressed')
    expect([type, body, unthreaded]).toEqual([ReceiptType.Read, {}, true])

    // Nothing for a message that is not the owner's, one already at or behind its receipt, or one it never had.
    group.readAt('$addressed')
    await expect(group.seen('$addressed')).resolves.toBeNull()
    await expect(group.seen('$linh2')).resolves.toBeNull()
    expect(group.receipt).toHaveBeenCalledOnce()
  })

  it('never acknowledges for its own messages as owner, or with a malformed list', async () => {
    const { client, said, seen, receipt } = fixture()
    said('$q1')
    await expect(
      sendMatrixAgentSeen(client, { kind: 'agentSeen', roomId, eventId: '$q1', ownerId: agent, admitted: [] })
    ).rejects.toThrow('matrix_command_invalid')
    await expect(seen('$q1', ['not-an-event'])).rejects.toThrow('matrix_command_invalid')
    await expect(
      seen(
        '$q1',
        Array.from({ length: MATRIX_AGENT_ADMITTED_MAX + 1 }, (_, index) => `$e${index}`)
      )
    ).rejects.toThrow('matrix_command_invalid')
    expect(receipt).not.toHaveBeenCalled()
  })
})

describe("the agent's typing notice", () => {
  it('says typing in its own chat with a 30 second timeout, and stops', async () => {
    const { client, typing } = fixture()

    await sendMatrixAgentTyping(client, { kind: 'agentTyping', roomId, ownerId: owner, typing: true })
    await sendMatrixAgentTyping(client, { kind: 'agentTyping', roomId, ownerId: owner, typing: false })
    // A stuck notice (a Mac that crashed mid-turn) clears on its own within 30 seconds.
    expect(MATRIX_AGENT_TYPING_TIMEOUT_MS).toBeLessThanOrEqual(30_000)
    expect(typing.mock.calls).toEqual([
      [roomId, true, MATRIX_AGENT_TYPING_TIMEOUT_MS],
      [roomId, false, MATRIX_AGENT_TYPING_TIMEOUT_MS]
    ])
  })

  it('types in a joined group, but never in a room the owner is not in', async () => {
    const group = fixture([owner, agent, '@linh:test'])
    await expect(
      sendMatrixAgentTyping(group.client, { kind: 'agentTyping', roomId, ownerId: owner, typing: true })
    ).resolves.toBeNull()

    const alone = fixture([agent])
    await expect(
      sendMatrixAgentTyping(alone.client, { kind: 'agentTyping', roomId, ownerId: owner, typing: true })
    ).rejects.toThrow('matrix_assistant_room_required')
    expect(group.typing).toHaveBeenCalledWith(roomId, true, MATRIX_AGENT_TYPING_TIMEOUT_MS)
    expect(alone.typing).not.toHaveBeenCalled()
  })
})
