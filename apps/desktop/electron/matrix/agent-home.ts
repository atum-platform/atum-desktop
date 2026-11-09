/**
 * A named agent's Hermes home on this Mac belongs to the agent, not to one executor.
 *
 * An executor's home is `matrixHermesHome(owner, executorId)`. Revoking an executor (sign-out,
 * Disconnect, a withdrawn or cleaned-up credential) clears its credentials and forgets that
 * home; the next enrollment mints a new executorId, which used to mean a new, empty home: the
 * agent lost its memory, its tool servers and its provider on this Mac. This module keeps, per
 * (owner, agent principal), which home is the agent's, in a small index beside the homes
 * (`agent-homes.json`), so a re-enrollment or signing in again reuses it.
 *
 * - The default agent (the root custody slot) uses the same agent-principal binding once its
 *   enrollment names that principal. Before then it safely falls back to
 *   `matrixHermesHome(owner, executorId)`.
 * - Nothing here moves, renames or deletes a home, or writes inside one.
 * - The account's retained record for the current executor (account.ts `agentHermes`) stays the
 *   authority for where that executor's credentials are, and reads follow it. Only
 *   `reconcileMatrixAgentHome`, once per host start and while nothing of the agent runs, may
 *   choose another home for that executor: the bound one, or (once, for homes split by earlier
 *   builds) an earlier home of the same agent that holds its content.
 *
 * Adoption, for a home an earlier build replaced on re-enrollment: when no binding exists yet,
 * the current home is near-empty (no memory, no tool servers, no saved sessions) and exactly one
 * other home on this Mac has the same persona (`SOUL.md`, byte for byte), an earlier persona
 * write, and content, that earlier home becomes the agent's. Homes another participant retains
 * or another agent is bound to are never candidates. Two or more candidates: nothing is adopted.
 */
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { matrixHermesHome } from './hermes-runtime'

export const MATRIX_AGENT_HOMES_FILE = 'agent-homes.json'
const MATRIX_PROFILE_IMPORT_MARKER = '.atum-profile-import.json'

const HEX = /^[a-f0-9]{64}$/

export interface MatrixAgentHomeEntry {
  /** The home's folder name inside the profiles folder. */
  home: string
  at: number
  /** The near-empty home an adoption set aside (kept in place). */
  from?: string
  /** This Mac is the agent's home device: it was created or imported here. */
  hosted?: true
}

export interface MatrixAgentHomeIndex {
  v: 1
  homes: Record<string, MatrixAgentHomeEntry>
}

/** Which agent: a hash, so the index lists no principal in the clear. Owners never share one. */
export function matrixAgentHomeKey(owner: string, agent: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['atum-agent-home/v1', owner, agent]))
    .digest('hex')
}

/** A real folder (never a link) directly inside the profiles folder. */
function isHome(profiles: string, home: string): boolean {
  if (!HEX.test(path.basename(home)) || path.resolve(path.dirname(home)) !== path.resolve(profiles)) {
    return false
  }

  try {
    return lstatSync(home).isDirectory()
  } catch {
    return false
  }
}

function parseMatrixAgentHomes(raw: string, strict = false): MatrixAgentHomeIndex {
  const value = JSON.parse(raw) as Partial<MatrixAgentHomeIndex> | null

  if (!value || value.v !== 1 || typeof value.homes !== 'object' || value.homes === null) {
    throw new Error('matrix_agent_homes_invalid')
  }

  const homes: Record<string, MatrixAgentHomeEntry> = {}

  // Only well-formed entries count; anything else is ignored by ordinary startup, never followed.
  // An operator repair is strict so a dry-run cannot silently discard another agent's entry.
  for (const [key, entry] of Object.entries(value.homes)) {
    if (
      !HEX.test(key) ||
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.home !== 'string' ||
      !HEX.test(entry.home) ||
      !Number.isFinite(entry.at) ||
      (entry.from !== undefined && (typeof entry.from !== 'string' || !HEX.test(entry.from))) ||
      (entry.hosted !== undefined && entry.hosted !== true)
    ) {
      if (strict) {
        throw new Error('matrix_agent_homes_invalid')
      }

      continue
    }

    homes[key] = {
      home: entry.home,
      at: entry.at,
      ...(entry.from ? { from: entry.from } : {}),
      ...(entry.hosted ? { hosted: true as const } : {})
    }
  }

  return { v: 1, homes }
}

