import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { normalizeBaseUrl, type SafeStorageLike } from './credential-vault'
import { AtumMessagingRuntime } from './runtime'
import { parseSocialMutationResponse } from './social'
import { AtumMessagingStore } from './store'
import type { CanonicalMessage, DirectMessagingStoreBoundary, MessagingAccountSession } from './types'

const ACCOUNT_A = '00000000-0000-4000-8000-303617b97302'
const ACCOUNT_B = '00000000-0000-4000-8000-00f765af1c54'
const CONVERSATION_A = '00000000-0000-4000-8000-f6222a1106ee'
const CONVERSATION_B = '00000000-0000-4000-8000-f2da1f9533d4'
const MESSAGE_A = '00000000-0000-4000-8000-b454f82c5857'
const CLIENT_A = '00000000-0000-4000-8000-bd7662a5eeb4'

const temporaryDirectories: string[] = []
const runtimes: AtumMessagingRuntime[] = []
const servers: http.Server[] = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    runtime.stop()
  }

  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))

  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function tempUserData(): string {
  const directory = mkdtempSync(join(tmpdir(), 'atum-sync-'))
  temporaryDirectories.push(directory)

  return directory
}

const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`sealed:${value}`, 'utf8'),
  decryptString: value => {
    const decoded = value.toString('utf8')
    assert.ok(decoded.startsWith('sealed:'))

    return decoded.slice('sealed:'.length)
  }
}

function message(
  id = MESSAGE_A,
  conversationId = CONVERSATION_A,
  content = 'Chào bạn — Atum đang hoạt động trên máy Mac.'
) {
  return {
    id,
    conversation_id: conversationId,
    sender: { type: 'user', id: ACCOUNT_B },
    content,
    kind: 'text',
    attachments: [],
    reply_to_message_id: null,
    forwarded_from: null,
    reactions: [],
    version: 1,
    created_at: '2026-08-12T03:00:00.000Z',
    edited_at: null,
    recalled_at: null,
    delivery: 'sent'
  }
}

function conversation(id = CONVERSATION_A, peer = ACCOUNT_B) {
  return {
    id,
    specialist: null,
    participants: [
      { type: 'user', id: ACCOUNT_A, display_name: 'Minh' },
      { type: 'user', id: peer, display_name: 'Bạn' }
    ],
    read_state: { last_read_message_id: null, read_at: null },
    state: { pinned: false, muted: false, archived: false },
    created_at: '2026-08-12T02:00:00.000Z',
    updated_at: '2026-08-12T03:00:00.000Z'
  }
}

interface FakeState {
  accountForToken: Record<string, string>
  conversations: Record<string, ReturnType<typeof conversation>[]>
  messages: Record<string, ReturnType<typeof message>[]>
  syncChanges: any[]
  syncFailure?: boolean
  syncCursorExpired?: boolean
  rosterFailure?: boolean
  sendFailure?: boolean
  sendRetryAfterMs?: number
  sendAuthFailure?: boolean
  sendConversationOverride?: string
  readFailure?: boolean
  disconnectFailure?: boolean
  hangSessionTokens?: Set<string>
  oversizedSessionBytes?: number
  syncAlwaysHasMore?: boolean
  requestLog: Array<{
    method: string
    path: string
    authorization: string | undefined
    idempotencyKey: string | undefined
    body: string
  }>
  syncCursors: Array<string | null>
  syncNextCursor?: string
}

async function fakeServer(state: FakeState): Promise<string> {
  const server = http.createServer(async (request, response) => {
    const body = await new Promise<string>(resolve => {
      let value = ''
      request.setEncoding('utf8')
      request.on('data', chunk => (value += chunk))
      request.on('end', () => resolve(value))
    })

    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const authorization = request.headers.authorization
    state.requestLog.push({
      method: request.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      authorization,
      idempotencyKey: request.headers['idempotency-key'] as string | undefined,
      body
    })
    const token = authorization?.replace(/^Bearer /, '') ?? ''
    const account = state.accountForToken[token]

    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(value))
    }

    if (!account) {
      send(401, {
        error: {
          code: 'token_expired',
          message_key: 'messaging.error.token_expired',
          retryable: true,
          request_id: 'req_auth'
        }
      })

      return
    }

    if (url.pathname === '/api/identity/apps/moon/disconnect') {
      send(
        state.disconnectFailure ? 503 : 200,
        state.disconnectFailure
          ? {
              error: {
                code: 'temporarily_unavailable',
                message_key: 'messaging.error.temporarily_unavailable',
                retryable: true,
                request_id: 'req_disconnect'
              }
            }
          : { status: 'unlinked' }
      )

      return
    }

    if (url.pathname.endsWith('/session')) {
      if (state.hangSessionTokens?.delete(token)) {
        return
      }

      send(200, {
        user: { id: account, display_name: account === ACCOUNT_A ? 'Minh' : 'Lan', handle: null },
        realtime: {
          transport: 'supabase_private_broadcast',
          topic: `user:${account}:messaging:v1`,
          event: 'sync_available'
        },
        server_time: '2026-08-12T03:00:00.000Z',
        sync_cursor: 'session-cursor-must-not-skip-initial-backfill',
        padding: state.oversizedSessionBytes ? 'x'.repeat(state.oversizedSessionBytes) : undefined
      })

      return
    }

    if (url.pathname.endsWith('/sync')) {
      state.syncCursors.push(url.searchParams.get('cursor'))

      if (state.syncCursorExpired) {
        send(409, {
          error: {
            code: 'sync_cursor_expired',
            message_key: 'messaging.error.sync_cursor_expired',
            retryable: true,
            request_id: 'req_cursor_expired',
            details: { reset_required: true }
          }
        })

        return
      }

      if (state.syncFailure) {
        send(503, {
          error: {
            code: 'temporarily_unavailable',
            message_key: 'messaging.error.temporarily_unavailable',
            retryable: true,
            request_id: 'req_sync'
          }
        })

        return
      }

      send(200, {
        changes: account === ACCOUNT_A ? state.syncChanges : [],
        next_cursor: state.syncAlwaysHasMore
          ? `cursor-page-${state.syncCursors.length}`
          : state.syncNextCursor
            ? state.syncNextCursor
            : account === ACCOUNT_A
              ? 'cursor-a'
              : 'cursor-b',
        has_more: state.syncAlwaysHasMore ?? false,
        server_time: '2026-08-12T03:00:02.000Z'
      })

      return
    }

    if (url.pathname.endsWith('/conversations')) {
      if (state.rosterFailure) {
        send(503, {
          error: {
            code: 'temporarily_unavailable',
            message_key: 'messaging.error.temporarily_unavailable',
            retryable: true,
            request_id: 'req_roster'
          }
        })

        return
      }

      send(200, { conversations: state.conversations[account] ?? [], next_cursor: null, has_more: false })

      return
    }

    const messagesMatch = /\/conversations\/([^/]+)\/messages$/.exec(url.pathname)

    if (messagesMatch && request.method === 'POST') {
      if (state.sendAuthFailure) {
        send(401, {
          error: {
            code: 'token_expired',
            message_key: 'messaging.error.token_expired',
            retryable: true,
            request_id: 'req_send_auth'
          }
        })

        return
      }

      if (state.sendFailure) {
        send(503, {
          error: {
            code: 'temporarily_unavailable',
            message_key: 'messaging.error.temporarily_unavailable',
            retryable: true,
            request_id: 'req_send',
            retry_after_ms: state.sendRetryAfterMs ?? 1
          }
        })

        return
      }

      const input = JSON.parse(body)

      const canonical = message(
        `server-${input.client_message_id}`,
        state.sendConversationOverride ?? messagesMatch[1],
        input.content
      )

      state.messages[messagesMatch[1]] = [canonical]
      send(201, { message: canonical, replayed: false })

      return
    }

    if (messagesMatch) {
      send(200, { messages: state.messages[messagesMatch[1]] ?? [], next_cursor: null, has_more: false })

      return
    }

    if (url.pathname.endsWith('/read')) {
      if (state.readFailure) {
        send(503, {
          error: {
            code: 'temporarily_unavailable',
            message_key: 'messaging.error.temporarily_unavailable',
            retryable: true,
            request_id: 'req_read'
          }
        })

        return
      }

      send(200, { read_state: {}, replayed: false })

      return
    }

    send(404, {
      error: { code: 'not_found', message_key: 'messaging.error.not_found', retryable: false, request_id: 'req_404' }
    })
  })

  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return `http://127.0.0.1:${address.port}`
}

