import { describe, expect, it } from 'vitest'

import { LOCALE_OPTIONS } from '@/i18n'

import { matrixChatCopy } from './chat-copy'

/** Every sentence a copy table can produce, functions called with a sample. */
function sentences(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value]
  }

  if (typeof value === 'function') {
    return sentences((value as (sample: unknown) => unknown)(2))
  }

  if (Array.isArray(value)) {
    return value.flatMap(sentences)
  }

  return value && typeof value === 'object' ? Object.values(value).flatMap(sentences) : []
}

describe('chat copy', () => {
  it.each(LOCALE_OPTIONS.map(({ id }) => id))('has every sentence in %s, and none names the runtime or the protocol', locale => {
    const copy = matrixChatCopy(locale)

    expect(Object.keys(copy).sort()).toEqual(Object.keys(matrixChatCopy('en')).sort())

    for (const sentence of sentences(copy)) {
      expect(sentence.trim()).not.toBe('')
      expect(sentence).not.toMatch(/Hermes|Matrix|candidate|undefined/u)
    }
  })

  it('offers each language the same number of starters, each with words to start from', () => {
    for (const { id } of LOCALE_OPTIONS) {
      const starters = matrixChatCopy(id).starters
      expect(starters).toHaveLength(matrixChatCopy('en').starters.length)
      expect(starters.every(starter => starter.label.trim() && starter.text.trim())).toBe(true)
    }
  })
})
