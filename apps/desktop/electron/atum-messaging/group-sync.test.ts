import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import type {
  GroupCapabilities,
  GroupDetail,
  GroupOperationInput,
  GroupRoom
} from '../../shared/atum-group-conversations'

import type { DirectMessagingTransport, GroupMessagingTransport } from './direct-transport'
import { AtumMessagingStore } from './store'
import { AtumMessagingSyncEngine } from './sync-engine'
import { MessagingTransportError } from './transport-error'
import type { CanonicalMessage, MessagingConversation } from './types'
import type { DesktopSessionBody, SyncPage } from './wire'

const ACCOUNT_A = '00000000-0000-4000-8000-303617b97302'
const ACCOUNT_B = '00000000-0000-4000-8000-00f765af1c54'
const ROOM_ID = '00000000-0000-4000-8000-576f18824476'
const MEMBER_ID = '00000000-0000-4000-8000-4b2f94c54b02'
const OPERATION_ID = '00000000-0000-4000-8000-471568220011'
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'atum-group-sync-'))
  temporaryDirectories.push(directory)

  return directory
}

function groupRoom(accountId: string, membershipEpoch = 1): GroupRoom {
  return {
    conversationId: ROOM_ID,
    title: 'Weekend plans',
    revision: membershipEpoch,
    retiredAt: null,
    membershipEpoch,
    members: [
      { userId: accountId, displayName: 'Account', handle: 'account', role: 'owner', membershipEpoch },
      { userId: MEMBER_ID, displayName: 'Member', handle: 'member', role: 'member', membershipEpoch }
    ],
    updatedAt: `2026-09-06T00:00:0${membershipEpoch}.000Z`
  }
}

function groupConversation(accountId: string, membershipEpoch = 1): Omit<MessagingConversation, 'unreadCount'> {
  const group = groupRoom(accountId, membershipEpoch)

  return {
    id: ROOM_ID,
    title: group.title,
    kind: 'group',
    group,
    participantIds: group.members.map(member => member.userId),
    updatedAt: group.updatedAt,
    lastMessageAt: group.updatedAt,
    payload: { kind: 'group' }
  }
}

function message(id: string, content = 'Server history'): CanonicalMessage {
  return {
    id,
    conversationId: ROOM_ID,
    sender: { type: 'user', id: MEMBER_ID },
    content,
    kind: 'text',
    attachments: [],
    metadata: null,
    replyToMessageId: null,
    forwardedFrom: null,
    reactions: [],
    version: 1,
    createdAt: '2026-09-06T00:00:00.000Z',
    editedAt: null,
    recalledAt: null,
    delivery: 'sent'
  }
}

function page(changes: SyncPage['changes'], nextCursor: string): SyncPage {
  return { changes, nextCursor, hasMore: false, serverTime: '2026-09-06T00:00:00.000Z' }
}

function groupOperation(id = OPERATION_ID): GroupOperationInput {
  return { action: 'add_member', conversationId: ROOM_ID, targetUserId: MEMBER_ID, clientOperationId: id }
}

function detail(accountId: string, membershipEpoch = 1): GroupDetail {
  return { room: groupRoom(accountId, membershipEpoch), events: [], nextCursor: null, hasMore: false }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void

  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })

  return { promise, resolve, reject }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 1))
  }

  throw new Error('timed out waiting for deterministic transport')
}

class FakeTransport implements DirectMessagingTransport, GroupMessagingTransport {
  activeAccount = ACCOUNT_A
  capabilities: GroupCapabilities | undefined = { available: true, creationEnabled: true, humanMemberLimit: 32 }
  readonly rosters = new Map<string, Omit<MessagingConversation, 'unreadCount'>[]>()
  readonly syncPages: SyncPage[] = []
  readonly sent: string[] = []
  readonly groupCalls: GroupOperationInput[] = []
  readonly detailCalls: string[] = []
  messagesHandler: (
    conversationId: string,
    cursor?: string | null
  ) => Promise<{ messages: CanonicalMessage[]; nextCursor: string | null; hasMore: boolean }> = async () => ({
    messages: [],
    nextCursor: null,
    hasMore: false
  })
  groupDetailHandler: (conversationId: string, cursor?: string | null) => Promise<GroupDetail> = async () =>
    detail(this.activeAccount)
  groupOperateHandler: (input: GroupOperationInput) => Promise<{ conversationId: string; replayed: boolean }> =
    async input => ({ conversationId: input.action === 'create' ? ROOM_ID : input.conversationId, replayed: false })

  abortAll() {}