/** The index, tolerant: missing is empty; unreadable is set aside (never guessed at) and empty. */
export function readMatrixAgentHomes(profiles: string, log: (line: string) => void = () => {}): MatrixAgentHomeIndex {
  const file = path.join(profiles, MATRIX_AGENT_HOMES_FILE)
  let raw: string

  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { v: 1, homes: {} }
  }

  try {
    return parseMatrixAgentHomes(raw)
  } catch {
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      // Left in place: the next write replaces it.
    }

    log('[Matrix] agent homes index unreadable; set aside')

    return { v: 1, homes: {} }
  }
}

/** Read-only, strict operator view: missing is empty; malformed, linked or unreadable refuses. */
export function readMatrixAgentHomesStrict(profiles: string): MatrixAgentHomeIndex {
  const file = path.join(profiles, MATRIX_AGENT_HOMES_FILE)

  try {
    const stats = lstatSync(file)

    if (!stats.isFile() || stats.nlink !== 1) {
      throw new Error('matrix_agent_homes_invalid')
    }

    return parseMatrixAgentHomes(readFileSync(file, 'utf8'), true)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { v: 1, homes: {} }
    }

    throw new Error('matrix_agent_homes_invalid')
  }
}

function writeMatrixAgentHomes(profiles: string, index: MatrixAgentHomeIndex): void {
  mkdirSync(profiles, { recursive: true, mode: 0o700 })
  const file = path.join(profiles, MATRIX_AGENT_HOMES_FILE)
  const staged = `${file}.${randomUUID()}.tmp`
  writeFileSync(staged, `${JSON.stringify(index)}\n`, { mode: 0o600 })
  renameSync(staged, file)
}

/**
 * An owner-confirmed repair binds one agent to an older retained home without moving, merging,
 * deleting or exposing its content. This is deliberately stricter than normal automatic adoption:
 * both exact folders must exist, the target must have a persona plus memory/sessions/MCP content,
 * and no other agent may own it. A prior binding may move only from the caller's exact `from` home.
 */
export function repairMatrixAgentHomeBinding(input: {
  profiles: string
  owner: string
  agent: string
  from: string
  home: string
  log?: (line: string) => void
  now?: () => number
}): MatrixAgentHomeEntry {
  const fromName = path.basename(input.from)
  const homeName = path.basename(input.home)

  if (
    input.from === input.home ||
    !isHome(input.profiles, input.from) ||
    !isHome(input.profiles, input.home) ||
    path.resolve(path.dirname(input.from)) !== path.resolve(input.profiles) ||
    path.resolve(path.dirname(input.home)) !== path.resolve(input.profiles)
  ) {
    throw new Error('matrix_agent_home_repair_invalid')
  }

  const target = matrixAgentHomeEvidence(input.home)

  if (!target.soul || !matrixAgentHomeHasContent(target)) {
    throw new Error('matrix_agent_home_repair_invalid')
  }

  const key = matrixAgentHomeKey(input.owner, input.agent)
  const homes = readMatrixAgentHomesStrict(input.profiles)
  const existing = homes.homes[key]

  if (existing?.home === homeName) {
    if (existing.from !== fromName) {
      throw new Error('matrix_agent_home_repair_conflict')
    }

    return existing
  }

  if (
    (existing && existing.home !== fromName) ||
    Object.entries(homes.homes).some(
      ([other, entry]) => other !== key && (entry.home === homeName || entry.home === fromName)
    )
  ) {
    throw new Error('matrix_agent_home_repair_conflict')
  }

  let imported = false

  try {
    imported = lstatSync(path.join(input.home, MATRIX_PROFILE_IMPORT_MARKER)).isFile()
  } catch {
    imported = false
  }

  const entry: MatrixAgentHomeEntry = {
    home: homeName,
    at: input.now?.() ?? Date.now(),
    from: fromName,
    ...(existing?.hosted || imported ? { hosted: true as const } : {})
  }

  writeMatrixAgentHomes(input.profiles, { v: 1, homes: { ...homes.homes, [key]: entry } })
  input.log?.(
    `[Matrix] agent ${input.agent.slice(0, 8)} home repair: bound ${homeName.slice(0, 12)}, ` +
      `kept ${fromName.slice(0, 12)} for rollback`
  )

  return entry
}

