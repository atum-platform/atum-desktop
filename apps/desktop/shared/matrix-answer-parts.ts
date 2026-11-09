/** Preserve user-visible identity, state and recovery behavior across connection changes. */
import { MATRIX_MESSAGE_MAX_BYTES } from './matrix'

export const MATRIX_ANSWER_PART_KEY = 'io.atum.part'

export interface MatrixAnswerPart {
  index: number
  count: number
}

/** A part's position, as a split answer's content carries it; anything else is not a part. */
export function matrixAnswerPart(value: unknown): MatrixAnswerPart | undefined {
  const part = value as Partial<MatrixAnswerPart> | null | undefined

  return part &&
    typeof part === 'object' &&
    Number.isSafeInteger(part.count) &&
    Number.isSafeInteger(part.index) &&
    part.count! >= 2 &&
    part.index! >= 0 &&
    part.index! < part.count!
    ? { index: part.index!, count: part.count! }
    : undefined
}

/** The fixed transaction of one part: the first keeps the answer's own, so a one-message answer
 * and the first part of a split one are sent the same way. */
export function matrixAnswerPartTransaction(transactionId: string, index: number): string {
  return index === 0 ? transactionId : `${transactionId}-p${index}`
}

/** UTF-8 bytes of one UTF-16 unit once JSON-escaped, as `matrixMessageTooLong` counts them. A
 * surrogate pair is four bytes, counted on its high unit; a lone surrogate is escaped (6). */
function unitBytes(text: string, index: number): number {
  const code = text.charCodeAt(index)

  if (
    code === 0x22 ||
    code === 0x5c ||
    code === 0x08 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0c ||
    code === 0x0d
  ) {
    return 2
  }

  if (code < 0x20) {
    return 6
  }

  if (code < 0x80) {
    return 1
  }

  if (code < 0x800) {
    return 2
  }

  if (code >= 0xd800 && code <= 0xdbff) {
    const next = text.charCodeAt(index + 1)

    return next >= 0xdc00 && next <= 0xdfff ? 4 : 6
  }

  if (code >= 0xdc00 && code <= 0xdfff) {
    const previous = text.charCodeAt(index - 1)

    return previous >= 0xd800 && previous <= 0xdbff ? 0 : 6
  }

  return 3
}

/** Bytes as `matrixMessageTooLong` counts them: the JSON-escaped text, quotes included. */
function jsonBytes(text: string): number {
  return new TextEncoder().encode(JSON.stringify(text)).byteLength
}

interface Fence {
  /** The opening line as written (its marker and info string), to open it again. */
  line: string
  marker: string
}

const OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const BLANK = /^[ \t]*$/

/** Break classes, best first. */
const PARAGRAPH = 0
const LINE = 1
const FENCED_LINE = 2

/**
 * The answer as the messages that carry it, in order: one when it fits (unchanged), else parts
 * that each fit `maxBytes` (as `matrixMessageTooLong` counts) and read naturally on their own.
 */
