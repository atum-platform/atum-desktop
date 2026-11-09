import { describe, expect, it } from 'vitest'

import {
  applyMatrixCheckInChange,
  applyMatrixCheckInFeedback,
  defaultMatrixCheckInSettings,
  MATRIX_CHECK_IN_COST,
  MATRIX_CHECK_IN_LIMITS,
  matrixCheckInChange,
  matrixCheckInCost,
  matrixCheckInFeedbackChange,
  type MatrixCheckInNudge,
  matrixCheckInSnoozeUntil,
  matrixCheckInStopRequested,
  parseMatrixCheckInFeedback,
  parseMatrixCheckInLedger,
  parseMatrixCheckInNudge,
  parseMatrixCheckInSettings
} from './matrix-check-ins'

const nudge: MatrixCheckInNudge = { kind: 'waiting', key: 'lan-quote', text: 'Lan is waiting', source: 'mail', action: 'draft' }

describe('"stop checking in"', () => {
  it('is heard in every language Atum speaks, with or without Vietnamese marks', () => {
    for (const words of [
      'stop checking in',
      'Stop checking in, please.',
      'turn off check-ins',
      'No more nudges!',
      'đừng nhắc nữa',
      'Thôi, đừng nhắc mình nữa nhé',
      'dung nhac nua',
      'tắt nhắc nhở',
      'チェックインをやめて',
      'もう通知をやめてください',
      '别再提醒了',
      '別再提醒了',
      '停止提醒',
      '關閉主動提醒'
    ]) {
      expect(matrixCheckInStopRequested(words), words).toBe(true)
    }
  })

  it('never fires on a longer request that merely mentions it', () => {
    for (const words of [
      'how do I stop checking in at the hotel tomorrow?',
      'stop',
      'đừng',
      'nhắc mình gọi cho Lan lúc 3 giờ',
      'remind me to stop checking in emails after 6pm',
      'Can you check in on the deploy?',
      ''
    ]) {
      expect(matrixCheckInStopRequested(words), words).toBe(false)
    }
  })
})

describe('the cost shown', () => {
  it('is a typical day under the hard ceiling, which bounds every allowed run', () => {
    const cost = matrixCheckInCost()

    expect(cost.perDay).toBeGreaterThan(0)
    expect(cost.perDay).toBeLessThan(cost.atMost)
    expect(cost.atMost).toBeGreaterThanOrEqual(cost.perRunMax * MATRIX_CHECK_IN_LIMITS.dailyRuns - 10 * MATRIX_CHECK_IN_LIMITS.dailyRuns)
    expect(cost.atMost % 10).toBe(0)
    // The ceiling follows the price: a dearer model raises it.
    expect(MATRIX_CHECK_IN_COST.max.output).toBeGreaterThanOrEqual(MATRIX_CHECK_IN_COST.typical.output)
  })
})

describe('the synced records', () => {
  it('default to on with an 08:00 brief, and refuse a newer schema rather than guess', () => {
    expect(parseMatrixCheckInSettings(undefined)).toEqual(defaultMatrixCheckInSettings())
    expect(parseMatrixCheckInSettings({ version: 1, enabled: false, brief: null })).toEqual({ enabled: false, brief: null })
    expect(parseMatrixCheckInSettings({ version: 1, brief: '04:00' })?.brief).toBe('08:00')
    expect(parseMatrixCheckInSettings({ version: 2, enabled: false })).toBeNull()
    expect(parseMatrixCheckInFeedback({ version: 2 })).toBeNull()
    expect(parseMatrixCheckInLedger({ version: 2 })).toBeNull()
  })

  it('keep only well-formed nudges and bounded lists', () => {
    expect(parseMatrixCheckInNudge({ ...nudge, ref: '../../etc/passwd' })?.ref).toBe('....etcpasswd')
    expect(parseMatrixCheckInNudge({ ...nudge, action: 'send' })).toBeUndefined()
    expect(parseMatrixCheckInNudge({ ...nudge, key: 'Has Spaces' })).toBeUndefined()

    const many = Array.from({ length: 80 }, (_, index) => ({ key: `k-${index}`, text: 't', at: index }))
    expect(parseMatrixCheckInLedger({ version: 1, sent: many })?.sent).toHaveLength(MATRIX_CHECK_IN_LIMITS.sentKept)
  })

  it('accept only the owner changes the window can make', () => {
    expect(matrixCheckInChange({ field: 'enabled', value: false })).toEqual({ field: 'enabled', value: false, by: 'settings' })
    expect(matrixCheckInChange({ field: 'brief', value: '07:30' })).toEqual({ field: 'brief', value: '07:30' })
    expect(() => matrixCheckInChange({ field: 'brief', value: '03:00' })).toThrow()
    expect(() => matrixCheckInChange({ field: 'runs', value: 0 })).toThrow()
    expect(matrixCheckInFeedbackChange({ kind: 'less', nudge: 'deadline' })).toEqual({ kind: 'less', nudge: 'deadline' })
    expect(() => matrixCheckInFeedbackChange({ kind: 'snooze', nudge: { ...nudge, action: 'send' }, until: 1 })).toThrow()
  })

  it('remember how check-ins were turned off, and forget it when turned on again', () => {
    const off = applyMatrixCheckInChange(defaultMatrixCheckInSettings(), { field: 'enabled', value: false, by: 'asked' }, 5)
    expect(off).toEqual({ enabled: false, brief: '08:00', offAt: 5, offBy: 'asked' })
    expect(applyMatrixCheckInChange(off, { field: 'enabled', value: true }, 9)).toEqual({ enabled: true, brief: '08:00' })
  })

  it('count every answer to a nudge as answering, and keep one snooze per item', () => {
    const empty = { muted: [], snoozed: [], ackAt: 0 }
    const less = applyMatrixCheckInFeedback(empty, { kind: 'less', nudge: 'deadline' }, 10)
    expect(less).toEqual({ muted: ['deadline'], snoozed: [], ackAt: 10 })

    const twice = applyMatrixCheckInFeedback(
      applyMatrixCheckInFeedback(empty, { kind: 'snooze', nudge, until: 100 }, 20),
      { kind: 'snooze', nudge, until: 200 },
      30
    )

    expect(twice.snoozed).toEqual([{ key: 'lan-quote', until: 200, nudge }])
    expect(twice.ackAt).toBe(30)
  })
})

describe('a snooze', () => {
  it('comes back three hours later, or the next morning when that would be after 22:00', () => {
    const settings = defaultMatrixCheckInSettings()
    const afternoon = new Date('2026-10-05T14:00:00')
    expect(matrixCheckInSnoozeUntil(afternoon, settings)).toBe(new Date('2026-10-05T17:00:00').getTime())

    const evening = new Date('2026-10-05T20:30:00')
    expect(matrixCheckInSnoozeUntil(evening, settings)).toBe(new Date('2026-10-06T08:00:00').getTime())
  })
})
