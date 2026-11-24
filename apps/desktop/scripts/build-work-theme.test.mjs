import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { buildWorkTheme } from './build-work-theme.mjs'

describe('the Work theme (the Atum Kit palette as a T3 theme file)', () => {
  it('is what the sidecar ships, so a Kit change cannot leave Work on an old palette', () => {
    const shipped = readFileSync(new URL('../electron/work/sidecar/atum.json', import.meta.url), 'utf8')

    expect(shipped).toBe(buildWorkTheme())
  })

  it('is colours only, in both appearances: Work is stock T3 in Atum colours', () => {
    const theme = JSON.parse(buildWorkTheme())

    expect(theme).toMatchObject({ version: 1, name: 'Atum', appearance: 'light' })
    expect(theme).not.toHaveProperty('css')
    expect(Object.keys(theme.variants)).toEqual(['dark'])
    expect(Object.keys(theme.variants.dark)).toEqual(Object.keys(theme.colors))
    expect(theme.variants.dark.canvas).not.toBe(theme.colors.canvas)
  })
})
