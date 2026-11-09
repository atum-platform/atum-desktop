import { describe, expect, it } from 'vitest'

import {
  advanceEclipse,
  createEclipse,
  type EclipseDirection,
  eclipseFinaleMs,
  eclipseFlightMs,
  eclipseFrame,
  type EclipseInputs,
  MARK
} from './engine'

const home = { x: 720, y: 400, r: 96 }
const dest = { x: 344, y: 24, r: 14 / MARK.face }

function run(direction: EclipseDirection, script: [seconds: number, input: Partial<EclipseInputs>][], reduced = false) {
  const state = createEclipse(direction, reduced)
  let input: EclipseInputs = { brief: false, current: 0, home, phase: 'checking', reduced, settled: 0 }
  let peakFlash = 0
  let peakBeads = 0

  for (const [seconds, change] of script) {
    input = { ...input, ...change }

    for (let t = 0; t < seconds; t += 1 / 240) {
      advanceEclipse(state, 1 / 240, input)
      const frame = eclipseFrame(state, input)
      peakFlash = Math.max(peakFlash, frame.flash)
      peakBeads = Math.max(peakBeads, ...frame.baily.map(([, , s]) => s))
    }
  }

  return { frame: eclipseFrame(state, input), peakBeads, peakFlash, state }
}

const finale: [number, Partial<EclipseInputs>][] = [
  [1.5, { current: 1, settled: 1 }],
  [1, { current: 5, settled: 5 }],
  [eclipseFinaleMs('totality', false) / 1000, { phase: 'lit' }]
]

// Just before the dissolve, and well after it.
const landed: [number, Partial<EclipseInputs>][] = [...finale, [eclipseFlightMs(false) / 1000 - 0.35, { dest, phase: 'leaving' }]]
const passedAll: [number, Partial<EclipseInputs>][] = [...finale, [eclipseFlightMs(false) / 1000 + 1.5, { dest, phase: 'leaving' }]]

describe('launch eclipse', () => {
  it.each(['totality', 'approach'] as const)('%s lands as the brand mark, the size of the header’s face', direction => {
    const { frame, state } = run(direction, landed)

    expect(frame.center.x).toBeCloseTo(dest.x, 0)
    expect(frame.center.y).toBeCloseTo(dest.y, 0)
    expect(frame.r).toBeCloseTo(dest.r, 1)
    expect(frame.moon[0]).toBeCloseTo(MARK.moon[0], 2)
    expect(frame.moon[1]).toBeCloseTo(MARK.moon[1], 2)
    expect(frame.moonR).toBeCloseTo(MARK.moonR, 2)
    expect(frame.beadDisc).toBeCloseTo(1, 2)
    expect(frame.face).toBeCloseTo(1, 2)
    // All the light has gone: what is left is the mark itself.
    expect(frame.corona).toBeLessThan(0.01)
    expect(frame.beadGlow).toBeLessThan(0.01)
    expect(frame.flash).toBeLessThan(0.01)
    expect(frame.opacity).toBeCloseTo(1, 2)
    expect(state.landing).toBe(false)
  })

  it('then dissolves into the header’s own face glyph', () => {
    const { frame, state } = run('totality', passedAll)

    expect(state.landing).toBe(true)
    expect(frame.opacity).toBeLessThan(0.01)
  })

  it('flashes the diamond ring once every check has passed', () => {
    expect(run('totality', passedAll).peakFlash).toBeGreaterThan(0.9)
  })

  it('never flashes for a window released without its checks, and fades where it is', () => {
    const { frame, peakFlash } = run('totality', [
      [2, { current: 2, settled: 2 }],
      [3, { dest, phase: 'leaving' }]
    ])

    expect(peakFlash).toBe(0)
    expect(frame.opacity).toBeLessThan(0.02)
    expect(frame.center.x).toBeCloseTo(home.x, 0)
  })

  it('lights one bead on the moon’s edge for each passed check while totality holds', () => {
    const { frame } = run('totality', [[3, { current: 3, settled: 3 }]])
    const lit = frame.baily.filter(([, , s]) => s > 0.45)

    expect(lit).toHaveLength(3)
    expect(frame.moonR).toBeGreaterThan(1)
  })

  it('dims and cools the corona while a check is blocked', () => {
    const { frame } = run('totality', [
      [2, { current: 1, settled: 1 }],
      [4, { phase: 'blocked' }]
    ])

    expect(frame.cool).toBeGreaterThan(0.9)
    expect(frame.corona).toBeLessThan(0.7)
  })

  it('moves nothing with reduced motion: the mark is there from the start and nothing flashes', () => {
    const { frame, peakBeads, peakFlash } = run('totality', [[0.5, { current: 2, settled: 2 }], ...passedAll], true)

    expect(peakFlash).toBe(0)
    expect(peakBeads).toBe(0)
    expect(frame.moon[0]).toBeCloseTo(MARK.moon[0], 5)
    expect(frame.center.x).toBeCloseTo(home.x, 0)
    expect(frame.opacity).toBeLessThan(0.02)
  })

  it('gives a warm launch the short finale', () => {
    expect(eclipseFinaleMs('totality', true)).toBeLessThan(eclipseFinaleMs('totality', false))
    expect(eclipseFlightMs(true)).toBeLessThan(eclipseFlightMs(false))
  })
})
