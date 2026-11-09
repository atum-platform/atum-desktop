/**
 * Shared measurement conversions for Atum Office.
 *
 * Before this module the document geometry was three disagreeing literals: the
 * DOCX `sectPr` used 1440 twips (25.4 mm), the print stylesheet used 20 mm, and
 * `printToPDF` used 0.7 in (17.78 mm). A document theme cannot describe a page
 * while three writers each invent their own numbers, so every geometry value
 * now starts as millimetres or points in one theme and is converted here.
 *
 * OOXML integer units:
 *   - twip ("twentieth of a point") for lengths: 1440 per inch, 20 per point.
 *   - half-point for font sizes: `w:sz` / `w:szCs`.
 */

export const MM_PER_INCH = 25.4
export const POINTS_PER_INCH = 72
export const TWIPS_PER_INCH = 1440
export const TWIPS_PER_POINT = 20
export const HALF_POINTS_PER_POINT = 2

/** OOXML lengths are integers; fractional twips are not representable. */
function toInteger(value: number, unit: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`ATUM_OFFICE_INVALID_${unit}`)
  }

  return Math.round(value)
}

export function mmToInches(mm: number): number {
  return mm / MM_PER_INCH
}

export function inchesToMm(inches: number): number {
  return inches * MM_PER_INCH
}

export function mmToTwips(mm: number): number {
  return toInteger((mm / MM_PER_INCH) * TWIPS_PER_INCH, 'MM')
}

export function twipsToMm(twips: number): number {
  return (twips / TWIPS_PER_INCH) * MM_PER_INCH
}

export function inchesToTwips(inches: number): number {
  return toInteger(inches * TWIPS_PER_INCH, 'INCHES')
}

export function pointsToTwips(points: number): number {
  return toInteger(points * TWIPS_PER_POINT, 'POINTS')
}

/** `w:sz` and `w:szCs` are half-points, so 11 pt serialises as 22. */
export function pointsToHalfPoints(points: number): number {
  return toInteger(points * HALF_POINTS_PER_POINT, 'POINTS')
}

/**
 * Word expresses multiple-of-single line spacing in 240ths of a line, paired
 * with `w:lineRule="auto"`. A 1.5 line height is `w:line="360"`.
 */
export const LINE_UNITS_PER_LINE = 240

export function lineHeightToLineUnits(multiple: number): number {
  return toInteger(multiple * LINE_UNITS_PER_LINE, 'LINE_HEIGHT')
}

export type DocumentPageSize = 'a4' | 'letter'

export interface PageDimensionsMm {
  readonly widthMm: number
  readonly heightMm: number
}

/** Portrait dimensions. Landscape is not offered; see the Phase 3 plan §10. */
export const PAGE_DIMENSIONS_MM: Readonly<Record<DocumentPageSize, PageDimensionsMm>> = Object.freeze({
  a4: Object.freeze({ heightMm: 297, widthMm: 210 }),
  letter: Object.freeze({ heightMm: 279.4, widthMm: 215.9 })
})

export interface PageMarginsMm {
  readonly topMm: number
  readonly rightMm: number
  readonly bottomMm: number
  readonly leftMm: number
}

export interface PageGeometryTwips {
  readonly widthTwips: number
  readonly heightTwips: number
  readonly topTwips: number
  readonly rightTwips: number
  readonly bottomTwips: number
  readonly leftTwips: number
}

/**
 * The single geometry authority. Every writer derives from this rather than
 * carrying its own literal: the DOCX `sectPr` takes the twips, the print
 * stylesheet takes the millimetres, and `printToPDF` takes the inches.
 */
export function pageGeometryTwips(size: DocumentPageSize, margins: PageMarginsMm): PageGeometryTwips {
  const page = PAGE_DIMENSIONS_MM[size]

  if (!page) {
    throw new Error('ATUM_OFFICE_INVALID_PAGE_SIZE')
  }

  return {
    bottomTwips: mmToTwips(margins.bottomMm),
    heightTwips: mmToTwips(page.heightMm),
    leftTwips: mmToTwips(margins.leftMm),
    rightTwips: mmToTwips(margins.rightMm),
    topTwips: mmToTwips(margins.topMm),
    widthTwips: mmToTwips(page.widthMm)
  }
}

export interface PageMarginsInches {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

export interface PagePaperInches {
  readonly width: number
  readonly height: number
}

/**
 * Paper size in inches for `printToPDF`.
 *
 * Deliberately the object form rather than Electron's named `'A4'`: its table
 * rounds A4 to 8.27 x 11.7 in, which is 210.058 x 297.18 mm, not 210 x 297.
 * Deriving from the same millimetres as `pageGeometryTwips` keeps the PDF and
 * the Word file on one set of numbers.
 */
export function pagePaperInches(size: DocumentPageSize): PagePaperInches {
  const page = PAGE_DIMENSIONS_MM[size]

  if (!page) {
    throw new Error('ATUM_OFFICE_INVALID_PAGE_SIZE')
  }

  return { height: mmToInches(page.heightMm), width: mmToInches(page.widthMm) }
}

/** `printToPDF` takes inches. */
export function pageMarginsInches(margins: PageMarginsMm): PageMarginsInches {
  return {
    bottom: mmToInches(margins.bottomMm),
    left: mmToInches(margins.leftMm),
    right: mmToInches(margins.rightMm),
    top: mmToInches(margins.topMm)
  }
}
