import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { StoreArt } from './store-card'

function glyphOf(item: { glyph?: string; kind: 'agent' | 'skill' }) {
  const { container } = render(<StoreArt item={item} size="tile" />)

  return [...container.querySelector('svg')!.classList].find(name => name.startsWith('atum-icon-') && name !== 'atum-icon-fill')
}

describe('StoreArt', () => {
  it('draws the Phosphor counterpart of the glyph the catalog names', () => {
    expect(glyphOf({ glyph: '🗓️', kind: 'skill' })).toBe('atum-icon-calendar-blank')
    expect(glyphOf({ glyph: '🧑‍🏫', kind: 'agent' })).toBe('atum-icon-chalkboard-teacher')
  })

  it('falls back to the kind’s glyph, never the emoji, when there is no counterpart', () => {
    const { container } = render(<StoreArt item={{ glyph: '🦄', kind: 'skill' }} size="tile" />)

    expect(container.textContent).toBe('')
    expect(glyphOf({ glyph: '🦄', kind: 'skill' })).toBe('atum-icon-sparkle')
    expect(glyphOf({ kind: 'agent' })).toBe('atum-icon-robot')
  })
})
