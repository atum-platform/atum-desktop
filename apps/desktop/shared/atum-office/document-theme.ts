/**
 * The document theme catalogue.
 *
 * A theme is the substitute for per-run formatting: Markdown stores no fonts,
 * so the document has a *look* instead, exactly as a Substack publication does.
 * The catalogue is deliberately CLOSED — a stored selection is an allowlisted
 * identifier plus a small set of bounded overrides, never arbitrary CSS and
 * never an arbitrary font name. Anything unrecognised resolves to the default
 * rather than being honoured, so a corrupted or hand-edited store cannot inject
 * a font name into an exported file or into the PDF renderer.
 *
 * Font policy: primary faces must ship on both macOS and Windows AND carry full
 * Vietnamese diacritic coverage. The PDF renderer sets `font-src 'none'`, so no
 * face can ever be fetched; a family absent from the machine silently falls back
 * through the stack. That is why the allowlist is small and conservative rather
 * than pretty. Line heights stay in the 1.5–1.65 range so stacked Vietnamese
 * diacritics do not collide at heading sizes.
 */

import type { DocumentPageSize, PageMarginsMm } from './units'

/** Bumped only when the *stored* shape changes; see the store's migration seam. */
export const DOCUMENT_THEME_SCHEMA_VERSION = 1

export const DOCUMENT_THEME_IDS = ['manuscript', 'modern', 'report', 'book', 'note'] as const

export type DocumentThemeId = (typeof DOCUMENT_THEME_IDS)[number]

export const DEFAULT_DOCUMENT_THEME_ID: DocumentThemeId = 'manuscript'

/** A theme may only move the body size inside this range. */
export const MIN_BODY_SIZE_PT = 8
export const MAX_BODY_SIZE_PT = 18

export interface DocumentFontStack {
  /** CSS stack for the editor canvas and the PDF renderer. System faces only. */
  readonly css: string
  /** `w:rFonts` attributes. Word substitutes when a face is absent. */
  readonly docx: {
    readonly ascii: string
    readonly hAnsi: string
    readonly cs: string
    readonly eastAsia: string
  }
}

export interface DocumentThemeDefinition {
  readonly id: DocumentThemeId
  /** Untranslated catalogue label; the picker supplies localised names. */
  readonly label: string
  readonly bodyFont: DocumentFontStack
  readonly headingFont: DocumentFontStack
  readonly bodySizePt: number
  /** Heading 1 through 6, in points. */
  readonly headingSizesPt: readonly number[]
  readonly lineHeight: number
  readonly paragraphSpacingPt: number
  readonly pageSize: DocumentPageSize
  readonly marginMm: PageMarginsMm
  /** OOXML colour form: six hex digits, no leading '#'. */
  readonly accentHex: string
}

/**
 * `family` is the bare family name. CSS quoting is applied here and ONLY here:
 * OOXML's `w:rFonts` attributes take the bare name, and a CSS-quoted value
 * would make Word hunt for a font whose name literally contains quote marks.
 *
 * Frozen at construction, nested object included. A resolved snapshot spreads
 * the outer definition and freezes that, which would leave these shared
 * catalogue objects writable; a single cast-and-assign by any consumer would
 * then change the font of every later export and defeat the closed catalogue.
 */
function stack(family: string, cssFallbacks: string, generic: string): DocumentFontStack {
  return Object.freeze({
    css: `"${family}", ${cssFallbacks}, ${generic}`,
    docx: Object.freeze({ ascii: family, cs: family, eastAsia: family, hAnsi: family })
  })
}

// Both families ship on macOS and Windows with complete Vietnamese coverage.
const TIMES = stack('Times New Roman', '"Liberation Serif", "Nimbus Roman", Times', 'serif')
const ARIAL = stack('Arial', '"Liberation Sans", "Helvetica Neue", Helvetica', 'sans-serif')
// Palatino Linotype (Windows) / Palatino (macOS) — verified Vietnamese coverage.
const PALATINO = stack('Palatino Linotype', 'Palatino, "Book Antiqua", "URW Palladio L"', 'serif')

const UNIFORM_MARGIN_MM: PageMarginsMm = Object.freeze({
  bottomMm: 25.4,
  leftMm: 25.4,
  rightMm: 25.4,
  topMm: 25.4
})

