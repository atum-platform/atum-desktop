import { describe, expect, it } from 'vitest'

import {
  matrixRoutineActionInput,
  matrixRoutineCreateInput,
  matrixRoutineTitle,
  matrixRoutineUpdateInput,
  parseMatrixAgentRoutineMutation,
  parseMatrixAgentRoutineRunsSnapshot,
  parseMatrixAgentRoutinesSnapshot,
  parseMatrixAgentRoutineWriteSchedule
} from './agent-routines'

const ASSISTANT = '00000000-0000-4000-8000-af16785cab34'
const PRINCIPAL = '00000000-0000-4000-8000-f257a03cc663'
const ROUTINE = '00000000-0000-4000-8000-c9f98e2c65c7'
const OCCURRENCE = '00000000-0000-4000-8000-5b3379da4cd1'

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

function snapshot(routines: unknown[]) {
  return {
    profile: 'atum.agent-routines/1',
    assistantId: ASSISTANT,
    assistantPrincipal: PRINCIPAL,
    serverTime: 1_800_000_000_000,
    legacyState: 'clear',
    routines
  }
}

describe('the agent-routines snapshot', () => {
  it('reads every schedule kind, keeping an unknown one as a read-only row', () => {
    const parsed = parseMatrixAgentRoutinesSnapshot(
      snapshot([
        routine({ id: '00000000-0000-4000-8000-bd7662a5eeb4' }),
        routine({
          id: '00000000-0000-4000-8000-b454f82c5857',
          schedule: { kind: 'weekly', hour: 9, minute: 30, weekdays: [5, 1, 3] }
        }),
        routine({
          id: '00000000-0000-4000-8000-f6222a1106ee',
          schedule: { kind: 'monthly', day: 5, hour: 7, minute: 0 }
        }),
        routine({
          id: '00000000-0000-4000-8000-f1d11edf5c5c',
          schedule: { kind: 'once', runAt: '2026-10-21T08:00:00.000Z' }
        }),
        routine({
          id: '00000000-0000-4000-8000-fbfe405ca65f',
          schedule: { kind: 'interval', everyHours: 6 }
        }),
        routine({
          id: '00000000-0000-4000-8000-a9703d75e616',
          schedule: { kind: 'fortnightly', hour: 8 }
        })
      ])
    )

    expect(parsed?.routines.map(each => each.schedule.kind)).toEqual([
      'daily',
      'weekly',
      'monthly',
      'once',
      'interval',
      'unsupported'
    ])
    expect(parsed?.routines[1]?.schedule).toEqual({ kind: 'weekly', hour: 9, minute: 30, weekdays: [1, 3, 5] })
    expect(parsed?.routines[5]?.schedule).toEqual({ kind: 'unsupported', kindName: 'fortnightly' })
  })

  it('refuses a malformed row instead of guessing, but keeps a legacy state fail-closed', () => {
    expect(parseMatrixAgentRoutinesSnapshot(snapshot([routine({ revision: 0 })]))).toBeNull()
    expect(parseMatrixAgentRoutinesSnapshot(snapshot([routine(), routine()]))).toBeNull()
    expect(parseMatrixAgentRoutinesSnapshot({ ...snapshot([]), legacyState: 'migrating' })).toBeNull()
  })

  it('reads runs with their closed states and published event', () => {
    const parsed = parseMatrixAgentRoutineRunsSnapshot(
      {
        profile: 'atum.agent-routine-runs/1',
        routineId: ROUTINE,
        runs: [
          {
            occurrenceId: OCCURRENCE,
            scheduledAt: 1_800_000_000_000,
            state: 'completed',
            outcome: 'answered',
            publishedEvent: '$routine-result',
            deliveryDisposition: 'delivered'
          },
          { occurrenceId: '00000000-0000-4000-8000-fd8bcef3af34', scheduledAt: 1_799_000_000_000, state: 'skipped', skipReason: 'revoked' },
          {
            occurrenceId: '00000000-0000-4000-8000-1be3e39b408f',
            scheduledAt: 1_798_000_000_000,
            state: 'completed',
            outcome: 'answered',
            deliveryDisposition: 'silent'
          }
        ]
      },
      ROUTINE
    )

    expect(parsed?.runs[0]?.publishedEvent).toBe('$routine-result')
    expect(parsed?.runs[0]?.deliveryDisposition).toBe('delivered')
    expect(parsed?.runs[1]?.skipReason).toBe('revoked')
    expect(parsed?.runs[2]?.deliveryDisposition).toBe('silent')
    expect(
      parseMatrixAgentRoutineRunsSnapshot(
        {
          profile: 'atum.agent-routine-runs/1',
          routineId: ROUTINE,
          runs: [{ occurrenceId: OCCURRENCE, scheduledAt: 1_800_000_000_000, state: 'claimed', deliveryDisposition: 'silent' }]
        },
        ROUTINE
      )
    ).toBeNull()
    expect(parseMatrixAgentRoutineRunsSnapshot({ profile: 'atum.agent-routine-runs/1', routineId: ASSISTANT, runs: [] }, ROUTINE)).toBeNull()
  })

  it('reads the delete receipt and a routine mutation', () => {
    expect(parseMatrixAgentRoutineMutation({ profile: 'atum.agent-routines/1', routine: routine() })).toMatchObject({ id: ROUTINE })
    expect(
      parseMatrixAgentRoutineMutation({
        profile: 'atum.agent-routines/1',
        outcome: 'deleted',
        routineId: ROUTINE,
        revision: 3
      })
    ).toEqual({ id: ROUTINE, revision: 3 })
  })
})

