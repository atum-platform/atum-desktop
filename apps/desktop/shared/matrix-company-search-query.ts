export type MatrixCompanySearchTab = 'messages' | 'files'
export type MatrixCompanySearchFileType = 'all' | 'images' | 'pdfs' | 'documents' | 'other'
export type MatrixCompanySearchOperator = 'from' | 'in' | 'before' | 'after'
export type MatrixCompanySearchQueryError = 'duplicate_operator' | 'invalid_date' | 'invalid_operator' | 'invalid_range' | 'unterminated_quote'

export interface MatrixCompanySearchTerm {
  value: string
  quoted: boolean
}

export interface MatrixCompanySearchChip {
  operator: MatrixCompanySearchOperator | 'phrase'
  value: string
  label: string
}

export interface ParsedMatrixCompanySearchQuery {
  raw: string
  terms: MatrixCompanySearchTerm[]
  from?: string
  in?: string
  before?: string
  after?: string
  chips: MatrixCompanySearchChip[]
  errors: MatrixCompanySearchQueryError[]
  /** Search term sent to Matrix when the query can stay server-side. */
  serverTerm: string
}

interface Token {
  value: string
  quoted: boolean
  closed: boolean
}

function tokens(raw: string): Token[] {
  const result: Token[] = []
  let index = 0

  while (index < raw.length) {
    while (/\s/u.test(raw[index] ?? '')) {index += 1}

    if (index >= raw.length) {break}

    if (raw[index] !== '"') {
      const start = index

      while (index < raw.length && !/\s/u.test(raw[index] ?? '')) {index += 1}
      result.push({ value: raw.slice(start, index), quoted: false, closed: true })

      continue
    }

    index += 1
    let value = ''
    let closed = false

    while (index < raw.length) {
      const character = raw[index]!

      if (character === '"') {
        index += 1
        closed = true

        break
      }

      if (character === '\\' && ['"', '\\'].includes(raw[index + 1] ?? '')) {
        value += raw[index + 1]
        index += 2

        continue
      }

      value += character
      index += 1
    }

    result.push({ value, quoted: true, closed })
  }

  return result
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)

  if (!match) {return false}
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))

  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function uniqueErrors(errors: MatrixCompanySearchQueryError[]): MatrixCompanySearchQueryError[] {
  return [...new Set(errors)]
}

/** Parse the small, intentionally familiar Team space search language without reading any authority. */
export function parseMatrixCompanySearchQuery(raw: string): ParsedMatrixCompanySearchQuery {
  const parsed: ParsedMatrixCompanySearchQuery = {
    raw,
    terms: [],
    chips: [],
    errors: [],
    serverTerm: ''
  }

  const seen = new Set<MatrixCompanySearchOperator>()

  for (const token of tokens(raw.trim())) {
    if (token.quoted) {
      if (!token.closed) {parsed.errors.push('unterminated_quote')}

      if (token.value) {
        parsed.terms.push({ value: token.value, quoted: true })
        parsed.chips.push({ operator: 'phrase', value: token.value, label: `“${token.value}”` })
      }

      continue
    }

    const operator = /^(from|in|before|after):(.*)$/iu.exec(token.value)

    if (!operator) {
      if (token.value) {parsed.terms.push({ value: token.value, quoted: false })}

      continue
    }

    const name = operator[1]!.toLocaleLowerCase('en-US') as MatrixCompanySearchOperator
    const value = operator[2]!

    if (seen.has(name)) {
      parsed.errors.push('duplicate_operator')

      continue
    }

    seen.add(name)

    const valid = name === 'from'
      ? value === 'me' || /^@[^\s@:|]+(?:[^\s:|]*)$/u.test(value)
      : name === 'in'
        ? /^#[^\s#|]+$/u.test(value)
        : validDate(value)

    if (!valid) {
      parsed.errors.push(name === 'before' || name === 'after' ? 'invalid_date' : 'invalid_operator')

      continue
    }

    parsed[name] = value
    parsed.chips.push({ operator: name, value, label: `${name}:${value}` })
  }

  if (parsed.before && parsed.after && parsed.before <= parsed.after) {
    parsed.errors.push('invalid_range')
  }

  parsed.errors = uniqueErrors(parsed.errors)
  parsed.serverTerm = parsed.terms.map(term => term.value).join(' ').trim()

  return parsed
}

/** Dates are calendar dates in the Mac's current timezone, matching what the result row shows. */
export function matrixCompanySearchDate(at: number): string {
  const date = new Date(at)
  const year = date.getFullYear().toString().padStart(4, '0')
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')

  return `${year}-${month}-${day}`
}

export function matrixCompanySearchNeedsLoadedHistory(
  parsed: ParsedMatrixCompanySearchQuery,
  _tab: MatrixCompanySearchTab
): boolean {
  // Matrix /search supplies full-history candidates for messages and files.
  // Client-side phrase/date/file-type checks refine those candidates. Only an
  // operator-only query has no search term for the native API.
  return parsed.serverTerm.length === 0
}

export function matrixCompanySearchTermMatches(body: string, parsed: ParsedMatrixCompanySearchQuery): boolean {
  const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/gu, 'd')
    .toLocaleLowerCase().replace(/\s+/gu, ' ').trim()

  const foldedBody = fold(body)

  return parsed.terms.every(term => foldedBody.includes(fold(term.value)))
}

export function matrixCompanySearchDateMatches(at: number, parsed: ParsedMatrixCompanySearchQuery): boolean {
  const date = matrixCompanySearchDate(at)

  return (!parsed.before || date < parsed.before) && (!parsed.after || date >= parsed.after)
}