const CATALOGUE: Readonly<Record<DocumentThemeId, DocumentThemeDefinition>> = Object.freeze({
  book: Object.freeze({
    accentHex: '6B4E2E',
    bodyFont: PALATINO,
    bodySizePt: 11.5,
    headingFont: PALATINO,
    headingSizesPt: Object.freeze([19, 16, 14, 12.5, 11.5, 11]),
    id: 'book',
    label: 'Book',
    lineHeight: 1.65,
    marginMm: Object.freeze({ bottomMm: 28, leftMm: 28, rightMm: 28, topMm: 28 }),
    pageSize: 'a4',
    paragraphSpacingPt: 0
  }),
  manuscript: Object.freeze({
    accentHex: '1F4E79',
    bodyFont: TIMES,
    bodySizePt: 11,
    headingFont: TIMES,
    // Matches the scale the exporter shipped with, so an untouched document
    // keeps the headings it already had.
    headingSizesPt: Object.freeze([18, 16, 14, 12, 10, 8]),
    id: 'manuscript',
    label: 'Manuscript',
    lineHeight: 1.6,
    marginMm: UNIFORM_MARGIN_MM,
    pageSize: 'a4',
    paragraphSpacingPt: 6
  }),
  modern: Object.freeze({
    accentHex: '0F6FC6',
    bodyFont: ARIAL,
    bodySizePt: 11,
    headingFont: ARIAL,
    headingSizesPt: Object.freeze([18, 15.5, 13.5, 12, 11, 10]),
    id: 'modern',
    label: 'Modern',
    lineHeight: 1.6,
    marginMm: UNIFORM_MARGIN_MM,
    pageSize: 'a4',
    paragraphSpacingPt: 8
  }),
  note: Object.freeze({
    accentHex: '4A5568',
    bodyFont: ARIAL,
    bodySizePt: 10.5,
    headingFont: ARIAL,
    headingSizesPt: Object.freeze([16, 14, 12.5, 11.5, 10.5, 10]),
    id: 'note',
    label: 'Note',
    lineHeight: 1.55,
    marginMm: Object.freeze({ bottomMm: 19, leftMm: 19, rightMm: 19, topMm: 19 }),
    pageSize: 'a4',
    paragraphSpacingPt: 6
  }),
  report: Object.freeze({
    accentHex: '1F4E79',
    bodyFont: TIMES,
    bodySizePt: 11,
    headingFont: ARIAL,
    headingSizesPt: Object.freeze([17, 15, 13, 12, 11, 10]),
    id: 'report',
    label: 'Report',
    lineHeight: 1.5,
    marginMm: UNIFORM_MARGIN_MM,
    pageSize: 'a4',
    paragraphSpacingPt: 10
  })
})

export function documentThemeDefinition(id: DocumentThemeId): DocumentThemeDefinition {
  return CATALOGUE[id]
}

export function documentThemeCatalogue(): readonly DocumentThemeDefinition[] {
  return DOCUMENT_THEME_IDS.map(id => CATALOGUE[id])
}

export function isDocumentThemeId(value: unknown): value is DocumentThemeId {
  return typeof value === 'string' && (DOCUMENT_THEME_IDS as readonly string[]).includes(value)
}

export interface DocumentThemeOverrides {
  readonly pageSize?: DocumentPageSize
  readonly bodySizePt?: number
}

export interface DocumentThemeSelection {
  readonly themeId: DocumentThemeId
  readonly overrides?: DocumentThemeOverrides
}

/**
 * A theme as the writers consume it: every value already resolved, plus the
 * provenance export fences and audits against.
 */
export interface ResolvedDocumentTheme extends DocumentThemeDefinition {
  readonly schemaVersion: number
  /** Per-document write counter. 0 means "never chosen; this is the default". */
  readonly revision: number
  readonly isDefault: boolean
}

function toHalfPoint(value: number): number {
  return Math.round(value * 2) / 2
}

/**
 * Code runs one point under the body, never below 8 pt, at half-point
 * granularity. Shared by the Word writer and the print CSS so both agree.
 */
export function codeSizePt(theme: Pick<DocumentThemeDefinition, 'bodySizePt'>): number {
  return Math.max(8, toHalfPoint(theme.bodySizePt - 1))
}

function isPageSize(value: unknown): value is DocumentPageSize {
  return value === 'a4' || value === 'letter'
}

