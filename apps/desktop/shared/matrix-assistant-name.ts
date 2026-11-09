/** Preserve user-visible identity, state and recovery behavior across connection changes. */

/**
 * ── OWNER DECISION D1: THE ONE SWITCH (answered 2026-10-05: the main assistant is renameable) ──
 *
 * `false` (shipped): the primary is renamed like any other assistant. It may keep or go back
 * to "Atum", which no other assistant may use; its face stays the Atum mark until a photo is
 * chosen; its built-in persona carries its current name and still takes another one when
 * asked in chat (electron/matrix/atum-soul.ts). The platform copies the primary's name into
 * `handles.assistant_name` (P5 in the session log).
 *
 * `true`: the primary is always "Atum": static name with a tip, no "Đổi tên…", native refuses
 * a rename with `locked`, and its built-in persona says its name stays Atum.
 *
 * Every behaviour above reads this constant through `isAssistantNameLocked`; nothing else
 * decides it.
 */
export const PRIMARY_ASSISTANT_KEEPS_NAME: boolean = false

/** Whether this assistant's name can be changed at all (D1: the primary's, when locked). */
export function isAssistantNameLocked(agent: { isDefault: boolean }): boolean {
  return agent.isDefault && PRIMARY_ASSISTANT_KEEPS_NAME
}

/** The platform's limit (`char_length(btrim(display_name)) between 1 and 40`), in code points
 * of the stored (normalized) name. */
export const ASSISTANT_NAME_MAX = 40

/** Names kept for Atum's own assistants and staff. The whole keys `atum` and `atumbot`
 * are allowed for the primary assistant only. Compared whole, accents kept
 * (`assistantNameKey`): "Bến" is not Ben. */
export const ASSISTANT_RESERVED_NAMES = [
  'atum',
  'moon',
  'ben',
  'andy',
  'taylor',
  'admin',
  'founder',
  'support'
] as const

/** Names also refused through the skeleton (accents, case, spacing and look-alike shapes
 * ignored), as any word of a longer name too. "ben" is left out on purpose: "Bến" is an
 * ordinary Vietnamese name. */
export const ASSISTANT_FOLD_RESERVED_NAMES = ['atum', 'moon', 'andy', 'taylor', 'admin', 'founder', 'support'] as const

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export const ASSISTANT_RESERVED_PERSON_NAMES = ['moon', 'ben', 'andy', 'taylor'] as const

/** No name may start with this (skeleton), nor any of its words: "Atum Support", "AtumBot",
 * "A.T.U.M Team". The primary-only whole-key exceptions are applied before this rule. */
export const ASSISTANT_RESERVED_PREFIX = 'atum'

/** An inclusive range of code points. */
export type AssistantNameRange = readonly [number, number]

/**
 * The letters a name may use, by script (inclusive code point ranges, Unicode 16; the platform
 * mirrors them as regex classes).
 *
 * - `latin`: ASCII letters, every precomposed Latin letter whose canonical decomposition is an
 *   ASCII letter and accents (all of Vietnamese, French, German, Spanish, Polish…; after NFC
 *   no loose accent is left), and the few letters of real languages that do not decompose
 *   (`ASSISTANT_NAME_SKELETON_LETTERS`: đ, ß, æ, ø, œ, ł, ı). Letters that only resemble
 *   Latin ones — IPA, small capitals, other stroked, barred or click letters (ɑ ᴀ Ⱥ ǀ ʟ…) —
 *   are not in it.
 * - `han`: the Unified Ideographs and 々 (not 〇, which draws as O).
 * - `kana`: Hiragana and Katakana letters, their iteration marks and ー.
 * - `hangul`: the precomposed syllables only, never loose jamo (ㅇ draws as O, ㄴ as L).
 */
export const ASSISTANT_NAME_LETTERS = {
  latin: [
    [0x41, 0x5a],
    [0x61, 0x7a],
    [0xc0, 0xcf],
    [0xd1, 0xd6],
    [0xd8, 0xdd],
    [0xdf, 0xef],
    [0xf1, 0xf6],
    [0xf8, 0xfd],
    [0xff, 0x125],
    [0x128, 0x131],
    [0x134, 0x137],
    [0x139, 0x13e],
    [0x141, 0x148],
    [0x14c, 0x165],
    [0x168, 0x17e],
    [0x1a0, 0x1a1],
    [0x1af, 0x1b0],
    [0x1cd, 0x1dc],
    [0x1de, 0x1e1],
    [0x1e6, 0x1ed],
    [0x1f0, 0x1f0],
    [0x1f4, 0x1f5],
    [0x1f8, 0x1fb],
    [0x200, 0x21b],
    [0x21e, 0x21f],
    [0x226, 0x233],
    [0x1e00, 0x1e99],
    [0x1e9e, 0x1e9e],
    [0x1ea0, 0x1ef9]
  ],
  han: [
    [0x3005, 0x3005],
    [0x3400, 0x4dbf],
    [0x4e00, 0x9fff],
    [0xfa0e, 0xfa0f],
    [0xfa11, 0xfa11],
    [0xfa13, 0xfa14],
    [0xfa1f, 0xfa1f],
    [0xfa21, 0xfa21],
    [0xfa23, 0xfa24],
    [0xfa27, 0xfa29],
    [0x20000, 0x2a6df],
    [0x2a700, 0x2b739],
    [0x2b740, 0x2b81d],
    [0x2b820, 0x2cea1],
    [0x2ceb0, 0x2ebe0],
    [0x2ebf0, 0x2ee5d],
    [0x30000, 0x3134a],
    [0x31350, 0x323af]
  ],
  kana: [
    [0x3041, 0x3096],
    [0x309d, 0x309e],
    [0x30a1, 0x30fa],
    [0x30fc, 0x30fe]
  ],
  hangul: [[0xac00, 0xd7a3]]
} as const satisfies Record<string, readonly AssistantNameRange[]>

