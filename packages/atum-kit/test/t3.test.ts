import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DARK_SELECTOR, generate, LIGHT_SELECTOR, PACKAGE, phoneTokens, readTokens } from '../scripts/build.mjs'
import { check, COMMIT, FILES, TAG } from '../scripts/sync-t3-design.mjs'
import { t3Geometry, t3RoleVariables, t3Theme } from '../scripts/t3-theme.mjs'

const HEX = /^#[0-9a-f]{6}$/
const rem = (value: string) => (value.endsWith('rem') ? Number.parseFloat(value) * 16 : Number.parseFloat(value))

const declarations = (css: string, selector: string, from = 0) => {
  const start = css.indexOf(`\n${selector} {`, from)
  expect(start, `missing block ${selector}`).toBeGreaterThanOrEqual(0)

  return {
    end: css.indexOf('}', start),
    values: Object.fromEntries(
      [...css.slice(start, css.indexOf('}', start)).matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [
        name,
        value.trim()
      ])
    )
  }
}

describe('the T3 base (pingdotgg/t3code v0.1.11, vendored)', () => {
  it('holds exactly the pinned upstream files, byte for byte', async () => {
    const pin = JSON.parse(readFileSync(join(PACKAGE, 't3/PIN.json'), 'utf8'))

    expect(pin).toMatchObject({ repository: 'pingdotgg/t3code', tag: TAG, commit: COMMIT, license: 'MIT' })
    expect(Object.keys(pin.files).sort()).toEqual([...FILES].sort())
    await expect(check()).resolves.toBeUndefined()
  })

  it("declares every T3 colour role, in both appearances, under T3's own variable names", async () => {
    const roles = await t3RoleVariables()
    const css = (await generate())['atum-kit.css']
    const theme = t3Theme(await readTokens())
    const light = declarations(css, LIGHT_SELECTOR, css.indexOf('T3 base'))
    const dark = declarations(css, DARK_SELECTOR, light.end)

    expect(Object.keys(theme.colors).sort()).toEqual(Object.keys(roles).sort())

    for (const [role, name] of Object.entries(roles)) {
      expect(light.values[name], name).toBe(theme.colors[role as keyof typeof theme.colors])
      expect(dark.values[name], name).toBe(theme.variants.dark[role as keyof typeof theme.colors])
    }
  })

  it('is one opaque palette with ink as the accent, the file Work installs', async () => {
    const files = await generate()
    const theme = JSON.parse(files['atum-t3-theme.json'])

    expect(Object.keys(theme)).toEqual(['version', 'name', 'appearance', 'colors', 'variants'])
    expect(theme).not.toHaveProperty('css')

    for (const colors of [theme.colors, theme.variants.dark]) {
      expect(Object.values(colors).every(value => HEX.test(String(value)))).toBe(true)
      expect(colors.accent).toBe(colors.text)
      expect(colors.messageAction).toBe(colors.text)
    }
  })

  it("gives Kit controls T3's control radius and carries T3's glass values", async () => {
    const geometry = await t3Geometry()
    const tokens = await readTokens()

    expect(rem(geometry.light['control-radius'])).toBe(tokens.radius.sm)
    expect(geometry.light).toHaveProperty('glass-blur')
    expect(geometry.dark).toHaveProperty('glass-blur')
  })

  it('sets desktop UI text at 14px while chat and the phone keep their type', async () => {
    const tokens = await readTokens()
    const css = (await generate())['atum-kit.css']

    expect(css).toMatch(/--ak-t-body: 400 14px\/20px/)
    expect(css).toMatch(/--ak-t-chat: 400 15px\/23px/)
    expect(phoneTokens(tokens).type).toEqual(tokens.type)
    expect(tokens.desktop.type.body.lineHeight / tokens.desktop.type.body.size).toBeGreaterThanOrEqual(
      tokens.type.body.lineHeight / tokens.type.body.size
    )
  })
})
