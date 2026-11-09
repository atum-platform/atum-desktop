/** An agent's content on this Mac (AW, G1-09): its definition persona is checked and its skills
 * are materialized in its own Hermes home in the background, with a truthful status per agent.
 * Main owns the account, grant and home; `hermes_cli/atum_agent_content.py` owns every skill and
 * receipt write this materializer makes. `agent-lifecycle.ts` separately seeds/reconciles the
 * persona while Hermes owns ordinary runtime writes. Portable MEMORY.md / USER.md entries use
 * the same conservative three-way account relay as AtumAgentSync; this does not copy a cloud
 * runtime home, sessions, credentials or local-only memory into the Matrix home. */
import { lstatSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import type { AtumCloudMemory, AtumMemorySnapshot, AtumSkillBundle } from '../../../shared/atum-agent-content'
import type { MatrixAgentContentView } from '../../../shared/matrix'
import { MatrixAgentDefinitionError, type MatrixAgentDefinitionSnapshot } from '../agent-definition'
import { matrixHermesHome, type MatrixHermesRuntimeConfig } from '../hermes-runtime'

import { MatrixAgentContentHelperError, runMatrixAgentContentHelper } from './helper'
import { type MatrixAgentMemoryState, syncMatrixAgentMemory } from './memory'
import {
  MATRIX_AGENT_SKILL_STATES,
  type MatrixAgentSkillResult,
  type MatrixAgentSkillsReport,
  type MatrixAgentSkillState,
  syncMatrixAgentSkills
} from './skills'

export type { MatrixAgentSkillResult, MatrixAgentSkillState } from './skills'

/** One agent on this Mac, as main knows it at setup. */
export interface MatrixAgentContentTarget {
  principal: string
  assistantId: string
  /** Its dedicated Hermes home on this Mac (agent-home.ts: bound to the agent, else matrixHermesHome). */
  home: string
  runtime: MatrixHermesRuntimeConfig
  /** False once its runtime here is stopped for good (retired, signed out, quitting). */
  live(): boolean
  definition(signal: AbortSignal): Promise<MatrixAgentDefinitionSnapshot>
  skill(sha256: string, signal: AbortSignal): Promise<AtumSkillBundle>
  memory?(signal: AbortSignal): Promise<AtumCloudMemory>
  memoryAllowed?(): boolean
  writeMemory?(
    input: { expected_revision: number; enabled: boolean; snapshot: AtumMemorySnapshot },
    signal: AbortSignal
  ): Promise<AtumCloudMemory>
}

/** What main knows about an agent at its setup; `matrixAgentContentTarget` decides from it. */
export interface MatrixAgentContentSource {
  /** Legacy default marker, ignored: definition and custody own content eligibility. */
  isDefault?: boolean
  principal?: string
  assistantId?: string
  /** This Mac's enrolled executor for the agent, once enrolled here. */
  identity?: { principal: string; executorId: string }
  runtime?: MatrixHermesRuntimeConfig
  /** The agent's home when it is not its executor's own (agent-home.ts binding). */
  home?: string
  live(): boolean
  definition(assistantId: string, signal: AbortSignal): Promise<MatrixAgentDefinitionSnapshot>
  skill(assistantId: string, sha256: string, signal: AbortSignal): Promise<AtumSkillBundle>
  memory?(assistantId: string, signal: AbortSignal): Promise<AtumCloudMemory>
  memoryAllowed?(): boolean
  writeMemory?(
    assistantId: string,
    input: { expected_revision: number; enabled: boolean; snapshot: AtumMemorySnapshot },
    signal: AbortSignal
  ): Promise<AtumCloudMemory>
}

/** The enrolled agent whose content this Mac brings, regardless of its default role or
 * physical custody slot. Its home is the one its Hermes runs in (matrixHermesHome). */
export function matrixAgentContentTarget(source: MatrixAgentContentSource): MatrixAgentContentTarget | undefined {
  const { principal, assistantId, identity, runtime } = source

  if (!principal || !assistantId || !identity || !runtime) {
    return undefined
  }

  return {
    principal,
    assistantId,
    home: source.home ?? matrixHermesHome(runtime, identity.principal, identity.executorId),
    runtime,
    live: () => source.live(),
    definition: signal => source.definition(assistantId, signal),
    skill: (sha256, signal) => source.skill(assistantId, sha256, signal),
    ...(source.memory && source.writeMemory
      ? {
          memory: (signal: AbortSignal) => source.memory!(assistantId, signal),
          ...(source.memoryAllowed ? { memoryAllowed: source.memoryAllowed } : {}),
          writeMemory: (
            input: { expected_revision: number; enabled: boolean; snapshot: AtumMemorySnapshot },
            signal: AbortSignal
          ) => source.writeMemory!(assistantId, input, signal)
        }
      : {})
  }
}

/**
 * - `complete`: every declared skill is here with the account's bytes (or ships with this Mac
 *   with the same bytes), and the persona matches;
 * - `differs`: nothing is missing, but some content here is deliberately not the account's:
 *   a local edit, this Mac's version of a shipped skill, a removal, a changed persona;
 * - `incomplete`: some declared content is not here (not downloadable, refused, blocked);
 * - `error`: it could not be checked this time; the last counts are kept.
 */
export type MatrixAgentContentState = MatrixAgentContentView['state']

export type MatrixAgentPersonaState = NonNullable<MatrixAgentContentView['persona']>

export interface MatrixAgentContentStatus extends MatrixAgentContentView {
  principal: string
  assistantId: string
}

const INCOMPLETE: readonly MatrixAgentSkillState[] = ['missing', 'unavailable', 'unsupported', 'collision', 'blocked']
const DIFFERS: readonly MatrixAgentSkillState[] = ['different', 'bundled_version', 'suppressed']
const MAXIMUM_PERSONA_BYTES = 1024 * 1024

const LABELS: Record<MatrixAgentSkillState, string> = {
  installed: 'installed',
  bundled: 'shipped',
  bundled_version: "shipped at this Mac's version",
  different: 'different here',
  suppressed: 'removed here',
  collision: 'name taken here',
  blocked: 'blocked',
  missing: 'missing',
  unsupported: 'refused',
  unavailable: 'not downloadable'
}

export interface MatrixAgentContentOptions {
  log(line: string): void
  /** Any status changed (for main to publish, once a view carries it). */
  changed?(): void
  now?(): number
  helper?: typeof runMatrixAgentContentHelper
  memoryIntervalMs?: number
}

const MATRIX_AGENT_MEMORY_SYNC_INTERVAL_MS = 60_000

export class MatrixAgentContent {
  private readonly current = new Map<string, MatrixAgentContentStatus>()
  private readonly targets = new Map<string, MatrixAgentContentTarget>()
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>()
  private readonly memoryRunning = new Map<string, { controller: AbortController; done: Promise<void> }>()
  private readonly memoryStates = new Map<string, MatrixAgentMemoryState>()
  private memoryTimer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly options: MatrixAgentContentOptions) {}

  /** Starts one agent's content in the background and never waits for it, so content can never
   * delay an agent's readiness. Nothing to do without a target. */
  start(target: MatrixAgentContentTarget | undefined): void {
    if (target) {
      void this.sync(target)
    }
  }

  /** Brings one agent's content up to its definition. A call while one runs joins it. */
  sync(target: MatrixAgentContentTarget): Promise<void> {
    if (!target.live()) {
      return Promise.resolve()
    }

    const previous = this.targets.get(target.principal)

    if (previous && (!previous.live() || !sameHome(previous, target))) {
      this.forget(target.principal)
    }

    const running = this.running.get(target.principal)

    if (running) {
      return running.done
    }

    const controller = new AbortController()
    this.targets.set(target.principal, target)
    this.ensureMemoryTimer()
    void this.syncMemory(target)

    const done = this.run(target, controller.signal)
      // Main starts this without waiting on it: nothing may escape as an unhandled rejection.
      .catch(() => this.options.log(`[Matrix] agent ${target.principal.slice(0, 8)} content check failed unexpectedly`))
      .finally(() => {
        if (this.running.get(target.principal)?.controller === controller) {
          this.running.delete(target.principal)
        }
      })

    this.running.set(target.principal, { controller, done })

    return done
  }

  /** A retired or removed agent: its work stops and its status goes. Its home is untouched. */
  forget(principal: string): void {
    this.running.get(principal)?.controller.abort(new Error('matrix_agent_content_cancelled'))
    this.memoryRunning.get(principal)?.controller.abort(new Error('matrix_agent_content_cancelled'))
    this.running.delete(principal)
    this.memoryRunning.delete(principal)
    this.memoryStates.delete(principal)
    this.targets.delete(principal)

    if (this.current.delete(principal)) {
      this.options.changed?.()
    }

    this.stopMemoryTimerIfIdle()
  }

  /** Keeps only these agents (the roster's), as after a sign-out or a roster read. */
  retain(principals: Iterable<string>): void {
    const keep = new Set(principals)

    for (const principal of new Set([
      ...this.current.keys(),
      ...this.targets.keys(),
      ...this.running.keys(),
      ...this.memoryRunning.keys()
    ])) {
      if (!keep.has(principal)) {
        this.forget(principal)
      }
    }
  }

  /** Sign-out: no agent's work or status outlives the account. */
  clear(): void {
    this.retain([])
  }

  /**
   * This agent's content (persona, skills, memories) is being brought up to its definition right now, so files of its home are
   * being written. A checkpoint's barrier does not hold a snapshot over it (agent-home-placement/at-rest.ts): it tries again at
   * the next quiet moment.
   */
  writing(principal: string): boolean {
    return this.running.has(principal) || this.memoryRunning.has(principal)
  }

  status(principal: string): MatrixAgentContentStatus | undefined {
    if (!this.targets.get(principal)?.live()) {
      return undefined
    }

    const status = this.current.get(principal)

    return status && structuredClone(status)
  }

  statuses(): MatrixAgentContentStatus[] {
    return [...this.current.keys()].flatMap(principal => {
      const status = this.status(principal)

      return status ? [status] : []
    })
  }

  /** A display projection only for the exact currently enrolled home. */
  view(target: MatrixAgentContentTarget | undefined): MatrixAgentContentView | undefined {
    const checked = target && this.targets.get(target.principal)

    if (!target?.live() || !checked || !sameHome(checked, target)) {
      return undefined
    }

    const status = this.status(target.principal)

    if (!status) {
      return undefined
    }

    const { state, definitionRevision, persona, skills, error, checkedAt } = status

    return {
      state,
      ...(definitionRevision !== undefined ? { definitionRevision } : {}),
      ...(persona ? { persona } : {}),
      ...(skills
        ? {
            skills: {
              declared: skills.declared,
              installedNow: skills.installedNow,
              receiptReset: skills.receiptReset,
              ...Object.fromEntries(
                MATRIX_AGENT_SKILL_STATES.flatMap(key => (skills[key] === undefined ? [] : [[key, skills[key]]]))
              )
            }
          }
        : {}),
      ...(error ? { error } : {}),
      ...(checkedAt !== undefined ? { checkedAt } : {})
    }
  }

  private async run(target: MatrixAgentContentTarget, signal: AbortSignal): Promise<void> {
    const live = () => !signal.aborted && target.live() && this.targets.get(target.principal) === target

    const set = (status: Omit<MatrixAgentContentStatus, 'principal' | 'assistantId'>) => {
      // A forgotten agent's late result never brings its status back.
      if (!live()) {
        return
      }

      this.current.set(target.principal, { principal: target.principal, assistantId: target.assistantId, ...status })
      this.options.changed?.()
    }

    const previous = this.current.get(target.principal)
    set({ ...(previous?.assistantId === target.assistantId ? withoutIdentity(previous) : {}), state: 'checking' })

    try {
      const snapshot = await target
        .definition(AbortSignal.any([signal, AbortSignal.timeout(20_000)]))
        .catch((error: unknown) => {
          throw new DefinitionUnreadable(error)
        })

      if (!live()) {
        return
      }

      const declared = snapshot.definition?.skills ?? []
      mkdirSync(target.home, { recursive: true, mode: 0o700 })
      const helper = this.options.helper ?? runMatrixAgentContentHelper

      const report: MatrixAgentSkillsReport | undefined = declared.length
        ? await syncMatrixAgentSkills(declared, {
            check: request => helper(target.runtime, target.home, 'skills-check', request, signal),
            install: request => helper(target.runtime, target.home, 'skills-install', request, signal),
            fetch: sha256 => target.skill(sha256, AbortSignal.any([signal, AbortSignal.timeout(60_000)])),
            live
          })
        : { skills: [], receiptReset: false }

      if (!report || !live()) {
        return
      }

      const persona = matrixAgentPersona(target.home, snapshot.definition?.soul)
      const skills = countSkills(report)

      set({
        state: contentState(persona, report.skills),
        definitionRevision: snapshot.definitionRevision,
        persona,
        skills,
        checkedAt: (this.options.now ?? Date.now)()
      })
      this.options.log(describeMatrixAgentContent(target.principal, this.current.get(target.principal)))
    } catch (error) {
      if (!live()) {
        return
      }

      const reason =
        error instanceof DefinitionUnreadable
          ? error.reason instanceof MatrixAgentDefinitionError && error.reason.code === 'denied'
            ? 'denied'
            : 'definition'
          : error instanceof MatrixAgentContentHelperError && error.code === 'agent_content_busy'
            ? 'busy'
            : error instanceof MatrixAgentDefinitionError && error.code === 'denied'
              ? 'denied'
              : 'helper'

      set({ ...withoutIdentity(this.current.get(target.principal)), state: 'error', error: reason })
      this.options.log(`[Matrix] agent ${target.principal.slice(0, 8)} content not checked: ${reason}`)
    }
  }

  private syncMemory(target: MatrixAgentContentTarget): Promise<void> {
    if (!target.memory || !target.writeMemory || !target.live() || this.targets.get(target.principal) !== target) {
      return Promise.resolve()
    }

    const running = this.memoryRunning.get(target.principal)

    if (running) {
      return running.done
    }

    const controller = new AbortController()
    const done = syncMatrixAgentMemory(
      {
        home: target.home,
        runtime: target.runtime,
        live: target.live,
        memoryAllowed: target.memoryAllowed,
        memory: target.memory,
        writeMemory: target.writeMemory
      },
      controller.signal,
      this.options.helper ?? runMatrixAgentContentHelper
    )
      .then(state => {
        if (!target.live() || this.targets.get(target.principal) !== target) {
          return
        }

        if (this.memoryStates.get(target.principal) !== state) {
          this.memoryStates.set(target.principal, state)
          this.options.log(`[Matrix] agent ${target.principal.slice(0, 8)} memory sync: ${state}`)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.memoryRunning.get(target.principal)?.controller === controller) {
          this.memoryRunning.delete(target.principal)
        }
      })

    this.memoryRunning.set(target.principal, { controller, done })

    return done
  }

  private ensureMemoryTimer(): void {
    if (this.memoryTimer || ![...this.targets.values()].some(target => target.memory && target.writeMemory)) {
      return
    }

    const interval = this.options.memoryIntervalMs ?? MATRIX_AGENT_MEMORY_SYNC_INTERVAL_MS

    if (interval <= 0) {
      return
    }

    this.memoryTimer = setInterval(() => {
      for (const target of this.targets.values()) {
        void this.syncMemory(target)
      }
    }, interval)
    this.memoryTimer.unref?.()
  }

  private stopMemoryTimerIfIdle(): void {
    if (this.memoryTimer && ![...this.targets.values()].some(target => target.memory && target.writeMemory)) {
      clearInterval(this.memoryTimer)
      this.memoryTimer = undefined
    }
  }
}

