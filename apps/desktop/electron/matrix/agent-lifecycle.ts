/**
 * Creating and retiring the person's other agents (
 * §2.7). Both are multi-step, cross the network and touch the vault, so each step is safe to
 * repeat and every unfinished one is recorded in the vault, to be resumed at the next launch.
 * Main supplies the steps' effects (MatrixAgentLifecycleDeps); this module owns their order.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { EncryptedStore } from '../encrypted-store'

import type { MatrixAgentCloudPlacement } from './agent-definition'
import type { MatrixProfileImport } from './profile-import'

/** An agent being created. The record stays until the agent answers in its room. */
export interface MatrixAgentCreation {
  requestId: string
  name: string
  persona: string
  step: 'create' | 'define' | 'room' | 'import' | 'enroll' | 'connect' | 'cloud'
  profileImport?: MatrixProfileImport
  /** The confirmed 60,000-Proton hire for the third+ agent (agent-definition.ts). */
  hireConfirmed?: boolean
  /** The platform's answer to the versioned create: `placed`/`pending_trust` mean the cloud
   * owns the agent's room and executor, so this Mac runs neither (agent-definition.ts). */
  cloudPlacement?: MatrixAgentCloudPlacement
  principal?: string
  assistantId?: string
  matrixUser?: string
  roomId?: string
}

/** A creation past its first step: the platform's agent exists. */
export type MatrixCreatedAgent = MatrixAgentCreation & { principal: string; assistantId: string; matrixUser: string }

/** What the renderer needs after creation: the room to open and the platform id used by
 * assistant-scoped services such as public handles. `roomId` is absent for an agent the
 * platform placed in the cloud: its room is the controller's and this Mac learns it from the
 * roster later, so there is nothing local to select now. */
export interface MatrixCreatedAgentResult {
  principal: string
  roomId?: string
  assistantId: string
}

/** The platform owns a placed agent: no local room, executor setup, connect or profile import. */
const cloudPlaced = (placement: MatrixAgentCloudPlacement | undefined) =>
  placement === 'placed' || placement === 'pending_trust'

export type MatrixAgentSessionCleanup = 'complete' | 'pending' | 'unconfirmed'

/** A retirement the person confirmed: recorded before the platform is asked, so a quit at any
 * point finishes it (the platform's retire repeats safely). */
export interface MatrixAgentRetirement {
  principal: string
  assistantId: string
  /** The physical root vault slot, which has different local cleanup from a named agent. */
  rootCustody?: true
}

/** Why the platform refused to make an agent: final, so nothing is kept to repeat. */
export type MatrixAgentRefusal = 'name' | 'limit' | 'account' | 'short' | { hire: number }

/** The platform refused the create for good (the name, the limit, the account, a hire). */
export class MatrixAgentCreationRefused extends Error {
  constructor(readonly reason: MatrixAgentRefusal) {
    super(`matrix_agent_refused_${typeof reason === 'string' ? reason : 'hire'}`)
    this.name = 'MatrixAgentCreationRefused'
  }
}

export const MATRIX_AGENT_CREATIONS = 'matrix-agent-creations'
/** Retirements not finished on the platform or on this Mac. */
export const MATRIX_AGENT_RETIREMENTS = 'matrix-agent-retirements'
/** At most eight sessions are revoked per retire call; a repeated call continues. */
const RETIRE_ROUNDS = 8

