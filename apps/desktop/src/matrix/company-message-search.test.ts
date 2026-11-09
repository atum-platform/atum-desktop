import { EventType, MatrixEvent, MsgType } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'

import { MATRIX_COMPANY_CHANNEL_BINDING, MATRIX_COMPANY_CHANNEL_TYPE } from '../../shared/matrix-company-channel-room'
import type { MatrixCompanyMessageSearchTarget } from '../../shared/matrix-company-search'
import { MATRIX_NOTES_SELF_ROOM_TYPE } from '../../shared/matrix-notes-self'

import { companyMessageRoom, openCompanyMessage, searchCompanyMessages } from './company-message-search'

const companyId = '00000000-0000-4000-8000-4423c334534f'
const channelId = '00000000-0000-4000-8000-a6350151b493'
const otherChannelId = '00000000-0000-4000-8000-01670d853f95'
const roomId = '!company-search:test'
const otherRoomId = '!company-search-other:test'
const manager = '@manager:test'

function target(id = channelId, room = roomId): MatrixCompanyMessageSearchTarget {
  return { channelId: id, roomId: room, channelName: id === channelId ? 'general' : 'quiet', state: 'active',
    authorityGeneration: 2, channelGeneration: 3 }
}

function room(id: string, channel: string, membership: 'join' | 'leave' = 'join', events: MatrixEvent[] = []) {
  const creation = {
    getContent: () => ({ type: MATRIX_COMPANY_CHANNEL_TYPE,
      room_version: '11',
      [MATRIX_COMPANY_CHANNEL_BINDING]: { companyId, channelId: channel } }),
    getSender: () => manager,
    getRoomId: () => id
  }

  return {
    roomId: id,
    getMyMembership: () => membership,
    getType: () => MATRIX_COMPANY_CHANNEL_TYPE,
    getLiveTimeline: () => ({ getEvents: () => events }),
    getThreads: () => [],
    getMembers: () => [
      { userId: '@avery:test', name: 'Avery', rawDisplayName: 'Avery' },
      { userId: '@me:test', name: 'Me', rawDisplayName: 'Me' }
    ],
    currentState: { getStateEvents: (type: string, key: string) =>
      type === EventType.RoomCreate && key === '' ? creation : null }
  }
}

function event(id = '$message', room = roomId, body = 'Exact launch needle') {
  return new MatrixEvent({
    type: EventType.RoomMessage,
    event_id: id,
    room_id: room,
    sender: '@avery:test',
    origin_server_ts: 100,
    content: { msgtype: MsgType.Text, body }
  })
}