function sameHome(left: MatrixAgentContentTarget, right: MatrixAgentContentTarget): boolean {
  return (
    left.assistantId === right.assistantId &&
    left.home === right.home &&
    left.runtime.python === right.runtime.python &&
    left.runtime.source === right.runtime.source &&
    left.runtime.profiles === right.runtime.profiles
  )
}

class DefinitionUnreadable extends Error {
  constructor(readonly reason: unknown) {
    super('matrix_agent_content_definition')
  }
}

function withoutIdentity(status: MatrixAgentContentStatus | undefined) {
  if (!status) {
    return {}
  }

  const { principal: _principal, assistantId: _assistantId, error: _error, ...rest } = status

  return rest
}

/** The persona here against the definition's, as `seedMatrixAgentSoul` writes it (trimmed). */
export function matrixAgentPersona(home: string, soul: string | undefined): MatrixAgentPersonaState {
  const declared = soul?.trim() ?? ''

  if (!declared) {
    return 'none'
  }

  const file = path.join(home, 'SOUL.md')

  try {
    const stats = lstatSync(file)

    if (!stats.isFile() || stats.size > MAXIMUM_PERSONA_BYTES) {
      return 'differs'
    }

    return readFileSync(file, 'utf8').trim() === declared ? 'matches' : 'differs'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'differs'
  }
}

