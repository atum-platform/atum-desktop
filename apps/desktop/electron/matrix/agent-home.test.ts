/**
 * A named agent's Hermes home survives its executor (agent-home.ts): real folders in a temporary
 * profiles folder, as the runtime lays them out (one 64-hex folder per home).
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  declaresMcpServers,
  markMatrixAgentHosted,
  MATRIX_AGENT_HOMES_FILE,
  matrixAgentHome,
  matrixAgentHomeKey,
  matrixAgentHosted,
  readMatrixAgentHomes,
  reconcileMatrixAgentHome,
  repairMatrixAgentHomeBinding,
  rollbackMatrixAgentHomeBinding
} from './agent-home'
import { matrixHermesHome } from './hermes-runtime'

const OWNER = '00000000-0000-4000-8000-e5602db60729'
const OTHER_OWNER = '00000000-0000-4000-8000-074293259dc5'
const MOON = '00000000-0000-4000-8000-dc958a96db7b'
const ALFRED = '00000000-0000-4000-8000-0f28154f2701'
const EARLIER = '00000000-0000-4000-8000-dc5a4c6fefce'
const FIRST = '00000000-0000-4000-8000-6a4e9ba98ef0'
const SECOND = '00000000-0000-4000-8000-58f15d82738f'
const THIRD = '00000000-0000-4000-8000-72ad3a464187'

const MOON_SOUL = '# Moon\n\nA calm, careful researcher who keeps the owner’s projects in order.\n'
const ALFRED_SOUL = '# Alfred\n\nA butler for the calendar.\n'

const MCP_CONFIG =
  'model:\n  provider: openai-codex\nmcp_servers:\n  agent-jobs:\n    command: agent-jobs\n  atum-aux:\n    command: atum-aux\n'

const ATUM_CONFIG = 'model:\n  provider: atum\napprovals:\n  mode: off\n'

const folders: string[] = []

afterEach(() => {
  folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true }))
})

function profilesFolder(): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'atum-agent-home-'))
  folders.push(folder)

  return folder
}

/** A home as Hermes leaves it. `soulAt` is the persona's write time (seconds since 2026-09-01). */
function home(
  profiles: string,
  executorId: string,
  content: { soul?: string; soulAt?: number; memory?: string; config?: string; sessions?: number; owner?: string } = {}
): string {
  const folder = matrixHermesHome({ profiles }, content.owner ?? OWNER, executorId)
  mkdirSync(path.join(folder, 'memories'), { recursive: true })
  mkdirSync(path.join(folder, 'sessions'), { recursive: true })
  writeFileSync(path.join(folder, 'config.yaml'), content.config ?? ATUM_CONFIG)
  writeFileSync(path.join(folder, 'state.db'), 'sqlite')

  if (content.soul) {
    writeFileSync(path.join(folder, 'SOUL.md'), content.soul)
    const at = new Date(Date.UTC(2026, 8, 1) + (content.soulAt ?? 0) * 1000)
    utimesSync(path.join(folder, 'SOUL.md'), at, at)
  }

  if (content.memory) {
    writeFileSync(path.join(folder, 'memories', 'MEMORY.md'), content.memory)
  }

  for (let index = 0; index < (content.sessions ?? 0); index++) {
    writeFileSync(path.join(folder, 'sessions', `session-${index}.json`), '{}')
  }

  return folder
}

/** Every file under the profiles folder with its bytes: proof that nothing was moved or removed. */
function tree(folder: string): Record<string, string> {
  const files: Record<string, string> = {}

  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)

      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name !== MATRIX_AGENT_HOMES_FILE) {
        files[path.relative(folder, full)] = readFileSync(full, 'utf8')
      }
    }
  }

  walk(folder)

  return files
}

function reconcile(
  profiles: string,
  input: Partial<Parameters<typeof reconcileMatrixAgentHome>[0]> & { executorId: string }
) {
  const lines: string[] = []

  const decision = reconcileMatrixAgentHome({
    profiles,
    owner: OWNER,
    agent: MOON,
    reserved: [],
    quiescent: true,
    log: line => lines.push(line),
    now: () => 1_000,
    ...input
  })

  return { ...decision, lines }
}

function binding(profiles: string, owner = OWNER, agent = MOON) {
  return readMatrixAgentHomes(profiles).homes[matrixAgentHomeKey(owner, agent)]
}

