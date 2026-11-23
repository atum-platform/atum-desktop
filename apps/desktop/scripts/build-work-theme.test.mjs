import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { buildWorkTheme, workThemeColors } from './build-work-theme.mjs'

const HEX = /^#[0-9a-f]{6}$/

describe('the Work theme (T3 environment theme from the Atum Kit)', () => {
  it('is what the sidecar ships, so a Kit change cannot leave Work on an old palette', () => {
    const shipped = JSON.parse(readFileSync(new URL('../electron/work/sidecar/atum.json', import.meta.url), 'utf8'))

    expect(shipped).toEqual(buildWorkTheme())
  })

  it('gives every role an opaque color in both appearances, ink as the accent', () => {
    const light = workThemeColors('light')
    const dark = workThemeColors('dark')

    expect(Object.keys(dark)).toEqual(Object.keys(light))
    for (const palette of [light, dark]) {
      for (const value of Object.values(palette)) {
        expect(value).toMatch(HEX)
      }

      expect(palette.accent).toBe(palette.text)
    }

    expect(dark.canvas).not.toBe(light.canvas)
  })

  it('stays inside what T3 publishes: one CSS string under its cap, no remote loads', () => {
    const { css, variants, appearance } = buildWorkTheme()

    expect(appearance).toBe('light')
    expect(Object.keys(variants)).toEqual(['dark'])
    expect(css.length).toBeLessThanOrEqual(100_000)
    expect(css).not.toMatch(/@import|url\(\s*["']?https?:/i)
    // Work's selectors are T3 data- hooks, never its class names.
    expect(css).toContain("[data-app-sidebar]")
    expect(css).toContain("[data-slot='sidebar-inset']")
  })
})
