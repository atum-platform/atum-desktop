import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import { AtumMessagingHttpClient, MessagingHttpError } from './http-client'
import type { MessagingAccountSession } from './types'

const session: MessagingAccountSession = {
  baseUrl: 'https://atum.test',
  user: { id: 'account-a', displayName: null, handle: null },
  tokens: { accessToken: 'secret-token', refreshToken: null, expiresAt: null }
}

const localContentWrites = {
  petContent: (client: AtumMessagingHttpClient) => client.putAccountPetContent({
    schema_version: 1, sha256: 'a'.repeat(64), files: []
  }),
  petMetadata: (client: AtumMessagingHttpClient) => client.putAccountPet('pet-a', {
    expected_revision: 0, display_name: 'Test pet', description: 'Synthetic private description', content_sha256: 'a'.repeat(64)
  }),
  memory: (client: AtumMessagingHttpClient) => client.putAssistantMemory('assistant-a', {
    expected_revision: 0, enabled: true, snapshot: { memory: ['Synthetic private memory'], user: [] }
  }),
  skill: (client: AtumMessagingHttpClient) => client.putAssistantSkill('assistant-a', {
    schema_version: 1, sha256: 'a'.repeat(64), files: []
  }),
  definition: (client: AtumMessagingHttpClient) => client.putAssistantDefinition('assistant-a', {
    definition: { schemaVersion: 1, soul: 'Synthetic private instructions', modelAlias: 'binh-minh', reasoning: { enabled: true, effort: 'medium' }, skills: [] },
    displayName: 'Writer', avatar: '', expectedDefinitionRevision: 0, expectedIdentityRevision: 1
  })
}

test.each(Object.entries(localContentWrites))('Google protection blocks %s at the network boundary', async (_kind, write) => {
  const fetchImpl = vi.fn(async () => { throw new Error('must not dispatch') })

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl, {
    workspaceProtected: () => true
  })

  await assert.rejects(write(client), /google_workspace_local_only/)
  assert.equal(fetchImpl.mock.calls.length, 0)
})

test.each(Object.entries(localContentWrites))('Google protection blocks a %s retry after token refresh', async (_kind, write) => {
  let protectedWorkspace = false

  const fetchImpl = vi.fn(async () => Response.json({ error: {
    code: 'auth_expired', message_key: 'auth.expired', retryable: false, request_id: 'test'
  } }, { status: 401 }))

  const refresh = vi.fn(async () => {
    protectedWorkspace = true

    return session
  })

  const client = new AtumMessagingHttpClient({ current: () => session, refresh }, fetchImpl, {
    workspaceProtected: () => protectedWorkspace
  })

  await assert.rejects(write(client), /google_workspace_local_only/)
  assert.equal(refresh.mock.calls.length, 1)
  assert.equal(fetchImpl.mock.calls.length, 1)
})

test('an unreadable Google protection latch cannot authorize an upload', async () => {
  const fetchImpl = vi.fn(async () => { throw new Error('must not dispatch') })

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl, {
    workspaceProtected: () => { throw new Error('storage_unavailable') }
  })

  await assert.rejects(localContentWrites.memory(client), /storage_unavailable/)
  assert.equal(fetchImpl.mock.calls.length, 0)
})

test('parses the complete Proton ledger with decimal balances', async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          balance_protons: 12_345,
          spending_enabled: true,
          available_protons: 12_300.125,
          held_protons: 44.875,
          trial_protons: 10_000,
          ai_protons_per_usd: 40_500,
          funded: true,
          checkout_enabled: true,
          packages: [],
          orders: []
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  )

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)

  assert.deepEqual(await client.protonWallet(), {
    balanceProtons: 12_345,
    spendingEnabled: true,
    availableProtons: 12_300.125,
    heldProtons: 44.875,
    trialProtons: 10_000,
    aiProtonsPerUsd: 40_500,
    funded: true
  })
})

test('retains wallet holds during a service pause and rejects the old incomplete wallet', async () => {
  const projection = { balance_protons: 10, spending_enabled: false, available_protons: 8.5, held_protons: 1.5, trial_protons: 0, ai_protons_per_usd: 40_500, funded: true, checkout_enabled: true, packages: [], orders: [] }
  const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(projection), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ ...projection, spending_enabled: undefined }), { status: 200 }))
  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)
  const wallet = await client.protonWallet()
  assert.equal(wallet.spendingEnabled, false)
  assert.equal(wallet.heldProtons, 1.5)
  assert.equal(wallet.availableProtons, 8.5)
  await assert.rejects(client.protonWallet(), /invalid_response:protons.wallet.spending_enabled/)
})

