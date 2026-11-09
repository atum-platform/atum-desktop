import { describe, expect, it } from 'vitest'

import {
  fitFollowupSweepSnapshot,
  FOLLOWUP_SWEEP_BOUNDS,
  FOLLOWUP_SWEEP_RESULT_PROFILE,
  followupSweepEvidence,
  type FollowupSweepEvidenceSnapshot,
  followupSweepFindingIdentity,
  followupSweepInsideNormalWindow,
  followupSweepNeedsModel,
  followupSweepPrompt,
  followupSweepResultFingerprint,
  followupSweepSnapshot,
  validateFollowupSweepResult
} from './followup-sweep'

const watermarks = { googleMail: null, googleCalendar: null, atumChats: null, conversation: null, memory: null }
const normalAt = Date.parse('2026-10-26T02:00:00.000Z') // 09:00 Asia/Ho_Chi_Minh

async function snapshot(overrides: Partial<FollowupSweepEvidenceSnapshot> = {}) {
  const entry = await followupSweepEvidence({ source: 'google_mail', scope: 'account-1', objectId: 'thread-1',
    anchorId: 'message-1', dueAt: null, observedAt: normalAt, title: 'Contract',
    text: 'Lan needs a reply by 15:00.', fresh: true })

  return followupSweepSnapshot({ capturedAt: normalAt, ownerTimeZone: 'Asia/Ho_Chi_Minh', watermarks,
    sources: [{ source: 'google_mail', status: 'ok' }], entries: [entry], ...overrides })
}

