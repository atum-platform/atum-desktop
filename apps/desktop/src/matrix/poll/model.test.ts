import { createClient, MatrixEvent, Room } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'

import { matrixPollCommand, matrixPollView } from './model'

const owner = '@owner:test'
const voter = '@voter:test'
const roomId = '!group:test'

function fixture(undisclosed = true) {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: owner })
  const room = new Room(roomId, client, owner)
  room.updateMyMembership('join')
  const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$sent' })

  const fromServer = (eventId: string, type: string, content: object, sender: string, ts: number) =>
    new MatrixEvent({ room_id: roomId, event_id: eventId, type, content, sender, origin_server_ts: ts })

  const root = fromServer('$start', 'org.matrix.msc3381.poll.start', {
    'org.matrix.msc3381.poll.start': {
      question: { 'org.matrix.msc1767.text': 'Which day?' },
      kind: undisclosed ? 'org.matrix.msc3381.poll.undisclosed' : 'org.matrix.msc3381.poll.disclosed',
      max_selections: 1,
      answers: [
        { id: 'one', 'org.matrix.msc1767.text': 'Monday' },
        { id: 'two', 'org.matrix.msc1767.text': 'Friday' }
      ]
    },
    'org.matrix.msc1767.text': 'Which day?'
  }, owner, 10)

  const reference = { rel_type: 'm.reference', event_id: '$start' }

  const vote = (id: string, answer: string, sender: string, ts: number) =>
    fromServer(id, 'org.matrix.msc3381.poll.response', {
      'm.relates_to': reference, 'org.matrix.msc3381.poll.response': { answers: [answer] }
    }, sender, ts)

  const end = (sender: string) => fromServer('$end', 'org.matrix.msc3381.poll.end', {
    'm.relates_to': reference,
    'org.matrix.msc3381.poll.end': {},
    'org.matrix.msc1767.text': 'Poll closed'
  }, sender, 35)

  vi.spyOn(client, 'relations').mockResolvedValue({ events: [], originalEvent: root, nextBatch: null })
  const changed = vi.fn()

  return { client, room, send, root, vote, end, changed }
}

describe('Matrix poll timeline', () => {
  it('uses the latest response for each sender, hides running undisclosed results and excludes post-close votes', async () => {
    const { client, room, root, vote, end, changed } = fixture()
    await room.processPollEvents([root])
    await matrixPollCommand(client, room, owner, { kind: 'pollRead', roomId, eventId: '$start' }, changed)
    await room.processPollEvents([
      vote('$a', 'one', voter, 20),
      vote('$b', 'two', voter, 30),
      vote('$c', 'two', owner, 33),
      vote('$after', 'one', owner, 40)
    ])
    expect(matrixPollView(root, owner, room)?.answers.every(answer => answer.votes === undefined)).toBe(true)
    expect(matrixPollView(root, owner, room)?.selected).toEqual(['one'])

    await room.processPollEvents([end(owner)])
    const closed = matrixPollView(root, owner, room)
    expect(closed?.ended).toBe(true)
    expect(closed?.answers.map(answer => answer.votes)).toEqual([0, 2])
    expect(closed?.selected).toEqual(['two'])
    expect(closed?.canVote).toBeUndefined()
  })

  it('serializes create, replace vote and end using the interoperable proposal names', async () => {
    const { client, room, send, root, changed } = fixture(false)
    await room.processPollEvents([root])
    await matrixPollCommand(client, room, owner, { kind: 'pollCreate', roomId, question: 'Which day?', options: ['Monday', 'Friday'], undisclosed: false }, changed)
    await matrixPollCommand(client, room, owner, { kind: 'pollVote', roomId, eventId: '$start', answers: ['two'] }, changed)
    await matrixPollCommand(client, room, owner, { kind: 'pollEnd', roomId, eventId: '$start' }, changed)

    expect(send.mock.calls.map(call => call[1])).toEqual([
      'org.matrix.msc3381.poll.start', 'org.matrix.msc3381.poll.response', 'org.matrix.msc3381.poll.end'
    ])
    expect(send.mock.calls[1]?.[2]).toMatchObject({
      'm.relates_to': { rel_type: 'm.reference', event_id: '$start' },
      'org.matrix.msc3381.poll.response': { answers: ['two'] }
    })
    expect(send.mock.calls[2]?.[2]).toMatchObject({
      'm.relates_to': { rel_type: 'm.reference', event_id: '$start' }
    })
  })
})
