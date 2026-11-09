import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  inchesToTwips,
  lineHeightToLineUnits,
  mmToInches,
  mmToTwips,
  pageGeometryTwips,
  pageMarginsInches,
  pagePaperInches,
  pointsToHalfPoints,
  pointsToTwips,
  twipsToMm
} from './units'

test('converts between millimetres, inches, points and twips', () => {
  assert.equal(mmToTwips(25.4), 1440)
  assert.equal(inchesToTwips(1), 1440)
  assert.equal(pointsToTwips(1), 20)
  assert.equal(mmToInches(25.4), 1)
  assert.equal(Math.round(twipsToMm(1440) * 100) / 100, 25.4)
})

test('reproduces the page geometry the exporter already ships', () => {
  // The shipped sectPr is w:w="11906" w:h="16838"; a theme-driven writer must
  // land on the same integers for an A4 document or every existing export moves.
  const geometry = pageGeometryTwips('a4', { bottomMm: 25.4, leftMm: 25.4, rightMm: 25.4, topMm: 25.4 })

  assert.equal(geometry.widthTwips, 11906)
  assert.equal(geometry.heightTwips, 16838)
  assert.equal(geometry.topTwips, 1440)
  assert.equal(geometry.leftTwips, 1440)
})

test('supports Letter alongside A4', () => {
  const geometry = pageGeometryTwips('letter', { bottomMm: 25.4, leftMm: 25.4, rightMm: 25.4, topMm: 25.4 })

  assert.equal(geometry.widthTwips, 12240)
  assert.equal(geometry.heightTwips, 15840)
})

test('converts font sizes to half-points, matching the shipped heading scale', () => {
  // The exporter hardcodes 36 half-points down to 16; a theme expressed in
  // points must produce the same values for the default scale.
  assert.equal(pointsToHalfPoints(18), 36)
  assert.equal(pointsToHalfPoints(8), 16)
  assert.equal(pointsToHalfPoints(11), 22)
  assert.equal(pointsToHalfPoints(11.5), 23)
})

test('expresses line height in Word 240ths-of-a-line units', () => {
  assert.equal(lineHeightToLineUnits(1), 240)
  assert.equal(lineHeightToLineUnits(1.5), 360)
  assert.equal(lineHeightToLineUnits(1.6), 384)
})

test('gives printToPDF its margins in inches', () => {
  const margins = pageMarginsInches({ bottomMm: 25.4, leftMm: 12.7, rightMm: 12.7, topMm: 25.4 })

  assert.equal(margins.top, 1)
  assert.equal(margins.bottom, 1)
  assert.equal(margins.left, 0.5)
  assert.equal(margins.right, 0.5)
})

test('refuses values that cannot become an OOXML integer', () => {
  assert.throws(() => mmToTwips(Number.NaN), /ATUM_OFFICE_INVALID_MM/u)
  assert.throws(() => mmToTwips(Number.POSITIVE_INFINITY), /ATUM_OFFICE_INVALID_MM/u)
  assert.throws(() => pointsToHalfPoints(Number.NaN), /ATUM_OFFICE_INVALID_POINTS/u)
  assert.throws(
    () => pageGeometryTwips('a3' as never, { bottomMm: 1, leftMm: 1, rightMm: 1, topMm: 1 }),
    /ATUM_OFFICE_INVALID_PAGE_SIZE/u
  )
})

test('gives printToPDF exact paper in inches, not Electron’s rounded named sizes', () => {
  const a4 = pagePaperInches('a4')
  // Electron's named 'A4' is 8.27 x 11.7 in; exact A4 is not.
  assert.ok(Math.abs(a4.width - 8.267716535) < 1e-9)
  assert.ok(Math.abs(a4.height - 11.692913386) < 1e-9)
  assert.deepEqual(pagePaperInches('letter'), { height: 11, width: 8.5 })
  assert.throws(() => pagePaperInches('a3' as never), /ATUM_OFFICE_INVALID_PAGE_SIZE/u)
})