/** Restore the exact home set aside by a prior repair. The repair receipt lives in the binding
 * itself (`home` + `from`), so rollback cannot name an unrelated or newly discovered folder. */
export function rollbackMatrixAgentHomeBinding(input: {
  profiles: string
  owner: string
  agent: string
  home: string
  restore: string
  log?: (line: string) => void
  now?: () => number
}): MatrixAgentHomeEntry {
  if (!isHome(input.profiles, input.home) || !isHome(input.profiles, input.restore)) {
    throw new Error('matrix_agent_home_repair_invalid')
  }

  const key = matrixAgentHomeKey(input.owner, input.agent)
  const homes = readMatrixAgentHomesStrict(input.profiles)
  const existing = homes.homes[key]
  const homeName = path.basename(input.home)
  const restoreName = path.basename(input.restore)

  if (!existing || existing.home !== homeName || existing.from !== restoreName) {
    throw new Error('matrix_agent_home_repair_conflict')
  }

  if (Object.entries(homes.homes).some(([other, entry]) => other !== key && entry.home === restoreName)) {
    throw new Error('matrix_agent_home_repair_conflict')
  }

  const entry: MatrixAgentHomeEntry = {
    home: restoreName,
    at: input.now?.() ?? Date.now(),
    from: homeName,
    ...(existing.hosted ? { hosted: true as const } : {})
  }
  writeMatrixAgentHomes(input.profiles, { v: 1, homes: { ...homes.homes, [key]: entry } })
  input.log?.(
    `[Matrix] agent ${input.agent.slice(0, 8)} home repair rolled back to ${restoreName.slice(0, 12)}, ` +
      `kept ${homeName.slice(0, 12)}`
  )

  return entry
}

/** The home bound to this agent, when it is still there. */
function boundHome(profiles: string, entry: MatrixAgentHomeEntry | undefined): string | undefined {
  const home = entry ? path.join(profiles, entry.home) : undefined

  return home && isHome(profiles, home) ? home : undefined
}

export interface MatrixAgentHomeInput {
  /** The runtime's profiles folder (`MatrixHermesRuntimeConfig.profiles`). */
  profiles: string
  /** The owner's principal (the enrollment's `principal`). */
  owner: string
  /** The agent's principal. */
  agent: string
  executorId: string
  /** The account's retained home for this agent (account.ts `agentHermes`), if any. */
  retained?: { home: string; executorId: string }
}

/**
 * Where this agent's Hermes runs now, without writing anything: the home the account retains for
 * this executor; else the home bound to the agent (a new executor after a revocation or a new
 * sign-in); else the executor's own home (a new agent).
 */
export function matrixAgentHome(input: MatrixAgentHomeInput): string {
  if (input.retained && input.retained.executorId === input.executorId) {
    return input.retained.home
  }

  const entry = readMatrixAgentHomes(input.profiles).homes[matrixAgentHomeKey(input.owner, input.agent)]

  return boundHome(input.profiles, entry) ?? matrixHermesHome(input, input.owner, input.executorId)
}

/** The home an agent's Hermes runs in on this Mac: a known agent principal uses its stable
 * binding; before the root slot knows its principal it falls back to the executor's own home. */
