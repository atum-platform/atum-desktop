import { describe, expect, it } from 'vitest'

import {
  ASSISTANT_FOLD_RESERVED_NAMES,
  ASSISTANT_NAME_CHECK_MARKS,
  ASSISTANT_NAME_LETTER_EMOJI,
  ASSISTANT_NAME_LETTERS,
  ASSISTANT_NAME_MAX,
  ASSISTANT_NAME_PUNCTUATION,
  ASSISTANT_NAME_PUNCTUATION_VARIANTS,
  ASSISTANT_NAME_SKELETON_LETTERS,
  ASSISTANT_RESERVED_NAMES,
  ASSISTANT_RESERVED_PERSON_NAMES,
  ASSISTANT_RESERVED_ROLE_AFFIXES,
  ASSISTANT_RESERVED_ROLE_WORDS,
  assistantNameKey,
  type AssistantNameRange,
  checkAssistantName,
  foldAssistantName,
  isAssistantNameLocked,
  isDuplicateAssistantName,
  isReservedAssistantName,
  normalizeAssistantName,
  PRIMARY_ASSISTANT_KEEPS_NAME
} from './matrix-assistant-name'

const context = (others: { principal: string; name?: string }[] = []) => ({
  primary: false,
  principal: 'self',
  others
})

/** Every probe from both impersonation reviews (of 0db8f30325, then of c0b159fd57), and the
 * new ones: each must be refused, by some rule, for an assistant that is not the primary. */
const ADVERSARIAL = {
  // Round 1: invisible characters that make a name display as "Moon".
  softHyphen: 'Mo\u00ADon',
  wordJoiner: 'Mo\u2060on',
  tagCharacter: 'Moon\u{E0041}',
  hangulFiller: 'Moon\u3164',
  // Round 1: direction marks.
  leftToRightMark: 'Moo\u200En',
  rightToLeftMark: 'Moo\u200Fn',
  arabicLetterMark: 'Moo\u061Cn',
  // Round 1: look-alike letters.
  cyrillicAtum: '\u0410tum',
  cyrillicMoon: '\u041C\u043E\u043En',
  greekAndy: '\u0391ndy',
  fullWidthAtum: '\uFF21\uFF54\uFF55\uFF4D',
  mathBoldAtum: '\u{1D400}tum',
  dotlessAndy: 'Andı',
  // Round 1: fake verified marks, blank names.
  checkedMoon: 'Moon \u2713',
  checkedFounder: 'Founder \u2705',
  brailleBlank: '\u2800',
  loneAccent: '\u0301',
  // Round 2: scripts the look-alike table missed.
  lisuMoon: '\uA4DF\uA4F3\uA4F3\uA4E0',
  lisuAtum: '\uA4EEtum',
  lisuAndy: '\uA4EE\uA4E0\uA4D3\uA4EC',
  copticAtum: '\u2C80tum',
  copticMoon: '\u2C98\u2C9F\u2C9Fn',
  canadianAndy: '\u15E9\u144E\u15EAY',
  canadianMoon: '\u15F0OO\u144E',
  cherokeeSmallAtum: '\uAB7Atum',
  cherokeeSmallMoon: '\uAB87oon',
  strokedCapitalA: '\u023Atum',
  strokedSmallA: '\u2C65tum',
  // Round 2: enclosed and indicator letters.
  negativeSquaredA: '\u{1F170}tum',
  negativeSquaredM: '\u{1F17C}oon',
  regionalIndicatorA: '\u{1F1E6}tum',
  // Round 2: other scripts' digits used as zeros, and a Hebrew samekh.
  devanagariZeros: 'M\u0966\u0966n',
  thaiZeros: 'M\u0E50\u0E50n',
  arabicIndicFives: 'M\u0665\u0665n',
  hebrewSamekh: 'M\u05E1\u05E1n',
  // Round 2: merges in the wrong order (cl→d before i→l and 1→l).
  andyCapitalI: 'AncIy',
  andyOne: 'Anc1y',
  founderCapitalI: 'FouncIer',
  founderClE: 'FounclEr',
  // Round 2: symbol stand-ins for letters.
  taylorPipe: 'Tay|or',
  andyYen: 'And\u00A5',
  supportDollar: '$upport',
  taylorDentalClick: 'Tay\u01C0or',
  // Round 2: staff names inside a longer name.
  founderAtum: 'Founder Atum',
  andyParenAtum: 'Andy (Atum)',
  hoTroAtum: 'Hỗ trợ Atum',
  teamAtum: 'Team Atum',
  moonOfficial: 'Moon Official',
  moonTwo: 'Moon 2',
  // New: Armenian, Cherokee and Coptic letters.
  armenianO: 'M\u0555\u0555n',
  armenianSmallO: 'M\u0585\u0585n',
  cherokeeA: '\u13AAtum',
  copticO: 'Mo\u2C9Fn',
  // New: Latin mixed with Cyrillic or Greek, reserved or not.
  cyrillicInLan: 'L\u0430n Anh',
  cyrillicInMoon: 'Mo\u043En',
  greekInAtum: 'At\u03C5m',
  // New: mathematical, full-width and circled forms of Atum's names.
  mathItalicMoon: '\u{1D440}\u{1D45C}\u{1D45C}\u{1D45B}',
  mathMonospaceAndy: '\u{1D670}\u{1D697}\u{1D68D}\u{1D6A2}',
  fullWidthMoon: '\uFF2D\uFF2F\uFF2F\uFF2E',
  circledMoon: '\u24C2\u24DE\u24DE\u24DD',
  framedAWithSelector: '\u{1F170}\uFE0Ftum',
  // New: joiners outside an emoji sequence.
  joinerBetweenLetters: 'Mo\u200Don',
  joinerAfterLetter: 'Moon\u200D\u{1F600}',
  joinedNotAnEmoji: 'Lan \u{1F469}\u200D\u{1F996}',
  // New: right-to-left scripts and controls.
  rightToLeftOverride: 'Lan\u202Enoom',
  rightToLeftIsolate: 'Moon\u2067',
  hebrewWord: 'Moon \u05E9\u05DC\u05D5\u05DD',
  arabicWord: 'Lan \u0645\u0648\u0646',
  // New: shapes glued to a Latin letter, drawn as the missing letters.
  emojiCircles: 'M\u2B55\u2B55n',
  keycapZeros: 'M0\uFE0F\u20E30\uFE0F\u20E3n',
  hanSquares: 'M口口n',
  hanY: 'And丫',
  hanT: '丁aylor',
  ideographicZeros: 'M\u3007\u3007n',
  hangulJamo: 'M\u3147\u3147n',
  kanaSuffix: 'Moonさん',
  digitSuffix: 'Moon2',
  yearSuffix: 'Andy2023'
} as const