/** The allowed Latin letters that do not decompose (Vietnamese, German, Nordic, French,
 * Polish, Turkish), with the letters the skeleton reads them as: "Møøn" is Moon, "Tayłor" is
 * Taylor, "Andı" is Andy. Every other letter's skeleton is its ASCII base. */
export const ASSISTANT_NAME_SKELETON_LETTERS: Readonly<Record<string, string>> = {
  '\u00C6': 'ae',
  '\u00D8': 'o',
  '\u00DF': 'ss',
  '\u00E6': 'ae',
  '\u00F8': 'o',
  '\u0110': 'd',
  '\u0111': 'd',
  '\u0131': 'i',
  '\u0141': 'l',
  '\u0142': 'l',
  '\u0152': 'oe',
  '\u0153': 'oe',
  '\u1E9E': 'ss'
}

/** ASCII digits only: other scripts' digits (५ ๐ ٥…) are refused, not read as numbers. */
export const ASSISTANT_NAME_DIGITS: readonly AssistantNameRange[] = [[0x30, 0x39]]

/** Besides the space, the only punctuation a name may use. */
export const ASSISTANT_NAME_PUNCTUATION = "'-.&,"

/** Typed variants of those marks (smart quotes on macOS and iOS, Unicode hyphens), stored as
 * the plain mark. */
export const ASSISTANT_NAME_PUNCTUATION_VARIANTS: Readonly<Record<string, string>> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u02BC': "'",
  '\u2010': '-',
  '\u2011': '-'
}

/** Marks that read as the app's "verified" badge, emoji or not: never in a name. */
export const ASSISTANT_NAME_CHECK_MARKS = '\u2713\u2714\u2611\u2705\u221A\u{1F5F8}\u{1F5F9}\u{1FBB1}\u{10102}'

/**
 * Emoji that are letters, digits or words in a frame (🅰 🅾 Ⓜ ℹ ™ © ® 🆗 🔤 🔜 🔟, and every
 * keycap: a digit, # or * in a key): they spell, so they are refused like another script's letters. An emoji
 * with any code point in these ranges is refused. Regional indicators are not listed: they
 * are only ever accepted as a whole flag (🇻🇳), never one by one.
 */
export const ASSISTANT_NAME_LETTER_EMOJI: readonly AssistantNameRange[] = [
  [0xa9, 0xa9],
  [0xae, 0xae],
  [0x20e3, 0x20e3],
  [0x2100, 0x214f],
  [0x2460, 0x24ff],
  [0x1f100, 0x1f1e5],
  [0x1f519, 0x1f51d],
  [0x1f51f, 0x1f524]
]

/** Read the same aloud ("Andi", "Andı" for Andy): Atum's names only, never duplicates ("Vy"
 * and "Vi" are two people). Applied before the look merges. */
export const ASSISTANT_NAME_SOUND_MERGES: readonly (readonly [string, string])[] = [['y', 'i']]

/** Drawn alike in a chat font, applied in this order: cl→d last, after i→l and 1→l, so
 * "AncIy" (capital i) reads as Andy. */
export const ASSISTANT_NAME_LOOK_MERGES: readonly (readonly [string, string])[] = [
  ['rn', 'm'],
  ['vv', 'w'],
  ['i', 'l'],
  ['1', 'l'],
  ['0', 'o'],
  ['5', 's'],
  ['cl', 'd']
]

/** The reserved-name skeleton's merges, in order (sound, then look). */
export const ASSISTANT_NAME_FOLD_MERGES: readonly (readonly [string, string])[] = [
  ...ASSISTANT_NAME_SOUND_MERGES,
  ...ASSISTANT_NAME_LOOK_MERGES
]

export type AssistantNameProblem =
  | 'empty'
  | 'tooLong'
  | 'invalidChars'
  | 'mixedScripts'
  | 'noLetters'
  | 'checkMark'
  | 'reserved'
  | 'duplicate'

export type AssistantNameCheck =
  | { ok: true; name: string }
  | {
      ok: false
      problem: AssistantNameProblem
      /** `invalidChars`: the first refused character as it can be shown (an accent on ◌);
       * absent when it draws nothing. */
      char?: string
    }

type UnitKind =
  | 'space'
  | 'punctuation'
  | 'digit'
  | 'latin'
  | 'han'
  | 'kana'
  | 'hangul'
  | 'emoji'
  | 'letterEmoji'
  | 'checkMark'
  | 'other'

/** One thing a person sees in a name: a character, or a whole emoji (flags, families,
 * skin tones and keycaps included). */
interface Unit {
  text: string
  kind: UnitKind
  /** A letter read from a flag (`readAsLetters`): one of a name's letters for Atum's names, not
   * one of a person's. */
  flag?: true
}

