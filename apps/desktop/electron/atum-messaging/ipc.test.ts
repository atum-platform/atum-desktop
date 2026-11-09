import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import { ATUM_MESSAGING_IPC_CHANNELS, groupOperationInput, registerAtumMessagingIpc } from './ipc'
import type { MessagingClientBoundary } from './types'

function harness() {
  const handlers = new Map<string, (...args: any[]) => unknown>()

  const ipc = {
    handle(channel: string, listener: (...args: any[]) => unknown) {
      handlers.set(channel, listener)
    },
    removeHandler(channel: string) {
      handlers.delete(channel)
    }
  }

  const client = {
    status: vi.fn(),
    roster: vi.fn(),
    messages: vi.fn(),
    artifact: vi.fn(),
    ensureSpecialistConversation: vi.fn(),
    registerAssistant: vi.fn(),
    createAssistantAvatarUpload: vi.fn(),
    completeAssistantAvatarUpload: vi.fn(),
    clearAssistantAvatar: vi.fn(),
    draft: vi.fn(),
    saveDraft: vi.fn(),
    send: vi.fn(),
    retry: vi.fn(),
    markRead: vi.fn(),
    sync: vi.fn(),
    groupCapabilities: vi.fn(),
    groupDetail: vi.fn(),
    groupOperate: vi.fn(),
    groupOperations: vi.fn()
  } as unknown as MessagingClientBoundary

  return { handlers, ipc, client }
}

test('registers only the allowlisted model operations and removes them cleanly', () => {
  const { handlers, ipc, client } = harness()
  const unregister = registerAtumMessagingIpc(ipc, client)

  assert.deepEqual([...handlers.keys()].sort(), [...ATUM_MESSAGING_IPC_CHANNELS].sort())
  assert.equal(
    [...handlers.keys()].some(channel => /token|database|fetch|supabase|secret/i.test(channel)),
    false
  )
  unregister()
  assert.equal(handlers.size, 0)
})

test('artifact IPC accepts only conversation scope plus opaque reference', async () => {
  const { handlers, ipc, client } = harness()
  registerAtumMessagingIpc(ipc, client)
  const artifact = handlers.get('atum:messaging:artifact')!

  await artifact({}, 'conversation-a', 'moon.laso:42')
  assert.deepEqual(vi.mocked(client.artifact).mock.calls[0], ['conversation-a', 'moon.laso:42'])
  assert.throws(() => artifact({}, 'conversation-a', '../secret'), /opaque resource/)
  assert.throws(() => artifact({}, 'conversation-a', 'https://evil.test/x'), /opaque resource/)
})

test('specialist conversation IPC accepts only a lowercase app identifier', async () => {
  const { handlers, ipc, client } = harness()
  registerAtumMessagingIpc(ipc, client)
  const ensure = handlers.get('atum:messaging:specialist:ensure')!

  await ensure({}, 'moon')
  assert.deepEqual(vi.mocked(client.ensureSpecialistConversation).mock.calls[0], ['moon'])
  assert.throws(() => ensure({}, '../moon'), /lowercase app identifier/)
  assert.throws(() => ensure({}, 'Moon'), /lowercase app identifier/)
})

test('assistant registration accepts 40 printable characters and rejects 41 before the client call', async () => {
  const { handlers, ipc, client } = harness()
  registerAtumMessagingIpc(ipc, client)
  const register = handlers.get('atum:assistants:register')!

  const input = {
    identityId: '00000000-0000-4000-8000-303617b97302',
    displayName: 'x'.repeat(40),
    avatar: '📣',
    isDefault: false,
    lifecycleRevision: 1
  }

  await register({}, input)
  assert.deepEqual(vi.mocked(client.registerAssistant).mock.calls[0]?.[0], input)
  assert.throws(
    () => register({}, { ...input, displayName: 'x'.repeat(41) }),
    /displayName must be 1 to 40 printable characters/
  )
  assert.equal(vi.mocked(client.registerAssistant).mock.calls.length, 1)
})