function state(): FakeState {
  return {
    accountForToken: { 'token-a': ACCOUNT_A, 'token-b': ACCOUNT_B },
    conversations: {
      [ACCOUNT_A]: [conversation()],
      [ACCOUNT_B]: [conversation(CONVERSATION_B, ACCOUNT_A)]
    },
    messages: { [CONVERSATION_A]: [message()], [CONVERSATION_B]: [] },
    syncChanges: [
      {
        change_id: '9001',
        entity: 'message',
        operation: 'upsert',
        entity_id: MESSAGE_A,
        conversation_id: CONVERSATION_A,
        value: { version: 1 },
        occurred_at: '2026-08-12T03:00:00.000Z'
      }
    ],
    requestLog: [],
    syncCursors: []
  }
}

function session(baseUrl: string, accountId = ACCOUNT_A, accessToken = 'token-a'): MessagingAccountSession {
  return {
    baseUrl,
    user: { id: accountId, displayName: null, handle: null },
    tokens: { accessToken, refreshToken: 'refresh', expiresAt: null }
  }
}

test('session base URLs discard userinfo before persistence or requests', () => {
  assert.equal(
    normalizeBaseUrl('https://username:password@example.com/atum/?ignored=yes#fragment'),
    'https://example.com/atum'
  )
})

async function waitForRequest(fake: FakeState, predicate: (request: FakeState['requestLog'][number]) => boolean) {
  const deadline = Date.now() + 2_000

  while (!fake.requestLog.some(predicate)) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for fake-server request')
    }

    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('real HTTP bytes perform initial backfill without trusting the session cursor and collapse ack/realtime echoes', async () => {
  const fake = state()
  const baseUrl = await fakeServer(fake)
  const runtime = new AtumMessagingRuntime({ userDataPath: tempUserData(), safeStorage })
  runtimes.push(runtime)
  await runtime.installSession(session(baseUrl))

  assert.deepEqual(fake.syncCursors, [null])
  assert.equal((await runtime.roster()).length, 1)
  assert.equal((await runtime.messages(CONVERSATION_A)).length, 1)

  await runtime.send({
    conversationId: CONVERSATION_A,
    clientMessageId: CLIENT_A,
    content: 'Một lần duy nhất',
    locale: 'vi'
  })
  fake.syncChanges = [
    {
      change_id: '9002',
      entity: 'message',
      operation: 'upsert',
      entity_id: `server-${CLIENT_A}`,
      conversation_id: CONVERSATION_A,
      value: { version: 1 },
      occurred_at: '2026-08-12T03:00:03.000Z'
    }
  ]
  await runtime.realtimeHint()

  const rows = await runtime.messages(CONVERSATION_A)
  assert.equal(rows.filter(row => row.clientMessageId === CLIENT_A || row.id === `server-${CLIENT_A}`).length, 1)
  assert.equal(rows.find(row => row.id === `server-${CLIENT_A}`)?.optimistic, false)
})

