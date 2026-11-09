import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixAgentRoutine, MatrixRoutineMutationResult } from '../../shared/agent-routines'
import { parseMatrixAgentRoutinesSnapshot } from '../../shared/agent-routines'

import {
  MatrixAgentRoutines,
  MatrixRoutineRequestLedger,
  mutateMatrixAgentRoutine,
  readMatrixAgentRoutineRuns,
  readMatrixAgentRoutines
} from './agent-routines'

const ASSISTANT = '00000000-0000-4000-8000-af16785cab34'
const PRINCIPAL = '00000000-0000-4000-8000-f257a03cc663'
const ROUTINE = '00000000-0000-4000-8000-c9f98e2c65c7'
const OTHER_ROUTINE = '00000000-0000-4000-8000-5b3379da4cd1'
const TOKEN = 'native-only-owner-token'
const resource = 'https://matrix.test/atum'
const OWNER = { principal: PRINCIPAL, assistantId: ASSISTANT }

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  })
}

function routine(overrides: Record<string, unknown> = {}) {
  return {
    id: ROUTINE,
    title: 'Bản tin sáng',
    instruction: 'Tóm tắt việc quan trọng hôm nay.',
    schedule: { kind: 'daily', hour: 8, minute: 0 },
    timezone: 'Asia/Ho_Chi_Minh',
    enabled: true,
    notifications: true,
    revision: 2,
    nextRunAt: 1_800_000_000_000,
    lastRun: null,
    ...overrides
  }
}

function snapshot(routines: unknown[] = [routine()]) {
  return {
    profile: 'atum.agent-routines/1',
    assistantId: ASSISTANT,
    assistantPrincipal: PRINCIPAL,
    serverTime: 1_800_000_000_000,
    legacyState: 'clear',
    routines
  }
}

function client(
  ledger = new MatrixRoutineRequestLedger(),
  ownerZone?: () => string | undefined,
  failureLog?: (message: string) => void
) {
  return new MatrixAgentRoutines(
    {
      agents: () => [OWNER],
      read: (assistantId, signal) => readMatrixAgentRoutines(resource, TOKEN, assistantId, signal),
      mutate: (assistantId, input, signal) => mutateMatrixAgentRoutine(resource, TOKEN, assistantId, input, signal),
      runs: (assistantId, routineId, signal) => readMatrixAgentRoutineRuns(resource, TOKEN, assistantId, routineId, signal),
      ...(ownerZone ? { ownerZone } : {}),
      ...(failureLog ? { failureLog } : {}),
      timeoutMs: 5_000
    },
    ledger
  )
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    principal: PRINCIPAL,
    title: 'Bản tin sáng',
    instruction: 'Tóm tắt việc quan trọng hôm nay.',
    schedule: { kind: 'daily' as const, hour: 8, minute: 0 },
    timezone: 'Asia/Ho_Chi_Minh',
    enabled: true,
    notifications: true,
    ...overrides
  }
}

function body(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>
}