test('assistant avatar IPC validates UUIDs and supported image content types before invoking the client', async () => {
  const { handlers, ipc, client } = harness()
  registerAtumMessagingIpc(ipc, client)
  const create = handlers.get('atum:assistants:avatar:create')!
  const complete = handlers.get('atum:assistants:avatar:complete')!
  const clear = handlers.get('atum:assistants:avatar:clear')!
  const assistantId = '00000000-0000-4000-8000-bd7662a5eeb4'
  const uploadId = '00000000-0000-4000-8000-b454f82c5857'

  await create({}, assistantId, { contentType: 'image/webp', ownerUserId: 'forged' })
  await complete({}, assistantId, uploadId)
  await clear({}, assistantId)

  assert.deepEqual(vi.mocked(client.createAssistantAvatarUpload).mock.calls[0], [
    assistantId,
    { contentType: 'image/webp' }
  ])
  assert.deepEqual(vi.mocked(client.completeAssistantAvatarUpload).mock.calls[0], [assistantId, uploadId])
  assert.deepEqual(vi.mocked(client.clearAssistantAvatar).mock.calls[0], [assistantId])
  assert.throws(() => create({}, 'assistant-id', { contentType: 'image/png' }), /assistantId must be a UUID/)
  assert.throws(() => create({}, assistantId, { contentType: 'image/gif' }), /avatar contentType/)
  assert.throws(() => complete({}, assistantId, 'upload-id'), /uploadId must be a UUID/)
})

test('send IPC reconstructs the allowlisted request and rejects renderer-authored authority fields', async () => {
  const { handlers, ipc, client } = harness()
  registerAtumMessagingIpc(ipc, client)
  const send = handlers.get('atum:messaging:send')!

  const input = {
    conversationId: 'conversation-a',
    clientMessageId: 'client-a',
    content: 'Xin chào',
    locale: 'vi',
    attachmentIds: [],
    sender_id: 'forged',
    created_at: 'forged',
    status: 'forged'
  }

  await send({}, input)
  assert.deepEqual(vi.mocked(client.send).mock.calls[0]?.[0], {
    conversationId: 'conversation-a',
    clientMessageId: 'client-a',
    content: 'Xin chào',
    locale: 'vi',
    replyToMessageId: null,
    attachmentIds: []
  })
  assert.throws(() => send({}, { ...input, locale: 'xx' }), /locale/)
})

test('mention validation measures the span in code points, matching the hosted validator', async () => {
  const { handlers, ipc, client } = harness()
  registerAtumMessagingIpc(ipc, client)
  const send = handlers.get('atum:messaging:send')!

  const base = {
    conversationId: '00000000-0000-4000-8000-bd7662a5eeb4',
    clientMessageId: '00000000-0000-4000-8000-b454f82c5857',
    locale: 'vi',
    replyToMessageId: null,
    attachmentIds: []
  }

  // '🙂 Chào @Atum giúp mình' — the emoji is two UTF-16 units but one code
  // point, so the token is [7,12) in code points and [8,13) in UTF-16.
  await send(
    {},
    {
      ...base,
      content: '🙂 Chào @Atum giúp mình',
      mention: { agent: 'binh-minh', revision: 0, startOffset: 7, endOffset: 12 }
    }
  )
  assert.equal((client.send as ReturnType<typeof vi.fn>).mock.calls.length, 1)

  // `sendInput` rejects before the promise exists, so these throw synchronously.
  assert.throws(
    () =>
      send(
        {},
        {
          ...base,
          content: '🙂 Chào @Atum giúp mình',
          mention: { agent: 'binh-minh', revision: 0, startOffset: 8, endOffset: 13 }
        }
      ),
    /mention is invalid/
  )
  assert.throws(
    () =>
      send(
        {},
        {
          ...base,
          content: 'xin chào bạn',
          mention: { agent: 'binh-minh', revision: 0, startOffset: 0, endOffset: 5 }
        }
      ),
    /mention is invalid/
  )
})

