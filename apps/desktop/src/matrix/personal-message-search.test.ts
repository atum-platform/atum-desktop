import { createClient, EventType, MatrixEvent, MsgType, Room } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'

import { MATRIX_COMPANY_CHANNEL_TYPE } from '../../shared/matrix-company-channel-room'

import { rosterSearchEventTimeline, searchLoadedPrivateMessages, searchPersonalMessages } from './personal-message-search'

const owner = '@owner:example.test'
const sender = '@sender:example.test'
const assistant = '!assistant:example.test'
const group = '!group:example.test'
const privateRoom = '!private:example.test'
const company = '!company:example.test'

function message(roomId: string, eventId: string, body: string, from = sender) {
  return {
    type: EventType.RoomMessage, room_id: roomId, event_id: eventId, sender: from,
    origin_server_ts: 100, content: { body, msgtype: MsgType.Text }
  }
}

function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>()

  const client = createClient({
    baseUrl: 'https://matrix.example.test', userId: owner, accessToken: 'test-only', fetchFn: fetch,
    timelineSupport: true
  })

  const encrypted = new Set<string>()
  vi.spyOn(client, 'getCrypto').mockReturnValue({ isEncryptionEnabledInRoom: async (id: string) => encrypted.has(id) } as never)

  return {
    client, fetch, encrypted,
    join(id: string, options: { private?: boolean; type?: string } = {}) {
      const room = new Room(id, client, owner, { timelineSupport: true })
      room.updateMyMembership('join')
      client.store.storeRoom(room)

      if (options.type) {vi.spyOn(room, 'getType').mockReturnValue(options.type)}

      if (options.private) {
        room.currentState.setStateEvents([new MatrixEvent({
          room_id: id, type: EventType.RoomEncryption, state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' }
        })])
        encrypted.add(id)
      }

      return room
    }
  }
}

describe('roster personal search', () => {
  it('sends a scoped native request, discards out-of-scope and ignored hits, and rechecks a leave in flight', async () => {
    const { client, fetch, join, encrypted } = setup()
    join(assistant)
    const peopleGroup = join(group)
    join(privateRoom, { private: true })
    join(company, { type: MATRIX_COMPANY_CHANNEL_TYPE })
    const rememberedRoom = '!remembered:example.test'
    join(rememberedRoom)
    encrypted.add(rememberedRoom)
    vi.spyOn(client, 'getIgnoredUsers').mockReturnValue(['@ignored:example.test'])

    const row = (room: string, id: string, from?: string) => ({ result: message(room, id, 'invoice 1042', from) })

    const matches = [row(group, '$group'), row(assistant, '$assistant'), row(privateRoom, '$private'),
      row(company, '$company'), row(assistant, '$ignored', '@ignored:example.test')]

    let respond!: (value: Response) => void
    fetch.mockReturnValueOnce(new Promise(resolve => {respond = resolve}))

    const result = searchPersonalMessages(client, [assistant, group, privateRoom, company, rememberedRoom], 'invoice', () => true)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/search')
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).search_categories.room_events).toMatchObject({
      search_term: 'invoice', filter: { rooms: [assistant, group], not_senders: ['@ignored:example.test'] }
    })
    peopleGroup.updateMyMembership('leave')
    respond(Response.json({ search_categories: { room_events: { count: matches.length, highlights: [], results: matches } } }))

    const page = await result
    expect(page.results.map(hit => hit.eventId)).toEqual(['$assistant'])
    expect(page.coverage).toMatchObject({ searchedRooms: 1, encryptedRooms: 2, source: 'server' })
  })

  it('makes no request when the given scope is empty, unknown or encrypted', async () => {
    const { client, fetch, join } = setup()
    join(privateRoom, { private: true })

    for (const ids of [[], ['!missing:example.test'], [privateRoom]]) {
      const page = await searchPersonalMessages(client, ids, 'invoice', () => true)
      expect(page.results).toEqual([])
      expect(page.coverage.searchedRooms).toBe(0)
    }

    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses the native cursor with the same room filter when no result survives the first page', async () => {
    const { client, fetch, join } = setup()
    join(assistant)
    const reply = (eventId: string, body: string, nextBatch?: string) =>
      Response.json({ search_categories: { room_events: {
        highlights: [], count: 2, results: [{ result: message(assistant, eventId, body) }], next_batch: nextBatch
      } } })

    fetch.mockResolvedValueOnce(reply('$filtered', 'different', 'second-page'))
      .mockResolvedValueOnce(reply('$second', 'invoice'))

    const page = await searchPersonalMessages(client, [assistant], 'invoice', () => true)

    expect(page.results.map(hit => hit.eventId)).toEqual(['$second'])
    expect(String(fetch.mock.calls[1]?.[0])).toContain('next_batch=second-page')
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).search_categories.room_events.filter.rooms).toEqual([assistant])
  })

  it('opens an unloaded result by its exact context ID when a duplicate is already loaded', async () => {
    const { client, fetch, join } = setup()
    const room = join(assistant)
    await room.addLiveEvents([new MatrixEvent(message(assistant, '$duplicate', 'invoice 1042'))],
      { fromCache: false, addToState: false })
    fetch.mockResolvedValueOnce(Response.json({ event: message(assistant, '$older', 'invoice 1042'),
      start: 'before', end: 'after' }))

    const found = await rosterSearchEventTimeline(client, room, '$older', 'plain')

    expect(found.event.getId()).toBe('$older')
    expect(found.timeline).not.toBe(room.getLiveTimeline())
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/context/%24older')
    expect(room.getLiveTimeline().getEvents().map(event => event.getId())).toEqual(['$duplicate'])
  })
})

describe('device-only loaded search', () => {
  it('searches decrypted SDK events without requests and drops locally removed, redacted and left history', async () => {
    const { client, fetch, join } = setup()
    const room = join(privateRoom, { private: true })

    const makeEncrypted = async (id: string) => {
      const clear = message(privateRoom, id, 'device-only-canary')
      const event = new MatrixEvent({ ...clear, type: EventType.RoomMessageEncrypted, content: { ciphertext: 'fixture' } })
      await event.attemptDecryption({ decryptEvent: async () => ({ clearEvent: clear }) } as never)

      return event
    }

    const redacted = await makeEncrypted('$redacted')
    const deleted = await makeEncrypted('$deleted')
    const remaining = await makeEncrypted('$remaining')
    await room.addLiveEvents([redacted, deleted, remaining,
      new MatrixEvent(message(privateRoom, '$plaintext-injection', 'device-only-canary'))],
    { fromCache: false, addToState: false })
    const search = () => searchLoadedPrivateMessages(client, [privateRoom], 'device-only-canary')

    expect(search().results.map(hit => hit.eventId)).toEqual(['$redacted', '$deleted', '$remaining'])
    expect(search().coverage).toMatchObject({ loadedMessages: 3, searchedRooms: 1, source: 'loaded_history' })
    await expect(rosterSearchEventTimeline(client, room, '$remaining', 'device')).resolves.toMatchObject({ event: remaining })
    redacted.makeRedacted(new MatrixEvent({ type: EventType.RoomRedaction, content: {}, sender }), room)
    room.removeEvent('$deleted')
    expect(search().results.map(hit => hit.eventId)).toEqual(['$remaining'])
    room.updateMyMembership('leave')
    expect(search().results).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })
})