test('ignores the retired legacy checkout fields the platform may still send', async () => {
  const orders = [{ id: 'not-a-uuid', status: 'settled', payment: { bank_bin: 'MB' } }]
  const fetchImpl = vi.fn(async () => new Response(
    JSON.stringify({ spending_enabled: false, available_protons: 0, held_protons: 0, trial_protons: 0, ai_protons_per_usd: 40_500, balance_protons: 0, funded: false, checkout_enabled: true, packages: [{ id: 1 }], orders }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  ))

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)
  const wallet = await client.protonWallet()

  assert.deepEqual(Object.keys(wallet).sort(), ['aiProtonsPerUsd', 'availableProtons', 'balanceProtons', 'funded', 'heldProtons', 'spendingEnabled', 'trialProtons'])
  assert.equal('createProtonOrder' in client, false)
  assert.equal('protonOrder' in client, false)
})

test('advisory history search sends exactly the bounded semantic source body', async () => {
  const room = '00000000-0000-4000-8000-f6222a1106ee'
  const assistant = '00000000-0000-4000-8000-f1d11edf5c5c'
  const message = '00000000-0000-4000-8000-fbfe405ca65f'
  const owner = '00000000-0000-4000-8000-a9703d75e616'

  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          status: 'ok',
          results: [
            {
              session_id: 'atum-advisory:eyJ2IjoxfQ',
              conversation_id: room,
              title: 'Moving',
              audience_revision: 1,
              context_revision: 2,
              messages: [
                {
                  id: message,
                  version: 1,
                  created_at: '2026-09-01T00:00:00Z',
                  speaker: { kind: 'owner', id: owner },
                  text: 'October'
                }
              ]
            }
          ],
          next_reference: null,
          previous_reference: null
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  )

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)

  await client.advisorySearch({
    target_assistant_id: assistant,
    conversation_id: room,
    query: 'chuyển nhà',
    reference: null,
    limit: 3
  })

  const [url, init] = (fetchImpl.mock.calls as unknown as [string, RequestInit][])[0]!
  assert.equal(url, 'https://atum.test/api/desktop/v1/advisory-conversations/search')
  assert.equal(new Headers(init.headers).get('x-atum-private-advisory'), '1')
  assert.deepEqual(JSON.parse(String(init.body)), {
    target_assistant_id: assistant,
    conversation_id: room,
    query: 'chuyển nhà',
    reference: null,
    limit: 3
  })
})

test('social v1 requests carry the frozen version, epoch, and idempotency contract', async () => {
  const epoch = '00000000-0000-4000-8000-d98016d67fb8'
  const operationId = '00000000-0000-4000-8000-03dd42e49c44'
  const profileId = '00000000-0000-4000-8000-e03cc076d760'

  const projection = {
    availability: 'available',
    profile: { profile_id: profileId, display_name: 'Bob', handle: 'social-bob', verified: false, avatar: null },
    state: 'outgoing_pending',
    version: 1,
    can_message: false,
    direct_thread_id: null
  }

  const responses = [
    { account_epoch: epoch, projection: { ...projection, state: 'none', version: 0 } },
    { account_epoch: epoch, operation_id: operationId, replayed: false, projection },
    { account_epoch: epoch, changes: [{ change_id: '1', projection }], next_cursor: 'cursor-1', has_more: false }
  ]

  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
  )

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)

  await client.socialLookup('social-bob')
  await client.socialMutate({
    accountEpoch: epoch,
    action: 'request',
    clientOperationId: operationId,
    targetProfileId: profileId
  })
  await client.socialSync(epoch, null)

  const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][]
  assert.equal(calls[0]?.[0], 'https://atum.test/api/desktop/v1/social/lookup?q=social-bob')
  assert.equal(calls[1]?.[0], 'https://atum.test/api/desktop/v1/social/mutations')
  assert.equal(calls[2]?.[0], `https://atum.test/api/desktop/v1/social/sync?account_epoch=${epoch}&limit=100`)

  for (const [, init] of calls) {
    assert.equal(new Headers(init.headers).get('x-atum-social-version'), '1')
  }

  assert.equal(new Headers(calls[1]?.[1].headers).get('idempotency-key'), operationId)
  assert.deepEqual(JSON.parse(String(calls[1]?.[1].body)), {
    account_epoch: epoch,
    action: 'request',
    client_operation_id: operationId,
    target_profile_id: profileId
  })
})

