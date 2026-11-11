import { describe, expect, it } from 'vitest'

import { generate, readTokens } from '../scripts/build.mjs'

// Contracts for the chat components STYLE.md §10 describes (file cards, Atum's own line).
// They read the generated stylesheet that ships, never a call site.

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Every declaration of the rules whose selector list mentions `prefix`, in source order. */
function declarations(css: string, prefix: string) {
  const out: Array<{ selector: string; property: string; value: string }> = []

  for (const [, selector, body] of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selector.split(',').some(part => part.trim().startsWith(prefix))) {
      continue
    }

    for (const [, property, value] of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
      out.push({ selector: selector.trim(), property, value: value.trim() })
    }
  }

  return out
}

describe('chat components take every value from the kit', async () => {
  const css = (await generate())['atum-kit.css']
  const tokens = await readTokens()

  for (const prefix of ['.ak-file', '.ak-chat-note']) {
    describe(prefix, () => {
      const rules = declarations(css, prefix)

      it('exists in the shipped stylesheet', () => {
        expect(rules.length).toBeGreaterThan(0)
      })

      it('uses no raw colour: every colour is a token', () => {
        const raw = rules.filter(({ value }) => /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(value))
        expect(raw).toEqual([])
      })

      it('sets type only through a type role', () => {
        const fonts = rules.filter(({ property }) => property === 'font')
        expect(fonts.length).toBeGreaterThan(0)
        expect(fonts.filter(({ value }) => !/^var\(--ak-t-[\w-]+\)$/.test(value))).toEqual([])
        expect(rules.filter(({ property }) => ['font-size', 'font-weight', 'line-height'].includes(property))).toEqual(
          []
        )
      })

      it('rounds only from the radius scale', () => {
        const radii = rules.filter(({ property }) => property === 'border-radius')
        expect(radii.filter(({ value }) => !/^var\(--ak-r-[\w-]+\)$/.test(value))).toEqual([])
      })

      it('never reads as an error or a warning', () => {
        expect(rules.filter(({ value }) => /--ak-(danger|warn|ok)/.test(value))).toEqual([])
      })

      it('never sets text in the icon-only ink', () => {
        const textInk4 = rules.filter(
          ({ selector, property, value }) =>
            property === 'color' && value === 'var(--ak-ink-4)' && !/tile/.test(selector)
        )

        expect(textInk4).toEqual([])
      })
    })
  }

  it('keeps the file tile concentric with the card: card radius - padding = tile radius', () => {
    const card = declarations(css, '.ak-file').filter(({ selector }) => selector === '.ak-file')
    const padding = card.find(({ property }) => property === 'padding')?.value.split(/\s+/)
    const cardRadius = card.find(({ property }) => property === 'border-radius')?.value

    const tileRadius = declarations(css, '.ak-file-tile').find(
      ({ selector, property }) => selector === '.ak-file-tile' && property === 'border-radius'
    )?.value

    const radius = (value?: string) => tokens.radius[value?.match(/^var\(--ak-r-([\w-]+)\)$/)?.[1] ?? '']
    const [top, , bottom, left] = (padding ?? []).map(part => Number.parseFloat(part))

    expect(top).toBe(bottom)
    expect(top).toBe(left)
    expect(radius(cardRadius) - top).toBe(radius(tileRadius))
  })

  it('gives the file card the keyboard-only kit focus ring', () => {
    const focus = declarations(css, '.ak-file:focus-visible')
    expect(focus).toContainEqual(expect.objectContaining({ property: 'outline', value: '3px solid var(--ak-focus)' }))

    const pointerFocus = declarations(css, '.ak-file:focus').filter(({ selector }) =>
      selector.split(',').some(part => part.trim() === '.ak-file:focus')
    )

    expect(pointerFocus).toEqual([])
  })
})