/**
 * An emoji: any RGI emoji (ZWJ sequences, flags, tag flags, keycaps, skin tones, with their
 * presentation selector), or one emoji character with or without its selector (a plain ❤,
 * or a sun with the text selector).
 * Anything else in a sequence — a stray joiner, a lone regional indicator or tag — is left
 * as a character and refused.
 */
const EMOJI = new RegExp('\\p{RGI_Emoji}|[\\p{Emoji}&&\\p{Extended_Pictographic}][\\u{FE0E}\\u{FE0F}]?', 'vy')

const CHECK_MARKS = new Set([...ASSISTANT_NAME_CHECK_MARKS].map(char => char.codePointAt(0)!))
const SCRIPT_KINDS = ['latin', 'han', 'kana', 'hangul'] as const

function inRanges(codePoint: number, ranges: readonly AssistantNameRange[]): boolean {
  return ranges.some(([low, high]) => codePoint >= low && codePoint <= high)
}

function split(text: string): { text: string; emoji: boolean }[] {
  const parts: { text: string; emoji: boolean }[] = []
  let index = 0

  while (index < text.length) {
    EMOJI.lastIndex = index
    const match = EMOJI.exec(text)

    if (match) {
      parts.push({ text: match[0], emoji: true })
      index += match[0].length

      continue
    }

    const char = String.fromCodePoint(text.codePointAt(index)!)
    parts.push({ text: char, emoji: false })
    index += char.length
  }

  return parts
}

function classify(part: { text: string; emoji: boolean }): Unit {
  const codePoints = [...part.text].map(char => char.codePointAt(0)!)

  if (codePoints.some(codePoint => CHECK_MARKS.has(codePoint))) {
    return { text: part.text, kind: 'checkMark' }
  }

  if (part.emoji) {
    const letters = codePoints.some(codePoint => inRanges(codePoint, ASSISTANT_NAME_LETTER_EMOJI))

    return { text: part.text, kind: letters ? 'letterEmoji' : 'emoji' }
  }

  const codePoint = codePoints[0]!

  if (part.text === ' ') {
    return { text: part.text, kind: 'space' }
  }

  if (ASSISTANT_NAME_PUNCTUATION.includes(part.text)) {
    return { text: part.text, kind: 'punctuation' }
  }

  if (inRanges(codePoint, ASSISTANT_NAME_DIGITS)) {
    return { text: part.text, kind: 'digit' }
  }

  const script = SCRIPT_KINDS.find(kind => inRanges(codePoint, ASSISTANT_NAME_LETTERS[kind]))

  return { text: part.text, kind: script ?? 'other' }
}

/**
 * The name as it will be stored, and what it is made of, without judging it: NFC, line
 * breaks, tabs and every kind of space as one space, compatibility forms folded (NFKC) except
 * inside emoji (so ‼ stays an emoji, and ™ stays — and is refused as — a framed word),
 * smart punctuation made plain, trimmed.
 */
function prepare(value: string): { name: string; units: Unit[] } {
  const spaced = value.normalize('NFC').replace(/[\t\n\r\f\v\p{Zs}]+/gu, ' ')
  let folded = ''
  let run = ''

  for (const part of split(spaced)) {
    if (part.emoji) {
      folded += run.normalize('NFKC') + part.text
      run = ''
    } else {
      run += part.text
    }
  }

  folded += run.normalize('NFKC')

  let name = ''

  for (const char of folded) {
    name += ASSISTANT_NAME_PUNCTUATION_VARIANTS[char] ?? char
  }

  // Only spaces are trimmed: String#trim would also drop a BOM or a line separator unseen.
  name = name.replace(/\p{Zs}+/gu, ' ').replace(/^ | $/g, '')

  return { name, units: split(name).map(classify) }
}

const isLatinish = (unit: Unit) => unit.kind === 'latin' || unit.kind === 'digit'
const isSeparator = (unit: Unit) => unit.kind === 'space' || unit.kind === 'punctuation'

/** How a refused character is named in the message: itself, an accent on ◌, or nothing for
 * one that draws nothing. */
function shown(text: string): { char?: string } {
  if (/^[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}\u2800]/u.test(text)) {
    return {}
  }

  return { char: /^\p{M}/u.test(text) ? `\u25CC${text}` : text }
}

/**
 * The name as it will be stored, or why it cannot be: one line, 1–40 characters, made only
 * of the allowed characters (refused, never quietly removed, so nobody is surprised by a
 * name that differs from what they typed), at least one letter or digit, no check mark, and
 * no Japanese kana together with Korean Hangul.
 */
export function normalizeAssistantName(value: unknown): AssistantNameCheck {
  if (typeof value !== 'string') {
    return { ok: false, problem: 'empty' }
  }

  if (value.length > 4096) {
    return { ok: false, problem: 'tooLong' }
  }

  const { name, units } = prepare(value)

  if (!name) {
    return { ok: false, problem: 'empty' }
  }

  if ([...name].length > ASSISTANT_NAME_MAX) {
    return { ok: false, problem: 'tooLong' }
  }

  if (units.some(unit => unit.kind === 'checkMark')) {
    return { ok: false, problem: 'checkMark' }
  }

  const refused = units.find(unit => unit.kind === 'other' || unit.kind === 'letterEmoji')

  if (refused) {
    return { ok: false, problem: 'invalidChars', ...shown(refused.text) }
  }

  if (!units.some(unit => isLatinish(unit) || (SCRIPT_KINDS as readonly UnitKind[]).includes(unit.kind))) {
    return { ok: false, problem: 'noLetters' }
  }

  if (units.some(unit => unit.kind === 'kana') && units.some(unit => unit.kind === 'hangul')) {
    return { ok: false, problem: 'mixedScripts' }
  }

  return { ok: true, name }
}

