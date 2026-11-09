#!/usr/bin/env node
/**
 * Checks the generated SQL (scripts/assistant-name-sql.mjs) against the desktop's rules
 * (shared/matrix-assistant-name.ts) on a SCRATCH Postgres: about 70,000 names — every BMP
 * character after "Lan", the emoji and CJK supplementary blocks, Atum's names written every
 * look-alike way, ordinary Vietnamese, CJK and emoji names — through both, comparing the shape
 * check, the reserved check (primary and not) and the duplicate key. Exit 1 on any mismatch.
 *
 * Any name the server would accept and the desktop refuses is a mismatch, with one exception
 * reported apart: a join (U+200D) of allowed pictographs that is not a recommended sequence.
 * Such a join draws as the pictographs side by side, never as a letter; the name must pass
 * the desktop with the joiners removed, with the same reserved verdicts.
 *
 *   PGHOST=127.0.0.1 PGPORT=55439 PGUSER=names PGDATABASE=postgres \
 *     node scripts/assistant-name-sql-parity.mjs --scratch
 *
 * To compare against v6 functions already loaded from platform migrations 0192 + 0261:
 *
 *   node scripts/assistant-name-sql-parity.mjs --scratch --schema atum_private
 *
 * Without `--schema`, it creates and drops `assistant_name_parity`; with `--schema`, it reads
 * those already-installed functions. Either mode is scratch-only: never point it at a shared
 * or production database. Needs `psql` on PATH and Node 23.6 or later.
 */
import { execFileSync } from 'node:child_process'

import * as N from '../shared/matrix-assistant-name.ts'

import { assistantNameSql } from './assistant-name-sql.mjs'

if (!process.argv.includes('--scratch')) {
  console.error('Refusing to run without --scratch: it writes a schema into the database psql connects to.')
  process.exit(2)
}

const schemaAt = process.argv.indexOf('--schema')
const installedSchema = schemaAt >= 0 ? process.argv[schemaAt + 1] : undefined

if (schemaAt >= 0 && (!installedSchema || !/^[a-z_][a-z0-9_]*$/.test(installedSchema))) {
  console.error('--schema needs a lowercase Postgres identifier.')
  process.exit(2)
}

const SCHEMA = installedSchema ?? 'assistant_name_parity'
const names = new Set()
const reserved = ['Atum', 'Moon', 'Ben', 'Andy', 'Taylor', 'Admin', 'Founder', 'Support']
const glue = ['', ' ', '-', '.', '2', '2023', '\u{1F319}', '\u2764\uFE0F', '\u5C0F', '\u3055\u3093', '\uBBFC']

for (const name of reserved) {
  const spellings = [
    name,
    name.toUpperCase(),
    name.toLowerCase(),
    [...name].join(' '),
    [...name].join('.'),
    name.normalize('NFD'),
    name.replace(/o/g, '0').replace(/i/g, '1').replace(/s/g, '5'),
    name.replace(/l/g, 'I').replace(/d/g, 'cl').replace(/m/g, 'rn'),
    name.replace(/a/gi, '\u00E0').replace(/o/g, '\u00F2').replace(/u/g, '\u00FA'),
    name.replace(/y/g, 'i')
  ]

  for (const spelling of spellings) {
    for (const piece of glue) {
      names.add(spelling + piece)
      names.add(piece + spelling)
      names.add(`Lan ${spelling}${piece}`)
      names.add(`${spelling}${piece} Lan`)
    }
  }

  // Shapes glued to the letters, drawn as the missing ones.
  names.add(`${name[0]}\u2B55${name.slice(2)}`)
  names.add(`${name.slice(0, -1)}\u4E2B`)
  names.add(`\u4E01${name.slice(1)}`)
  names.add(`${name[0]}\u{1F469}\u200D\u{1F4BB}${name.slice(2)}`)
}

