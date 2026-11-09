import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  parseArtifactResponse,
  parseAssistantRegistrationResult,
  parseCanonicalMessage,
  parseDesktopSession,
  parseMessageMetadata
} from './wire'

function messageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'server-1',
    conversation_id: 'conversation-1',
    sender: { type: 'agent', id: 'moon' },
    content: 'Lá số của bạn đây.',
    kind: 'text',
    attachments: [],
    reply_to_message_id: null,
    forwarded_from: null,
    reactions: [],
    version: 1,
    created_at: '2026-08-17T03:00:00.000Z',
    edited_at: null,
    recalled_at: null,
    delivery: 'sent',
    ...overrides
  }
}

test('parses the advertised private realtime channel contract', () => {
  assert.deepEqual(
    parseDesktopSession({
      user: { id: 'account-a', display_name: 'A', handle: null },
      sync_cursor: null,
      server_time: '2026-08-29T00:00:00.000Z',
      realtime: {
        transport: 'supabase_private_broadcast',
        topic: 'user:account-a:messaging:v1',
        event: 'sync_available'
      }
    }).realtime,
    {
      transport: 'supabase_private_broadcast',
      topic: 'user:account-a:messaging:v1',
      event: 'sync_available'
    }
  )
})

test('keeps group addressing additive to the legacy group session block', () => {
  const parsed = parseDesktopSession({
    group_conversations: { contract: 'atum.group-conversations/1', creation_enabled: false, human_member_limit: 32 },
    group_addressing: {
      contract: 'atum.group-addressing/1',
      enabled: true,
      mention_cardinality: 8,
      quote_limit: 4_000,
      specialist_member_limit: 4,
      specialist_catalog: [{ specialist: 'moon', display_name: 'Moon', avatar: '☾', room_supported: true }]
    },
    shared_group_agents: {
      contract: 'atum.group-shared-agents/1',
      enabled: true,
      assistant_member_limit: 4,
      own_assistant_only: true,
      assistant_catalog: [
        {
          assistant_id: '00000000-0000-4000-8000-576f18824476',
          display_name: 'Marketing',
          owner_user_id: '00000000-0000-4000-8000-4b2f94c54b02',
          membership_epoch: 1,
          availability: 'available'
        }
      ]
    },
    user: { id: 'account-a', display_name: 'A', handle: null },
    sync_cursor: null,
    server_time: '2026-09-06T00:00:00.000Z',
    realtime: { transport: 'supabase_private_broadcast', topic: 'user:account-a:messaging:v1', event: 'sync_available' }
  })

  assert.deepEqual(parsed.groupCapabilities?.addressing, {
    enabled: true,
    mentionCardinality: 8,
    quoteLimit: 4_000,
    specialistMemberLimit: 4,
    specialistCatalog: [{ specialist: 'moon', displayName: 'Moon', avatar: '☾', roomSupported: true }]
  })
  assert.equal(parsed.groupCapabilities?.sharedAgents?.assistantCatalog[0]?.displayName, 'Marketing')
  assert.equal(
    parseDesktopSession({
      user: { id: 'account-a', display_name: 'A', handle: null },
      sync_cursor: null,
      server_time: '2026-09-06T00:00:00.000Z',
      realtime: {
        transport: 'supabase_private_broadcast',
        topic: 'user:account-a:messaging:v1',
        event: 'sync_available'
      }
    }).groupCapabilities,
    undefined
  )
})

test('a plane that omits the identity profile fields yields null, never a guess', () => {
  assert.deepEqual(
    parseDesktopSession({
      user: { id: 'account-a', display_name: 'A', handle: 'an-sen-1234' },
      sync_cursor: null,
      server_time: '2026-08-29T00:00:00.000Z',
      realtime: {
        transport: 'supabase_private_broadcast',
        topic: 'user:account-a:messaging:v1',
        event: 'sync_available'
      }
    }).user,
    {
      id: 'account-a',
      displayName: 'A',
      handle: 'an-sen-1234',
      avatarUrl: null,
      handleCustomized: null,
      nextHandleChangeAt: null
    }
  )
})

test('rejects an adopt response without the identity it asks the device to adopt', () => {
  assert.throws(
    () =>
      parseAssistantRegistrationResult({
        outcome: 'adopt',
        assistant: {
          id: 'row-1',
          identity_id: null,
          display_name: 'Trợ lý',
          avatar: '',
          is_default: true,
          lifecycle_revision: 1,
          status: 'active'
        }
      }),
    /invalid_response:assistant_registration\.assistant\.identity_id/
  )
})

