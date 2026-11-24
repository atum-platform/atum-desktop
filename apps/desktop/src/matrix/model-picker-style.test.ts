import { describe, expect, it } from 'vitest'

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
})
