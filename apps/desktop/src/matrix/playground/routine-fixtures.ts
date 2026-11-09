import type {
  MatrixAgentRoutine,
  MatrixAgentRoutinesSnapshot,
  MatrixRoutinesBridge
} from '../../../shared/agent-routines'

/**
 * Routines in the design playground (?routines=three|empty|conflict|legacy|unknown), the
 * states the coordinator reviews: three routines with one paused, an empty list, a revision
 * conflict on every write, legacy schedules still present, and a newer kind kept read-only.
 */
export type PlaygroundRoutinesMode = 'empty' | 'conflict' | 'legacy' | 'three' | 'unknown'

export function playgroundRoutinesMode(params: URLSearchParams): PlaygroundRoutinesMode {
  const value = params.get('routines')

  return value === 'empty' || value === 'conflict' || value === 'legacy' || value === 'unknown' ? value : 'three'
}

const ASSISTANT = '00000000-0000-4000-8000-5b3379da4cd1'
const PRINCIPAL = '00000000-0000-4000-8000-f257a03cc663'
const ZONE = 'Asia/Ho_Chi_Minh'

/** An instant for a wall clock in this product's Vietnamese zone (the playground owner's). */
function nextInZone(hour: number, minute: number, dayOfMonth?: number): number {
  const offset = 7 * 3_600_000
  const now = Date.now()

  for (let offsetDays = 0; offsetDays < 70; offsetDays += 1) {
    const local = new Date(now + offset + offsetDays * 86_400_000)
    const day = local.getUTCDate()

    if (dayOfMonth !== undefined && day !== dayOfMonth) {
      continue
    }

    const instant = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), day, hour, minute) - offset

    if (instant > now) {
      return instant
    }
  }

  return now + 86_400_000
}

function nextFor(schedule: MatrixAgentRoutine['schedule']): number {
  switch (schedule.kind) {
    case 'once':
      return Date.parse(schedule.runAt)
    case 'daily':
      return nextInZone(schedule.hour, schedule.minute)
    case 'weekly':
      return nextInZone(schedule.hour, schedule.minute)
    case 'monthly':
      return nextInZone(schedule.hour, schedule.minute, schedule.day)
    default:
      return Date.now() + 3_600_000
  }
}

function seeded(): MatrixAgentRoutine[] {
  return [
    {
      id: '00000000-0000-4000-8000-bd7662a5eeb4',
      title: 'Bản tin sáng',
      instruction: 'Tóm tắt những việc quan trọng hôm nay và gửi cho tôi.',
      schedule: { kind: 'daily', hour: 8, minute: 0 },
      timezone: ZONE,
      enabled: true,
      notifications: true,
      revision: 2,
      nextRunAt: nextInZone(8, 0),
      lastRun: null
    },
    {
      id: '00000000-0000-4000-8000-b454f82c5857',
      title: 'Họp tuần',
      instruction: 'Nhắc tôi chuẩn bị cho cuộc họp tuần vào sáng thứ Hai, Tư, Sáu.',
      schedule: { kind: 'weekly', hour: 9, minute: 0, weekdays: [1, 3, 5] },
      timezone: ZONE,
      enabled: false,
      notifications: true,
      revision: 4,
      nextRunAt: null,
      lastRun: null
    },
    {
      id: '00000000-0000-4000-8000-f6222a1106ee',
      title: 'Tổng kết tháng',
      instruction: 'Tổng kết chi tiêu và việc đã làm trong tháng.',
      schedule: { kind: 'monthly', day: 5, hour: 9, minute: 0 },
      timezone: ZONE,
      enabled: true,
      notifications: false,
      revision: 1,
      nextRunAt: nextInZone(9, 0, 5),
      lastRun: null
    }
  ]
}

