import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test } from 'vitest'

import { parseSocialLookupResponse, parseSocialMutationResponse, parseSocialSyncResponse } from './social'

const fixtureRoot = join(import.meta.dirname, 'fixtures/social-v1')
const flow = JSON.parse(readFileSync(join(fixtureRoot, 's5-social-flow.json'), 'utf8'))
const unavailable = JSON.parse(readFileSync(join(fixtureRoot, 'lookup-unavailable.response.json'), 'utf8'))

test('parses the frozen s5.1 lookup fixture without widening the provider shape', () => {
  const parsed = parseSocialLookupResponse(flow.steps[0].response)
  assert.equal(parsed.accountEpoch, flow.accounts.alice_epoch)
  assert.equal(parsed.projection.availability, 'available')
  assert.equal(parsed.projection.canMessage, false)
  assert.equal(parsed.projection.directThreadId, null)
})

test('collapses unavailable lookup to the one neutral non-enumerating result', () => {
  assert.deepEqual(parseSocialLookupResponse(unavailable).projection, {
    availability: 'unavailable', profile: null, state: 'unavailable', version: 0,
    canMessage: false, directThreadId: null
  })
  assert.throws(
    () => parseSocialLookupResponse({ ...unavailable, reason: 'blocked' }),
    /lookup\.fields/
  )
})

test('rejects malformed, cross-scope, and internally inconsistent projections', () => {
  const response = structuredClone(flow.steps[0].response)
  response.projection.can_message = true
  assert.throws(() => parseSocialLookupResponse(response), /can_message/)

  const mutation = {
    account_epoch: flow.accounts.alice_epoch,
    operation_id: flow.steps[1].operation_id,
    replayed: false,
    projection: { ...flow.steps[0].response.projection, state: 'connected', version: 2, can_message: true,
      direct_thread_id: flow.steps[2].direct_thread_id }
  }

  assert.equal(parseSocialMutationResponse(mutation).projection.canMessage, true)
  assert.throws(() => parseSocialMutationResponse({ ...mutation, operation_id: 'wrong' }), /operation_id/)

  assert.throws(() => parseSocialSyncResponse({ account_epoch: flow.accounts.alice_epoch, changes: [
    { change_id: '2', projection: mutation.projection }, { change_id: '1', projection: mutation.projection }
  ], next_cursor: 'cursor', has_more: false }), /change_order/)
})