test('the frozen atum.social/1 connected thread sends one canonical text with exact durable bytes', async () => {
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/social-v1/s5-social-flow.json'), 'utf8')
  ) as {
    profile: string
    accounts: { alice_epoch: string }
    steps: Array<Record<string, unknown>>
  }

  assert.equal(fixture.profile, 's5.1-social-v1')

  const lookup = fixture.steps.find(step => step.event === 'lookup')?.response as {
    projection: Record<string, unknown>
  }

  const connected = fixture.steps.find(step => step.event === 'accept_ack') as {
    operation_id: string
    state: string
    can_message: boolean
    direct_thread_id: string
  }

  const threadId = connected.direct_thread_id

  const connectedProjection = parseSocialMutationResponse({
    account_epoch: fixture.accounts.alice_epoch,
    operation_id: connected.operation_id,
    replayed: false,
    projection: {
      ...lookup.projection,
      state: connected.state,
      version: 2,
      can_message: connected.can_message,
      direct_thread_id: connected.direct_thread_id
    }
  }).projection

  const fake = state()
  fake.conversations[ACCOUNT_A] = [conversation(threadId)]
  fake.messages[threadId] = []
  fake.syncChanges = []
  const baseUrl = await fakeServer(fake)
  const userData = tempUserData()

  const store = new AtumMessagingStore({
    accountId: ACCOUNT_A,
    databasePath: join(userData, 'atum-messaging', 'messaging.sqlite3')
  })

  store.applySocialProjection(fixture.accounts.alice_epoch, connectedProjection)
  store.close()

  const runtime = new AtumMessagingRuntime({ userDataPath: userData, safeStorage })
  runtimes.push(runtime)
  await runtime.installSession(session(baseUrl))
  const clientMessageId = '00000000-0000-4000-8000-88570ab55673'
  await runtime.send({ conversationId: threadId, clientMessageId, content: 'Chào Bob', locale: 'vi' })
  const sent = fake.requestLog.find(request => request.method === 'POST')
  assert.equal(sent?.idempotencyKey, clientMessageId)
  assert.equal(
    sent?.body,
    `{"attachment_ids":[],"client_message_id":"${clientMessageId}","content":"Chào Bob","locale":"vi","reply_to_message_id":null}`
  )

  fake.syncChanges = [
    {
      change_id: 'fixture-echo-1',
      entity: 'message',
      operation: 'upsert',
      entity_id: `server-${clientMessageId}`,
      conversation_id: threadId,
      value: { version: 1 },
      occurred_at: '2026-08-12T03:00:03.000Z'
    }
  ]
  fake.syncNextCursor = 'cursor-fixture-echo'
  await runtime.realtimeHint()
  const rows = await runtime.messages(threadId)
  assert.equal(rows.filter(row => row.id === `server-${clientMessageId}`).length, 1)
  assert.equal(rows.find(row => row.id === `server-${clientMessageId}`)?.optimistic, false)
})

test('history fails closed when a message does not belong to the requested conversation route', async () => {
  const fake = state()
  fake.messages[CONVERSATION_A] = [message(MESSAGE_A, CONVERSATION_B)]
  const baseUrl = await fakeServer(fake)
  const runtime = new AtumMessagingRuntime({ userDataPath: tempUserData(), safeStorage })
  runtimes.push(runtime)

  const result = await runtime.installSession(session(baseUrl))

  assert.equal(result.connectivity, 'offline_cached')
  assert.equal(result.errorCode, 'invalid_response:message.conversation_id_scope')
  assert.equal((await runtime.messages(CONVERSATION_A)).length, 0)
  assert.equal((await runtime.messages(CONVERSATION_B)).length, 0)
})

test('send acknowledgement fails closed when it targets a different conversation', async () => {
  const fake = state()
  const baseUrl = await fakeServer(fake)
  const runtime = new AtumMessagingRuntime({ userDataPath: tempUserData(), safeStorage })
  runtimes.push(runtime)
  await runtime.installSession(session(baseUrl))

  fake.sendConversationOverride = CONVERSATION_B

  await runtime.send({
    conversationId: CONVERSATION_A,
    clientMessageId: CLIENT_A,
    content: 'Không nhận phản hồi sai cuộc trò chuyện',
    locale: 'vi'
  })

  const rows = await runtime.messages(CONVERSATION_A)
  const optimistic = rows.find(row => row.clientMessageId === CLIENT_A)
  assert.equal((await runtime.status()).connectivity, 'online')
  assert.deepEqual(
    optimistic && {
      id: optimistic.id,
      clientMessageId: optimistic.clientMessageId,
      delivery: optimistic.delivery,
      optimistic: optimistic.optimistic
    },
    {
      id: null,
      clientMessageId: CLIENT_A,
      delivery: 'failed_terminal',
      optimistic: true
    }
  )
  assert.equal(
    rows.some(row => row.id === `server-${CLIENT_A}`),
    false
  )
  assert.equal((await runtime.messages(CONVERSATION_B)).length, 0)
})

test('an ordinary incremental poll with no changes does not refetch full message history', async () => {
  const fake = state()
  const baseUrl = await fakeServer(fake)
  const runtime = new AtumMessagingRuntime({ userDataPath: tempUserData(), safeStorage })
  runtimes.push(runtime)
  await runtime.installSession(session(baseUrl))

  const historyRequestsAfterBackfill = fake.requestLog.filter(
    request => request.method === 'GET' && /\/conversations\/[^/]+\/messages(?:\?|$)/.test(request.path)
  ).length

  fake.syncChanges = []
  await runtime.sync()

  assert.equal(historyRequestsAfterBackfill, 1)
  assert.equal(
    fake.requestLog.filter(
      request => request.method === 'GET' && /\/conversations\/[^/]+\/messages(?:\?|$)/.test(request.path)
    ).length,
    historyRequestsAfterBackfill
  )
})

test('incremental history scope failure preserves cached rows and safely replays after repair', async () => {
  const fake = state()
  const baseUrl = await fakeServer(fake)
  const runtime = new AtumMessagingRuntime({ userDataPath: tempUserData(), safeStorage })
  runtimes.push(runtime)
  await runtime.installSession(session(baseUrl))

  fake.syncChanges = [{ ...fake.syncChanges[0], change_id: '9002' }]
  fake.messages[CONVERSATION_A] = [message(MESSAGE_A, CONVERSATION_B)]

  const poisoned = await runtime.sync()
  assert.equal(poisoned.connectivity, 'offline_cached')
  assert.equal(poisoned.errorCode, 'invalid_response:message.conversation_id_scope')
  assert.deepEqual(
    (await runtime.messages(CONVERSATION_A)).map(row => row.id),
    [MESSAGE_A]
  )
  assert.equal((await runtime.messages(CONVERSATION_B)).length, 0)

  fake.messages[CONVERSATION_A] = [message()]

  const recovered = await runtime.sync()
  assert.equal(recovered.connectivity, 'online')
  assert.equal(recovered.errorCode, null)
  assert.deepEqual(
    (await runtime.messages(CONVERSATION_A)).map(row => row.id),
    [MESSAGE_A]
  )
})