export interface MatrixAgentLifecycleDeps {
  store: Pick<EncryptedStore, 'getItem' | 'setItem' | 'removeItem' | 'failureCode'>
  /** A refusal from createOnPlatform that is final, else undefined (worth repeating). */
  refusal(error: unknown): MatrixAgentRefusal | undefined
  /** POST /agents: the same request ID returns the same agent. `cloudPlacement` is the
   * platform's answer to the versioned create (atum.agent-lifecycle/1.1 A3). */
  createOnPlatform(input: { requestId: string; displayName: string; hireConfirmed?: boolean }): Promise<{
    principal: string
    id: string
    matrixUser: string
    cloudPlacement?: MatrixAgentCloudPlacement
  }>
  /** The persona into the agent's definition on the platform; a repeat changes nothing. */
  define(creation: MatrixCreatedAgent): Promise<void>
  /** The agent's runtime exists (made once) and knows its roster entry. */
  runtime(creation: MatrixCreatedAgent): void
  /** The owner's private room with the agent: the existing one, else a new one. */
  room(creation: MatrixCreatedAgent): Promise<string>
  /** A selected profile into a newly enrolled, stopped executor home, before setup. */
  importProfile?(creation: MatrixCreatedAgent): Promise<void>
  /** This Mac's executor, host, persona and model; true once the agent's host is ready. */
  setUp(principal: string): Promise<boolean>
  /** The agent joins its room and the two devices verify each other. */
  connect(principal: string, roomId: string): Promise<void>
  /** The agent answers in its room: its gate starts. */
  started(principal: string): void
  /** The platform placed the agent in the cloud (possibly still `pending_trust`): this Mac
   * must leave its room and executor to the cloud, including while the roster still says
   * `local`. Idempotent; called again when a resumed record reaches `cloud`. */
  placed?(creation: MatrixCreatedAgent): void
  /** DELETE /agents/{id}: final. */
  retireOnPlatform(assistantId: string): Promise<MatrixAgentSessionCleanup>
  /** This Mac's part of a retirement, safe to repeat. */
  forgetLocally(principal: string, rootCustody?: true): Promise<void>
  log(line: string): void
  randomId(): string
}

export class MatrixAgentLifecycle {
  private readonly running = new Map<string, Promise<MatrixCreatedAgentResult>>()

  constructor(private readonly deps: MatrixAgentLifecycleDeps) {}

  get busy(): boolean {
    return this.running.size > 0
  }

  /** Creates another agent; resolves with it and its room once it answers there. */
  create(name: string, persona: string, profileImport?: MatrixProfileImport, hireConfirmed?: boolean): Promise<MatrixCreatedAgentResult> {
    // Selecting the same preparation after an interrupted import resumes its durable
    // request, including an ambiguous platform response, rather than creating a twin.
    const interrupted =
      profileImport &&
      this.list<MatrixAgentCreation>(MATRIX_AGENT_CREATIONS).find(
        each =>
          each.profileImport?.prepared === profileImport.prepared && each.profileImport.sha256 === profileImport.sha256
      )

    if (interrupted) {
      return this.run(interrupted)
    }

    const creation: MatrixAgentCreation = {
      requestId: this.deps.randomId(),
      name,
      persona,
      step: 'create',
      ...(profileImport ? { profileImport } : {}),
      ...(hireConfirmed ? { hireConfirmed } : {})
    }

    this.save(creation)

    return this.run(creation)
  }

  /** Principals of agents being created: newer than any roster read before they finish. */
  creating(): Set<string> {
    return new Set(this.list<MatrixAgentCreation>(MATRIX_AGENT_CREATIONS).flatMap(each => each.principal ?? []))
  }

  /** Roster/background readiness may not start an import before its files are installed. */
  blocksRuntime(principal: string | undefined): boolean {
    return Boolean(
      principal &&
      this.list<MatrixAgentCreation>(MATRIX_AGENT_CREATIONS).some(
        each => each.principal === principal && each.profileImport && !['enroll', 'connect'].includes(each.step)
      )
    )
  }

