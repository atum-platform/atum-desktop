import { describe, expect, it } from 'vitest'

import { advanceEclipse, createEclipse, eclipseFrame, MARK } from './engine'
import { REDUCED_STORY, STORY, storyFacts } from './story'

describe('first-launch story script', () => {
  it('opens on the night alone, then a single spark before any bead', () => {
    expect(storyFacts(0.1, false)).toMatchObject({ current: -1, phase: 'checking', settled: 0 })
    expect(storyFacts(1, false)).toMatchObject({ current: 2, phase: 'checking', settled: 0 })
  })

  it('breaks the five beads through in order, then lights the ring and leaves', () => {
    const settled = STORY.beads.map(at => storyFacts(at + 0.01, false).settled)

    expect(settled).toEqual([1, 2, 3, 4, 5])
    expect(storyFacts(STORY.lit + 0.01, false).phase).toBe('lit')
    expect(storyFacts(STORY.leave + 0.01, false).phase).toBe('leaving')
  })

  it('keeps every beat inside the story and the words after the ring', () => {
    expect(STORY.wave).toBeGreaterThan(STORY.lit)
    expect(STORY.line).toBeGreaterThan(STORY.wave)
    expect(STORY.wordsOut).toBeLessThan(STORY.leave)
    expect(STORY.out).toBeGreaterThan(STORY.leave + 1.2)
    expect(STORY.done).toBeGreaterThan(STORY.out)
  })

  it('ends on the brand mark at the sign-in mark when played through the engine', () => {
    const state = createEclipse('totality')
    const home = { x: 720, y: 380, r: 96 }
    const dest = { x: 720, y: 300, r: 24 / MARK.face }
    let frame = eclipseFrame(state, storyFacts(0, false))

    for (let t = 0; t < STORY.leave + 1.1; t += 1 / 240) {
      const facts = storyFacts(t, false)
      advanceEclipse(state, 1 / 240, { ...facts, dest: facts.phase === 'leaving' ? dest : undefined, home })
      frame = eclipseFrame(state, facts)
    }

    expect(frame.center.y).toBeCloseTo(dest.y, 0)
    expect(frame.r).toBeCloseTo(dest.r, 1)
    expect(frame.moonR).toBeCloseTo(MARK.moonR, 2)
    expect(frame.beadDisc).toBeCloseTo(1, 2)
  })

  it('moves nothing with reduced motion and fades out at its end', () => {
    expect(storyFacts(1, true)).toMatchObject({ phase: 'checking', reduced: true, settled: 0 })
    expect(storyFacts(REDUCED_STORY.leave + 0.01, true).phase).toBe('leaving')
  })
})
