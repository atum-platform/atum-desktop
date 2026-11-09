import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('keyboard focus contract', () => {
  const css = readFileSync(resolve(__dirname, 'styles.css'), 'utf8')

  it('keeps a designed focus-visible outline and never globally suppresses it', () => {
    expect(css).toContain('--ui-focus-ring:')
    expect(css).toMatch(/\*:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--ui-focus-ring\)/su)
    expect(css).not.toMatch(/\*:focus-visible\s*\{[^}]*outline:\s*none/su)
  })

  it('lets the composer keep its border-owned focus treatment', () => {
    expect(css).toMatch(/\[data-slot='composer-rich-input'\]:focus-visible,[\s\S]*?outline:\s*none;/u)
  })
})
