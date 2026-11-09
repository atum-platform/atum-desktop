import { describe, expect, it } from 'vitest'

import { MatrixPetDisplay } from './pet-overlay-preferences'

function setup() {
  const values = new Map<string, string>()

  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    }
  }

  return { values, display: new MatrixPetDisplay(store), store }
}

describe('native pet display preferences', () => {
  it('defaults previews off and rejects malformed or widened preference writes', () => {
    const { display, values } = setup()
    expect(display.read()).toEqual({ showReplyExcerpt: false })

    for (const value of [null, true, [], {}, { showReplyExcerpt: 'true' }, { showReplyExcerpt: true, room: 'other' }]) {
      expect(() => display.write(value)).toThrow('matrix_pet_display_invalid')
    }

    values.set('matrix-pet-display', 'broken')
    expect(display.read()).toEqual({ showReplyExcerpt: false })
  })

  it('round-trips an explicit device-local choice and projects only the closed boolean', () => {
    const { display, store } = setup()
    display.write({ showReplyExcerpt: true })
    expect(new MatrixPetDisplay(store).read()).toEqual({ showReplyExcerpt: true })
    display.write({ showReplyExcerpt: false })
    expect(display.read()).toEqual({ showReplyExcerpt: false })
    store.setItem('matrix-pet-display', JSON.stringify({ showReplyExcerpt: 'true' }))
    expect(display.read()).toEqual({ showReplyExcerpt: false })
  })

  it('isolates native positions by account/agent and discards malformed coordinates', () => {
    const { display, values } = setup()
    display.remember('account-a:agent', { x: -100, y: 24 })
    expect(display.position('account-a:agent')).toEqual({ x: -100, y: 24 })
    expect(display.position('account-b:agent')).toBeUndefined()
    display.remember('other', { x: NaN, y: 4 })
    expect(display.position('other')).toBeUndefined()
    values.set('matrix-pet-position:bad', '{')
    expect(display.position('bad')).toBeUndefined()
  })
})
