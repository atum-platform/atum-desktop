import { describe, expect, it } from 'vitest'

import invalidatedFixture from '../../contracts/atum-cloud-data-v1/fixtures/retrieval-invalidated-source.response.json'
import retrievalFixture from '../../contracts/atum-cloud-data-v1/fixtures/retrieval-thread.response.json'
import pinnedDigest from '../../contracts/atum-cloud-data-v1/PINNED-SHA256?raw'

import { parsePersonalRetrievalBundle, type PersonalRetrievalExpectation } from './atum-cloud-data-retrieval'

const THREAD_SCOPE = { id: '00000000-0000-4000-8000-95eb2692c90e', kind: 'p2p_thread' } as const
const SUBJECT = 'account-subject-a'

const expectation: PersonalRetrievalExpectation = {
  activeSubject: SUBJECT,
  boundSubject: SUBJECT,
  maxContentUtf8Bytes: 32_768,
  maxItems: 20,
  minimumSourceGenerations: {
    '00000000-0000-4000-8000-576f18824476': 2
  },
  scope: THREAD_SCOPE
}

function validPersonalBundle(): Record<string, unknown> {
  return { ...structuredClone(retrievalFixture), agent_class: 'personal' }
}

function validDerivedBundle(): Record<string, unknown> {
  const value = validPersonalBundle()
  const item = structuredClone(retrievalFixture.items[0]) as unknown as Record<string, unknown>

  item.source = {
    generation: 1,
    lifecycle: 'active',
    occurred_at: retrievalFixture.items[0].source.occurred_at,
    record_id: 'memory-fact-1',
    record_kind: 'memory_fact',
    revision: 1,
    source_refs: [
      {
        generation: 2,
        record_id: retrievalFixture.items[0].source.record_id,
        revision: 2
      }
    ]
  }
  item.provenance = { recorded_at: retrievalFixture.items[0].provenance.recorded_at, source_kind: 'derived' }
  value.items = [item]

  return value
}

function rejectedCode(value: unknown, binding: PersonalRetrievalExpectation = expectation): string | undefined {
  const result = parsePersonalRetrievalBundle(value, binding)

  return result.ok ? undefined : result.code
}

