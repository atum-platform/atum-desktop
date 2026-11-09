import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { test } from 'vitest'

import { parseGroupCapabilities, parseGroupDetail, parseGroupRoom } from './group-wire'
import { parseConversation, parseSyncPage } from './wire'

const fixture = JSON.parse(
  readFileSync(new URL('../../../../spec/group-conversations/v1/fixtures.json', import.meta.url), 'utf8')
)

const addressingFixture = JSON.parse(
  readFileSync(new URL('../../../../spec/group-specialists/v1/fixtures.json', import.meta.url), 'utf8')
)

test('preserves the server group identity, current roster and event projection', () => {
  const parsed = parseConversation(fixture.conversation)
  assert.equal(parsed.kind, 'group')
  assert.equal(parsed.title, fixture.conversation.title)
  assert.deepEqual(
    parsed.participantIds,
    parsed.group?.members.map(member => member.userId)
  )
  const detail = parseGroupDetail(fixture.detail, parsed.id)
  assert.deepEqual(detail.room, parsed.group)
  assert.equal(detail.events[0].kind, 'created')
})

test('unknown room kind is unsupported even without legacy participants', () => {
  const parsed = parseConversation(fixture.unknown_conversation)
  assert.equal(parsed.kind, 'unsupported')
  assert.deepEqual(parsed.participantIds, [])
  assert.equal(parsed.group, undefined)
})

test('only an absent legacy kind uses the old specialist/direct compatibility path', () => {
  const legacy = { ...fixture.conversation, group: undefined, kind: undefined }
  assert.equal(parseConversation(legacy).kind, 'direct')
  assert.equal(parseConversation({ ...legacy, specialist: 'moon' }).kind, 'specialist')
  assert.equal(parseConversation({ ...legacy, kind: null }).kind, 'unsupported')
})

test('capability absence is compatible, while malformed supported capability is an error', () => {
  assert.equal(parseGroupCapabilities(undefined).available, false)
  assert.equal(parseGroupCapabilities({ contract: 'atum.group-conversations/2' }).available, false)
  assert.equal(parseGroupCapabilities(fixture.capability).creationEnabled, true)
  assert.equal(parseGroupCapabilities(fixture.capability).createDefaults, undefined)
  assert.equal(parseGroupCapabilities({ ...fixture.capability, create_defaults: true }).createDefaults, true)
  assert.equal(parseGroupCapabilities({ ...fixture.capability, create_defaults: 'true' }).createDefaults, undefined)
  assert.throws(() => parseGroupCapabilities({ ...fixture.capability, creation_enabled: 'true' }))
})

test('negotiates the addressing capability and parses public specialist projections', () => {
  const capabilities = parseGroupCapabilities(fixture.capability, addressingFixture.capabilities)
  assert.deepEqual(capabilities.addressing, {
    enabled: true,
    mentionCardinality: 8,
    quoteLimit: 4_000,
    specialistMemberLimit: 4,
    specialistCatalog: [{ specialist: 'moon', displayName: 'Moon', avatar: '☾', roomSupported: true }]
  })

  const detail = parseGroupDetail(
    {
      ...fixture.detail,
      group: { ...fixture.detail.group, specialists: [addressingFixture.specialist] },
      specialist_catalog: addressingFixture.specialist_catalog
    },
    fixture.conversation.id
  )

  assert.deepEqual(detail.room.specialists, [
    {
      specialist: 'moon',
      displayName: 'Moon',
      avatar: '☾',
      membershipEpoch: 1,
      availability: 'available'
    }
  ])
  assert.deepEqual(detail.specialistCatalog, [
    { specialist: 'moon', displayName: 'Moon', avatar: '☾', roomSupported: true }
  ])
  assert.throws(
    () => parseGroupCapabilities(fixture.capability, { ...addressingFixture.capabilities, quote_limit: 4_001 }),
    /addressing_capabilities/
  )
})

test('negotiates approved shared agents without accepting owner or context-mode ambiguities', () => {
  const group = fixture.capability

  const sharedAgents = {
    contract: 'atum.group-shared-agents/1',
    enabled: true,
    assistant_member_limit: 4,
    own_assistant_only: true,
    assistant_catalog: [
      {
        assistant_id: '00000000-0000-4000-8000-576f18824476',
        display_name: 'Marketing',
        avatar_url: 'https://cdn.atum.test/marketing.png',
        owner_user_id: '00000000-0000-4000-8000-4b2f94c54b02',
        owner_display_name: 'Minh',
        membership_epoch: 1,
        availability: 'available',
        persona: 'must not cross this boundary'
      }
    ]
  }

  assert.deepEqual(parseGroupCapabilities(group, undefined, undefined, sharedAgents).sharedAgents, {
    enabled: true,
    assistantMemberLimit: 4,
    ownAssistantOnly: true,
    assistantCatalog: [
      {
        assistantId: '00000000-0000-4000-8000-576f18824476',
        displayName: 'Marketing',
        avatarUrl: 'https://cdn.atum.test/marketing.png',
        ownerUserId: '00000000-0000-4000-8000-4b2f94c54b02',
        ownerDisplayName: 'Minh',
        membershipEpoch: 1,
        availability: 'available'
      }
    ]
  })

  assert.throws(
    () =>
      parseGroupCapabilities(group, undefined, undefined, {
        ...sharedAgents,
        assistant_catalog: [{ ...sharedAgents.assistant_catalog[0], owner_user_id: 'not-an-id' }]
      }),
    /owner_user_id/
  )

  const room = {
    ...fixture.conversation.group,
    context_mode: 'shared_group',
    assistants: sharedAgents.assistant_catalog
  }

  assert.equal(parseGroupRoom(room, room.conversation_id).contextMode, 'shared_group')
  assert.equal(
    parseGroupRoom(room, room.conversation_id).assistants?.[0]?.assistantId,
    sharedAgents.assistant_catalog[0]?.assistant_id
  )
  assert.throws(() => parseGroupRoom({ ...room, context_mode: 'unknown_mode' }, room.conversation_id), /context_mode/)
})

test('group room scope, duplicate membership and owner invariants are checked', () => {
  const row = fixture.conversation.group
  assert.throws(() => parseGroupRoom(row, fixture.detail.events[0].id), /conversation_scope/)
  assert.throws(
    () => parseGroupRoom({ ...row, members: [row.members[0], row.members[0]] }, row.conversation_id),
    /duplicate_members/
  )
  assert.throws(() => parseGroupRoom({ ...row, members: row.members.slice(1) }, row.conversation_id), /owner/)
  assert.throws(() => parseGroupRoom({ ...row, membership_epoch: 0 }, row.conversation_id), /membership_epoch/)
  assert.throws(
    () =>
      parseGroupDetail(
        { ...fixture.detail, events: [{ ...fixture.detail.events[0], conversation_id: fixture.detail.events[0].id }] },
        row.conversation_id
      ),
    /conversation_scope/
  )
})

test('membership events and content-free conversation deletion survive sync parsing', () => {
  const parsed = parseSyncPage({
    changes: [
      fixture.removal_change,
      {
        ...fixture.removal_change,
        change_id: '6',
        entity: 'membership_event',
        operation: 'upsert',
        entity_id: fixture.detail.events[0].id,
        value: fixture.detail.events[0]
      }
    ],
    next_cursor: 'next-page',
    has_more: false,
    server_time: fixture.removal_change.occurred_at
  })

  assert.equal(parsed.changes[0].operation, 'delete')
  assert.equal(parsed.changes[0].value, null)
  assert.equal(parsed.changes[1].entity, 'membership_event')
})