test('carries the desktop-identity/1 profile fields and rejects a non-boolean customized flag', () => {
  const session = (user: Record<string, unknown>) => ({
    user,
    sync_cursor: null,
    server_time: '2026-08-29T00:00:00.000Z',
    realtime: { transport: 'supabase_private_broadcast', topic: 'user:account-a:messaging:v1', event: 'sync_available' }
  })

  assert.deepEqual(
    parseDesktopSession(
      session({
        id: 'account-a',
        display_name: 'A',
        handle: 'an-sen-1234',
        avatar_url: 'https://cdn.atum.test/a.png',
        handle_customized: false,
        next_handle_change_at: null
      })
    ).user,
    {
      id: 'account-a',
      displayName: 'A',
      handle: 'an-sen-1234',
      avatarUrl: 'https://cdn.atum.test/a.png',
      handleCustomized: false,
      nextHandleChangeAt: null
    }
  )
  assert.throws(
    () => parseDesktopSession(session({ id: 'account-a', display_name: 'A', handle: 'a', handle_customized: 'yes' })),
    /session\.user\.handle_customized/
  )
})

test('parses a message from the old plane, which omits the metadata key entirely', () => {
  assert.equal(parseCanonicalMessage(messageRow()).metadata, null)
})

test('parses the common post-G3 case: metadata present and JSON null', () => {
  assert.equal(parseCanonicalMessage(messageRow({ metadata: null })).metadata, null)
})

test('projects addressed-room identity and quote references without quote text', () => {
  assert.deepEqual(
    parseMessageMetadata({
      specialist_identity: { specialist: 'moon', display_name: 'Moon', avatar: '☾', private_token: 'drop' },
      quoted_message: { message_id: '00000000-0000-4000-8000-fbfe405ca65f', source_version: 2, text: 'drop' }
    }),
    {
      specialist_identity: { specialist: 'moon', display_name: 'Moon', avatar: '☾' },
      quoted_message: { message_id: '00000000-0000-4000-8000-fbfe405ca65f', source_version: 2 }
    }
  )
})

test('carries attachments through untouched for the renderer to normalize', () => {
  const attachment = {
    id: 'attachment-1',
    name: 'la-so.html',
    mime_type: 'text/html',
    size_bytes: 4096,
    url: 'https://deployment.example.invalid/resources/la-so.html'
  }

  assert.deepEqual(parseCanonicalMessage(messageRow({ attachments: [attachment] })).attachments, [attachment])
})

test('projects the authoritative G3 metadata groups verbatim', () => {
  const message = parseCanonicalMessage(
    messageRow({
      metadata: {
        specialist_dispatch: { state: 'running', specialist: 'moon' },
        andy_memory: { v: 1, outcome: 'supplied', used: true },
        provider_memory: { v: 1, outcome: 'granted_empty', used: false, memory_body: 'never cross' },
        agent_session: { session_id: 'session-9', request_id: 'request-3', state: 'open' }
      }
    })
  )

  assert.deepEqual(message.metadata, {
    agent_session: { request_id: 'request-3', session_id: 'session-9', state: 'open' },
    andy_memory: { outcome: 'supplied', used: true, v: 1 },
    provider_memory: { outcome: 'granted_empty', used: false, v: 1 },
    specialist_dispatch: { specialist: 'moon', state: 'running' }
  })
})

test('keeps error_code when the server sets it, and omits it when it does not', () => {
  const withCode = parseMessageMetadata({ specialist_dispatch: { state: 'failed', error_code: 'provider_timeout' } })
  const withoutCode = parseMessageMetadata({ specialist_dispatch: { state: 'failed' } })

  assert.deepEqual(withCode, { specialist_dispatch: { error_code: 'provider_timeout', state: 'failed' } })
  assert.deepEqual(withoutCode, { specialist_dispatch: { state: 'failed' } })
})

test('projects mention dispatch updates for existing source messages', () => {
  assert.deepEqual(
    parseMessageMetadata({
      mention_dispatch: {
        state: 'dead_lettered',
        error_code: 'allowance_exhausted',
        agent: 'binh-minh',
        revision: 0,
        secret_prompt: 'must not cross'
      }
    }),
    { mention_dispatch: { agent: 'binh-minh', error_code: 'allowance_exhausted', revision: 0, state: 'dead_lettered' } }
  )
})

