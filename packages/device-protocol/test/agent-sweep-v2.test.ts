import { describe, expect, it } from 'vitest'

import { parseAgentSweepClaimResponse } from '../agent-sweep'
import {
  AGENT_SWEEP_PACK_V2_PIN,
  AGENT_SWEEP_PROFILE_V2,
  AGENT_SWEEP_PROTOCOL_VERSION_V2,
  migrateLegacySourceWatermarks,
  parseAgentSweepClaimResponseV2,
  parseAgentSweepDispatchResponseV2,
  parseAgentSweepLegacyProjectionV2,
  parseAgentSweepNativeActiveEnvelopeV2,
  parseAgentSweepNativeClaimEnvelopeV2,
  parseAgentSweepNativeReleaseEnvelopeV2,
  parseAgentSweepSettleRequestV2,
  parseAgentSweepSettlementResponseV2,
  projectLegacySourceWatermarks
} from '../agent-sweep-v2'
import { AGENT_SWEEP_V2_PACK } from '../contract-packs'
import { machineViolations, messageViolations } from '../schema'
import { fixtureEntries, readFixture } from './fixtures'

describe('the vendored agent-sweep v2 open-source contract', () => {
  it('pins the exact protocol pack', () => {
    expect(AGENT_SWEEP_PROFILE_V2).toBe('atum.agent-sweep/2')
    expect(AGENT_SWEEP_PROTOCOL_VERSION_V2).toBe('0.7.56')
    expect(AGENT_SWEEP_PACK_V2_PIN).toBe('2fe190c09d94145b8afe4d9baf54d8d7588e1363e96671e2add07dbc66f9ae8a')
  })

  for (const entry of fixtureEntries('agent-sweep-v2')) {
    it(`${entry.expect}: ${entry.file}`, () => {
      const value = readFixture('agent-sweep-v2', entry.file)
      const violations = entry.machine !== undefined
        ? machineViolations(AGENT_SWEEP_V2_PACK.state_machines![entry.machine]!, value.steps)
        : messageViolations(AGENT_SWEEP_V2_PACK, entry.message!, value)
      if (entry.expect === 'accept') expect(violations).toEqual([])
      else expect(violations.map(violation => violation.category)).toContain(entry.violation)
    })
  }

  it('parses open-source claim, dispatch, settlement and exact cursor deltas', () => {
    const claim = parseAgentSweepClaimResponseV2(readFixture('agent-sweep-v2', 'fixtures/claim.normal.json'))
    expect(claim.decision).toBe('claimed')
    if (claim.decision !== 'claimed') throw new Error('fixture_invalid')
    expect(claim.sourceCursors['app:00000000-0000-4000-8000-a3a9e1ed9732:chat'])
      .toBe('opaque:room:event_00')
    expect(parseAgentSweepDispatchResponseV2(
      readFixture('agent-sweep-v2', 'fixtures/dispatch.normal.cloud-managed.json')
    )).toMatchObject({ sourceSnapshotRevision: 31, sourceSnapshotDigest: claim.admittedSources.snapshotDigest })
    expect(parseAgentSweepSettleRequestV2(readFixture('agent-sweep-v2', 'fixtures/settle.normal-offer.json'))
      .scan.cursorDeltas.google_drive).toBe('opaque:drive:revision_01')
    expect(parseAgentSweepSettlementResponseV2(
      readFixture('agent-sweep-v2', 'fixtures/settlement.normal-offer.json')
    ).publication.state).toBe('admitted')
  })

  it('migrates six-source state without creating a Drive cursor and projects exactly five legacy keys', () => {
    const legacy = {
      googleMail: 'legacy:mail',
      googleCalendar: 'legacy:mixed-calendar-drive',
      atumChats: null,
      conversation: 'legacy:conversation',
      memory: null
    }
    const cursors = migrateLegacySourceWatermarks(legacy)
    expect(cursors).toEqual({
      google_mail: 'legacy:mail',
      google_calendar: 'legacy:mixed-calendar-drive',
      conversation: 'legacy:conversation'
    })
    expect(cursors.google_drive).toBeUndefined()
    expect(projectLegacySourceWatermarks({ ...cursors, google_drive: 'opaque:drive', 'plugin:future': 'opaque:x' }))
      .toEqual(legacy)
    expect(parseAgentSweepLegacyProjectionV2(
      readFixture('agent-sweep-v2', 'fixtures/legacy.projection.json')
    ).legacySourceWatermarks).toHaveProperty('memory', null)
  })

  it('keeps the frozen /1 parser unable to consume /2', () => {
    expect(() => parseAgentSweepClaimResponse(readFixture('agent-sweep-v2', 'fixtures/claim.normal.json')))
      .toThrow('agent_sweep_invalid')
  })

  it('keeps the later native collector seam on the same pinned profile', () => {
    expect(parseAgentSweepNativeClaimEnvelopeV2(
      readFixture('agent-sweep-v2', 'fixtures/native.claim-envelope.json')
    ).request.profile).toBe(AGENT_SWEEP_PROFILE_V2)
    expect(parseAgentSweepNativeActiveEnvelopeV2(
      readFixture('agent-sweep-v2', 'fixtures/native.active-envelope.json')
    ).request.operation).toBe('dispatch')
    expect(parseAgentSweepNativeReleaseEnvelopeV2(
      readFixture('agent-sweep-v2', 'fixtures/native.release-envelope.json')
    ).request.operation).toBe('release')
  })
})