test('message deletion cannot cross conversation scope and safely replays after repair', async () => {
  const fake = state()
  const baseUrl = await fakeServer(fake)
  const runtime = new AtumMessagingRuntime({ userDataPath: tempUserData(), safeStorage })
  runtimes.push(runtime)
  await runtime.installSession(session(baseUrl))

  fake.syncNextCursor = 'cursor-delete'
  fake.syncChanges = [
    {
      change_id: '9002',
      entity: 'message',
      operation: 'delete',
      entity_id: MESSAGE_A,
      conversation_id: CONVERSATION_B,
      value: null,
      occurred_at: '2026-08-12T03:00:03.000Z'
    }
  ]
  fake.messages[CONVERSATION_A] = []

  const poisoned = await runtime.sync()
  assert.equal(poisoned.connectivity, 'offline_cached')
  assert.equal(poisoned.errorCode, 'invalid_response:sync.message_delete.conversation_id_scope')
  assert.equal(poisoned.cursor, 'cursor-a')
  assert.equal(poisoned.nextRetryAt, null)
  assert.deepEqual(
    (await runtime.messages(CONVERSATION_A)).map(row => row.id),
    [MESSAGE_A]
  )
  assert.equal((await runtime.messages(CONVERSATION_B)).length, 0)

  fake.syncChanges = [{ ...fake.syncChanges[0], conversation_id: CONVERSATION_A }]

  const recovered = await runtime.sync()
  assert.equal(recovered.connectivity, 'online')
  assert.equal(recovered.errorCode, null)
  assert.equal(recovered.cursor, 'cursor-delete')
  assert.equal((await runtime.messages(CONVERSATION_A)).length, 0)
  assert.equal((await runtime.messages(CONVERSATION_B)).length, 0)
})

test('message deletion without conversation scope fails closed', async () => {
  const fake = state()
  const baseUrl = await fakeServer(fake)
  const runtime = new AtumMessagingRuntime({ userDataPath: tempUserData(), safeStorage })
  runtimes.push(runtime)
  await runtime.installSession(session(baseUrl))

  fake.syncNextCursor = 'cursor-unscoped-delete'
  fake.syncChanges = [
    {
      change_id: '9002',
      entity: 'message',
      operation: 'delete',
      entity_id: MESSAGE_A,
      conversation_id: null,
      value: null,
      occurred_at: '2026-08-12T03:00:03.000Z'
    }
  ]
  fake.messages[CONVERSATION_A] = []

  const poisoned = await runtime.sync()
  assert.equal(poisoned.connectivity, 'offline_cached')
  assert.equal(poisoned.errorCode, 'invalid_response:sync.message_delete.conversation_id_scope')
  assert.equal(poisoned.cursor, 'cursor-a')
  assert.equal(poisoned.nextRetryAt, null)
  assert.deepEqual(
    (await runtime.messages(CONVERSATION_A)).map(row => row.id),
    [MESSAGE_A]
  )
})

test('mark-read advances local unread state even when the hosted write is offline', async () => {
  const fake = state()
  const baseUrl = await fakeServer(fake)
  const userDataPath = tempUserData()
  const initial = new AtumMessagingRuntime({ userDataPath, safeStorage })
  runtimes.push(initial)
  await initial.installSession(session(baseUrl))
  initial.stop()

  const store = new AtumMessagingStore({
    accountId: ACCOUNT_A,
    databasePath: join(userDataPath, 'atum-messaging', 'messaging.sqlite3')
  })

  const unreadId = '00000000-0000-4000-8000-fbfe405ca65f'

  const unread: CanonicalMessage = {
    id: unreadId,
    conversationId: CONVERSATION_A,
    sender: { type: 'user', id: ACCOUNT_B },
    content: 'Tin chưa đọc',
    kind: 'text',
    attachments: [],
    metadata: null,
    replyToMessageId: null,
    forwardedFrom: null,
    reactions: [],
    version: 1,
    createdAt: '2026-08-12T03:00:03.000Z',
    editedAt: null,
    recalledAt: null,
    delivery: 'sent'
  }

  store.canonicalizeMessage({
    message: unread,
    incrementUnread: true
  })
  assert.equal(store.listConversations()[0]?.unreadCount, 1)
  store.close()

  fake.syncChanges = []
  const runtime = new AtumMessagingRuntime({ userDataPath, safeStorage })
  runtimes.push(runtime)
  await runtime.start()
  fake.readFailure = true

  assert.equal(await runtime.markRead(CONVERSATION_A, unreadId), true)
  assert.equal((await runtime.roster())[0]?.unreadCount, 0)
  assert.equal((await runtime.status()).connectivity, 'offline_cached')
  assert.equal(await runtime.markRead(CONVERSATION_A, 'not-yet-projected'), false)
})

test('401 refresh is owned by main and replays the rejected request exactly once', async () => {
  const fake = state()
  const baseUrl = await fakeServer(fake)
  let refreshes = 0

  const runtime = new AtumMessagingRuntime({
    userDataPath: tempUserData(),
    safeStorage,
    refreshSession: async rejected => {
      refreshes += 1

      return { ...rejected, tokens: { ...rejected.tokens, accessToken: 'token-a' } }
    }
  })

  runtimes.push(runtime)
  await runtime.installSession(session(baseUrl, ACCOUNT_A, 'expired-token'))

  assert.equal(refreshes, 1)
  assert.equal((await runtime.status()).connectivity, 'online')
  assert.deepEqual(
    fake.requestLog.slice(0, 2).map(request => request.authorization),
    ['Bearer expired-token', 'Bearer token-a']
  )
})

test('cursor advances only after a page is durably projected and errors never become empty success', async () => {
  const fake = state()
  fake.rosterFailure = true
  const baseUrl = await fakeServer(fake)
  const userData = tempUserData()
  const runtime = new AtumMessagingRuntime({ userDataPath: userData, safeStorage })
  runtimes.push(runtime)
  const failed = await runtime.installSession(session(baseUrl))

  assert.equal(failed.cursor, null)
  assert.equal(failed.connectivity, 'error')

  fake.rosterFailure = false
  await runtime.sync()
  assert.deepEqual(fake.syncCursors, [null, null])
  assert.equal((await runtime.status()).cursor, 'cursor-a')
  assert.equal((await runtime.roster()).length, 1)

  fake.rosterFailure = true
  fake.syncChanges = [{ ...fake.syncChanges[0], change_id: '9002' }]
  await runtime.sync()
  assert.equal((await runtime.status()).connectivity, 'offline_cached')
  assert.equal((await runtime.roster()).length, 1, 'cached roster survives an explicit server error')
})

