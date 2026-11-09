import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { DirectMessagingTransport } from './direct-transport'
import { AtumMessagingSyncEngine } from './sync-engine'

const ACCOUNT_A = '00000000-0000-4000-8000-303617b97302'
const ACCOUNT_B = '00000000-0000-4000-8000-00f765af1c54'
const EPOCH_A = '00000000-0000-4000-8000-d98016d67fb8'

test('an account replacement cancels stale social lookup publication', async () => {
  let accountId = ACCOUNT_A
  let releaseLookup!: () => void
  const lookupBarrier = new Promise<void>(resolve => { releaseLookup = resolve })

  const http: DirectMessagingTransport = {
    abortAll() {},
    session: async () => ({
      user: { id: accountId, displayName: null, handle: null },
      realtime: { transport: 'supabase_private_broadcast', topic: `user:${accountId}:messaging:v1`, event: 'sync_available' },
      serverTime: '2026-08-30T00:00:00.000Z', syncCursor: null
    }),
    conversations: async () => ({ conversations: [] }),
    messages: async () => ({ messages: [], nextCursor: null, hasMore: false }),
    send: async () => { throw new Error('not used') },
    markRead: async () => {},
    sync: async () => ({ changes: [], nextCursor: 'message-cursor', hasMore: false, serverTime: '2026-08-30T00:00:00.000Z' }),
    socialLookup: async () => {
      await lookupBarrier

      return { accountEpoch: EPOCH_A, projection: {
        availability: 'available', profile: { profileId: '00000000-0000-4000-8000-e03cc076d760', displayName: 'Bob', handle: 'social-bob', verified: false, avatar: null },
        state: 'none', version: 0, canMessage: false, directThreadId: null
      } }
    },
    socialMutate: async () => { throw new Error('not used') },
    socialSync: async epoch => ({ accountEpoch: epoch, changes: [], nextCursor: 'social-cursor', hasMore: false })
  }

  const engine = new AtumMessagingSyncEngine({
    userDataPath: '/unused', http, accountId: () => accountId, automaticPolling: false,
    databasePathForAccount: () => ':memory:'
  })

  await engine.start()
  const stale = engine.socialLookup('social-bob')
  accountId = ACCOUNT_B
  await engine.replaceAccount(ACCOUNT_B)
  releaseLookup()

  await assert.rejects(stale, /stale_messaging_lifecycle/)
  assert.deepEqual(await engine.socialRelationships(), [])
  engine.stop()
})

test('an unavailable sync change revalidates known handles and fails a peer-blocked thread closed', async () => {
  let lookupCount = 0

  const connected = {
    availability: 'available' as const,
    profile: { profileId: '00000000-0000-4000-8000-e03cc076d760', displayName: 'Bob', handle: 'social-bob', verified: false, avatar: null },
    state: 'connected' as const, version: 2, canMessage: true,
    directThreadId: '00000000-0000-4000-8000-1d1ea877549e'
  }

  const unavailable = { availability: 'unavailable' as const, profile: null, state: 'unavailable' as const, version: 0 as const, canMessage: false as const, directThreadId: null }

  const http: DirectMessagingTransport = {
    abortAll() {},
    session: async () => ({ user: { id: ACCOUNT_A, displayName: null, handle: null }, realtime: { transport: 'supabase_private_broadcast', topic: `user:${ACCOUNT_A}:messaging:v1`, event: 'sync_available' }, serverTime: '2026-08-30T00:00:00.000Z', syncCursor: null }),
    conversations: async () => ({ conversations: [] }),
    messages: async () => ({ messages: [], nextCursor: null, hasMore: false }),
    send: async () => {throw new Error('must not send')},
    markRead: async () => {},
    sync: async () => ({ changes: [], nextCursor: 'message-cursor', hasMore: false, serverTime: '2026-08-30T00:00:00.000Z' }),
    socialLookup: async () => ({ accountEpoch: EPOCH_A, projection: lookupCount++ === 0 ? connected : unavailable }),
    socialMutate: async () => {throw new Error('not used')},
    socialSync: async () => ({ accountEpoch: EPOCH_A, changes: [{ changeId: '1', projection: unavailable }], nextCursor: 'social-cursor', hasMore: false })
  }

  const engine = new AtumMessagingSyncEngine({ userDataPath: '/unused', http, accountId: () => ACCOUNT_A, automaticPolling: false, databasePathForAccount: () => ':memory:' })

  await engine.start()
  await engine.socialLookup('social-bob')
  assert.equal((await engine.socialRelationships())[0]?.canMessage, true)
  assert.deepEqual(await engine.socialSync(), [])
  await assert.rejects(engine.send({ conversationId: connected.directThreadId, clientMessageId: 'denied', content: 'no', locale: 'en' }), /direct_compose_denied/)
  engine.stop()
})

