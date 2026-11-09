import { describe, expect, it } from 'vitest'

import { petDrawScale } from '../pet'

import { roamSize } from './lane'
import { STAGE_MAX_HEIGHT, stageSize } from './profile'

const frame = { w: 192, h: 208 }

function bounds(height: number) {
  return { idle: { x: 26, y: 195 - height, width: 139, height } }
}

describe('legacy compatibility and approved relative standing sizes', () => {
  it.each([0.1, 0.33, 1, 2, 3])('preserves every old size exactly at saved scale %s', scale => {
    for (const size of [0.5, 0.85, 1, 1.1, 2, 3]) {
      for (const geometry of [frame, { w: 100, h: 150 }]) {
        const info = { scale, size }
        expect(stageSize(geometry, info)).toEqual(roamSize(geometry, petDrawScale(info)))
      }
    }
  })
  it('keeps Gigi/Cookie manifests absent and displays both new dogs at the approved ratios', () => {
    const gigi = stageSize(frame, { scale: 1, size: 1 })
    const cookie = stageSize(frame, { scale: 1, size: 0.85 })
    expect(gigi.height).toBe(96)
    expect(cookie.height).toBe(90)
    const gigiOpaque = gigi.height * 119 / 208

    for (const [naturalHeightPt, opaque] of [
      [100, 99],
      [210, 117]
    ]) {
      const dog = stageSize(frame, { scale: 1, size: 1, sizeClass: { naturalHeightPt }, bounds: bounds(opaque) })
      expect((dog.height * opaque) / frame.h / gigiOpaque).toBeCloseTo(naturalHeightPt / 96, 1)
    }
  })
  it('is linear in nominal standing size and ignores the old species multiplier', () => {
    const small = { scale: 1, size: 0.5, sizeClass: { naturalHeightPt: 50 }, bounds: bounds(119) }
    const large = { ...small, size: 2, sizeClass: { naturalHeightPt: 100 } }
    expect(stageSize(frame, large).height).toBe(2 * stageSize(frame, small).height)
  })
  it.each(['lane', 'window', 'overlay'] as const)('caps the %s cell at its own maximum', surface => {
    expect(
      stageSize(frame, { scale: 3, sizeClass: { naturalHeightPt: 300 }, bounds: bounds(99) }, surface).height
    ).toBe(STAGE_MAX_HEIGHT[surface])
  })
})