function requestUrl(call: unknown[]): string {
  return String(call[0])
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the owner-route routines client', () => {
  it('reads one agent with the main-held bearer and never returns the token', async () => {
    const fetch = vi.fn(async () => json(snapshot()))
    vi.stubGlobal('fetch', fetch)

    const result = await client().read(PRINCIPAL)

    expect(result).toMatchObject({ ok: true, snapshot: { assistantId: ASSISTANT, legacyState: 'clear' } })
    expect(requestUrl(fetch.mock.calls[0]!)).toBe(`${resource}/agents/${ASSISTANT}/routines`)
    expect((fetch.mock.calls[0] as unknown as unknown[])[1]).toMatchObject({
      headers: { Authorization: `Bearer ${TOKEN}` }
    })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it('refuses a snapshot addressed to another assistant', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...snapshot(), assistantId: OTHER_ROUTINE })))

    expect(await client().read(PRINCIPAL)).toEqual({ ok: false, error: 'invalid' })
  })

  it('reuses the same request id only across a retry of the same draft', async () => {
    const first = vi
      .fn<(url: string, init?: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json({
      profile: 'atum.agent-routines/1',
        routine: routine({ revision: 3 })
      }))

    vi.stubGlobal('fetch', first)
    const routines = client()

    const failed = await routines.create(input())
    expect(failed).toEqual({ ok: false, error: 'offline' })

    const saved = await routines.create(input())
    expect(saved).toMatchObject({ ok: true, routine: { id: ROUTINE, revision: 3 } })

    const retryId = body(first.mock.calls[0]!).requestId
    expect(body(first.mock.calls[1]!).requestId).toBe(retryId)
    expect(body(first.mock.calls[1]!).operation).toBe('create')

    const next = vi.fn(async () => json({ profile: 'atum.agent-routines/1', routine: routine({ revision: 4 }) }))
    vi.stubGlobal('fetch', next)
    await routines.create(input())
    expect(body(next.mock.calls[0]!).requestId).not.toBe(retryId)
  })

  it('sends the switch as enabled with the revision it read, and maps every refusal', async () => {
    const base = parseMatrixAgentRoutinesSnapshot(snapshot())!.routines[0]!
    const fetch = vi.fn(async () => json({ profile: 'atum.agent-routines/1', routine: { ...routine(), enabled: false, revision: 3 } }))
    vi.stubGlobal('fetch', fetch)
    const routines = client()

    const result = await routines.update({
      principal: PRINCIPAL,
      routineId: base.id,
      expectedRevision: base.revision,
      title: base.title,
      instruction: base.instruction,
      schedule: base.schedule,
      timezone: base.timezone,
      enabled: false,
      notifications: base.notifications
    })

    expect(result).toMatchObject({ ok: true, routine: { enabled: false, revision: 3 } })
    expect(body(fetch.mock.calls[0]!)).toMatchObject({
      operation: 'update',
      routineId: ROUTINE,
      expectedRevision: 2,
      enabled: false
    })

    for (const [status, operation, expected] of [
      [409, 'update', 'conflict'],
      [409, 'create', 'quota'],
      [403, 'create', 'legacy'],
      [403, 'delete', 'conflict'],
      [404, 'run', 'missing'],
      [422, 'create', 'invalid']
    ] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => json({ error: `matrix_${status}` }, status)))

      const failure =
        operation === 'create'
          ? await client().create(input())
          : operation === 'update'
            ? await client().update({
                principal: PRINCIPAL,
                routineId: ROUTINE,
                expectedRevision: 2,
                title: 'Bản tin sáng',
                instruction: 'Tóm tắt.',
                schedule: { kind: 'daily', hour: 8, minute: 0 },
                timezone: 'Asia/Ho_Chi_Minh',
                enabled: false,
                notifications: true
              })
            : operation === 'delete'
              ? await client().delete({ principal: PRINCIPAL, routineId: ROUTINE, expectedRevision: 2 })
              : await client().run({ principal: PRINCIPAL, routineId: ROUTINE, expectedRevision: 2 })

      expect(failure).toEqual({ ok: false, error: expected })
    }
  })

  it('reads recent runs and deletes with the read revision', async () => {
    const runs = {
      profile: 'atum.agent-routine-runs/1',
      routineId: ROUTINE,
      runs: [
        {
          occurrenceId: '00000000-0000-4000-8000-fd8bcef3af34',
          scheduledAt: 1_799_000_000_000,
          state: 'completed',
          outcome: 'answered',
          publishedEvent: '$result'
        }
      ]
    }

    const fetch = vi.fn(async () => json(runs))
    vi.stubGlobal('fetch', fetch)

    expect(await client().runs(PRINCIPAL, ROUTINE)).toMatchObject({ ok: true, snapshot: { routineId: ROUTINE } })
    expect(requestUrl(fetch.mock.calls[0]!)).toBe(`${resource}/agents/${ASSISTANT}/routines/${ROUTINE}/runs`)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ profile: 'atum.agent-routines/1', outcome: 'deleted', routineId: ROUTINE, revision: 2 })
      )
    )
    const deleted = await client().delete({ principal: PRINCIPAL, routineId: ROUTINE, expectedRevision: 2 })

    expect(deleted).toEqual({ ok: true, deleted: { id: ROUTINE, revision: 2 } })
  })

  it('holds no owner token in any result the renderer receives', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(snapshot())))
    const result: MatrixRoutineMutationResult | Awaited<ReturnType<MatrixAgentRoutines['read']>> = await client().read(PRINCIPAL)

    expect(JSON.stringify(result)).not.toMatch(/token|bearer/iu)
  })

  it('logs only a closed run code for a server refusal and an offline cloud route', async () => {
    const failureLog = vi.fn<(message: string) => void>()

    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'matrix_403' }, 403)))
    expect(
      await client(undefined, undefined, failureLog).run({
        principal: PRINCIPAL,
        routineId: ROUTINE,
        expectedRevision: 2
      })
    ).toEqual({ ok: false, error: 'legacy' })
    expect(failureLog).toHaveBeenLastCalledWith(
      '[Matrix] routine operation=run outcome=failed code=matrix_routine_run_legacy'
    )

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('network detail must not be logged'))))
    expect(
      await client(undefined, undefined, failureLog).run({
        principal: PRINCIPAL,
        routineId: ROUTINE,
        expectedRevision: 2
      })
    ).toEqual({ ok: false, error: 'offline' })
    expect(failureLog).toHaveBeenLastCalledWith(
      '[Matrix] routine operation=run outcome=failed code=matrix_routine_run_offline'
    )
    expect(failureLog.mock.calls.flat().join('\n')).not.toContain('network detail')
    expect(failureLog.mock.calls.flat().join('\n')).not.toContain(PRINCIPAL)
    expect(failureLog.mock.calls.flat().join('\n')).not.toContain(ROUTINE)
  })
})