describe("a named agent's Hermes home", () => {
  it('keeps the root executor home without an index write until its agent principal is known', () => {
    const profiles = profilesFolder()
    const current = home(profiles, FIRST, { soul: MOON_SOUL })

    expect(reconcile(profiles, { agent: undefined, executorId: FIRST }).home).toBe(current)
    expect(existsSync(path.join(profiles, MATRIX_AGENT_HOMES_FILE))).toBe(false)

    const retained = { home: current, executorId: SECOND }
    expect(reconcile(profiles, { agent: undefined, executorId: SECOND, retained }).home).toBe(current)
    expect(existsSync(path.join(profiles, MATRIX_AGENT_HOMES_FILE))).toBe(false)
  })

  it('is its first executor’s own home, then stays the agent’s when a new executor enrolls', () => {
    const profiles = profilesFolder()
    const first = home(profiles, FIRST, { soul: MOON_SOUL })

    // A new agent: nothing bound yet, so its first executor's own home, as shipped.
    expect(matrixAgentHome({ profiles, owner: OWNER, agent: MOON, executorId: FIRST })).toBe(first)
    expect(reconcile(profiles, { executorId: FIRST }).home).toBe(first)
    expect(binding(profiles)).toEqual({ home: path.basename(first), at: 1_000 })

    // Memory and tools accumulate; then the executor is revoked (sign-out, Disconnect) and a new
    // one enrolls: the account no longer retains anything for the agent.
    writeFileSync(path.join(first, 'memories', 'MEMORY.md'), 'The owner prefers short answers.')
    writeFileSync(path.join(first, 'config.yaml'), MCP_CONFIG)

    expect(matrixAgentHome({ profiles, owner: OWNER, agent: MOON, executorId: SECOND })).toBe(first)
    expect(reconcile(profiles, { executorId: SECOND }).home).toBe(first)
    expect(existsSync(matrixHermesHome({ profiles }, OWNER, SECOND))).toBe(false)

    // Once retained for the new executor, reads follow the account's record.
    const retained = { home: first, executorId: SECOND }
    expect(matrixAgentHome({ profiles, owner: OWNER, agent: MOON, executorId: SECOND, retained })).toBe(first)
    expect(reconcile(profiles, { executorId: SECOND, retained }).home).toBe(first)
  })

  it('belongs to one owner and one agent', () => {
    const profiles = profilesFolder()
    const moon = home(profiles, FIRST, { soul: MOON_SOUL })
    reconcile(profiles, { executorId: FIRST })

    expect(matrixAgentHomeKey(OWNER, MOON)).not.toBe(matrixAgentHomeKey(OTHER_OWNER, MOON))
    expect(matrixAgentHomeKey(OWNER, MOON)).not.toBe(matrixAgentHomeKey(OWNER, ALFRED))
    expect(matrixAgentHome({ profiles, owner: OTHER_OWNER, agent: MOON, executorId: SECOND })).toBe(
      matrixHermesHome({ profiles }, OTHER_OWNER, SECOND)
    )
    expect(matrixAgentHome({ profiles, owner: OWNER, agent: ALFRED, executorId: SECOND })).not.toBe(moon)
  })

  it('binds a new agent before its home exists only when no earlier home here could be its own', () => {
    const fresh = profilesFolder()
    const first = matrixHermesHome({ profiles: fresh }, OWNER, FIRST)

    // A fresh Mac: bound at once, so a revocation before the next start cannot lose it.
    expect(reconcile(fresh, { executorId: FIRST }).home).toBe(first)
    expect(binding(fresh)?.home).toBe(path.basename(first))

    // A Mac with an earlier home holding content: decided at a later start, once seeded.
    const busy = profilesFolder()
    home(busy, EARLIER, { soul: MOON_SOUL, memory: 'notes', config: MCP_CONFIG })
    expect(reconcile(busy, { executorId: FIRST }).home).toBe(matrixHermesHome({ profiles: busy }, OWNER, FIRST))
    expect(binding(busy)).toBeUndefined()
  })
})

