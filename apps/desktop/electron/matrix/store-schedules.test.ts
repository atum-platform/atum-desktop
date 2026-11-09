import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixStoreEntitlement, MatrixStoreSnapshot } from '../../shared/matrix-store'
import { emptyMatrixStoreRunLedger, type MatrixStoreRunLedger } from '../../shared/matrix-store-runs'
import {
  MATRIX_STORE_HIRE_SKILLS,
  MATRIX_STORE_RUN_MODEL_ALIAS,
  MATRIX_STORE_SCHEDULES,
  matrixStoreJobName,
  type MatrixStoreRunJob,
  matrixStoreRunModel,
  matrixStoreScheduledItems
} from '../../shared/matrix-store-schedules'

import { storeEntitlement } from './store-contract'
import {
  matrixStoreHireInstallable,
  matrixStoreRunItems,
  MatrixStoreRuns,
  type MatrixStoreRunsDeps,
  MatrixStoreSchedules,
  prepareMatrixStoreHire,
  reconcileMatrixStoreJobs
} from './store-schedules'

const RESEARCHER = 'agent/researcher'
const SHOP = 'agent/shop-assistant'
/** The Store jobs the tests run: the researcher's Monday 8:00 digest, and the shop
 * assistant's daily 8:30 sales summary and Monday 10:00 price check. */
const DIGEST: MatrixStoreRunJob = { itemId: RESEARCHER, scheduleId: 'weekly-digest' }
const SALES: MatrixStoreRunJob = { itemId: SHOP, scheduleId: 'daily-sales' }
const PRICES: MatrixStoreRunJob = { itemId: SHOP, scheduleId: 'price-check' }
const ASSISTANT = '00000000-0000-4000-8000-20101becbd5c'

interface Job {
  job_id: string
  name: string
  schedule: string
  prompt_preview: string
  model: string | null
  deliver: string
  enabled: boolean
}

/** A Hermes backend's `cron.manage` and `skills.manage`, as tui_gateway/server.py answers them. */
function backend(initial: Partial<Job>[] = [], options: { installable?: string[]; skills?: string[] } = {}) {
  let next = 1

  const jobs: Job[] = initial.map(job => ({
    job_id: `j${next++}`,
    name: 'job',
    schedule: '30m',
    prompt_preview: 'hello',
    model: null,
    deliver: 'local',
    enabled: true,
    ...job
  }))

  const skills = new Set<string>(['arxiv', ...(options.skills ?? [])])
  const installs: string[] = []

  const request = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'cron.manage') {
      if (params.action === 'list') {
        return { success: true, jobs: jobs.filter(job => job.enabled || params.include_disabled === true) }
      }

      if (params.action === 'add') {
        const job: Job = {
          job_id: `j${next++}`,
          name: String(params.name),
          schedule: String(params.schedule),
          prompt_preview: String(params.prompt),
          model: typeof params.model === 'string' ? params.model : null,
          deliver: typeof params.deliver === 'string' ? params.deliver : 'local',
          enabled: true
        }

        jobs.push(job)

        return { success: true, job_id: job.job_id }
      }

      if (params.action === 'remove') {
        const at = jobs.findIndex(job => job.job_id === params.name)

        if (at === -1) {
          return { success: false }
        }

        jobs.splice(at, 1)

        return { success: true }
      }
    }

    if (method === 'skills.manage') {
      if (params.action === 'list') {
        return { skills: { general: [...skills] } }
      }

      if (params.action === 'install') {
        installs.push(String(params.query))
        const name = String(params.query).split('/').pop()!

        // The real RPC says installed whatever happened.
        if (!options.installable || options.installable.includes(name)) {
          skills.add(name)
        }

        return { installed: true, name: params.query }
      }

      // `inspect` resolves a skill without installing it: `{}` when the runtime has none.
      if (params.action === 'inspect') {
        const name = String(params.query).split('/').pop()!

        return { info: !options.installable || options.installable.includes(name) ? { name } : {} }
      }
    }

    throw new Error(`unexpected ${method}`)
  })

  return { gateway: { request } as never, request, jobs, skills, installs }
}

function entitlement(change: Partial<MatrixStoreEntitlement> = {}): MatrixStoreEntitlement {
  return {
    id: '00000000-0000-4000-8000-437f2643396b',
    itemId: RESEARCHER,
    kind: 'agent',
    state: 'active',
    assistantId: ASSISTANT,
    delivery: 'cloud',
    grantedAt: '2026-10-06T00:00:00Z',
    subscription: { state: 'active', renewAt: '2026-11-06T00:00:00Z', priceMicroProtons: 1, offerVersion: 1 },
    ...change
  }
}

