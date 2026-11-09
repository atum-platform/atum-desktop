import { describe, expect, it } from 'vitest'

import { DESKTOP_LOCALES } from './desktop-locale'
import { matrixAcknowledgementCopy, matrixProgressCopy, matrixToolActivityCopy } from './matrix-status-line-copy'
import {
  macOwnerFacts,
  MATRIX_NARRATION_DISPLAY,
  MATRIX_TURN_CONTEXT_HEADER,
  MATRIX_TURN_STYLE,
  matrixTurnStyledPrompt
} from './matrix-turn-style'

describe('the turn style both the cloud and a Mac ask the agent for', () => {
  it('is one line that asks for a first sentence before the first tool call, then progress, then the answer', () => {
    expect(MATRIX_TURN_STYLE).not.toContain('\n')
    expect(MATRIX_TURN_STYLE.startsWith('style: ')).toBe(true)
    expect(MATRIX_TURN_STYLE).toMatch(/before your first tool call/)
    expect(MATRIX_TURN_STYLE).toMatch(/progress sentence/)
    expect(MATRIX_TURN_STYLE).toMatch(/full answer/)
  })

  it('goes after the words and anything attached, under the cloud’s own header, never before the person’s words', () => {
    const prompt = 'Tóm tắt video này\n\n@file:report.txt'
    const styled = matrixTurnStyledPrompt(prompt, 48_000)

    expect(styled).toBe(`${prompt}\n\n${MATRIX_TURN_CONTEXT_HEADER}\n${MATRIX_TURN_STYLE}`)
    expect(styled.startsWith(prompt)).toBe(true)
  })

  it('appends only the Mac’s own zone, clearly labelled, never before the person’s words', () => {
    const prompt = 'Plan my afternoon'
    const styled = matrixTurnStyledPrompt(prompt, 48_000, { timeZone: 'Asia/Ho_Chi_Minh' })

    expect(styled).toBe(`${prompt}\n\n${MATRIX_TURN_CONTEXT_HEADER}\n${MATRIX_TURN_STYLE}`
      + '\ntime zone: Asia/Ho_Chi_Minh (from this Mac)')
    expect(styled.startsWith(prompt)).toBe(true)
    // A Mac never presents a locale region as a place, and no fact changes the prompt.
    expect(styled).not.toContain('location:')
    expect(matrixTurnStyledPrompt(prompt, 48_000, {})).toBe(matrixTurnStyledPrompt(prompt, 48_000))
    // The fact line is dropped with the style when the prompt has no room, never cut.
    expect(matrixTurnStyledPrompt(prompt, prompt.length + 1, { timeZone: 'Asia/Ho_Chi_Minh' })).toBe(prompt)
  })

  it('derives the Mac fact from the system zone only, and refuses a non-IANA zone', () => {
    expect(macOwnerFacts({ timeZone: 'Asia/Ho_Chi_Minh' })).toEqual({ timeZone: 'Asia/Ho_Chi_Minh' })
    expect(macOwnerFacts({ timeZone: '+07:00' })).toEqual({})
    expect(macOwnerFacts({ timeZone: 'Asia/Tokyo' })).toHaveProperty('timeZone', 'Asia/Tokyo')
    expect(macOwnerFacts()).toEqual(expect.objectContaining({}))
    // The process locale's region, whatever it is, can never become a Mac location.
    expect(macOwnerFacts()).not.toHaveProperty('location')
  })

  it('is added only when the whole prompt still fits, and a prompt that leaves no room keeps its words uncut', () => {
    const room = `\n\n${MATRIX_TURN_CONTEXT_HEADER}\n${MATRIX_TURN_STYLE}`.length
    const fits = 'x'.repeat(100)

    expect(matrixTurnStyledPrompt(fits, fits.length + room)).toBe(
      `${fits}${`\n\n${MATRIX_TURN_CONTEXT_HEADER}\n${MATRIX_TURN_STYLE}`}`
    )
    expect(matrixTurnStyledPrompt(fits, fits.length + room - 1)).toBe(fits)
    expect(matrixTurnStyledPrompt(fits, 10)).toBe(fits)
  })
})

describe('the settings that carry the agent’s words to the owner', () => {
  it('keep tool events and remarks on', () => {
    expect(MATRIX_NARRATION_DISPLAY.tool_progress).not.toBe('off')
    expect(MATRIX_NARRATION_DISPLAY.interim_assistant_messages).toBe(true)
    expect(MATRIX_NARRATION_DISPLAY.show_commentary).toBe(true)
  })
})

describe('the acknowledgement copy', () => {
  const emoji = /\p{Extended_Pictographic}/u

  it('exists for exactly the locales the rest of the progress copy speaks', () => {
    expect(Object.keys(matrixAcknowledgementCopy).sort()).toEqual([...DESKTOP_LOCALES].sort())
    expect(Object.keys(matrixAcknowledgementCopy).sort()).toEqual(Object.keys(matrixProgressCopy).sort())
    expect(Object.keys(matrixAcknowledgementCopy).sort()).toEqual(Object.keys(matrixToolActivityCopy).sort())
  })

  it('is a few short, distinct, plain lines per locale: no emoji, no placeholders, nothing from the turn', () => {
    for (const [locale, lines] of Object.entries(matrixAcknowledgementCopy)) {
      expect(lines.length, locale).toBeGreaterThanOrEqual(1)
      expect(new Set(lines).size, locale).toBe(lines.length)

      for (const line of lines) {
        expect(line.trim(), locale).toBe(line)
        expect(line, locale).not.toBe('')
        expect([...line].length, locale).toBeLessThanOrEqual(60)
        expect(line, locale).not.toMatch(/[\r\n]/)
        expect(line, locale).not.toMatch(emoji)
        expect(line, locale).not.toMatch(/[${}<>[\]\\/@]|\d/)
      }
    }
  })
})
