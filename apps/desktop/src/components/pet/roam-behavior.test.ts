import { describe, expect, it } from 'vitest'

import {
  chooseGesture,
  chooseMove,
  chooseRoutine,
  dwellMs,
  type DwellRange,
  HOP_CHANCE,
  pickStrollTarget,
  REST_CHANCE,
  type Rng,
  ROUTINE_CHANCE,
  ROUTINES,
  tempoFor
} from './roam-behavior'
import type { Ledge } from './roam-geometry'

// Deterministic rng that replays a fixed sequence (last value sticks).
const seq =
  (...vals: number[]): Rng =>
  () =>
    vals.shift() ?? vals[vals.length - 1] ?? 0

const RANGE: DwellRange = { maxMs: 13000, meanMs: 4000, minMs: 1500 }
const ledge = (left: number, right: number, y = 0): Ledge => ({ left, right, y })

describe('dwellMs', () => {
  it('clamps the degenerate draws to the floor and ceiling', () => {
    // rng→0 ⇒ u=1 ⇒ -ln(1)·mean = 0, raised to the floor.
    expect(dwellMs(RANGE, () => 0)).toBe(RANGE.minMs)
    // rng→~1 ⇒ u→0 ⇒ -ln(u) blows up, capped at the ceiling.
    expect(dwellMs(RANGE, () => 1 - 1e-9)).toBe(RANGE.maxMs)
  })

  it('returns the mean at the exponential median point', () => {
    // rng = 1 - 1/e ⇒ u = 1/e ⇒ -ln(u) = 1 ⇒ exactly the mean.
    expect(dwellMs(RANGE, () => 1 - 1 / Math.E)).toBeCloseTo(RANGE.meanMs, 6)
  })

  it('stays within [min, max] across the whole rng domain', () => {
    let state = 0.123456789

    for (let i = 0; i < 5000; i++) {
      state = (state * 9301 + 0.49297) % 1 // cheap deterministic walk
      const ms = dwellMs(RANGE, () => state)
      expect(ms).toBeGreaterThanOrEqual(RANGE.minMs)
      expect(ms).toBeLessThanOrEqual(RANGE.maxMs)
    }
  })
})

describe('chooseMove', () => {
  it('rests whenever the first draw lands under restChance — even where it could hop', () => {
    expect(chooseMove(true, seq(0))).toBe('rest')
    expect(chooseMove(false, seq(REST_CHANCE - 1e-9))).toBe('rest')
  })

  it('strolls when moving with nowhere to hop', () => {
    expect(chooseMove(false, seq(0.99))).toBe('stroll')
  })

  it('hops only when moving, a ledge is reachable, and the second draw says so', () => {
    expect(chooseMove(true, seq(0.99, HOP_CHANCE - 1e-9))).toBe('hop')
    expect(chooseMove(true, seq(0.99, HOP_CHANCE))).toBe('stroll')
  })

  it('treats restChance as a strict lower bound (boundary stays a move)', () => {
    expect(chooseMove(false, seq(REST_CHANCE))).toBe('stroll')
  })

  it('loafs far more than it roams over a long run (the whole point)', () => {
    let state = 0.314159
    const rng: Rng = () => (state = (state * 16807 + 0.5) % 1)
    let rests = 0
    const N = 20000

    for (let i = 0; i < N; i++) {
      if (chooseMove(true, rng) === 'rest') {
        rests++
      }
    }

    // ~62% rests; assert the contract (majority loafing), not the exact rate.
    expect(rests / N).toBeGreaterThan(0.5)
  })
})

describe('pickStrollTarget', () => {
  it('collapses to the left edge on a ledge too narrow to walk', () => {
    expect(pickStrollTarget(ledge(100, 102), 100, seq(0))).toBe(100)
  })

  it('lands inside the ledge and clears the minimum travel distance', () => {
    const wide = ledge(0, 1000)
    const from = 500
    const x = pickStrollTarget(wide, from, seq(0.5, 0))

    expect(x).toBeGreaterThanOrEqual(wide.left)
    expect(x).toBeLessThanOrEqual(wide.right)
    expect(Math.abs(x - from)).toBeGreaterThanOrEqual(110) // STROLL_MIN_PX
  })

  it('heads toward the side with more room', () => {
    // Pinned near the right wall, the roomier side is left. First draw clears the
    // rare double-back coin ⇒ it commits to the roomy (left) side ⇒ target < x.
    const x = pickStrollTarget(ledge(0, 1000), 950, seq(0.5, 0))
    expect(x).toBeLessThan(950)
  })
})