const storeNames = (jobs: Job[]) =>
  jobs
    .filter(job => job.name.startsWith('atum-store/'))
    .map(job => job.name)
    .sort()

describe('the item IDs the bundled tables are keyed by', () => {
  it('are the IDs Store entitlements carry, so a hire in force finds its jobs and skills', () => {
    const keys = [...Object.keys(MATRIX_STORE_SCHEDULES), ...Object.keys(MATRIX_STORE_HIRE_SKILLS)]

    expect(keys.length).toBeGreaterThan(0)

    for (const itemId of keys) {
      // The entitlement the Store sends for a hire of it, through the app's own wire contract.
      const parsed = storeEntitlement(entitlement({ itemId }))

      expect(matrixStoreScheduledItems([parsed], ASSISTANT, Date.parse('2026-10-20T00:00:00Z'))).toEqual(
        MATRIX_STORE_SCHEDULES[itemId]?.length ? [itemId] : []
      )
    }
  })
})

describe('Store jobs on an assistant backend', () => {
  it("adds one job per spec of each hire, to the assistant's room on the Store run model", async () => {
    const { gateway, jobs } = backend([{ name: 'my own reminder' }], { skills: ['excel-author'] })
    const log = vi.fn()

    const result = await reconcileMatrixStoreJobs({ gateway, items: [RESEARCHER, SHOP], log })

    const expected = [RESEARCHER, SHOP].flatMap(item =>
      MATRIX_STORE_SCHEDULES[item]!.map(spec => matrixStoreJobName(item, spec.id))
    )

    expect(result.added.sort()).toEqual(expected.sort())
    expect(storeNames(jobs)).toEqual(expected.sort())

    // Each job on its own model name, which the proxy reads back to claim that job's slot.
    for (const itemId of [RESEARCHER, SHOP]) {
      for (const spec of MATRIX_STORE_SCHEDULES[itemId]!) {
        const job = jobs.find(each => each.name === matrixStoreJobName(itemId, spec.id))!

        expect(job.model).toBe(matrixStoreRunModel({ itemId, scheduleId: spec.id }))
        expect(job.deliver).toBe('matrix')
      }
    }

    // The owner's own job is never touched.
    expect(jobs.map(job => job.name)).toContain('my own reminder')
  })

  it('repeats safely: a second pass adds and removes nothing', async () => {
    const { gateway, jobs, request } = backend([], { skills: ['excel-author'] })
    await reconcileMatrixStoreJobs({ gateway, items: [SHOP], log: () => {} })
    const before = jobs.map(job => job.job_id)
    request.mockClear()

    const again = await reconcileMatrixStoreJobs({ gateway, items: [SHOP], log: () => {} })

    expect(again).toEqual({ added: [], removed: [], held: [] })
    expect(jobs.map(job => job.job_id)).toEqual(before)
    expect(request.mock.calls.map(([method, params]) => `${method} ${(params as { action: string }).action}`)).toEqual([
      'skills.manage list',
      'cron.manage list'
    ])
  })

  it('removes the jobs when the hire is no longer in force, and keeps the rest', async () => {
    const { gateway, jobs } = backend([{ name: 'my own reminder' }], { skills: ['excel-author'] })
    await reconcileMatrixStoreJobs({ gateway, items: [RESEARCHER, SHOP], log: () => {} })

    const now = Date.parse('2026-10-20T00:00:00Z')

    const lapsed = matrixStoreScheduledItems(
      [
        entitlement({
          subscription: { state: 'lapsed', renewAt: '2026-10-10T00:00:00Z', priceMicroProtons: 1, offerVersion: 1 }
        }),
        entitlement({ itemId: SHOP })
      ],
      ASSISTANT,
      now
    )

    expect(lapsed).toEqual([SHOP])

    const result = await reconcileMatrixStoreJobs({ gateway, items: lapsed, log: () => {} })

    expect(result.removed).toEqual([matrixStoreJobName(RESEARCHER, 'weekly-digest')])
    expect(storeNames(jobs)).toEqual(
      MATRIX_STORE_SCHEDULES[SHOP]!.map(spec => matrixStoreJobName(SHOP, spec.id)).sort()
    )
    expect(jobs.map(job => job.name)).toContain('my own reminder')

    await reconcileMatrixStoreJobs({ gateway, items: [], log: () => {} })
    expect(storeNames(jobs)).toEqual([])
  })

  it('sees a paused job, keeps it, and never adds a second; a duplicate or stale one is replaced', async () => {
    const name = matrixStoreJobName(RESEARCHER, 'weekly-digest')
    const spec = MATRIX_STORE_SCHEDULES[RESEARCHER]![0]!

    const current = {
      name,
      schedule: spec.cron,
      prompt_preview: spec.prompt,
      model: matrixStoreRunModel(DIGEST),
      deliver: 'matrix'
    }

    const paused = backend([{ ...current, enabled: false }])
    expect(await reconcileMatrixStoreJobs({ gateway: paused.gateway, items: [RESEARCHER], log: () => {} })).toEqual({
      added: [],
      removed: [],
      held: []
    })
    expect(paused.jobs).toHaveLength(1)

    const messy = backend([current, current, { ...current, schedule: '0 7 * * 1' }])
    const result = await reconcileMatrixStoreJobs({ gateway: messy.gateway, items: [RESEARCHER], log: () => {} })
    expect(result.removed).toEqual([name, name])
    expect(result.added).toEqual([])
    expect(messy.jobs.map(job => job.job_id)).toEqual(['j1'])

    // A job on the bare alias (an earlier build's) names no job: replaced by one on its own name.
    const earlier = backend([{ ...current, model: MATRIX_STORE_RUN_MODEL_ALIAS }])
    const replaced = await reconcileMatrixStoreJobs({ gateway: earlier.gateway, items: [RESEARCHER], log: () => {} })
    expect(replaced).toEqual({ added: [name], removed: [name], held: [] })
    expect(earlier.jobs.map(job => job.model)).toEqual([matrixStoreRunModel(DIGEST)])
  })

  it('stops at a removal the backend refused, and a reconcile that failed is tried again', async () => {
    const { gateway, request } = backend([{ name: matrixStoreJobName(RESEARCHER, 'weekly-digest') }])
    request.mockImplementationOnce(async () => ({ success: true, jobs: [{ job_id: 'gone', name: 'atum-store/x' }] }))
    const log = vi.fn()
    const schedules = new MatrixStoreSchedules({ log })

    await schedules.reconcile('agent:a', gateway, [])
    expect(log).toHaveBeenCalledWith('[Matrix] store jobs not reconciled: matrix_store_job_not_removed')

    request.mockClear()
    await schedules.reconcile('agent:a', gateway, [])
    expect(request).toHaveBeenCalled()
  })

  it('skips a repeat with the same backend and hires, unless forced or the backend changed', async () => {
    const first = backend()
    const schedules = new MatrixStoreSchedules({ log: () => {} })

    await schedules.reconcile('agent:a', first.gateway, [RESEARCHER])
    first.request.mockClear()
    await schedules.reconcile('agent:a', first.gateway, [RESEARCHER])
    expect(first.request).not.toHaveBeenCalled()

    await schedules.reconcile('agent:a', first.gateway, [RESEARCHER], true)
    expect(first.request).toHaveBeenCalledTimes(1)

    const second = backend()
    await schedules.reconcile('agent:a', second.gateway, [RESEARCHER])
    expect(storeNames(second.jobs)).toEqual([matrixStoreJobName(RESEARCHER, 'weekly-digest')])
  })
})

