import { describe, expect, it } from 'vitest'

import { PET_DRAW_SCALE_DEFAULT, petDrawScale } from './pet'
import { overlayWindowSize } from './pet-overlay'

/**
 * Size is a display factor (plan 2026-09-13, decision 1): the person's scale
 * times the pet's own size, everywhere the pet is drawn. `scale` alone stays
 * the person's setting, so the wheel and the slider keep meaning what they say.
 */
describe('petDrawScale', () => {
  it("multiplies the person's scale by the pet's size", () => {
    expect(petDrawScale({ scale: 0.5, size: 1.45 })).toBeCloseTo(0.725)
  })

  it('treats a gateway that predates size as 1', () => {
    expect(petDrawScale({ scale: 0.5 })).toBe(0.5)
  })

  it('falls back to the default scale when nothing has loaded', () => {
    expect(petDrawScale({})).toBe(PET_DRAW_SCALE_DEFAULT)
    expect(petDrawScale({ size: 2 })).toBeCloseTo(PET_DRAW_SCALE_DEFAULT * 2)
  })

  it('sizes the overlay window off the drawn size, so a big dog is never cropped', () => {
    const gigi = overlayWindowSize(192, 208, petDrawScale({ scale: 1, size: 1 }))
    const bailey = overlayWindowSize(192, 208, petDrawScale({ scale: 1, size: 1.45 }))

    expect(bailey.width - gigi.width).toBe(Math.round(192 * 1.45) - 192)
    expect(bailey.height - gigi.height).toBe(Math.round(208 * 1.45) - 208)
  })
})
