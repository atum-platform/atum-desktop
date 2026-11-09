import { describe, expect, it } from 'vitest'

import { type AwarenessView, canOpenAwarenessCitation, selectAwarenessView } from './model'
import type { AwarenessCoverageState, AwarenessData, AwarenessEvidence, AwarenessSnapshot } from './types'

const now = 1_000

function evidence(evidenceId: string, expiresAt?: number): AwarenessEvidence {
  return {
    evidenceId,
    sourceKind: 'assistant_chat',
    sourceLabel: 'Atum',
    content: evidenceId,
    epistemic: 'statement',
    eventTime: 500,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    citation: { kind: 'matrix_event', roomId: '!room:example', eventId: `$${evidenceId}` }
  }
}

function snapshot(overrides: Partial<AwarenessSnapshot> = {}): AwarenessSnapshot {
  return {
    scopeKey: 'account-a/profile-a/private-owner/1',
    snapshotId: 'snapshot-1',
    audience: 'private_owner',
    status: 'ok',
    freshness: 'current',
    sources: [
      {
        key: 'chat',
        kind: 'assistant_chat',
        label: 'Atum chat',
        state: 'ready',
        reasons: [],
        asOf: 900
      }
    ],
    evidence: [evidence('current')],
    ...overrides
  }
}

function readySnapshot(view: AwarenessView): AwarenessSnapshot {
  if (view.state !== 'ready') {
    throw new Error(`Expected ready view, received ${view.state}`)
  }

  return view.snapshot
}

describe('selectAwarenessView', () => {
  it('passes through loading and unavailable without inventing a snapshot', () => {
    expect(selectAwarenessView('scope', { state: 'loading' }, now)).toEqual({ state: 'loading' })
    expect(selectAwarenessView('scope', { state: 'unavailable' }, now)).toEqual({ state: 'unavailable' })
  })

  it.each([
    { currentScopeKey: 'another-scope', snapshotScopeKey: 'scope' },
    { currentScopeKey: null, snapshotScopeKey: 'scope' },
    { currentScopeKey: '   ', snapshotScopeKey: 'scope' },
    { currentScopeKey: 'scope', snapshotScopeKey: '   ' }
  ])('does not retain a snapshot outside the current private scope', ({ currentScopeKey, snapshotScopeKey }) => {
    const data: AwarenessData = { state: 'ready', snapshot: snapshot({ scopeKey: snapshotScopeKey }) }

    expect(selectAwarenessView(currentScopeKey, data, now)).toEqual({ state: 'unavailable' })
  })

  it('does not retain a snapshot with a non-private audience', () => {
    const nonPrivateSnapshot = { ...snapshot(), audience: 'shared' } as unknown as AwarenessSnapshot

    expect(
      selectAwarenessView(nonPrivateSnapshot.scopeKey, { state: 'ready', snapshot: nonPrivateSnapshot }, now)
    ).toEqual({
      state: 'unavailable'
    })
  })

  it.each(['ok', 'degraded'] as const)('keeps non-expired evidence for a %s snapshot', status => {
    const current = evidence('current', now + 1)
    const expired = evidence('expired', now)
    const source = snapshot().sources[0]!

    const data: AwarenessData = {
      state: 'ready',
      snapshot: snapshot({ status, sources: [source], evidence: [current, expired] })
    }

    const selected = readySnapshot(selectAwarenessView(data.snapshot.scopeKey, data, now))

    expect(selected.sources).toBe(data.snapshot.sources)
    expect(selected.evidence).toEqual([current])
  })

  it('keeps authorized coverage and reasons for an unavailable snapshot while exposing no evidence', () => {
    const coverageStates: readonly AwarenessCoverageState[] = [
      'ready',
      'catching_up',
      'partial',
      'offline',
      'excluded',
      'needs_keys',
      'paused',
      'error'
    ]

    const sources = coverageStates.map((state, index) => ({
      key: `source-${state}`,
      kind: 'assistant_chat' as const,
      state,
      reasons: [index % 2 === 0 ? ('service_unavailable' as const) : ('owner_paused' as const)],
      asOf: 900
    }))

    const data: AwarenessData = {
      state: 'ready',
      snapshot: snapshot({ status: 'unavailable', sources, evidence: [evidence('withheld')] })
    }

    const selected = readySnapshot(selectAwarenessView(data.snapshot.scopeKey, data, now))

    expect(selected.status).toBe('unavailable')
    expect(selected.sources).toBe(data.snapshot.sources)
    expect(selected.sources.map(source => source.reasons)).toEqual(data.snapshot.sources.map(source => source.reasons))
    expect(selected.evidence).toEqual([])
  })

  it('filters evidence at the expiry boundary without mutating the frozen-v1 input', () => {
    const live = evidence('live', now + 1)
    const atBoundary = evidence('at-boundary', now)
    const old = evidence('old', now - 1)
    const input = snapshot({ evidence: Object.freeze([live, atBoundary, old]) })
    const frozenInput = Object.freeze(input)
    const data: AwarenessData = { state: 'ready', snapshot: frozenInput }

    const selected = readySnapshot(selectAwarenessView(frozenInput.scopeKey, data, now))

    expect(selected).not.toBe(frozenInput)
    expect(selected.evidence).toEqual([live])
    expect(frozenInput.evidence).toEqual([live, atBoundary, old])
  })
})

describe('canOpenAwarenessCitation', () => {
  it('opens only the exact current evidence object in a current, usable snapshot', () => {
    const current = evidence('evidence-1')
    const usable = snapshot({ evidence: [current] })
    const replacement = { ...current, content: 'replacement revision' }

    expect(canOpenAwarenessCitation(usable, current, now)).toBe(true)
    expect(canOpenAwarenessCitation(snapshot({ evidence: [replacement] }), current, now)).toBe(false)
  })

  it.each(['stale', 'unavailable', 'expired'] as const)('rejects current evidence when %s', condition => {
    const candidate = evidence('current', condition === 'expired' ? now : undefined)

    const currentSnapshot = snapshot({
      evidence: [candidate],
      freshness: condition === 'stale' ? 'stale' : 'current',
      status: condition === 'unavailable' ? 'unavailable' : 'ok'
    })

    expect(canOpenAwarenessCitation(currentSnapshot, candidate, now)).toBe(false)
  })

  it('rejects evidence absent from the current snapshot', () => {
    expect(canOpenAwarenessCitation(snapshot(), evidence('other'), now)).toBe(false)
  })

  it('does not mutate the snapshot while rejecting stale or expired citations', () => {
    const expired = evidence('expired', now)
    const stale = snapshot({ freshness: 'stale', evidence: [expired] })

    expect(canOpenAwarenessCitation(stale, expired, now)).toBe(false)
    expect(stale).toEqual(snapshot({ freshness: 'stale', evidence: [expired] }))
  })
})
