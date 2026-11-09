import assert from 'node:assert/strict'

import { test } from 'vitest'

import { parseAdvisorySearchResult } from './atum-advisory-search'

const ROOM = '00000000-0000-4000-8000-f6222a1106ee'
const MESSAGE = '00000000-0000-4000-8000-f1d11edf5c5c'
const REFERENCE = 'atum-advisory:eyJ2IjoxfQ'

test('advisory source parser retains only the bounded frozen wire shape', () => {
  assert.deepEqual(
    parseAdvisorySearchResult({
      status: 'ok',
      results: [
        {
          session_id: REFERENCE,
          conversation_id: ROOM,
          title: 'Moving',
          audience_revision: 1,
          context_revision: 2,
          messages: [
            {
              id: MESSAGE,
              version: 1,
              created_at: '2026-09-01T00:00:00Z',
              speaker: { kind: 'specialist', id: 'moon' },
              text: '',
              truncated: false
            }
          ]
        }
      ],
      next_reference: null,
      previous_reference: null,
      ignored: 'never reaches Hermes'
    }),
    {
      status: 'ok',
      results: [
        {
          session_id: REFERENCE,
          conversation_id: ROOM,
          title: 'Moving',
          audience_revision: 1,
          context_revision: 2,
          messages: [
            {
              id: MESSAGE,
              version: 1,
              created_at: '2026-09-01T00:00:00Z',
              speaker: { kind: 'specialist', id: 'moon' },
              text: ''
            }
          ]
        }
      ],
      next_reference: null,
      previous_reference: null
    }
  )
})

test('advisory source parser fails closed for oversized or malformed source results', () => {
  const unavailable = { status: 'unavailable', results: [], next_reference: null, previous_reference: null }

  assert.deepEqual(parseAdvisorySearchResult({ status: 'denied', results: [] }), {
    status: 'denied',
    results: [],
    next_reference: null,
    previous_reference: null
  })
  assert.deepEqual(
    parseAdvisorySearchResult({
      status: 'ok',
      results: [],
      next_reference: null,
      previous_reference: null,
      padding: 'x'.repeat(6_100)
    }),
    unavailable
  )
})


test('advisory evidence accepts the same UUID versions as the platform API', () => {
  for (let version = 1; version <= 8; version++) {
    const id = `44444444-4444-${version}444-8444-444444444444`
    const response = parseAdvisorySearchResult({
      status: 'ok', results: [{session_id: REFERENCE, conversation_id: ROOM,
        title: null, audience_revision: 1, context_revision: 1,
        messages: [{id, version: 1, created_at: '2026-09-01T00:00:00Z',
          speaker: {kind: 'owner', id: ROOM}, text: 'Owner confirmed October.'}]}]
    })
    assert.equal(response.status, 'ok')
    assert.equal(response.results[0]?.messages[0]?.id, id)
  }
})
