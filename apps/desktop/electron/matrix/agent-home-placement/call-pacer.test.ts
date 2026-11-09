import { describe, expect, it } from 'vitest'

import { CallPacer } from './call-pacer'

function pacer(options: { baseMs?: number; maxMs?: number } = {}) {
  const clock = { now: 0 }

  // No jitter: the middle of the random range.
  return { clock, pacer: new CallPacer({ now: () => clock.now, random: () => 0.5, ...options }) }
}

describe('pacing background calls', () => {
  it('is due until it is told when to be next', () => {
    const { pacer: p, clock } = pacer()

    expect(p.due('a')).toBe(true)
    p.ok('a', 10_000)
    expect(p.due('a')).toBe(false)
    clock.now = 9_999
    expect(p.due('a')).toBe(false)
    clock.now = 10_000
    expect(p.due('a')).toBe(true)
  })

  it('doubles the wait after each failure up to a ceiling, and starts again after a success', () => {
    const { pacer: p, clock } = pacer({ baseMs: 10_000, maxMs: 50_000 })
    const waits: number[] = []

    for (let failure = 0; failure < 5; failure += 1) {
      const before = clock.now
      p.failed('a')
      let waited = 0
      while (!p.due('a')) {
        clock.now += 1_000
        waited = clock.now - before
      }
      waits.push(waited)
    }

    expect(waits).toEqual([10_000, 20_000, 40_000, 50_000, 50_000])

    p.ok('a', 1_000)
    clock.now += 1_000
    p.failed('a')
    expect(p.due('a')).toBe(false)
    clock.now += 10_000
    expect(p.due('a')).toBe(true)
  })

  it('never calls sooner than the platform asked', () => {
    const { pacer: p, clock } = pacer({ baseMs: 10_000 })

    p.failed('a', 90_000)
    clock.now = 89_000
    expect(p.due('a')).toBe(false)
    clock.now = 90_000
    expect(p.due('a')).toBe(true)
  })

  it('can be woken without forgetting how many times it failed', () => {
    const { pacer: p, clock } = pacer({ baseMs: 10_000 })

    p.failed('a')
    p.failed('a')
    p.wake('a')
    expect(p.due('a')).toBe(true)

    p.failed('a')
    clock.now += 39_000
    expect(p.due('a')).toBe(false)
    clock.now += 1_000
    expect(p.due('a')).toBe(true)
  })

  it('keeps each key apart and forgets by key or prefix', () => {
    const { pacer: p } = pacer()
    p.ok('publish:1', 60_000)
    p.ok('publish:2', 60_000)
    p.ok('application:1', 60_000)

    expect(p.due('publish:3')).toBe(true)
    p.forget('publish:1')
    expect(p.due('publish:1')).toBe(true)
    expect(p.due('publish:2')).toBe(false)

    p.forgetPrefix('publish:')
    expect(p.due('publish:2')).toBe(true)
    expect(p.due('application:1')).toBe(false)
  })

  it('spreads a fleet with jitter within a tenth either way', () => {
    const measure = (random: number) => {
      const clock = { now: 0 }
      const q = new CallPacer({ now: () => clock.now, random: () => random })
      q.ok('a', 100_000)
      while (!q.due('a')) {clock.now += 100}

      return clock.now
    }

    expect(measure(0)).toBe(90_000)
    expect(measure(0.5)).toBe(100_000)
    expect(measure(1)).toBe(110_000)
  })
})