  /** Retires an agent for good: recorded first, then the platform, then this Mac. */
  async retire(principal: string, assistantId: string, rootCustody = false): Promise<MatrixAgentSessionCleanup> {
    // A creation of the same agent never resumes: the agent is going for good.
    this.write(
      MATRIX_AGENT_CREATIONS,
      this.list<MatrixAgentCreation>(MATRIX_AGENT_CREATIONS).filter(each => each.principal !== principal)
    )
    this.write(MATRIX_AGENT_RETIREMENTS, [
      ...this.list<MatrixAgentRetirement>(MATRIX_AGENT_RETIREMENTS).filter(each => each.principal !== principal),
      { principal, assistantId, ...(rootCustody ? { rootCustody: true as const } : {}) }
    ])

    return this.finishRetirement({ principal, assistantId, ...(rootCustody ? { rootCustody: true as const } : {}) })
  }

  /** Agents being retired: a roster read meanwhile must not bring them back. */
  retiring(): Set<string> {
    return new Set(this.list<MatrixAgentRetirement>(MATRIX_AGENT_RETIREMENTS).map(each => each.principal))
  }

  /** At launch, once the roster is known: every creation and retirement a quit interrupted. */
  resume(): void {
    for (const retirement of this.list<MatrixAgentRetirement>(MATRIX_AGENT_RETIREMENTS)) {
      void this.finishRetirement(retirement).catch(() =>
        this.deps.log(`[Matrix] agent ${retirement.principal.slice(0, 8)} retirement still pending`)
      )
    }

    const retiring = this.retiring()

    for (const creation of this.list<MatrixAgentCreation>(MATRIX_AGENT_CREATIONS)) {
      if (creation.principal && retiring.has(creation.principal)) {
        continue
      }

      void this.run(creation).catch(() => this.deps.log(`[Matrix] agent creation still pending at ${creation.step}`))
    }
  }

  /** Runs a creation from its current step, once at a time. */
  private run(creation: MatrixAgentCreation): Promise<MatrixCreatedAgentResult> {
    let pending = this.running.get(creation.requestId)

    if (!pending) {
      pending = this.steps({ ...creation }).finally(() => this.running.delete(creation.requestId))
      this.running.set(creation.requestId, pending)
    }

    return pending
  }

