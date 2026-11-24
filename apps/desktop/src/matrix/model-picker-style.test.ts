import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { TRANSLATIONS } from '@/i18n/catalog'

import digests from './model-picker-digests.json'
import labels from './model-picker-labels.json'
import { MODEL_PICKER_SPEC, MODEL_PICKER_VARS } from './model-picker-style'

// Every measure of the shared spec, as `path: value` (the colours are Work's; the desktop reads its own token).
function measures(node: unknown, path: string[] = []): [string, number][] {
  if (typeof node === 'number') {
    return [[path.join('.'), node]]
  }

  if (!node || typeof node !== 'object' || path.at(-1) === 'focusUnderline') {
    return []
  }

  return Object.entries(node).flatMap(([key, value]) => measures(value, [...path, key]))
}

describe('the shared model picker spec', () => {
  it('reaches the desktop card through a custom property for every measure', () => {
    const values = Object.values(MODEL_PICKER_VARS as Record<string, string>)

    for (const [path, value] of measures(MODEL_PICKER_SPEC)) {
      expect(values, path).toContainEqual(path.endsWith('weight') ? String(value) : `${value}px`)
    }

    expect(Object.keys(MODEL_PICKER_VARS).length).toBe(measures(MODEL_PICKER_SPEC).length)
  })

  it('matches the digests atum-work checks its byte-identical copies against', () => {
    for (const file of ['model-picker-spec.json', 'model-picker-labels.json'] as const) {
      const bytes = readFileSync(join(dirname(fileURLToPath(import.meta.url)), file))

      expect(createHash('sha256').update(bytes).digest('hex'), file).toBe(digests[file])
    }
  })

  it("calls Atum's everyday model suggested in the word the rest of the app uses", () => {
    for (const [locale, words] of Object.entries(TRANSLATIONS)) {
      expect(labels.suggested[locale as keyof typeof labels.suggested], locale).toBe(words.matrixShell.modelRecommended)
    }
  })
})