const GROUP_ID = '00000000-0000-4000-8000-576f18824476'
const MEMBER_ID = '00000000-0000-4000-8000-4b2f94c54b02'
const MESSAGE_ID = '00000000-0000-4000-8000-471568220011'
const OPERATION_ID = '00000000-0000-4000-8000-6789912c6209'

test('group IPC routes every closed operation through the typed client boundary', async () => {
  const { handlers, ipc, client } = harness()
  registerAtumMessagingIpc(ipc, client)
  const operate = handlers.get('atum:messaging:group:operate')!

  await operate(
    {},
    {
      action: 'create',
      title: '  Weekend plans  ',
      memberUserIds: [MEMBER_ID],
      specialistIds: ['moon'],
      clientOperationId: OPERATION_ID
    }
  )
  await operate(
    {},
    { action: 'add_member', conversationId: GROUP_ID, targetUserId: MEMBER_ID, clientOperationId: OPERATION_ID }
  )
  await operate(
    {},
    { action: 'add_specialist', conversationId: GROUP_ID, specialist: 'moon', clientOperationId: OPERATION_ID }
  )
  await operate(
    {},
    { action: 'remove_specialist', conversationId: GROUP_ID, specialist: 'moon', clientOperationId: OPERATION_ID }
  )
  await operate(
    {},
    { action: 'remove_member', conversationId: GROUP_ID, targetUserId: MEMBER_ID, clientOperationId: OPERATION_ID }
  )
  await operate(
    {},
    {
      action: 'report',
      conversationId: GROUP_ID,
      reason: 'other',
      memberSpecialist: 'moon',
      clientOperationId: OPERATION_ID
    }
  )
  await operate(
    {},
    { action: 'transfer_owner', conversationId: GROUP_ID, targetUserId: MEMBER_ID, clientOperationId: OPERATION_ID }
  )
  await operate({}, { action: 'leave', conversationId: GROUP_ID, clientOperationId: OPERATION_ID })
  await operate({}, { action: 'retire', conversationId: GROUP_ID, clientOperationId: OPERATION_ID })
  await operate(
    {},
    { action: 'rename', conversationId: GROUP_ID, title: '🙂'.repeat(80), clientOperationId: OPERATION_ID }
  )
  await operate(
    {},
    {
      action: 'report',
      conversationId: GROUP_ID,
      reason: 'harassment',
      memberUserId: MEMBER_ID,
      note: '  details  ',
      clientOperationId: OPERATION_ID
    }
  )
  await operate(
    {},
    {
      action: 'report',
      conversationId: GROUP_ID,
      reason: 'spam',
      messageId: MESSAGE_ID,
      clientOperationId: OPERATION_ID
    }
  )

  assert.deepEqual(
    vi.mocked(client.groupOperate).mock.calls.map(([input]) => input),
    [
      {
        action: 'create',
        title: 'Weekend plans',
        memberUserIds: [MEMBER_ID],
        specialistIds: ['moon'],
        clientOperationId: OPERATION_ID
      },
      { action: 'add_member', conversationId: GROUP_ID, targetUserId: MEMBER_ID, clientOperationId: OPERATION_ID },
      { action: 'add_specialist', conversationId: GROUP_ID, specialist: 'moon', clientOperationId: OPERATION_ID },
      { action: 'remove_specialist', conversationId: GROUP_ID, specialist: 'moon', clientOperationId: OPERATION_ID },
      { action: 'remove_member', conversationId: GROUP_ID, targetUserId: MEMBER_ID, clientOperationId: OPERATION_ID },
      {
        action: 'report',
        conversationId: GROUP_ID,
        reason: 'other',
        memberSpecialist: 'moon',
        clientOperationId: OPERATION_ID
      },
      { action: 'transfer_owner', conversationId: GROUP_ID, targetUserId: MEMBER_ID, clientOperationId: OPERATION_ID },
      { action: 'leave', conversationId: GROUP_ID, clientOperationId: OPERATION_ID },
      { action: 'retire', conversationId: GROUP_ID, clientOperationId: OPERATION_ID },
      { action: 'rename', conversationId: GROUP_ID, title: '🙂'.repeat(80), clientOperationId: OPERATION_ID },
      {
        action: 'report',
        conversationId: GROUP_ID,
        reason: 'harassment',
        memberUserId: MEMBER_ID,
        note: 'details',
        clientOperationId: OPERATION_ID
      },
      {
        action: 'report',
        conversationId: GROUP_ID,
        reason: 'spam',
        messageId: MESSAGE_ID,
        clientOperationId: OPERATION_ID
      }
    ]
  )
})

