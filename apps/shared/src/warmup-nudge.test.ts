import { describe, expect, it } from 'vitest'

import {
  fitWarmupNudgeSnapshot,
  FOLLOWUP_SWEEP_BOUNDS,
  FOLLOWUP_SWEEP_RESULT_PROFILE,
  followupSweepEvidence,
  type FollowupSweepEvidenceSnapshot,
  followupSweepSnapshot,
  validateWarmupNudgeResult,
  type WarmupNudgeIndex,
  warmupNudgePrompt
} from './followup-sweep'

const watermarks = { googleMail: null, googleCalendar: null, atumChats: null, conversation: null, memory: null }
const at = Date.parse('2026-10-26T02:00:00.000Z') // 09:00 Asia/Ho_Chi_Minh

async function snapshot(): Promise<FollowupSweepEvidenceSnapshot> {
  const entry = await followupSweepEvidence({ source: 'google_mail', scope: 'account-1', objectId: 'thread-1',
    anchorId: 'message-1', dueAt: null, observedAt: at, title: 'Contract',
    text: 'Lan needs a reply by 15:00.', fresh: true })

  return followupSweepSnapshot({ capturedAt: at, ownerTimeZone: 'Asia/Ho_Chi_Minh', watermarks,
    sources: [{ source: 'google_mail', status: 'ok' }], entries: [entry] })
}

const offer = (overrides: Record<string, unknown> = {}) => ({ profile: FOLLOWUP_SWEEP_RESULT_PROFILE,
  decision: 'offer', evidenceIds: [], urgency: 'normal', text: 'Bạn đã nhắc về buổi ra mắt. Tôi phác thảo kế hoạch nhé?',
  ...overrides })

describe('shared warm-up nudge instruction', () => {
  it('writes one English instruction that defers the message language to memory and past chats', async () => {
    const current = await snapshot()
    const prompt = warmupNudgePrompt(current, 1)

    expect(prompt).toContain('warm-up nudge 1 of 4')
    expect(prompt).toContain("owner's own language")
    expect(prompt).toContain('memory and past chats')
    expect(prompt).toContain('One known fact → one new detail')
    expect(prompt).toContain('decision must be "offer"')
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(FOLLOWUP_SWEEP_BOUNDS.maxPromptBytes)
  })

  it('names the source mix and deepens from fact to detail to connection to action', async () => {
    const current = await snapshot()
    const prompts = ([1, 2, 3, 4] as WarmupNudgeIndex[]).map(index => warmupNudgePrompt(current, index))

    expect(prompts[0]).toContain('Sources: memory, first-run conversation, recent mail/calendar/files/chats')
    expect(prompts[1]).toContain('past-30-days/today/tomorrow calendar')
    expect(prompts[1]).toContain('read or unread, not only unread')
    expect(prompts[2]).toContain('Sources: mail, calendar, files, chats, memory')
    expect(prompts[3]).toContain('Sources: everything above')
    expect(new Set(prompts).size).toBe(4)
  })

  it('never lets a nudge claim it read a source that is not supplied', async () => {
    const current = await snapshot()
    const prompt = warmupNudgePrompt(current, 2)

    expect(prompt).toContain('Never claim you read a mail thread, file, mail category, chat or past calendar date that is not listed')
    expect(prompt).toContain('past 30 days plus today and tomorrow')
    expect(prompt).not.toContain('Past calendar dates are not supplied')
  })

  it('fits the same prompt byte budget without dropping the nudge', async () => {
    const current = await snapshot()
    const fitted = await fitWarmupNudgeSnapshot(current, 3)

    expect(fitted.digest).toMatch(/^[a-f0-9]{64}$/u)
    expect(new TextEncoder().encode(warmupNudgePrompt(fitted, 3)).byteLength)
      .toBeLessThanOrEqual(FOLLOWUP_SWEEP_BOUNDS.maxPromptBytes)
  })
})

describe('shared warm-up nudge result', () => {
  it('accepts one sendable offer with no evidence and drops an invented id', async () => {
    const current = await snapshot()
    const empty = validateWarmupNudgeResult(offer(), current)
    expect(empty.result).toMatchObject({ decision: 'offer', evidenceIds: [], urgency: 'normal' })
    expect(empty.findingHashes).toEqual([])

    const invented = validateWarmupNudgeResult(offer({ evidenceIds: ['mail:invented'] }), current)
    expect(invented.result.decision).toBe('offer')
    expect(invented.findingHashes).toEqual([])

    const grounded = validateWarmupNudgeResult(offer({ evidenceIds: [current.entries[0]!.id] }), current)
    expect(grounded.result.decision).toBe('offer')
    expect(grounded.findingHashes).toEqual([current.entries[0]!.findingHash])
  })

  it('never publishes an empty or malformed nudge', async () => {
    const current = await snapshot()

    expect(validateWarmupNudgeResult(offer({ text: '' }), current).result.decision).toBe('silent')
    expect(validateWarmupNudgeResult(
      offer({ text: 'I checked the current sources and recommend starting with the contract.' }), current).result.decision)
      .toBe('offer')
    expect(validateWarmupNudgeResult(offer({ text: 'Two\nlines?' }), current).result.decision).toBe('silent')
    expect(validateWarmupNudgeResult(offer({ urgency: 'harm_before_morning' }), current).result.decision).toBe('silent')
    expect(validateWarmupNudgeResult({ profile: FOLLOWUP_SWEEP_RESULT_PROFILE, decision: 'silent' }, current).result.decision)
      .toBe('silent')
    expect(validateWarmupNudgeResult(offer({ text: `${'a'.repeat(500)}?` }), current).result.decision).toBe('silent')
  })
})
