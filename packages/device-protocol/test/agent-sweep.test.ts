import { describe, expect, it } from 'vitest'

import {
  AGENT_SWEEP_LIMITS,
  AGENT_SWEEP_MIGRATION,
  AGENT_SWEEP_PACK_PIN,
  AGENT_SWEEP_PROFILE,
  AGENT_SWEEP_PROTOCOL_VERSION,
  parseAgentSweepClaimResponse,
  parseAgentSweepDispatchResponse,
  parseAgentSweepSettleRequest,
  parseAgentSweepSettlementResponse,
  parseFollowupSweepResult,
  validAgentSweepMessage
} from '../agent-sweep'
import { cases, readFixture } from './fixtures'

describe('the vendored agent-sweep v1 contract', () => {
  it('retains the frozen release, migration and small background limits', () => {
    expect(AGENT_SWEEP_PROFILE).toBe('atum.agent-sweep/1')
    expect(AGENT_SWEEP_PROTOCOL_VERSION).toBe('0.7.47')
    expect(AGENT_SWEEP_MIGRATION).toBe('0316')
    expect(AGENT_SWEEP_PACK_PIN).toMatch(/^[a-f0-9]{64}$/u)
    expect(AGENT_SWEEP_LIMITS).toMatchObject({ activeComputeSeconds: 120, inputTokens: 8_000,
      outputTokens: 1_000, everydayModel: 'nguyet-thuc' })
  })

  for (const message of ['claim.response', 'dispatch.response', 'settle', 'settlement', 'classifier.result'] as const) {
    for (const fixture of cases('agent-sweep', message)) {
      it(`${message}: ${fixture.name}`, () => {
        expect(validAgentSweepMessage(message, fixture.value)).toBe(fixture.entry.expect === 'accept')
      })
    }
  }

  it('parses the strict cloud adapters and classifier results', () => {
    expect(parseAgentSweepClaimResponse(readFixture('agent-sweep', 'fixtures/claim.claimed.json')).decision).toBe('claimed')
    expect(parseAgentSweepDispatchResponse(readFixture('agent-sweep', 'fixtures/dispatch.cloud-google.json')))
      .toMatchObject({ decision: 'dispatched', authorization: { kind: 'cloud', grant: { kind: 'google_protected' } } })
    expect(parseAgentSweepDispatchResponse(readFixture('agent-sweep', 'fixtures/dispatch.native-google.json')))
      .toMatchObject({ decision: 'dispatched', authorization: { kind: 'native', protection: { kind: 'google_protected' } } })
    expect(parseAgentSweepSettleRequest(readFixture('agent-sweep', 'fixtures/settle.offer.json')).disposition).toBe('offer')
    expect(parseAgentSweepSettlementResponse(readFixture('agent-sweep', 'fixtures/settlement.offer.json')).publication.state).toBe('admitted')
    expect(parseFollowupSweepResult(readFixture('agent-sweep', 'fixtures/result.offer.json')).decision).toBe('offer')
  })

  it('rejects budget and identity widening', () => {
    const dispatch = readFixture('agent-sweep', 'fixtures/dispatch.cloud-google.json')
    expect(() => parseAgentSweepDispatchResponse({ ...dispatch,
      authorization: { ...dispatch.authorization, grant: { ...dispatch.authorization.grant, outputBudget: 1_001 } } }))
      .toThrow('agent_sweep_invalid')
    const settle = readFixture('agent-sweep', 'fixtures/settle.offer.json')
    expect(() => parseAgentSweepSettleRequest({ ...settle, owner: 'forged' })).toThrow('agent_sweep_invalid')
  })
})