function countSkills(report: MatrixAgentSkillsReport): NonNullable<MatrixAgentContentStatus['skills']> {
  const counts: NonNullable<MatrixAgentContentStatus['skills']> = {
    declared: report.skills.length,
    installedNow: report.skills.filter(skill => skill.state === 'installed' && skill.detail === 'new').length,
    receiptReset: report.receiptReset
  }

  for (const skill of report.skills) {
    counts[skill.state] = (counts[skill.state] ?? 0) + 1
  }

  return counts
}

function contentState(persona: MatrixAgentPersonaState, skills: MatrixAgentSkillResult[]): MatrixAgentContentState {
  if (persona === 'absent' || skills.some(skill => INCOMPLETE.includes(skill.state))) {
    return 'incomplete'
  }

  if (persona === 'differs' || skills.some(skill => DIFFERS.includes(skill.state))) {
    return 'differs'
  }

  return 'complete'
}

/** One diagnostic line: counts and closed words only, never a skill name or path. */
export function describeMatrixAgentContent(principal: string, status: MatrixAgentContentStatus | undefined): string {
  const skills = status?.skills

  const counts = MATRIX_AGENT_SKILL_STATES.filter(state => (skills?.[state] ?? 0) > 0).map(state => {
    const count = skills![state]!

    return state === 'installed' && skills!.installedNow
      ? `${count} ${LABELS[state]} (${skills!.installedNow} new)`
      : `${count} ${LABELS[state]}`
  })

  return (
    `[Matrix] agent ${principal.slice(0, 8)} content r${status?.definitionRevision ?? 0}: ` +
    `${skills?.declared ?? 0} skill${skills?.declared === 1 ? '' : 's'}${counts.length ? ` (${counts.join(', ')})` : ''}` +
    `${skills?.receiptReset ? ', receipt reset' : ''}; persona ${status?.persona ?? 'none'}: ${status?.state ?? 'checking'}`
  )
}
