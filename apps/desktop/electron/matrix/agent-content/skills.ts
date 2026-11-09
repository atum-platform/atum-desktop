/** Bringing one agent's declared skills to this Mac: ask the home what it lacks, download
 * exactly those bundles from the account, and hand them to the home's own installer.
 * Additive only : what is here is
 * never replaced, and every declared skill ends with a truthful state. */
import type { AtumSkillBundle } from '../../../shared/atum-agent-content'
import type { AtumPortableSkillRef } from '../../../shared/atum-agent-portability'
import type { MatrixAgentContentSkillState } from '../../../shared/matrix'
import { MatrixAgentDefinitionError } from '../agent-definition'

/** The home's states (`hermes_cli/atum_agent_content.py`), plus `unavailable`: the account
 * could not hand over its bytes. */
const DETAILS = {
  installed: [undefined, 'new'],
  bundled: [undefined],
  bundled_version: [undefined],
  different: ['local_edit', 'account_changed', 'not_a_skill', 'unreadable'],
  suppressed: ['removed', 'archived', 'bundled_opt_out', 'bundled_suppressed', 'bundled_removed'],
  collision: ['bundled', 'external', 'local'],
  blocked: ['bundled', 'inside_skill', 'not_a_directory', 'symlink'],
  missing: [undefined],
  unsupported: ['name', 'bundle', 'filesystem'],
  unavailable: ['denied', 'missing', 'conflict', 'unavailable', 'invalid']
} as const satisfies Record<MatrixAgentContentSkillState, readonly (string | undefined)[]>

export type MatrixAgentSkillState = keyof typeof DETAILS

export const MATRIX_AGENT_SKILL_STATES = Object.keys(DETAILS) as MatrixAgentSkillState[]

export interface MatrixAgentSkillResult {
  name: string
  sha256: string
  state: MatrixAgentSkillState
  detail?: string
}

export interface MatrixAgentSkillsReport {
  skills: MatrixAgentSkillResult[]
  /** The home's receipt was unreadable and set aside (removals made before are forgotten). */
  receiptReset: boolean
}

export interface MatrixAgentSkillsDependencies {
  check(request: { skills: AtumPortableSkillRef[] }): Promise<unknown>
  install(request: { skills: AtumPortableSkillRef[]; bundles: AtumSkillBundle[] }): Promise<unknown>
  /** The account's bundle with exactly this hash (`getMatrixAgentSkill`). */
  fetch(sha256: string): Promise<AtumSkillBundle>
  /** False once the agent stops here for good: nothing more is fetched or installed. */
  live(): boolean
}

const FETCH_CONCURRENCY = 4
// Each bundle is at most 3 MiB; one helper's stdin (and this process's memory) stays bounded.
export const MATRIX_AGENT_SKILL_BATCH_BYTES = 24 * 1024 * 1024

export class MatrixAgentContentInvalid extends Error {
  constructor() {
    super('matrix_agent_content_invalid')
    this.name = 'MatrixAgentContentInvalid'
  }
}

/** `undefined` when the agent stopped here before the work was done. */
export async function syncMatrixAgentSkills(
  skills: AtumPortableSkillRef[],
  deps: MatrixAgentSkillsDependencies
): Promise<MatrixAgentSkillsReport | undefined> {
  if (!deps.live()) {
    return undefined
  }

  let report = parseMatrixAgentSkillsReport(await deps.check({ skills }), skills)
  const wanted = [...new Set(report.skills.filter(skill => skill.state === 'missing').map(skill => skill.sha256))]
  const failures = new Map<string, string>()
  let batch: AtumSkillBundle[] = []
  let batchBytes = 0

  const install = async () => {
    if (!batch.length) {
      return
    }

    if (!deps.live()) {
      throw new Stopped()
    }

    const receiptReset = report.receiptReset
    report = parseMatrixAgentSkillsReport(await deps.install({ skills, bundles: batch }), skills)
    report.receiptReset ||= receiptReset
    batch = []
    batchBytes = 0
  }

  try {
    for (let index = 0; index < wanted.length; index += FETCH_CONCURRENCY) {
      if (!deps.live()) {
        return undefined
      }

      const group = wanted.slice(index, index + FETCH_CONCURRENCY)
      const fetched = await Promise.allSettled(group.map(sha256 => deps.fetch(sha256)))

      for (const [position, outcome] of fetched.entries()) {
        const sha256 = group[position]!

        if (outcome.status === 'rejected') {
          failures.set(sha256, failureDetail(outcome.reason))

          continue
        }

        const size = Buffer.byteLength(JSON.stringify(outcome.value))

        if (batchBytes + size > MATRIX_AGENT_SKILL_BATCH_BYTES) {
          await install()
        }

        batch.push(outcome.value)
        batchBytes += size
      }

      // A refused grant refuses every other download too: ask again at the next setup.
      if ([...failures.values()].includes('denied')) {
        for (const sha256 of wanted.slice(index + FETCH_CONCURRENCY)) {
          failures.set(sha256, 'denied')
        }

        break
      }
    }

    await install()
  } catch (error) {
    if (error instanceof Stopped) {
      return undefined
    }

    throw error
  }

  return {
    receiptReset: report.receiptReset,
    skills: report.skills.map(skill =>
      skill.state === 'missing' && failures.has(skill.sha256)
        ? { name: skill.name, sha256: skill.sha256, state: 'unavailable', detail: failures.get(skill.sha256) }
        : skill
    )
  }
}

class Stopped extends Error {}

function failureDetail(error: unknown): string {
  return error instanceof MatrixAgentDefinitionError ? error.code : 'unavailable'
}

/** The helper's report for exactly the requested skills, each once, in a known state. */
export function parseMatrixAgentSkillsReport(
  value: unknown,
  requested: AtumPortableSkillRef[]
): MatrixAgentSkillsReport {
  const root = value as Record<string, unknown> | null

  if (
    !root ||
    typeof root !== 'object' ||
    root.ok !== true ||
    (root.receipt !== 'ok' && root.receipt !== 'reset') ||
    !Array.isArray(root.skills) ||
    root.skills.length !== requested.length
  ) {
    throw new MatrixAgentContentInvalid()
  }

  const expected = new Map(requested.map(skill => [skill.name, skill.sha256]))
  const seen = new Set<string>()

  const skills = root.skills.map(raw => {
    const row = raw as Record<string, unknown> | null

    if (!row || typeof row !== 'object' || typeof row.name !== 'string' || seen.has(row.name)) {
      throw new MatrixAgentContentInvalid()
    }

    const state = row.state as MatrixAgentSkillState
    const detail = row.detail === undefined ? undefined : row.detail

    if (
      expected.get(row.name) !== row.sha256 ||
      !Object.hasOwn(DETAILS, state) ||
      !(DETAILS[state] as readonly unknown[]).includes(detail) ||
      state === 'unavailable'
    ) {
      throw new MatrixAgentContentInvalid()
    }

    seen.add(row.name)

    return {
      name: row.name,
      sha256: row.sha256 as string,
      state,
      ...(typeof detail === 'string' ? { detail } : {})
    }
  })

  return { skills, receiptReset: root.receipt === 'reset' }
}