test('ensuring a specialist conversation carries one idempotency key and no user-authored identity', async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          conversation: {
            id: '00000000-0000-4000-8000-f6222a1106ee',
            specialist: 'moon',
            created_at: '2026-08-27T00:00:00.000Z',
            updated_at: '2026-08-27T00:00:00.000Z'
          },
          replayed: false
        }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      )
  )

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)

  assert.deepEqual(await client.ensureSpecialistConversation('moon', 'operation-1'), {
    conversationId: '00000000-0000-4000-8000-f6222a1106ee',
    replayed: false,
    specialist: 'moon'
  })
  const [url, init] = (fetchImpl.mock.calls as unknown as [string | URL | Request, RequestInit | undefined][])[0]!
  assert.equal(url, 'https://atum.test/api/desktop/v1/conversations')
  assert.equal(new Headers(init?.headers).get('idempotency-key'), 'operation-1')
  assert.deepEqual(JSON.parse(String(init?.body)), {
    specialist: 'moon',
    client_operation_id: 'operation-1'
  })
})

test('ensuring a specialist conversation rejects a sibling app response', async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          conversation: {
            id: '00000000-0000-4000-8000-f6222a1106ee',
            specialist: 'andy'
          },
          replayed: false
        }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      )
  )

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)

  await assert.rejects(
    client.ensureSpecialistConversation('moon', 'operation-1'),
    /create_conversation\.conversation\.specialist_scope/
  )
})

test('addressed group mutations negotiate the header and preserve only closed specialist fields', async () => {
  const room = '00000000-0000-4000-8000-f6222a1106ee'

  const responses = [
    { conversation_id: room, replayed: false },
    { conversation_id: room, replayed: false },
    { conversation_id: room, replayed: true }
  ]

  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'content-type': 'application/json' } })
  )

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)

  await client.groupOperate({
    action: 'create',
    title: 'Planning',
    memberUserIds: ['00000000-0000-4000-8000-f1d11edf5c5c'],
    specialistIds: ['moon'],
    clientOperationId: '00000000-0000-4000-8000-fbfe405ca65f'
  })
  await client.groupOperate({
    action: 'add_specialist',
    conversationId: room,
    specialist: 'moon',
    clientOperationId: '00000000-0000-4000-8000-a9703d75e616'
  })
  await client.groupOperate({
    action: 'report',
    conversationId: room,
    memberSpecialist: 'moon',
    reason: 'spam',
    clientOperationId: '00000000-0000-4000-8000-f2da1f9533d4'
  })

  const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][]
  assert.deepEqual(
    calls.map(([url]) => url),
    [
      'https://atum.test/api/desktop/v1/groups',
      `https://atum.test/api/desktop/v1/groups/${room}/operations`,
      `https://atum.test/api/desktop/v1/groups/${room}/reports`
    ]
  )
  assert.deepEqual(JSON.parse(String(calls[0]?.[1].body)), {
    title: 'Planning',
    member_user_ids: ['00000000-0000-4000-8000-f1d11edf5c5c'],
    specialist_ids: ['moon'],
    client_operation_id: '00000000-0000-4000-8000-fbfe405ca65f'
  })
  assert.deepEqual(JSON.parse(String(calls[1]?.[1].body)), {
    action: 'add_specialist',
    specialist: 'moon',
    client_operation_id: '00000000-0000-4000-8000-a9703d75e616'
  })
  assert.deepEqual(JSON.parse(String(calls[2]?.[1].body)), {
    reason: 'spam',
    note: null,
    reported_specialist: 'moon',
    client_operation_id: '00000000-0000-4000-8000-f2da1f9533d4'
  })

  for (const [, init] of calls) {
    assert.equal(new Headers(init.headers).get('x-atum-group-addressing'), '1')
    assert.equal(new Headers(init.headers).get('x-atum-group-conversations'), '1')
    assert.equal(new Headers(init.headers).get('x-atum-group-shared-agents'), '1')
  }
})

test('shared-group operations retain their context and assistant ids on the group route', async () => {
  const room = '00000000-0000-4000-8000-f6222a1106ee'
  const assistant = '00000000-0000-4000-8000-f1d11edf5c5c'
  const person = '00000000-0000-4000-8000-fbfe405ca65f'

  const responses = [
    { conversation_id: room, replayed: false },
    { conversation_id: room, replayed: false },
    { conversation_id: room, replayed: false }
  ]

  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'content-type': 'application/json' } })
  )

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)

  await client.groupOperate({
    action: 'create',
    contextMode: 'shared_group',
    title: 'Planning',
    memberUserIds: [person],
    specialistIds: ['moon'],
    assistantIds: [assistant],
    clientOperationId: '00000000-0000-4000-8000-a9703d75e616'
  })
  await client.groupOperate({
    action: 'add_assistant',
    conversationId: room,
    assistantId: assistant,
    clientOperationId: '00000000-0000-4000-8000-f2da1f9533d4'
  })
  await client.groupOperate({
    action: 'report',
    conversationId: room,
    memberAssistant: assistant,
    reason: 'spam',
    clientOperationId: '00000000-0000-4000-8000-c8f367a876b2'
  })

  const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][]
  assert.equal(calls[0]?.[0], 'https://atum.test/api/desktop/v1/groups')
  assert.deepEqual(JSON.parse(String(calls[0]?.[1].body)), {
    context_mode: 'shared_group',
    title: 'Planning',
    member_user_ids: [person],
    specialist_ids: ['moon'],
    assistant_ids: [assistant],
    client_operation_id: '00000000-0000-4000-8000-a9703d75e616'
  })
  assert.deepEqual(JSON.parse(String(calls[1]?.[1].body)), {
    action: 'add_assistant',
    assistant_id: assistant,
    client_operation_id: '00000000-0000-4000-8000-f2da1f9533d4'
  })
  assert.deepEqual(JSON.parse(String(calls[2]?.[1].body)), {
    reason: 'spam',
    note: null,
    reported_assistant_id: assistant,
    client_operation_id: '00000000-0000-4000-8000-c8f367a876b2'
  })
})