describe('a hire missing its skills', () => {
  const COACH = 'agent/english-coach'

  it('gets no jobs on a backend without its skills, and its jobs once they are installed', async () => {
    const { gateway, jobs, skills } = backend()
    const log = vi.fn()

    expect(await reconcileMatrixStoreJobs({ gateway, items: [COACH, RESEARCHER], log })).toEqual({
      added: [matrixStoreJobName(RESEARCHER, 'weekly-digest')],
      removed: [],
      held: [COACH]
    })
    expect(storeNames(jobs)).toEqual([matrixStoreJobName(RESEARCHER, 'weekly-digest')])
    expect(log).toHaveBeenCalledWith(`[Matrix] store jobs added=1 removed=0 held=${COACH}`)

    skills.add('memento-flashcards')
    const result = await reconcileMatrixStoreJobs({ gateway, items: [COACH, RESEARCHER], log })

    expect(result).toEqual({ added: [matrixStoreJobName(COACH, 'daily-lesson')], removed: [], held: [] })
  })

  it('removes the jobs of a hire whose skills went missing', async () => {
    const { gateway, jobs, skills } = backend([], { skills: ['memento-flashcards'] })
    await reconcileMatrixStoreJobs({ gateway, items: [COACH], log: () => {} })
    expect(storeNames(jobs)).toEqual([matrixStoreJobName(COACH, 'daily-lesson')])

    skills.delete('memento-flashcards')
    await reconcileMatrixStoreJobs({ gateway, items: [COACH], log: () => {} })
    expect(storeNames(jobs)).toEqual([])
  })

  it('looks again at the next pass, not an hour later, while a hire is held', async () => {
    const { gateway, jobs, skills, request } = backend()
    const schedules = new MatrixStoreSchedules({ log: () => {} })

    await schedules.reconcile('agent:a', gateway, [COACH])
    expect(storeNames(jobs)).toEqual([])

    skills.add('memento-flashcards')
    request.mockClear()
    await schedules.reconcile('agent:a', gateway, [COACH])
    expect(storeNames(jobs)).toEqual([matrixStoreJobName(COACH, 'daily-lesson')])

    request.mockClear()
    await schedules.reconcile('agent:a', gateway, [COACH])
    expect(request).not.toHaveBeenCalled()
  })

  it('is not sold where its skills cannot be installed: checked without installing anything', async () => {
    const ready = backend()
    expect(await matrixStoreHireInstallable({ gateway: ready.gateway, itemId: COACH, log: () => {} })).toBe(true)
    expect(ready.installs).toEqual([])
    expect(ready.request).toHaveBeenCalledWith(
      'skills.manage',
      { action: 'inspect', query: 'official/productivity/memento-flashcards' },
      expect.any(Number)
    )

    const log = vi.fn()
    const missing = backend([], { installable: [] })
    expect(await matrixStoreHireInstallable({ gateway: missing.gateway, itemId: COACH, log })).toBe(false)
    expect(log).toHaveBeenCalledWith('[Matrix] store hire refused: memento-flashcards not installable here')

    const failing = { request: vi.fn(async () => Promise.reject(new Error('backend gone'))) }
    expect(await matrixStoreHireInstallable({ gateway: failing, itemId: COACH, log })).toBe(false)
    expect(await matrixStoreHireInstallable({ gateway: undefined, itemId: COACH, log })).toBe(false)

    // A hire that needs no optional skill needs no backend either.
    expect(await matrixStoreHireInstallable({ gateway: undefined, itemId: RESEARCHER, log })).toBe(true)
  })
})

