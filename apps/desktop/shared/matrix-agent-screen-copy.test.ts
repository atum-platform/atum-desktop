import { describe, expect, it } from 'vitest'

import { DESKTOP_LOCALES } from './desktop-locale'
import { matrixAgentScreenText } from './matrix-agent-screen-copy'

function strings(locale: (typeof DESKTOP_LOCALES)[number]): string[] {
  const copy = matrixAgentScreenText(locale)

  return Object.values(copy).map(value => (typeof value === 'function' ? value('Luna') : value))
}

describe('agent screen copy', () => {
  it('says every line in every locale', () => {
    const keys = Object.keys(matrixAgentScreenText('en')).sort()

    for (const locale of DESKTOP_LOCALES) {
      expect(Object.keys(matrixAgentScreenText(locale)).sort()).toEqual(keys)

      for (const line of strings(locale)) {
        expect(line.trim()).not.toBe('')
      }
    }
  })

  it('names the agent and stays in the app’s voice', () => {
    for (const locale of DESKTOP_LOCALES) {
      const copy = matrixAgentScreenText(locale)

      for (const line of [copy.agentUsing('Luna'), copy.watchLine('Luna'), copy.controlLine('Luna'), copy.idle('Luna')]) {
        expect(line).toContain('Luna')
      }

      for (const line of strings(locale)) {
        // No vendor or engine names and no jargon on a person's screen (STYLE.md §1, §15).
        expect(line).not.toMatch(/\b(T3|Hermes|Nous|VNC|RFB|lease|ticket|token)\b/iu)
        expect(line).not.toMatch(/[!！]/u)
      }
    }

    expect(strings('en').join(' ')).not.toMatch(/\bplease\b/iu)
  })

  it('keeps the one line under the screen to one short line', () => {
    for (const locale of DESKTOP_LOCALES) {
      const copy = matrixAgentScreenText(locale)

      for (const line of [copy.watchLine('Luna'), copy.controlLine('Luna'), copy.handBackForceHint, copy.controlMoved]) {
        expect([...line].length).toBeLessThanOrEqual(80)
      }
    }
  })
})
