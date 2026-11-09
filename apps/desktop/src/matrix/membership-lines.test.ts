import { createClient, EventType, MatrixEvent, Room } from 'matrix-js-sdk'
import { describe, expect, it } from 'vitest'

import {
  MATRIX_COMPANY_CHANNEL_BINDING,
  MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
  MATRIX_COMPANY_CHANNEL_TYPE
} from '../../shared/matrix-company-channel-room'

import { matrixMembershipLine, matrixMembershipLines } from './membership-lines'

const MANAGER = '@manager:test'
const LINH = '@linh:test'
const BAO = '@bao:test'
const ROOM_ID = '!ops:test'

function room(binding = true) {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@owner:test' })
  const target = new Room(ROOM_ID, client, '@owner:test')

  target.currentState.setStateEvents([
    new MatrixEvent({
      type: EventType.RoomCreate,
      state_key: '',
      room_id: ROOM_ID,
      sender: MANAGER,
      content: binding
        ? {
            type: MATRIX_COMPANY_CHANNEL_TYPE,
            room_version: MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
            [MATRIX_COMPANY_CHANNEL_BINDING]: {
              companyId: '00000000-0000-4000-8000-8c031eadb7f3',
              channelId: '00000000-0000-4000-8000-01670d853f95'
            }
          }
        : { room_version: '11' }
    })
  ])

  return target
}

let count = 0

interface MemberOptions {
  /** Who did it: the person themself unless said. */
  sender?: string
  name?: string
  previousName?: string
}

/** One `m.room.member` event as a homeserver delivers it: the new membership and, in `unsigned`, the one before. */
function member(userId: string, membership: string, before: string | undefined, options: MemberOptions = {}) {
  return new MatrixEvent({
    type: EventType.RoomMember,
    state_key: userId,
    room_id: ROOM_ID,
    event_id: `$member${++count}`,
    sender: options.sender ?? userId,
    origin_server_ts: 1_000 + count,
    content: { membership, ...(options.name ? { displayname: options.name } : {}) },
    unsigned: before ? { prev_content: { membership: before, ...(options.previousName ? { displayname: options.previousName } : {}) } } : {}
  })
}

const read = (event: MatrixEvent, ignored = new Set<string>()) => matrixMembershipLine(event, MANAGER, ignored)

describe("a Team Space channel's joins and departures, from its own membership events", () => {
  it('reads someone coming in, with the name that event gave them', () => {
    const accepted = member(LINH, 'join', 'invite', { name: 'Linh' })

    expect(read(accepted)).toEqual({
      id: accepted.getId(),
      timestamp: accepted.getTs(),
      kind: 'joined',
      userId: LINH,
      name: 'Linh'
    })

    // Nothing earlier on record is still someone coming in.
    expect(read(member(BAO, 'join', undefined))).toMatchObject({ kind: 'joined', userId: BAO })
    expect(read(member(BAO, 'join', undefined))).not.toHaveProperty('name')
  })

  it.each([
    ['leave', 'themself', undefined],
    ['leave', 'someone removing them', MANAGER],
    ['ban', 'the room manager (how the platform completes a removal or a leave)', MANAGER]
  ])('reads a %s by %s of someone who was in as one departure', (membership, _who, sender) => {
    expect(read(member(LINH, membership, 'join', { sender, previousName: 'Linh' }))).toMatchObject({
      kind: 'departed',
      userId: LINH,
      name: 'Linh'
    })
  })

  it.each([
    ['an invitation', 'invite', undefined],
    ['an invitation again', 'invite', 'leave'],
    ['an invitation declined', 'leave', 'invite'],
    ['an invitation withdrawn by a ban', 'ban', 'invite'],
    ['an unban', 'leave', 'ban'],
    ['a profile change of someone already in', 'join', 'join'],
    ['a second leave', 'leave', 'leave'],
    ['a knock', 'knock', undefined]
  ])('says nothing of %s', (_what, membership, before) => {
    expect(read(member(LINH, membership, before))).toBeNull()
  })

  it('does not guess that someone was in when the event does not say so', () => {
    expect(read(member(LINH, 'leave', undefined))).toBeNull()
    expect(read(member(LINH, 'ban', undefined, { sender: MANAGER }))).toBeNull()
  })

  it('names a departure from the earlier membership when the new one carries no name', () => {
    expect(read(member(LINH, 'ban', 'join', { sender: MANAGER, previousName: 'Linh' }))?.name).toBe('Linh')
    expect(read(member(LINH, 'ban', 'join', { sender: MANAGER, name: 'Linh Mới', previousName: 'Linh' }))?.name).toBe('Linh Mới')
  })

  it('keeps a name to what a name is: trimmed text of bounded length', () => {
    expect(read(member(LINH, 'join', 'invite', { name: `  ${'x'.repeat(400)}  ` }))?.name).toHaveLength(256)
    expect(read(member(LINH, 'join', 'invite', { name: '   ' }))).not.toHaveProperty('name')
  })

  it("leaves out the room manager's own account and anyone the person ignores", () => {
    expect(read(member(MANAGER, 'join', undefined))).toBeNull()
    expect(read(member(MANAGER, 'join', 'invite'))).toBeNull()
    expect(read(member(LINH, 'join', 'invite'), new Set([LINH]))).toBeNull()
    expect(read(member(LINH, 'ban', 'join', { sender: MANAGER }), new Set([LINH]))).toBeNull()
  })

  it('reads only membership events', () => {
    const message = new MatrixEvent({
      type: EventType.RoomMessage,
      room_id: ROOM_ID,
      event_id: '$text',
      sender: LINH,
      origin_server_ts: 1,
      content: { msgtype: 'm.text', body: 'hi' }
    })

    expect(read(message)).toBeNull()
  })
})

describe('the lines of a loaded timeline', () => {
  it('are the joins and departures only, in the timeline order', () => {
    const events = [
      member(LINH, 'invite', undefined, { sender: MANAGER }),
      member(LINH, 'join', 'invite', { name: 'Linh' }),
      new MatrixEvent({
        type: EventType.RoomMessage,
        room_id: ROOM_ID,
        event_id: '$hello',
        sender: LINH,
        origin_server_ts: 5,
        content: { msgtype: 'm.text', body: 'hello' }
      }),
      member(BAO, 'join', 'invite', { name: 'Bảo' }),
      member(LINH, 'join', 'join', { name: 'Linh N.' }),
      member(LINH, 'ban', 'join', { sender: MANAGER })
    ]

    expect(matrixMembershipLines(room(), events, new Set()).map(line => [line.kind, line.userId])).toEqual([
      ['joined', LINH],
      ['joined', BAO],
      ['departed', LINH]
    ])
  })

  it("are none in a room without the platform's channel binding, whatever its membership says", () => {
    expect(matrixMembershipLines(room(false), [member(LINH, 'join', 'invite'), member(LINH, 'leave', 'join')], new Set())).toEqual([])
  })
})
