import { expect, it, vi } from 'vitest'

import badGlyph from './__fixtures__/app-panel-v1/bad-glyph.json'
import composerOnly from './__fixtures__/app-panel-v1/composer-only-route.json'
import badDefault from './__fixtures__/app-panel-v1/default-not-in-pages.json'
import duplicate from './__fixtures__/app-panel-v1/duplicate.json'
import unknown from './__fixtures__/app-panel-v1/unknown-route.json'
import valid from './__fixtures__/app-panel-v1/valid.json'
import { decodeAppPanel } from './app-panel'
import type { AppManifestRoute } from './app-view/protocol'

const routes: AppManifestRoute[] = ['library', 'readings', 'top-up'].map(id => ({
  id,
  label: { en: id, vi: id },
  icon: 'book',
  path: `/${id}`,
  placements: id === 'top-up' ? ['composer'] : ['menu'],
  session: 'none'
}))
it('preserves the platform declaration order, default, glyphs and localized tag', () => {
  expect(decodeAppPanel(valid, routes)).toEqual({
    defaultPage: 'library',
    pages: [
      { routeId: 'library', glyph: 'article' },
      { routeId: 'readings', glyph: 'yin-yang', tag: { en: 'Beta', vi: 'Beta' } }
    ]
  })
})
it.each([unknown, composerOnly, duplicate, badDefault, badGlyph])(
  'ignores and logs an invalid platform fixture',
  fixture => {
    const log = vi.fn()
    expect(decodeAppPanel(fixture, routes, null, log)).toBeNull()
    expect(log).toHaveBeenCalledExactlyOnceWith('app_panel ignored reason=invalid')
  }
)
it('rejects a chat default, and silently accepts an absent optional block', () => {
  const log = vi.fn()
  expect(decodeAppPanel(valid, routes, 'library', log)).toBeNull()
  expect(decodeAppPanel(undefined, routes, null, log)).toBeNull()
  expect(log).toHaveBeenCalledTimes(1)
})
