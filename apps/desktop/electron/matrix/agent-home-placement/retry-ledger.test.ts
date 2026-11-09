import { describe, expect, it } from 'vitest'

import type { PlacementConnectionResult } from './connection-platform'
import { outcomeIsDefinitive, RetryLedger } from './retry-ledger'

function ledger(options: { ttlMs?: number; limit?: number } = {}) {
  const clock = { now: 1_000_000 }
  let next = 0

  return {
    clock,
    ledger: new RetryLedger({ now: () => clock.now, uuid: () => `id-${(next += 1)}`, ...options })
  }
}

describe('retry identity', () => {
  it('gives one operation the same ids until it is settled, and new ids after', () => {
    const { ledger: l } = ledger()
    const key = RetryLedger.key('move', 'agent', { preflightId: 'a' })

    const first = l.begin(key, 3)
    expect(first.ids).toEqual(['id-1', 'id-2', 'id-3'])
    expect(l.begin(key, 3).ids).toEqual(['id-1', 'id-2', 'id-3'])

    l.settle(key)
    expect(l.begin(key, 3).ids).toEqual(['id-4', 'id-5', 'id-6'])
  })

  it('tells operations apart by their effect fields, not by their order of keys', () => {
    const a = RetryLedger.key('move', 'agent', { x: 1, y: [1, 2] })
    const b = RetryLedger.key('move', 'agent', { y: [1, 2], x: 1 })

    expect(a).toBe(b)
    expect(RetryLedger.key('move', 'agent', { x: 2, y: [1, 2] })).not.toBe(a)
    expect(RetryLedger.key('move', 'other', { x: 1, y: [1, 2] })).not.toBe(a)
    expect(RetryLedger.key('cancel', 'agent', { x: 1, y: [1, 2] })).not.toBe(a)
  })

  it('forgets an operation nobody retried in time', () => {
    const { ledger: l, clock } = ledger({ ttlMs: 60_000 })
    const key = RetryLedger.key('move', 'agent', {})
    const first = l.begin(key, 2)

    clock.now += 61_000
    expect(l.begin(key, 2).ids).not.toEqual(first.ids)
  })

  it('remembers only so many operations', () => {
    const { ledger: l } = ledger({ limit: 2 })
    const keys = [1, 2, 3].map(each => RetryLedger.key('move', 'agent', { each }))
    const first = l.begin(keys[0]!, 1).ids

    l.begin(keys[1]!, 1)
    l.begin(keys[2]!, 1)

    expect(l.begin(keys[0]!, 1).ids).not.toEqual(first)
  })

  it('offers the last signed bytes again only while they have long enough to live', () => {
    const { ledger: l, clock } = ledger()
    const key = RetryLedger.key('publish', 'agent', {})
    const entry = l.begin(key, 3)

    expect(l.reusable(entry)).toBeUndefined()
    l.sent(entry, { signed: true }, clock.now + 100_000)
    expect(l.reusable(entry)).toEqual({ signed: true })

    clock.now += 80_000
    expect(l.reusable(entry)).toBeUndefined()
  })
})

describe('which outcomes end an operation', () => {
  const failure = (kind: 'unsupported' | 'unauthorized' | 'forbidden' | 'conflict' | 'invalid' | 'unavailable', status: number): PlacementConnectionResult<unknown> => ({
    ok: false,
    kind,
    status
  })

  it.each([
    ['an accepted answer', { ok: true, value: 1 } as PlacementConnectionResult<unknown>, true],
    ['a refusal', failure('conflict', 409), true],
    ['a refusal of the caller', failure('forbidden', 403), true],
    ['a platform without the route', failure('unsupported', 404), true],
    ['a request the platform called invalid', failure('invalid', 422), true],
    ['a request that was never sent', failure('invalid', 0), true],
    ['an answer whose body could not be read', failure('invalid', 200), false],
    ['no answer at all', failure('unavailable', 0), false],
    ['a gateway timeout', failure('unavailable', 504), false],
    ['a rate limit', failure('unavailable', 429), false],
    ['a sign-in that has to be renewed', failure('unauthorized', 401), false]
  ])('%s', (_name, result, definitive) => {
    expect(outcomeIsDefinitive(result)).toBe(definitive)
  })
})
