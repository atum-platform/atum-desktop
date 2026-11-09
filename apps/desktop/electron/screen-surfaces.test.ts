/**
 * Tests for electron/screen-surfaces.ts — what a desktop-roaming pet can stand
 * on, and where a named place ("go to the left side") actually is.
 *
 * Run with: npm run test:desktop:platforms (vitest project "electron").
 */

import assert from 'node:assert/strict'

import { test } from 'vitest'

import { clampToScreens, type DisplayInfo, screenLedges, targetXFor } from './screen-surfaces'

const PET = { petH: 70, petW: 64 }

/** A 1440x900 display with a 70px Dock and a 25px menu bar. */
const MAC: DisplayInfo = {
  bounds: { height: 900, width: 1440, x: 0, y: 0 },
  workArea: { height: 805, width: 1440, x: 0, y: 25 }
}

/** No Dock, no menu bar — work area fills the display. */
const BARE: DisplayInfo = {
  bounds: { height: 1080, width: 1920, x: 1440, y: 0 },
  workArea: { height: 1080, width: 1920, x: 1440, y: 0 }
}

test('the floor sits on top of the Dock, not at the bottom of the screen', () => {
  const ledges = screenLedges({ displays: [MAC], ...PET })
  const floor = ledges.find(l => l.kind === 'floor')

  // workArea.y + height = 830, i.e. 70px above the 900px screen bottom.
  assert.equal(floor?.y, 830)
})

test('a ledge reserves room for the whole sprite', () => {
  const floor = screenLedges({ displays: [MAC], ...PET }).find(l => l.kind === 'floor')

  // Walking to `right` must not hang the pet off the edge.
  assert.equal(floor?.left, 0)
  assert.equal(floor?.right, 1440 - PET.petW)
})

test('there is exactly one ground line per display, and nothing else', () => {
  // The app's title bar and the strip under the menu bar used to be ledges. They
  // made the landing spot unpredictable — dropped over the Atum window she
  // perched on its title bar instead of falling — so the model is now one floor.
  const ledges = screenLedges({
    appWindow: { height: 600, width: 900, x: 200, y: 120 },
    displays: [MAC],
    ...PET
  })

  assert.deepEqual(ledges.map(l => l.kind), ['floor'])
})

test('a display with no chrome puts the floor at the bottom of the screen', () => {
  const floor = screenLedges({ displays: [BARE], ...PET })[0]

  assert.equal(floor?.y, 1080)
})

test('every display contributes its own ground, so she can cross screens', () => {
  const ledges = screenLedges({ displays: [MAC, BARE], ...PET })

  assert.equal(ledges.length, 2)
  assert.ok(ledges.some(l => l.left === 0))
  assert.ok(ledges.some(l => l.left === 1440))
})

test('a pet stranded off-screen is pulled back onto the nearest display', () => {
  const home = clampToScreens({ x: -900, y: -900 }, { displays: [MAC, BARE], ...PET })

  assert.equal(home.x, 0)
  assert.equal(home.y, 25)
})

test('a pet already on a display is left where it is', () => {
  const point = { x: 400, y: 400 }

  assert.deepEqual(clampToScreens(point, { displays: [MAC], ...PET }), point)
})

test('clamping keeps the whole sprite on screen, not just its origin', () => {
  const home = clampToScreens({ x: 9999, y: 9999 }, { displays: [MAC], ...PET })

  assert.equal(home.x, 1440 - PET.petW)
  assert.equal(home.y, 25 + 805 - PET.petH)
})

test('named places resolve to regions of the ledge, not to its very edge', () => {
  const floor = screenLedges({ displays: [MAC], ...PET }).find(l => l.kind === 'floor')!

  const left = targetXFor('left', floor)!
  const right = targetXFor('right', floor)!
  const centre = targetXFor('center', floor)!

  assert.ok(left > floor.left && left < centre)
  assert.ok(right < floor.right && right > centre)
  assert.equal(targetXFor('centre', floor), centre)
})

test('an unknown place is refused rather than guessed at', () => {
  const floor = screenLedges({ displays: [MAC], ...PET }).find(l => l.kind === 'floor')!

  assert.equal(targetXFor('somewhere nice', floor), null)
})