for (const name of [
  'AncIy',
  'Anc1y',
  'FouncIer',
  'FounclEr',
  'H\u1ED7 tr\u1EE3 Atum',
  'Team Atum',
  'A.T.U.M Team',
  'Atum Main',
  'Atum Bot',
  'Atum-Bot',
  'AtumBot',
  'Atum\u{1F319}Bot',
  'Atum Bot Official',
  'Atum Bót',
  'Moonlight',
  'Tatum',
  'Datum',
  'Autumn',
  'B\u1EBFn',
  'Ben Nguy\u1EC5n',
  'M\u00E3i',
  'Ian',
  '\u3055\u304F\u3089',
  '\u30EB\u30FC\u30B7\u30FC',
  '\u4F50\u3005\u6728',
  '\uAE40\uBBFC\uC218',
  '\u5C0FA',
  'A\u3055\u3093',
  '\u52A9\u624B2\u53F7',
  '\u3055\u304F\u3089\uBBFC\uC218',
  'Lan \u{1F1FB}\u{1F1F3}',
  'Lan \u{1F1E6}\u{1F1E6}',
  'Lan \u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
  'Lan \u{1F3F4}\u{E0075}\u{E0073}\u{E0063}\u{E0061}\u{E007F}',
  'Lan \u{1F469}\u200D\u{1F996}',
  'Lan \u{1F3FD}',
  'Lan\u2764',
  'Lan \u2600\uFE0E',
  'Lan\u203C\uFE0F',
  'M\u00E8o \u{1F431}'
]) {
  names.add(name)
}

// Round 3: joins without a space, flags read as letters, emoji drawn as two letters, the
// primary with staff words, Ben inside a longer name, CJK spellings of Atum.
const roleWords = [
  'Official',
  'Bot',
  'Team',
  'Support',
  'Staff',
  'Admin',
  'AI',
  'Go',
  'Lan',
  'H\u1ED7tr\u1EE3',
  'Nguy\u1EC5n',
  'Atum',
  'Moon'
]

for (const name of reserved) {
  for (const word of roleWords) {
    for (const joined of [name + word, word + name, `${name}2${word}`, `${word}2${name}`]) {
      names.add(joined)
      names.add(joined.toUpperCase())
      names.add(joined.toLowerCase())
    }
  }
}

const regional = letter => String.fromCodePoint(0x1f1e6 + letter.charCodeAt(0) - 0x61)

for (let first = 0x61; first <= 0x7a; first += 1) {
  for (let second = 0x61; second <= 0x7a; second += 1) {
    const pair = regional(String.fromCharCode(first)) + regional(String.fromCharCode(second))
    names.add(`Lan ${pair}`)
    names.add(`${pair}um`)
    names.add(`A${pair}m`)
  }
}

for (const name of reserved) {
  const low = name.toLowerCase()

  for (let at = 0; at + 1 < low.length; at += 1) {
    names.add(`${name.slice(0, at)}${regional(low[at])}${regional(low[at + 1])}${low.slice(at + 2)}`)
  }

  for (const emoji of ['\u{1F440}', '\u267E', '\u267E\uFE0F', '\u27BF', '\u{1F453}']) {
    names.add(`${name[0]}${emoji}${name.slice(3)}`)
    names.add(`${name[0]}${emoji}${name.slice(2)}`)
  }

  for (const word of ['H\u1ED7 tr\u1EE3', 'CSKH', 'Official', '\u30B5\u30DD\u30FC\u30C8', '\u5BA2\u670D']) {
    names.add(`${word} ${name}`)
    names.add(`${name} ${word}`)
  }
}

for (const name of [
  'TEAMATUM',
  'theatum',
  'MOONATUM',
  'supportadmin',
  'Ultimatum',
  'Channing Tatum',
  'Lan Tatum',
  'Big Datum',
  'Moon Atum',
  'Lan MOONATUM',
  'McDonald',
  'DeAndre',
  'MacKenzie',
  'Ben Careers',
  'BenCareers',
  'Ben\u{1F319}',
  'B\u1EBFn Official',
  'Benny',
  '\u30A2\u30C8\u30A5\u30E0',
  '\u963F\u56FE\u59C6',
  '\u963F\u5716\u59C6',
  '\uC544\uD23C',
  '\u30A2\u30C8\u30A5\u30E0 Lan',
  '\u30E0\u30FC\u30F3',
  'Lan \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
  'Lan \u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}',
  'Lan \u{1F3F4}\u{E0061}\u{E0074}\u{E0075}\u{E006D}\u{E007F}',
  'A\u{1F1F9}\u{1F1FA}M',
  'Lan\u{1F440}Mai',
  'Mo\u53E3\u5182'
]) {
  names.add(name)
}

// Masked words: two or more other characters before a word's letters, each read as one letter.
for (const lead of [
  '\u30CF\u4E01',
  '\u4EBA\u4E01',
  '\u30A2\u30C8',
  '\u6B27\u9633\u5C0F\u660E',
  '\u7530\u4E2D',
  '\u{1F319}\u4E01',
  '\u738B\u5C0F\u660E'
]) {
  for (const tail of ['UM', 'um', 'Um2', 'AI', 'Lan', 'Dy', 'on', 'ylor', 'UMBot', 'A', 'M2', '2']) {
    names.add(lead + tail)
    names.add(`${lead}${tail} Official`)
    names.add(`${tail}${lead}`)
  }
}

