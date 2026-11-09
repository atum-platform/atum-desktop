import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  codeSizePt,
  DEFAULT_DOCUMENT_THEME_ID,
  DOCUMENT_THEME_IDS,
  DOCUMENT_THEME_SCHEMA_VERSION,
  documentThemeCatalogue,
  documentThemeDefinition,
  isDocumentThemeId,
  parseDocumentThemeSelection,
  resolveDocumentTheme
} from './document-theme'

test('every catalogue entry is complete and internally consistent', () => {
  for (const definition of documentThemeCatalogue()) {
    assert.ok(DOCUMENT_THEME_IDS.includes(definition.id))
    assert.equal(definition.headingSizesPt.length, 6)
    assert.ok(definition.bodySizePt > 0)

    // Heading sizes descend from H1 to H6.
    for (let index = 1; index < definition.headingSizesPt.length; index += 1) {
      assert.ok(
        definition.headingSizesPt[index]! <= definition.headingSizesPt[index - 1]!,
        `${definition.id} heading scale must not increase at ${index}`
      )
    }

    // OOXML colours are six hex digits with no leading '#'.
    assert.match(definition.accentHex, /^[0-9A-F]{6}$/u)
  }
})

test('line heights stay in the range that keeps Vietnamese diacritics clear', () => {
  for (const definition of documentThemeCatalogue()) {
    assert.ok(
      definition.lineHeight >= 1.5 && definition.lineHeight <= 1.65,
      `${definition.id} line height ${definition.lineHeight} is outside 1.5–1.65`
    )
  }
})

test('every font stack ends in a generic family, because no face can be fetched', () => {
  // The PDF renderer sets font-src 'none', so a stack that cannot fall back to
  // a generic family would render in whatever the engine picked by accident.
  for (const definition of documentThemeCatalogue()) {
    for (const stack of [definition.bodyFont, definition.headingFont]) {
      assert.match(stack.css, /(serif|sans-serif|monospace)$/u)

      // OOXML w:rFonts takes the bare family name. A CSS-quoted value would
      // make Word hunt for a font whose name contains quote marks.
      for (const value of Object.values(stack.docx)) {
        assert.equal(value.includes('"'), false, `${definition.id}: ${value} must not be CSS-quoted`)
        assert.equal(value.trim(), value)
      }

      // The CSS side does quote, so a family with spaces stays one token.
      assert.match(stack.css, /^"[^"]+"/u)
      assert.ok(stack.docx.ascii.length > 0)
      assert.equal(stack.docx.ascii, stack.docx.hAnsi)
      assert.ok(stack.docx.cs.length > 0 && stack.docx.eastAsia.length > 0)
    }
  }
})

test('the default theme reproduces the heading scale the exporter already ships', () => {
  assert.equal(DEFAULT_DOCUMENT_THEME_ID, 'manuscript')
  // 36 half-points down to 16 is what stylesXml() emits today.
  assert.deepEqual([...documentThemeDefinition('manuscript').headingSizesPt], [18, 16, 14, 12, 10, 8])
})

test('identifies catalogue members and rejects everything else', () => {
  assert.equal(isDocumentThemeId('manuscript'), true)
  assert.equal(isDocumentThemeId('MANUSCRIPT'), false)
  assert.equal(isDocumentThemeId('custom'), false)
  assert.equal(isDocumentThemeId(null), false)
  assert.equal(isDocumentThemeId(7), false)
})

test('parses a well-formed selection and drops unknown override keys', () => {
  assert.deepEqual(parseDocumentThemeSelection({ themeId: 'modern' }), { themeId: 'modern' })
  assert.deepEqual(
    parseDocumentThemeSelection({
      overrides: { bodyFont: 'Comic Sans MS', bodySizePt: 12, css: 'body{}', pageSize: 'letter' },
      themeId: 'report'
    }),
    { overrides: { bodySizePt: 12, pageSize: 'letter' }, themeId: 'report' }
  )
})

test('refuses a selection that is not an allowlisted theme', () => {
  for (const value of [
    null,
    undefined,
    'manuscript',
    ['manuscript'],
    {},
    { themeId: 'custom' },
    { themeId: 'Manuscript' },
    { themeId: 42 }
  ]) {
    assert.equal(parseDocumentThemeSelection(value), null)
  }
})

