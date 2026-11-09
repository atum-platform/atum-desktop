/**
 * A hired Store assistant's own work (docs/shelf `detail.schedules`; launch plan Lane B,
 * B2): its jobs on its Hermes backend, the optional skills its hire installs, and the Store
 * binding of its scheduled runs.
 *
 * - Jobs (`reconcileMatrixStoreJobs`). For each hire in force, the assistant's backend has
 *   one job per spec, named `atum-store/<item>/<schedule>`, delivered to its own room and
 *   on the job's own Store run model name (`matrixStoreRunModel`). A job whose hire is no longer in force (lapsed, revoked,
 *   reversed, cancelled past its paid month) is removed. Idempotent by name, and run on
 *   every Mac, like the check-in job: which Mac's run reaches the model is the lease's call.
 * - Hire skills (`prepareMatrixStoreHire`). The optional Hermes skills an item names
 *   (MATRIX_STORE_HIRE_SKILLS) are installed before the backend serves its first turn, so no
 *   conversation's cached prompt changes under it.
 *   A hire whose skills are not on the backend gets no jobs until they are: its paid runs
 *   never go out without them. A hire is not sold on a Mac that cannot install them
 *   (`matrixStoreHireInstallable`, checked before the purchase).
 * - Scheduled runs (`MatrixStoreRuns`). A call on a Store job's model name is bound to the
 *   Store only on the Mac that holds the assistant's answering lease (taken on demand, as a
 *   check-in takes it), and only once per household for each occurrence of that job's
 *   schedule: the run claims it in the synced Store-run ledger (shared/matrix-store-runs.ts)
 *   before its Store task is minted, so a Mac catching the job up late repeats nothing. The
 *   task for the assistant's home room is cached for that lease session, that job and that
 *   occurrence.
 *   Anywhere else the proxy answers `[SILENT]`: never forwarded, never charged, and Hermes
 *   posts nothing.
 */
import type { MatrixStoreSnapshot } from '../../shared/matrix-store'
import {
  claimMatrixStoreRun,
  type MatrixStoreRunLedger,
  matrixStoreRunOccurrence
} from '../../shared/matrix-store-runs'
import {
  MATRIX_STORE_HIRE_SKILLS,
  MATRIX_STORE_JOB_PREFIX,
  MATRIX_STORE_SCHEDULES,
  matrixStoreBindableItems,
  matrixStoreJobName,
  matrixStoreRenewalDue,
  type MatrixStoreRunJob,
  matrixStoreRunJobKey,
  matrixStoreRunModel,
  type MatrixStoreScheduleSpec
} from '../../shared/matrix-store-schedules'

export interface MatrixStoreScheduleGateway {
  request<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T>
}

interface CronJobRow {
  job_id: string
  name: string
  schedule?: string
  prompt_preview?: string
  model?: string | null
  deliver?: string
}

const RPC_MS = 20_000
/** Installing one optional skill (a local copy and its scan) is quick; a stuck one is not
 * waited on past this, and the next backend start tries again. */
const INSTALL_MS = 60_000

function jobRows(value: unknown): CronJobRow[] {
  const jobs = (value as { jobs?: unknown } | null)?.jobs

  if (!Array.isArray(jobs)) {
    throw new Error('matrix_store_jobs_unreadable')
  }

  return jobs.filter(
    (job): job is CronJobRow =>
      Boolean(job) && typeof (job as CronJobRow).job_id === 'string' && typeof (job as CronJobRow).name === 'string'
  )
}

interface WantedJob {
  itemId: string
  spec: MatrixStoreScheduleSpec
}

/** A listed job is exactly what this build would add for its spec. */
function matches(job: CronJobRow, { itemId, spec }: WantedJob): boolean {
  return (
    job.schedule === spec.cron &&
    // `cron.manage list` shows a prompt's first 100 characters.
    job.prompt_preview === (spec.prompt.length > 100 ? `${spec.prompt.slice(0, 100)}...` : spec.prompt) &&
    job.model === matrixStoreRunModel({ itemId, scheduleId: spec.id }) &&
    job.deliver === 'matrix'
  )
}