export function matrixRuntimeHome(input: Omit<MatrixAgentHomeInput, 'agent'> & { agent?: string }): string {
  return input.agent === undefined
    ? matrixHermesHome(input, input.owner, input.executorId)
    : matrixAgentHome({ ...input, agent: input.agent })
}

/** What a home holds, by sizes and names only: never a memory or a setting's value. */
export interface MatrixAgentHomeEvidence {
  exists: boolean
  soul?: { sha256: string; mtimeMs: number }
  memoryBytes: number
  sessionFiles: number
  mcpServers: boolean
}

function filesIn(folder: string): Array<{ size: number }> {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => {
        try {
          return { size: lstatSync(path.join(folder, entry.name)).size }
        } catch {
          return { size: 0 }
        }
      })
  } catch {
    return []
  }
}

/** A top-level `mcp_servers:` with at least one server, in block or flow style. */
export function declaresMcpServers(config: string): boolean {
  const lines = config.split(/\r?\n/)
  const start = lines.findIndex(line => /^mcp_servers\s*:/.test(line))

  if (start < 0) {
    return false
  }

  const inline = lines[start]
    .replace(/^mcp_servers\s*:/, '')
    .replace(/#.*$/, '')
    .trim()

  if (inline) {
    return /^\{\s*[^\s}]/.test(inline)
  }

  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) {
      continue
    }

    // The next top-level key ends the section; an indented key is a server.
    return /^\s+[^\s#-][^:]*:/.test(line)
  }

  return false
}

export function matrixAgentHomeEvidence(home: string): MatrixAgentHomeEvidence {
  let exists = false

  try {
    exists = lstatSync(home).isDirectory()
  } catch {
    exists = false
  }

  if (!exists) {
    return { exists, memoryBytes: 0, sessionFiles: 0, mcpServers: false }
  }

  let soul: MatrixAgentHomeEvidence['soul']

  try {
    const file = path.join(home, 'SOUL.md')
    const stats = lstatSync(file)

    if (stats.isFile() && stats.size > 0) {
      soul = { sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), mtimeMs: stats.mtimeMs }
    }
  } catch {
    soul = undefined
  }

  let mcpServers = false

  try {
    const config = path.join(home, 'config.yaml')

    if (lstatSync(config).isFile()) {
      mcpServers = declaresMcpServers(readFileSync(config, 'utf8'))
    }
  } catch {
    mcpServers = false
  }

  return {
    exists,
    soul,
    memoryBytes: filesIn(path.join(home, 'memories')).reduce((total, file) => total + file.size, 0),
    sessionFiles: filesIn(path.join(home, 'sessions')).length,
    mcpServers
  }
}

/** Memory, saved sessions or tool servers: what an agent loses when its home is replaced. */
export function matrixAgentHomeHasContent(evidence: MatrixAgentHomeEvidence): boolean {
  return evidence.memoryBytes > 0 || evidence.sessionFiles > 0 || evidence.mcpServers
}

export interface MatrixAgentHomeReconcile extends Omit<MatrixAgentHomeInput, 'agent'> {
  /** The root slot may briefly be ready before its stable agent principal is projected. */
  agent?: string
  /** Homes another participant on this Mac retains (the default agent, other agents). */
  reserved: readonly string[]
  /** Nothing of this agent runs here (no backend, turn or start): its home may change now. */
  quiescent: boolean
  log(line: string): void
  now?(): number
}

export interface MatrixAgentHomeDecision {
  /** The home to retain and run in. */
  home: string
  /** Set when an adoption chose `home` over this near-empty one (left in place). */
  adoptedFrom?: string
}

