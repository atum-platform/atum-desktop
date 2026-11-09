import { expect, it } from 'vitest'

import moonLookFixture from '../../../shared/__fixtures__/look-pack-v1/fixtures/moon.published.json'
import { decodeLookPack, type LookPackPublished } from '../../../shared/look-pack'
import { lookAssetUrl } from '../look/resolve-look'

import { resolveAppPanelLook } from './panel-look'

const decoded = decodeLookPack(moonLookFixture)!
const moon: LookPackPublished = { ...decoded, panel: { background: decoded.chat!.background, derived: decoded.derived } }

const withGrounds = (pack: LookPackPublished, light: string, dark: string | null): LookPackPublished => ({
  ...pack,
  panel: {
    derived: {},
    background: {
      light: { tone: 'light', base: light, layers: [] },
      dark: dark ? { tone: 'dark', base: dark, layers: [] } : null
    }
  },
  derived: {}
})

it('paints the declared panel ground, art and accent on the panel', () => {
  const look = resolveAppPanelLook({ look: moon }, 'light')
  const ground = moon.panel!.background!.light
  const layer = ground.layers[0]!

  expect(look.ground).toBe(ground)
  expect(look.tone).toBe(ground.tone)
  expect(look.style['--look-base']).toBe(ground.base)
  expect(look.style['--look-l1-image']).toBe(`url("${lookAssetUrl(layer.asset.variants.find(v => v.mime === 'image/svg+xml')!.sha256)}")`)
  expect(look.style['--look-l1-opacity']).toBe(layer.opacity)
  expect(look.style['--atum-ink']).toBe(moon.panel!.derived.light!.ink)
  expect(look.style['--look-tile']).toBeUndefined()
  expect(look.accent).toBe(moon.accent!.light)
  expect(look.style['--look-accent']).toBe(moon.accent!.light)
})

it('resolves from the pack alone: the same pack on any app, known or not, gives the same look', () => {
  for (const appearance of ['light', 'dark'] as const) {
    expect(resolveAppPanelLook({ look: moon }, appearance)).toEqual(
      resolveAppPanelLook({ look: { ...moon, name: { en: 'Brand new app' } } }, appearance)
    )
  }
})

it('follows the appearance: a declared dark ground and accent, else the light ones', () => {
  const both = withGrounds({ ...moon, accent: { light: '#112233', dark: '#445566' } }, '#F7EDE9', '#2A1F1D')

  expect(resolveAppPanelLook({ look: both }, 'light')).toMatchObject({ tone: 'light', accent: '#112233' })
  expect(resolveAppPanelLook({ look: both }, 'dark')).toMatchObject({ tone: 'dark', accent: '#445566' })
  expect(resolveAppPanelLook({ look: both }, 'dark').style['--look-base']).toBe('#2A1F1D')

  const lightOnly = withGrounds({ ...moon, accent: { light: '#112233', dark: null } }, '#F7EDE9', null)

  expect(resolveAppPanelLook({ look: lightOnly }, 'dark')).toMatchObject({ tone: 'light', accent: '#112233' })
  expect(resolveAppPanelLook({ look: lightOnly }, 'dark').style['--look-base']).toBe('#F7EDE9')
})

it('is the default Kit panel when the app declares no look, or a look without a ground', () => {
  for (const look of [undefined, null]) {
    expect(resolveAppPanelLook({ look }, 'light')).toEqual({ ground: null, tone: undefined, accent: null, style: {} })
  }

  const accentOnly = resolveAppPanelLook({ look: { ...moon, panel: null } }, 'light')

  expect(accentOnly.ground).toBeNull()
  expect(accentOnly.style['--look-base']).toBeUndefined()
  expect(accentOnly.style['--look-tile']).toBeUndefined()
  // Its one accent still dresses the panel's single primary action.
  expect(accentOnly.style['--look-accent']).toBe(moon.accent!.light)
})

