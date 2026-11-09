const DAY_MS = 86_400_000

interface MatrixTimeFormatOptions {
  /** Tests pin this; production omits it so the device time zone applies. */
  timeZone?: string
}

function dateParts(timestamp: number, locale: string, options: MatrixTimeFormatOptions = {}) {
  const parts = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    ...options
  }).formatToParts(timestamp)
  const number = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value)

  return { year: number('year'), month: number('month'), day: number('day') }
}

function calendarDay(timestamp: number, locale: string, options: MatrixTimeFormatOptions = {}): number {
  const { year, month, day } = dateParts(timestamp, locale, options)

  return Date.UTC(year, month - 1, day)
}

/** Whether two moments fall on different calendar days in the device time zone. */
export function matrixNewDay(previous: number | undefined, current: number): boolean {
  if (previous === undefined || !Number.isFinite(previous) || !Number.isFinite(current)) {
    return true
  }

  const before = new Date(previous)
  const after = new Date(current)

  return before.getFullYear() !== after.getFullYear() ||
    before.getMonth() !== after.getMonth() ||
    before.getDate() !== after.getDate()
}

/** The short clock shown in a run or hover toolbar. */
export function matrixClock(timestamp: number, locale: string, options: MatrixTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', ...options }).format(timestamp)
}

/** A clock followed by the full local date, for a timestamp tip. */
export function matrixFullTime(timestamp: number, locale: string, options: MatrixTimeFormatOptions = {}): string {
  const date = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    ...options
  }).format(timestamp)

  return `${matrixClock(timestamp, locale, options)} · ${date}`
}

/** "Today", "Yesterday", else the weekday and date, in the person's language. */
export function matrixDayLabel(
  timestamp: number,
  locale: string,
  now = Date.now(),
  options: MatrixTimeFormatOptions = {}
): string {
  const days = Math.round((calendarDay(now, locale, options) - calendarDay(timestamp, locale, options)) / DAY_MS)

  if (days === 0 || days === 1) {
    const word = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-days, 'day')

    return word.charAt(0).toLocaleUpperCase(locale) + word.slice(1)
  }

  const current = dateParts(now, locale, options)
  const then = dateParts(timestamp, locale, options)

  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(then.year === current.year ? {} : { year: 'numeric' }),
    ...options
  }).format(timestamp)
}

export function matrixDateTime(timestamp: number): string | undefined {
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined
}

const MINUTE_MS = 60_000

/**
 * How long ago, in words, for a thread's "Last reply …" (Slack's and Mattermost's line): at least
 * a minute (a reply never reads "now" or as coming from the future on a skewed clock), then hours,
 * days ("yesterday"), months and years.
 */
export function matrixAgo(timestamp: number, locale: string, now = Date.now()): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'long' })
  const minutes = Math.max(1, Math.round((now - timestamp) / MINUTE_MS))

  if (minutes < 60) {
    return format.format(-minutes, 'minute')
  }

  const hours = Math.round(minutes / 60)

  if (hours < 24) {
    return format.format(-hours, 'hour')
  }

  const days = Math.round(hours / 24)

  if (days < 30) {
    return format.format(-days, 'day')
  }

  const months = Math.max(1, Math.round(days / 30.44))

  return months < 12 ? format.format(-months, 'month') : format.format(-Math.max(1, Math.round(days / 365.25)), 'year')
}