for (const name of [
  'An\u3055\u3093',
  'Mo\u3061\u3083\u3093',
  'Mo\u53E3\u5182',
  'A\u738B\u5C0F\u660E',
  '\uBBFC\uC9C0An'
]) {
  names.add(name)
}

// Round 5: Moon, Ben, Andy and Taylor as a word of a person's name, next to role words in
// every spacing, Atum's names read across words, and the leftovers a person's name needs.
const people = ['Moon', 'Ben', 'Andy', 'Taylor', 'M00n', 'And丫', 'M\u{1F440}n', 'Bến', 'Ta y lor']
const companions = [
  'Nguyễn',
  'Swift',
  'Jae-in',
  'Jae In',
  'Lan',
  'A',
  'A.',
  'Al',
  '2',
  '小明',
  'さん',
  '\u{1F319}',
  'Lan 2',
  'Mo On',
  'A Tum',
  'Su Pport',
  'B En',
  'Taylor',
  'Nguyễn \u{1F1FB}\u{1F1F3}',
  'Nguyễn \u{1F1FA}\u{1F1F8}'
]
const roles = [
  ...N.ASSISTANT_RESERVED_ROLE_WORDS,
  'Hỗ trợ',
  'Chính Thức',
  'Quản trị',
  'Hướng nghiệp',
  'O f f i c i a l',
  'B 0 T',
  'NguyenBot',
  'Bot2',
  'Team\u{1F319}'
]

for (const person of people) {
  for (const companion of companions) {
    names.add(`${person} ${companion}`)
    names.add(`${companion} ${person}`)
    names.add(`${person}-${companion}`)
  }

  for (const role of roles) {
    for (const shape of [
      `${person} Nguyễn ${role}`,
      `${role} ${person} Nguyễn`,
      `${person} ${role} Nguyễn`,
      `Nguyễn ${person}, ${role}`,
      `${person} ${role}`,
      `${person} Nguyễn${role.replace(/ /g, '')}`,
      `${person} ${role.replace(/ /g, '')}Nguyễn`
    ]) {
      names.add(shape.toLowerCase())
      names.add(shape)
      names.add(shape.toUpperCase())
    }
  }
}

for (const name of [
  'Andy Nguyễn',
  'Ben Nguyễn',
  'Taylor Swift',
  'Moon Jae-in',
  'Moon Ji-ho',
  'Ben Affleck',
  'Andy Lau',
  'Dr. Andy',
  'Mr Moon',
  '❤️ Andy Nguyễn',
  'Andy 2 Lan',
  'Ben Taylor Swift',
  'Andy Moon Lan',
  'AndyNguyễn',
  'Anđy Nguyễn',
  'Atum Nguyễn',
  'Moon Nguyễn サポート',
  'ハ丁AYLOR Lan',
  '人丁oon Lan',
  'ハ丁U\u{1F440}M',
  'And丫 小明',
  'M\u{1F440}n 小明',
  'Andy Stafford',
  'Ben Carey',
  'Andy Talbot',
  'Andy Thái',
  'アトゥムLan',
  'Lan阿图姆',
  '아툼김',
  'アトゥム\u{1F319}'
]) {
  names.add(name)
}

const syllables = [
  'Nguy\u1EC5n',
  'Tr\u1EA7n',
  'L\u00EA',
  'Ph\u1EA1m',
  'Ho\u00E0ng',
  '\u0110\u1EB7ng',
  '\u0110\u1ED7',
  'Ng\u00F4',
  'D\u01B0\u01A1ng',
  'Th\u1ECB',
  'V\u0103n',
  'Minh',
  'Anh',
  'Lan',
  'Mai',
  'H\u01B0\u01A1ng',
  'Ng\u1ECDc',
  'Tu\u1EA5n',
  'Th\u01B0',
  'Vy',
  'Vi',
  'Huy',
  '\u01A0n',
  '\u01AFng',
  '\u00C2n'
]

for (let index = 0; index < 400; index += 1) {
  names.add(
    Array.from({ length: 1 + (index % 4) }, (_, at) => syllables[(index * 7 + at * 13) % syllables.length]).join(' ')
  )
}

for (let codePoint = 0x20; codePoint <= 0xffff; codePoint += 1) {
  if (codePoint < 0xd800 || codePoint > 0xdfff) {
    names.add(`Lan${String.fromCodePoint(codePoint)}`)
  }
}