describe('an earlier home an older build replaced on re-enrollment', () => {
  function split() {
    const profiles = profilesFolder()
    const earlier = home(profiles, EARLIER, { soul: MOON_SOUL, soulAt: 10, memory: 'notes', config: MCP_CONFIG })
    const empty = home(profiles, SECOND, { soul: MOON_SOUL, soulAt: 20 })

    return { profiles, earlier, empty, retained: { home: empty, executorId: SECOND } }
  }

  it('is adopted when it is the one earlier home with the same persona and content; nothing is deleted', () => {
    const { profiles, earlier, empty, retained } = split()
    const before = tree(profiles)
    const decision = reconcile(profiles, { executorId: SECOND, retained })

    expect(decision.home).toBe(earlier)
    expect(decision.adoptedFrom).toBe(empty)
    expect(decision.lines.join('\n')).toContain('earlier home')
    expect(binding(profiles)).toEqual({ home: path.basename(earlier), at: 1_000, from: path.basename(empty) })
    expect(tree(profiles)).toEqual(before)

    // Recorded once: the next start, with the account's record moved, keeps it.
    const next = reconcile(profiles, { executorId: SECOND, retained: { home: earlier, executorId: SECOND } })
    expect(next.home).toBe(earlier)
    expect(next.adoptedFrom).toBeUndefined()
  })

  it('is not adopted while the persona is still a stock Hermes template, or when a third home shares it', () => {
    for (const soul of [
      'You are Hermes Agent, an intelligent AI assistant created by Nous Research. You are helpful.\n',
      '# Hermes Agent Persona\n\n<!--\nThis file defines the agent\'s personality and tone.\n-->\n'
    ]) {
      const profiles = profilesFolder()
      home(profiles, EARLIER, { soul, soulAt: 10, memory: 'someone else\'s notes', config: MCP_CONFIG })
      const empty = home(profiles, SECOND, { soul, soulAt: 20 })
      const before = tree(profiles)
      const decision = reconcile(profiles, { executorId: SECOND, retained: { home: empty, executorId: SECOND } })

      expect(decision.home).toBe(empty)
      expect(decision.adoptedFrom).toBeUndefined()
      expect(decision.lines.join('\n')).toContain('default persona')
      expect(tree(profiles)).toEqual(before)
    }

    // The same seeded persona in a third home: the bytes don't single this agent out.
    const shared = split()
    home(shared.profiles, THIRD, { soul: MOON_SOUL, soulAt: 15 })
    const decision = reconcile(shared.profiles, { executorId: SECOND, retained: shared.retained })
    expect(decision.home).toBe(shared.empty)
    expect(decision.adoptedFrom).toBeUndefined()
  })

  it('is adopted from content alone: memory, saved sessions or tool servers each count', () => {
    for (const content of [{ memory: 'notes' }, { sessions: 1 }, { config: MCP_CONFIG }]) {
      const profiles = profilesFolder()
      const earlier = home(profiles, EARLIER, { soul: MOON_SOUL, soulAt: 10, ...content })
      const empty = home(profiles, SECOND, { soul: MOON_SOUL, soulAt: 20 })

      expect(reconcile(profiles, { executorId: SECOND, retained: { home: empty, executorId: SECOND } }).home).toBe(
        earlier
      )
    }
  })

  it('is not adopted when it is ambiguous, retained by another participant or bound to another agent', () => {
    const twice = split()
    const second = home(twice.profiles, THIRD, { soul: MOON_SOUL, soulAt: 5, memory: 'other notes' })
    const ambiguous = reconcile(twice.profiles, { executorId: SECOND, retained: twice.retained })
    expect(ambiguous.home).toBe(twice.empty)
    expect(ambiguous.adoptedFrom).toBeUndefined()
    expect(ambiguous.lines.join('\n')).toContain('2 earlier homes match')
    expect(existsSync(second)).toBe(true)

    const reserved = split()
    expect(
      reconcile(reserved.profiles, { executorId: SECOND, retained: reserved.retained, reserved: [reserved.earlier] })
        .home
    ).toBe(reserved.empty)

    const boundElsewhere = split()
    reconcile(boundElsewhere.profiles, {
      agent: ALFRED,
      executorId: FIRST,
      retained: { home: boundElsewhere.earlier, executorId: FIRST }
    })
    expect(reconcile(boundElsewhere.profiles, { executorId: SECOND, retained: boundElsewhere.retained }).home).toBe(
      boundElsewhere.empty
    )
  })

  it('is not adopted over a current home with content, a different persona, or a later persona write', () => {
    const owned = split()
    writeFileSync(path.join(owned.empty, 'memories', 'MEMORY.md'), 'new notes')
    expect(reconcile(owned.profiles, { executorId: SECOND, retained: owned.retained }).home).toBe(owned.empty)

    const persona = split()
    writeFileSync(path.join(persona.earlier, 'SOUL.md'), ALFRED_SOUL)
    expect(reconcile(persona.profiles, { executorId: SECOND, retained: persona.retained }).home).toBe(persona.empty)

    const later = profilesFolder()
    home(later, EARLIER, { soul: MOON_SOUL, soulAt: 30, memory: 'notes' })
    const current = home(later, SECOND, { soul: MOON_SOUL, soulAt: 20 })
    expect(reconcile(later, { executorId: SECOND, retained: { home: current, executorId: SECOND } }).home).toBe(current)
  })

  it('waits while the agent runs: nothing changes and nothing is recorded', () => {
    const { profiles, empty, retained } = split()

    expect(reconcile(profiles, { executorId: SECOND, retained, quiescent: false })).toEqual({ home: empty, lines: [] })
    expect(existsSync(path.join(profiles, MATRIX_AGENT_HOMES_FILE))).toBe(false)
  })

  it('wins over the retained home when an adoption was recorded but the account was not', () => {
    const { profiles, earlier, retained } = split()
    reconcile(profiles, { executorId: SECOND, retained })

    // The account still retains the empty home (its move failed or the app quit first).
    expect(reconcile(profiles, { executorId: SECOND, retained })).toMatchObject({ home: earlier })
    expect(matrixAgentHome({ profiles, owner: OWNER, agent: MOON, executorId: SECOND, retained })).toBe(retained.home)
  })
})