describe('the owner zone for a new routine', () => {
  it('hands the acknowledged owner zone to the window, and nothing when never acked', () => {
    expect(client().ownerZone()).toBeUndefined()
    expect(client(undefined, () => 'Asia/Tokyo').ownerZone()).toBe('Asia/Tokyo')
  })
})

describe('the request ledger', () => {
  it('keys the exact body, so a changed draft is a new mutation', () => {
    const ledger = new MatrixRoutineRequestLedger()
    const draft = { operation: 'create' as const, title: 'A', instruction: 'B', schedule: { kind: 'daily' as const, hour: 8, minute: 0 }, timezone: 'Asia/Ho_Chi_Minh', enabled: true, notifications: true }

    const first = ledger.key(ASSISTANT, draft)
    const second = ledger.key(ASSISTANT, { ...draft, title: 'A2' })

    expect(first).not.toBe(second)
    expect(ledger.requestId(first)).toBe(ledger.requestId(first))
    expect(ledger.requestId(first)).not.toBe(ledger.requestId(second))
  })
})

describe('a mapped routine still fits the shared contract', () => {
  it('keeps the update body closed', async () => {
    const fetch = vi.fn(async () => json({ profile: 'atum.agent-routines/1', routine: routine() }))
    vi.stubGlobal('fetch', fetch)

    const base: MatrixAgentRoutine = parseMatrixAgentRoutinesSnapshot(snapshot())!.routines[0]!
    await client().update({
      principal: PRINCIPAL,
      routineId: base.id,
      expectedRevision: base.revision,
      title: base.title,
      instruction: base.instruction,
      schedule: base.schedule,
      timezone: base.timezone,
      enabled: true,
      notifications: base.notifications
    })

    expect(Object.keys(body(fetch.mock.calls[0]!)).sort()).toEqual([
      'enabled',
      'expectedRevision',
      'instruction',
      'notifications',
      'operation',
      'requestId',
      'routineId',
      'schedule',
      'timezone',
      'title'
    ])
  })
})