function adoptionCandidate(
  input: MatrixAgentHomeReconcile,
  current: string,
  taken: ReadonlySet<string>
): { home?: string; ambiguous?: number; template?: boolean } {
  const own = matrixAgentHomeEvidence(current)

  if (!own.exists || !own.soul || matrixAgentHomeHasContent(own)) {
    return {}
  }

  // A persona that is still a stock Hermes template identifies nobody: two agents that never
  // got their own persona share these bytes, so matching on them could hand one agent
  // another's memory and tools. Only a persona seeded from the agent's own definition counts.
  if (isTemplateSoul(path.join(current, 'SOUL.md'))) {
    return { template: true }
  }

  let names: string[]

  try {
    names = readdirSync(input.profiles, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && HEX.test(entry.name))
      .map(entry => entry.name)
  } catch {
    return {}
  }

  const matches = names
    .map(name => path.join(input.profiles, name))
    .filter(home => home !== current && !taken.has(path.resolve(home)))
    .filter(home => {
      const evidence = matrixAgentHomeEvidence(home)

      return (
        evidence.soul?.sha256 === own.soul!.sha256 &&
        evidence.soul.mtimeMs < own.soul!.mtimeMs &&
        matrixAgentHomeHasContent(evidence)
      )
    })

  // The same persona in a third home (another agent's, or a retained one) means the bytes
  // don't single this agent out either: refuse rather than guess.
  const sharing = names
    .map(name => path.join(input.profiles, name))
    .filter(home => matrixAgentHomeEvidence(home).soul?.sha256 === own.soul!.sha256).length

  if (matches.length === 1 && sharing > 2) {
    return { ambiguous: sharing - 1 }
  }

  return matches.length === 1 ? { home: matches[0] } : matches.length > 1 ? { ambiguous: matches.length } : {}
}

/** Hermes's own default persona, or the legacy comment-only template its installers wrote. */
const HERMES_TEMPLATE_SOUL_PREFIXES = [
  'You are Hermes Agent, an intelligent AI assistant created by Nous Research.',
  '# Hermes Agent Persona'
]

function isTemplateSoul(file: string): boolean {
  try {
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim()

    return HERMES_TEMPLATE_SOUL_PREFIXES.some(prefix => text.startsWith(prefix))
  } catch {
    return true
  }
}

/**
 * Once per host start, before the home is retained: the home this agent's executor runs in, with
 * its binding recorded. Only while nothing of the agent runs:
 * - a binding that differs from the retained home wins (an adoption that did not finish, or a
 *   repair written into the index);
 * - with no binding yet, an earlier home of the same agent that holds its content is adopted
 *   over a near-empty current one (see the module comment).
 * A binding is recorded once its home exists. A new agent whose home is not made yet is bound
 * at once only when no other home here could later be adopted for it; otherwise a later start,
 * after its persona is seeded, decides. While something runs, nothing is recorded or changed.
 */
