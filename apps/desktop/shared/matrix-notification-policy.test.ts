import { describe, expect, it } from 'vitest'

import {
  applyMatrixNotificationPolicyChange,
  defaultMatrixNotificationPolicy,
  matrixEffectiveDoNotDisturb,
  matrixNotificationPolicyChange,
  matrixQuietHoursActive,
  matrixResolvedNotificationLevel,
  parseMatrixNotificationPolicy
} from './matrix-notification-policy'

describe('Matrix notification policy', () => {
  it('resolves thread over channel over account and removes overrides back to inheritance', () => {
    let policy = defaultMatrixNotificationPolicy('Asia/Ho_Chi_Minh')
    policy = applyMatrixNotificationPolicyChange(policy, { scope: 'account', level: 'nothing' })
    policy = applyMatrixNotificationPolicyChange(policy, {
      scope: 'channel', roomId: '!launch:test', level: 'all'
    })
    policy = applyMatrixNotificationPolicyChange(policy, {
      scope: 'thread', roomId: '!launch:test', rootId: '$budget', level: 'mentions'
    })

    expect(matrixResolvedNotificationLevel(policy, '!other:test')).toBe('nothing')
    expect(matrixResolvedNotificationLevel(policy, '!launch:test')).toBe('all')
    expect(matrixResolvedNotificationLevel(policy, '!launch:test', '$budget')).toBe('mentions')
    expect(matrixResolvedNotificationLevel(policy, '!launch:test', '$other')).toBe('all')

    policy = applyMatrixNotificationPolicyChange(policy, {
      scope: 'thread', roomId: '!launch:test', rootId: '$budget', level: 'inherit'
    })
    policy = applyMatrixNotificationPolicyChange(policy, {
      scope: 'channel', roomId: '!launch:test', level: 'inherit'
    })

    expect(policy.threadOverrides).toEqual({})
    expect(policy.channelOverrides).toEqual({})
    expect(matrixResolvedNotificationLevel(policy, '!launch:test', '$budget')).toBe('nothing')
  })

  it('round-trips one bounded account-data record and refuses malformed or newer content', () => {
    const policy = applyMatrixNotificationPolicyChange(
      defaultMatrixNotificationPolicy('America/New_York'),
      { scope: 'channel', roomId: '!launch:test', level: 'all' }
    )

    expect(parseMatrixNotificationPolicy(JSON.parse(JSON.stringify(policy)))).toEqual(policy)
    expect(parseMatrixNotificationPolicy({ ...policy, version: 2 })).toBeUndefined()
    expect(parseMatrixNotificationPolicy({ ...policy, quietHours: { ...policy.quietHours, timeZone: 'Mars/Base' } }))
      .toBeUndefined()
    expect(() => matrixNotificationPolicyChange({ scope: 'thread', roomId: '!launch:test', rootId: '~local', level: 'all' }))
      .toThrow('invalid')
  })

  it('handles a daily window across midnight in its saved time zone', () => {
    const quiet = {
      enabled: true,
      startMinute: 22 * 60,
      endMinute: 7 * 60,
      timeZone: 'America/New_York'
    }

    expect(matrixQuietHoursActive(quiet, Date.parse('2026-07-01T03:00:00Z'))).toBe(true) // 23:00
    expect(matrixQuietHoursActive(quiet, Date.parse('2026-07-01T10:59:00Z'))).toBe(true) // 06:59
    expect(matrixQuietHoursActive(quiet, Date.parse('2026-07-01T11:00:00Z'))).toBe(false) // 07:00
    expect(matrixQuietHoursActive({ ...quiet, startMinute: 7 * 60, endMinute: 22 * 60 }, Date.parse('2026-07-01T16:00:00Z')))
      .toBe(true) // 12:00
  })

  it('uses wall-clock time through spring-forward and both fall-back hours', () => {
    const quiet = {
      enabled: true,
      startMinute: 60,
      endMinute: 4 * 60,
      timeZone: 'America/New_York'
    }

    // 2026-03-08 has no 02:xx in New York; the daily window still spans 01:00–04:00.
    expect(matrixQuietHoursActive(quiet, Date.parse('2026-03-08T06:30:00Z'))).toBe(true) // 01:30 EST
    expect(matrixQuietHoursActive(quiet, Date.parse('2026-03-08T07:30:00Z'))).toBe(true) // 03:30 EDT
    expect(matrixQuietHoursActive(quiet, Date.parse('2026-03-08T08:00:00Z'))).toBe(false) // 04:00 EDT

    // 2026-11-01 repeats 01:30; both instances are in the same saved wall-clock window.
    expect(matrixQuietHoursActive(quiet, Date.parse('2026-11-01T05:30:00Z'))).toBe(true) // 01:30 EDT
    expect(matrixQuietHoursActive(quiet, Date.parse('2026-11-01T06:30:00Z'))).toBe(true) // 01:30 EST
  })

  it('composes status DND and quiet hours into one effective state', () => {
    const now = Date.parse('2026-10-30T15:30:00Z') // 22:30 Asia/Ho_Chi_Minh
    const base = {
      identity: { userId: '@alice:test' },
      notificationPolicy: {
        quietHours: { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60, timeZone: 'Asia/Ho_Chi_Minh' }
      }
    }

    expect(matrixEffectiveDoNotDisturb(base, now)).toBe(true)
    expect(matrixEffectiveDoNotDisturb({
      ...base,
      notificationPolicy: { quietHours: { ...base.notificationPolicy.quietHours, enabled: false } },
      presence: { users: [{ userId: '@alice:test', status: { dnd: true, expiresAt: now + 1_000 } }] }
    }, now)).toBe(true)
    expect(matrixEffectiveDoNotDisturb({
      ...base,
      notificationPolicy: { quietHours: { ...base.notificationPolicy.quietHours, enabled: false } },
      presence: { users: [{ userId: '@alice:test', status: { dnd: true, expiresAt: now - 1 } }] }
    }, now)).toBe(false)
  })
})
