import { describe, expect, it, vi } from 'vitest'

import { NATIVE_TOOLTIP_DELAY_MS, quickenNativeTooltips } from './native-tooltip-delay'

describe('quickenNativeTooltips', () => {
  it('registers a short AppKit tooltip delay on macOS', () => {
    const registerDefaults = vi.fn()

    expect(quickenNativeTooltips('darwin', { registerDefaults })).toBe(true)
    expect(registerDefaults).toHaveBeenCalledWith({ NSInitialToolTipDelay: NATIVE_TOOLTIP_DELAY_MS })
    expect(NATIVE_TOOLTIP_DELAY_MS).toBeGreaterThan(0)
    expect(NATIVE_TOOLTIP_DELAY_MS).toBeLessThan(500)
  })

  it('leaves other platforms alone', () => {
    const registerDefaults = vi.fn()

    expect(quickenNativeTooltips('win32', { registerDefaults })).toBe(false)
    expect(quickenNativeTooltips('linux', { registerDefaults })).toBe(false)
    expect(registerDefaults).not.toHaveBeenCalled()
  })

  it('never fails startup when the preference cannot be written', () => {
    const registerDefaults = vi.fn(() => {
      throw new Error('unavailable')
    })

    expect(quickenNativeTooltips('darwin', { registerDefaults })).toBe(false)
  })
})