describe('chooseGesture', () => {
  it('mostly just loafs', () => {
    // Movement is the exception and so is performance: a pet that does a trick
    // on every pause is a screensaver.
    expect(chooseGesture(() => 0.5)).toBeNull()
    expect(chooseGesture(() => 0.99)).toBeNull()
  })

  it('favours the quiet gesture over the showy ones', () => {
    // Sitting reads as a creature occupying itself; waving and hopping read as
    // one performing at you.
    const draws = [0.0, 0.2, 0.39, 0.5, 0.74, 0.8, 0.9]

    const picks = draws.map(second => {
      let call = 0

      return chooseGesture(() => (call++ === 0 ? 0.0 : second))
    })

    expect(picks.filter(p => p === 'waiting').length).toBeGreaterThan(
      picks.filter(p => p === 'wave' || p === 'jump').length
    )
  })

  it('always yields a real gesture once it has decided to act', () => {
    for (const second of [0, 0.25, 0.5, 0.75, 0.999]) {
      let call = 0
      const pick = chooseGesture(() => (call++ === 0 ? 0.0 : second))

      expect(['waiting', 'wave', 'jump', 'lounging', 'review']).toContain(pick)
    }
  })

  it('can glance — the head-tilt row as a rare idle variant', () => {
    const picks = new Set<null | string>()

    for (let second = 0; second < 1; second += 0.01) {
      let call = 0
      picks.add(chooseGesture(() => (call++ === 0 ? 0.0 : second)))
    }

    expect(picks.has('review')).toBe(true)
  })
})

describe('chooseRoutine', () => {
  it('mostly does not start one — a routine is a minute of intention, rarer than a gesture', () => {
    expect(chooseRoutine(() => ROUTINE_CHANCE)).toBeNull()
    expect(chooseRoutine(() => 0.5)).toBeNull()
  })

  it('picks deterministically under an injected rng', () => {
    expect(chooseRoutine(seq(0, 0), { canHop: true })?.name).toBe(ROUTINES[0]!.name)
    expect(chooseRoutine(seq(0, 0.999), { canHop: true })?.name).toBe(ROUTINES[ROUTINES.length - 1]!.name)
  })

  it('never offers a routine that hops when nothing is reachable', () => {
    for (let second = 0; second < 1; second += 0.05) {
      const routine = chooseRoutine(seq(0, second), { canHop: false })

      expect(routine).not.toBeNull()
      expect(routine!.steps.some(step => step.kind === 'hop')).toBe(false)
    }
  })

  it('is built only from rows the sheets already have, with real durations', () => {
    for (const routine of ROUTINES) {
      expect(routine.steps.length).toBeGreaterThanOrEqual(3)

      for (const step of routine.steps) {
        if (step.kind === 'pose') {
          expect(['waiting', 'wave', 'jump', 'lounging', 'review']).toContain(step.pose)
          expect(step.ms).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe('tempoFor', () => {
  it('stays near the sheet pace, slows a lounge, and never touches locomotion', () => {
    for (const draw of [0, 0.5, 0.999]) {
      expect(tempoFor('idle', () => draw)).toBeGreaterThanOrEqual(0.9)
      expect(tempoFor('idle', () => draw)).toBeLessThanOrEqual(1.15)
      expect(tempoFor('lounging', () => draw)).toBeGreaterThan(tempoFor('idle', () => draw))
      expect(tempoFor('run', () => draw)).toBe(1)
      expect(tempoFor('jump', () => draw)).toBe(1)
    }

    // Unknown or no pose: the sheet's own pace.
    expect(tempoFor(null, () => 0.7)).toBeGreaterThanOrEqual(0.9)
    expect(tempoFor('failed', () => 0.7)).toBe(1)
  })
})