/**
 * Makes the backend's Store jobs exactly those of `items` (hires in force): adds a missing
 * one, removes one whose hire is no longer in force, a second copy of a name, and one this
 * build would write differently (then added again). A paused job is kept as it is: pausing
 * is the owner's. Jobs not named `atum-store/…` are never touched.
 *
 * A hire whose skills (MATRIX_STORE_HIRE_SKILLS) this backend lacks is `held`: it has no
 * jobs here until they are installed, so none of its paid runs goes out without them.
 */
export async function reconcileMatrixStoreJobs(input: {
  gateway: MatrixStoreScheduleGateway
  items: readonly string[]
  log(line: string): void
}): Promise<{ added: string[]; removed: string[]; held: string[] }> {
  const wanted = new Map<string, WantedJob>()
  const held: string[] = []
  const needsSkills = input.items.some(itemId => MATRIX_STORE_HIRE_SKILLS[itemId]?.length)
  const present = needsSkills ? await installedSkills(input.gateway) : new Set<string>()

  for (const itemId of input.items) {
    if (!(MATRIX_STORE_HIRE_SKILLS[itemId] ?? []).every(skill => present.has(skill.name))) {
      held.push(itemId)

      continue
    }

    for (const spec of MATRIX_STORE_SCHEDULES[itemId] ?? []) {
      wanted.set(matrixStoreJobName(itemId, spec.id), { itemId, spec })
    }
  }

  const listed = jobRows(await input.gateway.request('cron.manage', { action: 'list', include_disabled: true }, RPC_MS))

  const kept = new Set<string>()
  const removed: string[] = []
  const added: string[] = []

  for (const job of listed) {
    if (!job.name.startsWith(MATRIX_STORE_JOB_PREFIX)) {
      continue
    }

    const want = wanted.get(job.name)

    if (want && !kept.has(job.name) && matches(job, want)) {
      kept.add(job.name)

      continue
    }

    const result = await input.gateway.request<{ success?: unknown }>(
      'cron.manage',
      { action: 'remove', name: job.job_id },
      RPC_MS
    )

    if (result?.success !== true) {
      throw new Error('matrix_store_job_not_removed')
    }

    removed.push(job.name)
  }

  for (const [name, { itemId, spec }] of wanted) {
    if (kept.has(name)) {
      continue
    }

    const result = await input.gateway.request<{ success?: unknown }>(
      'cron.manage',
      {
        action: 'add',
        name,
        schedule: spec.cron,
        prompt: spec.prompt,
        deliver: 'matrix',
        model: matrixStoreRunModel({ itemId, scheduleId: spec.id })
      },
      RPC_MS
    )

    if (result?.success !== true) {
      throw new Error('matrix_store_job_not_added')
    }

    added.push(name)
  }

  if (added.length || removed.length || held.length) {
    input.log(`[Matrix] store jobs added=${added.length} removed=${removed.length} held=${held.join(',') || '-'}`)
  }

  return { added, removed, held }
}

/** The backend's skill names, from `skills.manage list` ({ category: [name] }). */
async function installedSkills(gateway: MatrixStoreScheduleGateway): Promise<Set<string>> {
  const value = await gateway.request<{ skills?: unknown }>('skills.manage', { action: 'list' }, RPC_MS)
  const names = new Set<string>()

  if (value?.skills && typeof value.skills === 'object') {
    for (const list of Object.values(value.skills as Record<string, unknown>)) {
      if (Array.isArray(list)) {
        list.filter((name): name is string => typeof name === 'string').forEach(name => names.add(name))
      }
    }
  }

  return names
}

/**
 * Installs the optional skills the hires in force name and this backend lacks, then reads
 * the list back: `skills.manage install` reports success even when the hub refused, so
 * only the list says it is there. Returns the skills still missing.
 */
export async function prepareMatrixStoreHire(input: {
  gateway: MatrixStoreScheduleGateway
  items: readonly string[]
  log(line: string): void
}): Promise<string[]> {
  const needed = input.items.flatMap(itemId => MATRIX_STORE_HIRE_SKILLS[itemId] ?? [])

  if (!needed.length) {
    return []
  }

  let present = await installedSkills(input.gateway)
  const absent = needed.filter(skill => !present.has(skill.name))

  if (!absent.length) {
    return []
  }

  for (const skill of absent) {
    await input.gateway
      .request('skills.manage', { action: 'install', query: skill.identifier }, INSTALL_MS)
      .catch(() => undefined)
  }

  present = await installedSkills(input.gateway)
  const missing = absent.filter(skill => !present.has(skill.name)).map(skill => skill.name)
  input.log(
    `[Matrix] store hire skills installed=${absent.length - missing.length} missing=${missing.join(',') || '-'}`
  )

  return missing
}

