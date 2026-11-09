/**
 * Tests for electron/pet-overlay-registry.ts — the keying, placement and
 * retirement rules behind the per-assistant pet overlay windows.
 *
 * Run with: npm run test:desktop:platforms (vitest project "electron").
 */

import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  CASCADE_STEP,
  cascadeBounds,
  DEFAULT_PET_ID,
  MAX_PET_OVERLAYS,
  petIdOf,
  retireesFor
} from './pet-overlay-registry'

test('a named pet keys on its own id', () => {
  assert.equal(petIdOf('00000000-0000-4000-8000-041f5243cc7b'), '00000000-0000-4000-8000-041f5243cc7b')
})

test('blank, missing and non-string ids all address the default', () => {
  // The single-pet renderer sends nothing at all; it must keep working.
  for (const value of [undefined, null, '', '   ', 42, {}, []]) {
    assert.equal(petIdOf(value), DEFAULT_PET_ID)
  }
})

test('ids are trimmed so whitespace cannot fork a second window for one pet', () => {
  assert.equal(petIdOf('  agent-a  '), 'agent-a')
})

test('bounds are left alone when nothing is in the way', () => {
  const bounds = { height: 220, width: 220, x: 100, y: 100 }

  assert.deepEqual(cascadeBounds(bounds, []), bounds)
})

test('a colliding overlay is nudged clear, preserving size', () => {
  const placed = cascadeBounds({ height: 220, width: 220, x: 100, y: 100 }, [{ x: 100, y: 100 }])

  assert.deepEqual(placed, {
    height: 220,
    width: 220,
    x: 100 + CASCADE_STEP,
    y: 100 + CASCADE_STEP
  })
})

test('the cascade walks past a run of occupied origins', () => {
  const taken = [
    { x: 100, y: 100 },
    { x: 128, y: 128 },
    { x: 156, y: 156 }
  ]

  const placed = cascadeBounds({ x: 100, y: 100 }, taken)

  assert.deepEqual(placed, { x: 100 + 3 * CASCADE_STEP, y: 100 + 3 * CASCADE_STEP })
})

test('a near-miss still counts as a collision', () => {
  // Overlapping by all but a pixel reads as one pet, so the threshold is a
  // distance, not an equality.
  const placed = cascadeBounds({ x: 100, y: 100 }, [{ x: 100 + CASCADE_STEP - 1, y: 100 }])

  assert.notDeepEqual(placed, { x: 100, y: 100 })
})

test('the cascade gives up rather than marching a window off-screen', () => {
  // A wall of occupied origins along the diagonal can never be escaped by
  // stepping along it; bail out instead of looping.
  const wall = Array.from({ length: 50 }, (_, i) => ({
    x: 100 + i * CASCADE_STEP,
    y: 100 + i * CASCADE_STEP
  }))

  const placed = cascadeBounds({ x: 100, y: 100 }, wall)

  assert.equal(placed.x, 100 + MAX_PET_OVERLAYS * CASCADE_STEP)
})

test('nothing retires below the cap', () => {
  assert.deepEqual(retireesFor(['a', 'b']), [])
})

test('opening the (max + 1)th overlay retires the oldest', () => {
  const order = Array.from({ length: MAX_PET_OVERLAYS }, (_, i) => `pet-${i}`)

  assert.deepEqual(retireesFor(order), ['pet-0'])
})

test('a backlog over the cap retires enough to make exactly one slot', () => {
  const order = Array.from({ length: MAX_PET_OVERLAYS + 3 }, (_, i) => `pet-${i}`)
  const retired = retireesFor(order)

  assert.deepEqual(retired, ['pet-0', 'pet-1', 'pet-2', 'pet-3'])
  assert.equal(order.length - retired.length, MAX_PET_OVERLAYS - 1)
})
