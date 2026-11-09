/**
 * What the owner sees in the native "Send this email?" / "Save this event?" dialog is the only
 * approval of an assistant-authored write, so the dialog text must be the whole message, readable.
 * The assistant's text is untrusted: it can pad with blank lines so the real tail falls below the
 * visible area, or hide characters (bidi overrides, zero-width) that the dialog does not draw.
 *
 * `confirmationText` makes those visible and collapses padding. `fitsConfirmation` says whether the
 * result is short enough to read in full; a write that does not fit is refused rather than sent
 * partly unseen. Read-only existing text (a calendar event's current notes) is shortened for
 * display with `shortenForDisplay` because it is not being sent.
 *
 * The character classes are built from code points on purpose: a source file that contains the
 * invisible characters themselves is as unreviewable as the text it guards against.
 */

export const CONFIRMATION_MAX_CHARS = 4_000
export const CONFIRMATION_MAX_LINES = 60
const DISPLAY_EXISTING_MAX_CHARS = 1_500
const DISPLAY_EXISTING_MAX_LINES = 12
/** The whole dialog (headers, recipients, the current event, every field), not one field. */
export const CONFIRMATION_DIALOG_MAX_CHARS = 8_000
export const CONFIRMATION_DIALOG_MAX_LINES = 100

type Range = number | readonly [number, number]

function escape(code: number): string {
  return '\\' + 'u' + code.toString(16).padStart(4, '0')
}

function characterClass(ranges: readonly Range[]): string {
  return ranges.map(range => (typeof range === 'number' ? escape(range) : `${escape(range[0])}-${escape(range[1])}`)).join('')
}

const LINE_SEPARATORS = new RegExp(`[${characterClass([0x2028, 0x2029, 0x85])}]`, 'gu')
const SPACES = characterClass([0x20, 0x09, 0xa0, 0x1680, [0x2000, 0x200a], 0x202f, 0x205f, 0x3000])
const TRAILING_SPACES = new RegExp(`[${SPACES}]+$`, 'gmu')
const SPACE_RUN = new RegExp(`[${SPACES}]{8,}`, 'gu')

// Zero width space/non-joiner/word joiner/BOM, soft hyphen, Mongolian vowel separator, bidi marks,
// embeddings, overrides and isolates, and the Arabic letter mark. U+200D (joiner) is handled
// separately because emoji sequences need it.
const HIDDEN = new RegExp(
  `[${characterClass([0x200b, 0x200c, 0x2060, 0xfeff, 0x61c, 0x200e, 0x200f, [0x202a, 0x202e], [0x2066, 0x2069], 0xad, 0x180e])}]`,
  'gu'
)

const JOINER = escape(0x200d)
const VARIATION = escape(0xfe0f)
const STRAY_JOINER = new RegExp(`(?<!\\p{Extended_Pictographic}${VARIATION}?)${JOINER}|${JOINER}(?!\\p{Extended_Pictographic})`, 'gu')

function marker(char: string): string {
  return `⟦U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟧`
}

/** Hidden characters shown as ⟦U+XXXX⟧; padding runs collapsed to a labelled marker. */
export function confirmationText(value: string): string {
  return value
    .replace(LINE_SEPARATORS, '\n')
    .replace(/\r\n?/gu, '\n')
    .replace(HIDDEN, marker)
    .replace(STRAY_JOINER, marker)
    // A line of only spaces is a blank line; trailing spaces are padding.
    .replace(TRAILING_SPACES, '')
    .replace(/\n{3,}/gu, run => `\n⟦${run.length - 1} blank lines⟧\n`)
    .replace(SPACE_RUN, run => `⟦${run.length} spaces⟧`)
}

/** True when the owner can read all of `value` in the dialog. */
export function fitsConfirmation(value: string): boolean {
  const shown = confirmationText(value)

  return shown.length <= CONFIRMATION_MAX_CHARS && shown.split('\n').length <= CONFIRMATION_MAX_LINES
}

/** True when the whole assembled dialog text can be read at once. Checked on the final string, so a
 * sum of fields that each fit still cannot push the part the owner is approving out of view. */
export function fitsDialog(detail: string): boolean {
  return detail.length <= CONFIRMATION_DIALOG_MAX_CHARS && detail.split('\n').length <= CONFIRMATION_DIALOG_MAX_LINES
}

/** Existing (not sent) text, bounded by characters and by lines, with an explicit indicator. */
export function shortenForDisplay(value: string, limit = DISPLAY_EXISTING_MAX_CHARS, lineLimit = DISPLAY_EXISTING_MAX_LINES): string {
  const shown = confirmationText(value)
  const lines = shown.split('\n')

  if (shown.length <= limit && lines.length <= lineLimit) {
    return shown
  }

  const byLines = lines.slice(0, lineLimit).join('\n')
  const cut = [...byLines].slice(0, limit).join('')

  return `${cut}\n⟦… ${shown.length - cut.length} more characters not shown⟧`
}