test('identity and discovery routes use bearer auth without leaking tokens to the renderer seam', async () => {
  const responses = [
    { available: true },
    {
      user: {
        id: 'account-a',
        display_name: 'Minh Anh',
        handle: 'minh-anh',
        avatar_url: null,
        handle_customized: true,
        next_handle_change_at: '2026-10-02T00:00:00.000Z'
      }
    },
    { conversation: { id: '00000000-0000-4000-8000-f1d11edf5c5c' }, replayed: false },
    [{ app_id: 'moon', display_name: 'Moon', state: 'linked' }],
    null
  ]

  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'content-type': 'application/json' } })
  )

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)

  assert.equal((await client.handleAvailability('minh-anh')).available, true)
  assert.deepEqual(await client.renameHandle('minh-anh'), {
    id: 'account-a',
    displayName: 'Minh Anh',
    handle: 'minh-anh',
    avatarUrl: null,
    handleCustomized: true,
    nextHandleChangeAt: '2026-10-02T00:00:00.000Z'
  })
  assert.equal(
    (
      await client.ensureContactConversation({
        contactUserId: 'account-b',
        clientOperationId: 'operation-contact'
      })
    ).conversationId,
    '00000000-0000-4000-8000-f1d11edf5c5c'
  )
  assert.deepEqual((await client.linkedApps())[0], {
    app: 'moon',
    displayName: 'Moon',
    state: 'linked',
    connectedAt: null,
    lastActiveAt: null
  })
  await client.disconnectApp('moon')

  const calls = fetchImpl.mock.calls as unknown as [string | URL | Request, RequestInit | undefined][]
  const urls = calls.map(call => String(call[0]))
  assert.deepEqual(urls, [
    'https://atum.test/api/desktop/v1/identity/handle/availability?handle=minh-anh',
    'https://atum.test/api/desktop/v1/identity/handle',
    'https://atum.test/api/desktop/v1/conversations',
    'https://atum.test/api/identity/apps',
    'https://atum.test/api/identity/apps/moon/disconnect'
  ])

  for (const call of calls) {
    assert.equal(new Headers(call[1]?.headers).get('authorization'), 'Bearer secret-token')
  }

  assert.deepEqual(JSON.parse(String(calls[2]?.[1]?.body)), {
    contact_user_id: 'account-b',
    client_operation_id: 'operation-contact'
  })
})

test('avatar routes reserve, complete, and clear through the desktop identity plane', async () => {
  const user = {
    id: 'account-a',
    display_name: 'Minh Anh',
    handle: 'minh-anh',
    avatar_url: 'https://cdn.atum.test/a.png',
    handle_customized: true,
    next_handle_change_at: null
  }

  const responses = [
    {
      upload_id: '00000000-0000-4000-8000-6e19e97fb048',
      upload_url: 'https://storage.atum.test/signed',
      upload_headers: { 'content-type': 'image/png' },
      expires_at: '2026-09-02T02:00:00+00:00'
    },
    { user },
    { user: { ...user, avatar_url: null } }
  ]

  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'content-type': 'application/json' } })
  )

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)

  assert.deepEqual(await client.createAvatarUpload({ contentType: 'image/png' }), {
    uploadId: '00000000-0000-4000-8000-6e19e97fb048',
    uploadUrl: 'https://storage.atum.test/signed',
    uploadHeaders: { 'content-type': 'image/png' },
    expiresAt: '2026-09-02T02:00:00+00:00'
  })
  assert.equal(
    (await client.completeAvatarUpload('00000000-0000-4000-8000-6e19e97fb048')).avatarUrl,
    'https://cdn.atum.test/a.png'
  )
  assert.equal((await client.clearAvatar()).avatarUrl, null)

  const calls = fetchImpl.mock.calls as unknown as [string | URL | Request, RequestInit | undefined][]
  assert.deepEqual(
    calls.map(call => [String(call[0]), call[1]?.method ?? 'GET']),
    [
      ['https://atum.test/api/desktop/v1/identity/avatar/uploads', 'POST'],
      [
        'https://atum.test/api/desktop/v1/identity/avatar/uploads/00000000-0000-4000-8000-6e19e97fb048/complete',
        'POST'
      ],
      ['https://atum.test/api/desktop/v1/identity/avatar', 'DELETE']
    ]
  )
  assert.deepEqual(JSON.parse(String(calls[0]?.[1]?.body)), { content_type: 'image/png' })
})

