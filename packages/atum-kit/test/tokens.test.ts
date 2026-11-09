import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DARK_SELECTOR, generate, LIGHT_SELECTOR, OUTPUT, PACKAGE, produce, SCALE_SELECTOR } from '../scripts/build.mjs'

// The stylesheet the owner approved for Atum Kit 0.1, kept verbatim. What they saw is what ships:
// every generated --ak-* value must equal this file's, block by block.
const approved = readFileSync(join(PACKAGE, 'approved-0.1.css'), 'utf8')
const APPROVED = { light: ':root, .ak-light', dark: '.ak-dark', scale: ':root, .ak-light, .ak-dark' }

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

function block(css: string, selector: string) {
  const source = stripComments(css)
  const start = source.indexOf(`\n${selector} {`)
  expect(start, `missing block ${selector}`).toBeGreaterThanOrEqual(0)
  const body = source.slice(source.indexOf('{', start) + 1, source.indexOf('}', start))

  return body
}

const tokens = (body: string) =>
  Object.fromEntries(
    [...body.matchAll(/(--ak-[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim().replace(/\s+/g, ' ')])
  )

describe('generated tokens equal the approved Atum Kit 0.1 values', async () => {
  const files = await generate()
  const css = files['atum-kit.css']

  it.each([
    ['light', LIGHT_SELECTOR, APPROVED.light],
    ['dark', DARK_SELECTOR, APPROVED.dark],
    ['scale', SCALE_SELECTOR, APPROVED.scale]
  ])('%s block', (_name, generatedSelector, approvedSelector) => {
    const expected = tokens(block(`\n${approved}`, approvedSelector))
    expect(Object.keys(expected).length).toBeGreaterThan(10)
    expect(tokens(block(css, generatedSelector))).toEqual(expected)
  })

  it('declares no --ak-* token outside the generated blocks', () => {
    const declared = [...stripComments(css).matchAll(/(--ak-[\w-]+)\s*:/g)].length
    const approvedDeclared = [...stripComments(approved).matchAll(/(--ak-[\w-]+)\s*:/g)].length
    expect(declared).toBe(approvedDeclared)
  })

  it('resolves every var(--ak-*) a component uses', () => {
    const defined = new Set([...stripComments(css).matchAll(/(--ak-[\w-]+)\s*:/g)].map(match => match[1]))
    const used = new Set([...css.matchAll(/var\((--ak-[\w-]+)\)/g)].map(match => match[1]))
    expect([...used].filter(name => !defined.has(name))).toEqual([])
  })

  it('ships the approved component rules, plus the desktop .dark scope on its two dark-only rules', () => {
    const components = readFileSync(join(PACKAGE, 'components.css'), 'utf8')
    const rules = components.slice(components.indexOf('*/\n') + 3).replace(/^\n/, '')
    const unscoped = rules.replace(', .dark .ak-switch.is-on::after', '').replace(', .dark .ak-seg > .is-selected', '')
    const approvedRules = approved.slice(approved.indexOf('.ak-light, .ak-dark { color'))
    expect(unscoped).toBe(approvedRules)
  })

  it('scopes dark to the desktop .dark root and never sets color-scheme on bare :root', () => {
    expect(DARK_SELECTOR.split(',').map(part => part.trim())).toEqual(['.ak-dark', '.dark'])

    for (const selector of [LIGHT_SELECTOR, DARK_SELECTOR, SCALE_SELECTOR]) {
      expect(block(css, selector)).not.toMatch(/color-scheme/)
    }

    expect(css).toMatch(/^\.ak-light \{ color-scheme: light; \}$/m)
    expect(css).toMatch(/^\.ak-dark \{ color-scheme: dark; \}$/m)
    expect(css).not.toMatch(/(^|,\s*)(:root|\.dark)\s*(,[^{]*)?\{[^}]*color-scheme/m)
  })

  it('keeps every class ak- prefixed so loading the kit changes no existing surface', () => {
    const classes = new Set(
      [
        ...stripComments(css)
          .replace(/url\("[^"]*"\)/g, '')
          .matchAll(/\.(-?[a-z][\w-]*)/gi)
      ].map(match => match[1])
    )

    const foreign = [...classes].filter(
      name =>
        !name.startsWith('ak-') &&
        !['is-hover', 'is-press', 'is-on', 'is-selected', 'is-disabled', 'is-focus', 'dark'].includes(name)
    )

    expect(foreign).toEqual([])
  })

  it('has a committed dist/ that matches a fresh generation', async () => {
    await expect(produce({ check: true, output: OUTPUT })).resolves.toBeTruthy()
  })
})

describe('phone token projection', async () => {
  const phone = JSON.parse((await generate())['atum-kit-tokens.json'])

  it('converts light and dark colours to sRGB channels', () => {
    expect(phone.light.ink).toEqual({ red: 0x1b / 255, green: 0x1d / 255, blue: 0x22 / 255, alpha: 1 })
    expect(phone.dark['fill-quiet']).toEqual({ red: 1, green: 1, blue: 1, alpha: 0.065 })
    expect(Object.keys(phone.light).sort()).toEqual(Object.keys(phone.dark).sort())
    expect(phone.light).toHaveProperty('panel-rim')
  })

  it('structures shadows and the monogram gradient', () => {
    expect(phone.shadows.light['shadow-2'][0]).toMatchObject({ x: 0, y: 12, blur: 32, spread: -10 })
    expect(phone.shadows.dark['shadow-1'][0]).toMatchObject({ spread: 0.5 })
    expect(phone.gradients.dark.monogram.stops.map((stop: { location: number }) => stop.location)).toEqual([0, 1])
  })

  it('carries the scales and the phone deltas', () => {
    expect(phone.type.display).toEqual({ family: 'display', lineHeight: 32, size: 26, weight: 600 })
    expect(phone.radius.lg).toBe(14)
    expect(phone.phone.controlHeight).toEqual({ primary: 50, regular: 44 })
  })
})