test('group IPC validates the capability, detail, and operation-list routes before main calls the client', async () => {
  const { handlers, ipc, client } = harness()
  registerAtumMessagingIpc(ipc, client)

  await handlers.get('atum:messaging:group:capabilities')!({})
  await handlers.get('atum:messaging:group:detail')!({}, GROUP_ID, 'event-cursor')
  await handlers.get('atum:messaging:group:operations')!({})

  assert.equal(vi.mocked(client.groupCapabilities).mock.calls.length, 1)
  assert.deepEqual(vi.mocked(client.groupDetail).mock.calls[0], [GROUP_ID, 'event-cursor'])
  assert.equal(vi.mocked(client.groupOperations).mock.calls.length, 1)
  assert.throws(
    () => handlers.get('atum:messaging:group:detail')!({}, 'not-a-uuid'),
    /conversationId must be a UUID v4/
  )
  assert.equal(vi.mocked(client.groupDetail).mock.calls.length, 1)
})

test('group IPC rejects forged fields, invalid UUIDs, invalid title and membership shapes, and ambiguous reports', () => {
  const { handlers, ipc, client } = harness()
  registerAtumMessagingIpc(ipc, client)
  const operate = handlers.get('atum:messaging:group:operate')!
  const create = { action: 'create', title: 'Room', memberUserIds: [MEMBER_ID], clientOperationId: OPERATION_ID }

  assert.throws(() => operate({}, { ...create, actorUserId: MEMBER_ID }), /unsupported fields/)
  assert.throws(() => operate({}, { ...create, clientOperationId: 'forged' }), /clientOperationId must be a UUID v4/)
  assert.throws(() => operate({}, { ...create, title: '🙂'.repeat(81) }), /title must be 1 to 80 characters/)
  assert.throws(() => operate({}, { ...create, memberUserIds: [MEMBER_ID, MEMBER_ID] }), /must be unique/)
  assert.throws(() => operate({}, { ...create, memberUserIds: [] }), /1 to 31 UUIDs/)
  assert.throws(
    () =>
      operate(
        {},
        {
          action: 'report',
          conversationId: GROUP_ID,
          reason: 'unsafe',
          memberUserId: MEMBER_ID,
          messageId: MESSAGE_ID,
          clientOperationId: OPERATION_ID
        }
      ),
    /exactly one memberUserId, memberSpecialist, memberAssistant or messageId/
  )
  assert.throws(
    () =>
      operate(
        {},
        {
          action: 'report',
          conversationId: GROUP_ID,
          reason: 'unsafe',
          memberUserId: MEMBER_ID,
          clientOperationId: OPERATION_ID,
          note: 'x'.repeat(2001)
        }
      ),
    /note must be at most 2000 characters/
  )
  assert.equal(vi.mocked(client.groupOperate).mock.calls.length, 0)
})