/**
 * Whether this Mac's Hermes runtime can install every skill a hire of `itemId` needs,
 * asked of any running backend (they share the runtime and its optional skills) without
 * installing anything. Checked before the hire is bought: a hire whose skills cannot be
 * installed here is refused, never charged for an assistant that would be missing them.
 */
export async function matrixStoreHireInstallable(input: {
  gateway: MatrixStoreScheduleGateway | undefined
  itemId: string
  log(line: string): void
}): Promise<boolean> {
  const skills = MATRIX_STORE_HIRE_SKILLS[input.itemId] ?? []

  if (!skills.length) {
    return true
  }

  if (!input.gateway) {
    input.log('[Matrix] store hire refused: no backend to check its skills')

    return false
  }

  for (const skill of skills) {
    const found = await input.gateway
      .request<{ info?: { name?: unknown } }>('skills.manage', { action: 'inspect', query: skill.identifier }, RPC_MS)
      .catch(() => undefined)

    if (found?.info?.name !== skill.name) {
      input.log(`[Matrix] store hire refused: ${skill.name} not installable here`)

      return false
    }
  }

  return true
}

/**
 * The hired items a scheduled run of this assistant may be bound to now, or null (the run
 * stays silent). The Store is read again first when its snapshot may be stale: never read
 * (a run caught up at app start), a failed read, or a subscription past its renewal date
 * (only the server knows whether it renewed, and a run bound to an ended period would be
 * charged without its paid skill).
 */
export async function matrixStoreRunItems(input: {
  store: { snapshot(): MatrixStoreSnapshot | undefined; refresh(): Promise<void> } | undefined
  assistantId: string
  now?: () => number
}): Promise<string[] | null> {
  const now = input.now ?? Date.now
  const before = input.store?.snapshot()

  if (
    input.store &&
    (before?.state !== 'ready' || matrixStoreRenewalDue(before.entitlements, input.assistantId, now()))
  ) {
    await input.store.refresh()
  }

  const snapshot = input.store?.snapshot()

  if (snapshot?.state !== 'ready') {
    return null
  }

  const items = matrixStoreBindableItems(snapshot.entitlements, input.assistantId, now())

  return items.length ? items : null
}

/**
 * Keeps each agent's Store jobs reconciled: one reconcile at a time per agent, and a repeat
 * with nothing changed (the same backend connection and the same hires) is skipped unless
 * forced or an hour old.
 */
export class MatrixStoreSchedules {
  private readonly last = new Map<string, { gateway: MatrixStoreScheduleGateway; key: string; at: number }>()
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(
    private readonly deps: {
      log(line: string): void
      now?: () => number
    }
  ) {}

  reconcile(
    agent: string,
    gateway: MatrixStoreScheduleGateway,
    items: readonly string[],
    force = false
  ): Promise<void> {
    const run = (this.queues.get(agent) ?? Promise.resolve()).then(async () => {
      const key = [...items].sort().join('\n')
      const now = this.deps.now?.() ?? Date.now()
      const last = this.last.get(agent)

      if (!force && last && last.gateway === gateway && last.key === key && now - last.at < 60 * 60_000) {
        return
      }

      try {
        const { held } = await reconcileMatrixStoreJobs({ gateway, items, log: this.deps.log })

        // A hire held for its skills is looked at again on the next pass, not an hour later.
        if (held.length) {
          this.last.delete(agent)
        } else {
          this.last.set(agent, { gateway, key, at: now })
        }
      } catch (error) {
        this.last.delete(agent)
        this.deps.log(
          `[Matrix] store jobs not reconciled: ${error instanceof Error ? error.message : 'matrix_store_jobs_failed'}`
        )
      }
    })

    this.queues.set(
      agent,
      run.catch(() => {})
    )

    return run
  }

  forget(agent: string): void {
    this.last.delete(agent)
  }
}

/** What a scheduled run is bound with: the Store task for the assistant's home room. */
export interface MatrixStoreRunBinding {
  taskId: string
  assistantId: string
  executorId: string
  conversationId: string
  leaseToken?: string
  invocationId?: string
}

/** A held answering lease, released when the run stops calling (generalised check-in hold). */
export interface MatrixStoreRunHold {
  leaseToken?: string
  held(): boolean
  release(): void
}

