import { describe, expect, it } from 'vitest'

import { matrixClock, matrixDayLabel, matrixFullTime } from './message-time'

const zone = { timeZone: 'Asia/Ho_Chi_Minh' }
const at = (value: string) => Date.parse(value)

describe('Matrix message time', () => {
  it('uses the app locale and a pinned local time zone', () => {
    const timestamp = at('2026-10-29T07:32:00.000Z')

    expect(matrixClock(timestamp, 'en', zone)).toBe('2:32 PM')
    expect(matrixClock(timestamp, 'vi', zone)).toBe('14:32')
    expect(matrixFullTime(timestamp, 'vi', zone)).toBe('14:32 · Thứ Năm, 29 tháng 10, 2026')
  })

  it('labels calendar days relative to local midnight for any supplied now', () => {
    const now = at('2026-10-31T05:00:00.000Z')

    expect(matrixDayLabel(at('2026-10-31T00:01:00.000Z'), 'en', now, zone)).toBe('Today')
    expect(matrixDayLabel(at('2026-10-30T16:59:00.000Z'), 'vi', now, zone)).toBe('Hôm qua')
    expect(matrixDayLabel(at('2026-10-29T07:32:00.000Z'), 'en', now, zone)).toBe('Thursday, October 29')
    expect(matrixDayLabel(at('2025-12-03T07:32:00.000Z'), 'en', now, zone)).toBe('Wednesday, December 3, 2025')
  })
})
