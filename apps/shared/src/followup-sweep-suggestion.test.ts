import { describe, expect, it } from 'vitest'

import {
  FOLLOWUP_SWEEP_BOUNDS,
  FOLLOWUP_SWEEP_RESULT_PROFILE,
  followupSweepEvidence,
  type FollowupSweepEvidenceSnapshot,
  followupSweepFindingIdentity,
  followupSweepInsideSuggestionWindow,
  followupSweepLocalDay,
  followupSweepNeedsSuggestion,
  followupSweepPrompt,
  followupSweepSnapshot,
  followupSweepSuggestionHistory,
  followupSweepSuggestionNote,
  validateFollowupSweepSuggestion
} from './followup-sweep'

const watermarks = { googleMail: null, googleCalendar: null, atumChats: null, conversation: null, memory: null }
const ownerId = '@owner:atum.test'
const otherOwnerId = '@other:atum.test'
const midday = Date.parse('2026-10-26T04:30:00.000Z') // 11:30 Asia/Ho_Chi_Minh

async function snapshot(at: number, fresh = false): Promise<FollowupSweepEvidenceSnapshot> {
  const entry = await followupSweepEvidence({ source: 'google_mail', scope: 'account-1', objectId: 'thread-1',
    anchorId: 'message-1', dueAt: null, observedAt: at, title: 'Contract',
    text: 'Lan needs a reply by 15:00.', fresh })

  return followupSweepSnapshot({ capturedAt: at, ownerTimeZone: 'Asia/Ho_Chi_Minh', watermarks,
    sources: [{ source: 'google_mail', status: 'ok' }], entries: [entry] })
}

const offer = (overrides: Record<string, unknown> = {}) => ({ profile: FOLLOWUP_SWEEP_RESULT_PROFILE,
  decision: 'offer', evidenceIds: [], urgency: 'normal',
  text: 'I could draft a one-page brief for the launch you keep postponing. Want me to start it?', ...overrides })