  async session(): Promise<DesktopSessionBody> {
    return {
      ...(this.capabilities === undefined ? {} : { groupCapabilities: this.capabilities }),
      user: { id: this.activeAccount, displayName: null, handle: null },
      syncCursor: null,
      serverTime: '2026-09-06T00:00:00.000Z',
      realtime: {
        transport: 'supabase_private_broadcast',
        topic: `user:${this.activeAccount}:messaging:v1`,
        event: 'sync_available'
      }
    }
  }

  async conversations() {
    return { conversations: this.rosters.get(this.activeAccount) ?? [] }
  }
  messages(conversationId: string, cursor?: string | null) {
    return this.messagesHandler(conversationId, cursor)
  }
  async send(mutation: Parameters<DirectMessagingTransport['send']>[0]) {
    this.sent.push(mutation.clientMessageId)

    return { message: message(`server-${mutation.clientMessageId}`, mutation.request.content) }
  }
  async markRead() {}
  async sync(cursor: string | null): Promise<SyncPage> {
    return this.syncPages.shift() ?? page([], cursor ?? 'initial-cursor')
  }
  async socialLookup(_query: string): Promise<never> {
    throw new Error('not used')
  }
  async socialMutate(_input: Parameters<DirectMessagingTransport['socialMutate']>[0]): Promise<never> {
    throw new Error('not used')
  }
  async socialSync(_accountEpoch: string, _cursor: string, _limit?: number): Promise<never> {
    throw new Error('not used')
  }
  groupDetail(conversationId: string, cursor?: string | null) {
    this.detailCalls.push(conversationId)

    return this.groupDetailHandler(conversationId, cursor)
  }
  groupOperate(input: GroupOperationInput) {
    this.groupCalls.push(input)

    return this.groupOperateHandler(input)
  }
}

function engineFor(
  http: FakeTransport,
  activeAccount: () => string,
  root = temporaryPath(),
  now = () => new Date('2026-09-06T00:00:00.000Z')
) {
  const stores = new Map<string, AtumMessagingStore>()

  const engine = new AtumMessagingSyncEngine({
    userDataPath: root,
    http,
    accountId: activeAccount,
    now,
    automaticPolling: false,
    databasePathForAccount: accountId => join(root, `${accountId}.sqlite3`),
    openStore: (accountId, databasePath) => {
      const store = new AtumMessagingStore({ accountId, databasePath })
      stores.set(accountId, store)

      return store
    }
  })

  return { engine, stores }
}

test('negotiates the current group capability from session authority', async () => {
  const http = new FakeTransport()
  http.rosters.set(ACCOUNT_A, [groupConversation(ACCOUNT_A)])
  const { engine } = engineFor(http, () => http.activeAccount)

  await engine.start()

  assert.deepEqual(await engine.groupCapabilities(), { available: true, creationEnabled: true, humanMemberLimit: 32 })
  assert.equal((await engine.roster())[0]?.group?.membershipEpoch, 1)
  engine.stop()
})

test('a conversation removal page purges room work before either group or message outbox drains', async () => {
  const http = new FakeTransport()
  http.rosters.set(ACCOUNT_A, [groupConversation(ACCOUNT_A)])
  http.messagesHandler = async () => ({
    messages: [message('00000000-0000-4000-8000-b74112cc20c8')],
    nextCursor: null,
    hasMore: false
  })
  const { engine, stores } = engineFor(http, () => http.activeAccount)
  await engine.start()
  const store = stores.get(ACCOUNT_A)!
  store.queueSend({
    conversationId: ROOM_ID,
    clientMessageId: 'queued-send',
    content: 'Must not leave the machine',
    locale: 'en'
  })
  store.groups.queueGroupOperation(groupOperation(), '2026-09-06T00:00:00.000Z')
  http.syncPages.push(
    page(
      [
        {
          changeId: 'remove-room',
          entity: 'conversation',
          operation: 'delete',
          entityId: ROOM_ID,
          conversationId: ROOM_ID,
          value: null,
          occurredAt: '2026-09-06T00:01:00.000Z'
        }
      ],
      'remove-cursor'
    )
  )

  await engine.sync()

  assert.deepEqual(http.sent, [])
  assert.deepEqual(http.groupCalls, [])
  assert.equal(
    (await engine.roster()).some(conversation => conversation.id === ROOM_ID),
    false
  )
  assert.equal(store.listDueMutations('2099-01-01T00:00:00.000Z').length, 0)
  assert.deepEqual(store.groups.groupOperations(), [])
  engine.stop()
})