  private async steps(creation: MatrixAgentCreation): Promise<MatrixCreatedAgentResult> {
    const advance = (step: MatrixAgentCreation['step'], values: Partial<MatrixAgentCreation> = {}) => {
      Object.assign(creation, values, { step })
      this.save(creation)
    }

    if (creation.step === 'create') {
      let agent: Awaited<ReturnType<MatrixAgentLifecycleDeps['createOnPlatform']>>

      try {
        agent = await this.deps.createOnPlatform({ requestId: creation.requestId, displayName: creation.name,
          ...(creation.hireConfirmed ? { hireConfirmed: true } : {}) })
      } catch (error) {
        const refused = this.deps.refusal(error)

        // Refused for good: nothing was made, so nothing is kept to repeat.
        if (refused) {
          this.write(
            MATRIX_AGENT_CREATIONS,
            this.list<MatrixAgentCreation>(MATRIX_AGENT_CREATIONS).filter(each => each.requestId !== creation.requestId)
          )

          throw new MatrixAgentCreationRefused(refused)
        }

        throw error
      }

      advance('define', {
        principal: agent.principal,
        assistantId: agent.id,
        matrixUser: agent.matrixUser,
        ...(agent.cloudPlacement === undefined ? {} : { cloudPlacement: agent.cloudPlacement })
      })
      this.deps.log(`[Matrix] agent ${agent.principal.slice(0, 8)} created`)
    }

    if (!creation.principal || !creation.assistantId || !creation.matrixUser) {
      throw new Error('matrix_vault_invalid')
    }

    const created = creation as MatrixCreatedAgent
    this.deps.runtime(created)

    // The cloud owns it from the create's answer on, before any step this Mac still owes it
    // (the persona write): its listing still says `local` until the controller trusts the
    // enrollment, so the roster alone must not start a local executor meanwhile.
    if (cloudPlaced(created.cloudPlacement)) {
      this.deps.placed?.(created)
    }

    if (created.step === 'define') {
      await this.deps.define(created)
      advance(cloudPlaced(created.cloudPlacement) ? 'cloud' : 'room')
    }

    // The platform placed it: it owns the room, the executor enrollment and the connect. The
    // persona above is revision-fenced and still lands; no profile import runs either.
    if (created.step === 'cloud') {
      this.write(
        MATRIX_AGENT_CREATIONS,
        this.list<MatrixAgentCreation>(MATRIX_AGENT_CREATIONS).filter(each => each.requestId !== created.requestId)
      )
      this.deps.log(`[Matrix] agent ${created.principal.slice(0, 8)} answers in the cloud`)

      return { principal: created.principal, assistantId: created.assistantId }
    }

    if (created.step === 'room') {
      advance(created.profileImport ? 'import' : 'enroll', { roomId: await this.deps.room(created) })
    }

    if (created.step === 'import') {
      if (!created.profileImport || !created.roomId || !this.deps.importProfile) {
        throw new Error('matrix_profile_import_invalid')
      }

      await this.deps.importProfile(created)
      advance('enroll')
    }

    // A durable connect record proves setup completed in the previous process,
    // not that this process has an SDK host. Recreate that local state before
    // connecting; profile installation and platform creation stay skipped.
    if (created.step === 'enroll' || created.step === 'connect') {
      if (!(await this.deps.setUp(created.principal))) {
        throw new Error('matrix_agent_unavailable')
      }

      if (created.step === 'enroll') {
        advance('connect')
      }
    }

    if (!created.roomId) {
      throw new Error('matrix_vault_invalid')
    }

    await this.deps.connect(created.principal, created.roomId)
    this.write(
      MATRIX_AGENT_CREATIONS,
      this.list<MatrixAgentCreation>(MATRIX_AGENT_CREATIONS).filter(each => each.requestId !== created.requestId)
    )
    this.deps.started(created.principal)
    this.deps.log(`[Matrix] agent ${created.principal.slice(0, 8)} answers in its room`)

    return { principal: created.principal, roomId: created.roomId, assistantId: created.assistantId }
  }

  /** The platform (a repeat of a retire is safe), then this Mac, then the record goes. */
  private async finishRetirement({
    principal,
    assistantId,
    rootCustody
  }: MatrixAgentRetirement): Promise<MatrixAgentSessionCleanup> {
    let cleanup = await this.deps.retireOnPlatform(assistantId)

    for (let round = 1; cleanup === 'pending' && round < RETIRE_ROUNDS; round++) {
      cleanup = await this.deps.retireOnPlatform(assistantId)
    }

    this.deps.log(`[Matrix] agent ${principal.slice(0, 8)} retired: sessions ${cleanup}`)

    if (rootCustody) {
      await this.deps.forgetLocally(principal, true)
    } else {
      await this.deps.forgetLocally(principal)
    }

    this.write(
      MATRIX_AGENT_RETIREMENTS,
      this.list<MatrixAgentRetirement>(MATRIX_AGENT_RETIREMENTS).filter(each => each.principal !== principal)
    )
    this.deps.log(`[Matrix] agent ${principal.slice(0, 8)} removed from this Mac`)

    return cleanup
  }

  private save(creation: MatrixAgentCreation) {
    this.write(MATRIX_AGENT_CREATIONS, [
      ...this.list<MatrixAgentCreation>(MATRIX_AGENT_CREATIONS).filter(each => each.requestId !== creation.requestId),
      creation
    ])
  }

  private list<T>(key: string): T[] {
    const raw = this.deps.store.getItem(key)

    if (this.deps.store.failureCode()) {
      throw new Error('matrix_vault_unavailable')
    }

    const value: unknown = raw ? JSON.parse(raw) : []

    return Array.isArray(value) ? (value as T[]) : []
  }

  private write(key: string, values: unknown[]) {
    if (values.length) {
      this.deps.store.setItem(key, JSON.stringify(values))
    } else {
      this.deps.store.removeItem(key)
    }
  }
}

