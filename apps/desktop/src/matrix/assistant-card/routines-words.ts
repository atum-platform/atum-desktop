import type { Locale } from '@/i18n'

import type { MatrixAgentRoutine, MatrixAgentRoutineSchedule } from '../../../shared/agent-routines'
import type { MatrixAgentView } from '../../../shared/matrix'

import type { AssistantCardCopy } from './copy'

/** The window's locale ids are lower case (`zh-hant`); BCP 47 spelling reads the same. */
export function matrixRoutineLocale(locale: string): string {
  return locale === 'zh-hant' ? 'zh-Hant' : locale
}

const WEEKDAY_CHIP: Record<Locale, readonly string[]> = {
  en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  vi: ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'CN'],
  ja: ['月', '火', '水', '木', '金', '土', '日'],
  zh: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
  'zh-hant': ['週一', '週二', '週三', '週四', '週五', '週六', '週日']
}

/** The words inside a sentence ("Thứ 2, 4, 6"): Vietnamese carries the prefix in copy. */
const WEEKDAY_WORD: Record<Locale, readonly string[]> = {
  en: WEEKDAY_CHIP.en,
  vi: ['2', '3', '4', '5', '6', '7', 'CN'],
  ja: WEEKDAY_CHIP.ja,
  zh: WEEKDAY_CHIP.zh,
  'zh-hant': WEEKDAY_CHIP['zh-hant']
}

const WEEKDAY_SEPARATOR: Record<Locale, string> = {
  en: ', ',
  vi: ', ',
  ja: '・',
  zh: '、',
  'zh-hant': '、'
}

export function matrixRoutineWeekdayChip(day: number, locale: string): string {
  return WEEKDAY_CHIP[locale as Locale]?.[day - 1] ?? String(day)
}

export function matrixRoutineWeekdayList(days: readonly number[], locale: string): string {
  const words = WEEKDAY_WORD[locale as Locale] ?? WEEKDAY_WORD.en

  return days
    .map(day => words[day - 1] ?? String(day))
    .join(WEEKDAY_SEPARATOR[locale as Locale] ?? ', ')
}

interface WallParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

/** A wall clock (`hour`, `minute`) in the routine's zone. Always 24-hour: the form edits the
 * same `HH:MM` the contract stores, whatever the device's region, so the two cannot disagree. */