test('a crash after page projection replays idempotently before committing the cursor', async () => {
  const fake = state()
  const baseUrl = await fakeServer(fake)
  const userData = tempUserData()
  let crash = true

  const runtime = new AtumMessagingRuntime({
    userDataPath: userData,
    safeStorage,
    afterPageProjectionBeforeCursorCommit: () => {
      if (crash) {
        crash = false
        throw new Error('simulated_projection_crash')
      }
    }
  })

  runtimes.push(runtime)

  const interrupted = await runtime.installSession(session(baseUrl))
  assert.equal(interrupted.cursor, null)
  assert.equal(interrupted.errorCode, 'simulated_projection_crash')
  assert.equal((await runtime.messages(CONVERSATION_A)).filter(row => row.id === MESSAGE_A).length, 1)
  runtime.stop()

  const projected = new AtumMessagingStore({
    accountId: ACCOUNT_A,
    databasePath: join(userData, 'atum-messaging', 'messaging.sqlite3')
  })

  assert.equal(projected.getSyncCursor().cursor, null)
  assert.equal(projected.listMessages(CONVERSATION_A).filter(row => row.id === MESSAGE_A).length, 1)
  projected.close()

  const restarted = new AtumMessagingRuntime({
    userDataPath: userData,
    safeStorage,
    afterPageProjectionBeforeCursorCommit: () => undefined
  })

  runtimes.push(restarted)
  const recovered = await restarted.start()
  assert.equal(recovered.cursor, 'cursor-a')
  assert.deepEqual(fake.syncCursors, [null, null])
  assert.equal((await restarted.messages(CONVERSATION_A)).filter(row => row.id === MESSAGE_A).length, 1)
})

test('cursor expiry resets only cloud projection and preserves draft and queued text outbox', async () => {
  const fake = state()
  const baseUrl = await fakeServer(fake)
  const userData = tempUserData()
  const runtime = new AtumMessagingRuntime({ userDataPath: userData, safeStorage })
  runtimes.push(runtime)
  await runtime.installSession(session(baseUrl))
  await runtime.saveDraft(CONVERSATION_A, { text: 'Giữ bản nháp' })

  fake.syncFailure = true
  await runtime.sync()
  await runtime.send({
    conversationId: CONVERSATION_A,
    clientMessageId: CLIENT_A,
    content: 'Gửi lại sau',
    locale: 'vi'
  })
  assert.equal(fake.requestLog.filter(request => request.method === 'POST').length, 0)
  assert.equal(
    (await runtime.messages(CONVERSATION_A)).find(row => row.clientMessageId === CLIENT_A)?.delivery,
    'queued'
  )

  fake.syncFailure = false
  fake.syncCursorExpired = true
  const expired = await runtime.sync()
  fake.syncCursorExpired = false
  assert.equal(expired.cursor, null)
  assert.equal(expired.connectivity, 'reconnecting')
  assert.notEqual(expired.nextRetryAt, null)
  assert.deepEqual(fake.syncCursors.slice(-1), ['cursor-a'])
  runtime.stop()

  const reopened = new AtumMessagingStore({
    accountId: ACCOUNT_A,
    databasePath: join(userData, 'atum-messaging', 'messaging.sqlite3')
  })

  assert.equal(reopened.getDraft(CONVERSATION_A)?.text, 'Giữ bản nháp')
  const due = reopened.listDueMutations('9999-01-01T00:00:00.000Z')
  const storedBytes = JSON.stringify(due[0]?.request)
  assert.equal(due[0]?.clientMessageId, CLIENT_A)
  assert.equal(reopened.listMessages(CONVERSATION_A).find(row => row.clientMessageId === CLIENT_A)?.delivery, 'queued')
  reopened.close()

  const restarted = new AtumMessagingRuntime({ userDataPath: userData, safeStorage })
  runtimes.push(restarted)
  await restarted.start()
  const drained = fake.requestLog.find(request => request.method === 'POST' && request.idempotencyKey === CLIENT_A)
  assert.equal(drained?.body, storedBytes)
  assert.equal((await restarted.messages(CONVERSATION_A)).filter(row => row.clientMessageId === CLIENT_A).length, 1)
})

test('offline send retries with identical bytes and restart recovers a sending outbox row', async () => {
  const fake = state()
  const baseUrl = await fakeServer(fake)
  const userData = tempUserData()
  const runtime = new AtumMessagingRuntime({ userDataPath: userData, safeStorage })
  runtimes.push(runtime)
  await runtime.installSession(session(baseUrl))

  fake.sendFailure = true
  await runtime.send({ conversationId: CONVERSATION_A, clientMessageId: CLIENT_A, content: 'Giữ nguyên', locale: 'vi' })
  assert.equal(
    (await runtime.messages(CONVERSATION_A)).find(row => row.clientMessageId === CLIENT_A)?.delivery,
    'failed_retryable'
  )
  const firstBody = fake.requestLog.find(request => request.method === 'POST')?.body
  fake.sendFailure = false
  await runtime.retry(CLIENT_A)
  const sendBodies = fake.requestLog.filter(request => request.method === 'POST').map(request => request.body)
  assert.deepEqual(sendBodies, [firstBody, firstBody])
  assert.deepEqual(
    fake.requestLog.filter(request => request.method === 'POST').map(request => request.idempotencyKey),
    [CLIENT_A, CLIENT_A]
  )

  runtime.stop()

  const store = new AtumMessagingStore({
    accountId: ACCOUNT_A,
    databasePath: join(userData, 'atum-messaging', 'messaging.sqlite3')
  })

  const restartClientMessageId = '00000000-0000-4000-8000-e8d95748107a'
  store.queueSend({
    conversationId: CONVERSATION_A,
    clientMessageId: restartClientMessageId,
    content: 'Khôi phục sau restart',
    locale: 'vi'
  })
  const interrupted = store.markMutationSending(restartClientMessageId)
  const interruptedBytes = JSON.stringify(interrupted.request)
  store.close()

  const restarted = new AtumMessagingRuntime({ userDataPath: userData, safeStorage })
  runtimes.push(restarted)
  await restarted.start()

  const replay = fake.requestLog.find(
    request => request.method === 'POST' && request.idempotencyKey === restartClientMessageId
  )

  assert.equal(replay?.body, interruptedBytes)
  assert.equal(replay?.idempotencyKey, restartClientMessageId)
  assert.equal(
    (await restarted.messages(CONVERSATION_A)).some(
      row =>
        row.clientMessageId === restartClientMessageId && row.content === 'Khôi phục sau restart' && !row.optimistic
    ),
    true
  )
})

