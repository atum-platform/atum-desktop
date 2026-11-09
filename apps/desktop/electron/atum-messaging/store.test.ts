import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import { afterEach, test } from 'vitest'

import { applyMessagingMigrations, MESSAGING_MIGRATIONS } from './migrations'
import type { SocialProjection } from './social'
import { AtumMessagingStore } from './store'
import type { CanonicalMessage, MessagingConversation } from './types'

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'atum-messaging-'))
  tempDirectories.push(directory)

  return join(directory, 'messaging.sqlite3')
}

function conversation(id: string, lastMessageAt = '2026-08-12T03:00:00.000Z') {
  return {
    id,
    title: `Conversation ${id}`,
    kind: 'direct',
    participantIds: ['user-a', 'user-b'],
    updatedAt: lastMessageAt,
    lastMessageAt,
    payload: { id }
  } satisfies Omit<MessagingConversation, 'unreadCount'>
}

function message(id: string, conversationId: string, createdAt: string, content = `Message ${id}`): CanonicalMessage {
  return {
    id,
    conversationId,
    sender: { type: 'user', id: 'user-b' },
    content,
    kind: 'text',
    attachments: [],
    metadata: null,
    replyToMessageId: null,
    forwardedFrom: null,
    reactions: [],
    version: 1,
    createdAt,
    editedAt: null,
    recalledAt: null,
    delivery: 'sent'
  }
}