describe('write inputs from the window', () => {
  const create = {
    principal: PRINCIPAL,
    title: 'Bản tin sáng',
    instruction: 'Tóm tắt việc quan trọng hôm nay.',
    schedule: { kind: 'daily', hour: 8, minute: 0 },
    timezone: 'Asia/Ho_Chi_Minh',
    enabled: true,
    notifications: true
  }

  it('accepts the four editable kinds and refuses interval/unknown', () => {
    expect(parseMatrixAgentRoutineWriteSchedule({ kind: 'weekly', hour: 9, minute: 0, weekdays: [1, 2, 3] })).toEqual({
      kind: 'weekly',
      hour: 9,
      minute: 0,
      weekdays: [1, 2, 3]
    })
    expect(parseMatrixAgentRoutineWriteSchedule({ kind: 'interval', everyHours: 2 })).toBeNull()
    expect(parseMatrixAgentRoutineWriteSchedule({ kind: 'fortnightly', hour: 8 })).toBeNull()
  })

  it('never accepts a token or an unknown field from the renderer', () => {
    expect(matrixRoutineCreateInput(create)).not.toBeNull()
    expect(matrixRoutineCreateInput({ ...create, accessToken: 'owner-token' })).toBeNull()
    expect(matrixRoutineCreateInput({ ...create, principal: 'agent-lan' })).toBeNull()
    expect(matrixRoutineUpdateInput({ ...create, routineId: ROUTINE, expectedRevision: 2 })).not.toBeNull()
    expect(matrixRoutineUpdateInput({ ...create, routineId: ROUTINE, expectedRevision: 2, requestId: OCCURRENCE })).toBeNull()
    expect(matrixRoutineActionInput({ principal: PRINCIPAL, routineId: ROUTINE, expectedRevision: 2 })).toEqual({
      principal: PRINCIPAL,
      routineId: ROUTINE,
      expectedRevision: 2
    })
    expect(matrixRoutineActionInput({ principal: PRINCIPAL, routineId: ROUTINE, expectedRevision: 2, enabled: false })).toBeNull()
  })
})

describe('the routine title', () => {
  it('is the first words, trimmed and bounded', () => {
    expect(matrixRoutineTitle('  Tóm tắt   việc quan trọng hôm nay và gửi cho tôi. Đừng bỏ sót. ')).toBe(
      'Tóm tắt việc quan trọng hôm nay và'
    )
    expect(matrixRoutineTitle('Một hai ba bốn năm sáu bảy tám chín mười')).toBe('Một hai ba bốn năm sáu bảy tám')
    expect(matrixRoutineTitle('   ')).toBe('')
    expect(Array.from(matrixRoutineTitle('a '.repeat(200))).length).toBeLessThanOrEqual(120)
  })
})