test('an explicit assistant mention survives offline restart with identical scope and stays account-partitioned', async () => {
  const fake = state()
  const baseUrl = await fakeServer(fake)
  const userData = tempUserData()
  const first = new AtumMessagingRuntime({ userDataPath: userData, safeStorage })
  runtimes.push(first)
  await first.installSession(session(baseUrl))

  fake.sendFailure = true
  await first.send({
    conversationId: CONVERSATION_A,
    clientMessageId: CLIENT_A,
    content: '@Atum giúp tụi mình chốt quyết định',
    locale: 'vi',
    mention: { agent: 'binh-minh', revision: 0, startOffset: 0, endOffset: 5 }
  })

  const failedRequest = fake.requestLog.find(
    request => request.method === 'POST' && request.idempotencyKey === CLIENT_A
  )!

  assert.deepEqual(JSON.parse(failedRequest.body).mention, {
    agent: 'binh-minh',
    revision: 0,
    start_offset: 0,
    end_offset: 5
  })
  first.stop()

  fake.sendFailure = false
  const restarted = new AtumMessagingRuntime({ userDataPath: userData, safeStorage })
  runtimes.push(restarted)
  await restarted.start()

  const mentionRequests = fake.requestLog.filter(
    request => request.method === 'POST' && request.idempotencyKey === CLIENT_A
  )

  assert.deepEqual(
    mentionRequests.map(request => request.body),
    [failedRequest.body, failedRequest.body]
  )
  assert.equal((await restarted.messages(CONVERSATION_A)).filter(row => row.clientMessageId === CLIENT_A).length, 1)

  await restarted.installSession(session(baseUrl, ACCOUNT_B, 'token-b'))
  assert.equal(
    (await restarted.messages(CONVERSATION_A)).some(row => row.clientMessageId === CLIENT_A),
    false
  )
})

test('S2 capability close fences stale network, realtime, renderer publication, and SQLite writes', async () => {
  const fake = state()
  const baseUrl = await fakeServer(fake)
  const userData = tempUserData()
  const writes = new Map<string, number>()
  const closed = new Set<string>()
  const projections: string[][] = []
  let realtimeHint: ((message: unknown) => void) | null = null
  let disconnected = 0
  let unsubscribed = 0

  const writeMethods = new Set([
    'upsertConversation',
    'saveDraft',
    'queueSend',
    'markMutationSending',
    'markMutationFailed',
    'retryMutation',
    'canonicalizeMessage',
    'deleteCanonicalMessage',
    'markRead',
    'queueReadReceipt',
    'markReadReceiptSending',
    'markReadReceiptSent',
    'markReadReceiptFailed',
    'commitSyncCursor',
    'recordSyncChange',
    'applySocialProjection',
    'invalidateSocialProfile',
    'commitSocialCursor',
    'resetProjection'
  ])

  const openStore = (accountId: string): DirectMessagingStoreBoundary => {
    const target = new AtumMessagingStore({ accountId, databasePath: join(userData, `${accountId}.sqlite3`) })

    return new Proxy(target, {
      get(instance, property) {
        const value = Reflect.get(instance, property, instance)

        if (typeof value !== 'function') {
          return value
        }

        return (...args: unknown[]) => {
          if (property === 'close') {
            closed.add(accountId)
          } else if (writeMethods.has(String(property))) {
            writes.set(accountId, (writes.get(accountId) ?? 0) + 1)
          }

          return value.apply(instance, args)
        }
      }
    }) as DirectMessagingStoreBoundary
  }

  const channel = {
    on: (_type: 'broadcast', _filter: { event: string }, callback: (message: unknown) => void) => {
      realtimeHint = callback

      return channel
    },
    subscribe: () => channel,
    unsubscribe: async () => {
      unsubscribed += 1
    }
  }

  const realtimeClient = {
    channel: () => channel,
    connect: () => undefined,
    disconnect: () => {
      disconnected += 1
    },
    setAuth: () => undefined
  }

  const runtime = new AtumMessagingRuntime({
    userDataPath: userData,
    safeStorage,
    openStore: accountId => openStore(accountId),
    projectionChanged: roster => projections.push(roster.map(row => row.id)),
    realtime: { url: 'https://realtime.example', anonKey: 'public-anon-key' },
    createRealtimeClient: async () => realtimeClient
  })

  runtimes.push(runtime)
  await runtime.installSession(session(baseUrl))

  const deadline = Date.now() + 2_000

  while (!realtimeHint) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for realtime subscription')
    }

    await new Promise(resolve => setTimeout(resolve, 5))
  }

  fake.hangSessionTokens = new Set(['token-a'])
  const requestStart = fake.requestLog.length
  const staleSync = runtime.sync()
  const staleRealtime = runtime.realtimeHint()
  await waitForRequest(
    fake,
    request => fake.requestLog.indexOf(request) >= requestStart && request.path.endsWith('/session')
  )
  await runtime.quiesce()
  const writesAtFence = writes.get(ACCOUNT_A) ?? 0
  const eventsAtFence = projections.length
  realtimeHint?.({ payload: { cursor_hint: 'cursor-after-close' } })
  await Promise.all([staleSync, staleRealtime])
  await Promise.resolve()

  assert.equal(closed.has(ACCOUNT_A), true)
  assert.equal(writes.get(ACCOUNT_A) ?? 0, writesAtFence)
  assert.equal(projections.length, eventsAtFence)
  assert.deepEqual(projections.at(-1), [])
  assert.ok(disconnected >= 1)
  assert.ok(unsubscribed >= 1)

  await runtime.installSession(session(baseUrl, ACCOUNT_B, 'token-b'))
  assert.deepEqual(projections.at(-1), [CONVERSATION_B])
  assert.equal(writes.get(ACCOUNT_A) ?? 0, writesAtFence)
})