function newerKind(): MatrixAgentRoutine[] {
  return [
    {
      id: '00000000-0000-4000-8000-f1d11edf5c5c',
      title: 'Kiểm tra hàng giờ',
      instruction: 'Kiểm tra hàng đợi mỗi sáu giờ.',
      schedule: { kind: 'interval', everyHours: 6 },
      timezone: ZONE,
      enabled: true,
      notifications: true,
      revision: 1,
      nextRunAt: Date.now() + 6 * 3_600_000,
      lastRun: null
    },
    {
      id: '00000000-0000-4000-8000-fbfe405ca65f',
      title: 'Nhắc một lần',
      instruction: 'Nhắc tôi gọi cho chị Lan vào chiều mai.',
      schedule: { kind: 'once', runAt: new Date(Date.now() + 86_400_000).toISOString() },
      timezone: ZONE,
      enabled: true,
      notifications: true,
      revision: 3,
      nextRunAt: Date.now() + 86_400_000,
      lastRun: null
    }
  ]
}

export function playgroundRoutines(mode: PlaygroundRoutinesMode): MatrixRoutinesBridge {
  let routines = mode === 'empty' ? [] : mode === 'unknown' ? newerKind() : seeded()
  const legacyState: MatrixAgentRoutinesSnapshot['legacyState'] = mode === 'legacy' ? 'present' : 'clear'

  const snapshot = (): MatrixAgentRoutinesSnapshot => ({
    assistantId: ASSISTANT,
    assistantPrincipal: PRINCIPAL,
    serverTime: Date.now(),
    legacyState,
    routines
  })

  return {
    read: async () => ({ ok: true, snapshot: snapshot() }),
    create: async input => {
      if (mode === 'conflict') {
        return { ok: false, error: 'conflict' }
      }

      if (legacyState !== 'clear') {
        return { ok: false, error: 'legacy' }
      }

      const routine: MatrixAgentRoutine = {
        id: crypto.randomUUID(),
        title: input.title,
        instruction: input.instruction,
        schedule: input.schedule,
        timezone: input.timezone,
        enabled: input.enabled,
        notifications: input.notifications,
        revision: 1,
        nextRunAt: Date.now() + 86_400_000,
        lastRun: null
      }

      routines = [...routines, routine]

      return { ok: true, routine }
    },
    update: async input => {
      if (mode === 'conflict') {
        return { ok: false, error: 'conflict' }
      }

      if (input.enabled && legacyState !== 'clear') {
        return { ok: false, error: 'legacy' }
      }

      const current = routines.find(each => each.id === input.routineId)

      if (!current) {
        return { ok: false, error: 'missing' }
      }

      if (current.revision !== input.expectedRevision) {
        return { ok: false, error: 'conflict' }
      }

      const routine: MatrixAgentRoutine = {
        ...current,
        title: input.title,
        instruction: input.instruction,
        schedule: input.schedule,
        timezone: input.timezone,
        enabled: input.enabled,
        notifications: input.notifications,
        revision: current.revision + 1,
        nextRunAt: input.enabled ? nextFor(input.schedule) : null
      }

      routines = routines.map(each => (each.id === routine.id ? routine : each))

      return { ok: true, routine }
    },
    run: async input => {
      if (mode === 'conflict') {
        return { ok: false, error: 'conflict' }
      }

      const current = routines.find(each => each.id === input.routineId)

      if (!current || current.revision !== input.expectedRevision) {
        return { ok: false, error: current ? 'conflict' : 'missing' }
      }

      const routine = { ...current, revision: current.revision + 1 }
      routines = routines.map(each => (each.id === routine.id ? routine : each))

      return { ok: true, routine }
    },
    delete: async input => {
      if (mode === 'conflict') {
        return { ok: false, error: 'conflict' }
      }

      const current = routines.find(each => each.id === input.routineId)

      if (!current) {
        return { ok: false, error: 'missing' }
      }

      if (current.revision !== input.expectedRevision) {
        return { ok: false, error: 'conflict' }
      }

      routines = routines.filter(each => each.id !== current.id)

      return { ok: true, deleted: { id: current.id, revision: current.revision } }
    },
    runs: async (_principal, routineId) => ({
      ok: true,
      snapshot: {
        routineId,
        runs: [
          {
            occurrenceId: '00000000-0000-4000-8000-e8d95748107a',
            scheduledAt: Date.now() - 86_400_000,
            state: 'completed',
            outcome: 'answered',
            publishedEvent: '$routine-result'
          }
        ]
      }
    })
  }
}
