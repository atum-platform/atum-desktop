import { describe, expect, it } from 'vitest'

import {
  AGENT_SWEEP_MIGRATION_V11,
  AGENT_SWEEP_PACK_V11_PIN,
  AGENT_SWEEP_PROFILE_V11,
  AGENT_SWEEP_PROTOCOL_VERSION_V11,
  AGENT_SWEEP_V11_LIMITS,
  parseAgentSweepClaimResponseV11,
  parseAgentSweepDispatchResponseV11,
  parseAgentSweepReleaseRequestV11,
  parseAgentSweepReleaseResponseV11,
  parseAgentSweepSettleRequestV11,
  parseAgentSweepSettlementResponseV11,
  parseAnyAgentSweepClaimResponse
} from '../agent-sweep-v1.1'
import { parseAgentSweepClaimResponse } from '../agent-sweep'
import { AGENT_SWEEP_V11_PACK } from '../contract-packs'
import { machineViolations, messageViolations } from '../schema'
import { fixtureEntries, readFixture } from './fixtures'

describe('the vendored agent-sweep v1.1 warm-up contract', () => {
  it('retains the additive release, migration and warm-up slice', () => {
    expect(AGENT_SWEEP_PROFILE_V11).toBe('atum.agent-sweep/1.1')
    expect(AGENT_SWEEP_PROTOCOL_VERSION_V11).toBe('0.7.52')
    expect(AGENT_SWEEP_MIGRATION_V11).toBe('0328')
    expect(AGENT_SWEEP_PACK_V11_PIN).toMatch(/^[a-f0-9]{64}$/u)
    expect(AGENT_SWEEP_V11_LIMITS).toMatchObject({
      warmupOffsetsMs: [300_000, 900_000, 2_100_000, 3_600_000],
      warmupActiveComputeSeconds: 1_800,
      warmupReleaseLimit: 2,
      warmupReleaseBackoffMs: 120_000
    })
  })

  // The pack is complete now: every declared fixture validates directly against it, with the
  // declared violation category for each refusal, exactly like the platform reference checker.
  for (const entry of fixtureEntries('agent-sweep-v1.1')) {
    it(`${entry.expect}: ${entry.file}`, () => {
      const value = readFixture('agent-sweep-v1.1', entry.file)
      const violations = entry.machine !== undefined
        ? machineViolations(AGENT_SWEEP_V11_PACK.state_machines![entry.machine]!, value.steps)
        : messageViolations(AGENT_SWEEP_V11_PACK, entry.message!, value)
      if (entry.expect === 'accept') expect(violations).toEqual([])
      else expect(violations.map(violation => violation.category)).toContain(entry.violation)
    })
  }

  it('parses the warm-up claim, dispatch, settle and settlement fixtures', () => {
    expect(parseAgentSweepClaimResponseV11(readFixture('agent-sweep-v1.1', 'fixtures/claim.warmup.json')))
      .toMatchObject({ occurrenceKind: 'warmup_nudge', warmupNudgeIndex: 1, effectiveDueAt: 1793017200000 })
    expect(parseAgentSweepDispatchResponseV11(readFixture('agent-sweep-v1.1', 'fixtures/dispatch.warmup.json')))
      .toMatchObject({ authorization: { kind: 'cloud', budget: { computeSeconds: 1_800 } } })
    const settle = parseAgentSweepSettleRequestV11(readFixture('agent-sweep-v1.1', 'fixtures/settle.warmup-offer.json'))
    expect(settle.disposition).toBe('offer')
    if (settle.disposition === 'offer') expect(settle.findingHashes).toEqual([])
    expect(parseAgentSweepSettlementResponseV11(readFixture('agent-sweep-v1.1', 'fixtures/settlement.warmup-offer.json')))
      .toMatchObject({ occurrenceKind: 'warmup_nudge', warmupNudgeIndex: 1, publication: { state: 'admitted' } })
  })

  it('parses the release request and both release decisions', () => {
    expect(parseAgentSweepReleaseRequestV11(readFixture('agent-sweep-v1.1', 'fixtures/release.request.json')))
      .toMatchObject({ operation: 'release', reason: 'invalid_result', usage: { modelAttempts: 1 } })
    expect(parseAgentSweepReleaseResponseV11(readFixture('agent-sweep-v1.1', 'fixtures/release.released.json')))
      .toMatchObject({ decision: 'released', releaseCount: 1, retryAt: 1793017920000 })
    expect(parseAgentSweepReleaseResponseV11(readFixture('agent-sweep-v1.1', 'fixtures/release.retired.json')))
      .toMatchObject({ decision: 'retired', releaseCount: 2, disposition: 'none', publication: { state: 'none' } })
  })

  it('refuses a release for anything but the 1.1 nudge profile', () => {
    const release = readFixture('agent-sweep-v1.1', 'fixtures/release.request.json')
    expect(() => parseAgentSweepReleaseRequestV11({ ...release, profile: 'atum.agent-sweep/1' }))
      .toThrow('agent_sweep_v11_invalid')
    expect(() => parseAgentSweepReleaseRequestV11({ ...release, reason: 'mystery' }))
      .toThrow('agent_sweep_v11_invalid')
    expect(() => parseAgentSweepReleaseRequestV11({ ...release, usage: { ...release.usage, modelAttempts: 0 } }))
      .toThrow('agent_sweep_v11_invalid')
  })

  it('requires effectiveDueAt to equal occurrenceAt and ties index to kind', () => {
    const normal = readFixture('agent-sweep-v1.1', 'fixtures/claim.normal.json')
    expect(() => parseAgentSweepClaimResponseV11({ ...normal, effectiveDueAt: normal.occurrenceAt + 1 }))
      .toThrow('agent_sweep_v11_invalid')
    expect(() => parseAgentSweepClaimResponseV11({ ...normal, warmupNudgeIndex: 1 }))
      .toThrow('agent_sweep_v11_invalid')

    const warmup = readFixture('agent-sweep-v1.1', 'fixtures/claim.warmup.json')
    const { warmupNudgeIndex: _index, ...withoutIndex } = warmup
    expect(() => parseAgentSweepClaimResponseV11(withoutIndex)).toThrow('agent_sweep_v11_invalid')
    expect(() => parseAgentSweepClaimResponseV11({ ...warmup, warmupNudgeIndex: 5 }))
      .toThrow('agent_sweep_v11_invalid')
  })

  it('ties warm-up identity to the 1,800-second dispatch budget', () => {
    const dispatch = readFixture('agent-sweep-v1.1', 'fixtures/dispatch.warmup.json')
    expect(() => parseAgentSweepDispatchResponseV11({
      ...dispatch,
      authorization: { ...dispatch.authorization, budget: { ...dispatch.authorization.budget, computeSeconds: 120 } }
    })).toThrow('agent_sweep_v11_invalid')
    expect(() => parseAgentSweepDispatchResponseV11({ ...dispatch, warmupNudgeIndex: null }))
      .toThrow('agent_sweep_v11_invalid')
  })

  it('accepts an evidence-free warm-up offer but still refuses widening', () => {
    const settle = readFixture('agent-sweep-v1.1', 'fixtures/settle.warmup-offer.json')
    expect(parseAgentSweepSettleRequestV11(settle).disposition).toBe('offer')
    expect(() => parseAgentSweepSettleRequestV11({ ...settle, owner: 'forged' })).toThrow('agent_sweep_v11_invalid')
    expect(() => parseAgentSweepSettleRequestV11({ ...settle, usage: { ...settle.usage, computeSeconds: 1_801 } }))
      .toThrow('agent_sweep_v11_invalid')
    expect(() => parseAgentSweepSettleRequestV11({ ...settle, findingHashes: ['a'.repeat(64), 'a'.repeat(64)] }))
      .toThrow('agent_sweep_v11_invalid')
  })

  it('keeps the frozen /1 parser unable to claim the warm-up shape', () => {
    expect(() => parseAgentSweepClaimResponse(readFixture('agent-sweep-v1.1', 'fixtures/claim.warmup.json')))
      .toThrow('agent_sweep_invalid')
    const response = parseAnyAgentSweepClaimResponse(readFixture('agent-sweep-v1.1', 'fixtures/claim.warmup.json'))
    expect(response.profile).toBe(AGENT_SWEEP_PROFILE_V11)
    if (response.decision === 'claimed' && response.profile === AGENT_SWEEP_PROFILE_V11) {
      expect(response.occurrenceKind).toBe('warmup_nudge')
    }
  })
})