test('account switch closes the previous projection boundary and opens the verified account partition', async () => {
  const fake = state()
  const baseUrl = await fakeServer(fake)
  const runtime = new AtumMessagingRuntime({ userDataPath: tempUserData(), safeStorage })
  runtimes.push(runtime)
  await runtime.installSession(session(baseUrl))
  assert.deepEqual(
    (await runtime.roster()).map(row => row.id),
    [CONVERSATION_A]
  )

  await runtime.installSession(session(baseUrl, ACCOUNT_B, 'token-b'))
  assert.equal((await runtime.status()).accountId, ACCOUNT_B)
  assert.deepEqual(
    (await runtime.roster()).map(row => row.id),
    [CONVERSATION_B]
  )
  assert.equal((await runtime.messages(CONVERSATION_A)).length, 0)
})

test('direct sync refuses a provider subject that differs from the S2-owned account scope', async () => {
  const fake = state()
  const baseUrl = await fakeServer(fake)
  const runtime = new AtumMessagingRuntime({ userDataPath: tempUserData(), safeStorage })
  runtimes.push(runtime)

  const status = await runtime.installSession(session(baseUrl, ACCOUNT_B, 'token-a'))

  assert.equal(status.accountId, ACCOUNT_B)
  assert.equal(status.connectivity, 'error')
  assert.equal(status.errorCode, 'account_scope_mismatch')
  assert.equal(status.nextRetryAt, null)
  assert.deepEqual(await runtime.roster(), [])

  const recovered = await runtime.installSession(session(baseUrl, ACCOUNT_B, 'token-b'))

  assert.equal(recovered.connectivity, 'online')
  assert.deepEqual(
    (await runtime.roster()).map(row => row.id),
    [CONVERSATION_B]
  )
})

test('a bounded HTTP timeout aborts a hung server request and explicit retry recovers', async () => {
  const fake = state()
  fake.hangSessionTokens = new Set(['token-a'])
  const baseUrl = await fakeServer(fake)

  const runtime = new AtumMessagingRuntime({
    userDataPath: tempUserData(),
    safeStorage,
    requestTimeoutMs: 250
  })

  runtimes.push(runtime)

  const timedOut = await runtime.installSession(session(baseUrl))
  assert.equal(timedOut.connectivity, 'error')
  assert.equal(timedOut.errorCode, 'temporarily_unavailable')

  const recovered = await runtime.sync()
  assert.equal(recovered.connectivity, 'online')
  assert.deepEqual(
    (await runtime.roster()).map(row => row.id),
    [CONVERSATION_A]
  )
})

test('stop and account switch abort stale in-flight work without reopening or clobbering stores', async () => {
  const fake = state()
  const baseUrl = await fakeServer(fake)

  const stoppedRuntime = new AtumMessagingRuntime({
    userDataPath: tempUserData(),
    safeStorage,
    requestTimeoutMs: 5_000
  })

  runtimes.push(stoppedRuntime)
  await stoppedRuntime.installSession(session(baseUrl))

  fake.hangSessionTokens = new Set(['token-a'])
  const stopRequestStart = fake.requestLog.length
  const stoppedSync = stoppedRuntime.sync()
  await waitForRequest(
    fake,
    request => fake.requestLog.indexOf(request) >= stopRequestStart && request.path.endsWith('/session')
  )
  stoppedRuntime.stop()
  await stoppedSync
  assert.throws(() => stoppedRuntime.roster(), /auth_unavailable/)

  const switchedRuntime = new AtumMessagingRuntime({
    userDataPath: tempUserData(),
    safeStorage,
    requestTimeoutMs: 5_000
  })

  runtimes.push(switchedRuntime)
  await switchedRuntime.installSession(session(baseUrl))
  fake.hangSessionTokens = new Set(['token-a'])
  const switchRequestStart = fake.requestLog.length
  const staleSync = switchedRuntime.sync()
  await waitForRequest(
    fake,
    request => fake.requestLog.indexOf(request) >= switchRequestStart && request.path.endsWith('/session')
  )

  const switched = await switchedRuntime.installSession(session(baseUrl, ACCOUNT_B, 'token-b'))
  await staleSync
  assert.equal(switched.accountId, ACCOUNT_B)
  assert.equal((await switchedRuntime.status()).connectivity, 'online')
  assert.deepEqual(
    (await switchedRuntime.roster()).map(row => row.id),
    [CONVERSATION_B]
  )
  assert.equal((await switchedRuntime.messages(CONVERSATION_A)).length, 0)
})

test('a refresh completing after account switch cannot overwrite or replay the previous account', async () => {
  const fake = state()
  const baseUrl = await fakeServer(fake)
  let markRefreshStarted!: () => void
  let resolveRefresh!: (value: MessagingAccountSession) => void

  const refreshStarted = new Promise<void>(resolve => {
    markRefreshStarted = resolve
  })

  const runtime = new AtumMessagingRuntime({
    userDataPath: tempUserData(),
    safeStorage,
    refreshSession: rejected =>
      new Promise<MessagingAccountSession>(refreshResolve => {
        resolveRefresh = refreshResolve
        markRefreshStarted()
      }).then(refreshed => ({ ...rejected, ...refreshed }))
  })

  runtimes.push(runtime)

  const staleInstall = runtime.installSession(session(baseUrl, ACCOUNT_A, 'expired-token'))
  await refreshStarted
  await runtime.installSession(session(baseUrl, ACCOUNT_B, 'token-b'))
  resolveRefresh(session(baseUrl, ACCOUNT_A, 'token-a'))
  await staleInstall
  assert.equal((await runtime.status()).accountId, ACCOUNT_B)
  assert.deepEqual(
    (await runtime.roster()).map(row => row.id),
    [CONVERSATION_B]
  )
  assert.equal(
    fake.requestLog.filter(request => request.authorization === 'Bearer token-a').length,
    0,
    'stale refresh must not replay its request after the lifecycle was aborted'
  )
})