test('bounds the overrides rather than trusting stored numbers', () => {
  const outOfRange = parseDocumentThemeSelection({ overrides: { bodySizePt: 400 }, themeId: 'modern' })
  assert.deepEqual(outOfRange, { themeId: 'modern' })

  assert.deepEqual(parseDocumentThemeSelection({ overrides: { bodySizePt: 7 }, themeId: 'modern' }), {
    themeId: 'modern'
  })
  assert.deepEqual(parseDocumentThemeSelection({ overrides: { bodySizePt: Number.NaN }, themeId: 'modern' }), {
    themeId: 'modern'
  })
  assert.deepEqual(parseDocumentThemeSelection({ overrides: { pageSize: 'a3' }, themeId: 'modern' }), {
    themeId: 'modern'
  })

  // Half-point granularity, so the Word file and the CSS cannot disagree.
  assert.deepEqual(parseDocumentThemeSelection({ overrides: { bodySizePt: 11.3 }, themeId: 'modern' }), {
    overrides: { bodySizePt: 11.5 },
    themeId: 'modern'
  })
  assert.deepEqual(parseDocumentThemeSelection({ overrides: { bodySizePt: 11.25 }, themeId: 'modern' }), {
    overrides: { bodySizePt: 11.5 },
    themeId: 'modern'
  })
})

test('resolves nothing into the default, marked as such', () => {
  const resolved = resolveDocumentTheme(null)

  assert.equal(resolved.id, DEFAULT_DOCUMENT_THEME_ID)
  assert.equal(resolved.isDefault, true)
  assert.equal(resolved.revision, 0)
  assert.equal(resolved.schemaVersion, DOCUMENT_THEME_SCHEMA_VERSION)
})

test('resolves a selection with its overrides applied and its provenance attached', () => {
  const resolved = resolveDocumentTheme({ overrides: { bodySizePt: 13, pageSize: 'letter' }, themeId: 'report' }, 4)

  assert.equal(resolved.id, 'report')
  assert.equal(resolved.bodySizePt, 13)
  assert.equal(resolved.pageSize, 'letter')
  assert.equal(resolved.isDefault, false)
  assert.equal(resolved.revision, 4)
  // Untouched values still come from the catalogue.
  assert.equal(resolved.lineHeight, documentThemeDefinition('report').lineHeight)
})

test('hands back a deeply frozen snapshot so a writer cannot mutate the catalogue', () => {
  // The snapshot spreads the catalogue definition, so its nested objects are
  // shared references. A single cast-and-assign by any consumer would otherwise
  // change the font of every later export.
  const resolved = resolveDocumentTheme({ themeId: 'modern' }, 1)

  assert.equal(Object.isFrozen(resolved), true)
  assert.equal(Object.isFrozen(resolved.bodyFont), true)
  assert.equal(Object.isFrozen(resolved.bodyFont.docx), true)
  assert.equal(Object.isFrozen(resolved.headingFont), true)
  assert.equal(Object.isFrozen(resolved.headingFont.docx), true)
  assert.equal(Object.isFrozen(resolved.headingSizesPt), true)
  assert.equal(Object.isFrozen(resolved.marginMm), true)

  assert.throws(() => {
    ;(resolved.bodyFont.docx as { ascii: string }).ascii = 'Comic Sans MS'
  })
  assert.throws(() => {
    ;(resolved.bodyFont as { css: string }).css = 'Comic Sans MS'
  })
  assert.equal(documentThemeDefinition('modern').bodyFont.docx.ascii, 'Arial')
})

test('a body-size override scales the heading scale with it', () => {
  // Otherwise an 18 pt body under the note theme gets headings of 16 pt and below.
  const resolved = resolveDocumentTheme({ overrides: { bodySizePt: 18 }, themeId: 'note' }, 1)
  const base = documentThemeDefinition('note')

  assert.equal(resolved.bodySizePt, 18)

  for (let index = 0; index < 6; index += 1) {
    const expected = Math.round(base.headingSizesPt[index]! * (18 / base.bodySizePt) * 2) / 2
    assert.equal(resolved.headingSizesPt[index], expected, `heading ${index + 1}`)
    assert.equal(Number.isInteger(resolved.headingSizesPt[index]! * 2), true, 'half-point granularity')
  }

  assert.ok(resolved.headingSizesPt[0]! > resolved.bodySizePt, 'H1 stays above the body')
  // No override, no change: the shared catalogue array is handed back as is.
  assert.equal(resolveDocumentTheme({ themeId: 'note' }, 1).headingSizesPt, base.headingSizesPt)
})

test('code sits one point under the body at half-point granularity, never below 8', () => {
  assert.equal(codeSizePt({ bodySizePt: 11 }), 10)
  assert.equal(codeSizePt({ bodySizePt: 11.5 }), 10.5)
  assert.equal(codeSizePt({ bodySizePt: 8 }), 8)
  assert.equal(codeSizePt({ bodySizePt: 18 }), 17)
})