/** A Latin text's skeleton: accents gone, Đ/đ as d, lowercase, then `merges` in order.
 * `?` (a character that could be drawn as any letter) passes through. */
function skeleton(text: string, merges: readonly (readonly [string, string])[]): string {
  let key = ''

  for (const char of text.normalize('NFD').replace(/\p{M}/gu, '')) {
    key += ASSISTANT_NAME_SKELETON_LETTERS[char] ?? char
  }

  key = key.toLowerCase()

  for (const [from, to] of merges) {
    key = key.split(from).join(to)
  }

  return key
}

/**
 * The look-alike key for Atum's own names (and the platform's `atum_private.fold_name`):
 * the name's Latin letters and digits only, through the skeleton. Not for display: "Moon",
 * "Mòon", "ＭＯＯＮ", "𝐌𝐨𝐨𝐧", "M00n", "M o o n" and "Moon 小明" all give "moon".
 */
export function foldAssistantName(value: string): string {
  return skeleton(
    prepare(value)
      .units.filter(isLatinish)
      .map(unit => unit.text)
      .join(''),
    ASSISTANT_NAME_FOLD_MERGES
  )
}

function keyOf(units: readonly Unit[]): string {
  let key = units
    .filter(
      unit => !isSeparator(unit) && unit.kind !== 'emoji' && unit.kind !== 'letterEmoji' && unit.kind !== 'checkMark'
    )
    .map(unit => unit.text)
    .join('')
    .normalize('NFD')
    .toLowerCase()
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '')

  for (const [from, to] of ASSISTANT_NAME_LOOK_MERGES) {
    key = key.split(from).join(to)
  }

  return key.normalize('NFC')
}

/**
 * The key two names are "the same name" by (duplicates, and the exact reserved list): its
 * letters and digits in any allowed script, lowercase, accents kept, the shapes a chat font
 * draws alike merged (I/l, rn/m, 0/o…). Spaces, punctuation and emoji do not count. "Ian" is
 * lan; "Mãi" is not Mai (owner decision D3).
 */
export function assistantNameKey(value: string): string {
  return keyOf(prepare(value).units)
}

/** The words of a name: runs between spaces and punctuation (emoji and other scripts stay
 * inside the word they touch). */
function words(units: readonly Unit[]): Unit[][] {
  const result: Unit[][] = [[]]

  for (const unit of units) {
    if (isSeparator(unit)) {
      result.push([])
    } else {
      result[result.length - 1]!.push(unit)
    }
  }

  return result.filter(word => word.length > 0)
}

const REGIONAL_A = 0x1f1e6
const REGIONAL_Z = 0x1f1ff

/** A flag's two letters, as capitals ("🇦🇹" is "AT"). Where flags are not drawn (Windows
 * without an emoji font), a flag shows as its two letters, so Atum's names are looked for
 * with flags read that way. */
function flagLetters(unit: Unit): string | undefined {
  if (unit.kind !== 'emoji') {
    return undefined
  }

  const codePoints = [...unit.text].map(char => char.codePointAt(0)!)

  return codePoints.length === 2 && codePoints.every(codePoint => codePoint >= REGIONAL_A && codePoint <= REGIONAL_Z)
    ? String.fromCharCode(...codePoints.map(codePoint => 0x41 + codePoint - REGIONAL_A))
    : undefined
}

/** The units the reserved-name checks read: each flag as two capital Latin letters. */
function readAsLetters(units: readonly Unit[]): Unit[] {
  return units.flatMap(unit => {
    const letters = flagLetters(unit)

    return letters ? [...letters].map(text => ({ text, kind: 'latin' as const, flag: true as const })) : [unit]
  })
}

/** Whether an allowed Latin letter is a capital or a small letter (neither for anything
 * else). Word breaks inside a run of letters are read from it: "MoonOfficial". */
export function assistantNameLetterCase(char: string): 'upper' | 'lower' | undefined {
  const codePoint = char.codePointAt(0)

  if (codePoint === undefined || [...char].length !== 1 || !inRanges(codePoint, ASSISTANT_NAME_LETTERS.latin)) {
    return undefined
  }

  return char !== char.toLowerCase() ? 'upper' : char !== char.toUpperCase() ? 'lower' : undefined
}

const caseOf = (unit: Unit | undefined) => (unit?.kind === 'latin' ? assistantNameLetterCase(unit.text) : undefined)

/**
 * A run of Latin letters and digits, cut where a reader sees a word break: small letter then
 * capital ("Moon|Official"), the last capital before a small letter ("MOON|Bot"), and, with
 * `digits`, letter against digit ("Lan|2|Atum"). Both cuts are checked besides the whole run,
 * never instead of it: "M00nOfficial" is found by its case cut alone ("M00n|Official").
 */