describe('hire skills', () => {
  it('installs what the hire names and the backend lacks, and confirms by reading the list back', async () => {
    const { gateway, installs, skills } = backend()
    const log = vi.fn()

    expect(await prepareMatrixStoreHire({ gateway, items: [SHOP, RESEARCHER], log })).toEqual([])
    expect(installs).toEqual(MATRIX_STORE_HIRE_SKILLS[SHOP]!.map(skill => skill.identifier))
    expect(skills.has('excel-author')).toBe(true)

    installs.length = 0
    expect(await prepareMatrixStoreHire({ gateway, items: [SHOP], log })).toEqual([])
    expect(installs).toEqual([])
  })

  it('reports a skill the hub said it installed but the list does not show', async () => {
    const { gateway } = backend([], { installable: [] })
    const log = vi.fn()

    expect(await prepareMatrixStoreHire({ gateway, items: ['agent/english-coach'], log })).toEqual([
      'memento-flashcards'
    ])
    expect(log).toHaveBeenCalledWith('[Matrix] store hire skills installed=0 missing=memento-flashcards')
  })
})

describe('scheduled runs bound to the Store', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function runs(change: Partial<MatrixStoreRunsDeps> = {}) {
    const release = vi.fn()
    let held = true
    const ledgers = new Map<string, MatrixStoreRunLedger>()

    const deps: MatrixStoreRunsDeps = {
      entitled: () => ({ assistantId: ASSISTANT, executorId: 'executor-1', scope: 'account-1:1', items: [RESEARCHER] }),
      hold: vi.fn(async () => ({ leaseToken: 'lease-1', held: () => held, release })),
      homeRoom: () => '!home:atum.test',
      createTask: vi.fn(async binding => ({ ...binding, taskId: 'task-1' })),
      readLedger: async assistantId => ledgers.get(assistantId) ?? emptyMatrixStoreRunLedger(),
      writeLedger: async (assistantId, ledger) => void ledgers.set(assistantId, ledger),
      // Monday 08:00:30, Mac time: the researcher's weekly digest has just fired.
      now: () => new Date(2026, 9, 5, 8, 0, 30).getTime(),
      lingerMs: 60_000,
      log: () => {},
      ...change
    }

    return { runs: new MatrixStoreRuns(deps), deps, release, lose: () => (held = false) }
  }

  it("returns a task for the assistant's home room, with its lease, only while this Mac holds the lease", async () => {
    const { runs: bound, deps } = runs()

    expect(await bound.binding('agent:a', DIGEST)).toEqual({
      taskId: 'task-1',
      assistantId: ASSISTANT,
      executorId: 'executor-1',
      conversationId: '!home:atum.test',
      leaseToken: 'lease-1'
    })
    expect(deps.createTask).toHaveBeenCalledWith({
      assistantId: ASSISTANT,
      executorId: 'executor-1',
      conversationId: '!home:atum.test',
      leaseToken: 'lease-1'
    })

    // Every call of the same run carries the same task: one lease session, one task.
    await bound.binding('agent:a', DIGEST)
    expect(deps.createTask).toHaveBeenCalledTimes(1)
    expect(deps.hold).toHaveBeenCalledTimes(1)
  })

  it('stays silent (null) on a Mac without the lease, and creates no task', async () => {
    const { runs: silent, deps } = runs({ hold: vi.fn(async () => null) })

    expect(await silent.binding('agent:a', DIGEST)).toBeNull()
    expect(deps.createTask).not.toHaveBeenCalled()
  })

  it('stays silent without a hire in force, a lease token or a home room, and lets the lease go', async () => {
    const none = runs({ entitled: () => null })
    expect(await none.runs.binding('agent:a', DIGEST)).toBeNull()
    expect(none.deps.hold).not.toHaveBeenCalled()

    const tokenlessRelease = vi.fn()
    const tokenless = runs({ hold: vi.fn(async () => ({ held: () => true, release: tokenlessRelease })) })
    expect(await tokenless.runs.binding('agent:a', DIGEST)).toBeNull()
    expect(tokenlessRelease).toHaveBeenCalledTimes(1)

    const roomless = runs({ homeRoom: () => undefined })
    expect(await roomless.runs.binding('agent:a', DIGEST)).toBeNull()
    expect(roomless.release).toHaveBeenCalledTimes(1)
    expect(roomless.deps.createTask).not.toHaveBeenCalled()
  })

  it('takes a new lease and task after the lease was lost, and releases a lease the Store refused', async () => {
    const lost = runs()
    await lost.runs.binding('agent:a', DIGEST)
    lost.lose()

    await lost.runs.binding('agent:a', DIGEST)
    expect(lost.release).toHaveBeenCalled()
    expect(lost.deps.hold).toHaveBeenCalledTimes(2)

    const refused = runs({
      createTask: vi.fn(async () => {
        throw new Error('matrix_store_execution_denied')
      })
    })

    await expect(refused.runs.binding('agent:a', DIGEST)).rejects.toThrow('matrix_store_execution_denied')
    expect(refused.release).toHaveBeenCalledTimes(1)
  })

  it('lets the lease go once the run stops calling, or when its hire ends', async () => {
    vi.useFakeTimers()
    const idle = runs()
    await idle.runs.binding('agent:a', DIGEST)
    vi.advanceTimersByTime(59_000)
    expect(idle.release).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2_000)
    expect(idle.release).toHaveBeenCalledTimes(1)

    let entitled = true

    const ended = runs({
      entitled: () =>
        entitled
          ? { assistantId: ASSISTANT, executorId: 'executor-1', scope: 'account-1:1', items: [RESEARCHER] }
          : null
    })

    await ended.runs.binding('agent:a', DIGEST)
    entitled = false
    expect(await ended.runs.binding('agent:a', DIGEST)).toBeNull()
    expect(ended.release).toHaveBeenCalledTimes(1)
  })

  it('never reuses a cached binding after the account changed: a new lease and task are taken', async () => {
    let scope = 'account-1:1'

    const {
      runs: bound,
      deps,
      release
    } = runs({
      entitled: () => ({ assistantId: ASSISTANT, executorId: 'executor-1', scope, items: [RESEARCHER] })
    })

    await bound.binding('agent:a', DIGEST)
    scope = 'account-2:1'
    await bound.binding('agent:a', DIGEST)

    expect(release).toHaveBeenCalledTimes(1)
    expect(deps.hold).toHaveBeenCalledTimes(2)
    expect(deps.createTask).toHaveBeenCalledTimes(2)
  })

  it('drops a cached binding once the home room changed, and stays silent without one', async () => {
    let room: string | undefined = '!home:atum.test'
    const { runs: bound, deps } = runs({ homeRoom: () => room })

    await bound.binding('agent:a', DIGEST)
    room = undefined
    expect(await bound.binding('agent:a', DIGEST)).toBeNull()
    expect(deps.createTask).toHaveBeenCalledTimes(1)
  })

  it('shares one lease and one task between calls that arrive together', async () => {
    const { runs: bound, deps } = runs()

    const [a, b] = await Promise.all([bound.binding('agent:a', DIGEST), bound.binding('agent:a', DIGEST)])

    expect(a).toEqual(b)
    expect(deps.hold).toHaveBeenCalledTimes(1)
    expect(deps.createTask).toHaveBeenCalledTimes(1)
  })
})

