import { describe, expect, it } from 'vitest'

import { DESKTOP_LOCALES, type DesktopLocale } from './desktop-locale'
import {
  isMatrixAgentClosedStatusCode,
  MATRIX_AGENT_STATUS_CODES,
  matrixAgentAccessRemedy,
  matrixAgentStatusCopy,
  matrixAgentStatusText,
  matrixCheckingLine
} from './matrix-agent-status-copy'

describe('matrix agent access-status copy', () => {
  it('publishes exactly the frozen notice vocabulary (agent-home status codes plus agent-turns/1.5 device_unreachable)', () => {
    expect(MATRIX_AGENT_STATUS_CODES).toEqual([
      'stopped', 'failed', 'deadline', 'couldnt_confirm', 'unfunded', 'trial_expired', 'queue_full',
      'memory_not_saved', 'couldnt_verify_mac', 'resuming_on_device', 'attachment_unsupported', 'thread_unsupported',
      'saved_to_drive', 'saved_as_copy', 'save_unconfirmed', 'reply_unreadable',
      'turn_limit', 'reminder_missed', 'stuck', 'access_final', 'daily_cap', 'daily_cap_warning',
      'device_unreachable'
    ])
  })

  it.each(DESKTOP_LOCALES)('keeps the %s access remedy consumer-owned and locale-specific', locale => {
    const copy = matrixAgentStatusCopy[locale]
    const remedy = matrixAgentAccessRemedy(locale)

    expect(remedy).toBe(copy.accessRemedy)
    expect(matrixAgentStatusText('unfunded', locale)).toBe(`${copy.unfunded} ${remedy}`)
    expect(matrixAgentStatusText('trial_expired', locale)).toBe(`${copy.trialExpired} ${remedy}`)
    expect(matrixAgentStatusText('access_final', locale)).toBe(`${copy.accessFinal} ${remedy}`)
    expect(matrixAgentStatusText('turn_limit', locale)).toBe(copy.turnLimit)
    expect(matrixAgentStatusText('reminder_missed', locale)).toBe(copy.reminderMissed)
    expect(matrixAgentStatusText('stuck', locale)).toBe(copy.stuck)
  })

  it('uses Vietnamese when a stale locale reaches the native boundary', () => {
    expect(matrixAgentAccessRemedy('stale' as DesktopLocale)).toBe(matrixAgentStatusCopy.vi.accessRemedy)
  })

  it.each(DESKTOP_LOCALES)('says the daily-cap refusal in %s as plain state, never a number or a meter', locale => {
    const text = matrixAgentStatusText('daily_cap', locale)

    expect(text).toBe(matrixAgentStatusCopy[locale].dailyCap)
    expect(text.length).toBeGreaterThan(20)
    expect(text.split('\n')).toHaveLength(1)
    expect(text).not.toMatch(/\d/u)
    expect(text).not.toMatch(/Proton|usedProtons|balance|số dư|残高|余额|餘額/i)
  })

  it.each(DESKTOP_LOCALES)('says the quiet daily-cap warning in %s as plain state, never a number or a meter', locale => {
    const text = matrixAgentStatusText('daily_cap_warning', locale)

    expect(text).toBe(matrixAgentStatusCopy[locale].dailyCapWarning)
    expect(text.length).toBeGreaterThan(20)
    expect(text.split('\n')).toHaveLength(1)
    expect(text).not.toMatch(/\d/u)
    expect(text).not.toMatch(/Proton|usedProtons|balance|số dư|残高|余额|餘額/i)
  })

  it('does not close the message with the 80% warning', () => {
    expect(isMatrixAgentClosedStatusCode('daily_cap_warning')).toBe(false)
  })

  it('closes a message with the daily-cap line, because the turn ended without an answer', () => {
    expect(isMatrixAgentClosedStatusCode('daily_cap')).toBe(true)
  })

  it('does not tell owners to top up Proton or claim an operator was alerted', () => {
    const allCopy = Object.values(matrixAgentStatusCopy).flatMap(copy => Object.values(copy).filter(value => typeof value === 'string'))

    expect(allCopy.join('\n')).not.toMatch(/Proton|top up|充值|儲值|nạp thêm|operator|paged|notified|alerted|đã báo/i)
  })

  it.each(DESKTOP_LOCALES)('never closes a message with a "couldn’t confirm" meta-notice in %s: it says what happened and what to do', locale => {
    const meta = /chưa xác nhận|couldn[’']t confirm|could not confirm|確認できな|[没沒]能(确认|確認)|无法确认|無法確認|未能确认/i

    const texts = [
      matrixAgentStatusText('couldnt_confirm', locale),
      matrixAgentStatusText('couldnt_confirm', locale, { devices: ['MacBook mẫu', 'Mac mini'] }),
      matrixAgentStatusText('save_unconfirmed', locale)
    ]

    for (const text of texts) {
      expect(text).not.toMatch(meta)
      expect(text.length).toBeGreaterThan(40)
    }

    // The Macs that may have run it are named, whichever language.
    expect(texts[1]).toContain('MacBook mẫu')
    expect(texts[1]).toContain('Mac mini')
    expect(texts[1]!.startsWith(texts[0]!)).toBe(true)
  })

  it('tells the Vietnamese owner an interrupted job may be half done, that it will not run twice, and the one thing to say', () => {
    expect(matrixAgentStatusText('couldnt_confirm', 'vi')).toBe(
      'Việc này bị ngắt giữa chừng nên có thể mới làm được một phần. Mình không tự làm lại để khỏi làm hai lần. Bạn nhắn “kiểm tra lại” để mình xem đã xong đến đâu nhé.'
    )
  })

  it.each(DESKTOP_LOCALES)('says in %s, in one short human line, that it is looking at how far it got: no meta-notice, not a status', locale => {
    const line = matrixCheckingLine(locale)

    expect(line.length).toBeGreaterThan(10)
    expect(line.length).toBeLessThan(80)
    expect(line.split('\n')).toHaveLength(1)
    expect(line).not.toMatch(/chưa xác nhận|couldn[’']t confirm|could not confirm|確認できな|无法确认|無法確認/i)
  })

  it('says the Vietnamese checking line exactly, and falls back to it for a stale locale', () => {
    expect(matrixCheckingLine('vi')).toBe('Mình bị ngắt giữa chừng, để mình xem lại đã làm tới đâu…')
    expect(matrixCheckingLine('stale' as DesktopLocale)).toBe(matrixCheckingLine('vi'))
  })
})