function parts(run: readonly Unit[], digits: boolean): string[] {
  const result: string[] = []
  let current = ''

  run.forEach((unit, index) => {
    const previous = run[index - 1]
    const next = run[index + 1]

    const boundary =
      previous !== undefined &&
      ((digits && (previous.kind === 'digit') !== (unit.kind === 'digit')) ||
        (caseOf(previous) === 'lower' && caseOf(unit) === 'upper') ||
        (caseOf(previous) === 'upper' && caseOf(unit) === 'upper' && caseOf(next) === 'lower'))

    if (boundary) {
      result.push(current)
      current = ''
    }

    current += unit.text
  })

  result.push(current)

  return result.filter(Boolean)
}

/** A text and the same text without the digits it starts or ends with ("Moon2", "Andy2023"),
 * when that leaves something. */
function withBare(text: string): string[] {
  if (!text) {
    return []
  }

  const bare = text.replace(/^[0-9]+|[0-9]+$/g, '')

  return bare && bare !== text ? [text, bare] : [text]
}

/**
 * The Latin texts a reserved name could hide in, for one word (flags already read as letters):
 * - `whole`: the word, with any other character glued to a Latin letter or digit read as a
 *   wildcard: `?` for one letter ("And丫", "M口口n"), or `*` for one or two letters when it sits
 *   between two ("M👀n": an emoji can be drawn as "oo"); a `?` at either end of the word is also
 *   tried as a decoration and left out ("丅aylor🌙");
 * - `masked`: a word with two or more Latin letters or digits that starts with two or more
 *   other characters, each of those read as one letter `?` ("ハ丁UM": two strokes drawn as
 *   "AT"), compared whole against Atum's names only, never by the prefix or no-break rules
 *   ("欧阳小明AI" must not start with Atum). Only before the letters: after them they are an
 *   honorific far more often ("Anさん", "Moちゃん");
 * - `parts`: each run of Latin letters and digits inside the word ("Lan小Moon"), and that run's
 *   parts at visible word breaks, by case alone and by case and digits ("MoonOfficial",
 *   "MOONBot", "M00nOfficial", "Lan2Atum"), where they are not a whole reading: one of Atum's
 *   names there is joined to something;
 * - each of these again without the digits it starts or ends with ("Moon2", "Andy2023").
 *
 * The no-break rules (`ASSISTANT_RESERVED_SUFFIX`, `ASSISTANT_RESERVED_PAIRS`) read words only,
 * so "Channing Tatum" is not "channingtatum".
 */
interface WordReading {
  whole: Set<string>
  masked: Set<string>
  parts: Set<string>
  /** The word's Latin letters and digits, in order. */
  latin: string
  /** The word's Latin letters; a flag's are not a person's. */
  letters: number
}

function readWord(word: readonly Unit[]): WordReading {
  const whole = new Set<string>()
  const masked = new Set<string>()
  const inner = new Set<string>()

  const latin = word
    .filter(isLatinish)
    .map(unit => unit.text)
    .join('')

  const letters = word.filter(unit => unit.kind === 'latin' && !unit.flag).length

  if (!latin) {
    return { whole, masked, parts: inner, latin, letters }
  }

  const marked = word
    .map((unit, index) => {
      if (isLatinish(unit)) {
        return unit.text
      }

      const before = index > 0 && isLatinish(word[index - 1]!)
      const after = index + 1 < word.length && isLatinish(word[index + 1]!)

      return before && after ? '*' : before || after ? '?' : ''
    })
    .join('')

  // A character at either end may be a letter or a decoration: "丅aylor🌙" is Taylor.
  for (const text of [marked, marked.replace(/^\?/, ''), marked.replace(/\?$/, ''), marked.replace(/^\?|\?$/g, '')]) {
    withBare(text).forEach(each => whole.add(each))
  }

  // Two or more other characters before the first Latin letter: each one letter ("ハ丁UM").
  const leading = word.findIndex(isLatinish)

  if (leading >= 2 && word.filter(isLatinish).length >= 2) {
    withBare('?'.repeat(leading) + marked.slice(1)).forEach(each => masked.add(each))
  }

  let run: Unit[] = []

  for (const unit of [...word, undefined]) {
    if (unit && isLatinish(unit)) {
      run.push(unit)

      continue
    }

    const texts = run.length ? [run.map(each => each.text).join(''), ...parts(run, false), ...parts(run, true)] : []

    for (const each of texts.flatMap(withBare)) {
      if (!whole.has(each)) {
        inner.add(each)
      }
    }

    run = []
  }

  return { whole, masked, parts: inner, latin, letters }
}

/** A skeleton with wildcards as a regular expression body: `?` is any one letter, `*` any one
 * or two. */
const wildcards = (candidate: string) =>
  [...candidate].map(char =>
    char === '?' ? '.' : char === '*' ? '.{1,2}' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  )

/** Whether a skeleton with wildcards spells `target` (or starts with it). */
function spells(candidate: string, target: string, prefix = false): boolean {
  const tokens = wildcards(candidate)

  if (!prefix) {
    return new RegExp(`^${tokens.join('')}$`).test(target)
  }

  for (let length = 1; length <= Math.min(tokens.length, target.length); length += 1) {
    if (new RegExp(`^${tokens.slice(0, length).join('')}$`).test(target)) {
      return true
    }
  }

  return false
}