function parseBodySizePt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }

  // Half-point granularity, because OOXML sizes are integer half-points: a
  // quarter-point value would round in the Word file but not in the CSS, and
  // the two writers would disagree.
  const rounded = Math.round(value * 2) / 2

  return rounded >= MIN_BODY_SIZE_PT && rounded <= MAX_BODY_SIZE_PT ? rounded : undefined
}

/**
 * Parse an untrusted stored value. Returns null for anything unrecognised so
 * the caller falls back to the default rather than honouring partial data.
 * Unknown override keys are dropped, never carried through.
 */
export function parseDocumentThemeSelection(value: unknown): DocumentThemeSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const candidate = value as { themeId?: unknown; overrides?: unknown }

  if (!isDocumentThemeId(candidate.themeId)) {
    return null
  }

  const overrides: { pageSize?: DocumentPageSize; bodySizePt?: number } = {}

  if (candidate.overrides && typeof candidate.overrides === 'object' && !Array.isArray(candidate.overrides)) {
    const raw = candidate.overrides as { pageSize?: unknown; bodySizePt?: unknown }

    if (isPageSize(raw.pageSize)) {
      overrides.pageSize = raw.pageSize
    }

    const bodySizePt = parseBodySizePt(raw.bodySizePt)

    if (bodySizePt !== undefined) {
      overrides.bodySizePt = bodySizePt
    }
  }

  return Object.keys(overrides).length > 0 ? { overrides, themeId: candidate.themeId } : { themeId: candidate.themeId }
}

/**
 * The strict parser for a selection arriving from a renderer. Where the stored
 * form is read tolerantly (an unknown key from an older build is dropped, not
 * fatal), a live request that carries anything off the contract is refused
 * outright: an unknown key, an out-of-range size, a page size that is not in
 * the enum. Nothing a renderer sends may be silently "corrected" on its way
 * into the store.
 */
export function parseDocumentThemeSelectionStrict(value: unknown): DocumentThemeSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const keys = Object.keys(value as object)

  if (keys.some(key => key !== 'themeId' && key !== 'overrides')) {
    return null
  }

  const candidate = value as { themeId?: unknown; overrides?: unknown }

  if (!isDocumentThemeId(candidate.themeId)) {
    return null
  }

  if (candidate.overrides === undefined) {
    return { themeId: candidate.themeId }
  }

  if (!candidate.overrides || typeof candidate.overrides !== 'object' || Array.isArray(candidate.overrides)) {
    return null
  }

  const raw = candidate.overrides as Record<string, unknown>

  if (Object.keys(raw).some(key => key !== 'pageSize' && key !== 'bodySizePt')) {
    return null
  }

  const overrides: { pageSize?: DocumentPageSize; bodySizePt?: number } = {}

  if ('pageSize' in raw) {
    if (!isPageSize(raw.pageSize)) {
      return null
    }

    overrides.pageSize = raw.pageSize
  }

  if ('bodySizePt' in raw) {
    const bodySizePt = parseBodySizePt(raw.bodySizePt)

    if (bodySizePt === undefined || bodySizePt !== raw.bodySizePt) {
      return null
    }

    overrides.bodySizePt = bodySizePt
  }

  return Object.keys(overrides).length > 0 ? { overrides, themeId: candidate.themeId } : { themeId: candidate.themeId }
}

/**
 * Resolve a selection (or nothing) into the immutable snapshot export pins.
 * Defaults are *inferred* here, never materialised into the store, so a
 * document that has never been themed writes no metadata row at all.
 */
export function resolveDocumentTheme(selection: DocumentThemeSelection | null, revision = 0): ResolvedDocumentTheme {
  const base = CATALOGUE[selection?.themeId ?? DEFAULT_DOCUMENT_THEME_ID]
  const overrides = selection?.overrides
  const bodySizePt = overrides?.bodySizePt ?? base.bodySizePt
  // A body-size override scales the whole type scale, so headings keep their
  // relationship to the body instead of ending up smaller than it.
  const scale = bodySizePt / base.bodySizePt

  const headingSizesPt =
    scale === 1 ? base.headingSizesPt : Object.freeze(base.headingSizesPt.map(size => toHalfPoint(size * scale)))

  return Object.freeze({
    ...base,
    bodySizePt,
    headingSizesPt,
    isDefault: selection === null,
    marginMm: base.marginMm,
    pageSize: overrides?.pageSize ?? base.pageSize,
    revision: Math.max(0, Math.floor(revision)),
    schemaVersion: DOCUMENT_THEME_SCHEMA_VERSION
  })
}
