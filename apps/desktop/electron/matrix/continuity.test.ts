import { expect, it } from 'vitest'

import { MATRIX_CONTINUITY, type MatrixContinuityRead } from '../../shared/matrix-continuity'

import {
  canResumeConversation,
  conversationSeed,
  conversationWitness,
  readContinuityResult,
  validHistorySeed
} from './continuity'

const scope = { roomId: '!room:test', ownerId: '@owner:test', agentId: '@agent:test' }

const read = (entries: MatrixContinuityRead['entries'] = []): MatrixContinuityRead => ({
  ...scope,
  entries,
  reachedStop: true,
  gaps: 0,
  uncertainAgent: false
})

const user = (id: string, text = id) => ({ eventId: `$${id}`, role: 'user' as const, text })
const answer = (id: string) => ({ eventId: `$${id}`, role: 'assistant' as const, text: id, invocationId: id })

it('resumes local completions even before publication, but never hides a foreign answer behind a late own answer', () => {
  const witness = { anchor: '$anchor', ours: ['mine'] }
  expect(canResumeConversation(witness, read([answer('anchor')]))).toBe(true)
  expect(canResumeConversation(witness, read([answer('mine'), answer('anchor')]))).toBe(true)
  expect(canResumeConversation(witness, read([answer('mine'), answer('foreign'), answer('anchor')]))).toBe(false)
  expect(
    canResumeConversation(
      witness,
      read([{ eventId: '$cron', role: 'assistant', text: 'Scheduled update' }, answer('anchor')])
    )
  ).toBe(false)
  expect(canResumeConversation(witness, { ...read([answer('anchor')]), reachedStop: false })).toBe(false)
  expect(canResumeConversation(witness, read([answer('mine')]))).toBe(false)
  expect(canResumeConversation(witness, { ...read([answer('anchor')]), uncertainAgent: true })).toBe(false)
})

it.each([undefined, null, {}, { ours: [1] }, { ours: [], anchor: 'bad' }, { ours: Array(17).fill('id') }])(
  'missing or malformed continuity witnesses request a fresh seed: %j',
  value => {
    expect(conversationWitness(value)).toBeUndefined()
    expect(canResumeConversation(conversationWitness(value), read())).toBe(false)
  }
)

it('seeds only complete visible dialogue in chronological order, merging consecutive roles and dropping unanswered tail', () => {
  const result = conversationSeed(
    read([user('current'), answer('latest'), user('second'), user('first'), answer('orphan')])
  )

  expect(result).toEqual([
    { role: 'user', content: 'first\n\nsecond' },
    { role: 'assistant', content: 'latest' }
  ])
  expect(validHistorySeed(result)).toBe(true)
  expect(conversationSeed(read([user('unanswered')]))).toEqual([])
})

it('bounds oldest-first dialogue by both message count and characters without a partial leading answer', () => {
  const entries = Array.from({ length: 50 }, (_, i) => [answer(`a${i}`), user(`u${i}`, 'x'.repeat(2_000))]).flat()
  const result = conversationSeed(read(entries))
  expect(result.length).toBeLessThanOrEqual(MATRIX_CONTINUITY.messages)
  expect(result.reduce((n, row) => n + row.content.length, 0)).toBeLessThanOrEqual(MATRIX_CONTINUITY.chars)
  expect(result.at(-1)).toEqual({ role: 'assistant', content: 'a0' })
  expect(validHistorySeed(result)).toBe(true)
})

it('distinguishes per-wire-event admission from the total seed budget after merging adjacent roles', () => {
  const result = conversationSeed(
    read([answer('a'), ...Array.from({ length: 5 }, (_, i) => user(`${i}`, 'x'.repeat(4_000)))])
  )

  expect(result[0].content.length).toBeGreaterThan(16_000)
  expect(validHistorySeed(result)).toBe(true) // Hermes history has no 16k per-message limit.
  expect(
    validHistorySeed(
      conversationSeed(read([answer('a'), ...Array.from({ length: 10 }, (_, i) => user(`${i}`, 'x'.repeat(4_000)))]))
    )
  ).toBe(true)
})

it.each([
  { role: 'system', content: 'instructions' },
  { role: 'tool', content: 'private' },
  { role: 'user', content: '' },
  { role: 'user', content: 'x'.repeat(32_001) }
])('rejects invalid role or oversized seed before RPC: %j', row => expect(validHistorySeed([row])).toBe(false))

it('validates the native SDK result scope, event identity and types', () => {
  const value = read([answer('one'), user('question')])
  expect(readContinuityResult(value, scope)).toBe(value)

  for (const change of [
    { roomId: '!other:test' },
    { ownerId: '@other:test' },
    { agentId: '@other:test' },
    { gaps: -1 },
    { entries: [{ ...user('question'), role: 'system' }] },
    { entries: [user('question'), user('question')] },
    { entries: [{ ...user('question'), invocationId: 'forged' }] }
  ]) {
    expect(() => readContinuityResult({ ...value, ...change }, scope)).toThrow('matrix_continuity_unavailable')
  }

  expect(() => readContinuityResult(value, { ...scope, before: '$one' })).toThrow('matrix_continuity_unavailable')
})

it('accepts a clipped read only where a bounded one was asked for, and never as complete', () => {
  const clipped = { ...read([answer('recent'), user('asked')]), reachedStop: false, clipped: true as const }
  expect(readContinuityResult(clipped, { ...scope, bounded: true })).toBe(clipped)
  expect(() => readContinuityResult(clipped, scope)).toThrow('matrix_continuity_unavailable')
  expect(() => readContinuityResult({ ...clipped, reachedStop: true }, { ...scope, bounded: true })).toThrow(
    'matrix_continuity_unavailable'
  )
  expect(() => readContinuityResult({ ...clipped, clipped: 'yes' }, { ...scope, bounded: true })).toThrow(
    'matrix_continuity_unavailable'
  )
  // What it keeps seeds a new session like any read; it never lets a stored session resume.
  expect(conversationSeed(clipped)).toEqual([
    { role: 'user', content: 'asked' },
    { role: 'assistant', content: 'recent' }
  ])
  expect(canResumeConversation({ anchor: '$recent', ours: [] }, clipped)).toBe(false)
})