/** Atum's names in Japanese, Chinese and Korean script: refused as any word. Not "ムーン", "문"
 * or "月亮": 문 is a Korean surname and 月亮 the ordinary word for the moon. */
export const ASSISTANT_RESERVED_CJK_ATUM = ['アトゥム', '阿图姆', '阿圖姆', '아툼'] as const

/** No word of a name but the primary's whole name may have one of these in it
 * (`assistantNameKey`, accents kept): the CJK spellings of Atum, alone or joined to anything
 * ("アトゥム", "アトゥムLan"). (Ben was here until v5: it is a person's name.) */
export const ASSISTANT_RESERVED_WORDS = [...ASSISTANT_RESERVED_CJK_ATUM] as const

const EXACT_KEYS = new Set<string>(ASSISTANT_RESERVED_NAMES.map(name => assistantNameKey(name)))

/** The whole first-party keys the primary may have: Atum, Atum Bot, or Atum in any of its
 * CJK spellings. Key equality deliberately includes spacing and punctuation variants such as
 * "AtumBot" and "Atum-Bot", exactly like the platform's `assistant_name_key`. */
const PRIMARY_KEYS = new Set<string>(
  ['Atum', 'Atum Bot', ...ASSISTANT_RESERVED_CJK_ATUM].map(name => assistantNameKey(name))
)

const WORD_KEYS = new Set<string>(ASSISTANT_RESERVED_WORDS.map(name => assistantNameKey(name)))
const BEN_KEY = assistantNameKey('ben')
const FOLD_KEYS = ASSISTANT_FOLD_RESERVED_NAMES.map(name => skeleton(name, ASSISTANT_NAME_FOLD_MERGES))

const PERSON_FOLDS = ASSISTANT_FOLD_RESERVED_NAMES.filter(name =>
  (ASSISTANT_RESERVED_PERSON_NAMES as readonly string[]).includes(name)
).map(name => skeleton(name, ASSISTANT_NAME_FOLD_MERGES))

const BRAND_FOLDS = FOLD_KEYS.filter(fold => !PERSON_FOLDS.includes(fold))
const PREFIX_FOLD = skeleton(ASSISTANT_RESERVED_PREFIX, ASSISTANT_NAME_FOLD_MERGES)

/** A word made of "atum" after two or more letters or digits ("TEAMATUM", "theatum"), as a
 * skeleton. Tatum and Datum stay allowed; Ultimatum, Stratum and Erratum are the cost. */
export const ASSISTANT_RESERVED_SUFFIX = /^[a-z0-9]{2,}atum$/

/**
 * Words that read as Atum's staff, an official account or one of Atum's specialists:
 * - joined to one of Atum's names (Ben included) with no break: "MOONOFFICIAL", "andybot",
 *   "BENTEAM" (only these: a general rule would also refuse Moonlight, Supporter, Founders and
 *   Andie);
 * - next to a person's name that has one of Atum's in it, in any order or spacing, as a word,
 *   a part of one or words read together: "Andy Nguyễn Official", "Hỗ trợ Ben Nguyễn",
 *   "Taylor Swift Bot", "Moon Jae-in Chính Thức".
 * The owner's role and official words (v4, and quản trị in v5), then the titles of Atum's own
 * specialists (Moon: astrology; Andy: mental and emotional guide; Ben: careers; Taylor:
 * financial research), so "Ben Hướng nghiệp" and "Ben Careers" stay Atum's.
 */
export const ASSISTANT_RESERVED_ROLE_WORDS = [
  'official',
  'bot',
  'team',
  'staff',
  'hq',
  'ai',
  'app',
  'help',
  'care',
  'desk',
  'real',
  'vn',
  'cskh',
  'hotro',
  'chinhthuc',
  'quantri',
  'chuyengia',
  'specialist',
  'chiemtinh',
  'astrology',
  'tinhthan',
  'mental',
  'emotional',
  'guide',
  'huongnghiep',
  'career',
  'careers',
  'counselor',
  'taichinh',
  'finance',
  'financial',
  'nghiencuu',
  'research'
] as const

const ROLE_FOLDS = ASSISTANT_RESERVED_ROLE_WORDS.map(word => skeleton(word, ASSISTANT_NAME_FOLD_MERGES))
const ROLES = new Set(ROLE_FOLDS)
const FOLDS = new Set(FOLD_KEYS)

/** Next to a person's name with one of Atum's in it, these are also refused at the start or
 * end of another word, where no case shows the break: "MOON NGUYỄNOFFICIAL", "andy lanhotro".
 * The role words and admin, founder and support, but not those that start or end people's
 * names: bot (Talbot), team, staff (Stafford), hq, ai (Thái), app, help, care (Carey), desk,
 * real (Realmuto), vn, guide (Guidetti). */
export const ASSISTANT_RESERVED_ROLE_AFFIXES = [
  'official',
  'cskh',
  'hotro',
  'chinhthuc',
  'quantri',
  'chuyengia',
  'specialist',
  'chiemtinh',
  'astrology',
  'tinhthan',
  'mental',
  'emotional',
  'huongnghiep',
  'career',
  'careers',
  'counselor',
  'taichinh',
  'finance',
  'financial',
  'nghiencuu',
  'research',
  'admin',
  'founder',
  'support'
] as const