/** Ordinary names in every language the app speaks, which must keep working. */
const ORDINARY = [
  'Lan',
  'Lan Anh',
  'Nguyễn Thị Hồng',
  'Đức',
  'Bến',
  'Trần Văn Ơn',
  'Ưng Hoàng Phúc',
  'Mona',
  'Moonlight',
  'Tatum',
  'Datum',
  'Autumn',
  'Bentley',
  'Andrea',
  'Bến Official',
  "O'Brien",
  'Anne-Marie',
  'Lan & Mai',
  'Dr. Lan',
  'Lan, Mai',
  'R2D2',
  'Strauß',
  'Søren',
  'Łukasz',
  'Işık',
  'Lǚ Xiǎomíng',
  'さくら',
  'ルーシー',
  '佐々木',
  '東京タワー',
  '小明',
  '小A',
  'Aさん',
  '助手2号',
  '민수',
  'Lan さくら',
  'Lan 민수',
  'Lan \u2764\uFE0F',
  'Lan \u2764',
  'Lan \u2600\uFE0E',
  'Mèo \u{1F431}',
  'Lan \u{1F44D}\u{1F3FD}',
  'Lan \u{1F469}\u200D\u{1F4BB}',
  'Lan \u{1F1FB}\u{1F1F3}',
  'Lan \u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
  'Lan\u203C\uFE0F'
]

function codePoints(ranges: readonly AssistantNameRange[]): number[] {
  return ranges.flatMap(([low, high]) => Array.from({ length: high - low + 1 }, (_, index) => low + index))
}

