import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import { parseGroupCapabilities, parseGroupRoom } from './group-wire'
import { AtumMessagingHttpClient } from './http-client'
import { groupOperationInput } from './ipc'

const roomId = '00000000-0000-4000-8000-f6222a1106ee'
const ownerId = '00000000-0000-4000-8000-f1d11edf5c5c'
const operationId = '00000000-0000-4000-8000-fbfe405ca65f'
const roundId = '00000000-0000-4000-8000-a9703d75e616'

const advisor = {
  target: { type: 'specialist', id: 'moon' },
  display_name: 'Moon',
  avatar: '☾',
  availability: 'available'
}

test('advisory IPC and real transport retain typed roster and expected round without client authority', async () => {
  const input = {
    action: 'create',
    contextMode: 'private_advisory',
    memberUserIds: [],
    advisors: [advisor.target],
    title: 'Meeting',
    clientOperationId: operationId
  }

  const create = groupOperationInput(input)
  assert.throws(() => groupOperationInput({ ...input, ownerId }), /unexpected|keys|fields/i)
  assert.throws(() => groupOperationInput({ ...input, memberUserIds: [ownerId] }), /no human invitees/)
  assert.throws(() => groupOperationInput({ ...input, advisors: [advisor.target, advisor.target] }), /unique/)

  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify({ conversation_id: roomId, replayed: false }), {
        headers: { 'content-type': 'application/json' }
      })
  )

  const client = new AtumMessagingHttpClient(
    {
      current: () => ({
        baseUrl: 'https://atum.test',
        user: { id: ownerId, displayName: null, handle: null },
        tokens: { accessToken: 'fixture-token', refreshToken: null, expiresAt: null }
      }),
      refresh: async () => null
    },
    fetchImpl
  )

  await client.groupOperate(create)
  await client.groupOperate(
    groupOperationInput({
      action: 'stop_advisory',
      conversationId: roomId,
      roundId,
      audienceRevision: 1,
      clientOperationId: operationId
    })
  )
  const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][]
  assert.equal(calls[0]![0], 'https://atum.test/api/desktop/v1/advisory-conversations')
  assert.deepEqual(JSON.parse(String(calls[0]![1].body)), {
    title: 'Meeting',
    advisors: [advisor.target],
    client_operation_id: operationId
  })
  assert.equal(new Headers(calls[0]![1].headers).get('x-atum-private-advisory'), '1')
  assert.deepEqual(JSON.parse(String(calls[1]![1].body)), {
    round_id: roundId,
    audience_revision: 1,
    client_operation_id: operationId
  })
})

test('shared-group IPC accepts only its closed roster shape', () => {
  const shared = groupOperationInput({
    action: 'create',
    contextMode: 'shared_group',
    title: 'Planning',
    memberUserIds: [ownerId],
    specialistIds: ['moon'],
    assistantIds: [ownerId],
    clientOperationId: operationId
  })

  assert.deepEqual(shared, {
    action: 'create',
    contextMode: 'shared_group',
    title: 'Planning',
    memberUserIds: [ownerId],
    specialistIds: ['moon'],
    assistantIds: [ownerId],
    clientOperationId: operationId
  })
  assert.throws(() => groupOperationInput({ ...shared, contextMode: 'unknown_context' }), /unsupported fields/)
  assert.throws(() => groupOperationInput({ ...shared, memberUserIds: [] }), /memberUserIds/)
  assert.deepEqual(
    groupOperationInput({
      action: 'add_assistant',
      conversationId: roomId,
      assistantId: ownerId,
      clientOperationId: operationId
    }),
    { action: 'add_assistant', conversationId: roomId, assistantId: ownerId, clientOperationId: operationId }
  )
  assert.deepEqual(
    groupOperationInput({
      action: 'report',
      conversationId: roomId,
      memberAssistant: ownerId,
      reason: 'spam',
      clientOperationId: operationId
    }),
    {
      action: 'report',
      conversationId: roomId,
      memberAssistant: ownerId,
      reason: 'spam',
      clientOperationId: operationId
    }
  )
})

test('private scope is advertised explicitly and rejects a second human in a server projection', () => {
  const group = { contract: 'atum.group-conversations/1', creation_enabled: false, human_member_limit: 32 }
  assert.equal(parseGroupCapabilities(group).advisory, undefined)
  assert.equal(parseGroupCapabilities(group, undefined, { contract: 'future/2' }).advisory, undefined)
  assert.equal(
    parseGroupCapabilities(group, undefined, {
      contract: 'atum.private-advisory/1',
      enabled: true,
      advisor_limit: 8,
      advisor_catalog: [advisor]
    }).advisory?.enabled,
    true
  )
  const member = { user_id: ownerId, display_name: 'Owner', handle: 'owner', role: 'owner', membership_epoch: 1 }

  const room = {
    conversation_id: roomId,
    title: 'Meeting',
    revision: 1,
    retired_at: null,
    membership_epoch: 1,
    members: [member],
    updated_at: '2026-09-06T00:00:00Z',
    context_mode: 'private_advisory',
    audience_revision: 1,
    advisors: [advisor],
    latest_round: { id: roundId, status: 'running', slots: [{ slot: 1, target: advisor.target, status: 'running' }] }
  }

  assert.equal(parseGroupRoom(room, roomId).contextMode, 'private_advisory')
  assert.throws(
    () => parseGroupRoom({ ...room, members: [member, { ...member, user_id: operationId, role: 'member' }] }, roomId),
    /advisory_owner/
  )
  const ordinary = { ...room, context_mode: 'ordinary' }
  assert.equal(parseGroupRoom(ordinary, roomId).advisors, undefined)
})

test('advisory completion requires the platform canonical reply result', async () => {
  const responses = [
    { state: 'completed', reply_id: '00000000-0000-4000-8000-f2da1f9533d4', deduplicated: false },
    { state: 'completed', reply_id: null, deduplicated: false }
  ]

  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify(responses.shift()), {
        headers: { 'content-type': 'application/json' }
      })
  )

  const client = new AtumMessagingHttpClient(
    {
      current: () => ({
        baseUrl: 'https://atum.test',
        user: { id: ownerId, displayName: null, handle: null },
        tokens: { accessToken: 'fixture-token', refreshToken: null, expiresAt: null }
      }),
      refresh: async () => null
    },
    fetchImpl
  )

  await client.advisoryComplete(roomId, operationId, 'lease-token', 'canonical reply')
  await assert.rejects(
    client.advisoryComplete(roomId, operationId, 'lease-token', 'canonical reply'),
    /invalid_response:advisory\.complete/
  )
})
