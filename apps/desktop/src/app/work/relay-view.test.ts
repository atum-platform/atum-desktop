import { describe, expect, it } from 'vitest'

import type {
  WorkRelayLimit,
  WorkRelayOperation,
  WorkRelayReceipt
} from '../../../shared/matrix-work-relay'

import { WORK_RELAY_PLAN_NAMES, workRelayChipText, workRelayCopy, workRelayTurnText, workRelayUsageText } from './relay-copy'
import {
  WORK_RELAY_UI_WAIT_MS,
  workRelayFallbackReason,
  type WorkRelayPickerInput,
  workRelayPickerView,
  workRelaySharedContext,
  type WorkRelayTurnChrome,
  workRelayTurnChrome,
  workRelayUsage
} from './relay-view'

const picker = (extra: Partial<WorkRelayPickerInput> = {}): WorkRelayPickerInput => ({
  plan: 'codex',
  published: true,
  connected: true,
  selection: null,
  ...extra
})

const operation = (extra: Partial<WorkRelayOperation> = {}): WorkRelayOperation => ({
  requestId: 'r'.repeat(22),
  eventId: '$event',
  roomId: '!dm:atum',
  resetEpoch: 0,
  phase: 'running',
  forwarded: true,
  threadId: 'mcp:launch:t1',
  stopOwed: false,
  ...extra
})

const SELECTED = { provider: 'atum-work' as const, plan: 'codex' as const, model: 'gpt-6-sol', revision: 2 }

describe('the native plan picker', () => {
  it('lets a published Mac’s connected plan be picked', () => {
    expect(workRelayPickerView(picker())).toEqual({ plan: 'codex', rows: 'selectable' })
  })

  it('greys a connected plan when no Mac is published', () => {
    expect(workRelayPickerView(picker({ published: false }))).toEqual({
      plan: 'codex', rows: 'greyed', greyed: 'unavailable'
    })
  })

  it('offers Connect when the Mac is published and the native plan is disconnected', () => {
    expect(workRelayPickerView(picker({ connected: false }))).toEqual({
      plan: 'codex', rows: 'greyed', greyed: 'connect', fix: 'connect'
    })
  })

  it('names the selected model, and only for its own plan', () => {
    expect(workRelayPickerView(picker({ selection: SELECTED })).currentModel).toBe('gpt-6-sol')
    expect(workRelayPickerView(picker({ plan: 'claude', selection: SELECTED })).currentModel).toBeUndefined()
  })
})

const RIN = '00000000-0000-4000-8000-00000000b001'
const LUNA = '00000000-0000-4000-8000-00000000b002'

describe('the composer chip (owner rule 11-11): only while the selection names this plan, never for a held run', () => {
  const exhausted: WorkRelayLimit = { plan: 'codex', state: 'exhausted', observedAt: 1, resetsAt: 99 }

  it('warns at the limit, after a fallback, and when the selected plan became unusable', () => {
    expect(workRelayPickerView(picker({ selection: SELECTED, limit: exhausted })).chip).toEqual({ kind: 'limit', resetsAt: 99 })
    expect(
      workRelayPickerView(picker({ selection: SELECTED, lastTurn: { kind: 'fallback', at: 'reply', reason: 'mac_off' } })).chip
    ).toEqual({ kind: 'fallback', reason: 'mac_off' })
    expect(
      workRelayPickerView(picker({ selection: SELECTED, connected: false }))
        .chip
    ).toEqual({ kind: 'greyed', greyed: 'connect' })
  })

  it('stays plain while the plan can answer, when nothing is selected, and while a run is held', () => {
    expect(workRelayPickerView(picker({ selection: SELECTED })).chip).toBeUndefined()
    expect(workRelayPickerView(picker({ limit: exhausted })).chip).toBeUndefined()

    for (const lastTurn of [
      { kind: 'waiting', at: 'message', action: 'stop' },
      { kind: 'needs_ok', at: 'message', action: 'stop' },
      { kind: 'limit', at: 'message', action: 'stop' }
    ] satisfies WorkRelayTurnChrome[]) {
      expect(workRelayPickerView(picker({ selection: SELECTED, lastTurn })).chip).toBeUndefined()
    }

    expect(workRelayPickerView(picker({ selection: SELECTED, limit: { ...exhausted, state: 'unknown' } })).chip).toBeUndefined()
  })
})