test('identity apps rejects malformed canonical rows fail closed', async () => {
  const malformed = [
    [{ app_id: '', display_name: 'Moon', state: 'linked' }],
    [{ app_id: 'moon', state: 'linked' }],
    [{ app_id: 'moon', display_name: 'Moon', state: 'unknown' }],
    { app_id: 'moon', display_name: 'Moon', state: 'linked' }
  ]

  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify(malformed.shift()), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
  )

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)

  await assert.rejects(client.linkedApps(), /invalid_response:identity\.apps\.app/)
  await assert.rejects(client.linkedApps(), /invalid_response:identity\.apps\.display_name/)
  await assert.rejects(client.linkedApps(), /invalid_response:identity\.apps\.state/)
  await assert.rejects(client.linkedApps(), /invalid_response:identity\.apps/)
})

test('create-direct rejects app scope before transport and serializes only direct fields', async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify({ conversation: { id: '00000000-0000-4000-8000-f1d11edf5c5c' } }), {
        status: 200
      })
  )

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)

  assert.throws(
    () =>
      client.ensureContactConversation({
        contactUserId: 'account-b',
        clientOperationId: 'operation-forged',
        specialist_scope: 'moon'
      } as never),
    /create_direct\.specialist_scope/
  )
  assert.throws(
    () =>
      client.ensureContactConversation({
        contactUserId: 'account-b',
        clientOperationId: 'operation-forged',
        specialist: 'moon'
      } as never),
    /create_direct\.specialist_scope/
  )
  assert.equal(fetchImpl.mock.calls.length, 0)

  await client.ensureContactConversation({
    contactUserId: 'account-b',
    clientOperationId: 'operation-direct'
  })
  const [, init] = (fetchImpl.mock.calls as unknown as [string, RequestInit][])[0]!
  assert.deepEqual(JSON.parse(String(init.body)), {
    contact_user_id: 'account-b',
    client_operation_id: 'operation-direct'
  })
})

test('artifact resolution uses bearer authority and only conversation plus opaque resource in the route', async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          artifact: {
            artifact_id: 'moon.laso:42',
            type: 'reading',
            title: 'Lá số',
            url: 'https://moon.test/artifact/42',
            status: 'ready'
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  )

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)

  await client.artifact('00000000-0000-4000-8000-f6222a1106ee', 'moon.laso:42')
  const [url, init] = (fetchImpl.mock.calls as unknown as [string | URL | Request, RequestInit | undefined][])[0]!
  assert.equal(
    url,
    'https://atum.test/api/desktop/v1/conversations/00000000-0000-4000-8000-f6222a1106ee/artifacts/moon.laso%3A42'
  )
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secret-token')
  assert.equal(String(url).includes('user_id'), false)
  assert.equal(String(url).includes('app'), false)
})

test('messenger feature mutations use the accepted message and media routes', async () => {
  const responses: unknown[] = [
    null,
    null,
    null,
    { attachment_id: 'attachment-1', upload_url: 'https://storage.test/upload' },
    null,
    { url: 'https://storage.test/download' }
  ]

  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'content-type': 'application/json' } })
  )

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)
  await client.toggleReaction('message-1', '❤️')
  await client.editMessage('message-1', 'Đã sửa')
  await client.recallMessage('message-1')
  assert.equal(
    (await client.createMediaUpload({ fileName: 'ảnh.png', mimeType: 'image/png', sizeBytes: 42 })).attachmentId,
    'attachment-1'
  )
  await client.completeMediaUpload('attachment-1')
  assert.equal((await client.downloadMedia('attachment-1')).url, 'https://storage.test/download')
  const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][]
  assert.deepEqual(
    calls.map(call => call[0]),
    [
      'https://atum.test/api/desktop/v1/messages/message-1/reactions/%E2%9D%A4%EF%B8%8F',
      'https://atum.test/api/desktop/v1/messages/message-1',
      'https://atum.test/api/desktop/v1/messages/message-1/recall',
      'https://atum.test/api/desktop/v1/media/uploads',
      'https://atum.test/api/desktop/v1/media/uploads/complete',
      'https://atum.test/api/desktop/v1/media/download?attachment_id=attachment-1'
    ]
  )
})