/** Who a run would be bound for: the assistant, its executor here, the signed-in account's
 * scope (a cached binding never outlives a change of account) and the hired items a run may
 * be bound for (a job of any other item stays silent). */
export interface MatrixStoreRunEntitled {
  assistantId: string
  executorId: string
  scope: string
  items: readonly string[]
}

export interface MatrixStoreRunsDeps {
  /** The agent's hire is in force with its paid period running (`matrixStoreRunItems`), it
   * answers with Atum's AI and it is enrolled here. */
  entitled(agent: string): MatrixStoreRunEntitled | null | Promise<MatrixStoreRunEntitled | null>
  /** The agent's answering lease: already held here, or taken now when no Mac holds it;
   * null while another Mac answers for it. */
  hold(agent: string): Promise<MatrixStoreRunHold | null>
  homeRoom(agent: string): string | undefined
  /** A Store task for the binding (server-minted); null when the Store has nothing to bind. */
  createTask(binding: Omit<MatrixStoreRunBinding, 'taskId'>): Promise<MatrixStoreRunBinding | null>
  /** The assistant's Store-run ledger, fresh from the server (never the sync cache); throws
   * when it cannot be read. */
  readLedger(assistantId: string): Promise<MatrixStoreRunLedger>
  /** Writes it; only ever called holding the assistant's lease, which orders Macs. */
  writeLedger(assistantId: string, ledger: MatrixStoreRunLedger): Promise<void>
  now?: () => number
  /** This Mac's time zone, as Date#getTimezoneOffset (its jobs fire in local time). */
  zoneOffset?: (now: number) => number
  /** How long a run's lease is kept after its last call: a run's calls are minutes apart at
   * most, and a lease kept between them saves taking it again. */
  lingerMs?: number
  log(line: string): void
}

interface HeldRun {
  hold: MatrixStoreRunHold
  binding: MatrixStoreRunBinding
  scope: string
  /** The occurrence this run claimed: the binding is good for that one only. */
  occurrence: string
  timer?: ReturnType<typeof setTimeout>
}

/**
 * The Store binding of paid assistants' scheduled runs, per agent and per job (see the file
 * header). Each job's run holds the assistant's lease on its own (the hold is counted), so
 * two jobs caught up together each claim and bind their own slot.
 */
export class MatrixStoreRuns {
  /** Held runs by agent, then by job key. */
  private readonly runs = new Map<string, Map<string, HeldRun>>()
  private readonly starting = new Map<string, Promise<MatrixStoreRunBinding | null>>()
  /** The claim being written for each assistant: one at a time on this Mac, so two jobs'
   * claims in the one ledger event never overwrite each other (the lease orders Macs). */
  private readonly claims = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: MatrixStoreRunsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** The binding for one call of a Store job's scheduled run, or null: answer it with
   * silence. Throws when the Store refused the task (the call is refused, never sent
   * unbound). */
  async binding(agent: string, job: MatrixStoreRunJob): Promise<MatrixStoreRunBinding | null> {
    const entitled = await this.deps.entitled(agent)

    if (!entitled) {
      this.end(agent)

      return null
    }

    const key = matrixStoreRunJobKey(job)
    const now = this.now()

    const spec = entitled.items.includes(job.itemId)
      ? MATRIX_STORE_SCHEDULES[job.itemId]?.find(each => each.id === job.scheduleId)
      : undefined

    const occurrence = spec ? matrixStoreRunOccurrence([spec], now, this.deps.zoneOffset?.(now)) : null

    if (!occurrence) {
      this.endRun(agent, key)

      return null
    }

    const current = this.runs.get(agent)?.get(key)

    if (
      current &&
      current.hold.held() &&
      current.occurrence === occurrence &&
      current.scope === entitled.scope &&
      current.binding.assistantId === entitled.assistantId &&
      current.binding.executorId === entitled.executorId &&
      current.binding.conversationId === this.deps.homeRoom(agent)
    ) {
      this.linger(agent, key, current)

      return current.binding
    }

    this.endRun(agent, key)

    const starting = `${agent}\n${key}`
    const pending = this.starting.get(starting) ?? this.start(agent, key, entitled, occurrence)
    this.starting.set(starting, pending)

    try {
      return await pending
    } finally {
      if (this.starting.get(starting) === pending) {
        this.starting.delete(starting)
      }
    }
  }