describe('company exact message search', () => {
  it('excludes a personal notes room even if a caller tries to pass it as a company target', async () => {
    const notes = room(roomId, channelId)
    const creation = notes.currentState.getStateEvents(EventType.RoomCreate, '') as ReturnType<typeof notes.currentState.getStateEvents>

    notes.getType = () => MATRIX_NOTES_SELF_ROOM_TYPE
    notes.currentState.getStateEvents = ((type: string, key: string) =>
      type === EventType.RoomCreate && key === ''
        ? { ...creation, getContent: () => ({ type: MATRIX_NOTES_SELF_ROOM_TYPE }), getSender: () => '@me:test' }
        : null) as never

    const searchRoomEvents = vi.fn()
    const client = { getRoom: () => notes, searchRoomEvents } as never

    const result = await searchCompanyMessages(client, {
      kind: 'companyMessageSearch', companyId, query: 'private', limit: 25, rooms: [target()]
    })

    expect(searchRoomEvents).not.toHaveBeenCalled()
    expect(result).toMatchObject({ coverage: { eligibleRooms: 1, searchedRooms: 0 }, results: [] })
  })

  it('searches only currently joined, correctly bound authorized rooms', async () => {
    const joined = room(roomId, channelId)
    const left = room(otherRoomId, otherChannelId, 'leave')

    const searchRoomEvents = vi.fn(async () => ({
      results: [{ context: { getEvent: () => event() } }],
      highlights: ['launch'],
      count: 1
    }))

    const client = { getRoom: (id: string) => id === roomId ? joined : id === otherRoomId ? left : null,
      searchRoomEvents } as never

    const result = await searchCompanyMessages(client, {
      kind: 'companyMessageSearch', companyId, query: 'launch', limit: 25,
      rooms: [target(), target(otherChannelId, otherRoomId)]
    })

    expect(searchRoomEvents).toHaveBeenCalledWith(expect.objectContaining({
      term: 'launch', filter: expect.objectContaining({ rooms: [roomId], types: [EventType.RoomMessage], limit: 25 })
    }))
    expect(result).toEqual({
      schemaVersion: 1,
      companyId,
      query: 'launch',
      coverage: { eligibleRooms: 2, searchedRooms: 1, truncated: false, encryptedRooms: 0, source: 'server' },
      results: [{ channelId, roomId, channelName: 'general', eventId: '$message', sender: '@avery:test',
        snippet: 'Exact launch needle', at: 100 }]
    })
  })

  it('fails closed when the homeserver returns an event outside the authorized room filter', async () => {
    const joined = room(roomId, channelId)

    const client = {
      getRoom: () => joined,
      searchRoomEvents: vi.fn(async () => ({ results: [{ context: { getEvent: () => event('$foreign', otherRoomId) } }], highlights: [] }))
    } as never

    await expect(searchCompanyMessages(client, {
      kind: 'companyMessageSearch', companyId, query: 'launch', limit: 25, rooms: [target()]
    })).rejects.toThrow('matrix_company_search_unavailable')
  })

  it('returns a bounded snippet around a match instead of a whole large message', async () => {
    const joined = room(roomId, channelId)
    const body = `${'before '.repeat(120)}needle${' after'.repeat(120)}`

    const client = {
      getRoom: () => joined,
      searchRoomEvents: vi.fn(async () => ({
        results: [{ context: { getEvent: () => event('$large', roomId, body) } }],
        highlights: ['needle'],
        count: 1
      }))
    } as never

    const result = await searchCompanyMessages(client, {
      kind: 'companyMessageSearch', companyId, query: 'needle', limit: 25, rooms: [target()]
    })

    expect(result.results[0]?.snippet).toContain('needle')
    expect([...(result.results[0]?.snippet ?? '')].length).toBeLessThanOrEqual(602)
    expect(result.results[0]?.snippet).not.toBe(body)
  })

  it('keeps multiple plain terms on the full-history server path', async () => {
    const joined = room(roomId, channelId, 'join', [event('$loaded', roomId, 'We are launching Tuesday.')])
    const searchRoomEvents = vi.fn(async () => ({ results: [], highlights: [] }))

    const client = {
      getRoom: () => joined,
      searchRoomEvents
    } as never

    await expect(searchCompanyMessages(client, {
      kind: 'companyMessageSearch', companyId, query: 'launch plan', limit: 25, rooms: [target()]
    })).resolves.toMatchObject({ results: [], coverage: { truncated: false, source: 'server' } })
    expect(searchRoomEvents).toHaveBeenCalledWith(expect.objectContaining({ term: 'launch plan' }))
  })

  it('applies before: and after: to loaded message timestamps', async () => {
    const inside = event('$inside', roomId, 'Launch plan')
    inside.event.origin_server_ts = new Date(2026, 9, 30, 12).getTime()
    const outside = event('$outside', roomId, 'Launch plan')
    outside.event.origin_server_ts = new Date(2026, 9, 31, 12).getTime()
    const joined = room(roomId, channelId, 'join', [outside, inside])
    const client = { getRoom: () => joined, searchRoomEvents: vi.fn(async () => ({
      results: [outside, inside].map(value => ({ context: { getEvent: () => value } })), highlights: []
    })) } as never

    await expect(searchCompanyMessages(client, { kind: 'companyMessageSearch', companyId,
      query: 'launch after:2026-10-30 before:2026-10-31', limit: 25, rooms: [target()] })).resolves.toMatchObject({
      coverage: { source: 'server' }, results: [{ eventId: '$inside' }]
    })
  })

  it('maps from: and in: onto Matrix sender and room filters when one plain term stays server-side', async () => {
    const joined = room(roomId, channelId)
    const searchRoomEvents = vi.fn(async () => ({ results: [{ context: { getEvent: () => event() } }], highlights: [] }))
    const client = { getRoom: () => joined, getUserId: () => '@me:test', searchRoomEvents } as never

    await expect(searchCompanyMessages(client, {
      kind: 'companyMessageSearch', companyId, query: 'launch from:@lan in:#general', limit: 25,
      senderUserId: '@avery:test', rooms: [target()]
    })).resolves.toMatchObject({ results: [{ eventId: '$message' }], coverage: { source: 'server' } })
    expect(searchRoomEvents).toHaveBeenCalledWith(expect.objectContaining({
      term: 'launch', filter: expect.objectContaining({ rooms: [roomId], senders: ['@avery:test'] })
    }))
  })

  it('finds loaded attachments and applies the Files type filter', async () => {
    const file = new MatrixEvent({ type: EventType.RoomMessage, event_id: '$pdf', room_id: roomId, sender: '@avery:test',
      origin_server_ts: new Date(2026, 9, 30, 12).getTime(),
      content: { msgtype: MsgType.File, body: 'Launch brief.pdf', info: { mimetype: 'application/pdf', size: 42 } } })

    const image = new MatrixEvent({ type: EventType.RoomMessage, event_id: '$image', room_id: roomId, sender: '@avery:test',
      origin_server_ts: new Date(2026, 9, 30, 13).getTime(),
      content: { msgtype: MsgType.Image, body: 'Launch.png', info: { mimetype: 'image/png', size: 84 } } })

    const joined = room(roomId, channelId, 'join', [file, image])
    const searchRoomEvents = vi.fn(async () => ({
      results: [image, file].map(value => ({ context: { getEvent: () => value } })), highlights: []
    }))
    const client = { getRoom: () => joined, searchRoomEvents } as never

    await expect(searchCompanyMessages(client, { kind: 'companyMessageSearch', companyId, query: 'launch', limit: 25,
      tab: 'files', fileType: 'pdfs', rooms: [target()] })).resolves.toMatchObject({
      coverage: { source: 'server' },
      results: [{ eventId: '$pdf', file: { name: 'Launch brief.pdf', type: 'pdfs', mimeType: 'application/pdf', size: 42 } }]
    })
    expect(searchRoomEvents).toHaveBeenCalledWith(expect.objectContaining({
      filter: expect.objectContaining({ contains_url: true })
    }))
  })

  it('skips ordinary non-text and edit hits without dropping valid text results', async () => {
    const joined = room(roomId, channelId)

    const raw = (id: string, content: Record<string, unknown>) => new MatrixEvent({
      type: EventType.RoomMessage,
      event_id: id,
      room_id: roomId,
      sender: '@avery:test',
      origin_server_ts: 100,
      content
    })

    const client = {
      getRoom: () => joined,
      searchRoomEvents: vi.fn(async () => ({
        results: [
          { context: { getEvent: () => raw('$file', { msgtype: MsgType.File, body: 'launch.pdf' }) } },
          { context: { getEvent: () => raw('$edit', { msgtype: MsgType.Text, body: 'launch',
            'm.relates_to': { rel_type: 'm.replace', event_id: '$old' } }) } },
          { context: { getEvent: () => raw('$self', { msgtype: MsgType.Text, body: 'launch',
            'm.relates_to': { rel_type: 'm.thread', event_id: '$self' } }) } },
          { context: { getEvent: () => event('$text') } }
        ],
        highlights: ['launch'],
        count: 4
      }))
    } as never

    await expect(searchCompanyMessages(client, {
      kind: 'companyMessageSearch', companyId, query: 'launch', limit: 25, rooms: [target()]
    })).resolves.toMatchObject({
      coverage: { truncated: false },
      results: [{ eventId: '$text', snippet: 'Exact launch needle' }]
    })
  })

  it('reports explicit zero-room coverage without asking the homeserver', async () => {
    const searchRoomEvents = vi.fn()
    const client = { getRoom: () => room(roomId, channelId, 'leave'), searchRoomEvents } as never
    await expect(searchCompanyMessages(client, {
      kind: 'companyMessageSearch', companyId, query: 'launch', limit: 25, rooms: [target()]
    })).resolves.toMatchObject({ coverage: { eligibleRooms: 1, searchedRooms: 0 }, results: [] })
    expect(searchRoomEvents).not.toHaveBeenCalled()
  })

  it('returns and consumes the homeserver continuation token without rescanning loaded history', async () => {
    const joined = room(roomId, channelId)
    const searchRoomEvents = vi.fn(async () => ({
      results: [{ context: { getEvent: () => event('$first') } }], highlights: [], next_batch: 'page_2'
    }))
    const search = vi.fn(async () => ({ search_categories: { room_events: {
      results: [{ rank: 1, result: event('$second').event, context: { events_before: [], events_after: [], profile_info: {} } }],
      next_batch: undefined
    } } }))
    const client = { getRoom: () => joined, searchRoomEvents, search } as never
    const first = await searchCompanyMessages(client, { kind: 'companyMessageSearch', companyId,
      query: 'launch', limit: 25, rooms: [target()] })
    expect(first.nextBatch).toBe('page_2')
    const second = await searchCompanyMessages(client, { kind: 'companyMessageSearch', companyId,
      query: 'launch', limit: 25, nextBatch: first.nextBatch, rooms: [target()] })
    expect(second.results.map(result => result.eventId)).toEqual(['$second'])
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ next_batch: 'page_2' }))
  })

  it('labels encrypted rooms honestly and leaves them out of server search', async () => {
    const joined = room(roomId, channelId)
    const searchRoomEvents = vi.fn()
    const client = { getRoom: () => joined, isRoomEncrypted: () => true, searchRoomEvents } as never
    await expect(searchCompanyMessages(client, { kind: 'companyMessageSearch', companyId,
      query: 'launch', limit: 25, rooms: [target()] })).resolves.toMatchObject({
      coverage: { eligibleRooms: 1, searchedRooms: 0, encryptedRooms: 1, source: 'server' }, results: []
    })
    expect(searchRoomEvents).not.toHaveBeenCalled()
  })

  it('revalidates the exact server event before opening a result', async () => {
    const joined = room(roomId, channelId)

    const fetchRoomEvent = vi.fn(async () => ({
      type: EventType.RoomMessage, event_id: '$message', room_id: roomId, sender: '@avery:test',
      origin_server_ts: 100, content: { msgtype: MsgType.Text, body: 'Exact launch needle' }
    }))

    const client = { getRoom: () => joined, fetchRoomEvent } as never

    await expect(openCompanyMessage(client, {
      kind: 'companyMessageOpen', companyId, channelId, roomId, eventId: '$message'
    })).resolves.toBeUndefined()
    expect(fetchRoomEvent).toHaveBeenCalledWith(roomId, '$message')
  })

  it('binds a thread result to the exact server relation before opening it', async () => {
    const joined = room(roomId, channelId)

    const fetchRoomEvent = vi.fn(async () => ({
      type: EventType.RoomMessage, event_id: '$reply', room_id: roomId, sender: '@avery:test',
      origin_server_ts: 100,
      content: { msgtype: MsgType.Text, body: 'Thread needle',
        'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } }
    }))

    const client = { getRoom: () => joined, fetchRoomEvent } as never

    await expect(openCompanyMessage(client, {
      kind: 'companyMessageOpen', companyId, channelId, roomId, eventId: '$reply', threadRootId: '$root'
    })).resolves.toBeUndefined()
    await expect(openCompanyMessage(client, {
      kind: 'companyMessageOpen', companyId, channelId, roomId, eventId: '$reply', threadRootId: '$other'
    })).rejects.toThrow('matrix_company_search_unavailable')
  })

  it('revalidates an exact file event through the same open-in-context fence', async () => {
    const joined = room(roomId, channelId)

    const fetchRoomEvent = vi.fn(async () => ({ type: EventType.RoomMessage, event_id: '$file', room_id: roomId,
      sender: '@avery:test', origin_server_ts: 100,
      content: { msgtype: MsgType.File, body: 'brief.pdf', info: { mimetype: 'application/pdf', size: 42 } } }))

    const client = { getRoom: () => joined, fetchRoomEvent } as never

    await expect(openCompanyMessage(client, {
      kind: 'companyMessageOpen', companyId, channelId, roomId, eventId: '$file'
    })).resolves.toBeUndefined()
    expect(fetchRoomEvent).toHaveBeenCalledWith(roomId, '$file')
  })

  it('rechecks joined immutable room binding before trusted selection', () => {
    const joined = room(roomId, channelId)
    const client = { getRoom: () => joined } as never

    expect(companyMessageRoom(client, { kind: 'companyMessageSelect', companyId, channelId, roomId })).toBe(joined)
    expect(() => companyMessageRoom({ getRoom: () => room(roomId, channelId, 'leave') } as never, {
      kind: 'companyMessageSelect', companyId, channelId, roomId
    })).toThrow('matrix_company_search_unavailable')
  })
})