test('send preserves structured mention offsets in the existing message route body', async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          message: {
            id: 'server-1',
            conversation_id: 'conversation-a',
            sender: { type: 'user', id: 'account-a' },
            content: '@Atum giúp mình',
            kind: 'text',
            attachments: [],
            metadata: null,
            reply_to_message_id: null,
            forwarded_from: null,
            reactions: [],
            version: 1,
            created_at: '2026-08-29T00:00:00.000Z',
            edited_at: null,
            recalled_at: null,
            delivery: 'sent'
          }
        }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      )
  )

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)
  await client.send({
    id: 'send:1',
    kind: 'send_message',
    conversationId: 'conversation-a',
    clientMessageId: 'client-1',
    request: {
      client_message_id: 'client-1',
      content: '@Atum giúp mình',
      locale: 'vi',
      reply_to_message_id: null,
      attachment_ids: [],
      mention: { agent: 'binh-minh', revision: 0, start_offset: 0, end_offset: 5 }
    },
    state: 'queued',
    attemptCount: 0,
    nextAttemptAt: null,
    lastErrorCode: null,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z'
  })
  const [url, init] = (fetchImpl.mock.calls as unknown as [string, RequestInit][])[0]!
  assert.equal(url, 'https://atum.test/api/desktop/v1/conversations/conversation-a/messages')
  assert.deepEqual(JSON.parse(String(init.body)).mention, {
    agent: 'binh-minh',
    revision: 0,
    start_offset: 0,
    end_offset: 5
  })
  assert.equal(new Headers(init.headers).get('idempotency-key'), 'client-1')
})

test.each(['not_linked', 'unsupported', 'not_registered', 'unavailable'])(
  'retains private unavailable targets (%s) without hiding an available agent',
  async availability => {
    const fetchImpl = vi.fn(async () => Response.json({
      contract: 'atum.addressed-mentions/1',
      mention_cardinality: 1,
      targets: [
        { target: { type: 'specialist', id: 'moon' }, revision: 1, display_name: 'Moon', avatar: '☾', availability },
        { target: { type: 'assistant', id: 'owner-agent' }, revision: 1, display_name: 'Atum', avatar: '', availability: 'available' }
      ]
    }))

    const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)
    const result = await client.mentionTargets('private-room')

    assert.equal(result.mentionCardinality, 1)
    assert.deepEqual(result.targets.map(target => [target.displayName, target.availability]), [
      ['Moon', availability], ['Atum', 'available']
    ])
  }
)

test('rejects unknown mention availability instead of making it invocable', async () => {
  const fetchImpl = vi.fn(async () => Response.json({
    contract: 'atum.addressed-mentions/1',
    mention_cardinality: 1,
    targets: [{ target: { type: 'assistant', id: 'owner-agent' }, revision: 1, display_name: 'Atum', availability: 'future_allowed' }]
  }))

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)

  await assert.rejects(client.mentionTargets('private-room'), /invalid_response:mention_targets.targets.0.availability/)
})

test('reads the account-authorized assistant target roster from its distinct route', async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          contract: 'atum.addressed-mentions/1',
          mention_cardinality: 8,
          targets: [
            {
              target: { type: 'assistant', id: '00000000-0000-4000-8000-bd7662a5eeb4' },
              revision: 3,
              display_name: 'Mai',
              avatar: '🌸',
              avatar_url: 'https://cdn.atum.test/mai.png',
              availability: 'assistant_not_owned'
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  )

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)

  assert.deepEqual(await client.mentionTargets('conversation-a'), {
    contract: 'atum.addressed-mentions/1',
    mentionCardinality: 8,
    targets: [
      {
        target: { type: 'assistant', id: '00000000-0000-4000-8000-bd7662a5eeb4' },
        revision: 3,
        displayName: 'Mai',
        avatarUrl: 'https://cdn.atum.test/mai.png',
        avatar: '🌸',
        availability: 'assistant_not_owned'
      }
    ]
  })
  assert.equal(
    (fetchImpl.mock.calls as unknown as [string][])[0]?.[0],
    'https://atum.test/api/desktop/v1/conversations/conversation-a/mention-targets'
  )
})