test('an empty replica bootstraps its epoch with a self lookup and then syncs relationships', async () => {
  const lookups: string[] = []
  const syncs: string[] = []

  const http: DirectMessagingTransport = {
    abortAll() {},
    session: async () => ({
      user: { id: ACCOUNT_A, displayName: 'A', handle: 'self-handle' },
      realtime: { transport: 'supabase_private_broadcast', topic: `user:${ACCOUNT_A}:messaging:v1`, event: 'sync_available' },
      serverTime: '2026-09-03T00:00:00.000Z', syncCursor: null
    }),
    conversations: async () => ({ conversations: [] }),
    messages: async () => ({ messages: [], nextCursor: null, hasMore: false }),
    send: async () => { throw new Error('not used') },
    markRead: async () => {},
    sync: async () => ({ changes: [], nextCursor: 'message-cursor', hasMore: false, serverTime: '2026-09-03T00:00:00.000Z' }),
    socialLookup: async query => {
      lookups.push(query)

      // The provider excludes the caller: neutral projection, but the epoch rides along.
      return { accountEpoch: EPOCH_A, projection: {
        availability: 'unavailable', profile: null, state: 'unavailable', version: 0, canMessage: false, directThreadId: null
      } }
    },
    socialMutate: async () => { throw new Error('not used') },
    socialSync: async epoch => {
      syncs.push(epoch)

      return { accountEpoch: epoch, nextCursor: 'social-cursor', hasMore: false, changes: [{
        changeId: '1', projection: {
          availability: 'available',
          profile: { profileId: '00000000-0000-4000-8000-e03cc076d760', displayName: 'Minh', handle: 'minh', verified: false, avatar: null },
          state: 'connected', version: 1, canMessage: true, directThreadId: '00000000-0000-4000-8000-07f20b52b9a0'
        }
      }] }
    }
  }

  const engine = new AtumMessagingSyncEngine({
    userDataPath: '/unused', http, accountId: () => ACCOUNT_A, accountHandle: () => 'self-handle',
    automaticPolling: false, databasePathForAccount: () => ':memory:'
  })

  await engine.start()
  const relationships = await engine.socialSync()

  assert.deepEqual(lookups, ['self-handle'])
  assert.deepEqual(syncs, [EPOCH_A])
  assert.equal(relationships.length, 1)
  assert.equal(relationships[0]?.availability === 'available' && relationships[0].canMessage, true)

  // The epoch is durable: the next sync goes straight to the provider.
  await engine.socialSync()
  assert.deepEqual(lookups, ['self-handle'])
  engine.stop()
})

test('a failed bootstrap lookup is not fatal and leaves the replica empty for the next poll', async () => {
  let attempts = 0

  const http: DirectMessagingTransport = {
    abortAll() {},
    session: async () => ({
      user: { id: ACCOUNT_A, displayName: 'A', handle: 'self-handle' },
      realtime: { transport: 'supabase_private_broadcast', topic: `user:${ACCOUNT_A}:messaging:v1`, event: 'sync_available' },
      serverTime: '2026-09-03T00:00:00.000Z', syncCursor: null
    }),
    conversations: async () => ({ conversations: [] }),
    messages: async () => ({ messages: [], nextCursor: null, hasMore: false }),
    send: async () => { throw new Error('not used') },
    markRead: async () => {},
    sync: async () => ({ changes: [], nextCursor: 'message-cursor', hasMore: false, serverTime: '2026-09-03T00:00:00.000Z' }),
    socialLookup: async () => { attempts += 1; throw new Error('temporarily_unavailable') },
    socialMutate: async () => { throw new Error('not used') },
    socialSync: async () => { throw new Error('must not be called without an epoch') }
  }

  const engine = new AtumMessagingSyncEngine({
    userDataPath: '/unused', http, accountId: () => ACCOUNT_A, accountHandle: () => 'self-handle',
    automaticPolling: false, databasePathForAccount: () => ':memory:'
  })

  await engine.start()
  assert.deepEqual(await engine.socialSync(), [])
  assert.deepEqual(await engine.socialSync(), [])
  assert.equal(attempts, 2)
  engine.stop()
})

test('without a known handle the replica stays quiet instead of guessing', async () => {
  const http: DirectMessagingTransport = {
    abortAll() {},
    session: async () => ({
      user: { id: ACCOUNT_A, displayName: 'A', handle: null },
      realtime: { transport: 'supabase_private_broadcast', topic: `user:${ACCOUNT_A}:messaging:v1`, event: 'sync_available' },
      serverTime: '2026-09-03T00:00:00.000Z', syncCursor: null
    }),
    conversations: async () => ({ conversations: [] }),
    messages: async () => ({ messages: [], nextCursor: null, hasMore: false }),
    send: async () => { throw new Error('not used') },
    markRead: async () => {},
    sync: async () => ({ changes: [], nextCursor: 'message-cursor', hasMore: false, serverTime: '2026-09-03T00:00:00.000Z' }),
    socialLookup: async () => { throw new Error('must not be called') },
    socialMutate: async () => { throw new Error('not used') },
    socialSync: async () => { throw new Error('must not be called') }
  }

  const engine = new AtumMessagingSyncEngine({
    userDataPath: '/unused', http, accountId: () => ACCOUNT_A, accountHandle: () => null,
    automaticPolling: false, databasePathForAccount: () => ':memory:'
  })

  await engine.start()
  assert.deepEqual(await engine.socialSync(), [])
  engine.stop()
})