test('projects bounded per-target dispatch snapshots and drops untrusted members', () => {
  assert.deepEqual(
    parseMessageMetadata({
      target_dispatches: [
        {
          target_type: 'assistant',
          target_id: 'assistant-1',
          display_name: 'Mai',
          avatar: '🌸',
          avatar_url: 'https://cdn.atum.test/mai.png',
          revision: 1,
          state: 'completed',
          job_id: 'job-1',
          owner_user_id: 'must-not-cross'
        }
      ]
    }),
    {
      target_dispatches: [
        {
          target_type: 'assistant',
          target_id: 'assistant-1',
          display_name: 'Mai',
          avatar: '🌸',
          avatar_url: 'https://cdn.atum.test/mai.png',
          revision: 1,
          state: 'completed',
          job_id: 'job-1'
        }
      ]
    }
  )
})

test('projects assistant photo snapshots only as bounded HTTPS URLs', () => {
  assert.deepEqual(
    parseMessageMetadata({
      assistant_identity: {
        id: 'assistant-1',
        display_name: 'Mai',
        avatar: '🌸',
        avatar_url: 'https://cdn.atum.test/mai.png',
        revision: 1
      }
    }),
    {
      assistant_identity: {
        id: 'assistant-1',
        display_name: 'Mai',
        avatar: '🌸',
        avatar_url: 'https://cdn.atum.test/mai.png',
        revision: 1
      }
    }
  )
  assert.deepEqual(
    parseMessageMetadata({
      assistant_identity: {
        id: 'assistant-1',
        avatar_url: 'http://cdn.atum.test/mai.png'
      }
    }),
    { assistant_identity: { id: 'assistant-1' } }
  )
})

test('drops unknown metadata groups and unknown members inside known groups', () => {
  const projected = parseMessageMetadata({
    andy_memory: { v: 1, outcome: 'granted_empty', memory_body: 'a memory that must never reach the app' },
    provider_memory: { v: 1, outcome: 'supplied', used: true, memory_body: 'another memory that must never reach the app' },
    billing: { plan: 'pro' },
    specialist_dispatch: { state: 'failed', job_id: 'job-1', attempts: 3 }
  })

  assert.deepEqual(projected, {
    andy_memory: { outcome: 'granted_empty', v: 1 },
    provider_memory: { outcome: 'supplied', used: true, v: 1 },
    specialist_dispatch: { state: 'failed' }
  })
})

test('drops non-scalar, oversized, and non-finite metadata values', () => {
  const projected = parseMessageMetadata({
    andy_memory: { outcome: { nested: 'object' }, v: Number.POSITIVE_INFINITY },
    specialist_dispatch: { specialist: 'x'.repeat(257), state: 'pending' }
  })

  assert.deepEqual(projected, { specialist_dispatch: { state: 'pending' } })
})

test('malformed metadata never fails the message and never reaches storage', () => {
  for (const metadata of ['not-an-object', 42, [], null, {}, { andy_memory: [] }, { specialist_dispatch: 'running' }]) {
    assert.equal(parseCanonicalMessage(messageRow({ metadata })).metadata, null, JSON.stringify(metadata))
  }
})

test('projects only strict URL-free artifact references', () => {
  const ref = {
    kind: 'artifact',
    resource_id: 'moon.laso:42',
    type: 'reading',
    title: 'Lá số',
    status: 'ready',
    presentation: { intent: 'open' }
  }

  assert.deepEqual(parseMessageMetadata({ resource_refs: [ref] }), { resource_refs: [ref] })
  assert.equal(parseMessageMetadata({ resource_refs: [{ ...ref, url: 'https://evil.test' }] }), null)
  assert.equal(parseMessageMetadata({ resource_refs: [{ ...ref, resource_id: '../secret' }] }), null)
  assert.equal(parseMessageMetadata({ resource_refs: [ref, ref] }), null)
})

test('projects an artifact response without leaking provider authority fields', () => {
  assert.deepEqual(
    parseArtifactResponse({
      artifact: {
        artifact_id: 'moon.laso:42',
        type: 'reading',
        title: 'Lá số',
        url: 'https://moon.test/artifact/42',
        status: 'ready',
        user_id: 'must-not-cross',
        cookie: 'must-not-cross',
        path: '/private',
        embed: {
          url: 'https://moon.test/atum/embed/42',
          kind: 'reading',
          expires_at: '2026-08-24T10:00:00Z',
          token: 'drop'
        }
      }
    }),
    {
      artifactId: 'moon.laso:42',
      type: 'reading',
      title: 'Lá số',
      url: 'https://moon.test/artifact/42',
      status: 'ready',
      embed: { url: 'https://moon.test/atum/embed/42', kind: 'interactive_view', expiresAt: '2026-08-24T10:00:00Z' }
    }
  )
})
