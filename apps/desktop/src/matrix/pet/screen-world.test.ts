import { expect, it } from 'vitest'

import { petScreenWorld } from './screen-world'

it('uses work-area floors and clamps disconnected or negative-coordinate displays', () => {
  const displays = [
    { bounds: { x: -1440, y: 0, width: 1440, height: 900 }, workArea: { x: -1440, y: 24, width: 1440, height: 830 } },
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 24, width: 1920, height: 1020 } }
  ]

  const left = petScreenWorld(displays, { x: -1000, y: 700 }, 320, 300)!
  expect(left.origin).toEqual({ x: -1440, y: 24 })
  expect(left.world.floorY).toBe(830)
  expect(left.world.free).toEqual([{ left: 0, right: 1120 }])
  const disconnected = petScreenWorld(displays.slice(1), { x: -1000, y: 700 }, 320, 300)!
  expect(disconnected.point.x).toBe(0)
  expect(disconnected.origin.x).toBe(0)
  expect(petScreenWorld([], { x: 0, y: 0 }, 320, 300)).toBeUndefined()
})