for (let codePoint = 0x1f000; codePoint <= 0x1faff; codePoint += 1) {
  names.add(`Lan ${String.fromCodePoint(codePoint)}`)
}

for (let codePoint = 0x20000; codePoint <= 0x323af; codePoint += 97) {
  names.add(`Lan ${String.fromCodePoint(codePoint)}`)
}

const rows = [...names].map(input => {
  const checked = N.normalizeAssistantName(input)

  return checked.ok
    ? {
        input,
        sent: checked.name,
        ok: true,
        reserved: N.isReservedAssistantName(checked.name),
        reservedPrimary: N.isReservedAssistantName(checked.name, { primary: true }),
        key: N.assistantNameKey(checked.name)
      }
    : { input, sent: input.normalize('NFC'), ok: false, unjoined: unjoined(input) }
})

/** The desktop's verdicts for a name with its joiners removed, when that passes the shape. */
function unjoined(input) {
  if (!input.includes('\u200D')) {
    return undefined
  }

  const checked = N.normalizeAssistantName(input.replaceAll('\u200D', ''))

  return checked.ok
    ? {
        reserved: N.isReservedAssistantName(checked.name),
        reservedPrimary: N.isReservedAssistantName(checked.name, { primary: true })
      }
    : undefined
}

const csv = value => `"${value.replace(/"/g, '""')}"`

const script = [
  ...(installedSchema
    ? []
    : [`drop schema if exists ${SCHEMA} cascade;`, `create schema ${SCHEMA};`, assistantNameSql(SCHEMA)]),
  'create temp table parity_names (ord integer, v text);',
  'copy parity_names from stdin with (format csv);',
  ...rows.map((row, index) => `${index},${csv(row.sent)}`),
  '\\.',
  `copy (select ord, ${SCHEMA}.assistant_name_shape_ok(v), ${SCHEMA}.assistant_name_reserved(v, false), ` +
    `${SCHEMA}.assistant_name_reserved(v, true), ${SCHEMA}.assistant_name_key(v) from parity_names order by ord) to stdout with (format csv);`,
  ...(installedSchema ? [] : [`drop schema ${SCHEMA} cascade;`]),
  ''
].join('\n')

const psqlArgs = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At']

if (process.env.DATABASE_URL) {
  psqlArgs.push('-d', process.env.DATABASE_URL)
}

const output = execFileSync('psql', psqlArgs, {
  input: script,
  maxBuffer: 1 << 28
}).toString('utf8')

function parse(text) {
  const records = []
  let field = ''
  let record = []
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]

    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      record.push(field)
      field = ''
    } else if (char === '\n') {
      record.push(field)
      records.push(record)
      record = []
      field = ''
    } else {
      field += char
    }
  }

  return records
}

const results = new Map(parse(output).map(([ord, ...rest]) => [Number(ord), rest]))
const problems = []
const looser = []

rows.forEach((row, index) => {
  const [shape, reservedAny, reservedPrimary, key] = results.get(index) ?? []
  const shown = `${JSON.stringify(row.input)} (${[...row.input].map(char => char.codePointAt(0).toString(16)).join(' ')})`

  if (row.ok) {
    if (shape !== 't') {
      problems.push(`desktop accepts, SQL refuses: ${shown}`)
    }

    if ((reservedAny === 't') !== row.reserved || (reservedPrimary === 't') !== row.reservedPrimary) {
      problems.push(
        `reserved differs: ${shown} desktop ${row.reserved}/${row.reservedPrimary} SQL ${reservedAny}/${reservedPrimary}`
      )
    }

    if (key !== row.key) {
      problems.push(`key differs: ${shown} desktop ${JSON.stringify(row.key)} SQL ${JSON.stringify(key)}`)
    }
  } else if (shape === 't' && (reservedAny !== 't' || reservedPrimary !== 't')) {
    const joins = row.unjoined
    const sameVerdicts =
      joins !== undefined &&
      (reservedAny === 't') === joins.reserved &&
      (reservedPrimary === 't') === joins.reservedPrimary

    ;(sameVerdicts ? looser : problems).push(`desktop refuses, SQL accepts: ${shown}`)
  }
})

console.log(`${rows.length} names, ${rows.filter(row => row.ok).length} accepted by the desktop`)
console.log(`server looser: a join of allowed pictographs that is not a recommended sequence: ${looser.length}`)
looser.slice(0, 10).forEach(line => console.log(`  ${line}`))
console.log(`mismatches: ${problems.length}`)
problems.slice(0, 50).forEach(line => console.log(`  ${line}`))
process.exit(problems.length ? 1 : 0)
