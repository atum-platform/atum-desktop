import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import type { GroupDetail, GroupOperationInput, GroupRoom } from '../../shared/atum-group-conversations'

import { AtumMessagingStore } from './store'
import type { CanonicalMessage, MessagingConversation } from './types'

const temporaryDirectories: string[] = []
const ROOM_ID = '00000000-0000-4000-8000-576f18824476'
const MEMBER_ID = '00000000-0000-4000-8000-4b2f94c54b02'
const MESSAGE_ID = '00000000-0000-4000-8000-471568220011'
const OPERATION_ID = '00000000-0000-4000-8000-6789912c6209'

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'atum-group-store-'))
  temporaryDirectories.push(directory)

  return join(directory, 'messaging.sqlite3')
}

function room(accountId: string, membershipEpoch = 1, retiredAt: string | null = null): GroupRoom {
  return {
    conversationId: ROOM_ID,
    title: 'Weekend plans',
    revision: membershipEpoch,
    retiredAt,
    membershipEpoch,
    members: [
      { userId: accountId, displayName: 'Account owner', handle: 'account-owner', role: 'owner', membershipEpoch },
      { userId: MEMBER_ID, displayName: 'Member', handle: 'member', role: 'member', membershipEpoch }
    ],
    updatedAt: `2026-09-06T00:00:0${membershipEpoch}.000Z`
  }
}

function groupConversation(
  accountId: string,
  membershipEpoch = 1,
  retiredAt: string | null = null
): Omit<MessagingConversation, 'unreadCount'> {
  const group = room(accountId, membershipEpoch, retiredAt)

  return {
    id: group.conversationId,
    title: group.title,
    kind: 'group',
    group,
    participantIds: group.members.map(member => member.userId),
    updatedAt: group.updatedAt,
    lastMessageAt: null,
    payload: { kind: 'group' }
  }
}