test('an older history response cannot restore a removed room or overwrite a higher-epoch rejoin', async () => {
  const http = new FakeTransport()
  http.rosters.set(ACCOUNT_A, [groupConversation(ACCOUNT_A)])
  let deferOlder = false
  let olderRequested = false
  let initialHistory = true
  const older = deferred<{ messages: CanonicalMessage[]; nextCursor: string | null; hasMore: boolean }>()

  http.messagesHandler = async (_conversationId, cursor) => {
    if (cursor === undefined && initialHistory) {
      initialHistory = false

      return { messages: [message('00000000-0000-4000-8000-ea6d413dd339')], nextCursor: 'older-cursor', hasMore: true }
    }

    if (deferOlder && cursor === 'older-cursor') {
      olderRequested = true

      return older.promise
    }

    return {
      messages: [message('00000000-0000-4000-8000-0990f7358350', 'Rejoined history')],
      nextCursor: null,
      hasMore: false
    }
  }

  const { engine } = engineFor(http, () => http.activeAccount)
  await engine.start()
  deferOlder = true
  const pendingOlder = engine.loadOlderMessages(ROOM_ID)
  await waitFor(() => olderRequested)

  http.rosters.set(ACCOUNT_A, [])
  http.syncPages.push(
    page(
      [
        {
          changeId: 'remove-room',
          entity: 'conversation',
          operation: 'delete',
          entityId: ROOM_ID,
          conversationId: ROOM_ID,
          value: null,
          occurredAt: '2026-09-06T00:01:00.000Z'
        }
      ],
      'remove-cursor'
    )
  )
  await engine.sync()

  http.rosters.set(ACCOUNT_A, [groupConversation(ACCOUNT_A, 2)])
  http.syncPages.push(
    page(
      [
        {
          changeId: 'rejoin-room',
          entity: 'participant',
          operation: 'upsert',
          entityId: MEMBER_ID,
          conversationId: ROOM_ID,
          value: { membership_epoch: 2 },
          occurredAt: '2026-09-06T00:02:00.000Z'
        }
      ],
      'rejoin-cursor'
    )
  )
  await engine.sync()
  older.resolve({
    messages: [message('00000000-0000-4000-8000-2063e70f1b4e', 'Old response')],
    nextCursor: null,
    hasMore: false
  })

  await assert.rejects(pendingOlder, /stale_group_membership/)
  assert.equal((await engine.roster())[0]?.group?.membershipEpoch, 2)
  assert.deepEqual(
    (await engine.messages(ROOM_ID)).map(row => row.id),
    ['00000000-0000-4000-8000-0990f7358350']
  )
  engine.stop()
})

test('a lost group-operation response returns retry truth and replays the same operation id with one effect', async () => {
  const http = new FakeTransport()
  http.rosters.set(ACCOUNT_A, [groupConversation(ACCOUNT_A)])
  let now = new Date('2026-09-06T00:00:00.000Z')
  const effects = new Set<string>()
  let loseResponse = true

  http.groupOperateHandler = async input => {
    effects.add(input.clientOperationId)

    if (loseResponse) {
      loseResponse = false
      throw new MessagingTransportError('temporarily_unavailable', 0, true, null, null, null)
    }

    return { conversationId: ROOM_ID, replayed: true }
  }

  const { engine } = engineFor(
    http,
    () => http.activeAccount,
    temporaryPath(),
    () => now
  )

  await engine.start()

  const first = await engine.groupOperate(groupOperation())
  assert.deepEqual(first, {
    operationId: OPERATION_ID,
    state: 'failed_retryable',
    conversationId: ROOM_ID,
    errorCode: 'temporarily_unavailable'
  })
  assert.equal(effects.size, 1)

  now = new Date('2026-09-06T00:00:02.000Z')
  const replay = await engine.groupOperate(groupOperation())
  assert.deepEqual(replay, { operationId: OPERATION_ID, state: 'sent', conversationId: ROOM_ID, errorCode: null })
  assert.deepEqual(
    http.groupCalls.map(input => input.clientOperationId),
    [OPERATION_ID, OPERATION_ID]
  )
  assert.equal(effects.size, 1)
  engine.stop()
})