export function matrixAnswerParts(text: string, maxBytes: number = MATRIX_MESSAGE_MAX_BYTES): string[] {
  if (jsonBytes(text) <= maxBytes) {
    return [text]
  }

  const n = text.length
  const prefix = new Float64Array(n + 1)

  for (let index = 0; index < n; index++) {
    prefix[index + 1] = prefix[index]! + unitBytes(text, index)
  }

  // A cut never splits a surrogate pair.
  const boundary = (index: number) => {
    const code = text.charCodeAt(index)

    return !(
      code >= 0xdc00 &&
      code <= 0xdfff &&
      index > 0 &&
      text.charCodeAt(index - 1) >= 0xd800 &&
      text.charCodeAt(index - 1) <= 0xdbff
    )
  }

  // Lines, and whether each one starts inside a fenced code block.
  const starts: number[] = []
  const fenced: (Fence | null)[] = []
  const blank: boolean[] = []
  let fence: Fence | null = null
  let longestMarker = 3

  for (let start = 0; start <= n; ) {
    const newline = text.indexOf('\n', start)
    const end = newline < 0 ? n : newline
    const line = text.slice(start, end).replace(/\r$/, '')
    starts.push(start)
    fenced.push(fence)
    blank.push(BLANK.test(line))

    if (fence) {
      const close = CLOSE.exec(line)

      if (close && close[1]![0] === fence.marker[0] && close[1]!.length >= fence.marker.length) {
        fence = null
      }
    } else {
      const open = OPEN.exec(line)

      if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
        fence = { line: line.trimStart(), marker: open[1]! }
        longestMarker = Math.max(longestMarker, open[1]!.length)
      }
    }

    if (newline < 0) {
      break
    }

    start = newline + 1
  }

  // Where a part may end (the start of the next line), by class, in order.
  const breaks: number[][] = [[], [], []]

  for (let line = 1; line < starts.length; line++) {
    const at = starts[line]!

    if (fenced[line]) {
      // Between two lines of code only: never just after the opening line or just before the
      // closing one, which would leave an empty block on one side.
      if (fenced[line - 1] && (line + 1 >= starts.length || fenced[line + 1])) {
        breaks[FENCED_LINE]!.push(at)
      }
    } else if (blank[line] || blank[line - 1]) {
      breaks[PARAGRAPH]!.push(at)
    } else {
      breaks[LINE]!.push(at)
    }
  }

  const lineOf = (position: number) => {
    let low = 0
    let high = starts.length - 1

    while (low < high) {
      const middle = (low + high + 1) >> 1

      if (starts[middle]! <= position) {
        low = middle
      } else {
        high = middle - 1
      }
    }

    return low
  }

  /** The fence a position is inside, by its line's start (a cut mid-line keeps that line's). */
  const fenceAt = (position: number) => fenced[lineOf(position)] ?? null

  const lastAtMost = (list: number[], low: number, high: number): number | undefined => {
    let lo = 0
    let hi = list.length - 1
    let found: number | undefined

    while (lo <= hi) {
      const middle = (lo + hi) >> 1

      if (list[middle]! <= high) {
        found = list[middle]
        lo = middle + 1
      } else {
        hi = middle - 1
      }
    }

    return found !== undefined && found > low ? found : undefined
  }

  // Room for the fence a part may have to close (a newline and the longest marker).
  const closeReserve = 1 + longestMarker
  const parts: string[] = []
  let at = 0

  while (at < n) {
    const open = fenceAt(at)
    const reopen = open ? `${open.line}\n` : ''
    // The part's own text, beside its quotes and the fence line it opens again.
    const budget = maxBytes - jsonBytes(reopen)

    if (prefix[n]! - prefix[at]! <= budget) {
      push(parts, reopen + text.slice(at))

      break
    }

    // The furthest end that fits with a fence close after it.
    let low = at + 1
    let high = n
    let limit = at

    while (low <= high) {
      const middle = (low + high) >> 1

      if (prefix[middle]! - prefix[at]! <= budget - closeReserve) {
        limit = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }

    while (limit > at && !boundary(limit)) {
      limit--
    }

    if (limit <= at) {
      // Not even one character fits beside the fence lines: the bound is too small to split by.
      limit = at + 1

      while (limit < n && !boundary(limit)) {
        limit++
      }
    }

    const half = at + (limit - at) / 2
    let cut: number | undefined
    let skipWhitespace = false

    // Between paragraphs or lines, outside code, filling at least half the part; then outside
    // code at all; then between lines of a code block; then at a space; then mid-word.
    for (const option of [
      lastAtMost(breaks[PARAGRAPH]!, half, limit),
      lastAtMost(breaks[LINE]!, half, limit),
      Math.max(lastAtMost(breaks[PARAGRAPH]!, at, limit) ?? -1, lastAtMost(breaks[LINE]!, at, limit) ?? -1),
      lastAtMost(breaks[FENCED_LINE]!, at, limit)
    ]) {
      if (option !== undefined && option > at) {
        cut = option

        break
      }
    }

    if (cut === undefined) {
      const space = text.slice(at, limit).search(/\s\S*$/)

      if (space > 0) {
        cut = at + space + 1
        skipWhitespace = true
      } else {
        cut = limit
      }
    }

    // A part that ends inside a code block closes it; the next one opens it again.
    const closing = fenceAt(cut)
    const body = text.slice(at, cut)
    const trimmed = skipWhitespace ? body.replace(/\s+$/, '') : body.replace(/(?:[ \t]*\r?\n)+$/, '')
    push(parts, reopen + trimmed + (closing ? `\n${closing.marker}` : ''))
    at = cut

    // A new part starts at its first line with words, outside code (blank lines are code's own).
    while (at < n && !fenceAt(at)) {
      const line = lineOf(at)

      if (starts[line] !== at || !blank[line]) {
        break
      }

      at = line + 1 < starts.length ? starts[line + 1]! : n
    }
  }

  // A guard, never expected to act: a part that still does not fit is cut by bytes alone.
  return parts.flatMap(part => (jsonBytes(part) <= maxBytes ? [part] : hardParts(part, maxBytes)))
}

function push(parts: string[], part: string) {
  if (part.trim()) {
    parts.push(part)
  }
}

/** Cut by bytes only, at code point boundaries. */
function hardParts(text: string, maxBytes: number): string[] {
  const parts: string[] = []
  let current = ''
  let bytes = 2

  for (const char of text) {
    const size = jsonBytes(char) - 2

    if (bytes + size > maxBytes && current) {
      parts.push(current)
      current = ''
      bytes = 2
    }

    current += char
    bytes += size
  }

  if (current.trim()) {
    parts.push(current)
  }

  return parts
}