describe('one turn’s line (§3.4, §3.6, O12, O13)', () => {
  const sentAt = 1_000_000

  it('says nothing for a turn answered on the plan, or running inside the UI wait', () => {
    expect(workRelayTurnChrome({})).toEqual({ kind: 'none' })
    expect(workRelayTurnChrome({ operation: operation(), sentAt, now: sentAt + 1000 })).toEqual({ kind: 'none' })
    expect(workRelayTurnChrome({ receipt: { class: 'completed', answer: { finishedAt: sentAt + 5000 } }, sentAt })).toEqual({
      kind: 'none'
    })
    expect(workRelayTurnChrome({ receipt: { class: 'closed' } })).toEqual({ kind: 'none' })
  })

  it('names the fallback under the reply, with its short reason', () => {
    expect(workRelayTurnChrome({ fallback: 'switch_off' })).toEqual({ kind: 'fallback', at: 'reply', reason: 'switch_off' })
    expect(workRelayTurnChrome({ receipt: { class: 'refused', receipt: 'refused', reason: 'plan_consent_off' } })).toEqual({
      kind: 'fallback',
      at: 'reply',
      reason: 'consent_off'
    })
  })

  it('holds with one action: waiting for the Mac, its OK, its limit', () => {
    expect(workRelayTurnChrome({ operation: operation({ phase: 'held', hold: 'waiting_for_mac' }) })).toEqual({
      kind: 'waiting',
      at: 'message',
      action: 'stop'
    })
    expect(workRelayTurnChrome({ operation: operation(), sentAt, now: sentAt + WORK_RELAY_UI_WAIT_MS })).toEqual({
      kind: 'waiting',
      at: 'message',
      action: 'stop'
    })
    expect(workRelayTurnChrome({ operation: operation({ phase: 'held', hold: 'approval' }) })).toEqual({
      kind: 'needs_ok',
      at: 'message',
      action: 'stop'
    })
    expect(workRelayTurnChrome({ operation: operation({ phase: 'held', hold: 'question' }), onBoundMac: true })).toEqual({
      kind: 'waiting',
      at: 'message',
      action: 'stop',
      waitingForAnswer: true
    })
    expect(workRelayTurnChrome({ operation: operation({ phase: 'held', hold: 'question_invalid' }) })).toEqual({
      kind: 'waiting',
      at: 'message',
      action: 'stop',
      waitingForAnswer: true,
      invalidAnswer: true
    })
    expect(
      workRelayTurnChrome({
        operation: operation({ phase: 'held', hold: 'plan_limit' }),
        limit: { plan: 'codex', state: 'exhausted', observedAt: 1, resetsAt: 42 }
      })
    ).toEqual({ kind: 'limit', at: 'message', action: 'stop', resetsAt: 42 })
  })

  it('reads a stop as stopping until the Mac confirms it, then stopped', () => {
    expect(workRelayTurnChrome({ operation: operation({ stopOwed: true, phase: 'held', hold: 'approval' }) }).kind).toBe('stopping')
    expect(workRelayTurnChrome({ operation: operation({ phase: 'held', hold: 'stop_pending' }) }).kind).toBe('stopping')
    expect(workRelayTurnChrome({ receipt: { class: 'revoked', stopConfirmed: false } }).kind).toBe('stopping')
    expect(workRelayTurnChrome({ receipt: { class: 'revoked', stopConfirmed: true } }).kind).toBe('stopped')
    expect(
      workRelayTurnChrome({ receipt: { class: 'terminal', receipt: 'stopped', finishedAt: 5, stopConfirmed: true } }).kind
    ).toBe('stopped')
    expect(workRelayTurnChrome({ receipt: { class: 'terminal', receipt: 'cut', finishedAt: 5, stopConfirmed: false } }).kind).toBe(
      'stopping'
    )
  })

  it('marks a late answer with when it finished, and a run that ended without one', () => {
    const finishedAt = sentAt + WORK_RELAY_UI_WAIT_MS + 1
    expect(workRelayTurnChrome({ receipt: { class: 'completed', answer: { finishedAt } }, sentAt })).toEqual({
      kind: 'late',
      at: 'reply',
      finishedAt
    })
    expect(workRelayTurnChrome({ receipt: { class: 'terminal', receipt: 'empty', finishedAt, stopConfirmed: false } }).kind).toBe('empty')
    expect(workRelayTurnChrome({ receipt: { class: 'terminal', receipt: 'failed', finishedAt, stopConfirmed: false } }).kind).toBe(
      'failed'
    )
  })

  it('shows a queued message as waiting behind the open one', () => {
    expect(workRelayTurnChrome({ queued: true, operation: operation() })).toEqual({ kind: 'queued', at: 'message' })
  })

  // The one safety rule (§3.5): only a receipt that proves non-dispatch lets the Atum model answer.
  it('never reads a fallback from anything but a refused receipt', () => {
    const receipts: WorkRelayReceipt[] = [
      { class: 'closed' },
      { class: 'none' },
      { class: 'pending', operation: operation({ phase: 'admitted' }) },
      { class: 'accepted', operation: operation() },
      { class: 'ambiguous', forwarded: true, reason: 'timeout' },
      { class: 'ambiguous', forwarded: false, reason: 'unreachable' },
      { class: 'revoked', stopConfirmed: false },
      { class: 'completed', answer: { finishedAt: 2 } },
      { class: 'terminal', receipt: 'failed', finishedAt: 2, stopConfirmed: false, reason: 'rate_limited' },
      { class: 'terminal', receipt: 'empty', finishedAt: 2, stopConfirmed: false }
    ]

    for (const receipt of receipts) {
      expect(workRelayTurnChrome({ receipt, sentAt: 0, now: 1 }).kind).not.toBe('fallback')
    }

    expect(workRelayTurnChrome({ receipt: { class: 'ambiguous', forwarded: false, reason: 'unreachable' } }).kind).toBe('waiting')
  })
})