describe('assistant names', () => {
  it('stores what was typed as one NFC line, trimmed, spaces and compatibility forms folded', () => {
    const vietnamese = 'Nguyễn Thị Hồng'

    expect(normalizeAssistantName('  Lan \n  Anh\t')).toEqual({ ok: true, name: 'Lan Anh' })
    expect(normalizeAssistantName(vietnamese.normalize('NFD'))).toEqual({ ok: true, name: vietnamese.normalize('NFC') })
    expect(normalizeAssistantName('Lan\u00A0Anh')).toEqual({ ok: true, name: 'Lan Anh' })
    expect(normalizeAssistantName('さくら\u3000民')).toEqual({ ok: true, name: 'さくら 民' })
    // NFKC: full-width, ligatures and half-width kana are stored as their plain forms.
    expect(normalizeAssistantName('\uFF2C\uFF41\uFF4E')).toEqual({ ok: true, name: 'Lan' })
    expect(normalizeAssistantName('\uFB01ona')).toEqual({ ok: true, name: 'fiona' })
    expect(normalizeAssistantName('\uFF76\uFF9E\uFF9D')).toEqual({ ok: true, name: 'ガン' })
    // Smart punctuation from a Mac or an iPhone keyboard is stored as the plain mark.
    expect(normalizeAssistantName('O\u2019Brien')).toEqual({ ok: true, name: "O'Brien" })
    expect(normalizeAssistantName('Anne\u2010Marie')).toEqual({ ok: true, name: 'Anne-Marie' })
  })

  it('refuses invisible and direction characters instead of quietly removing them', () => {
    const hidden = [
      '\u200B',
      '\u200D',
      '\uFEFF',
      '\u202E',
      '\u2066',
      '\u0007',
      '\u00AD',
      '\u2060',
      '\u{E0041}',
      '\u3164',
      '\u115F',
      '\uFFA0',
      '\u034F',
      '\u17B4',
      '\u180E',
      '\u200E',
      '\u200F',
      '\u061C',
      '\u2028',
      '\uE000',
      '\uFE00',
      '\u{E0100}',
      '\uFE0F',
      '\u2800'
    ]

    for (const char of hidden) {
      // Nothing to show for a character that draws nothing.
      expect(normalizeAssistantName(`Lan${char}`), char.codePointAt(0)!.toString(16)).toEqual({
        ok: false,
        problem: 'invalidChars'
      })
    }
  })

  it('keeps ordinary names in Vietnamese, English, Japanese, Chinese and Korean', () => {
    for (const name of ORDINARY) {
      expect(checkAssistantName(name, context()), name).toEqual({ ok: true, name: name.normalize('NFC') })
    }
  })

  it('allows every Vietnamese letter, in any case and either normal form', () => {
    for (const base of 'aăâeêioôơuưy') {
      for (const tone of ['', '\u0300', '\u0301', '\u0309', '\u0303', '\u0323']) {
        for (const letter of [base, base.toUpperCase()]) {
          const typed = letter.normalize('NFD') + tone

          expect(normalizeAssistantName(`Lan ${typed}`), typed).toEqual({
            ok: true,
            name: `Lan ${typed.normalize('NFC')}`
          })
        }
      }
    }

    expect(normalizeAssistantName('Đđ')).toEqual({ ok: true, name: 'Đđ' })
  })

  it('refuses every other script, symbol and digit, and names the character', () => {
    const refused: [string, string][] = [
      ['\u0416', '\u0416'],
      ['\u03A9', '\u03A9'],
      ['\u0531', '\u0531'],
      ['\u13A0', '\u13A0'],
      ['\uA4D0', '\uA4D0'],
      ['\u2C80', '\u2C80'],
      ['\u05D0', '\u05D0'],
      ['\u0627', '\u0627'],
      ['\u0E01', '\u0E01'],
      ['\u0905', '\u0905'],
      ['\u0966', '\u0966'],
      ['\u3007', '\u3007'],
      ['\u0251', '\u0251'],
      ['\u1D00', '\u1D00'],
      ['\u023A', '\u023A'],
      ['\u01C0', '\u01C0'],
      ['\u2605', '\u2605'],
      ['\u2014', '\u2014'],
      ['|', '|'],
      ['$', '$'],
      ['@', '@'],
      ['(', '('],
      ['"', '"'],
      ['\u{1F170}\uFE0F', '\u{1F170}\uFE0F'],
      ['1\uFE0F\u20E3', '1\uFE0F\u20E3'],
      ['\u2122', '\u2122'],
      ['\u24C2\uFE0F', '\u24C2\uFE0F'],
      ['\u00A9', '\u00A9'],
      ['\u{1F197}', '\u{1F197}'],
      ['\u{1F1E6}', '\u{1F1E6}']
    ]

    for (const [char, shown] of refused) {
      expect(normalizeAssistantName(`Lan ${char}`), char).toEqual({ ok: false, problem: 'invalidChars', char: shown })
    }

    // A loose accent (one NFC cannot put on its letter) is shown on a dotted circle.
    expect(normalizeAssistantName('\u0301Lan')).toEqual({ ok: false, problem: 'invalidChars', char: '\u25CC\u0301' })
    expect(normalizeAssistantName('Lan\u0335\u0336\u0337\u0338')).toEqual({
      ok: false,
      problem: 'invalidChars',
      char: '\u25CC\u0335'
    })
    expect(normalizeAssistantName('Ẹ\u0301mi')).toMatchObject({ ok: false, problem: 'invalidChars' })
  })

  it('keeps emoji whole, and refuses a joiner, tag or regional indicator outside one', () => {
    expect(normalizeAssistantName('Lan \u{1F469}\u200D\u{1F4BB}')).toMatchObject({ ok: true })
    expect(normalizeAssistantName('\u{1F408}\u200D\u2B1B Mun')).toMatchObject({ ok: true })
    expect(normalizeAssistantName('Lan \u{1F3F3}\uFE0F\u200D\u{1F308}')).toMatchObject({ ok: true })
    // Not a recommended emoji: a joiner between two that do not make one is refused.
    expect(normalizeAssistantName('Lan \u{1F469}\u200D\u{1F996}')).toEqual({ ok: false, problem: 'invalidChars' })
    // A tag sequence that is not one of the three recommended flags.
    expect(normalizeAssistantName('Lan \u{1F3F4}\u{E0075}\u{E0073}\u{E0063}\u{E0061}\u{E007F}')).toEqual({
      ok: false,
      problem: 'invalidChars'
    })
    expect(normalizeAssistantName('Lan \u{1F1E6}\u{1F1E6}')).toMatchObject({ ok: false, problem: 'invalidChars' })
    expect(normalizeAssistantName('Lan\uFE0F')).toEqual({ ok: false, problem: 'invalidChars' })
  })

  it('needs a letter or a digit', () => {
    expect(normalizeAssistantName('\u{1F600}\u{1F600}')).toEqual({ ok: false, problem: 'noLetters' })
    expect(normalizeAssistantName('- . -')).toEqual({ ok: false, problem: 'noLetters' })
    expect(normalizeAssistantName('7')).toEqual({ ok: true, name: '7' })
  })

  it('refuses anything that reads as the verified mark', () => {
    for (const mark of [
      '\u2713',
      '\u2714',
      '\u2714\uFE0F',
      '\u2611',
      '\u2611\uFE0F',
      '\u2705',
      '\u{1F5F8}',
      '\u{1F5F9}',
      '\u221A',
      '\u{10102}'
    ]) {
      expect(normalizeAssistantName(`Lan ${mark}`), mark).toEqual({ ok: false, problem: 'checkMark' })
    }

    for (const mark of ASSISTANT_NAME_CHECK_MARKS) {
      expect(normalizeAssistantName(`Lan${mark}`), mark).toEqual({ ok: false, problem: 'checkMark' })
    }
  })

  it('counts length in characters of the stored name, not UTF-16 units', () => {
    expect(normalizeAssistantName('ữ'.repeat(ASSISTANT_NAME_MAX))).toMatchObject({ ok: true })
    expect(normalizeAssistantName(`Lan${'😀'.repeat(ASSISTANT_NAME_MAX - 3)}`)).toMatchObject({ ok: true })
    expect(normalizeAssistantName('a'.repeat(ASSISTANT_NAME_MAX + 1))).toEqual({ ok: false, problem: 'tooLong' })
    expect(normalizeAssistantName('   ')).toEqual({ ok: false, problem: 'empty' })
    expect(normalizeAssistantName(undefined)).toEqual({ ok: false, problem: 'empty' })
  })

  it('mixes scripts only as Japanese or Korean writing does', () => {
    for (const name of [
      'Lan 東京',
      'Lan さくら',
      'Lan カナ',
      'Lan 민수',
      '東京タワー',
      '김민수 金',
      'さくら 東京 Lan'
    ]) {
      expect(normalizeAssistantName(name), name).toMatchObject({ ok: true })
    }

    for (const name of ['さくら민수', 'Lan カナ 민수', '민수 ひらがな']) {
      expect(normalizeAssistantName(name), name).toEqual({ ok: false, problem: 'mixedScripts' })
    }
  })

  it('refuses every probe from both impersonation reviews and the new ones, through the full check', () => {
    for (const [probe, name] of Object.entries(ADVERSARIAL)) {
      expect(checkAssistantName(name, context()).ok, probe).toBe(false)
    }
  })

  it('keeps Atum’s names for Atum, written in any look-alike way, but not ordinary names', () => {
    const lookalikes = [
      'Moon',
      'MOON',
      'moon ',
      'Mòon',
      'Fóunder',
      'support',
      'Admin',
      'Àdmin',
      'Súpport',
      'Ben',
      'B.e.n',
      'Atum',
      'Ätum',
      'A Tum',
      'Atumn',
      ADVERSARIAL.fullWidthAtum,
      ADVERSARIAL.mathBoldAtum,
      ADVERSARIAL.dotlessAndy,
      '\u{1D40C}\u{1D428}\u{1D428}\u{1D427}',
      'M00n',
      'M o o n',
      'Mo-on',
      'Aturn',
      'TayIor',
      'Tayłor',
      'Ąndy',
      'Møøn',
      'Founder'.normalize('NFD'),
      'Atum Support',
      'AtumBot',
      'A.T.U.M Team'
    ]

    for (const name of lookalikes) {
      expect(isReservedAssistantName(name), name).toBe(true)
    }

    // "Bến" is a person's name, not Ben (only Atum's own names are compared without accents).
    for (const name of [
      'Bến',
      'Lan',
      'Mai',
      'Moonlight',
      'Bentley',
      'Autumn',
      'Datum',
      'Tatum',
      'Mona',
      'Andrea',
      'Bến Official',
      'Benny',
      'Benjamin'
    ]) {
      expect(isReservedAssistantName(name), name).toBe(false)
    }
  })

  it('finds Atum’s names inside a longer name, word by word, and behind anything glued to a letter', () => {
    for (const name of [
      'Founder Atum',
      'Hỗ trợ Atum',
      'Team Atum',
      'Moon Official',
      'Moon 2',
      'Moon2',
      'Andy2023',
      'Moon 小明',
      'Moonさん',
      'Taylor Official',
      'Anđy Nguyễn Bot',
      'M\u2B55\u2B55n',
      'M口口n',
      'And丫',
      '丁aylor',
      'Mo0冂'
    ]) {
      expect(isReservedAssistantName(name), name).toBe(true)
    }

    // A character that only touches another script, or a space, is not a letter of the name.
    for (const name of [
      'Moonlight \u{1F319}',
      'Lan \u2764\uFE0F',
      '小A',
      'Aさん',
      'Kちゃん',
      'Mo \u{1F404}',
      '助手2号'
    ]) {
      expect(isReservedAssistantName(name), name).toBe(false)
    }
  })

  it('finds Atum’s names joined to another word where a reader sees the break (round 3, B1)', () => {
    for (const name of [
      'MoonOfficial',
      'OfficialMoon',
      'FounderAtum',
      'TeamAtum',
      'SupportAtum',
      'AdminAtum',
      'AndyBot',
      'TaylorOfficial',
      'HỗtrợAtum',
      'AndyNguyễn',
      'MOONBot',
      'Lan2Atum',
      'Moon2Go',
      'M00nOfficial',
      // No visible break: "atum" after two or more letters, or two of Atum's names joined.
      'TEAMATUM',
      'theatum',
      'MOONATUM',
      'supportadmin'
    ]) {
      expect(isReservedAssistantName(name), name).toBe(true)
    }

    // Names whose letters only happen to contain one of Atum's; the no-break rules read
    // words, never the whole name run together.
    for (const name of [
      'McDonald',
      'DeAndre',
      'MacKenzie',
      'Tatum',
      'Datum',
      'Moonlight',
      'LeBron',
      'R2D2',
      'Channing Tatum',
      'Lan Tatum',
      'Big Datum'
    ]) {
      expect(isReservedAssistantName(name), name).toBe(false)
    }
  })

  it('finds Atum’s names joined to a role word with no break, Ben included (round 4, M4)', () => {
    for (const name of [
      'MOONOFFICIAL',
      'moonbot',
      'ANDYTEAM',
      'teamandy',
      'TAYLORAI',
      'BENOFFICIAL',
      'benbot',
      'BENMOON',
      'supportben',
      'MOONHỖTRỢ',
      'CHÍNHTHỨCANDY',
      'adminhq'
    ]) {
      expect(isReservedAssistantName(name), name).toBe(true)
    }

    // Only role words: a general no-break rule would also take these.
    for (const name of ['Moonlight', 'Moonbeam', 'Supporter', 'Founders', 'Bentley', 'Benny', 'Bến Team']) {
      expect(isReservedAssistantName(name), name).toBe(false)
    }
  })

  it('reads two or more characters before a word’s letters as one letter each, compared whole (round 4)', () => {
    for (const name of ['ハ丁UM', '人丁UM', 'ハ丁um2', 'ハ丁UM Official', 'アトUM', '🌙丁um']) {
      expect(isReservedAssistantName(name), name).toBe(true)
    }

    // Never by the prefix rule, only with two or more Latin letters or digits, and never
    // after the letters, where an honorific is far more likely.
    for (const name of ['欧阳小明AI', '東京太郎Lan', '王小明AI', 'A王小明', '小明Lan', '花子2', 'Anさん', 'Moちゃん']) {
      expect(isReservedAssistantName(name), name).toBe(false)
    }
  })

  it('refuses Ben alone, joined or with a role word, accents kept: "Bến" is a person (round 3, B4; v5)', () => {
    for (const name of [
      'Ben',
      'Ben Hướng nghiệp',
      'Ben Careers',
      'BEN Official',
      'Ben 2',
      'Ben2',
      'BenCareers',
      'Hướng nghiệp Ben',
      'Ben🌙',
      'B e n'
    ]) {
      expect(isReservedAssistantName(name), name).toBe(true)
    }

    // Preserve user-visible identity, state and recovery behavior across connection changes.
    for (const name of ['Bến', 'Bến Official', 'Benny', 'Benjamin', 'Bentley', 'Ben Nguyễn']) {
      expect(isReservedAssistantName(name), name).toBe(false)
    }
  })

  it('lets Moon, Ben, Andy and Taylor be a word of a person’s name, never Atum’s (owner, 2026-10-06; v5)', () => {
    const people = [
      'Andy Nguyễn',
      'Ben Nguyễn',
      'Taylor Swift',
      'Moon Jae-in',
      'Moon Ji-ho',
      'Ben Affleck',
      'Andy Lau',
      'Taylor Lautner',
      'Mr Moon',
      'Dr. Andy Nguyễn',
      'Nguyễn Văn Andy',
      'ANDY NGUYỄN',
      '\u2764\uFE0F Ben Nguyễn',
      'Anđy Nguyễn',
      'Andy Stafford',
      'Ben Carey',
      'Andy Talbot',
      'Andy Thái'
    ]

    for (const name of people) {
      expect(checkAssistantName(name, context()).ok, name).toBe(true)
      expect(checkAssistantName(name, { primary: true, principal: 'self', others: [] }).ok, name).toBe(true)
    }

    for (const name of [
      // The whole name, or the name and nothing of a person's: initials, digits, emoji, other
      // scripts ("Moon 小明": its Latin letters are Moon alone).
      'Moon 2',
      'Andy A',
      'Taylor 🌙',
      'Moon 小明',
      'And丫 小明',
      'Mo on',
      'Andy 🇺🇸',
      // Joined to another word with no space.
      'AndyNguyễn',
      'MoonJae',
      'Lan2Andy',
      // Two of Atum's names, also read across words.
      'Ben Taylor',
      'Andy Moon',
      'Ben Mo On',
      'Andy A Tum',
      // A role word in any order or spacing, as a word, a part of one or words read together.
      'Andy Nguyễn Official',
      'Official Andy Nguyễn',
      'Andy Official Nguyễn',
      'Hỗ trợ Ben Nguyễn',
      'Ben Nguyễn Hỗ Trợ',
      'Taylor Swift Bot',
      'Moon Jae-in Chính thức',
      'Moon Jae-in Quản trị',
      'Andy Nguyễn CSKH',
      'Andy Nguyễn VN',
      'Andy Nguyễn \u{1F1FB}\u{1F1F3}',
      'Andy NguyễnBot',
      'Andy Nguyễn-Team',
      'Andy Nguyễn O f f i c i a l',
      'Andy Nguyễn Support',
      'Taylor Swift Admin',
      'Ben Nguyễn Careers',
      'Moon Lan Chiêm tinh',
      // A long role word glued to a word where no case shows the break.
      'MOON NGUYỄNOFFICIAL',
      'andy nguyễnhotro',
      'ben nguyễnsupport',
      // Atum and the words that are not people's names stay Atum's as any word.
      'Atum Nguyễn',
      'Lan Atum',
      'Admin Nguyễn',
      'Lan Founder',
      'Support Swift',
      'アトゥムLan'
    ]) {
      expect(isReservedAssistantName(name), name).toBe(true)
      expect(isReservedAssistantName(name, { primary: true }), name).toBe(true)
    }

    // The known cost: a short role word glued to a word with no visible break is not read
    // ("ANDY NGUYỄNBOT"): bot, team, ai and the like end people's names (Talbot, Thái).
    expect(isReservedAssistantName('ANDY NGUYỄNBOT')).toBe(false)
  })

  it('reads a flag as its two letters, as Windows draws it (round 3, M1)', () => {
    const flag = (letters: string) =>
      [...letters].map(letter => String.fromCodePoint(0x1f1e6 + letter.charCodeAt(0) - 97)).join('')

    for (const name of [
      `${flag('at')}um`,
      `At${flag('um')}`,
      `${flag('mo')}on`,
      `${flag('fo')}${flag('un')}${flag('de')}r`,
      `${flag('ta')}ylor`,
      `${flag('ad')}min`,
      `${flag('be')}n`,
      `${flag('at')}${flag('um')} Lan`
    ]) {
      expect(checkAssistantName(name, context()), name).toEqual({ ok: false, problem: 'reserved' })
    }

    expect(checkAssistantName(`Lan ${flag('vn')}`, context()).ok).toBe(true)
  })

  it('reads an emoji between two letters as one or two letters (round 3, M3)', () => {
    for (const name of [
      'M\u{1F440}n',
      'M\u267En',
      'M\u267E\uFE0Fn',
      'M\u27BFn',
      'M\u{1F453}n',
      'F\u{1F440}nder',
      'Supp\u{1F440}rt'
    ]) {
      expect(isReservedAssistantName(name), name).toBe(true)
    }

    expect(isReservedAssistantName('Lan\u{1F440}Mai')).toBe(false)
  })

  it('keeps the CJK spellings of Atum for Atum (round 3, M7)', () => {
    for (const name of ['アトゥム', '阿图姆', '阿圖姆', '아툼', 'アトゥム サポート']) {
      expect(isReservedAssistantName(name), name).toBe(true)
      expect(checkAssistantName(name, context()).ok, name).toBe(false)
    }

    expect(isReservedAssistantName('アトゥム', { primary: true })).toBe(false)

    for (const name of ['ムーン', '月亮', '문', 'アトム']) {
      expect(isReservedAssistantName(name), name).toBe(false)
    }
  })

  it('reads the same aloud as Andy or Taylor: refused too (a known cost: Andi, Tailor)', () => {
    expect(isReservedAssistantName('Andi')).toBe(true)
    expect(isReservedAssistantName('Tailor')).toBe(true)
  })

  it('lets only the primary use the whole Atum or Atum Bot key and refuses longer first-party names', () => {
    expect(isReservedAssistantName('Atum', { primary: true })).toBe(false)
    expect(isReservedAssistantName('ATUM', { primary: true })).toBe(false)
    expect(isReservedAssistantName('Atum \u{1F319}', { primary: true })).toBe(false)
    expect(isReservedAssistantName('\uFF21\uFF54\uFF55\uFF4D', { primary: true })).toBe(false)

    for (const name of ['Atum Bot', 'Atum-Bot', 'AtumBot']) {
      expect(assistantNameKey(name), name).toBe('atumbot')
      expect(checkAssistantName(name, { primary: true, principal: 'self', others: [] }), name).toEqual({
        ok: true,
        name
      })
      expect(checkAssistantName(name, context()), name).toEqual({ ok: false, problem: 'reserved' })
    }

    expect(checkAssistantName('Atum Bot Official', { primary: true, principal: 'self', others: [] })).toEqual({
      ok: false,
      problem: 'reserved'
    })
    expect(checkAssistantName('Atum Bot Official', context())).toEqual({ ok: false, problem: 'reserved' })

    // Round 3, B2: staff and official names around Atum are Atum's, for the primary too.
    for (const name of [
      'Atum Main',
      'Hỗ trợ Atum',
      'Atum Chính thức',
      'Quản trị Atum',
      'CSKH Atum',
      'Atum Team',
      'AtumSupport',
      'AtumAdmin',
      'AtumFounder',
      'AtumMoon',
      'Atum サポート',
      'Atum 客服',
      'Atum2',
      'Atum Bot Official'
    ]) {
      expect(isReservedAssistantName(name, { primary: true }), name).toBe(true)
    }

    expect(isReservedAssistantName('Moon', { primary: true })).toBe(true)
    expect(isReservedAssistantName('Atum Moon', { primary: true })).toBe(true)
    expect(checkAssistantName('Atum', { primary: true, principal: 'self', others: [] })).toEqual({
      ok: true,
      name: 'Atum'
    })
    expect(checkAssistantName('Linh', { primary: true, principal: 'self', others: [] })).toEqual({
      ok: true,
      name: 'Linh'
    })
    expect(checkAssistantName('Atum', context())).toEqual({ ok: false, problem: 'reserved' })
  })

  it('every reserved name is caught by its own key, and the look-alike list is the reserved list but Ben', () => {
    for (const name of ASSISTANT_RESERVED_NAMES) {
      expect(isReservedAssistantName(name), name).toBe(true)
      expect(isReservedAssistantName(name.toUpperCase()), name).toBe(true)
    }

    for (const name of ASSISTANT_FOLD_RESERVED_NAMES) {
      expect(ASSISTANT_RESERVED_NAMES).toContain(name)
      expect(isReservedAssistantName(`Lan ${name}`), name).toBe(
        !(ASSISTANT_RESERVED_PERSON_NAMES as readonly string[]).includes(name)
      )
      expect(isReservedAssistantName(`Lan ${name} Official`), name).toBe(true)
    }

    // People's names are reserved names; the role affixes are role words, or reserved names
    // that are not people's.
    for (const name of ASSISTANT_RESERVED_PERSON_NAMES) {
      expect(ASSISTANT_RESERVED_NAMES).toContain(name)
    }

    for (const affix of ASSISTANT_RESERVED_ROLE_AFFIXES) {
      expect(
        (ASSISTANT_RESERVED_ROLE_WORDS as readonly string[]).includes(affix) ||
          ((ASSISTANT_RESERVED_NAMES as readonly string[]).includes(affix) &&
            !(ASSISTANT_RESERVED_PERSON_NAMES as readonly string[]).includes(affix)),
        affix
      ).toBe(true)
    }

    expect(
      ASSISTANT_RESERVED_NAMES.filter(name => !(ASSISTANT_FOLD_RESERVED_NAMES as readonly string[]).includes(name))
    ).toEqual(['ben'])
  })

  it('folds accents, case, spacing, other forms and look-alike digits into one key', () => {
    expect(foldAssistantName('Đức Ánh')).toBe(foldAssistantName('duc anh'))
    expect(foldAssistantName('M0 0N')).toBe('moon')
    expect(foldAssistantName('\uFF2D\uFF2F\uFF2F\uFF2E')).toBe('moon')
    expect(foldAssistantName('Moon 小明')).toBe('moon')
    expect(foldAssistantName('Lan')).not.toBe(foldAssistantName('Mai'))
    // The merge order: I and 1 become l first, so the cl they make reads as d.
    expect(foldAssistantName('AncIy')).toBe(foldAssistantName('Andy'))
    expect(foldAssistantName('Anc1y')).toBe(foldAssistantName('Andy'))
    expect(foldAssistantName('FouncIer')).toBe(foldAssistantName('Founder'))
  })

  it('refuses a second assistant with the same name, ignoring case, spacing and look-alike shapes but not accents', () => {
    const others = [
      { principal: 'a', name: 'Lan Anh' },
      { principal: 'self', name: 'Mai' }
    ]

    expect(isDuplicateAssistantName('lan anh', others, 'self')).toBe(true)
    expect(isDuplicateAssistantName('\uFF2C\uFF41\uFF4E\uFF21\uFF4E\uFF48', others, 'self')).toBe(true)
    expect(isDuplicateAssistantName('Ian Anh', others, 'self')).toBe(true)
    expect(isDuplicateAssistantName('Mai', others, 'self')).toBe(false)
    expect(isDuplicateAssistantName('Lán Anh', others, 'self')).toBe(false)
    // Owner decision D3: accents make a different name, and so does y/i.
    expect(isDuplicateAssistantName('Mãi', [{ principal: 'b', name: 'Mai' }], 'self')).toBe(false)
    expect(isDuplicateAssistantName('Vy', [{ principal: 'b', name: 'Vi' }], 'self')).toBe(false)
    expect(isDuplicateAssistantName('小明', [{ principal: 'b', name: '小明' }], 'self')).toBe(true)
    expect(assistantNameKey('Lan \u2764\uFE0F')).toBe(assistantNameKey('lan'))
  })

  it('checks in order: shape, then reserved, then duplicates', () => {
    expect(checkAssistantName('  Lan  ', context())).toEqual({ ok: true, name: 'Lan' })
    expect(checkAssistantName('Moon', context([{ principal: 'x', name: 'Moon' }]))).toEqual({
      ok: false,
      problem: 'reserved'
    })
    expect(checkAssistantName('lan', context([{ principal: 'x', name: 'Lan' }]))).toEqual({
      ok: false,
      problem: 'duplicate'
    })
    expect(checkAssistantName('M\u043E\u043En', context())).toEqual({
      ok: false,
      problem: 'invalidChars',
      char: '\u043E'
    })
  })

  it('locks a name only for the primary, and only as owner decision D1 says', () => {
    expect(isAssistantNameLocked({ isDefault: false })).toBe(false)
    expect(isAssistantNameLocked({ isDefault: true })).toBe(PRIMARY_ASSISTANT_KEEPS_NAME)
  })
})

