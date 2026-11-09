import { describe, expect, it } from 'vitest'

import {
  AGENT_SOURCE_GATES_PACK_PIN,
  AGENT_SOURCE_GATES_PROFILE,
  AGENT_SOURCE_GATES_PROTOCOL_VERSION,
  parseAgentSourceGateSnapshot,
  parseAgentSourceGateWrite,
  parseAgentSourceGateWriteConflict,
  sameAgentSourceGates
} from '../agent-source-gates'
import { AGENT_SOURCE_GATES_PACK } from '../contract-packs'
import { messageViolations } from '../schema'

import { fixtureEntries, readFixture } from './fixtures'

describe('the vendored agent source gate contract', () => {
  it('pins the exact protocol pack', () => {
    expect(AGENT_SOURCE_GATES_PROFILE).toBe('atum.agent-source-gates/1')
    expect(AGENT_SOURCE_GATES_PROTOCOL_VERSION).toBe('0.7.57')
    expect(AGENT_SOURCE_GATES_PACK_PIN).toBe('74dd2fc488707138bf906eb655138b6b5e70884cd03fb25ad175eace99fb6af4')
  })

  for (const entry of fixtureEntries('agent-source-gates')) {
    it(`${entry.expect}: ${entry.file}`, () => {
      const value = readFixture('agent-source-gates', entry.file)
      const violations = messageViolations(AGENT_SOURCE_GATES_PACK, entry.message!, value)

      if (entry.expect === 'accept') {
        expect(violations).toEqual([])

        if (entry.message === 'gate.snapshot') {
          expect(parseAgentSourceGateSnapshot(value)).toEqual(value)
        } else if (entry.message === 'gate.write') {
          expect(parseAgentSourceGateWrite(value)).toEqual(value)
        } else {
          expect(parseAgentSourceGateWriteConflict(value)).toEqual(value)
        }
      } else {
        expect(violations.map(violation => violation.category)).toContain(entry.violation)
      }
    })
  }

  it('parses a successful write result through the frozen snapshot shape', () => {
    const result = readFixture('agent-source-gates', 'fixtures/snapshot-selective-off.json')
    expect(parseAgentSourceGateSnapshot(result)).toEqual(result)
  })

  it('compares every gate without source-specific branching', () => {
    const snapshot = parseAgentSourceGateSnapshot(
      readFixture('agent-source-gates', 'fixtures/snapshot-selective-off.json')
    )

    expect(sameAgentSourceGates(snapshot.gates, { ...snapshot.gates })).toBe(true)
    expect(sameAgentSourceGates(snapshot.gates, { ...snapshot.gates, team_spaces: true })).toBe(false)
  })
})