const ROLE_AFFIXES = ASSISTANT_RESERVED_ROLE_AFFIXES.map(word => skeleton(word, ASSISTANT_NAME_FOLD_MERGES))

/** A role word: the whole skeleton, or one of the affixes at its start or end. */
const isRole = (candidate: string) =>
  ROLES.has(candidate) ||
  ROLE_AFFIXES.some(
    affix => candidate.length > affix.length && (candidate.startsWith(affix) || candidate.endsWith(affix))
  )

const JOINABLE = [...new Set([...FOLD_KEYS, PREFIX_FOLD, skeleton('ben', ASSISTANT_NAME_FOLD_MERGES)])]

/** A word that is two of Atum's names (Ben included) joined with no break ("MOONATUM",
 * "supportadmin", "BENMOON"), or one of them joined to a role word either way ("MOONBOT",
 * "teamandy"), as skeletons. */
export const ASSISTANT_RESERVED_PAIRS: readonly string[] = [
  ...new Set([
    ...JOINABLE.flatMap(first => JOINABLE.map(second => first + second)),
    ...JOINABLE.flatMap(name => ROLE_FOLDS.flatMap(role => [name + role, role + name]))
  ])
]

const PAIRS = new Set(ASSISTANT_RESERVED_PAIRS)

/** Ben, accents kept ("Bến" is not), wildcards left out. */
const isBen = (text: string) => assistantNameKey(text.replace(/[?*]/g, '')) === BEN_KEY

/** The fewest letters and digits a catalog name needs to be kept (through the skeleton, or as a
 * whole name in any script): shorter ones ("AI", "X", "月亮") are ordinary words and names. */
export const ASSISTANT_CATALOG_NAME_MIN = 3

/** At most this many catalog names are read per check, each cut to `ASSISTANT_NAME_MAX * 2` characters. */
const CATALOG_NAMES_MAX = 512

interface ReservedFolds {
  /** Whether a whole name (`assistantNameKey`) is one of the names kept, in any script. */
  isExact: (key: string) => boolean
  /** Every skeleton a name is looked for under, as a whole or joined to something. */
  foldKeys: readonly string[]
  /** The ones that may be a word of a person's longer name. */
  personFolds: readonly string[]
  folds: ReadonlySet<string>
  /** Two of them, or one and a role word, joined with no break ("moonbot", "demozaofficial"). */
  isPair: (candidate: string) => boolean
}

/**
 * Atum's names, and with `apps` the names the apps in the catalog go by (each app's name in every
 * language, its bot's name, its slug as words; shared/app-catalog.ts `appCatalogNames`), kept
 * like Moon's and Andy's: a person's name may have one as a word of it; nothing may be one alone,
 * beside a role word, or joined to a word. Nothing names an app here: the list comes from the
 * catalog the window holds, so a new app is kept the day it is published. A Latin name is read
 * through the same skeleton as Atum's own, so accents, case, spacing and look-alike shapes do not
 * hide it; a name in another script is kept as a whole name only.
 */
function reservedFolds(apps: readonly string[] | undefined): ReservedFolds {
  const folds = new Set<string>()
  const exact = new Set<string>()

  for (const name of (apps ?? []).slice(0, CATALOG_NAMES_MAX)) {
    if (typeof name !== 'string') {
      continue
    }

    const text = name.slice(0, ASSISTANT_NAME_MAX * 2)
    const fold = foldAssistantName(text)
    const key = assistantNameKey(text)

    if (fold.length >= ASSISTANT_CATALOG_NAME_MIN) {
      folds.add(fold)
    }

    if ([...key].length >= ASSISTANT_CATALOG_NAME_MIN) {
      exact.add(key)
    }
  }

  if (folds.size === 0 && exact.size === 0) {
    return {
      isExact: key => EXACT_KEYS.has(key),
      foldKeys: FOLD_KEYS,
      personFolds: PERSON_FOLDS,
      folds: FOLDS,
      isPair: candidate => PAIRS.has(candidate)
    }
  }

  const catalog = [...folds]
  const joinable = [...JOINABLE, ...catalog]

  const pairs = new Set(
    catalog.flatMap(fold => [
      ...joinable.flatMap(other => [fold + other, other + fold]),
      ...ROLE_FOLDS.flatMap(role => [fold + role, role + fold])
    ])
  )

  return {
    isExact: key => EXACT_KEYS.has(key) || exact.has(key),
    foldKeys: [...FOLD_KEYS, ...catalog],
    personFolds: [...PERSON_FOLDS, ...catalog],
    folds: new Set([...FOLDS, ...catalog]),
    isPair: candidate => PAIRS.has(candidate) || pairs.has(candidate)
  }
}

/** Whether a name belongs to Atum. The primary assistant may use the whole key `atum` or
 * `atumbot` ("Atum", "Atum-Bot", "AtumBot", "Atum 🌙 Bot") or an Atum CJK whole key, and is
 * held to every other rule: "Hỗ trợ Atum", "Atum Bot Official" and "AtumSupport" are refused
 * for it too. A person's name with Moon, Ben, Andy or Taylor in it is not Atum's
 * (`ASSISTANT_RESERVED_PERSON_NAMES`).
 *
 * `apps` are the names the catalog's apps go by. They are kept like Moon's and Andy's: the whole
 * name, the name beside a role word or joined to another word is refused; the name as one word of
 * a person's longer name ("River Phoenix") is not. */
