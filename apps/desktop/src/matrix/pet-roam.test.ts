import { describe, expect, it } from 'vitest'

import {
  ROAM_CONTROL_GAP_PX,
  ROAM_DEFAULT_HEIGHT_PX,
  ROAM_MAX_HEIGHT_PX,
  roamControlSpans,
  roamFreeSpans,
  roamIsFree,
  roamNearestFree,
  roamNextStep,
  roamRestMs,
  roamSize,
  roamSpeed
} from './pet-roam'

const sequence = (...values: number[]) => {
  let index = 0

  return () => values[index++ % values.length]!
}

describe('the companion stroll', () => {
  it('draws every size the slider offers at a different height, under the ceiling, keeping proportions', () => {
    // The slider runs 0.1–3; the house dogs' own sizes (0.85–1.45) multiply it.
    for (const own of [0.85, 1, 1.45]) {
      let previous = 0

      for (let step = 1; step <= 30; step += 1) {
        const drawn = roamSize({ w: 192, h: 208 }, (step / 10) * own)
        expect(drawn.height).toBeGreaterThan(previous)
        expect(drawn.height).toBeLessThanOrEqual(ROAM_MAX_HEIGHT_PX)
        expect(drawn.width / drawn.height).toBeCloseTo(192 / 208, 1)
        previous = drawn.height
      }
    }

    // The default size strolls at the companion's usual height.
    expect(roamSize({ w: 192, h: 208 }, 1).height).toBe(ROAM_DEFAULT_HEIGHT_PX)
    expect(roamSize({ w: 192, h: 208 }, 40).height).toBe(ROAM_MAX_HEIGHT_PX)
  })

  it('counts only controls that meet the pet band, in lane pixels', () => {
    const lane = { left: 100, bottom: 500 }

    const spans = roamControlSpans(lane, 80, [
      { left: 400, right: 432, top: 468, bottom: 500 }, // the companion button, in the lane
      { left: 150, right: 190, top: 440, bottom: 460 }, // a message action just above the lane, under the pet
      { left: 200, right: 260, top: 100, bottom: 140 }, // far up the transcript
      { left: 300, right: 300, top: 470, bottom: 490 }, // collapsed: takes no room
      { left: 120, right: 160, top: 510, bottom: 540 } // below the lane (the message box)
    ])

    expect(spans).toEqual([
      { left: 300, right: 332 },
      { left: 50, right: 90 }
    ])
  })

  it('leaves no position where the pet overlaps a control or its gap', () => {
    const petW = 60
    const controls = [{ left: 300, right: 332 }]
    const free = roamFreeSpans(400, petW, controls)

    for (let x = 0; x <= 400 - petW; x += 1) {
      const overlaps = x < 332 + ROAM_CONTROL_GAP_PX && x + petW > 300 - ROAM_CONTROL_GAP_PX
      expect(roamIsFree(x, free)).toBe(!overlaps)
    }
  })

  it('has no room at all when the lane is narrower than the pet or fully taken', () => {
    expect(roamFreeSpans(40, 60, [])).toEqual([])
    expect(roamFreeSpans(200, 60, [{ left: 0, right: 200 }])).toEqual([])
    expect(roamNearestFree(10, [])).toBeUndefined()
  })

  it('walks a pet standing on a control off it to the nearest free spot', () => {
    const free = roamFreeSpans(400, 60, [{ left: 300, right: 332 }])
    const nearest = roamNearestFree(330, free)!
    expect(roamIsFree(nearest, free)).toBe(true)
    expect(roamNextStep(330, free, () => 0.99)).toEqual({ kind: 'walk', to: nearest })
  })

  it('mostly rests, and when it strolls it stays inside its own free span', () => {
    const free = roamFreeSpans(800, 60, [{ left: 400, right: 432 }])
    expect(roamNextStep(100, free, () => 0.1).kind).toBe('rest')

    for (const start of [0, 100, 300]) {
      for (const roll of [0.6, 0.8, 0.99]) {
        const step = roamNextStep(start, free, sequence(roll, 0.3, 0.7))

        if (step.kind === 'walk') {
          const span = free.find(each => start >= each.left && start <= each.right)!
          expect(step.to).toBeGreaterThanOrEqual(span.left)
          expect(step.to).toBeLessThanOrEqual(span.right)
          expect(Math.abs(step.to - start)).toBeGreaterThan(0)
        }
      }
    }
  })

  it('rests a bounded, varied time and walks at a pace tied to its legs', () => {
    expect(roamRestMs(() => 0)).toBeGreaterThan(0)
    expect(roamRestMs(() => 0.999999)).toBeLessThanOrEqual(14_000)
    expect(roamRestMs(() => 0.2)).toBeLessThan(roamRestMs(() => 0.8))
    expect(roamSpeed(80, 1100)).toBeGreaterThan(roamSpeed(80, 2200))
    expect(roamSpeed(80, 0)).toBeLessThan(Infinity)
  })
})