test('assistant avatar routes carry only server-owned ids and return the authoritative row', async () => {
  const assistantId = '00000000-0000-4000-8000-bd7662a5eeb4'
  const uploadId = '00000000-0000-4000-8000-b454f82c5857'

  const row = {
    id: assistantId,
    identity_id: '00000000-0000-4000-8000-f6222a1106ee',
    display_name: 'Mai',
    avatar: '🌸',
    avatar_url: 'https://cdn.atum.test/assistants/mai.png',
    is_default: false,
    lifecycle_revision: 4,
    status: 'active'
  }

  const responses = [
    {
      upload_id: uploadId,
      upload_url: 'https://storage.atum.test/signed',
      upload_headers: { 'content-type': 'image/png' },
      expires_at: '2026-09-06T00:00:00.000Z'
    },
    { assistant: row },
    { assistant: { ...row, avatar_url: null } }
  ]

  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
  )

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)

  assert.deepEqual(await client.createAssistantAvatarUpload(assistantId, { contentType: 'image/png' }), {
    uploadId,
    uploadUrl: 'https://storage.atum.test/signed',
    uploadHeaders: { 'content-type': 'image/png' },
    expiresAt: '2026-09-06T00:00:00.000Z'
  })
  assert.equal((await client.completeAssistantAvatarUpload(assistantId, uploadId)).avatarUrl, row.avatar_url)
  assert.equal((await client.clearAssistantAvatar(assistantId)).avatarUrl, null)

  const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][]
  assert.equal(calls[0]?.[0], `https://atum.test/api/desktop/v1/assistants/${assistantId}/avatar/uploads`)
  assert.deepEqual(JSON.parse(String(calls[0]?.[1].body)), { content_type: 'image/png' })
  assert.equal(
    calls[1]?.[0],
    `https://atum.test/api/desktop/v1/assistants/${assistantId}/avatar/uploads/${uploadId}/complete`
  )
  assert.equal(String(calls[1]?.[1].body), '{}')
  assert.equal(calls[2]?.[0], `https://atum.test/api/desktop/v1/assistants/${assistantId}/avatar`)
  assert.equal(calls[2]?.[1].method, 'DELETE')
})

test('artifact failure preserves only the stable state for main-process mapping', async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'forbidden',
            message_key: 'messaging.error.forbidden',
            retryable: false,
            request_id: 'request-1',
            details: { artifact_state: 'denied', provider_subject: 'must-not-reach-renderer' }
          }
        }),
        { status: 403 }
      )
  )

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)

  await assert.rejects(client.artifact('conversation-a', 'andy.receipt:9'), error => {
    assert.ok(error instanceof MessagingHttpError)
    assert.equal(error.details?.artifact_state, 'denied')

    return true
  })
})

test('artifact resolution rejects a sibling resource response', async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          artifact: {
            artifact_id: 'andy.receipt:other',
            type: 'receipt',
            title: 'Other',
            url: 'https://andy.test/other',
            status: 'ready'
          }
        }),
        { status: 200 }
      )
  )

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)

  await assert.rejects(client.artifact('conversation-a', 'andy.receipt:9'), /artifact_id_scope/)
})

test('message history sends the opaque server cursor and parses the next page cursor', async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify({ messages: [], next_cursor: 'opaque-next', has_more: true }), { status: 200 })
  )

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)

  assert.deepEqual(await client.messages('conversation-a', 'opaque-before', 75), {
    messages: [],
    nextCursor: 'opaque-next',
    hasMore: true
  })
  const [url] = (fetchImpl.mock.calls as unknown as [string | URL | Request, RequestInit | undefined][])[0]!
  assert.equal(
    url,
    'https://atum.test/api/desktop/v1/conversations/conversation-a/messages?limit=75&cursor=opaque-before'
  )
})

test('assistant registry: register, retire and list carry the frozen shapes and honour every outcome', async () => {
  const identity = '00000000-0000-4000-8000-303617b97302'

  const row = {
    id: 'row-1',
    identity_id: identity,
    display_name: 'Marketing',
    avatar: '📣',
    is_default: false,
    lifecycle_revision: 3,
    status: 'active'
  }

  const responses = [
    { outcome: 'registered', assistant: row },
    { outcome: 'adopt', assistant: { ...row, is_default: true, identity_id: '00000000-0000-4000-8000-00f765af1c54' } },
    { outcome: 'retired', status: 'retired', lifecycle_revision: 4 },
    { assistants: [row, { ...row, id: 'row-0', identity_id: null, is_default: true, status: 'active' }] }
  ]

  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
  )

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)

  const registered = await client.registerAssistant({
    identityId: identity,
    displayName: 'Marketing',
    avatar: '📣',
    isDefault: false,
    lifecycleRevision: 3
  })

  const adopt = await client.registerAssistant({
    identityId: identity,
    displayName: 'Trợ lý',
    avatar: '',
    isDefault: true,
    lifecycleRevision: 1
  })

  const retired = await client.retireAssistant({ identityId: identity, lifecycleRevision: 4 })
  const listed = await client.listAssistants()

  const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][]
  assert.equal(calls[0]?.[0], 'https://atum.test/api/desktop/v1/assistants')
  assert.deepEqual(JSON.parse(String(calls[0]?.[1].body)), {
    identity_id: identity,
    display_name: 'Marketing',
    avatar: '📣',
    is_default: false,
    lifecycle_revision: 3
  })
  assert.equal(calls[2]?.[0], 'https://atum.test/api/desktop/v1/assistants/retire')
  assert.equal(calls[3]?.[1].method ?? 'GET', 'GET')

  assert.equal(registered.outcome, 'registered')
  assert.equal(registered.assistant.identityId, identity)
  assert.equal(adopt.outcome, 'adopt')
  assert.equal(adopt.assistant.identityId, '00000000-0000-4000-8000-00f765af1c54')
  assert.deepEqual(retired, { outcome: 'retired', lifecycleRevision: 4 })
  assert.equal(listed.length, 2)
  assert.equal(listed[1]?.identityId, null)
  assert.equal(listed[1]?.isDefault, true)
})