it('never borrows chat art or contrast when the panel slot is absent', () => {
  const look = resolveAppPanelLook({ look: decoded }, 'light')
  expect(decoded.chat?.background?.light.layers.length).toBeGreaterThan(0)
  expect(look.ground).toBeNull()
  expect(look.style['--atum-ink']).toBeUndefined()
})

it('paints the declared panel background over chrome, and chrome only when no background is declared', () => {
  const pack = withGrounds(moon, '#EEEEEE', '#111111')
  pack.panel!.chrome = { light: { tone: 'light', base: '#FFFFFF', layers: [] }, dark: null }
  pack.panel!.page_base = { light: '#F7F6F2', dark: null }
  expect(resolveAppPanelLook({ look: pack }, 'light').style['--look-base']).toBe('#EEEEEE')
  expect(resolveAppPanelLook({ look: pack }, 'dark').style['--look-base']).toBe('#111111')

  const chromeOnly: LookPackPublished = { ...pack, panel: { ...pack.panel!, background: null } }
  for (const appearance of ['light', 'dark'] as const) {
    const look = resolveAppPanelLook({ look: chromeOnly }, appearance)
    expect(look.style['--look-base']).toBe('#FFFFFF')
    expect(look.style['--app-panel-page-base']).toBe('#F7F6F2')
    expect(look.style['--atum-ink']).toBe('#151515FF')
  }
  chromeOnly.panel!.chrome!.dark = { tone: 'dark', base: '#000000', layers: [] }
  expect(resolveAppPanelLook({ look: chromeOnly }, 'dark').style['--atum-ink']).toBe('#FFFFFFFF')
  delete chromeOnly.panel!.page_base
  expect(resolveAppPanelLook({ look: chromeOnly }, 'dark').style['--app-panel-page-base']).toBeUndefined()
  expect(resolveAppPanelLook({ look: chromeOnly }, 'light').style['--app-panel-page-base']).toBe('#FFFFFF')
})
it('uses the derived ramp of the selected ground only', () => {
  const pack = withGrounds(moon, '#EEEEEE', '#111111')
  pack.panel!.background = null
  pack.panel!.derived = { light: { ...decoded.derived.light!, ink: '#000000FF' } }
  pack.panel!.chrome = { light: { tone: 'light', base: '#FFFFFF', layers: [] }, dark: null }
  pack.panel!.chrome_derived = { light: decoded.derived.light }
  expect(resolveAppPanelLook({ look: pack }, 'dark').style['--atum-ink']).toBe(decoded.derived.light!.ink)
  expect(resolveAppPanelLook({ look: pack }, 'dark')).toEqual(
    resolveAppPanelLook({ look: { ...pack, name: { en: 'Unknown' } } }, 'dark')
  )
})

it('serves a light-tone ground as paper in both appearances when no dark variant is declared', () => {
  const pack = withGrounds(moon, '#F7F6F2', null)
  for (const appearance of ['light', 'dark'] as const) {
    expect(resolveAppPanelLook({ look: pack }, appearance)).toMatchObject({ tone: 'light', pageTone: 'light' })
    expect(resolveAppPanelLook({ look: pack }, appearance).style['--app-panel-page-base']).toBe('#F7F6F2')
  }
})

it('themes an open page by its page base, so host states stay legible on a paper page over a dark ground', () => {
  const pack = withGrounds(moon, '#FFFFFF', '#0E1D60')
  pack.panel!.page_base = { light: '#F7F6F2', dark: null }
  expect(resolveAppPanelLook({ look: pack }, 'dark')).toMatchObject({ tone: 'dark', pageTone: 'light' })
  pack.panel!.page_base = { light: '#F7F6F2', dark: '#111828' }
  expect(resolveAppPanelLook({ look: pack }, 'dark').pageTone).toBe('dark')
  delete pack.panel!.page_base
  // No page base and a dark ground: the content keeps the appearance's Kit card.
  expect(resolveAppPanelLook({ look: pack }, 'dark').pageTone).toBeUndefined()
  expect(resolveAppPanelLook({ look: pack }, 'light').pageTone).toBe('light')
})