/**
 * The persona an agent falls back to when its definition has none (the primary assistant's
 * Atum persona), and which SOUL.md already in its home carries nobody's intent and may be
 * replaced by it (Hermes's untouched default, written before the persona arrived).
 */
export interface MatrixAgentSoulFallback {
  soul: string
  replaces(existing: string): boolean
}

/**
 * The agent's persona as its Hermes SOUL.md in `home`, when none is there yet: the first
 * setup on this Mac, before its Hermes first runs and writes Hermes's own default. A SOUL.md
 * already there (Hermes's, or the person's edits) is never replaced, except one the
 * `fallback` says carries nobody's intent. `soul` reads the agent's definition; its failure
 * fails the seeding, so a persona is never silently lost. Without a persona in the
 * definition, the `fallback`'s is written (the primary assistant's), else nothing.
 */
export async function seedMatrixAgentSoul(
  home: string,
  soul: () => Promise<string | undefined>,
  fallback?: MatrixAgentSoulFallback
): Promise<void> {
  const file = path.join(home, 'SOUL.md')
  const existing = existsSync(file)

  if (existing && !(fallback && replaceable(file, fallback))) {
    return
  }

  let declared: string | undefined

  try {
    declared = (await soul())?.trim()
  } catch (error) {
    // A home that already has a persona keeps it until the definition can be read again:
    // replacing Hermes's default must never stop the assistant from starting.
    if (existing) {
      return
    }

    throw error
  }

  const text = declared || fallback?.soul.trim()

  if (!text) {
    return
  }

  mkdirSync(home, { recursive: true, mode: 0o700 })

  if (existing) {
    // Swapped in whole, and only while the file still says what was judged replaceable.
    const staged = path.join(home, `.SOUL.md.${process.pid}.${Date.now()}`)
    writeFileSync(staged, `${text}\n`, { flag: 'wx', mode: 0o600 })

    try {
      if (!replaceable(file, fallback!)) {
        return
      }

      renameSync(staged, file)
      markSoulApplied(home, text)
    } finally {
      rmSync(staged, { force: true })
    }

    return
  }

  try {
    writeFileSync(file, `${text}\n`, { flag: 'wx', mode: 0o600 })
    markSoulApplied(home, text)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }
}

/** Beside SOUL.md: the digest of the persona Atum last wrote there. A SOUL.md that still
 * matches it carries nobody's edits, so a newer persona from the definition may replace it. */
const SOUL_APPLIED = '.SOUL.md.applied'
const ATUM_INSTRUCTIONS_MARKER = /^<!-- atum:instructions revision=(0|[1-9][0-9]{0,15})(?: tag=[A-Za-z0-9_-]{22})? -->\n/u

function soulDigest(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n?/g, '\n').trim()).digest('hex')
}

function markSoulApplied(home: string, text: string) {
  try {
    writeFileSync(path.join(home, SOUL_APPLIED), `${soulDigest(text)}\n`, { mode: 0o600 })
  } catch {
    // Without the marker a later persona is simply not applied here (the safe direction).
  }
}

/** The instructions as Hermes sees them: normalized and without a trusted-controller marker. */
export function matrixAgentSoulText(home: string): string | undefined {
  const current = readSoul(path.join(home, 'SOUL.md'))

  return current === undefined
    ? undefined
    : current
        .replace(/^\uFEFF/u, '')
        .replace(/\r\n?/gu, '\n')
        .replace(ATUM_INSTRUCTIONS_MARKER, '')
        .trim()
}

/** Mark an exact platform/write-back value as Atum-owned for later card reconciliation. */
export function markMatrixAgentSoulApplied(home: string, text: string): void {
  markSoulApplied(home, text)
}

/**
 * Replace one known SOUL value atomically. Used when a revision-fenced write lands, or when a
 * concurrent card edit wins. A different concurrent local edit is never overwritten.
 */
