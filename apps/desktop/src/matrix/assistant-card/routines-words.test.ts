import { describe, expect, it } from 'vitest'

import type { MatrixAgentRoutine } from '../../../shared/agent-routines'
import type { MatrixAgentView } from '../../../shared/matrix'

import { assistantCardCopies } from './copy'
import {
  matrixRoutineClock,
  matrixRoutineDateInput,
  matrixRoutineInstant,
  matrixRoutineNextWords,
  matrixRoutineRunsInCloud,
  matrixRoutineScheduleWords,
  matrixRoutineTimeFromInstant,
  matrixRoutineWeekdayChip,
  matrixRoutineWeekdayList
} from './routines-words'

describe('plain-words schedules', () => {
  it('writes each Vietnamese kind the way the card list says it', () => {
    const copy = assistantCardCopies.vi
    const zone = 'Asia/Ho_Chi_Minh'

    expect(matrixRoutineScheduleWords({ kind: 'daily', hour: 8, minute: 0 }, zone, 'vi', copy)).toBe('Hằng ngày lúc 8:00')
    expect(
      matrixRoutineScheduleWords({ kind: 'weekly', hour: 9, minute: 0, weekdays: [1, 3, 5] }, zone, 'vi', copy)
    ).toBe('Thứ 2, 4, 6 lúc 9:00')
    expect(matrixRoutineScheduleWords({ kind: 'monthly', day: 5, hour: 9, minute: 0 }, zone, 'vi', copy)).toBe(
      'Ngày 5 hằng tháng lúc 9:00'
    )
    expect(
      matrixRoutineScheduleWords({ kind: 'once', runAt: '2026-10-21T08:00:00.000Z' }, zone, 'vi', copy)
    ).toBe('Một lần, 21/10 15:00')
    expect(matrixRoutineScheduleWords({ kind: 'interval', everyHours: 2 }, zone, 'vi', copy)).toBe('Mỗi 2 giờ')
    expect(matrixRoutineScheduleWords({ kind: 'unsupported', kindName: 'x' }, zone, 'vi', copy)).toBe('Lịch khác')
  })

  it('writes each English kind too', () => {
    const copy = assistantCardCopies.en
    const zone = 'Asia/Ho_Chi_Minh'

    expect(matrixRoutineScheduleWords({ kind: 'daily', hour: 8, minute: 0 }, zone, 'en', copy)).toBe('Every day at 8:00')
    expect(
      matrixRoutineScheduleWords({ kind: 'weekly', hour: 9, minute: 0, weekdays: [1, 3] }, zone, 'en', copy)
    ).toBe('Mon, Wed at 9:00')
    expect(matrixRoutineScheduleWords({ kind: 'monthly', day: 5, hour: 9, minute: 0 }, zone, 'en', copy)).toBe(
      'Monthly on day 5 at 9:00'
    )
    expect(matrixRoutineScheduleWords({ kind: 'interval', everyHours: 6 }, zone, 'en', copy)).toBe('Every 6 hours')
  })

  it('names the weekdays for the form, with Sunday last', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(day => matrixRoutineWeekdayChip(day, 'vi'))).toEqual([
      'Thứ 2',
      'Thứ 3',
      'Thứ 4',
      'Thứ 5',
      'Thứ 6',
      'Thứ 7',
      'CN'
    ])
    expect(matrixRoutineWeekdayList([1, 3, 5], 'vi')).toBe('2, 4, 6')
    expect(matrixRoutineWeekdayList([7], 'vi')).toBe('CN')
    expect(matrixRoutineWeekdayList([1, 3], 'en')).toBe('Mon, Wed')
  })
})

describe('the next run in the row’s zone', () => {
  const routine = (overrides: Partial<MatrixAgentRoutine> = {}): MatrixAgentRoutine => ({
    id: '00000000-0000-4000-8000-af16785cab34',
    title: 'Bản tin',
    instruction: 'Tóm tắt.',
    schedule: { kind: 'daily', hour: 8, minute: 0 },
    timezone: 'Asia/Ho_Chi_Minh',
    enabled: true,
    notifications: true,
    revision: 1,
    nextRunAt: Date.now() + 3_600_000,
    lastRun: null,
    ...overrides
  })

  it('says a paused routine instead of a time', () => {
    expect(matrixRoutineNextWords(routine({ enabled: false, nextRunAt: null }), 'Asia/Ho_Chi_Minh', 'vi', assistantCardCopies.vi)).toBe(
      'Đã tạm dừng'
    )
  })

  it('writes the time in the row’s zone, naming the zone only when it differs', () => {
    const next = matrixRoutineNextWords(routine(), 'Asia/Ho_Chi_Minh', 'vi', assistantCardCopies.vi)
    expect(next).toMatch(/^Lần tới: (hôm nay|ngày mai)/u)

    const elsewhere = matrixRoutineNextWords(routine(), 'Europe/Paris', 'vi', assistantCardCopies.vi)
    expect(elsewhere).toContain('(Asia/Ho_Chi_Minh)')
  })
})

describe('wall clocks in a zone', () => {
  it('round-trips a once date and time', () => {
    const instant = matrixRoutineInstant('2026-10-21', '15:00', 'Asia/Ho_Chi_Minh')

    expect(instant).not.toBeNull()
    expect(matrixRoutineDateInput(instant!, 'Asia/Ho_Chi_Minh')).toBe('2026-10-21')
    expect(matrixRoutineTimeFromInstant(instant!, 'Asia/Ho_Chi_Minh')).toBe('15:00')
    expect(new Date(instant!).toISOString()).toBe('2026-10-21T08:00:00.000Z')
  })

  it('refuses a clock that does not exist', () => {
    expect(matrixRoutineInstant('2026-03-29', '02:30', 'Europe/Paris')).toBeNull()
  })

  it('writes the wall clock 24-hour in every locale, matching the list', () => {
    expect(matrixRoutineClock(8, 5)).toBe('8:05')
    expect(matrixRoutineClock(18, 30)).toBe('18:30')
    expect(matrixRoutineClock(0, 0)).toBe('0:00')
  })
})

describe('whether the list can fire', () => {
  const agent = (value: Record<string, unknown>) => value as unknown as MatrixAgentView

  it('runs while the cloud answers, including with a standby Mac', () => {
    expect(matrixRoutineRunsInCloud(agent({ answering: 'cloud' }))).toBe(true)
    expect(matrixRoutineRunsInCloud(agent({ answering: 'cloud', macRole: 'standby' }))).toBe(true)
  })

  it('does not run while this Mac answers or the agent is local', () => {
    expect(matrixRoutineRunsInCloud(agent({ answering: 'cloud', macRole: 'answering' }))).toBe(false)
    expect(matrixRoutineRunsInCloud(agent({}))).toBe(false)
  })

  it('reads the saved policy’s current destination when it is known', () => {
    expect(matrixRoutineRunsInCloud(agent({ answering: 'cloud', executionPolicy: { status: { current: 'cloud' } } }))).toBe(true)
    expect(
      matrixRoutineRunsInCloud(
        agent({ answering: 'cloud', executionPolicy: { status: { current: 'mac:00000000-0000-4000-8000-b454f82c5857' } } })
      )
    ).toBe(false)
    expect(matrixRoutineRunsInCloud(agent({ answering: 'cloud', executionPolicy: { status: { current: null } } }))).toBe(false)
  })
})