describe('a scheduled run happens once per household', () => {
  const AGENT = 'agent:researcher'
  /** A wall-clock time on a Mac in the test's time zone: October 2026 (the 5th and 12th are Mondays). */
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime()

  /** The owner's Macs: one synced account-data ledger and one answering lease between them. */
  function household() {
    const ledgers = new Map<string, MatrixStoreRunLedger>()
    let holder: string | null = null
    const macs: MatrixStoreRuns[] = []

    function mac(
      executorId: string,
      clock: { now: number },
      options: { zone?: number; items?: string[]; lingerMs?: number; change?: Partial<MatrixStoreRunsDeps> } = {}
    ) {
      const release = vi.fn()

      const createTask = vi.fn(async (binding: Parameters<MatrixStoreRunsDeps['createTask']>[0]) => ({
        ...binding,
        taskId: `task-${executorId}-${createTask.mock.calls.length}`
      }))

      const runs = new MatrixStoreRuns({
        entitled: () => ({
          assistantId: ASSISTANT,
          executorId,
          scope: 'account-1:1',
          items: options.items ?? [RESEARCHER]
        }),
        // Taken on demand when no Mac holds it; none while another Mac does.
        hold: async () => {
          if (holder && holder !== executorId) {
            return null
          }

          holder = executorId
          let released = false

          return {
            leaseToken: `lease-${executorId}`,
            held: () => !released && holder === executorId,
            release: () => {
              release()

              if (!released) {
                released = true
                holder = null
              }
            }
          }
        },
        homeRoom: () => '!home:atum.test',
        createTask,
        readLedger: async assistantId => ledgers.get(assistantId) ?? emptyMatrixStoreRunLedger(),
        writeLedger: async (assistantId, ledger) => void ledgers.set(assistantId, ledger),
        now: () => clock.now,
        ...(options.zone === undefined ? {} : { zoneOffset: () => options.zone! }),
        lingerMs: options.lingerMs ?? 5 * 60_000,
        log: () => {},
        ...options.change
      })

      macs.push(runs)

      return { runs, createTask, release }
    }

    return { ledgers, mac, holder: () => holder, stop: () => macs.forEach(runs => runs.stop()) }
  }

  it('stays silent on a Mac catching up a run another Mac already did: never charged, never posted twice', async () => {
    const home = household()
    const desk = { now: at(5, 8) }
    const laptop = { now: at(5, 15) }
    const a = home.mac('executor-a', desk)
    const b = home.mac('executor-b', laptop)

    // Mac A runs Monday's 8:00 digest, then its run stops calling and the lease goes.
    expect(await a.runs.binding(AGENT, DIGEST)).toMatchObject({ executorId: 'executor-a', taskId: 'task-executor-a-1' })
    a.runs.end(AGENT)
    expect(home.holder()).toBeNull()

    // Mac B, opened at 15:00, catches the 8:00 job up: no task, so the proxy answers [SILENT].
    expect(await b.runs.binding(AGENT, DIGEST)).toBeNull()
    expect(b.createTask).not.toHaveBeenCalled()
    expect(b.release).toHaveBeenCalledTimes(1)
    expect(home.holder()).toBeNull()
    expect(home.ledgers.get(ASSISTANT)?.runs).toEqual({
      'agent/researcher/weekly-digest': {
        occurrence: '2026-10-05T08:00',
        executorId: 'executor-a',
        claimedAt: at(5, 8)
      }
    })

    // The next Monday runs once again, on whichever Mac claims it first.
    laptop.now = at(12, 8, 1)
    expect(await b.runs.binding(AGENT, DIGEST)).toMatchObject({ executorId: 'executor-b' })
    b.runs.end(AGENT)
    desk.now = at(12, 9, 30)
    expect(await a.runs.binding(AGENT, DIGEST)).toBeNull()
    expect(a.createTask).toHaveBeenCalledTimes(1)
    home.stop()
  })

  it('names the same occurrence on Macs whose clocks disagree, whichever runs first', async () => {
    // Mac B's clock is 20 minutes slow: it fires "8:00" at 8:20, past A's run and its linger.
    const slow = household()
    const a = slow.mac('executor-a', { now: at(5, 8) })
    expect(await a.runs.binding(AGENT, DIGEST)).not.toBeNull()
    a.runs.end(AGENT)
    const b = slow.mac('executor-b', { now: at(5, 8) })
    expect(await b.runs.binding(AGENT, DIGEST)).toBeNull()
    expect(b.createTask).not.toHaveBeenCalled()
    slow.stop()

    // Mac B's clock is 20 minutes fast: it runs first, and A's 8:00 stays silent.
    const fast = household()
    const early = fast.mac('executor-b', { now: at(5, 8) })
    expect(await early.runs.binding(AGENT, DIGEST)).not.toBeNull()
    early.runs.end(AGENT)
    const late = fast.mac('executor-a', { now: at(5, 8, 0) + 60_000 })
    expect(await late.runs.binding(AGENT, DIGEST)).toBeNull()
    expect(late.createTask).not.toHaveBeenCalled()
    fast.stop()
  })

  it('names the same occurrence on Macs in different time zones', async () => {
    const home = household()
    // Mac A in UTC+7 fires its 8:00 at 01:00 UTC; Mac B in UTC fires its 8:00 seven hours later.
    const a = home.mac('executor-a', { now: Date.UTC(2026, 9, 5, 1, 0) }, { zone: -420 })
    const b = home.mac('executor-b', { now: Date.UTC(2026, 9, 5, 8, 0) }, { zone: 0 })

    expect(await a.runs.binding(AGENT, DIGEST)).not.toBeNull()
    a.runs.end(AGENT)
    expect(await b.runs.binding(AGENT, DIGEST)).toBeNull()
    expect(b.createTask).not.toHaveBeenCalled()
    home.stop()
  })

  it('keeps a cached binding for its own job and occurrence only: the next one is claimed again', async () => {
    const home = household()
    const clock = { now: at(5, 8, 30) }
    const shop = home.mac('executor-a', clock, { items: [SHOP], lingerMs: 48 * 60 * 60_000 })

    expect(await shop.runs.binding(AGENT, SALES)).toMatchObject({ taskId: 'task-executor-a-1' })
    clock.now = at(5, 8, 32)
    expect(await shop.runs.binding(AGENT, SALES)).toMatchObject({ taskId: 'task-executor-a-1' })

    // Monday's 10:00 price check is its own job: its own claim and task.
    clock.now = at(5, 10)
    expect(await shop.runs.binding(AGENT, PRICES)).toMatchObject({ taskId: 'task-executor-a-2' })

    // Tuesday's 8:30 sales summary, while Monday's binding still lingers: claimed again.
    clock.now = at(6, 8, 30)
    expect(await shop.runs.binding(AGENT, SALES)).toMatchObject({ taskId: 'task-executor-a-3' })
    expect(shop.createTask).toHaveBeenCalledTimes(3)
    expect(home.ledgers.get(ASSISTANT)?.runs).toEqual({
      'agent/shop-assistant/daily-sales': {
        occurrence: '2026-10-06T08:30',
        executorId: 'executor-a',
        claimedAt: at(6, 8, 30)
      },
      'agent/shop-assistant/price-check': {
        occurrence: '2026-10-05T10:00',
        executorId: 'executor-a',
        claimedAt: at(5, 10)
      }
    })
    home.stop()
  })

  it("repeats none of an assistant's jobs another Mac ran, and runs the one it did not", async () => {
    const home = household()
    // Mac A runs Monday's 8:30 sales summary, then is closed before the 10:00 price check.
    const a = home.mac('executor-a', { now: at(5, 8, 30) }, { items: [SHOP] })
    expect(await a.runs.binding(AGENT, SALES)).not.toBeNull()
    a.runs.end(AGENT)

    // Mac B, opened at 10:30, catches both jobs up: the sales summary stays silent (never
    // charged or posted twice), the price check nobody ran is run once.
    const b = home.mac('executor-b', { now: at(5, 10, 30) }, { items: [SHOP] })
    expect(await b.runs.binding(AGENT, SALES)).toBeNull()
    expect(b.createTask).not.toHaveBeenCalled()
    expect(await b.runs.binding(AGENT, PRICES)).toMatchObject({ executorId: 'executor-b' })
    expect(b.createTask).toHaveBeenCalledTimes(1)
    home.stop()
  })

  it('claims two jobs caught up together on one Mac without either claim overwriting the other', async () => {
    const home = household()
    const shop = home.mac('executor-a', { now: at(5, 10, 30) }, { items: [SHOP] })

    const [sales, prices] = await Promise.all([shop.runs.binding(AGENT, SALES), shop.runs.binding(AGENT, PRICES)])

    expect(sales).not.toBeNull()
    expect(prices).not.toBeNull()
    expect(sales!.taskId).not.toBe(prices!.taskId)
    expect(Object.keys(home.ledgers.get(ASSISTANT)!.runs).sort()).toEqual([
      'agent/shop-assistant/daily-sales',
      'agent/shop-assistant/price-check'
    ])

    // Each run holds the lease on its own; the agent's end lets both go.
    shop.runs.end(AGENT)
    expect(shop.release).toHaveBeenCalledTimes(2)
    home.stop()
  })

  it('stays silent for a job of an item the assistant is not hired for, and mints nothing', async () => {
    const home = household()
    const researcher = home.mac('executor-a', { now: at(5, 10, 30) })

    expect(await researcher.runs.binding(AGENT, PRICES)).toBeNull()
    expect(await researcher.runs.binding(AGENT, { itemId: RESEARCHER, scheduleId: 'no-such-job' })).toBeNull()
    expect(researcher.createTask).not.toHaveBeenCalled()
    expect(home.holder()).toBeNull()
    home.stop()
  })

  it("binds its own claim again soon after (a run that lost its lease), not once the slot's run is long over", async () => {
    const home = household()
    const clock = { now: at(5, 8) }
    const a = home.mac('executor-a', clock)

    expect(await a.runs.binding(AGENT, DIGEST)).not.toBeNull()
    a.runs.end(AGENT)
    clock.now = at(5, 8, 10)
    expect(await a.runs.binding(AGENT, DIGEST)).not.toBeNull()
    expect(a.createTask).toHaveBeenCalledTimes(2)
    a.runs.end(AGENT)

    clock.now = at(5, 9, 0)
    expect(await a.runs.binding(AGENT, DIGEST)).toBeNull()
    expect(a.createTask).toHaveBeenCalledTimes(2)
    home.stop()
  })

  it('stays silent, mints nothing and lets the lease go when the ledger cannot be read or written', async () => {
    for (const change of [
      { readLedger: async () => Promise.reject(new Error('matrix_store_runs_readonly')) },
      { writeLedger: async () => Promise.reject(new Error('matrix_not_ready')) }
    ] satisfies Partial<MatrixStoreRunsDeps>[]) {
      const home = household()
      const a = home.mac('executor-a', { now: at(5, 8) }, { change })

      expect(await a.runs.binding(AGENT, DIGEST)).toBeNull()
      expect(a.createTask).not.toHaveBeenCalled()
      expect(home.holder()).toBeNull()
      home.stop()
    }
  })
})