  private async start(
    agent: string,
    key: string,
    entitled: MatrixStoreRunEntitled,
    occurrence: string
  ): Promise<MatrixStoreRunBinding | null> {
    const hold = await this.deps.hold(agent)

    if (!hold) {
      return null
    }

    const conversationId = this.deps.homeRoom(agent)

    if (!hold.leaseToken || !conversationId || !hold.held()) {
      hold.release()

      return null
    }

    // Once per household: a run another Mac already did for this job's occurrence (a Mac
    // that was asleep catching the job up, or one whose clock or time zone differs) stays
    // silent. The claim is written under the lease, before any task is minted.
    let claimed: boolean

    try {
      claimed = await this.claim(entitled, key, occurrence, hold)
    } catch {
      this.deps.log(`[Matrix] store run ledger unavailable for ${agent}`)
      claimed = false
    }

    if (!claimed) {
      hold.release()

      return null
    }

    let binding: MatrixStoreRunBinding | null

    try {
      binding = await this.deps.createTask({
        assistantId: entitled.assistantId,
        executorId: entitled.executorId,
        conversationId,
        leaseToken: hold.leaseToken
      })
    } catch (error) {
      hold.release()

      throw error
    }

    if (!binding || !hold.held()) {
      hold.release()

      return null
    }

    const run: HeldRun = { hold, binding, scope: entitled.scope, occurrence }
    const runs = this.runs.get(agent) ?? new Map<string, HeldRun>()
    runs.set(key, run)
    this.runs.set(agent, runs)
    this.linger(agent, key, run)
    this.deps.log(`[Matrix] store run bound for ${agent} job=${key} occurrence=${occurrence}`)

    return binding
  }

  /** Claims the job's `occurrence` for this Mac in the assistant's ledger; false when it is
   * another Mac's (or a later one was claimed), or the lease went meanwhile. One claim per
   * assistant at a time. */
  private async claim(
    entitled: MatrixStoreRunEntitled,
    key: string,
    occurrence: string,
    hold: MatrixStoreRunHold
  ): Promise<boolean> {
    const before = this.claims.get(entitled.assistantId) ?? Promise.resolve()
    const mine = before.catch(() => {}).then(() => this.claimNow(entitled, key, occurrence, hold))
    this.claims.set(entitled.assistantId, mine)

    try {
      return await mine
    } finally {
      if (this.claims.get(entitled.assistantId) === mine) {
        this.claims.delete(entitled.assistantId)
      }
    }
  }

  private async claimNow(
    entitled: MatrixStoreRunEntitled,
    key: string,
    occurrence: string,
    hold: MatrixStoreRunHold
  ): Promise<boolean> {
    const ledger = await this.deps.readLedger(entitled.assistantId)
    const next = claimMatrixStoreRun(ledger, key, occurrence, entitled.executorId, this.now())

    if (!next) {
      this.deps.log(`[Matrix] store run already done job=${key} occurrence=${occurrence}`)

      return false
    }

    if (!hold.held()) {
      return false
    }

    if (next !== ledger) {
      await this.deps.writeLedger(entitled.assistantId, next)
    }

    return hold.held()
  }

  private linger(agent: string, key: string, run: HeldRun) {
    if (run.timer) {
      clearTimeout(run.timer)
    }

    run.timer = setTimeout(
      () => {
        if (this.runs.get(agent)?.get(key) === run) {
          this.endRun(agent, key)
        }
      },
      this.deps.lingerMs ?? 5 * 60_000
    )
    run.timer.unref?.()
  }

  /** Lets one job's run go (it stopped calling, or its slot or binding changed). */
  private endRun(agent: string, key: string): void {
    const runs = this.runs.get(agent)
    const run = runs?.get(key)

    if (!runs || !run) {
      return
    }

    runs.delete(key)

    if (!runs.size) {
      this.runs.delete(agent)
    }

    if (run.timer) {
      clearTimeout(run.timer)
    }

    run.hold.release()
  }

  /** Lets every run of the agent go (its hire ended, or the agent closed). */
  end(agent: string): void {
    for (const key of [...(this.runs.get(agent)?.keys() ?? [])]) {
      this.endRun(agent, key)
    }
  }

  stop(): void {
    for (const agent of [...this.runs.keys()]) {
      this.end(agent)
    }
  }
}