describe('atum.cloud-data/1 personal retrieval boundary', () => {
  it('pins the exact frozen S7 contract pack digest', () => {
    expect(pinnedDigest.trim()).toBe('a60db7e4645fd795d1b97e3f8deb580ecb4bdb42dd38b054e9182f72accfec67')
  })

  it('accepts a valid personal bundle derived from the frozen one-scope fixture', () => {
    const result = parsePersonalRetrievalBundle(validPersonalBundle(), expectation)

    expect(result).toEqual({
      bundle: {
        agentClass: 'personal',
        bundleId: retrievalFixture.bundle_id,
        contentUtf8Bytes: retrievalFixture.content_utf8_bytes,
        contract: 'atum.cloud-data/1',
        createdAt: retrievalFixture.created_at,
        fresh: true,
        items: [
          {
            content: retrievalFixture.items[0].content,
            itemId: retrievalFixture.items[0].item_id,
            provenance: {
              recordedAt: retrievalFixture.items[0].provenance.recorded_at,
              sourceKind: 'message'
            },
            source: {
              generation: 2,
              lifecycle: 'active',
              occurredAt: retrievalFixture.items[0].source.occurred_at,
              recordId: retrievalFixture.items[0].source.record_id,
              recordKind: 'message',
              revision: 2
            },
            untrustedInput: true
          }
        ],
        scope: THREAD_SCOPE,
        sourceWatermark: retrievalFixture.source_watermark,
        truncated: false
      },
      ok: true
    })
  })

  it('rejects wrong versions and non-personal agent classes', () => {
    expect(rejectedCode({ ...validPersonalBundle(), contract: 'atum.cloud-data/2' })).toBe('unsupported_contract')
    expect(rejectedCode(retrievalFixture)).toBe('agent_class_mismatch')
  })

  it('rejects a response after the active account subject changes', () => {
    expect(rejectedCode(validPersonalBundle(), { ...expectation, activeSubject: 'account-subject-b' })).toBe(
      'subject_mismatch'
    )
  })

  it('rejects a scope other than the one captured by the trusted request', () => {
    const value = {
      ...validPersonalBundle(),
      scope: { id: '00000000-0000-4000-8000-676a3a34ff0f', kind: 'app_thread' }
    }

    expect(rejectedCode(value)).toBe('scope_mismatch')
  })

  it('rejects a source older than the caller generation floor', () => {
    expect(
      rejectedCode(validPersonalBundle(), {
        ...expectation,
        minimumSourceGenerations: { '00000000-0000-4000-8000-576f18824476': 3 }
      })
    ).toBe('stale_generation')
  })

  it('accepts bounded derived lineage and rejects a stale source reference', () => {
    expect(parsePersonalRetrievalBundle(validDerivedBundle(), expectation).ok).toBe(true)
    expect(
      rejectedCode(validDerivedBundle(), {
        ...expectation,
        minimumSourceGenerations: { [retrievalFixture.items[0].source.record_id]: 3 }
      })
    ).toBe('stale_generation')
  })

  it('rejects missing, empty, malformed, or over-limit derived lineage', () => {
    const missing = validDerivedBundle()
    const empty = validDerivedBundle()
    const malformed = validDerivedBundle()
    const overLimit = validDerivedBundle()

    const sourceOf = (value: Record<string, unknown>) =>
      (value.items as Array<Record<string, unknown>>)[0].source as Record<string, unknown>

    delete sourceOf(missing).source_refs
    sourceOf(empty).source_refs = []
    sourceOf(malformed).source_refs = [{ generation: 2, record_id: 'source-1' }]
    sourceOf(overLimit).source_refs = Array.from({ length: 17 }, (_, index) => ({
      generation: 2,
      record_id: `source-${index}`,
      revision: 2
    }))

    expect(rejectedCode(missing)).toBe('malformed_bundle')
    expect(rejectedCode(empty)).toBe('invalidated_provenance')
    expect(rejectedCode(malformed)).toBe('invalidated_provenance')
    expect(rejectedCode(overLimit)).toBe('invalidated_provenance')
  })

  it('rejects fresh=false even when every source remains active', () => {
    expect(rejectedCode({ ...validPersonalBundle(), fresh: false })).toBe('stale_bundle')
  })

  it('rejects the frozen invalidated-source fixture before exposing content', () => {
    const value = { ...structuredClone(invalidatedFixture), agent_class: 'personal' }

    const binding: PersonalRetrievalExpectation = {
      ...expectation,
      maxContentUtf8Bytes: 65_536,
      maxItems: 50,
      minimumSourceGenerations: {},
      scope: { ...invalidatedFixture.scope, kind: 'app_thread' as const }
    }

    expect(rejectedCode(value, binding)).toBe('stale_bundle')

    const activeBundleWithInvalidatedSource = validDerivedBundle()

    const items = activeBundleWithInvalidatedSource.items as Array<Record<string, unknown>>

    ;(items[0].source as Record<string, unknown>).lifecycle = 'invalidated'

    expect(rejectedCode(activeBundleWithInvalidatedSource)).toBe('invalidated_provenance')
  })

  it('rejects malformed artifact items', () => {
    const value = validPersonalBundle()
    const item = structuredClone(retrievalFixture.items[0]) as unknown as Record<string, unknown>
    item.source = {
      generation: 2,
      lifecycle: 'active',
      record_id: 'artifact-1',
      record_kind: 'artifact',
      revision: 1
    }
    item.provenance = { recorded_at: '2026-08-30T12:00:01Z', source_kind: 'artifact' }
    value.items = [item]

    expect(rejectedCode(value)).toBe('malformed_bundle')
  })

  it.each([
    ['bundle', (value: Record<string, unknown>) => Object.assign(value, { account_id: 'forged' })],
    [
      'scope',
      (value: Record<string, unknown>) => {
        value.scope = { ...THREAD_SCOPE, grant: 'all_memory' }
      }
    ],
    [
      'item',
      (value: Record<string, unknown>) => {
        const items = value.items as Array<Record<string, unknown>>
        items[0].tool_authority = 'forged'
      }
    ],
    [
      'source',
      (value: Record<string, unknown>) => {
        const items = value.items as Array<Record<string, unknown>>

        ;(items[0].source as Record<string, unknown>).storage_path = 'private/object'
      }
    ],
    [
      'provenance',
      (value: Record<string, unknown>) => {
        const items = value.items as Array<Record<string, unknown>>

        ;(items[0].provenance as Record<string, unknown>).verified = true
      }
    ]
  ])('rejects unknown %s fields', (_level, mutate) => {
    const value = validPersonalBundle()
    mutate(value)
    expect(rejectedCode(value)).toBe('malformed_bundle')
  })

  it('enforces the caller item/byte budgets and the declared byte count', () => {
    expect(rejectedCode(validPersonalBundle(), { ...expectation, maxItems: 0 })).toBe('invalid_binding')
    expect(rejectedCode(validPersonalBundle(), { ...expectation, maxContentUtf8Bytes: 8 })).toBe('malformed_bundle')
    expect(rejectedCode({ ...validPersonalBundle(), content_utf8_bytes: 999 })).toBe('malformed_bundle')
  })

  it('accepts a bounded truncated bundle and preserves the incomplete-result signal', () => {
    const result = parsePersonalRetrievalBundle({ ...validPersonalBundle(), truncated: true }, expectation)

    expect(result.ok && result.bundle.truncated).toBe(true)
  })

  it('rejects trusted binding values outside the frozen contract ceilings', () => {
    expect(rejectedCode(validPersonalBundle(), { ...expectation, maxItems: 51 })).toBe('invalid_binding')
    expect(rejectedCode(validPersonalBundle(), { ...expectation, maxContentUtf8Bytes: 65_537 })).toBe('invalid_binding')
    expect(
      rejectedCode(validPersonalBundle(), {
        ...expectation,
        minimumSourceGenerations: { [retrievalFixture.items[0].source.record_id]: 0 }
      })
    ).toBe('invalid_binding')
  })
})