test('migrates deterministically from v1 and rejects modified migration history', () => {
  const path = databasePath()
  const oldDatabase = new DatabaseSync(path)
  applyMessagingMigrations(oldDatabase, 1)
  assert.equal((oldDatabase.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1)
  oldDatabase.close()

  const store = new AtumMessagingStore({ accountId: 'account-a', databasePath: path })
  store.close()
  const migrated = new DatabaseSync(path)
  assert.equal(
    (migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    MESSAGING_MIGRATIONS.at(-1)!.version
  )
  assert.ok(migrated.prepare("SELECT 1 AS present FROM sqlite_master WHERE name = 'messaging_pending_mutations'").get())
  migrated.prepare('UPDATE messaging_schema_migrations SET checksum = ? WHERE version = 1').run('tampered')
  migrated.close()

  assert.throws(
    () => new AtumMessagingStore({ accountId: 'account-a', databasePath: path }),
    /Unknown or modified messaging migration/
  )
})

test('reopens a freshly migrated account database without replaying schema creation', () => {
  const path = databasePath()
  const first = new AtumMessagingStore({ accountId: 'account-a', databasePath: path })
  first.close()
  const second = new AtumMessagingStore({ accountId: 'account-a', databasePath: path })
  second.close()

  const database = new DatabaseSync(path)
  assert.equal(
    (database.prepare('SELECT count(*) AS count FROM messaging_schema_migrations').get() as { count: number }).count,
    MESSAGING_MIGRATIONS.length
  )
  database.close()
})

test('social block is atomic, survives restart, preserves history, and unblock does not reconnect', () => {
  const path = databasePath()
  const accountEpoch = '00000000-0000-4000-8000-d98016d67fb8'
  const threadId = '00000000-0000-4000-8000-1d1ea877549e'

  const base = {
    availability: 'available',
    profile: {
      profileId: '00000000-0000-4000-8000-e03cc076d760',
      displayName: 'Bob',
      handle: 'social-bob',
      verified: false,
      avatar: null
    },
    directThreadId: threadId
  } as const

  const store = new AtumMessagingStore({ accountId: 'account-a', databasePath: path })
  store.applySocialProjection(accountEpoch, { ...base, state: 'connected', version: 2, canMessage: true })
  store.canonicalizeMessage({ message: message('server-history', threadId, '2026-08-30T00:00:00.000Z') })
  store.saveDraft(threadId, { text: 'draft' })
  store.queueSend({ conversationId: threadId, clientMessageId: 'pending-send', content: 'hello', locale: 'en' })

  store.applySocialProjection(accountEpoch, { ...base, state: 'blocked_by_me', version: 3, canMessage: false })
  assert.equal(store.getDraft(threadId), null)
  assert.equal(store.listDueMutations('2099-01-01T00:00:00.000Z').length, 0)
  assert.throws(
    () => store.queueSend({ conversationId: threadId, clientMessageId: 'denied', content: 'no', locale: 'en' }),
    /direct_compose_denied/
  )
  assert.equal(
    store.listMessages(threadId).some(row => row.id === 'server-history'),
    true
  )
  store.close()

  const restarted = new AtumMessagingStore({ accountId: 'account-a', databasePath: path })
  assert.equal(restarted.socialRelationshipForThread(threadId)?.state, 'blocked_by_me')
  assert.equal(
    restarted.listMessages(threadId).some(row => row.id === 'server-history'),
    true
  )
  restarted.applySocialProjection(accountEpoch, { ...base, state: 'none', version: 4, canMessage: false })
  assert.equal(restarted.socialRelationshipForThread(threadId)?.canMessage, false)
  assert.throws(() => restarted.saveDraft(threadId, { text: 'still denied' }), /direct_compose_denied/)
  restarted.close()
})

test('social replica rejects wrong account epoch and stale projection versions', () => {
  const store = new AtumMessagingStore({ accountId: 'account-a', databasePath: databasePath() })

  const projection: SocialProjection = {
    availability: 'available',
    profile: {
      profileId: '00000000-0000-4000-8000-e03cc076d760',
      displayName: 'Bob',
      handle: 'social-bob',
      verified: false,
      avatar: null
    },
    state: 'outgoing_pending',
    version: 2,
    canMessage: false,
    directThreadId: null
  }

  store.applySocialProjection('00000000-0000-4000-8000-d98016d67fb8', projection)
  assert.throws(
    () => store.applySocialProjection('00000000-0000-4000-8000-85a2939c3fce', projection),
    /account_epoch_mismatch/
  )
  assert.throws(
    () => store.applySocialProjection('00000000-0000-4000-8000-d98016d67fb8', { ...projection, version: 1 }),
    /stale_social_projection/
  )
  assert.throws(
    () =>
      store.applySocialProjection('00000000-0000-4000-8000-d98016d67fb8', { ...projection, state: 'incoming_pending' }),
    /social_projection_version_conflict/
  )
  store.close()
})

test('neutral peer-block invalidation removes roster identity but keeps a compose-denied history thread', () => {
  const store = new AtumMessagingStore({ accountId: 'account-a', databasePath: databasePath() })
  const threadId = '00000000-0000-4000-8000-1d1ea877549e'
  const profileId = '00000000-0000-4000-8000-e03cc076d760'

  store.applySocialProjection('00000000-0000-4000-8000-d98016d67fb8', {
    availability: 'available',
    profile: { profileId, displayName: 'Bob', handle: 'social-bob', verified: false, avatar: null },
    state: 'connected',
    version: 2,
    canMessage: true,
    directThreadId: threadId
  })
  store.canonicalizeMessage({ message: message('server-history', threadId, '2026-08-30T00:00:00.000Z') })
  store.invalidateSocialProfile(profileId)

  assert.deepEqual(store.listSocialRelationships(), [])
  assert.equal(
    store.listMessages(threadId).some(row => row.id === 'server-history'),
    true
  )
  assert.throws(
    () => store.queueSend({ conversationId: threadId, clientMessageId: 'denied', content: 'no', locale: 'en' }),
    /direct_compose_denied/
  )
  store.close()
})

test('leases failed read receipts through the durable retry outbox', () => {
  const store = new AtumMessagingStore({ accountId: 'account-a', databasePath: databasePath() })
  store.upsertConversation(conversation('conversation-a'))
  store.queueReadReceipt('conversation-a', 'server-1', 'operation-1', '2026-08-12T03:00:00.000Z')

  const sending = store.markReadReceiptSending(
    store.listDueReadReceipts('2026-08-12T03:00:00.000Z')[0]!.id,
    '2026-08-12T03:00:01.000Z'
  )

  store.markReadReceiptFailed(sending.id, {
    code: 'temporarily_unavailable',
    retryable: true,
    retryAt: '2026-08-12T03:01:00.000Z',
    now: '2026-08-12T03:00:02.000Z'
  })

  assert.equal(store.listDueReadReceipts('2026-08-12T03:00:59.999Z').length, 0)
  assert.equal(store.listDueReadReceipts('2026-08-12T03:01:00.000Z')[0]?.clientOperationId, 'operation-1')
  store.close()
})

test('treats an unprojected read watermark as a safe race', () => {
  const store = new AtumMessagingStore({ accountId: 'account-a', databasePath: databasePath() })
  store.upsertConversation(conversation('conversation-a'))
  assert.equal(store.markRead('conversation-a', 'not-yet-projected'), false)
  store.close()
})

test('serializes concurrent first-open migrations before reading history', async () => {
  const path = databasePath()
  const directory = join(path, '..')
  const migrationModule = pathToFileURL(join(__dirname, 'migrations.ts')).href

  const script = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    import { applyMessagingMigrations } from ${JSON.stringify(migrationModule)};
    const [path, ownReady, peerReady] = process.argv.slice(1);
    const database = new DatabaseSync(path);
    database.exec('PRAGMA busy_timeout = 5000');
    const exec = database.exec.bind(database);
    database.exec = sql => {
      if (sql === 'BEGIN IMMEDIATE') {
        writeFileSync(ownReady, 'ready');
        const deadline = Date.now() + 5000;
        while (!existsSync(peerReady) && Date.now() < deadline) {}
        if (!existsSync(peerReady)) throw new Error('migration test barrier timed out');
      }
      return exec(sql);
    };
    applyMessagingMigrations(database);
    database.close();
  `

  const run = (name: string, peer: string) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '-e', script, path, name, peer],
        { cwd: directory, stdio: ['ignore', 'ignore', 'pipe'] }
      )

      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => {
        stderr += chunk
      })
      child.once('error', reject)
      child.once('exit', code => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`migration child exited ${code}: ${stderr}`))
        }
      })
    })

  await Promise.all([
    run(join(directory, 'a.ready'), join(directory, 'b.ready')),
    run(join(directory, 'b.ready'), join(directory, 'a.ready'))
  ])

  const database = new DatabaseSync(path)
  assert.equal(
    (database.prepare('SELECT count(*) AS count FROM messaging_schema_migrations').get() as { count: number }).count,
    MESSAGING_MIGRATIONS.length
  )
  database.close()
})

test('partitions conversations, drafts, cursors, and change de-duplication by account', () => {
  const path = databasePath()
  const accountA = new AtumMessagingStore({ accountId: 'account-a', databasePath: path })
  const accountB = new AtumMessagingStore({ accountId: 'account-b', databasePath: path })
  accountA.upsertConversation(conversation('shared'))
  accountA.upsertConversation(conversation('account-a-second'))
  accountB.upsertConversation(conversation('shared'))

  assert.equal(accountA.saveDraft('shared', { text: 'A' }, '2026-08-12T03:00:01.000Z').revision, 1)
  assert.equal(accountA.saveDraft('shared', { text: 'A2' }, '2026-08-12T03:00:02.000Z').revision, 2)
  assert.equal(accountB.saveDraft('shared', { text: 'B' }, '2026-08-12T03:00:01.000Z').revision, 1)
  assert.equal(accountA.getDraft('shared')?.text, 'A2')
  assert.equal(accountB.getDraft('shared')?.text, 'B')
  accountA.saveDraft('account-a-second', { text: 'Independent conversation draft' })
  assert.equal(accountA.getDraft('shared')?.text, 'A2')
  assert.equal(accountA.getDraft('account-a-second')?.text, 'Independent conversation draft')

  assert.equal(accountA.commitSyncCursor(null, 'cursor-a'), true)
  assert.equal(accountA.commitSyncCursor(null, 'stale'), false)
  assert.equal(accountB.getSyncCursor().cursor, null)
  assert.equal(accountA.recordSyncChange('change-1'), true)
  assert.equal(accountA.recordSyncChange('change-1'), false)
  assert.equal(accountB.recordSyncChange('change-1'), true)

  const longOpaqueToken = `opaque.${'x'.repeat(2048)}`
  assert.equal(accountB.commitSyncCursor(null, longOpaqueToken), true)
  assert.equal(accountB.getSyncCursor().cursor, longOpaqueToken)
  assert.equal(accountB.recordSyncChange(longOpaqueToken), true)

  accountA.close()
  accountB.close()
})

test('retains optimistic identity and drafts across outage, crash, and relaunch', () => {
  const path = databasePath()
  let store = new AtumMessagingStore({ accountId: 'account-a', databasePath: path })
  store.upsertConversation(conversation('conversation-a'))
  store.saveDraft('conversation-a', { text: 'Xin chào' }, '2026-08-12T03:00:00.000Z')

  const queued = store.queueSend({
    conversationId: 'conversation-a',
    clientMessageId: 'client-1',
    content: 'Xin chào',
    locale: 'vi',
    now: '2026-08-12T03:00:01.000Z'
  })

  assert.equal(queued.state, 'queued')
  assert.equal(
    store.queueSend({
      conversationId: 'conversation-a',
      clientMessageId: 'client-1',
      content: 'Xin chào',
      locale: 'vi',
      now: '2026-08-12T03:00:02.000Z'
    }).id,
    queued.id
  )
  assert.throws(
    () =>
      store.queueSend({
        conversationId: 'conversation-a',
        clientMessageId: 'client-1',
        content: 'Different bytes',
        locale: 'vi'
      }),
    /idempotency_conflict/
  )

  assert.equal(store.markMutationSending('client-1').attemptCount, 1)
  store.close()
  store = new AtumMessagingStore({ accountId: 'account-a', databasePath: path })
  assert.equal(store.listDueMutations('9999-01-01T00:00:00.000Z')[0]?.state, 'queued')
  assert.equal(store.listMessages('conversation-a')[0]?.delivery, 'queued')

  store.markMutationSending('client-1', '2026-08-12T03:01:00.000Z')

  const failed = store.markMutationFailed('client-1', {
    code: 'temporarily_unavailable',
    retryable: true,
    retryAt: '2026-08-12T03:02:00.000Z',
    now: '2026-08-12T03:01:01.000Z'
  })

  assert.equal(failed.state, 'failed_retryable')
  assert.equal(store.listDueMutations('2026-08-12T03:01:59.999Z').length, 0)
  assert.equal(store.listDueMutations('2026-08-12T03:02:00.000Z').length, 1)
  store.markMutationSending('client-1', '2026-08-12T03:02:00.000Z')
  assert.equal(
    store.markMutationFailed('client-1', {
      code: 'version_conflict',
      retryable: false,
      conflicted: true,
      now: '2026-08-12T03:02:01.000Z'
    }).state,
    'conflicted'
  )
  assert.equal(store.listDueMutations('9999-01-01T00:00:00.000Z').length, 0)
  assert.equal(store.getDraft('conversation-a')?.text, 'Xin chào')
  store.close()
})

test('canonicalizes acknowledgements, collapses duplicate echoes, and preserves newer drafts', () => {
  const store = new AtumMessagingStore({ accountId: 'account-a', databasePath: databasePath() })
  store.upsertConversation(conversation('conversation-a'))
  store.saveDraft('conversation-a', { text: 'First' }, '2026-08-12T03:00:00.000Z')
  store.queueSend({
    conversationId: 'conversation-a',
    clientMessageId: 'client-1',
    content: 'First',
    locale: 'vi',
    now: '2026-08-12T03:00:01.000Z'
  })
  store.saveDraft('conversation-a', { text: 'Newer draft' }, '2026-08-12T03:00:02.000Z')

  const canonical = message('server-1', 'conversation-a', '2026-08-12T03:00:03.000Z', 'First')

  store.canonicalizeMessage({ message: canonical, incrementUnread: false })
  assert.equal(store.listMessages('conversation-a').length, 2, 'echo can arrive before ack')
  const reconciled = store.canonicalizeMessage({ message: canonical, clientMessageId: 'client-1' })
  assert.equal(reconciled.id, 'server-1')
  assert.equal(reconciled.clientMessageId, 'client-1')
  assert.equal(reconciled.optimistic, false)
  assert.equal(store.listMessages('conversation-a').length, 1)
  assert.equal(store.getDraft('conversation-a')?.text, 'Newer draft')

  store.saveDraft('conversation-a', { text: 'Clear me after ack' })
  store.queueSend({
    conversationId: 'conversation-a',
    clientMessageId: 'client-2',
    content: 'Clear me after ack',
    locale: 'vi',
    now: '2026-08-12T03:00:04.000Z'
  })
  store.canonicalizeMessage({
    message: message('server-2', 'conversation-a', '2026-08-12T03:00:05.000Z', 'Clear me after ack'),
    clientMessageId: 'client-2'
  })
  assert.equal(store.getDraft('conversation-a'), null)

  store.saveDraft('conversation-a', { text: 'Typed after the first acknowledgement' })
  store.canonicalizeMessage({
    message: message('server-2', 'conversation-a', '2026-08-12T03:00:05.000Z', 'Clear me after ack'),
    clientMessageId: 'client-2'
  })
  assert.equal(store.getDraft('conversation-a')?.text, 'Typed after the first acknowledgement')

  store.canonicalizeMessage({
    message: canonical,
    clientMessageId: 'client-1',
    incrementUnread: true
  })
  assert.equal(store.listMessages('conversation-a').length, 2)
  assert.equal(store.listConversations()[0]?.unreadCount, 0, 'duplicate echo does not increment unread')

  store.canonicalizeMessage({
    message: { ...canonical, content: 'Server edit', version: 2 }
  })
  store.canonicalizeMessage({ message: canonical })
  assert.equal(
    store.listMessages('conversation-a').find(item => item.id === canonical.id)?.content,
    'Server edit',
    'an out-of-order older server projection cannot clobber a newer version'
  )
  store.close()
})

test('advances read state monotonically and retains local work on projection reset', () => {
  const store = new AtumMessagingStore({ accountId: 'account-a', databasePath: databasePath() })
  store.upsertConversation(conversation('conversation-a'))
  const first = message('server-1', 'conversation-a', '2026-08-12T03:00:01.000Z')
  const second = message('server-2', 'conversation-a', '2026-08-12T03:00:02.000Z')
  store.canonicalizeMessage({ message: first, incrementUnread: true })
  store.canonicalizeMessage({ message: second, incrementUnread: true })
  assert.equal(store.listConversations()[0]?.unreadCount, 2)
  assert.equal(store.markRead('conversation-a', 'server-1'), true)
  assert.equal(store.listConversations()[0]?.unreadCount, 1)
  assert.equal(store.markRead('conversation-a', 'server-1'), false)
  assert.equal(store.markRead('conversation-a', 'server-2'), true)
  assert.equal(store.listConversations()[0]?.unreadCount, 0)
  const third = message('server-3', 'conversation-a', '2026-08-12T03:00:03.000Z')
  const fourth = message('server-4', 'conversation-a', '2026-08-12T03:00:04.000Z')
  store.canonicalizeMessage({ message: third, incrementUnread: true })
  store.canonicalizeMessage({ message: fourth, incrementUnread: true })
  assert.equal(store.listConversations()[0]?.unreadCount, 2)
  assert.equal(store.deleteCanonicalMessage('server-missing', 'conversation-a'), 'missing')
  assert.equal(store.listConversations()[0]?.unreadCount, 2, 'missing delete is an idempotent no-op')
  assert.equal(store.deleteCanonicalMessage('server-3', 'conversation-b'), 'conversation_mismatch')
  assert.equal(
    store.listMessages('conversation-a').some(item => item.id === 'server-3'),
    true
  )
  assert.equal(store.listConversations()[0]?.unreadCount, 2, 'rejected cross-conversation delete changes nothing')
  assert.equal(store.deleteCanonicalMessage('server-3', 'conversation-a'), 'deleted')
  assert.equal(store.listConversations()[0]?.unreadCount, 1, 'delete recomputes unread rows after the read watermark')
  store.canonicalizeMessage({
    message: message('server-old', 'conversation-a', '2026-08-12T02:59:00.000Z'),
    incrementUnread: true
  })
  assert.equal(
    store.listConversations()[0]?.unreadCount,
    1,
    'older backfill does not become unread after a later read marker'
  )

  store.saveDraft('conversation-a', { text: 'Offline draft' })
  store.queueSend({
    conversationId: 'conversation-a',
    clientMessageId: 'client-reset',
    content: 'Offline draft',
    locale: 'vi'
  })
  store.commitSyncCursor(null, 'cursor-before-reset')
  store.resetProjection()
  assert.equal(store.getSyncCursor().cursor, null)
  assert.equal(store.getDraft('conversation-a')?.text, 'Offline draft')
  assert.equal(store.listDueMutations('9999-01-01T00:00:00.000Z').length, 1)
  const remaining = store.listMessages('conversation-a')
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0]?.clientMessageId, 'client-reset')
  assert.equal(remaining[0]?.optimistic, true)
  store.close()
})

// A latency budget for a developer Mac ("on this host"). Shared CI runners can't promise it, so CI skips it.
test.skipIf(Boolean(process.env.CI))('switches indexed 10,000-message conversations at <=100ms p95 on this host', () => {
  const store = new AtumMessagingStore({ accountId: 'benchmark', databasePath: databasePath() })
  store.upsertConversation(conversation('conversation-a'))
  store.upsertConversation(conversation('conversation-b'))

  for (let index = 0; index < 10_000; index += 1) {
    const conversationId = index % 2 === 0 ? 'conversation-a' : 'conversation-b'
    const createdAt = new Date(Date.UTC(2026, 7, 12, 3, 0, 0, index)).toISOString()
    store.canonicalizeMessage({
      message: message(`server-${String(index).padStart(5, '0')}`, conversationId, createdAt)
    })
  }

  const samples: number[] = []

  for (let iteration = 0; iteration < 200; iteration += 1) {
    const conversationId = iteration % 2 === 0 ? 'conversation-a' : 'conversation-b'
    const startedAt = performance.now()
    const result = store.listMessages(conversationId, 100)
    samples.push(performance.now() - startedAt)
    assert.equal(result.length, 100)
  }

  samples.sort((left, right) => left - right)
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!
  console.info(`ATUM_MESSAGING_SWITCH_P95_MS=${p95.toFixed(3)} samples=${samples.length} messages=10000`)
  assert.ok(p95 <= 100, `expected p95 <= 100ms, measured ${p95.toFixed(3)}ms`)
  store.close()
}, 120_000)

test('round-trips message metadata and attachments, tolerating rows without either', () => {
  const store = new AtumMessagingStore({ accountId: 'account-a', databasePath: databasePath() })
  store.upsertConversation(conversation('conversation-a'))

  const attachment = { id: 'attachment-1', name: 'la-so.html', url: 'https://example.test/la-so.html' }

  store.canonicalizeMessage({
    message: {
      ...message('server-1', 'conversation-a', '2026-08-17T03:00:00.000Z'),
      attachments: [attachment],
      metadata: { andy_memory: { outcome: 'supplied', used: true, v: 1 } }
    }
  })
  store.canonicalizeMessage({ message: message('server-2', 'conversation-a', '2026-08-17T03:00:01.000Z') })

  const rows = store.listMessages('conversation-a')
  const withMetadata = rows.find(row => row.id === 'server-1')!
  const without = rows.find(row => row.id === 'server-2')!

  assert.deepEqual(withMetadata.attachments, [attachment])
  assert.deepEqual(withMetadata.metadata, { andy_memory: { outcome: 'supplied', used: true, v: 1 } })
  assert.equal(without.metadata, null)
  store.close()
})

test('a queued optimistic send has no metadata until the server canonicalizes it', () => {
  const store = new AtumMessagingStore({ accountId: 'account-a', databasePath: databasePath() })
  store.upsertConversation(conversation('conversation-a'))
  store.queueSend({
    conversationId: 'conversation-a',
    clientMessageId: 'client-1',
    content: 'Xem giúp mình lá số',
    locale: 'vi'
  })

  assert.equal(store.listMessages('conversation-a')[0]!.metadata, null)
  store.close()
})

test('a mention rides the durable outbox request and participates in idempotency', () => {
  const store = new AtumMessagingStore({ accountId: 'account-a', databasePath: databasePath() })
  store.upsertConversation(conversation('conversation-a'))

  const queued = store.queueSend({
    conversationId: 'conversation-a',
    clientMessageId: 'client-mention',
    content: '@Atum giúp mình',
    locale: 'vi',
    mention: { agent: 'binh-minh', revision: 0, startOffset: 0, endOffset: 5 }
  })

  assert.deepEqual(queued.request.mention, {
    agent: 'binh-minh',
    revision: 0,
    start_offset: 0,
    end_offset: 5
  })
  store.close()
})

test('addressed targets keep every ordered span in the durable request fingerprint', () => {
  const store = new AtumMessagingStore({ accountId: 'account-a', databasePath: databasePath() })
  store.upsertConversation(conversation('conversation-a'))

  const queued = store.queueSend({
    conversationId: 'conversation-a',
    clientMessageId: 'client-addressed',
    content: '@Mai và @Minh',
    locale: 'vi',
    mentions: {
      contract: 'atum.addressed-mentions/1',
      targets: [
        {
          target: { type: 'assistant', id: '00000000-0000-4000-8000-bd7662a5eeb4' },
          revision: 1,
          startOffset: 0,
          endOffset: 4
        },
        {
          target: { type: 'assistant', id: '00000000-0000-4000-8000-b454f82c5857' },
          revision: 2,
          startOffset: 8,
          endOffset: 13
        }
      ]
    }
  })

  assert.deepEqual(queued.request.mentions, {
    contract: 'atum.addressed-mentions/1',
    targets: [
      {
        target: { type: 'assistant', id: '00000000-0000-4000-8000-bd7662a5eeb4' },
        revision: 1,
        start_offset: 0,
        end_offset: 4
      },
      {
        target: { type: 'assistant', id: '00000000-0000-4000-8000-b454f82c5857' },
        revision: 2,
        start_offset: 8,
        end_offset: 13
      }
    ]
  })
  store.close()
})

test('specialist targets and explicit quote references are unavailable outside a group room', () => {
  const store = new AtumMessagingStore({ accountId: 'account-a', databasePath: databasePath() })
  store.upsertConversation(conversation('conversation-a'))

  assert.throws(
    () =>
      store.queueSend({
        conversationId: 'conversation-a',
        clientMessageId: 'direct-specialist',
        content: '@Moon help',
        locale: 'en',
        mentions: {
          contract: 'atum.addressed-mentions/1',
          targets: [
            {
              target: { type: 'specialist', id: 'moon' },
              revision: 1,
              startOffset: 0,
              endOffset: 5
            }
          ]
        }
    }),
    /group_addressing_unavailable/
  )
  assert.throws(
    () =>
      store.queueSend({
        conversationId: 'conversation-a',
        clientMessageId: 'direct-quote',
        content: 'No room',
        locale: 'en',
      quotedMessage: { messageId: '00000000-0000-4000-8000-bd7662a5eeb4', sourceVersion: 1 }
    }),
    /group_addressing_unavailable/
  )
  store.close()
})

test('canonical upsert replaces mention dispatch metadata on an existing source message', () => {
  const store = new AtumMessagingStore({ accountId: 'account-a', databasePath: databasePath() })
  store.upsertConversation(conversation('conversation-a'))

  const source = {
    ...message('server-mention', 'conversation-a', '2026-08-29T00:00:00.000Z'),
    metadata: {
    mention_dispatch: { state: 'pending', agent: 'binh-minh', revision: 0 }
    }
  }

  store.canonicalizeMessage({ message: source })
  store.canonicalizeMessage({
    message: {
      ...source,
      metadata: {
    mention_dispatch: { state: 'dead_lettered', agent: 'binh-minh', revision: 0, error_code: 'allowance_exhausted' }
      }
    }
  })
  assert.deepEqual(store.listMessages('conversation-a')[0]?.metadata, {
    mention_dispatch: { state: 'dead_lettered', agent: 'binh-minh', revision: 0, error_code: 'allowance_exhausted' }
  })
  store.close()
})

test('canonical message storage preserves the server assistant photo snapshot', () => {
  const store = new AtumMessagingStore({ accountId: 'account-a', databasePath: databasePath() })
  store.upsertConversation(conversation('conversation-a'))

  const source = {
    ...message('server-assistant-photo', 'conversation-a', '2026-09-06T00:00:00.000Z'),
    metadata: {
      assistant_identity: {
        id: 'assistant-1',
        display_name: 'Mai',
        avatar: '🌸',
        avatar_url: 'https://cdn.atum.test/assistants/mai.png',
        revision: 1
      }
    }
  }

  store.canonicalizeMessage({ message: source })
  assert.deepEqual(store.listMessages('conversation-a')[0]?.metadata, source.metadata)
  store.close()
})