describe('quiet suggestion policy', () => {
  it('is due only without a fresh external finding inside the owner-local mid-day window', async () => {
    expect(followupSweepNeedsSuggestion(await snapshot(midday))).toBe(true)
    expect(followupSweepNeedsSuggestion(await snapshot(midday, true))).toBe(false)
    expect(followupSweepNeedsSuggestion(await snapshot(Date.parse('2026-10-26T03:59:00.000Z')))).toBe(false) // 10:59
    expect(followupSweepNeedsSuggestion(await snapshot(Date.parse('2026-10-26T06:00:00.000Z')))).toBe(false) // 13:00
    expect(followupSweepNeedsSuggestion(await snapshot(Date.parse('2026-10-25T18:00:00.000Z')))).toBe(false) // 01:00

    expect(followupSweepInsideSuggestionWindow(midday, 'Asia/Ho_Chi_Minh')).toBe(true)
    expect(followupSweepInsideSuggestionWindow(midday, 'Pacific/Auckland')).toBe(false)
  })

  it('asks for one grounded, honest suggestion in the owner language and no evidence IDs', async () => {
    const prompt = followupSweepPrompt(await snapshot(midday), 'suggestion')

    expect(prompt).toContain('no fresh mail, calendar or chat finding')
    expect(prompt).toContain('evidenceIds must be []')
    expect(prompt).toContain('Use decision "silent"')
    expect(prompt).toContain('read-only facts you verify with the tools available in this run')
    expect(prompt).toContain('Write entirely in the owner\'s own language')
    expect(prompt).not.toContain('harm_before_morning"; the latter')
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(FOLLOWUP_SWEEP_BOUNDS.maxPromptBytes)
  })

  it('passes yesterday\'s admitted suggestion as a negative example', async () => {
    const prompt = followupSweepPrompt(await snapshot(midday), 'suggestion',
      { previousSuggestion: 'Shall I turn the launch notes into a one-page plan?' })

    expect(prompt).toContain('Yesterday\'s admitted suggestion')
    expect(prompt).toContain('turn the launch notes into a one-page plan')
    expect(prompt).toContain('Do not repeat yesterday\'s suggestion')
    expect(followupSweepPrompt(await snapshot(midday), 'finding',
      { previousSuggestion: 'Shall I turn the launch notes into a one-page plan?' }))
      .not.toContain('Yesterday\'s admitted suggestion')
  })

  it('derives one day-scoped finding hash and accepts only an evidence-free normal offer', async () => {
    const current = await snapshot(midday)
    const day = followupSweepLocalDay(midday, 'Asia/Ho_Chi_Minh')!
    const identity = await followupSweepFindingIdentity({ source: 'conversation', scope: ownerId, objectId: ownerId,
      anchorId: `suggestion:${day.date}`, dueAt: day.startMs })

    expect(day).toEqual({ date: '2026-10-26', startMs: Date.parse('2026-10-25T17:00:00.000Z') })

    const result = await validateFollowupSweepSuggestion(offer(), current, ownerId)

    expect(result.result).toEqual({ profile: FOLLOWUP_SWEEP_RESULT_PROFILE, decision: 'offer', evidenceIds: [],
      urgency: 'normal', text: offer().text })
    expect(result.findingHashes).toEqual([identity.findingHash])
    expect(await validateFollowupSweepSuggestion('not json', current, ownerId)).toMatchObject({
      result: { decision: 'silent' }, findingHashes: [] })
  })

  it('keeps the same suggestion identity all day and changes it on the next local day', async () => {
    const first = await validateFollowupSweepSuggestion(offer(), await snapshot(midday), ownerId)
    const later = await validateFollowupSweepSuggestion(offer({ text: 'Different words, same day. Ready to start?' }),
      await snapshot(Date.parse('2026-10-26T05:30:00.000Z')), ownerId) // 12:30
    const tomorrow = await validateFollowupSweepSuggestion(offer(), await snapshot(midday + 86_400_000), ownerId)

    expect(later.findingHashes).toEqual(first.findingHashes)
    expect(tomorrow.findingHashes).not.toEqual(first.findingHashes)
  })

  it('scopes the day identity to the owner, not to one agent or room', async () => {
    const first = await validateFollowupSweepSuggestion(offer(), await snapshot(midday), ownerId)
    const sameOwner = await validateFollowupSweepSuggestion(offer({ text: 'Another agent, same owner. Start now?' }),
      await snapshot(midday), ownerId)
    const otherOwner = await validateFollowupSweepSuggestion(offer(), await snapshot(midday), otherOwnerId)

    expect(sameOwner.findingHashes).toEqual(first.findingHashes)
    expect(otherOwner.findingHashes).not.toEqual(first.findingHashes)
  })

  it('reads one owner-scoped note as today\'s block and yesterday\'s negative example', async () => {
    const note = followupSweepSuggestionNote({ owner: ownerId, date: '2026-10-25', at: midday - 86_400_000,
      text: 'Shall I turn the launch notes into a one-page plan?', admitted: true })

    expect(followupSweepSuggestionHistory(await snapshot(midday), ownerId, note)).toEqual({
      offeredToday: false, previousText: 'Shall I turn the launch notes into a one-page plan?' })
    expect(followupSweepSuggestionHistory(await snapshot(midday), ownerId,
      { ...note!, date: '2026-10-26' })).toEqual({ offeredToday: true, previousText: null })
    expect(followupSweepSuggestionHistory(await snapshot(midday), ownerId,
      { ...note!, admitted: false })).toEqual({ offeredToday: false, previousText: null })
    expect(followupSweepSuggestionHistory(await snapshot(midday), otherOwnerId, note)).toEqual({
      offeredToday: false, previousText: null })
    expect(followupSweepSuggestionNote({ ...note, text: 'I recommend starting with the launch brief.' }))
      .toMatchObject({ text: 'I recommend starting with the launch brief.' })
    expect(followupSweepSuggestionNote({ ...note, owner: '' })).toBeNull()
    expect(followupSweepSuggestionNote({ ...note, extra: true })).toBeNull()
  })

  it('silences cited evidence, quiet hours, bad prose and an unusable owner', async () => {
    const current = await snapshot(midday)
    const quiet = await snapshot(Date.parse('2026-10-25T18:00:00.000Z'))

    expect((await validateFollowupSweepSuggestion(offer({ evidenceIds: [current.entries[0]!.id] }), current, ownerId))
      .result.decision).toBe('silent')
    expect((await validateFollowupSweepSuggestion(offer(), quiet, ownerId)).result.decision).toBe('silent')
    expect((await validateFollowupSweepSuggestion(offer({ urgency: 'harm_before_morning' }), current, ownerId))
      .result.decision).toBe('silent')
    expect((await validateFollowupSweepSuggestion(
      offer({ text: 'I recommend starting with the launch brief.' }), current, ownerId)).result.decision).toBe('offer')
    expect((await validateFollowupSweepSuggestion(offer({ text: '- Shall I start?' }), current, ownerId)).result.decision)
      .toBe('silent')
    expect((await validateFollowupSweepSuggestion(offer({ text: 'Want me to start? 🙂' }), current, ownerId)).result.decision)
      .toBe('silent')
    expect((await validateFollowupSweepSuggestion(offer(), current, '')).result.decision).toBe('silent')
  })
})