export function reconcileMatrixAgentHome(input: MatrixAgentHomeReconcile): MatrixAgentHomeDecision {
  // Without the stable agent identity there is no safe index key. Keep the exact retained home
  // for this executor, else its ordinary executor home, and do not read or write agent-homes.json.
  if (!input.agent) {
    const retained = input.retained?.executorId === input.executorId ? input.retained.home : undefined

    return { home: retained ?? matrixHermesHome(input, input.owner, input.executorId) }
  }

  const key = matrixAgentHomeKey(input.owner, input.agent)
  const index = readMatrixAgentHomes(input.profiles, input.log)
  const entry = index.homes[key]
  const reserved = new Set(input.reserved.map(home => path.resolve(home)))
  let bound = boundHome(input.profiles, entry)

  if (bound && reserved.has(path.resolve(bound))) {
    input.log(`[Matrix] agent ${input.agent.slice(0, 8)} home binding names another participant's home; ignored`)
    bound = undefined
  }

  const retained = input.retained && input.retained.executorId === input.executorId ? input.retained.home : undefined

  const current = retained ?? bound ?? matrixHermesHome(input, input.owner, input.executorId)

  if (!input.quiescent) {
    return { home: current }
  }

  // Homes bound to other agents, and everything another participant retains, stay theirs.
  const taken = new Set([
    ...reserved,
    ...Object.entries(index.homes)
      .filter(([other]) => other !== key)
      .map(([, value]) => path.resolve(input.profiles, value.home))
  ])

  let home = current
  let adoptedFrom: string | undefined

  if (bound && retained && bound !== retained) {
    home = bound
  } else if (!bound) {
    const candidate = adoptionCandidate(input, current, taken)

    if (candidate.home) {
      home = candidate.home
      adoptedFrom = current
      input.log(
        `[Matrix] agent ${input.agent.slice(0, 8)} home: its earlier home ${path.basename(home).slice(0, 12)} ` +
          `holds its memory and tools; using it, the empty ${path.basename(current).slice(0, 12)} is kept aside`
      )
    } else if (candidate.template) {
      input.log(`[Matrix] agent ${input.agent.slice(0, 8)} home: default persona; none adopted`)
    } else if (candidate.ambiguous) {
      input.log(
        `[Matrix] agent ${input.agent.slice(0, 8)} home: ${candidate.ambiguous} earlier homes match; none adopted`
      )
    }
  }

  const name = path.basename(home)

  if (
    entry?.home !== name &&
    HEX.test(name) &&
    path.resolve(path.dirname(home)) === path.resolve(input.profiles) &&
    (isHome(input.profiles, home) || !anyAdoptable(input, home, taken))
  ) {
    try {
      const homes = readMatrixAgentHomes(input.profiles, input.log).homes

      writeMatrixAgentHomes(input.profiles, {
        v: 1,
        homes: {
          ...homes,
          [key]: {
            home: name,
            at: input.now?.() ?? Date.now(),
            ...(adoptedFrom ? { from: path.basename(adoptedFrom) } : {}),
            // Where the agent was made never changes with its home.
            ...(homes[key]?.hosted ? { hosted: true as const } : {})
          }
        }
      })
    } catch {
      // Unwritten: the retained record still holds this executor's home; a later start
      // records the binding.
      input.log(`[Matrix] agent ${input.agent.slice(0, 8)} home binding not written yet`)
    }
  }

  return { home, ...(adoptedFrom ? { adoptedFrom } : {}) }
}

/** Whether some other home here holds content that an agent could adopt (cheap; no persona). */
function anyAdoptable(input: MatrixAgentHomeReconcile, home: string, taken: ReadonlySet<string>): boolean {
  try {
    return readdirSync(input.profiles, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && HEX.test(entry.name))
      .map(entry => path.join(input.profiles, entry.name))
      .some(other => {
        if (other === home || taken.has(path.resolve(other))) {
          return false
        }

        const evidence = matrixAgentHomeEvidence(other)

        return Boolean(evidence.soul) && matrixAgentHomeHasContent(evidence)
      })
  } catch {
    return false
  }
}

/**
 * Whether this Mac is the agent's home device: it was created here (recorded at creation)
 * or imported here (its profile-import marker, which also covers agents made before the
 * record existed). A Mac that only installed the agent from its definition holds a guest
 * copy: its memory, files, tools and sessions live on the home device.
 */
export function matrixAgentHosted(input: { profiles: string; owner: string; agent: string; home: string }): boolean {
  if (readMatrixAgentHomes(input.profiles).homes[matrixAgentHomeKey(input.owner, input.agent)]?.hosted) {
    return true
  }

  try {
    return lstatSync(path.join(input.home, MATRIX_PROFILE_IMPORT_MARKER)).isFile()
  } catch {
    return false
  }
}

/** Record that the agent was created or imported on this Mac, with its home. */
export function markMatrixAgentHosted(input: { profiles: string; owner: string; agent: string; home: string }): void {
  const key = matrixAgentHomeKey(input.owner, input.agent)
  const homes = readMatrixAgentHomes(input.profiles).homes
  const entry = homes[key]

  if (entry?.hosted) {
    return
  }

  const name = path.basename(input.home)

  if (!HEX.test(name) || path.resolve(path.dirname(input.home)) !== path.resolve(input.profiles)) {
    throw new Error('matrix_runtime_configuration_invalid')
  }

  writeMatrixAgentHomes(input.profiles, {
    v: 1,
    homes: { ...homes, [key]: { ...(entry ?? { home: name, at: Date.now() }), hosted: true } }
  })
}
