import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $zoomPercent,
  normalizeTextSizeSliderPercent,
  setZoomPercent,
  storedZoomPercent,
  TEXT_SIZE_MAX_PERCENT,
  TEXT_SIZE_MIN_PERCENT
} from './zoom'

const setPercent = vi.fn()

beforeEach(() => {
  setPercent.mockClear()
  window.localStorage.removeItem('hermes:desktop:zoomLevel')
  $zoomPercent.set(100)
  window.hermesDesktop = { ...window.hermesDesktop, zoom: { get: vi.fn(), onChanged: vi.fn(), setPercent } }
})

describe('text size zoom', () => {
  it('only exposes a persisted zoom level as portable preference intent', () => {
    expect(storedZoomPercent()).toBeNull()

    window.localStorage.setItem('hermes:desktop:zoomLevel', '1')
    expect(storedZoomPercent()).toBe(120)

    window.localStorage.setItem('hermes:desktop:zoomLevel', '10')
    expect(storedZoomPercent()).toBeNull()
  })

  it('clamps invalid and out-of-range percentages to the consumer control range', () => {
    expect(normalizeTextSizeSliderPercent(Number.NaN)).toBe(100)
    expect(normalizeTextSizeSliderPercent(20)).toBe(TEXT_SIZE_MIN_PERCENT)
    expect(normalizeTextSizeSliderPercent(300)).toBe(TEXT_SIZE_MAX_PERCENT)
  })

  it('updates renderer state immediately and forwards the normalized value', () => {
    setZoomPercent(112.6)

    expect($zoomPercent.get()).toBe(112.6)
    expect(setPercent).toHaveBeenCalledWith(112.6)
  })
})
