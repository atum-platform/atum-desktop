import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('single rail capability contract', () => {
  it('keeps every core destination and separates action/platform semantics', () => {
    const source = readFileSync(resolve(__dirname, 'index.tsx'), 'utf8')

    expect(source).toContain("id: 'new-session'")
    expect(source).toContain('name="add"')
    expect(source).toContain('route: SKILLS_ROUTE')
    expect(source).toContain('route: MESSAGING_ROUTE')
    expect(source).toContain('name="radio-tower"')
    expect(source).toContain('route: ARTIFACTS_ROUTE')
    expect(source).toContain('...contributedNav')
  })

  it('mounts profile functionality once, before navigation, with no footer strip', () => {
    const source = readFileSync(resolve(__dirname, 'index.tsx'), 'utf8')
    const mounts = source.match(/<ProfileRail\s*\/>/gu) ?? []

    expect(mounts).toHaveLength(1)
    expect(source.indexOf('<ProfileRail />')).toBeLessThan(source.indexOf('<SidebarMenu className="gap-px">'))
  })
})