export function matrixRoutineClock(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, '0')}`
}

/**
 * Whether the platform routines can fire now. They run under the cloud controller's lease
 * (`packages/cloud-controller/src/controller/runtime.ts` ticks schedules only while it takes
 * a term; the lease refuses `local_answering` as terminal, `provider/lease.ts`), so a Mac
 * that answers holds the term away from the cloud. A standby Mac does not: the cloud keeps
 * the term. The saved policy's current destination is the honest answer when it is known.
 */
export function matrixRoutineRunsInCloud(
  agent: Pick<MatrixAgentView, 'answering' | 'macRole' | 'executionPolicy'>
): boolean {
  const current = agent.executionPolicy?.status?.current

  if (current !== undefined) {
    return current === 'cloud'
  }

  return agent.answering === 'cloud' && agent.macRole !== 'answering'
}

export function matrixRoutineTimeInput(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function partsAt(instant: number, timeZone: string): WallParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(instant))

  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value)

  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute')
  }
}

function offsetAt(timeZone: string, instant: number): string | undefined {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(instant))
      .find(part => part.type === 'timeZoneName')?.value
  } catch {
    return undefined
  }
}

function dayKey(parts: WallParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day)
}

/** The calendar date, without a time. `2026-10-21` for the date input. */
export function matrixRoutineDateInput(instant: number, timeZone: string): string {
  const parts = partsAt(instant, timeZone)

  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

export function matrixRoutineTimeFromInstant(instant: number, timeZone: string): string {
  const parts = partsAt(instant, timeZone)

  return matrixRoutineTimeInput(parts.hour, parts.minute)
}

/** An instant for a wall clock in `timeZone`, or null when that clock does not exist (a DST
 * gap) or is ambiguous and cannot be resolved to the requested minute. */
export function matrixRoutineInstant(date: string, time: string, timeZone: string): number | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date)
  const timeMatch = /^(\d{2}):(\d{2})$/u.exec(time)

  if (!dateMatch || !timeMatch) {
    return null
  }

  const [year, month, day] = [Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3])]
  const [hour, minute] = [Number(timeMatch[1]), Number(timeMatch[2])]

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return null
  }

  const wall = Date.UTC(year, month - 1, day, hour, minute)
  let instant = wall

  // Two passes settle an offset that changes at the transition itself.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = partsAt(instant, timeZone)
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
    instant += wall - asUtc
  }

  const resolved = partsAt(instant, timeZone)

  return resolved.year === year &&
    resolved.month === month &&
    resolved.day === day &&
    resolved.hour === hour &&
    resolved.minute === minute
    ? instant
    : null
}

function dateWords(instant: number, timeZone: string, locale: string, withYear: boolean): string {
  if (locale.startsWith('vi')) {
    const parts = partsAt(instant, timeZone)

    return `${String(parts.day).padStart(2, '0')}/${String(parts.month).padStart(2, '0')}${withYear ? `/${parts.year}` : ''}`
  }

  return new Intl.DateTimeFormat(matrixRoutineLocale(locale), {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone
  }).format(new Date(instant))
}

export function matrixRoutineScheduleWords(
  schedule: MatrixAgentRoutineSchedule,
  timezone: string,
  locale: string,
  copy: AssistantCardCopy
): string {
  switch (schedule.kind) {
    case 'once': {
      const instant = Date.parse(schedule.runAt)
      const time = Number.isFinite(instant) ? matrixRoutineClock(partsAt(instant, timezone).hour, partsAt(instant, timezone).minute) : ''
      const date = Number.isFinite(instant) ? dateWords(instant, timezone, locale, false) : ''

      return copy.routineOnceWords(date, time)
    }

    case 'daily':
      return copy.routineDailyWords(matrixRoutineClock(schedule.hour, schedule.minute))

    case 'weekly':
      return copy.routineWeeklyWords(
        matrixRoutineWeekdayList(schedule.weekdays, locale),
        matrixRoutineClock(schedule.hour, schedule.minute)
      )

    case 'monthly':
      return copy.routineMonthlyWords(schedule.day, matrixRoutineClock(schedule.hour, schedule.minute))

    case 'interval':
      return copy.routineIntervalWords(schedule.everyHours)

    default:
      return copy.routineUnsupported
  }
}

/** The row's second line: the next run in the row's zone, and the zone only when it is not
 * this device's. A paused routine says so instead of a time. */
export function matrixRoutineNextWords(
  routine: MatrixAgentRoutine,
  deviceTimeZone: string,
  locale: string,
  copy: AssistantCardCopy
): string {
  if (!routine.enabled || routine.nextRunAt === null) {
    return copy.routinePaused
  }

  const nextParts = partsAt(routine.nextRunAt, routine.timezone)
  const nowParts = partsAt(Date.now(), routine.timezone)
  const days = Math.round((dayKey(nextParts) - dayKey(nowParts)) / 86_400_000)
  const time = matrixRoutineClock(nextParts.hour, nextParts.minute)

  const next =
    days === 0
      ? copy.routineNextToday(time)
      : days === 1
        ? copy.routineNextTomorrow(time)
        : copy.routineNextDate(dateWords(routine.nextRunAt, routine.timezone, locale, nextParts.year !== nowParts.year), time)

  // The zone name is said only when the row's clock differs from this device's. Two names for
  // one offset (Asia/Saigon and Asia/Ho_Chi_Minh) are the same zone to the person reading it.
  const sameZone = offsetAt(routine.timezone, routine.nextRunAt) === offsetAt(deviceTimeZone, routine.nextRunAt)

  return sameZone ? next : copy.routineNextZone(next, routine.timezone)
}
