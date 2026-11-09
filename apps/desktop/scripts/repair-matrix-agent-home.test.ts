import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { matrixAgentHomeKey, readMatrixAgentHomes } from '../electron/matrix/agent-home'

import { repairMatrixAgentHome } from './repair-matrix-agent-home'

const OWNER = '00000000-0000-4000-8000-bd7662a5eeb4'
const AGENT = '00000000-0000-4000-8000-b454f82c5857'
const CURRENT = 'a'.repeat(64)
const EARLIER = 'b'.repeat(64)
const temporary: string[] = []
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const profiles = mkdtempSync(path.join(tmpdir(), 'matrix-home-repair-'))
  temporary.push(profiles)
  const current = path.join(profiles, CURRENT)
  const earlier = path.join(profiles, EARLIER)
  mkdirSync(path.join(current, 'memories'), { recursive: true })
  mkdirSync(path.join(earlier, 'memories'), { recursive: true })
  writeFileSync(path.join(current, 'SOUL.md'), 'Current persona')
  writeFileSync(path.join(earlier, 'SOUL.md'), 'Historical persona')
  writeFileSync(path.join(current, 'state.db'), 'current-state')
  writeFileSync(path.join(earlier, 'state.db'), 'earlier-state-longer')
  writeFileSync(path.join(earlier, 'memories', 'MEMORY.md'), 'private bytes')
  writeFileSync(path.join(earlier, '.atum-profile-import.json'), '{}')
  const marker = path.join(profiles, 'stopped.json')
  const fromMarker = path.join(profiles, 'stopped-from.json')
  writeFileSync(marker, JSON.stringify({ state: 'stopped', home: earlier }))
  writeFileSync(fromMarker, JSON.stringify({ state: 'stopped', home: current }))

  const args = [
    '--profiles',
    profiles,
    '--owner',
    OWNER,
    '--agent',
    AGENT,
    '--from',
    CURRENT,
    '--home',
    EARLIER,
    '--expected-from-soul',
    digest('Current persona'),
    '--expected-home-soul',
    digest('Historical persona'),
    '--expected-from-memory-bytes',
    '0',
    '--expected-home-memory-bytes',
    String(Buffer.byteLength('private bytes')),
    '--expected-from-state-bytes',
    String(Buffer.byteLength('current-state')),
    '--expected-home-state-bytes',
    String(Buffer.byteLength('earlier-state-longer'))
  ]

  return { profiles, current, earlier, marker, fromMarker, args }
}

describe('the owner-confirmed Matrix home repair command', () => {
  it('dry-runs from exact evidence, then binds without moving either home', () => {
    const f = fixture()
    expect(repairMatrixAgentHome(f.args)).toMatchObject({
      status: 'ready',
      from: CURRENT.slice(0, 12),
      home: EARLIER.slice(0, 12),
      currentBinding: null
    })
    expect(readMatrixAgentHomes(f.profiles).homes).toEqual({})

    expect(() => repairMatrixAgentHome([...f.args, '--apply', '--owner-confirmed'])).toThrow(
      'matrix_agent_home_repair_not_authorized'
    )
    expect(() =>
      repairMatrixAgentHome([...f.args, '--apply', '--owner-confirmed', '--stopped-marker', f.marker])
    ).toThrow('matrix_agent_home_repair_not_authorized')
    const stopped = ['--stopped-marker', f.marker, '--stopped-marker-from', f.fromMarker]
    const applied = repairMatrixAgentHome([...f.args, '--apply', '--owner-confirmed', ...stopped])
    expect(applied.status).toBe('applied')
    expect(readMatrixAgentHomes(f.profiles).homes[matrixAgentHomeKey(OWNER, AGENT)]).toMatchObject({
      home: EARLIER,
      from: CURRENT,
      hosted: true
    })
    expect(existsSync(f.current)).toBe(true)
    expect(existsSync(f.earlier)).toBe(true)

    expect(
      repairMatrixAgentHome([...f.args, '--rollback', '--owner-confirmed', ...stopped])
    ).toMatchObject({ status: 'rolled_back', currentBinding: EARLIER.slice(0, 12) })
    expect(readMatrixAgentHomes(f.profiles).homes[matrixAgentHomeKey(OWNER, AGENT)]).toMatchObject({
      home: CURRENT,
      from: EARLIER,
      hosted: true
    })
  })

  it('refuses stale evidence before either dry-run or apply can write', () => {
    const f = fixture()
    writeFileSync(path.join(f.earlier, 'state.db'), 'changed')
    expect(() => repairMatrixAgentHome(f.args)).toThrow('matrix_agent_home_repair_evidence_changed')
    expect(readMatrixAgentHomes(f.profiles).homes).toEqual({})
  })

  it('keeps a malformed index byte-for-byte during a refused dry-run', () => {
    const f = fixture()
    const index = path.join(f.profiles, 'agent-homes.json')
    writeFileSync(index, '{torn')
    const before = readFileSync(index)

    expect(() => repairMatrixAgentHome(f.args)).toThrow('matrix_agent_homes_invalid')
    expect(readFileSync(index)).toEqual(before)
    expect(readdirSync(f.profiles).some(name => name.startsWith('agent-homes.json.corrupt-'))).toBe(false)
  })
})
