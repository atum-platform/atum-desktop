import { expect, it } from 'vitest'

import names from '../../../../packages/atum-kit/icons.json'
import { akIconPaths } from '../../../../packages/atum-kit/src/icon'

import { APP_SURFACE_ALIASES, appSurfaceGlyph, appSurfaceIcon } from './atum-app-surface-icons'

it('resolves every legacy alias to a Kit icon in Light and Fill', () => {
  for (const alias of Object.keys(APP_SURFACE_ALIASES)) {
    const name = appSurfaceGlyph(alias) as Parameters<typeof akIconPaths>[0]
    expect(names.names).toContain(name)
    expect(akIconPaths(name, 'light').length).toBeGreaterThan(0)
    expect(akIconPaths(name, 'fill').length).toBeGreaterThan(0)
  }
})
it('accepts every curated name directly, with a stable component and generic fallback', () => {
  for (const name of names.names) {
    expect(appSurfaceGlyph(name)).toBe(name)
    expect(appSurfaceIcon(name)).toBe(appSurfaceIcon(name))
  }

  expect(appSurfaceGlyph('unknown-glyph')).toBe('app-window')
})