describe('fallback reasons', () => {
  it.each([
    ['offline', 'mac_off'],
    ['mac_offline', 'mac_off'],
    ['timeout', 'mac_off'],
    ['plan_consent_off', 'consent_off'],
    ['plan_switch_off', 'switch_off'],
    ['rate_limited', 'limit'],
    ['plan_limit', 'limit'],
    ['plan_consent_stale', 'other'],
    ['provider_not_ready', 'other'],
    ['anything else', 'other']
  ] as const)('%s → %s', (code, reason) => {
    expect(workRelayFallbackReason(code)).toBe(reason)
  })
})

describe('the plan usage line and the shared-context line', () => {
  it('reads usage as used, at the limit, or unknown, never as unlimited', () => {
    expect(workRelayUsage(undefined)).toEqual({ kind: 'unknown' })
    expect(workRelayUsage({ plan: 'codex', state: 'unknown', observedAt: 1, usedPercent: 10 })).toEqual({ kind: 'unknown' })
    expect(workRelayUsage({ plan: 'codex', state: 'available', observedAt: 1 })).toEqual({ kind: 'unknown' })
    expect(workRelayUsage({ plan: 'codex', state: 'available', observedAt: 1, usedPercent: 41.6, resetsAt: 9 })).toEqual({
      kind: 'used',
      percent: 42,
      resetsAt: 9
    })
    expect(workRelayUsage({ plan: 'codex', state: 'exhausted', observedAt: 1, usedPercent: 100 })).toEqual({ kind: 'limit' })
  })

  it('lists each assistant once, in order', () => {
    expect(workRelaySharedContext([LUNA, RIN, LUNA])).toEqual([LUNA, RIN])
    expect(workRelaySharedContext([])).toEqual([])
  })
})

describe('the words (airy: one line, no cost, no relay, no token)', () => {
  const chromes: WorkRelayTurnChrome[] = [
    { kind: 'fallback', at: 'reply', reason: 'mac_off' },
    { kind: 'fallback', at: 'reply', reason: 'consent_off' },
    { kind: 'fallback', at: 'reply', reason: 'switch_off' },
    { kind: 'fallback', at: 'reply', reason: 'limit' },
    { kind: 'fallback', at: 'reply', reason: 'other' },
    { kind: 'waiting', at: 'message', action: 'stop' },
    { kind: 'needs_ok', at: 'message', action: 'open_work' },
    { kind: 'limit', at: 'message', action: 'stop', resetsAt: Date.UTC(2026, 10, 22, 9, 40) },
    { kind: 'limit', at: 'message', action: 'stop' },
    { kind: 'stopping', at: 'message' },
    { kind: 'stopped', at: 'message' },
    { kind: 'queued', at: 'message' },
    { kind: 'late', at: 'reply', finishedAt: Date.UTC(2026, 10, 22, 9, 12) },
    { kind: 'empty', at: 'message' },
    { kind: 'failed', at: 'message' }
  ]

  it.each(['en', 'vi'])('words every state in one short line (%s)', locale => {
    const context = { words: workRelayCopy(locale), plan: WORK_RELAY_PLAN_NAMES.codex, model: 'Nguyệt Thực', now: Date.UTC(2026, 10, 22, 8), locale }

    for (const chrome of chromes) {
      const line = workRelayTurnText(chrome, context)
      expect(line?.text.length).toBeGreaterThan(0)
      expect(line!.text).not.toMatch(/\n|Proton|\$|relay|token|cost/iu)
      expect(line!.text.length).toBeLessThanOrEqual(64)
    }

    expect(workRelayTurnText({ kind: 'none' }, context)).toBeNull()
    expect(workRelayTurnText(chromes[0]!, context)!.text).toContain('Nguyệt Thực')
  })

  it('words the chip and the usage line', () => {
    const context = { words: workRelayCopy('en'), plan: 'ChatGPT', model: 'Nguyệt Thực', now: Date.UTC(2026, 10, 22, 8), locale: 'en' }
    expect(workRelayChipText(undefined, context)).toBeUndefined()
    expect(workRelayChipText({ kind: 'limit' }, context)).toBe('ChatGPT limit reached')
    expect(workRelayChipText({ kind: 'fallback', reason: 'mac_off' }, context)).toBe('Nguyệt Thực answered · your Mac was off')
    expect(workRelayChipText({ kind: 'greyed', greyed: 'connect' }, context)).toBe('ChatGPT isn’t connected on any of your Macs')
    expect(workRelayUsageText({ kind: 'used', percent: 42 }, { words: context.words, now: 0, locale: 'en' })).toBe('42% used')
    const weeklyReset = Date.UTC(2026, 10, 29, 8, 14)
    expect(workRelayUsageText({ kind: 'used', percent: 42, resetsAt: weeklyReset }, context)).toMatch(/resets .*:\d{2}/u)
    expect(workRelayUsageText({ kind: 'unknown' }, { words: context.words, now: 0, locale: 'en' })).toBe('Usage not reported')
  })
})