describe('the agent homes index', () => {
  it('sets an unreadable index aside and starts empty', () => {
    const profiles = profilesFolder()
    writeFileSync(path.join(profiles, MATRIX_AGENT_HOMES_FILE), '{"v":1,"homes":')
    const lines: string[] = []

    expect(readMatrixAgentHomes(profiles, line => lines.push(line))).toEqual({ v: 1, homes: {} })
    expect(lines).toEqual(['[Matrix] agent homes index unreadable; set aside'])
    expect(readdirSync(profiles).some(name => name.startsWith(`${MATRIX_AGENT_HOMES_FILE}.corrupt-`))).toBe(true)
  })

  it('follows only a real home folder inside the profiles folder, never another participant’s', () => {
    const profiles = profilesFolder()
    const key = matrixAgentHomeKey(OWNER, MOON)
    const outside = profilesFolder()
    const linked = path.join(profiles, 'f'.repeat(64))
    symlinkSync(outside, linked)
    const theirs = home(profiles, EARLIER, { soul: ALFRED_SOUL })
    const fresh = matrixHermesHome({ profiles }, OWNER, SECOND)

    for (const target of ['../escape', 'f'.repeat(64), path.basename(theirs)]) {
      writeFileSync(
        path.join(profiles, MATRIX_AGENT_HOMES_FILE),
        JSON.stringify({ v: 1, homes: { [key]: { home: target, at: 1 } } })
      )

      const reserved = target === path.basename(theirs) ? [theirs] : []

      expect(reconcile(profiles, { executorId: SECOND, reserved }).home).toBe(fresh)
      expect(lstatSync(linked).isSymbolicLink()).toBe(true)
    }
  })
})

describe('an owner-confirmed home repair', () => {
  it('binds an older imported home with a different persona while preserving both trees', () => {
    const profiles = profilesFolder()
    const current = home(profiles, SECOND, { soul: MOON_SOUL, soulAt: 20 })
    const earlier = home(profiles, EARLIER, { soul: ALFRED_SOUL, soulAt: 10, memory: 'old notes' })
    writeFileSync(path.join(earlier, '.atum-profile-import.json'), '{}')
    const before = tree(profiles)
    const lines: string[] = []

    const repaired = repairMatrixAgentHomeBinding({
      profiles,
      owner: OWNER,
      agent: MOON,
      from: current,
      home: earlier,
      now: () => 2_000,
      log: line => lines.push(line)
    })

    expect(repaired).toEqual({
      home: path.basename(earlier),
      at: 2_000,
      from: path.basename(current),
      hosted: true
    })
    expect(binding(profiles)).toEqual(repaired)
    expect(tree(profiles)).toEqual(before)
    expect(lines.join('\n')).toContain('kept')

    // An exact retry is a no-op and retains the first receipt time.
    expect(repairMatrixAgentHomeBinding({ profiles, owner: OWNER, agent: MOON, from: current, home: earlier })).toEqual(
      repaired
    )

    const rolledBack = rollbackMatrixAgentHomeBinding({
      profiles,
      owner: OWNER,
      agent: MOON,
      home: earlier,
      restore: current,
      now: () => 3_000
    })
    expect(rolledBack).toEqual({
      home: path.basename(current),
      at: 3_000,
      from: path.basename(earlier),
      hosted: true
    })
    expect(tree(profiles)).toEqual(before)
    expect(() =>
      rollbackMatrixAgentHomeBinding({ profiles, owner: OWNER, agent: MOON, home: earlier, restore: current })
    ).toThrow('matrix_agent_home_repair_conflict')
  })

  it('refuses an empty target, another agent’s target, and a stale source binding', () => {
    const profiles = profilesFolder()
    const current = home(profiles, SECOND, { soul: MOON_SOUL })
    const empty = home(profiles, EARLIER, { soul: ALFRED_SOUL })

    expect(() =>
      repairMatrixAgentHomeBinding({ profiles, owner: OWNER, agent: MOON, from: current, home: empty })
    ).toThrow('matrix_agent_home_repair_invalid')

    const earlier = home(profiles, THIRD, { soul: ALFRED_SOUL, memory: 'old notes' })
    reconcile(profiles, {
      agent: ALFRED,
      executorId: FIRST,
      retained: { home: earlier, executorId: FIRST }
    })
    expect(() =>
      repairMatrixAgentHomeBinding({ profiles, owner: OWNER, agent: MOON, from: current, home: earlier })
    ).toThrow('matrix_agent_home_repair_conflict')

    const bound = home(profiles, '00000000-0000-4000-8000-300929439eae', { soul: MOON_SOUL })
    reconcile(profiles, { executorId: SECOND, retained: { home: bound, executorId: SECOND } })
    expect(() =>
      repairMatrixAgentHomeBinding({ profiles, owner: OWNER, agent: MOON, from: current, home: earlier })
    ).toThrow('matrix_agent_home_repair_conflict')
  })
})