test('absent capability and an account switch keep group methods and stale responses out of the active account', async () => {
  const http = new FakeTransport()
  http.capabilities = undefined
  const { engine } = engineFor(http, () => http.activeAccount)
  await engine.start()
  assert.deepEqual(await engine.groupCapabilities(), { available: false, creationEnabled: false, humanMemberLimit: 32 })
  await assert.rejects(engine.groupOperate(groupOperation()), /group_feature_unavailable/)
  await assert.rejects(engine.groupDetail(ROOM_ID), /group_membership_ended/)
  assert.deepEqual(http.groupCalls, [])
  assert.deepEqual(http.detailCalls, [])
  engine.stop()

  http.capabilities = { available: true, creationEnabled: true, humanMemberLimit: 32 }
  http.activeAccount = ACCOUNT_A
  http.rosters.set(ACCOUNT_A, [groupConversation(ACCOUNT_A)])
  const pendingDetail = deferred<GroupDetail>()
  const pendingOperation = deferred<{ conversationId: string; replayed: boolean }>()
  http.groupDetailHandler = async () => pendingDetail.promise
  http.groupOperateHandler = async () => pendingOperation.promise
  const switched = engineFor(http, () => http.activeAccount)
  await switched.engine.start()
  const detailRequest = switched.engine.groupDetail(ROOM_ID)
  const operationRequest = switched.engine.groupOperate(groupOperation('00000000-0000-4000-8000-5975292cfa94'))
  await waitFor(() => http.detailCalls.length === 1 && http.groupCalls.length === 1)

  http.activeAccount = ACCOUNT_B
  http.rosters.set(ACCOUNT_B, [])
  await switched.engine.replaceAccount(ACCOUNT_B)
  pendingDetail.resolve(detail(ACCOUNT_A))
  pendingOperation.resolve({ conversationId: ROOM_ID, replayed: false })

  await assert.rejects(detailRequest, /stale_messaging_lifecycle/)
  await assert.rejects(operationRequest, /stale_messaging_lifecycle/)
  assert.deepEqual(await switched.engine.roster(), [])
  assert.deepEqual(await switched.engine.groupOperations(), [])
  switched.engine.stop()
})

test('an authoritative roster absence purges a group even before its removal ledger row arrives', async () => {
  const http = new FakeTransport()
  http.rosters.set(ACCOUNT_A, [groupConversation(ACCOUNT_A)])
  const { engine, stores } = engineFor(http, () => http.activeAccount)
  await engine.start()
  const store = stores.get(ACCOUNT_A)!
  store.queueSend({ conversationId: ROOM_ID, clientMessageId: 'absent-send', content: 'Private', locale: 'en' })
  http.rosters.set(ACCOUNT_A, [])
  await engine.sync()
  assert.deepEqual(http.sent, [])
  assert.equal(store.groups.groupRoom(ROOM_ID), null)
  assert.equal(store.listDueMutations('2099-01-01T00:00:00.000Z').length, 0)
  engine.stop()
})

test('a retirement receipt refreshes room authority before an already queued send can drain', async () => {
  const http = new FakeTransport()
  http.rosters.set(ACCOUNT_A, [groupConversation(ACCOUNT_A)])
  const { engine, stores } = engineFor(http, () => http.activeAccount)
  await engine.start()
  const store = stores.get(ACCOUNT_A)!
  store.queueSend({ conversationId: ROOM_ID, clientMessageId: 'retired-send', content: 'Private', locale: 'en', now: '2026-09-06T00:02:00.000Z' })
  store.groups.queueGroupOperation(
    { action: 'retire', conversationId: ROOM_ID, clientOperationId: OPERATION_ID },
    '2026-09-06T00:00:00.000Z'
  )

  http.groupOperateHandler = async () => {
    const conversation = groupConversation(ACCOUNT_A)
    http.rosters.set(ACCOUNT_A, [
      { ...conversation, group: { ...conversation.group!, revision: 2, retiredAt: '2026-09-06T00:01:00.000Z' } }
    ])

    return { conversationId: ROOM_ID, replayed: false }
  }

  await engine.sync()
  assert.equal(http.groupCalls.length, 1)
  assert.deepEqual(http.sent, [])
  assert.equal(store.groups.groupRoom(ROOM_ID)?.retiredAt, '2026-09-06T00:01:00.000Z')
  assert.equal(store.listDueMutations('2099-01-01T00:00:00.000Z').length, 0)
  engine.stop()
})

test('a denied older-history request immediately purges the known group cache', async () => {
  const http = new FakeTransport()
  http.rosters.set(ACCOUNT_A, [groupConversation(ACCOUNT_A)])
  http.messagesHandler = async () => ({
    messages: [message('00000000-0000-4000-8000-f04d65a731c3')],
    nextCursor: 'older',
    hasMore: true
  })
  const { engine, stores } = engineFor(http, () => http.activeAccount)
  await engine.start()

  http.messagesHandler = async () => {
    throw new MessagingTransportError('forbidden', 403, false, null, null, null)
  }

  await assert.rejects(engine.loadOlderMessages(ROOM_ID))
  assert.equal(stores.get(ACCOUNT_A)!.groups.groupRoom(ROOM_ID), null)
  assert.deepEqual(await engine.messages(ROOM_ID), [])
  engine.stop()
})