describe('the exported rule tables', () => {
  it('Latin is ASCII, letters that decompose to ASCII and accents, and the listed real-language letters', () => {
    for (const codePoint of codePoints(ASSISTANT_NAME_LETTERS.latin)) {
      const char = String.fromCodePoint(codePoint)
      const decomposes = /^[A-Za-z]\p{M}*$/u.test(char.normalize('NFD'))

      expect(decomposes || char in ASSISTANT_NAME_SKELETON_LETTERS, codePoint.toString(16)).toBe(true)
      expect(/\p{Script=Latin}/u.test(char), codePoint.toString(16)).toBe(true)
      expect(normalizeAssistantName(char), codePoint.toString(16)).toEqual({ ok: true, name: char })
    }

    for (const letter of Object.keys(ASSISTANT_NAME_SKELETON_LETTERS)) {
      expect(normalizeAssistantName(letter), letter).toEqual({ ok: true, name: letter })
    }
  })

  it('every other script’s letters and every unlisted Latin look-alike are refused', () => {
    const allowed = new Set(
      [
        ...ASSISTANT_NAME_LETTERS.latin,
        ...ASSISTANT_NAME_LETTERS.han,
        ...ASSISTANT_NAME_LETTERS.kana,
        ...ASSISTANT_NAME_LETTERS.hangul
      ].flatMap(range => codePoints([range]))
    )

    // Every letter of the Basic Multilingual Plane outside the tables (and that NFKC or the
    // smart-punctuation map does not turn into one of them) is refused.
    for (let codePoint = 0x80; codePoint <= 0xffff; codePoint += 1) {
      const char = String.fromCodePoint(codePoint)

      if (!/\p{L}/u.test(char) || allowed.has(codePoint) || char in ASSISTANT_NAME_PUNCTUATION_VARIANTS) {
        continue
      }

      const folded = [...char.normalize('NFKC')].map(each => ASSISTANT_NAME_PUNCTUATION_VARIANTS[each] ?? each)

      if (folded.every(each => allowed.has(each.codePointAt(0)!) || /[A-Za-z0-9 '\-.&,]/.test(each))) {
        continue
      }

      expect(normalizeAssistantName(`Lan${char}`).ok, codePoint.toString(16)).toBe(false)
    }
  })

  it('Han, kana and Hangul are their scripts’ letters, and none of them is a framed-letter emoji', () => {
    for (const codePoint of codePoints(ASSISTANT_NAME_LETTERS.han)) {
      expect(
        /\p{Unified_Ideograph}/u.test(String.fromCodePoint(codePoint)) || codePoint === 0x3005,
        codePoint.toString(16)
      ).toBe(true)
    }

    for (const codePoint of codePoints(ASSISTANT_NAME_LETTERS.kana)) {
      expect(
        /[\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u.test(String.fromCodePoint(codePoint)),
        codePoint.toString(16)
      ).toBe(true)
    }

    for (const codePoint of codePoints(ASSISTANT_NAME_LETTERS.hangul)) {
      expect(/\p{Script=Hangul}/u.test(String.fromCodePoint(codePoint)), codePoint.toString(16)).toBe(true)
    }

    const letters = Object.values(ASSISTANT_NAME_LETTERS).flat()

    for (const [low, high] of ASSISTANT_NAME_LETTER_EMOJI) {
      expect(letters.some(([from, to]) => low <= to && from <= high)).toBe(false)
    }
  })

  it('the five marks are the only punctuation', () => {
    for (const mark of ASSISTANT_NAME_PUNCTUATION) {
      expect(normalizeAssistantName(`Lan${mark}Anh`), mark).toEqual({ ok: true, name: `Lan${mark}Anh` })
    }

    for (const mark of '!?:;/\\_*#+=~^%<>[]{}"`') {
      expect(normalizeAssistantName(`Lan${mark}Anh`), mark).toMatchObject({ ok: false, problem: 'invalidChars' })
    }
  })
})

// An assistant's name is shown to other people beside its messages, and the apps in the catalog
// speak in the same chats. Their names are kept for them, the way Moon's and Andy's are, from the
// Preserve user-visible identity, state and recovery behavior across connection changes.
describe('the names of the apps in the catalog', () => {
  const apps = ['Demoza', 'River', 'eTax Mobile', 'Thật Space', 'VNeID', 'AI', 'Demoza AI Skin Coach']

  it('keeps an app’s name for the app, written in any look-alike way', () => {
    for (const name of [
      'Demoza',
      'Demoza',
      'démôza',
      'D e m o z a',
      'Demoza 2',
      'Demoza 🌙',
      'Ｄｅｍｏｚａ',
      'eTax Mobile',
      'ETAXMOBILE',
      'etax mobile',
      'That Space',
      'THẬT SPACE',
      'thatspace',
      'VNeID',
      'vneid',
      'River'
    ]) {
      expect(isReservedAssistantName(name, { apps }), name).toBe(true)
      expect(checkAssistantName(name, { ...context(), apps }), name).toEqual({ ok: false, problem: 'reserved' })
    }
  })

  it('reads an app’s name beside a role word, or glued to a word, as the app’s', () => {
    for (const name of [
      'Demoza Official',
      'Official Demoza',
      'DemozaBot',
      'Demoza Team',
      'Hỗ trợ Demoza',
      'RiverOfficial',
      'Demoza Staff',
      'DemozaNguyễn',
      'Lan2Demoza',
      // No capital shows the break, as in "andybot": a catalog name joins a role word or another
      // of the names kept, either way round.
      'demozabot',
      'botdemoza',
      'DemozaOFFICIAL',
      'teamriver',
      'demozamoon',
      'atumdemoza',
      'riverdemoza',
      // Spelled in two words beside another kept name, as "Andy A Tum" is Atum's.
      'River De Moza'
    ]) {
      expect(isReservedAssistantName(name, { apps }), name).toBe(true)
    }
  })

  it('lets an app’s name be one word of a person’s longer name, as Moon and Andy may be', () => {
    for (const name of ['River Phoenix', 'Mr River', 'Demoza Nguyễn', 'Lan Demoza']) {
      expect(isReservedAssistantName(name, { apps }), name).toBe(false)
      expect(checkAssistantName(name, { ...context(), apps }).ok, name).toBe(true)
    }
  })

  it('keeps an app’s name in another script as a whole name, but not a word too short to be one', () => {
    const named = ['皮肤专家', 'カタログ', '月亮']

    expect(isReservedAssistantName('皮肤专家', { apps: named })).toBe(true)
    expect(isReservedAssistantName('カタログ', { apps: named })).toBe(true)
    expect(checkAssistantName('皮肤专家', { ...context(), apps: named })).toEqual({ ok: false, problem: 'reserved' })
    // 月亮 is two letters, the ordinary word for the moon, as it is for Atum's own names.
    expect(isReservedAssistantName('月亮', { apps: named })).toBe(false)
    // Only the whole name is kept: a longer name that holds it is a different name.
    expect(isReservedAssistantName('皮肤专家小明', { apps: named })).toBe(false)
    expect(isReservedAssistantName('皮肤专家小明')).toBe(false)
  })

  it('reserves nothing without a catalog, or for a name too short to be one', () => {
    expect(isReservedAssistantName('Demoza')).toBe(false)
    expect(isReservedAssistantName('Demoza', { apps: [] })).toBe(false)
    expect(checkAssistantName('Demoza', context()).ok).toBe(true)
    // "AI" is in the catalog above, and still an ordinary name.
    expect(isReservedAssistantName('AI', { apps })).toBe(false)
    expect(isReservedAssistantName('Ai Linh', { apps })).toBe(false)
    // Something that is not a name is not one either.
    expect(isReservedAssistantName('Lan', { apps: ['', '   ', '🌙', '小明'] })).toBe(false)
  })

  it('leaves every other rule as it was', () => {
    // The primary may still be called Atum, and only that.
    expect(checkAssistantName('Atum', { primary: true, principal: 'self', others: [], apps }).ok).toBe(true)
    expect(isReservedAssistantName('Atum Demoza', { primary: true, apps })).toBe(true)

    // Atum's own names and every probe from the impersonation reviews are refused as before.
    for (const name of Object.values(ADVERSARIAL)) {
      expect(isReservedAssistantName(name, { apps }) || !checkAssistantName(name, { ...context(), apps }).ok, name).toBe(true)
    }

    // Duplicates and shape come after, in the same order.
    expect(
      checkAssistantName('Lan', { ...context([{ principal: 'other', name: 'Lan' }]), apps })
    ).toEqual({ ok: false, problem: 'duplicate' })
    expect(checkAssistantName('Moon', { ...context(), apps })).toEqual({ ok: false, problem: 'reserved' })
  })
})