export function replaceMatrixAgentSoul(home: string, expected: string, target: string): boolean {
  const file = path.join(home, 'SOUL.md')
  const current = readSoul(file)

  if (current !== expected) {
    return false
  }

  const text = target.replace(/\r\n?/gu, '\n').trim()
  if (!text) {
    return false
  }

  const staged = path.join(home, `.SOUL.md.${process.pid}.${Date.now()}`)
  writeFileSync(staged, `${text}\n`, { flag: 'wx', mode: 0o600 })

  try {
    if (readSoul(file) !== expected) {
      return false
    }

    renameSync(staged, file)
    markSoulApplied(home, text)

    return true
  } finally {
    rmSync(staged, { force: true })
  }
}

function readSoul(file: string): string | undefined {
  try {
    const stats = lstatSync(file)

    return stats.isFile() && stats.size <= 64 * 1024 ? readFileSync(file, 'utf8') : undefined
  } catch {
    return undefined
  }
}

/**
 * A persona changed on the assistant card reaches this Mac's copy of the assistant
 * (2026-10-05). SOUL.md is replaced only when it still says what Atum last wrote there
 * (its digest marker), or what the `fallback` says carries nobody's intent; a persona the
 * person edited by hand on this Mac is kept. A home without SOUL.md is left to
 * `seedMatrixAgentSoul`. New conversations read the new persona; a running one keeps its own.
 *
 * - `matches`: already the definition's (the marker is brought up to date);
 * - `applied`: replaced with the definition's;
 * - `kept`: left as it is (edited here, unreadable, or nothing to apply);
 * - `absent`: no SOUL.md yet.
 */
export function reconcileMatrixAgentSoul(
  home: string,
  declared: string | undefined,
  fallback?: MatrixAgentSoulFallback
): 'matches' | 'applied' | 'kept' | 'absent' {
  const file = path.join(home, 'SOUL.md')

  if (!existsSync(file)) {
    return 'absent'
  }

  const current = readSoul(file)
  const target = declared?.trim() || fallback?.soul.trim()

  if (current === undefined || !target) {
    return 'kept'
  }

  const normalized = current
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .replace(ATUM_INSTRUCTIONS_MARKER, '')
    .trim()

  if (normalized === target) {
    // A cloud-portable home may carry the controller's authenticated marker. The Mac does
    // not use that tag as authority; once the platform definition confirms the same text,
    // store the ordinary Mac form and adopt it under this Mac's digest marker.
    if (current.replace(/\r\n?/gu, '\n').trim() !== target) {
      replaceMatrixAgentSoul(home, current, target)
    }
    markSoulApplied(home, target)

    return 'matches'
  }

  let marker: string | undefined

  try {
    marker = readFileSync(path.join(home, SOUL_APPLIED), 'utf8').trim()
  } catch {
    marker = undefined
  }

  const ours =
    marker === soulDigest(current) ||
    Boolean(fallback && (fallback.replaces(current) || normalized === fallback.soul.trim()))

  if (!ours) {
    return 'kept'
  }

  const staged = path.join(home, `.SOUL.md.${process.pid}.${Date.now()}`)
  writeFileSync(staged, `${target}\n`, { flag: 'wx', mode: 0o600 })

  try {
    // Still what was judged replaceable: a concurrent hand edit wins.
    if (readSoul(file) !== current) {
      return 'kept'
    }

    renameSync(staged, file)
    markSoulApplied(home, target)

    return 'applied'
  } finally {
    rmSync(staged, { force: true })
  }
}

/** A regular, small SOUL.md the fallback may replace; anything unreadable is kept. */
function replaceable(file: string, fallback: MatrixAgentSoulFallback): boolean {
  try {
    const stats = lstatSync(file)

    return stats.isFile() && stats.size <= 64 * 1024 && fallback.replaces(readFileSync(file, 'utf8'))
  } catch {
    return false
  }
}