test('send and retry 401 responses become auth_expired without rejecting the renderer command', async () => {
  const fake = state()
  const baseUrl = await fakeServer(fake)
  const runtime = new AtumMessagingRuntime({ userDataPath: tempUserData(), safeStorage })
  runtimes.push(runtime)
  await runtime.installSession(session(baseUrl))

  fake.sendAuthFailure = true
  await runtime.send({
    conversationId: CONVERSATION_A,
    clientMessageId: CLIENT_A,
    content: 'Auth hết hạn khi gửi',
    locale: 'vi'
  })
  assert.equal((await runtime.status()).connectivity, 'auth_expired')
  assert.equal((await runtime.status()).errorCode, 'token_expired')

  fake.sendAuthFailure = false
  await runtime.installSession(session(baseUrl))
  fake.sendFailure = true
  const retryClient = '00000000-0000-4000-8000-f1d11edf5c5c'
  await runtime.send({
    conversationId: CONVERSATION_A,
    clientMessageId: retryClient,
    content: 'Auth hết hạn khi thử lại',
    locale: 'vi'
  })
  fake.sendFailure = false
  fake.sendAuthFailure = true
  await runtime.retry(retryClient)
  assert.equal((await runtime.status()).connectivity, 'auth_expired')
  assert.equal((await runtime.status()).errorCode, 'token_expired')
})

test('server retry_after_ms is finite and clamped before it reaches the durable outbox', async () => {
  const fake = state()
  fake.sendFailure = true
  fake.sendRetryAfterMs = Number.MAX_SAFE_INTEGER
  const baseUrl = await fakeServer(fake)
  const userDataPath = tempUserData()
  const runtime = new AtumMessagingRuntime({ userDataPath, safeStorage })
  runtimes.push(runtime)
  await runtime.installSession(session(baseUrl))
  await runtime.send({
    conversationId: CONVERSATION_A,
    clientMessageId: CLIENT_A,
    content: 'Thử lại có giới hạn',
    locale: 'vi'
  })
  runtime.stop()

  const store = new AtumMessagingStore({
    accountId: ACCOUNT_A,
    databasePath: join(userDataPath, 'atum-messaging', 'messaging.sqlite3')
  })

  assert.equal(
    store.listDueMutations(new Date(Date.now() + 301_000).toISOString()).some(row => row.clientMessageId === CLIENT_A),
    true
  )
  store.close()
})

test('wire and pagination caps turn deterministic poison pages into explicit non-looping errors', async () => {
  const fake = state()
  fake.syncChanges = [{ ...fake.syncChanges[0], change_id: `poison-${'x'.repeat(8_192)}` }]
  const baseUrl = await fakeServer(fake)
  const poisonRuntime = new AtumMessagingRuntime({ userDataPath: tempUserData(), safeStorage })
  runtimes.push(poisonRuntime)
  const poison = await poisonRuntime.installSession(session(baseUrl))
  assert.equal(poison.connectivity, 'error')
  assert.match(poison.errorCode ?? '', /invalid_response:sync\.changes\.0\.change_id/)
  assert.equal(poison.nextRetryAt, null)

  const pagedFake = state()
  pagedFake.syncAlwaysHasMore = true
  const pagedBaseUrl = await fakeServer(pagedFake)

  const pagedRuntime = new AtumMessagingRuntime({
    userDataPath: tempUserData(),
    safeStorage,
    maxSyncPages: 2
  })

  runtimes.push(pagedRuntime)
  const capped = await pagedRuntime.installSession(session(pagedBaseUrl))
  assert.equal(capped.errorCode, 'sync_page_limit')
  assert.equal(capped.nextRetryAt, null)
  assert.equal(pagedFake.syncCursors.length, 2)
})

test('oversized responses are rejected before JSON projection', async () => {
  const fake = state()
  fake.oversizedSessionBytes = 2_000
  const baseUrl = await fakeServer(fake)

  const runtime = new AtumMessagingRuntime({
    userDataPath: tempUserData(),
    safeStorage,
    maxResponseBytes: 1_024
  })

  runtimes.push(runtime)
  const result = await runtime.installSession(session(baseUrl))
  assert.equal(result.connectivity, 'error')
  assert.equal(result.errorCode, 'invalid_response')
  assert.equal(result.nextRetryAt, null)
})

test('app disconnect uses the signed-in HTTP authority and cleans up only after success', async () => {
  const fake = state()
  const baseUrl = await fakeServer(fake)
  const cleanups: Array<{ accountId: string; app: string }> = []

  const runtime = new AtumMessagingRuntime({
    userDataPath: tempUserData(),
    safeStorage,
    appDisconnected: async scope => {
      cleanups.push(scope)
    }
  })

  runtimes.push(runtime)
  await runtime.installSession(session(baseUrl))
  fake.disconnectFailure = true
  await assert.rejects(runtime.disconnectApp('moon'))
  assert.deepEqual(cleanups, [])
  fake.disconnectFailure = false
  await runtime.disconnectApp('moon')
  assert.deepEqual(cleanups, [{ accountId: ACCOUNT_A, app: 'moon' }])
  const request = fake.requestLog.filter(row => row.path.endsWith('/moon/disconnect')).at(-1)!
  assert.equal(request.authorization, 'Bearer token-a')
  assert.equal(request.method, 'POST')
  assert.equal(request.body, '')
})

test('a confirmed server disconnect retries transient local cleanup without repeating the server action', async () => {
  const fake = state()
  const baseUrl = await fakeServer(fake)
  let attempts = 0
  const runtime = new AtumMessagingRuntime({
    userDataPath: tempUserData(),
    safeStorage,
    appDisconnected: async () => {
      if (++attempts === 1) {
        throw new Error('partition clear failed')
      }
    }
  })
  runtimes.push(runtime)
  await runtime.installSession(session(baseUrl))
  assert.deepEqual(await runtime.disconnectApp('moon'), { localCleanup: 'complete' })
  assert.equal(attempts, 2)
  assert.equal(fake.requestLog.filter(row => row.path.endsWith('/moon/disconnect')).length, 1)
})

test('a persistent local cleanup failure keeps the confirmed server disconnect and offers cleanup again', async () => {
  const fake = state()
  const baseUrl = await fakeServer(fake)
  const runtime = new AtumMessagingRuntime({
    userDataPath: tempUserData(),
    safeStorage,
    appDisconnected: async () => {
      throw new Error('partition clear failed')
    }
  })
  runtimes.push(runtime)
  await runtime.installSession(session(baseUrl))
  assert.deepEqual(await runtime.disconnectApp('moon'), { localCleanup: 'unconfirmed' })
  assert.equal(fake.requestLog.filter(row => row.path.endsWith('/moon/disconnect')).length, 1)
})