describe('the hire a scheduled run binds for', () => {
  const now = () => Date.parse('2026-11-06T01:00:00Z')

  function storeOf(
    entitlements: MatrixStoreEntitlement[],
    afterRefresh?: Partial<MatrixStoreSnapshot>,
    state: MatrixStoreSnapshot['state'] = 'ready'
  ) {
    let snapshot: MatrixStoreSnapshot = { state, items: [], entitlements, purchases: [], pending: [] }

    return {
      snapshot: () => snapshot,
      refresh: vi.fn(async () => {
        snapshot = { ...snapshot, ...afterRefresh }
      })
    }
  }

  // Granted 2026-10-06, renewing 2026-11-06T00:00Z: an hour past its renewal date.
  const due = entitlement()

  const renewed = entitlement({
    subscription: { state: 'active', renewAt: '2026-12-06T00:00:00Z', priceMicroProtons: 1, offerVersion: 1 }
  })

  it('reads the Store again once a renewal date passed, and binds nothing to a period that ended', async () => {
    const unrenewed = storeOf([due])
    expect(await matrixStoreRunItems({ store: unrenewed, assistantId: ASSISTANT, now })).toBeNull()
    expect(unrenewed.refresh).toHaveBeenCalledTimes(1)

    const paid = storeOf([due], { entitlements: [renewed] })
    expect(await matrixStoreRunItems({ store: paid, assistantId: ASSISTANT, now })).toEqual([RESEARCHER])
    expect(paid.refresh).toHaveBeenCalledTimes(1)
  })

  it('binds a paid period still running without reading the Store again', async () => {
    const store = storeOf([renewed])

    expect(await matrixStoreRunItems({ store, assistantId: ASSISTANT, now })).toEqual([RESEARCHER])
    expect(store.refresh).not.toHaveBeenCalled()
  })

  it('reads a Store not read yet, and binds nothing while it cannot be read', async () => {
    const first = storeOf([renewed], { state: 'ready' }, 'loading')
    expect(await matrixStoreRunItems({ store: first, assistantId: ASSISTANT, now })).toEqual([RESEARCHER])
    expect(first.refresh).toHaveBeenCalledTimes(1)

    const failing = storeOf([renewed], { state: 'unavailable' }, 'loading')
    expect(await matrixStoreRunItems({ store: failing, assistantId: ASSISTANT, now })).toBeNull()
    expect(failing.refresh).toHaveBeenCalledTimes(1)

    expect(await matrixStoreRunItems({ store: undefined, assistantId: ASSISTANT, now })).toBeNull()
  })
})