test('addressed mentions accept ordered assistant and specialist spans, with closed quote references', async () => {
  const { handlers, ipc, client } = harness()
  registerAtumMessagingIpc(ipc, client)
  const send = handlers.get('atum:messaging:send')!

  const base = {
    conversationId: '00000000-0000-4000-8000-bd7662a5eeb4',
    clientMessageId: '00000000-0000-4000-8000-b454f82c5857',
    content: '@Mai và @Minh',
    locale: 'vi',
    replyToMessageId: null,
    attachmentIds: []
  }

  await send(
    {},
    {
    ...base,
    mentions: {
      contract: 'atum.addressed-mentions/1',
      targets: [
          {
            target: { type: 'assistant', id: '00000000-0000-4000-8000-f6222a1106ee' },
            revision: 1,
            startOffset: 0,
            endOffset: 4
          },
          {
            target: { type: 'assistant', id: '00000000-0000-4000-8000-f1d11edf5c5c' },
            revision: 1,
            startOffset: 8,
            endOffset: 13
          }
      ]
    }
    }
  )
  assert.deepEqual(
    (client.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].mentions?.targets.map(row => row.target.id),
    ['00000000-0000-4000-8000-f6222a1106ee', '00000000-0000-4000-8000-f1d11edf5c5c']
  )
  await send(
    {},
    {
    ...base,
      mentions: {
        contract: 'atum.addressed-mentions/1',
        targets: [{ target: { type: 'specialist', id: 'moon' }, revision: 1, startOffset: 0, endOffset: 4 }]
      },
    quotedMessage: { messageId: '00000000-0000-4000-8000-fbfe405ca65f', sourceVersion: 1 }
    }
  )
  assert.deepEqual((client.send as ReturnType<typeof vi.fn>).mock.calls[1]?.[0].mentions?.targets, [
    { target: { type: 'specialist', id: 'moon' }, revision: 1, startOffset: 0, endOffset: 4 }
  ])
  assert.deepEqual((client.send as ReturnType<typeof vi.fn>).mock.calls[1]?.[0].quotedMessage, {
    messageId: '00000000-0000-4000-8000-fbfe405ca65f',
    sourceVersion: 1
  })
  assert.throws(
    () =>
      send(
        {},
        {
    ...base,
    attachmentIds: ['attachment-a'],
          mentions: {
            contract: 'atum.addressed-mentions/1',
            targets: [
              {
                target: { type: 'assistant', id: '00000000-0000-4000-8000-f6222a1106ee' },
                revision: 1,
                startOffset: 0,
                endOffset: 4
              }
            ]
          }
        }
      ),
    /cannot include attachments/
  )
  assert.throws(
    () =>
      send(
        {},
        {
    ...base,
          mentions: {
            contract: 'atum.addressed-mentions/1',
            targets: [
              {
                target: { type: 'assistant', id: '00000000-0000-4000-8000-f6222a1106ee' },
                revision: 1,
                startOffset: 0,
                endOffset: 99
              }
            ]
          }
        }
      ),
    /mentions are invalid/
  )
  assert.throws(
    () =>
      send(
        {},
        {
    ...base,
    quotedMessage: { messageId: '00000000-0000-4000-8000-fbfe405ca65f', sourceVersion: 0 }
        }
      ),
    /quotedMessage is invalid/
  )
})

test('group creation carries blank default-name intent through IPC while rename remains explicit', () => {
  const base = { action: 'create', reuseExisting: true, memberUserIds: [MEMBER_ID], clientOperationId: OPERATION_ID }

  for (const title of [undefined, null, '', '  ']) {
    assert.equal(
      (groupOperationInput({ ...base, title }) as Extract<ReturnType<typeof groupOperationInput>, { action: 'create' }>)
        .title,
      ''
    )
  }

  assert.throws(
    () =>
      groupOperationInput({ action: 'rename', title: '', conversationId: GROUP_ID, clientOperationId: OPERATION_ID }),
    /group title/
  )
  assert.throws(() => groupOperationInput({ ...base, reuseExisting: undefined, title: '' }), /group title/)
  assert.throws(() => groupOperationInput({ ...base, reuseExisting: 'yes', title: '' }), /creation behavior/)
})