function canonicalMessage(id = MESSAGE_ID): CanonicalMessage {
  return {
    id,
    conversationId: ROOM_ID,
    sender: { type: 'user', id: MEMBER_ID },
    content: 'Server history',
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

function addMemberOperation(operationId = OPERATION_ID): Extract<GroupOperationInput, { targetUserId: string }> {
  return {
    action: 'add_member',
    conversationId: ROOM_ID,
    targetUserId: MEMBER_ID,
    clientOperationId: operationId
  }
}

function groupDetail(accountId: string, membershipEpoch = 1): GroupDetail {
  return {
    room: room(accountId, membershipEpoch),
    events: [
      {
        id: '00000000-0000-4000-8000-cb3c7031a0b0',
        conversationId: ROOM_ID,
        actorUserId: accountId,
        subjectUserId: MEMBER_ID,
        kind: 'member_added',
        createdAt: '2026-09-06T00:00:00.000Z',
        identitySnapshot: { displayName: 'Member', handle: 'member' }
      }
    ],
    nextCursor: null,
    hasMore: false
  }
}

test('newer room authority wins over optimistic activity without accepting an older revision', () => {
  const store = new AtumMessagingStore({ accountId: 'account-a', databasePath: databasePath() })
  const original = groupConversation('account-a')
  store.upsertConversation(original)
  store.queueSend({
    conversationId: ROOM_ID,
    clientMessageId: 'pending-before-retirement',
    content: 'Pending',
    locale: 'en',
    now: '2026-09-06T00:02:00.000Z'
  })

  const retiredAt = '2026-09-06T00:01:00.000Z'
  store.upsertConversation({ ...original, group: { ...original.group!, revision: 2, retiredAt } })

  assert.equal(store.groups.groupRoom(ROOM_ID)?.retiredAt, retiredAt)
  store.upsertConversation({ ...original, updatedAt: '2026-09-06T00:03:00.000Z' })
  assert.equal(store.groups.groupRoom(ROOM_ID)?.revision, 2)
  assert.equal(store.groups.groupRoom(ROOM_ID)?.retiredAt, retiredAt)
  store.close()
})

test('requeues a sending group operation after restart without duplicating its operation identity', () => {
  const path = databasePath()
  let store = new AtumMessagingStore({ accountId: 'account-a', databasePath: path })
  store.upsertConversation(groupConversation('account-a'))
  const queued = store.groups.queueGroupOperation(addMemberOperation(), '2026-09-06T00:00:00.000Z')
  store.groups.startGroupOperation(queued.operationId, '2026-09-06T00:00:01.000Z')
  assert.equal(store.groups.groupOperations()[0]?.state, 'sending')
  assert.equal(store.groups.groupOperations()[0]?.attemptCount, 1)
  store.close()

  store = new AtumMessagingStore({ accountId: 'account-a', databasePath: path })
  const restarted = store.groups.groupOperations()
  assert.deepEqual(
    restarted.map(operation => operation.operationId),
    [OPERATION_ID]
  )
  assert.equal(restarted[0]?.state, 'queued')
  assert.equal(restarted[0]?.attemptCount, 1)
  assert.equal(store.groups.dueGroupOperations('2026-09-06T00:00:02.000Z').length, 1)
  assert.equal(
    store.groups.queueGroupOperation(addMemberOperation(), '2026-09-06T00:00:03.000Z').operationId,
    OPERATION_ID
  )
  assert.equal(store.groups.groupOperations().length, 1)
  assert.throws(
    () =>
      store.groups.queueGroupOperation(
        { ...addMemberOperation(), targetUserId: '00000000-0000-4000-8000-7f708f1061f5' },
        '2026-09-06T00:00:04.000Z'
      ),
    /idempotency_conflict/
  )
  store.close()
})

test('keeps a shared-group create byte-stable and rejects an unknown durable context', () => {
  const store = new AtumMessagingStore({ accountId: 'account-a', databasePath: databasePath() })

  const create: Extract<GroupOperationInput, { action: 'create' }> = {
    action: 'create',
    contextMode: 'shared_group',
    title: 'Planning',
    memberUserIds: [MEMBER_ID],
    specialistIds: ['moon'],
    assistantIds: ['00000000-0000-4000-8000-7f708f1061f5'],
    clientOperationId: OPERATION_ID
  }

  const first = store.groups.queueGroupOperation(create, '2026-09-06T00:00:00.000Z')
  const replay = store.groups.queueGroupOperation(create, '2026-09-06T00:00:01.000Z')

  assert.deepEqual(first.input, create)
  assert.deepEqual(replay.input, create)
  assert.throws(
    () =>
      store.groups.queueGroupOperation(
        { ...create, contextMode: 'unknown_context' } as unknown as GroupOperationInput,
        '2026-09-06T00:00:02.000Z'
      ),
    /group_context_mode/
  )
  store.close()
})

test('an addressed room send keeps only its quote reference across restart and is purged on removal', () => {
  const path = databasePath()
  let store = new AtumMessagingStore({ accountId: 'account-a', databasePath: path })
  store.upsertConversation(groupConversation('account-a'))
  store.queueSend({
    conversationId: ROOM_ID,
    clientMessageId: 'addressed-room-send',
    content: '@Moon please help',
    locale: 'en',
    mentions: {
      contract: 'atum.addressed-mentions/1',
      targets: [{ target: { type: 'specialist', id: 'moon' }, revision: 1, startOffset: 0, endOffset: 5 }]
    },
    quotedMessage: { messageId: MESSAGE_ID, sourceVersion: 1 }
  })
  store.close()

  store = new AtumMessagingStore({ accountId: 'account-a', databasePath: path })
  const queued = store.listDueMutations('2099-01-01T00:00:00.000Z')
  assert.deepEqual(queued[0]?.request.quoted_message, { message_id: MESSAGE_ID, source_version: 1 })
  assert.equal(JSON.stringify(queued[0]?.request).includes('Explicitly shared'), false)

  store.groups.revokeGroup(ROOM_ID)
  assert.deepEqual(store.listDueMutations('2099-01-01T00:00:00.000Z'), [])
  store.upsertConversation(groupConversation('account-a', 2))
  assert.deepEqual(store.listDueMutations('2099-01-01T00:00:00.000Z'), [])
  store.close()
})

test('partitions identical group operation ids by account', () => {
  const path = databasePath()
  const accountA = new AtumMessagingStore({ accountId: 'account-a', databasePath: path })
  const accountB = new AtumMessagingStore({ accountId: 'account-b', databasePath: path })
  accountA.upsertConversation(groupConversation('account-a'))
  accountB.upsertConversation(groupConversation('account-b'))

  accountA.groups.queueGroupOperation(addMemberOperation(), '2026-09-06T00:00:00.000Z')
  accountB.groups.queueGroupOperation(
    { ...addMemberOperation(), targetUserId: '00000000-0000-4000-8000-7f708f1061f5' },
    '2026-09-06T00:00:00.000Z'
  )

  assert.equal(accountA.groups.groupOperations().length, 1)
  assert.equal(accountB.groups.groupOperations().length, 1)
  assert.equal(accountA.groups.groupOperations()[0]?.input.action, 'add_member')
  assert.equal(accountB.groups.groupOperations()[0]?.input.action, 'add_member')
  accountA.close()
  accountB.close()
})

test('revocation atomically purges group durability, rejects an old epoch, and permits a higher-epoch rejoin without old work', () => {
  const store = new AtumMessagingStore({ accountId: 'account-a', databasePath: databasePath() })
  store.upsertConversation(groupConversation('account-a'))
  store.canonicalizeMessage({ message: canonicalMessage() })
  store.saveDraft(ROOM_ID, { text: 'Draft to purge' }, '2026-09-06T00:00:00.000Z')
  store.queueSend({
    conversationId: ROOM_ID,
    clientMessageId: 'group-send',
    content: 'Optimistic send',
    locale: 'en',
    now: '2026-09-06T00:00:01.000Z'
  })
  store.queueReadReceipt(ROOM_ID, MESSAGE_ID, 'read-operation', '2026-09-06T00:00:02.000Z')
  store.groups.queueGroupOperation(addMemberOperation(), '2026-09-06T00:00:03.000Z')
  store.groups.saveGroupDetail(groupDetail('account-a'))

  store.groups.revokeGroup(ROOM_ID)

  assert.equal(
    store.listConversations().some(conversation => conversation.id === ROOM_ID),
    false
  )
  assert.deepEqual(store.listMessages(ROOM_ID), [])
  assert.equal(store.getDraft(ROOM_ID), null)
  assert.equal(store.listDueMutations('2099-01-01T00:00:00.000Z').length, 0)
  assert.equal(store.listDueReadReceipts('2099-01-01T00:00:00.000Z').length, 0)
  assert.deepEqual(store.groups.groupOperations(), [])
  assert.equal(store.groups.getGroupDetail(ROOM_ID), null)
  assert.equal(store.groups.groupRevokedEpoch(ROOM_ID), 1)

  store.upsertConversation(groupConversation('account-a', 1))
  assert.equal(
    store.listConversations().some(conversation => conversation.id === ROOM_ID),
    false
  )
  assert.throws(
    () =>
      store.queueSend({ conversationId: ROOM_ID, clientMessageId: 'old-epoch-send', content: 'Denied', locale: 'en' }),
    /group_membership_ended/
  )

  store.upsertConversation(groupConversation('account-a', 2))
  store.canonicalizeMessage({ message: canonicalMessage('00000000-0000-4000-8000-833f75989eb2') })
  assert.equal(store.groups.groupRoom(ROOM_ID)?.membershipEpoch, 2)
  assert.deepEqual(
    store.listMessages(ROOM_ID).map(message => message.id),
    ['00000000-0000-4000-8000-833f75989eb2']
  )
  assert.deepEqual(store.groups.groupOperations(), [])
  assert.equal(store.listDueMutations('2099-01-01T00:00:00.000Z').length, 0)
  store.close()
})

test('retired group rooms reject sends and management but preserve leave and reporting', () => {
  const store = new AtumMessagingStore({ accountId: 'account-a', databasePath: databasePath() })
  store.upsertConversation(groupConversation('account-a', 1, '2026-09-06T00:00:00.000Z'))

  assert.throws(
    () =>
      store.queueSend({ conversationId: ROOM_ID, clientMessageId: 'retired-send', content: 'Denied', locale: 'en' }),
    /group_retired/
  )
  assert.throws(
    () => store.groups.queueGroupOperation(addMemberOperation(), '2026-09-06T00:00:00.000Z'),
    /group_retired/
  )

  const leave = store.groups.queueGroupOperation(
    { action: 'leave', conversationId: ROOM_ID, clientOperationId: OPERATION_ID },
    '2026-09-06T00:00:01.000Z'
  )

  const report = store.groups.queueGroupOperation(
    {
      action: 'report',
      conversationId: ROOM_ID,
      reason: 'harassment',
      messageId: MESSAGE_ID,
      clientOperationId: '00000000-0000-4000-8000-df85828bc4f2'
    },
    '2026-09-06T00:00:02.000Z'
  )

  assert.equal(leave.state, 'queued')
  assert.equal(report.state, 'queued')
  assert.deepEqual(
    store.groups
      .groupOperations()
      .map(operation => operation.input.action)
      .sort(),
    ['leave', 'report']
  )
  store.close()
})

test('cursor reset purges group work beyond the roster display limit', () => {
  const accountId = 'account-a'
  const store = new AtumMessagingStore({ accountId, databasePath: databasePath() })
  let lastId = ''

  for (let index = 1; index <= 501; index += 1) {
    lastId = `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`
    const conversation = groupConversation(accountId)
    store.upsertConversation({ ...conversation, id: lastId, group: { ...conversation.group!, conversationId: lastId } })
  }

  store.queueSend({ conversationId: lastId, clientMessageId: 'last-room-send', content: 'Pending', locale: 'en' })
  assert.equal(store.listConversations(1000).length, 500)
  assert.equal(store.groups.groupRoomIds().length, 501)
  store.resetProjection()
  assert.deepEqual(store.groups.groupRoomIds(), [])
  assert.equal(store.listConversations(1000).length, 0)
  assert.equal(store.listDueMutations('2099-01-01T00:00:00.000Z').length, 0)
  store.close()
})
