import { describe, expect, it } from 'vitest'

import { CONFIRMATION_DIALOG_MAX_CHARS, CONFIRMATION_MAX_CHARS, confirmationText, fitsConfirmation, fitsDialog, shortenForDisplay } from './write-preview'

const ch = (...codes: number[]) => String.fromCharCode(...codes)

// 2026-11-06 audit lead matrix-google-write-confirmation-unbounded-body-display.
describe('write confirmation text', () => {
  it('collapses a padded body so the tail is not pushed below the visible area', () => {
    const body = 'Thanks!' + '\n'.repeat(400) + 'MARKER-TAIL'
    const shown = confirmationText(body)

    expect(shown).toContain('MARKER-TAIL')
    expect(shown).toContain('⟦399 blank lines⟧')
    expect(shown.split('\n').length).toBeLessThan(6)
    expect(fitsConfirmation(body)).toBe(true)
  })

  it('treats lines of spaces and long space runs as padding, and shows what it collapsed', () => {
    const blank = ' '.repeat(50)
    const shown = confirmationText('Hello' + ' '.repeat(300) + 'there\n' + [blank, blank, blank, 'end'].join('\n'))

    expect(shown).toContain('⟦300 spaces⟧')
    expect(shown).not.toMatch(/ {8}/u)
    expect(shown).toContain('blank lines⟧')
    expect(shown).toContain('end')
  })

  it('makes characters the dialog does not draw visible', () => {
    const hidden = [0x202e, 0x200b, 0x2066, 0x2069, 0xfeff]
    const shown = confirmationText('pay' + ch(0x202e) + 'txt.exe' + ch(0x200b, 0x2066) + 'x' + ch(0x2069) + ' ' + ch(0xfeff))

    expect(shown).toContain('⟦U+202E⟧')
    expect(shown).toContain('⟦U+200B⟧')
    expect(shown).toContain('⟦U+2066⟧')
    expect(shown).toContain('⟦U+FEFF⟧')
    expect(hidden.some(code => shown.includes(ch(code)))).toBe(false)
  })

  it('leaves emoji joiner sequences and ordinary text alone', () => {
    const joiner = ch(0x200d)
    const text = 'Cảm ơn 👨' + joiner + '👩' + joiner + '👧 và 🏳' + ch(0xfe0f) + joiner + '🌈!\nDòng hai.\n\nDòng ba.'

    expect(confirmationText(text)).toBe(text)
  })

  it('shows a joiner that is not part of an emoji sequence', () => {
    expect(confirmationText('a' + ch(0x200d) + 'b')).toBe('a⟦U+200D⟧b')
  })

  it('refuses a body the owner could not read in full: 20,000 characters of text', () => {
    expect(fitsConfirmation('a'.repeat(20_000))).toBe(false)
    expect(fitsConfirmation('a'.repeat(CONFIRMATION_MAX_CHARS))).toBe(true)
    expect(fitsConfirmation('line\n'.repeat(80))).toBe(false)
  })

  it('shortens existing text for display with an explicit indicator', () => {
    const shown = shortenForDisplay('x'.repeat(20_000))

    expect(shown.length).toBeLessThan(1_700)
    expect(shown).toMatch(/⟦… 18500 more characters not shown⟧$/u)
    expect(shortenForDisplay('short')).toBe('short')
  })

  it('shortens existing text by lines as well as characters', () => {
    const shown = shortenForDisplay('q\n'.repeat(700))

    expect(shown.split('\n').length).toBeLessThanOrEqual(13)
    expect(shown).toMatch(/more characters not shown⟧$/u)
  })

  it('refuses an assembled dialog that is too long even when each part fits', () => {
    expect(fitsDialog('a\n'.repeat(40))).toBe(true)
    expect(fitsDialog('a\n'.repeat(120))).toBe(false)
    expect(fitsDialog('a'.repeat(CONFIRMATION_DIALOG_MAX_CHARS + 1))).toBe(false)
  })
})
