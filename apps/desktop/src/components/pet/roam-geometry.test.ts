import { describe, expect, it } from 'vitest'

import { floorSpan, GROUND_EPS, groundTop, type Ledge, overlapsX, resolveLedge } from './roam-geometry'

const ledge = (y: number, left = 0, right = 1000): Ledge => ({ left, right, y })

describe('floorSpan', () => {
  // A 220px dock pinned 8px above the bottom edge of a 1000×600 window.
  const dock = { bottom: 592, left: 12, right: 232, width: 220 }

  it('is the whole window when nothing is pinned to the bottom edge', () => {
    expect(floorSpan(1000, 600, 100, null)).toEqual({ left: 0, right: 900 })
  })

  it('gives a dock in the bottom-left corner a berth on the left', () => {
    // The pet's left edge starts a gap past the dock's right edge, so it can
    // never stand in front of the Home button and take its clicks.
    expect(floorSpan(1000, 600, 100, dock)).toEqual({ left: 240, right: 900 })
  })

  it('gives a dock in the bottom-right corner a berth on the right', () => {
    expect(floorSpan(1000, 600, 100, { bottom: 592, left: 768, right: 988, width: 220 })).toEqual({ left: 0, right: 660 })
  })

  it('leaves the floor alone for furniture off the bottom edge or as wide as a bar', () => {
    expect(floorSpan(1000, 600, 100, { ...dock, bottom: 500 })).toEqual({ left: 0, right: 900 })
    expect(floorSpan(1000, 600, 100, { bottom: 592, left: 0, right: 1000, width: 1000 })).toEqual({ left: 0, right: 900 })
  })

  it('never crosses its own bounds when a wide pet has no room past the dock', () => {
    // 460px window, 240px pet: the floor's right bound (220) is left of the
    // berth (240), so the span collapses to the bound rather than inverting.
    expect(floorSpan(460, 600, 240, dock)).toEqual({ left: 220, right: 220 })
  })
})

describe('groundTop', () => {
  it('sinks the feet by the padding offset so they meet the surface', () => {
    // y - petH + FEET_DROP_PX(4)
    expect(groundTop(ledge(500), 100)).toBe(404)
  })
})

describe('overlapsX', () => {
  it('is true only when the walkable ranges share real width', () => {
    expect(overlapsX(ledge(0, 0, 100), ledge(0, 50, 200))).toBe(true)
    expect(overlapsX(ledge(0, 0, 100), ledge(0, 100, 200))).toBe(false) // touching, not overlapping
    expect(overlapsX(ledge(0, 0, 100), ledge(0, 300, 400))).toBe(false)
  })
})

describe('resolveLedge', () => {
  const floor = ledge(600)
  const shelf = ledge(300, 100, 400)

  it('returns the highest surface at or below the feet under the current x', () => {
    // Standing on the shelf line, under the shelf's x-span ⇒ the shelf.
    const petH = 100
    const onShelf = resolveLedge([floor, shelf], 200, shelf.y - petH, petH)
    expect(onShelf).toBe(shelf)
  })

  it('ignores surfaces the pet is not horizontally over', () => {
    const petH = 100
    // x=800 is past the shelf ⇒ only the floor qualifies.
    const onFloor = resolveLedge([floor, shelf], 800, floor.y - petH, petH)
    expect(onFloor).toBe(floor)
  })

  it('falls back to the floor (ledges[0]) when below everything', () => {
    const petH = 100
    const below = resolveLedge([floor, shelf], 200, 5000, petH)
    expect(below).toBe(floor)
  })

  it('counts a surface within GROUND_EPS of the feet as standing on it', () => {
    const petH = 100
    const justAbove = resolveLedge([floor], 10, floor.y - petH - GROUND_EPS + 0.5, petH)
    expect(justAbove).toBe(floor)
  })
})