export function isReservedAssistantName(
  name: string,
  options: { primary?: boolean; apps?: readonly string[] } = {}
): boolean {
  const units = readAsLetters(prepare(name).units)
  const key = keyOf(units)

  if (options.primary && PRIMARY_KEYS.has(key)) {
    return false
  }

  const { isExact, foldKeys, personFolds, folds, isPair } = reservedFolds(options.apps)

  if (isExact(key)) {
    return true
  }

  const nameWords = words(units)

  if (nameWords.some(word => [...WORD_KEYS].some(reserved => keyOf(word).includes(reserved)))) {
    return true
  }

  // The whole name's Latin letters and digits read together: "M o o n", "Moon 2", "Moon 小明".
  for (const text of withBare(
    units
      .filter(isLatinish)
      .map(unit => unit.text)
      .join('')
  )) {
    const candidate = skeleton(text, ASSISTANT_NAME_FOLD_MERGES)

    if (
      isBen(text) ||
      foldKeys.some(reserved => spells(candidate, reserved)) ||
      spells(candidate, PREFIX_FOLD, true)
    ) {
      return true
    }
  }

  const readings = nameWords.map(readWord)
  const people = new Set<WordReading>()
  let role = false

  for (const reading of readings) {
    for (const text of reading.whole) {
      const candidate = skeleton(text, ASSISTANT_NAME_FOLD_MERGES)

      if (
        BRAND_FOLDS.some(reserved => spells(candidate, reserved)) ||
        spells(candidate, PREFIX_FOLD, true) ||
        ASSISTANT_RESERVED_SUFFIX.test(candidate) ||
        isPair(candidate)
      ) {
        return true
      }

      if (isBen(text) || personFolds.some(reserved => spells(candidate, reserved))) {
        people.add(reading)
      }

      role ||= isRole(candidate)
    }

    for (const text of reading.masked) {
      const candidate = skeleton(text, ASSISTANT_NAME_FOLD_MERGES)

      if (BRAND_FOLDS.some(reserved => spells(candidate, reserved))) {
        return true
      }

      if (personFolds.some(reserved => spells(candidate, reserved))) {
        people.add(reading)
      }
    }

    for (const text of reading.parts) {
      const candidate = skeleton(text, ASSISTANT_NAME_FOLD_MERGES)

      if (
        isBen(text) ||
        foldKeys.some(reserved => spells(candidate, reserved)) ||
        spells(candidate, PREFIX_FOLD, true) ||
        ASSISTANT_RESERVED_SUFFIX.test(candidate) ||
        isPair(candidate)
      ) {
        return true
      }

      role ||= isRole(candidate)
    }
  }

  if (people.size === 0) {
    return false
  }

  // One of Atum's names as a word of a person's name: another word of it, two or more
  // letters, not one of Atum's ("Andy Nguyễn"; not "Andy A", "Andy 2" or "Ben Taylor"), and no
  // role word anywhere.
  if (role || !readings.some(reading => !people.has(reading) && reading.letters >= 2)) {
    return true
  }

  // Words read together between Atum's names (emoji and other scripts left out): a role word
  // ("Hỗ trợ", "O f f i c i a l"), one of Atum's names ("A Tum", "Mo On") or a pair.
  let segment: string[] = []

  for (const reading of [...readings, undefined]) {
    if (reading && !people.has(reading)) {
      if (reading.latin) {
        segment.push(reading.latin)
      }

      continue
    }

    for (let first = 0; first < segment.length; first += 1) {
      for (let last = first + 1; last < segment.length; last += 1) {
        for (const text of withBare(segment.slice(first, last + 1).join(''))) {
          const candidate = skeleton(text, ASSISTANT_NAME_FOLD_MERGES)

          if (isBen(text) || ROLES.has(candidate) || folds.has(candidate) || isPair(candidate)) {
            return true
          }
        }
      }
    }

    segment = []
  }

  return false
}

/** Another of the owner's assistants already goes by this name (`assistantNameKey`). */
export function isDuplicateAssistantName(
  name: string,
  others: readonly { principal: string; name?: string }[],
  self: string
): boolean {
  const key = assistantNameKey(name)

  return (
    Boolean(key) &&
    others.some(other => other.principal !== self && other.name !== undefined && assistantNameKey(other.name) === key)
  )
}

/** Every rule in one place: the window checks with this, and native checks again. */
export function checkAssistantName(
  value: unknown,
  context: {
    primary: boolean
    principal: string
    others: readonly { principal: string; name?: string }[]
    /** The names the catalog's apps go by (`isReservedAssistantName`). */
    apps?: readonly string[]
  }
): AssistantNameCheck {
  const normalized = normalizeAssistantName(value)

  if (!normalized.ok) {
    return normalized
  }

  if (isReservedAssistantName(normalized.name, { primary: context.primary, apps: context.apps })) {
    return { ok: false, problem: 'reserved' }
  }

  if (isDuplicateAssistantName(normalized.name, context.others, context.principal)) {
    return { ok: false, problem: 'duplicate' }
  }

  return normalized
}