test('assistant registry: an outcome the client does not know is a bad response, not a silent success', async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify({ outcome: 'surprise', assistant: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
  )

  const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)

  await assert.rejects(
    client.registerAssistant({
      identityId: '00000000-0000-4000-8000-303617b97302',
      displayName: 'x',
      avatar: '',
      isDefault: false,
      lifecycleRevision: 1
    }),
    /invalid_response:assistant_registration\.outcome/
  )
})

test.each(['ordinary', 'shared_group', 'private_advisory'] as const)(
  'nameless %s creation negotiates reuse and accepts the existing room returned with HTTP 200',
  async mode => {
    const room = '00000000-0000-4000-8000-f6222a1106ee'

    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get('x-atum-group-create'), '1')
      assert.equal(JSON.parse(String(init?.body)).title, '')

      return new Response(JSON.stringify({ conversation_id: room, replayed: false, reused: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })

    const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)

    const identity = {
      action: 'create' as const,
      reuseExisting: true as const,
      title: '',
      clientOperationId: '00000000-0000-4000-8000-a9703d75e616'
    }

    const result = await client.groupOperate(
      mode === 'private_advisory'
        ? { ...identity, contextMode: mode, memberUserIds: [], advisors: [{ type: 'specialist', id: 'moon' }] }
        : mode === 'shared_group'
          ? { ...identity, contextMode: mode, memberUserIds: ['00000000-0000-4000-8000-f1d11edf5c5c'] }
          : { ...identity, memberUserIds: ['00000000-0000-4000-8000-f1d11edf5c5c'] }
    )

    assert.equal(result.conversationId, room)
  }
)

test.each(['ordinary', 'shared_group', 'private_advisory'] as const)(
  'retries a pre-upgrade %s create without changing its protocol',
  async mode => {
    const room = '00000000-0000-4000-8000-f6222a1106ee'
    const operation = '00000000-0000-4000-8000-a9703d75e616'

    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get('x-atum-group-create'), null)
      assert.equal(new Headers(init?.headers).get('idempotency-key'), operation)
      assert.equal(JSON.parse(String(init?.body)).title, 'Existing intent')

      return new Response(JSON.stringify({ conversation_id: room, replayed: true }), { status: 200 })
    })

    const client = new AtumMessagingHttpClient({ current: () => session, refresh: async () => null }, fetchImpl)
    const identity = { action: 'create' as const, title: 'Existing intent', clientOperationId: operation }

    const result = await client.groupOperate(
      mode === 'private_advisory'
        ? { ...identity, contextMode: mode, memberUserIds: [], advisors: [{ type: 'specialist', id: 'moon' }] }
        : mode === 'shared_group'
          ? { ...identity, contextMode: mode, memberUserIds: ['00000000-0000-4000-8000-f1d11edf5c5c'] }
          : { ...identity, memberUserIds: ['00000000-0000-4000-8000-f1d11edf5c5c'] }
    )

    assert.deepEqual(result, { conversationId: room, replayed: true })
  }
)

test('Store requests carry the app version the Shell gates assistant sales on', async () => {
  const seen: Array<string | null> = []

  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('x-atum-desktop-version'))

    return Response.json({ items: [], entitlements: [] })
  })

  const tokens = { current: () => session, refresh: async () => null }
  const current = new AtumMessagingHttpClient(tokens, fetchImpl, { desktopVersion: '0.18.3' })
  const unversioned = new AtumMessagingHttpClient(tokens, fetchImpl)
  const malformed = new AtumMessagingHttpClient(tokens, fetchImpl, { desktopVersion: '0.18.3\r\nX-Injected: 1' })

  // Only the request is under test; a parse failure of the stub body does not matter here.
  await current.catalog().catch(() => undefined)
  await current.purchase('offer-a', 1, '00000000-0000-4000-8000-11e594f48195').catch(() => undefined)
  await unversioned.catalog().catch(() => undefined)
  await malformed.catalog().catch(() => undefined)

  assert.deepEqual(seen, ['0.18.3', '0.18.3', null, null])
})
