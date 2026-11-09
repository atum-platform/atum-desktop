import { describe, expect, it } from 'vitest'

import {
  AGENT_SOURCES_PACK_PIN,
  AGENT_SOURCES_PROFILE,
  AGENT_SOURCES_PROTOCOL_VERSION,
  applyAgentSourceCursorDeltas,
  decideAgentSourceCursorBinding,
  parseAgentSourceAccessSnapshot,
  parseAgentSourceCursors,
  parseAgentSourceReadRequest,
  parseAgentSourceReadResult,
  parseAgentSourceRegistration
} from '../agent-sources'
import { AGENT_SOURCES_PACK } from '../contract-packs'
import { machineViolations, messageViolations } from '../schema'
import { fixtureEntries, readFixture } from './fixtures'

describe('the vendored open agent-source contract', () => {
  it('pins the exact protocol pack', () => {
    expect(AGENT_SOURCES_PROFILE).toBe('atum.agent-sources/1')
    expect(AGENT_SOURCES_PROTOCOL_VERSION).toBe('0.7.56')
    expect(AGENT_SOURCES_PACK_PIN).toBe('677365750031f1ccd908710541222605b36dea9cb40ea8dc03b8820635b61902')
  })

  for (const entry of fixtureEntries('agent-sources')) {
    it(`${entry.expect}: ${entry.file}`, () => {
      const value = readFixture('agent-sources', entry.file)
      const violations = entry.machine !== undefined
        ? machineViolations(AGENT_SOURCES_PACK.state_machines![entry.machine]!, value.steps)
        : messageViolations(AGENT_SOURCES_PACK, entry.message!, value)
      if (entry.expect === 'accept') expect(violations).toEqual([])
      else expect(violations.map(violation => violation.category)).toContain(entry.violation)
    })
  }

  it('round-trips an unknown app source without product-code enumeration', () => {
    const registration = parseAgentSourceRegistration(
      readFixture('agent-sources', 'fixtures/registration-unknown-source-kind.json')
    )
    const sourceId = registration.sources[0]!.id
    expect(sourceId).toMatch(/^app:[0-9a-f-]+:chat$/u)
    expect(parseAgentSourceAccessSnapshot(readFixture('agent-sources', 'fixtures/access-snapshot.json'))
      .sources[0]!.descriptor.id).toBe(sourceId)
    expect(parseAgentSourceReadRequest(readFixture('agent-sources', 'fixtures/read-request-unknown.json')).sourceId)
      .toBe(sourceId)
    expect(parseAgentSourceReadResult(readFixture('agent-sources', 'fixtures/read-result-unknown-ok.json')).sourceId)
      .toBe(sourceId)
  })

  it('patches cursor deltas while retaining every unmentioned open key', () => {
    const updated = applyAgentSourceCursorDeltas(
      parseAgentSourceCursors({ google_mail: 'legacy:mail', 'plugin:future:source': 'opaque:future' }),
      parseAgentSourceCursors({ google_drive: 'opaque:drive:1' })
    )
    expect(updated).toEqual({
      google_mail: 'legacy:mail',
      google_drive: 'opaque:drive:1',
      'plugin:future:source': 'opaque:future'
    })
  })

  it('reuses a cursor only under the exact current binding', () => {
    const fixture = readFixture('agent-sources', 'fixtures/cursor-binding-reset.json')
    expect(decideAgentSourceCursorBinding(
      fixture.sourceId, fixture.storedCursor, fixture.storedBinding, fixture.currentBinding
    ).decision).toBe('reset')
    expect(decideAgentSourceCursorBinding(
      fixture.sourceId, fixture.storedCursor, fixture.currentBinding, fixture.currentBinding
    ).decision).toBe('reuse')
  })
})