describe('shared follow-up sweep policy', () => {
  it('fingerprints source identity rather than model wording', async () => {
    const first = await followupSweepEvidence({ source: 'google_mail', scope: 'account-1', objectId: 'thread-1',
      anchorId: 'message-1', dueAt: null, observedAt: normalAt, text: 'First wording', fresh: true })

    const rewritten = await followupSweepEvidence({ ...first, text: 'Completely different wording' })
    const reanchored = await followupSweepEvidence({ ...first, anchorId: 'message-2' })
    const dueLater = await followupSweepEvidence({ ...first, dueAt: normalAt + 60_000 })

    const identity = await followupSweepFindingIdentity({ source: 'google_mail', scope: 'account-1',
      objectId: 'thread-1', anchorId: 'message-1', dueAt: null })

    expect(rewritten.findingHash).toBe(first.findingHash)
    expect(rewritten.id).toBe(first.id)
    expect(identity).toEqual({ id: first.id, findingHash: first.findingHash })
    expect(reanchored.findingHash).not.toBe(first.findingHash)
    expect(dueLater.findingHash).not.toBe(first.findingHash)
  })

  it('keeps legacy prefixes while admitting an unknown source identity', async () => {
    const known = await followupSweepFindingIdentity({ source: 'google_calendar', scope: 'account-1',
      objectId: 'event-1', anchorId: 'revision-1', dueAt: null })
    const unknown = await followupSweepFindingIdentity({ source: 'app:future-id:chat', scope: 'room-1',
      objectId: 'event-1', anchorId: 'revision-1', dueAt: null })

    expect(known.id).toMatch(/^calendar:/u)
    expect(unknown.id).toMatch(/^src:/u)
    expect(unknown.findingHash).not.toBe(known.findingHash)
  })

  it('runs judgment only for fresh bounded evidence and requires investigate-first behavior', async () => {
    const current = await snapshot()
    expect(followupSweepNeedsModel(current)).toBe(true)
    expect(followupSweepPrompt(current)).toContain('Investigate first: use every available read-only tool')
    expect(followupSweepPrompt(current)).toContain('Never ask whether the owner wants you to inspect, look up, map, or check')
    expect(followupSweepPrompt(current)).toContain('Ask a question only before a side effect')
    expect(new TextEncoder().encode(followupSweepPrompt(current)).byteLength).toBeLessThanOrEqual(5_000)

    const unchanged = await snapshot({ entries: current.entries.map(entry => ({ ...entry, fresh: false })) })
    expect(followupSweepNeedsModel(unchanged)).toBe(false)

    for (const source of ['conversation', 'memory'] as const) {
      const context = await followupSweepEvidence({ source, scope: 'agent-1', objectId: 'context-1',
        anchorId: 'owner-event-1', dueAt: normalAt + 7_200_000, observedAt: normalAt,
        text: 'Context changed without new external evidence.', fresh: true })

      expect(followupSweepNeedsModel(await followupSweepSnapshot({ capturedAt: normalAt,
        ownerTimeZone: 'Asia/Ho_Chi_Minh', watermarks, sources: [{ source, status: 'ok' }],
        entries: [context] }))).toBe(false)
    }

    for (const source of ['google_drive', 'mac_files'] as const) {
      const files = await followupSweepEvidence({ source, scope: 'owner', objectId: `${source}-1`,
        anchorId: 'revision-1', dueAt: null, observedAt: normalAt,
        text: 'Modified 2026-10-26T02:00:00.000Z', fresh: true })

      expect(followupSweepNeedsModel(await followupSweepSnapshot({ capturedAt: normalAt,
        ownerTimeZone: 'Asia/Ho_Chi_Minh', watermarks, sources: [], entries: [files] }))).toBe(true)
    }
  })

  it('states and parses the exact result keys and accepts a realistic model reply', async () => {
    const current = await snapshot()
    const prompt = followupSweepPrompt(current)

    const schema = (label: string) => {
      const line = prompt.split('\n').find(value => value.startsWith(`${label} schema: `))
      expect(line).toBeDefined()

      return JSON.parse(line!.slice(`${label} schema: `.length)) as Record<string, unknown>
    }

    expect(Object.keys(schema('Silent')).sort()).toEqual(['decision', 'profile'])
    expect(Object.keys(schema('Offer')).sort()).toEqual(['decision', 'evidenceIds', 'profile', 'text', 'urgency'])
    expect(prompt).toContain('urgency is "normal" or "harm_before_morning"')
    expect(prompt).toContain('text must contain 1-500 Unicode characters')

    const reply = JSON.stringify({
      profile: 'atum.followup-sweep-result/1',
      decision: 'offer',
      evidenceIds: [current.entries[0]!.id],
      urgency: 'normal',
      text: 'Lan needs your contract answer by 15:00 today. Shall I draft a reply?'
    })

    expect(validateFollowupSweepResult(reply, current).result).toEqual(JSON.parse(reply))
  })

  it('fits a realistic maximum snapshot without dropping findings', async () => {
    const entries = await Promise.all(Array.from({ length: FOLLOWUP_SWEEP_BOUNDS.maxEvidenceEntries }, (_, index) =>
      followupSweepEvidence({ source: index % 2 === 0 ? 'atum_chats' : 'google_mail',
        scope: `scope-${index}`, objectId: `object-${index}`, anchorId: `event-${index}`,
        dueAt: null, observedAt: normalAt + index, title: `Thread ${index}`,
        text: 'x'.repeat(FOLLOWUP_SWEEP_BOUNDS.maxEvidenceTextCharacters), fresh: index === 0 })))

    const large = await followupSweepSnapshot({ capturedAt: normalAt, ownerTimeZone: 'Asia/Ho_Chi_Minh',
      watermarks, sources: [{ source: 'atum_chats', status: 'ok' }, { source: 'google_mail', status: 'ok' }], entries })

    const fitted = await fitFollowupSweepSnapshot(large)

    expect(fitted.entries.map(entry => entry.id)).toEqual(large.entries.map(entry => entry.id))
    expect(fitted.entries.some((entry, index) => entry.text.length < large.entries[index]!.text.length)).toBe(true)
    expect(new TextEncoder().encode(followupSweepPrompt(fitted)).byteLength).toBeLessThanOrEqual(
      FOLLOWUP_SWEEP_BOUNDS.maxPromptBytes
    )
  })

  it('admits a supported short offer and maps it to source finding hashes', async () => {
    const current = await snapshot()

    const result = validateFollowupSweepResult({ profile: FOLLOWUP_SWEEP_RESULT_PROFILE, decision: 'offer',
      evidenceIds: [current.entries[0]!.id], urgency: 'normal',
      text: 'Lan needs an answer on the contract by 15:00. Shall I draft a reply?' }, current)

    expect(result.result).toMatchObject({ decision: 'offer', evidenceIds: [current.entries[0]!.id] })
    expect(result.findingHashes).toEqual([current.entries[0]!.findingHash])
    await expect(followupSweepResultFingerprint(result.result)).resolves.toMatch(/^[a-f0-9]{64}$/u)
  })

  it('silences invented evidence, malformed prose and unsupported quiet-hour urgency', async () => {
    const current = await snapshot()
    const quiet = await snapshot({ capturedAt: Date.parse('2026-10-25T18:00:00.000Z') }) // 01:00 local

    const offer = (evidenceIds: string[], text = 'Shall I draft a reply?', urgency = 'normal') => ({
      profile: FOLLOWUP_SWEEP_RESULT_PROFILE, decision: 'offer', evidenceIds, urgency, text
    })

    expect(validateFollowupSweepResult(offer(['mail:invented']), current).result.decision).toBe('silent')
    expect(validateFollowupSweepResult(offer([current.entries[0]!.id], '- Shall I act?'), current).result.decision).toBe('silent')
    expect(validateFollowupSweepResult(offer([quiet.entries[0]!.id]), quiet).result.decision).toBe('silent')
    expect(validateFollowupSweepResult(offer([quiet.entries[0]!.id], 'Shall I draft a reply?', 'harm_before_morning'), quiet).result.decision).toBe('silent')

    const hostMarked = await snapshot({ capturedAt: quiet.capturedAt,
      entries: quiet.entries.map(entry => ({ ...entry, harmBeforeMorning: true })) })

    expect(validateFollowupSweepResult(
      offer([hostMarked.entries[0]!.id], 'Shall I draft a reply?', 'harm_before_morning'), hostMarked
    ).result.decision).toBe('offer')

    const unchanged = await snapshot({ capturedAt: quiet.capturedAt,
      entries: quiet.entries.map(entry => ({ ...entry, fresh: false })) })

    expect(validateFollowupSweepResult(offer([unchanged.entries[0]!.id], 'Shall I draft a reply?', 'harm_before_morning'), unchanged).result.decision).toBe('silent')
  })

  it('uses the owner IANA zone for the 08:00 inclusive to 21:00 exclusive window', () => {
    expect(followupSweepInsideNormalWindow(Date.parse('2026-10-26T01:00:00.000Z'), 'Asia/Ho_Chi_Minh')).toBe(true)
    expect(followupSweepInsideNormalWindow(Date.parse('2026-10-26T13:59:59.000Z'), 'Asia/Ho_Chi_Minh')).toBe(true)
    expect(followupSweepInsideNormalWindow(Date.parse('2026-10-26T14:00:00.000Z'), 'Asia/Ho_Chi_Minh')).toBe(false)
  })
})
