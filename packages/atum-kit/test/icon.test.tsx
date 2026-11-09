import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AkIcon, akIconPaths } from '../src/icon'

const require = createRequire(import.meta.url)
const coreSvg = (path: string) => readFileSync(require.resolve(`@phosphor-icons/core/${path}`), 'utf8')

describe('AkIcon', () => {
  it('renders the pinned Phosphor Light path in currentColor at the kit size', () => {
    const markup = renderToStaticMarkup(<AkIcon name="compass" />)
    expect(markup).toContain('class="ak-icon"')
    expect(markup).toContain('fill="currentColor"')
    expect(markup).toContain('aria-hidden="true"')

    for (const d of akIconPaths('compass')) {
      expect(coreSvg('light/compass-light.svg')).toContain(`d="${d}"`)
    }
  })

  it('renders Fill, a size modifier and an accessible name', () => {
    const markup = renderToStaticMarkup(
      <AkIcon className="x" label="Discover" name="storefront" size="lg" weight="fill" />
    )

    expect(markup).toContain('class="ak-icon ak-icon--lg x"')
    expect(markup).toContain('role="img"')
    expect(markup).toContain('aria-label="Discover"')
    expect(markup).not.toContain('aria-hidden')

    for (const d of akIconPaths('storefront', 'fill')) {
      expect(coreSvg('fill/storefront-fill.svg')).toContain(`d="${d}"`)
    }
  })
})
