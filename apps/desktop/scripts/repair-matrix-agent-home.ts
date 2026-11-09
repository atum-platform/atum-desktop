import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  matrixAgentHomeEvidence,
  matrixAgentHomeKey,
  readMatrixAgentHomesStrict,
  repairMatrixAgentHomeBinding,
  rollbackMatrixAgentHomeBinding
} from '../electron/matrix/agent-home'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu
const HEX = /^[a-f0-9]{64}$/u
const VALUE_ARGUMENTS = new Set([
  '--profiles',
  '--owner',
  '--agent',
  '--from',
  '--home',
  '--expected-from-soul',
  '--expected-home-soul',
  '--expected-from-memory-bytes',
  '--expected-home-memory-bytes',
  '--expected-from-state-bytes',
  '--expected-home-state-bytes',
  '--stopped-marker',
  '--stopped-marker-from'
])

interface RepairArguments {
  profiles: string
  owner: string
  agent: string
  from: string
  home: string
  expectedFromSoul: string
  expectedHomeSoul: string
  expectedFromMemoryBytes: number
  expectedHomeMemoryBytes: number
  expectedFromStateBytes: number
  expectedHomeStateBytes: number
  stoppedMarker?: string
  stoppedFromMarker?: string
  apply: boolean
  rollback: boolean
  ownerConfirmed: boolean
}

function fail(code: string): never {
  throw new Error(code)
}

function value(values: Map<string, string>, name: string): string {
  return values.get(name) ?? fail('matrix_agent_home_repair_arguments')
}

function bytes(values: Map<string, string>, name: string): number {
  const parsed = Number(value(values, name))

  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fail('matrix_agent_home_repair_arguments')
}

function argumentsFrom(argv: readonly string[]): RepairArguments {
  const values = new Map<string, string>()
  const flags = new Set<string>()

  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]

    if ((name === '--apply' || name === '--rollback' || name === '--owner-confirmed') && !flags.has(name)) {
      flags.add(name)
    } else if (
      name &&
      VALUE_ARGUMENTS.has(name) &&
      !values.has(name) &&
      argv[index + 1] &&
      !argv[index + 1]!.startsWith('--')
    ) {
      values.set(name, argv[index + 1]!)
      index += 1
    } else {
      fail('matrix_agent_home_repair_arguments')
    }
  }

  const profiles = path.resolve(value(values, '--profiles'))
  const owner = value(values, '--owner')
  const agent = value(values, '--agent')
  const from = value(values, '--from')
  const home = value(values, '--home')
  const expectedFromSoul = value(values, '--expected-from-soul')
  const expectedHomeSoul = value(values, '--expected-home-soul')
  const stoppedMarker = values.get('--stopped-marker')
  const stoppedFromMarker = values.get('--stopped-marker-from')
  const apply = flags.has('--apply')
  const rollback = flags.has('--rollback')

  if (
    !path.isAbsolute(value(values, '--profiles')) ||
    !UUID.test(owner) ||
    !UUID.test(agent) ||
    !HEX.test(from) ||
    !HEX.test(home) ||
    from === home ||
    !HEX.test(expectedFromSoul) ||
    !HEX.test(expectedHomeSoul) ||
    (stoppedMarker !== undefined && !path.isAbsolute(stoppedMarker)) ||
    (stoppedFromMarker !== undefined && !path.isAbsolute(stoppedFromMarker)) ||
    (apply && rollback)
  ) {
    fail('matrix_agent_home_repair_arguments')
  }

  return {
    profiles,
    owner,
    agent,
    from,
    home,
    expectedFromSoul,
    expectedHomeSoul,
    expectedFromMemoryBytes: bytes(values, '--expected-from-memory-bytes'),
    expectedHomeMemoryBytes: bytes(values, '--expected-home-memory-bytes'),
    expectedFromStateBytes: bytes(values, '--expected-from-state-bytes'),
    expectedHomeStateBytes: bytes(values, '--expected-home-state-bytes'),
    stoppedMarker,
    stoppedFromMarker,
    apply,
    rollback,
    ownerConfirmed: flags.has('--owner-confirmed')
  }
}

function regularBytes(file: string): number {
  try {
    const stats = lstatSync(file)

    return stats.isFile() ? stats.size : -1
  } catch {
    return -1
  }
}

function stopped(marker: string | undefined, expectedHome: string): boolean {
  if (!marker) {
    return false
  }

  try {
    const stats = lstatSync(marker)

    if (!stats.isFile() || stats.nlink !== 1 || stats.size > 4096) {
      return false
    }

    const parsed = JSON.parse(readFileSync(marker, 'utf8')) as { state?: unknown; home?: unknown }

    return (
      parsed.state === 'stopped' &&
      typeof parsed.home === 'string' &&
      path.resolve(parsed.home) === path.resolve(expectedHome)
    )
  } catch {
    return false
  }
}

export function repairMatrixAgentHome(argv: readonly string[]) {
  const input = argumentsFrom(argv)
  const from = path.join(input.profiles, input.from)
  const home = path.join(input.profiles, input.home)
  const fromEvidence = matrixAgentHomeEvidence(from)
  const homeEvidence = matrixAgentHomeEvidence(home)

  if (
    fromEvidence.soul?.sha256 !== input.expectedFromSoul ||
    homeEvidence.soul?.sha256 !== input.expectedHomeSoul ||
    fromEvidence.memoryBytes !== input.expectedFromMemoryBytes ||
    homeEvidence.memoryBytes !== input.expectedHomeMemoryBytes ||
    regularBytes(path.join(from, 'state.db')) !== input.expectedFromStateBytes ||
    regularBytes(path.join(home, 'state.db')) !== input.expectedHomeStateBytes
  ) {
    fail('matrix_agent_home_repair_evidence_changed')
  }

  const key = matrixAgentHomeKey(input.owner, input.agent)
  const existing = readMatrixAgentHomesStrict(input.profiles).homes[key]
  const report = {
    status: input.rollback ? ('rolled_back' as const) : input.apply ? ('applied' as const) : ('ready' as const),
    from: input.from.slice(0, 12),
    home: input.home.slice(0, 12),
    currentBinding: existing?.home.slice(0, 12) ?? null,
    evidence: {
      fromSoul: fromEvidence.soul.sha256,
      homeSoul: homeEvidence.soul.sha256,
      fromMemoryBytes: fromEvidence.memoryBytes,
      homeMemoryBytes: homeEvidence.memoryBytes,
      fromStateBytes: input.expectedFromStateBytes,
      homeStateBytes: input.expectedHomeStateBytes
    }
  }

  if (!input.apply && !input.rollback) {
    return report
  }

  if (
    !input.ownerConfirmed ||
    !stopped(input.stoppedMarker, home) ||
    !stopped(input.stoppedFromMarker, from)
  ) {
    fail('matrix_agent_home_repair_not_authorized')
  }

  if (input.rollback) {
    rollbackMatrixAgentHomeBinding({
      profiles: input.profiles,
      owner: input.owner,
      agent: input.agent,
      home,
      restore: from
    })
  } else {
    repairMatrixAgentHomeBinding({
      profiles: input.profiles,
      owner: input.owner,
      agent: input.agent,
      from,
      home
    })
  }

  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(repairMatrixAgentHome(process.argv.slice(2)))}\n`)
  } catch (error) {
    const code = error instanceof Error ? error.message : 'matrix_agent_home_repair_failed'
    process.stdout.write(`${JSON.stringify({ error: code })}\n`)
    process.exitCode = 1
  }
}