describe("the agent's home device", () => {
  it('is this Mac when the agent was imported here, even before the record existed', () => {
    const profiles = profilesFolder()
    const imported = home(profiles, FIRST, { soul: MOON_SOUL })
    writeFileSync(path.join(imported, '.atum-profile-import.json'), '{}')
    const installed = home(profiles, SECOND, { soul: ALFRED_SOUL })

    expect(matrixAgentHosted({ profiles, owner: OWNER, agent: MOON, home: imported })).toBe(true)
    // Installed from its definition only: a guest copy here.
    expect(matrixAgentHosted({ profiles, owner: OWNER, agent: ALFRED, home: installed })).toBe(false)
  })

  it('is recorded when the agent is made here, kept for that owner and agent across homes and rewrites', () => {
    const profiles = profilesFolder()
    const first = home(profiles, FIRST, { soul: MOON_SOUL })
    markMatrixAgentHosted({ profiles, owner: OWNER, agent: MOON, home: first })

    expect(binding(profiles)).toMatchObject({ home: path.basename(first), hosted: true })
    expect(matrixAgentHosted({ profiles, owner: OWNER, agent: MOON, home: first })).toBe(true)
    expect(matrixAgentHosted({ profiles, owner: OTHER_OWNER, agent: MOON, home: first })).toBe(false)
    expect(matrixAgentHosted({ profiles, owner: OWNER, agent: ALFRED, home: first })).toBe(false)

    // A later start that records another home for the agent keeps where it was made.
    const gone = 'f'.repeat(64)
    writeFileSync(
      path.join(profiles, MATRIX_AGENT_HOMES_FILE),
      JSON.stringify({ v: 1, homes: { [matrixAgentHomeKey(OWNER, MOON)]: { home: gone, at: 1, hosted: true } } })
    )
    reconcile(profiles, { executorId: THIRD, retained: { home: first, executorId: THIRD } })
    expect(binding(profiles)).toEqual({ home: path.basename(first), at: 1_000, hosted: true })
  })

  it('is never recorded for a folder outside the profiles folder', () => {
    const profiles = profilesFolder()

    expect(() =>
      markMatrixAgentHosted({ profiles, owner: OWNER, agent: MOON, home: path.join(tmpdir(), 'elsewhere') })
    ).toThrow('matrix_runtime_configuration_invalid')
    expect(existsSync(path.join(profiles, MATRIX_AGENT_HOMES_FILE))).toBe(false)
  })
})

describe('tool servers in a Hermes config', () => {
  it('counts a declared server in block or flow style, never an empty section', () => {
    expect(declaresMcpServers(MCP_CONFIG)).toBe(true)
    expect(declaresMcpServers('mcp_servers: {jobs: {command: agent-jobs}}\n')).toBe(true)
    expect(declaresMcpServers('mcp_servers:\n  # none yet\nmodel:\n  provider: atum\n')).toBe(false)
    expect(declaresMcpServers('mcp_servers: {}\n')).toBe(false)
    expect(declaresMcpServers('mcp_servers:\n')).toBe(false)
    expect(declaresMcpServers(ATUM_CONFIG)).toBe(false)
  })
})
