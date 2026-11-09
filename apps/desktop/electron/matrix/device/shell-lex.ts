/**
 * A forgiving shell lexer for the command classifiers (`drive-delete.ts`). It turns command text into
 * the simple commands a shell would run, in order, so a classifier sees `rm` after `&`, `;`, a
 * newline, `(`, `$(…)` or a backtick as well as after `&&` and `|`, and does not see an `rm` that
 * only sits inside a quote, a comment or a heredoc's prose as more than the text it is.
 *
 * It is not an interpreter. It expands nothing: a word keeps its `~`, `$VAR`, glob and `{a,b}` text
 * for the caller, and a substitution stays in its word as written. It never throws on text a real
 * shell would reject (an unterminated quote or substitution runs to the end, and a shell would not
 * run that command at all) — except for nesting deeper than a classifier follows.
 *
 * What it does, in the order a shell reads:
 * - separators: `;`, newline, `&`, `&&`, `||`, `|`, `|&`; a single `&` is a separator unless it is
 *   part of a redirection (`2>&1`, `&>file`);
 * - `(`/`)` subshells and the bodies of `$(…)`, backticks and `<(…)`/`>(…)`, anywhere in a command,
 *   as commands of their own inside an `enter`/`leave` pair (the caller scopes its state to it);
 * - quotes (`'…'`, `"…"` with their escapes, `$'…'`), backslash escapes and line continuations; each word
 *   also comes with a `marked` form that remembers what the quotes kept the shell from expanding (below);
 * - redirections, dropped with their target (`>file`, `2>&1`, `<<EOF`); a here-string's word is kept;
 * - comments (`#` at the start of a word), so an apostrophe in a comment cannot swallow what follows;
 * - heredocs: a body is DATA for the command that reads it (`cat > notes.md <<'EOF'`), and is read as commands
 *   only when a shell runs it: the command, or one it pipes into, is a shell, `eval`, `source`, or a program that
 *   runs one (`bash <<EOF`, `ssh host bash <<EOF`, `cat <<EOF | sh`, `bash -c "$(cat <<EOF …)"`). Such a body is
 *   read line by line as commands in its own scope, so an apostrophe in prose cannot swallow the commands after
 *   it. Data still holds the commands that an UNQUOTED delimiter's body runs itself: `$(…)` and backticks.
 *
 * It also expands braces ({@link expandBraces}), which a shell does before anything else.
 *
 * Quote provenance. A shell expands `~`, `$`, `*`, `?`, `[` and `{` only where they are not quoted: single
 * quotes expand nothing, double quotes only `$`, and a backslash or `$'…'` nothing. `ShellCommand.marked[i]` is
 * `words[i]` with each such character that the shell did NOT expand replaced by a private-use stand-in of the same
 * length (`markLiteral`; `unmark` undoes it), so a classifier that reads `~/x` as the home folder and `*` as a
 * wildcard can tell `'~/x'`, `"$HOME/x/{a,b}"` and `\*` from the real thing.
 */

import { readsShellFromStdin, runsText } from './shell-program'

/** One simple command: its words after quote removal, redirections dropped. */
export interface ShellCommand {
  readonly words: string[]
  /** `words`, with what was quoted or escaped marked as literal (see the header); the same length word for word. */
  readonly marked: string[]
  /** Its output feeds the next command (`|`, `|&`). */
  piped: boolean
}

/** A command, or the edge of a subshell, substitution or heredoc body (directory and variables are scoped to it). */
export type ShellItem = ShellCommand | 'enter' | 'leave'

/** The characters a shell expands when they are not quoted, in the order of their stand-ins from U+E000. */
const EXPANDING = '~$*?[{'
const STAND_IN = new Map([...EXPANDING].map((character, at) => [character, String.fromCharCode(0xe000 + at)]))
const STOOD_FOR = new Map([...STAND_IN].map(([character, standIn]) => [standIn, character]))
const STAND_INS = new RegExp(`[${[...STOOD_FOR.keys()].join('')}]`, 'g')

/** `text` as the shell kept it literal: each character it would have expanded becomes a stand-in (`$` stays when double quotes expand it). */
export function markLiteral(text: string, keepDollar = false): string {
  return text.replace(/[~$*?[{]/g, character => (keepDollar && character === '$' ? character : STAND_IN.get(character)!))
}

/** The characters themselves again: a word as it reads after quote removal. */
export function unmark(text: string): string {
  return text.replace(STAND_INS, standIn => STOOD_FOR.get(standIn)!)
}

/** How a shell reads the text it is adding to a word: expanded, expanded only for `$` (double quotes), or not at all. */
type Quote = 'plain' | 'double' | 'literal'

/** `bash -c "bash -c …"` and substitutions in substitutions are followed this deep. */
const MAX_DEPTH = 8

/** Nesting beyond what a classifier follows: the caller falls back to asking. */
export class ShellDepthError extends Error {}

/**
 * `shellFed`: the text is handed to a shell as commands (the body of `bash -c "$(…)"`), so a heredoc in it is a
 * script, whoever reads it.
 */
export function lexShell(text: string, depth = 0, shellFed = false): ShellItem[] {
  if (depth > MAX_DEPTH) {
    throw new ShellDepthError('shell nesting too deep')
  }

  return new Lexer(text, depth, shellFed).run()
}

type Target = 'plain' | 'heredoc' | 'heredoc-strip'

interface Heredoc {
  readonly delimiter: string
  readonly strip: boolean
  /** The delimiter was quoted or escaped: the body is literal, nothing in it runs. */
  readonly quoted: boolean
  /** The words of the command the heredoc is the input of (the array that becomes its `ShellCommand`). */
  readonly words: readonly string[]
}

class Lexer {
  private at = 0
  private word = ''
  private marked = ''
  private inWord = false
  /** Part of the word was quoted or escaped. */
  private quoted = false
  private words: string[] = []
  private markedWords: string[] = []
  /** The next completed word is a redirection target or heredoc delimiter, not an argument. */
  private target: Target | null = null
  private readonly heredocs: Heredoc[] = []
  private readonly items: ShellItem[] = []
  /** Where in `items` the line being read begins: the pipeline a heredoc feeds is on its line. */
  private lineStart = 0

  constructor(
    private readonly text: string,
    private readonly depth: number,
    private readonly shellFed: boolean
  ) {}

  run(): ShellItem[] {
    const text = this.text

    while (this.at < text.length) {
      const character = text[this.at]!

      if (character === ' ' || character === '\t' || character === '\r') {
        this.endWord()
        this.at += 1
      } else if (character === '\n') {
        this.endCommand(false)
        this.at += 1
        this.readHeredocs()
        this.lineStart = this.items.length
      } else if (character === ';') {
        this.endCommand(false)
        this.at += 1
      } else if (character === '(' || character === ')') {
        this.endCommand(false)
        this.items.push(character === '(' ? 'enter' : 'leave')
        this.at += 1
      } else if (character === '|') {
        const next = text[this.at + 1]

        this.endCommand(next !== '|')
        this.at += next === '|' || next === '&' ? 2 : 1
      } else if (character === '&') {
        const next = text[this.at + 1]

        if (next === '>') {
          // `&>file` and `&>>file` redirect both streams; they are not a separator.
          this.endWord()
          this.at += text[this.at + 2] === '>' ? 3 : 2
          this.target = 'plain'
        } else {
          this.endCommand(false)
          this.at += next === '&' ? 2 : 1
        }
      } else if (character === '<' || character === '>') {
        this.angle()
      } else if (character === '#' && !this.inWord) {
        // A comment runs to the end of the line; its quotes and commands are not the shell's.
        while (this.at < text.length && text[this.at] !== '\n') {
          this.at += 1
        }
      } else if (character === '\\') {
        const next = text[this.at + 1]

        if (next === undefined || next === '\n') {
          this.at += next === undefined ? 1 : 2
        } else {
          // `\*`, `\~`: the character is the shell's no longer.
          this.add(next, 'literal')
          this.quoted = true
          this.at += 2
        }
      } else if (character === "'") {
        this.single()
      } else if (character === '"') {
        this.double()
      } else if (character === '`') {
        this.backtick()
      } else if (character === '$') {
        this.dollar(false)
      } else {
        this.push(character)
        this.at += 1
      }
    }

    this.endCommand(false)

    return this.items
  }

  /** Text for the word: `word` has it after quote removal, `marked` also what the shell would not have expanded. */
  private add(text: string, quote: Quote): void {
    this.word += text
    this.marked += quote === 'plain' ? text : markLiteral(text, quote === 'double')
    this.inWord = true
  }

  private push(character: string): void {
    this.add(character, 'plain')
  }

  private endWord(): void {
    if (this.inWord) {
      const target = this.target

      if (target) {
        this.target = null

        if (target !== 'plain') {
          this.heredocs.push({ delimiter: this.word, strip: target === 'heredoc-strip', quoted: this.quoted, words: this.words })
        }
      } else {
        this.words.push(this.word)
        this.markedWords.push(this.marked)
      }
    }

    this.word = ''
    this.marked = ''
    this.inWord = false
    this.quoted = false
  }

  private endCommand(piped: boolean): void {
    this.endWord()
    this.target = null

    if (this.words.length) {
      this.items.push({ words: this.words, marked: this.markedWords, piped })
    }

    this.words = []
    this.markedWords = []
  }

  /** A redirection operator, or a process substitution `<(…)` / `>(…)`. */
  private angle(): void {
    const text = this.text

    if (text[this.at + 1] === '(') {
      this.substitute(this.at + 1, this.at)

      return
    }

    // `2>file`: the digits glued to the operator are a descriptor, not an argument.
    if (this.inWord && /^\d+$/.test(this.word)) {
      this.word = ''
      this.marked = ''
      this.inWord = false
      this.quoted = false
    } else {
      this.endWord()
    }

    const operator = /^(?:<<<|<<-|<<|<>|<&|<|>>|>\||>&|>)/.exec(text.slice(this.at, this.at + 3))![0]

    this.at += operator.length

    if (operator === '<<<') {
      // A here-string's word is the input (a script, for a shell): keep both as arguments.
      this.words.push(operator)
      this.markedWords.push(operator)
    } else {
      this.target = operator === '<<-' ? 'heredoc-strip' : operator === '<<' ? 'heredoc' : 'plain'
    }
  }

  private single(): void {
    const end = this.text.indexOf("'", this.at + 1)
    const stop = end < 0 ? this.text.length : end

    // Single quotes expand nothing.
    this.add(this.text.slice(this.at + 1, stop), 'literal')
    this.quoted = true
    this.at = end < 0 ? stop : end + 1
  }

  private double(): void {
    const text = this.text

    this.inWord = true
    this.quoted = true
    this.at += 1

    while (this.at < text.length) {
      const character = text[this.at]!

      if (character === '"') {
        this.at += 1

        return
      }

      if (character === '\\') {
        const next = text[this.at + 1]

        if (next === '\n') {
          this.at += 2
        } else if (next !== undefined && '$`"\\'.includes(next)) {
          this.add(next, 'literal')
          this.at += 2
        } else {
          this.add(character, 'double')
          this.at += 1
        }
      } else if (character === '$') {
        this.dollar(true)
      } else if (character === '`') {
        this.backtick()
      } else {
        // Double quotes expand `$`, and not `~`, a glob or a brace.
        this.add(character, 'double')
        this.at += 1
      }
    }
  }

  /** `$(…)`, `$((…))`, `${…}` and `$'…'`; any other `$` is an ordinary character. */
  private dollar(quoted: boolean): void {
    const text = this.text
    const next = text[this.at + 1]

    if (next === '(') {
      const close = matchParen(text, this.at + 1)

      // `$(( … ))` is arithmetic: no command runs in it.
      if (text[this.at + 2] === '(' && close > 0 && matchParen(text, this.at + 2) === close - 1) {
        this.add(text.slice(this.at, close + 1), 'plain')
        this.at = close + 1
      } else {
        this.substitute(this.at + 1, this.at)
      }

      return
    }

    if (next === '{') {
      const close = matchBrace(text, this.at + 1)

      if (close > 0) {
        // `${X:-$(cmd)}` runs `cmd` when X is unset: the substitutions in the braces are commands of their own.
        // The braces and what is in them are the shell's own syntax, kept as written for the caller to read.
        this.substitutionsIn(text.slice(this.at + 2, close))
        this.add(text.slice(this.at, close + 1), 'plain')
        this.at = close + 1

        return
      }

      // Never closed, or longer than a `${…}` is followed: the `{` is still the shell's syntax, not a brace that quotes could keep.
      this.add('${', 'plain')
      this.at += 2

      return
    }

    if (!quoted && next === "'") {
      let end = this.at + 2

      while (end < text.length && text[end] !== "'") {
        end += text[end] === '\\' ? 2 : 1
      }

      this.add(text.slice(this.at + 2, Math.min(end, text.length)), 'literal')
      this.quoted = true
      this.at = Math.min(end + 1, text.length)

      return
    }

    this.push('$')
    this.at += 1
  }

  /** The `$(…)` and backtick substitutions in the text of a `${…}`: they run when the expansion needs them. */
  private substitutionsIn(body: string): void {
    for (let at = 0; at < body.length; at++) {
      const character = body[at]

      if (character === '\\') {
        at += 1
      } else if (character === '$' && body[at + 1] === '(') {
        const close = matchParen(body, at + 1)

        this.nested(body.slice(at + 2, close < 0 ? body.length : close))

        if (close < 0) {
          return
        }

        at = close
      } else if (character === '`') {
        const close = skipBacktick(body, at)

        this.nested(body.slice(at + 1, close < 0 ? body.length : close))

        if (close < 0) {
          return
        }

        at = close
      }
    }
  }

  /** `$(…)` / `<(…)` / `>(…)` whose `(` is at `open`: the body runs (scoped); the word keeps its text. */
  private substitute(open: number, start: number): void {
    const text = this.text
    const close = matchParen(text, open)
    const end = close < 0 ? text.length : close + 1

    this.nested(text.slice(open + 1, close < 0 ? text.length : close))
    this.add(text.slice(start, end), 'plain')
    this.at = end
  }

  private backtick(): void {
    const text = this.text
    let end = this.at + 1
    let body = ''

    while (end < text.length && text[end] !== '`') {
      if (text[end] === '\\' && end + 1 < text.length && '`\\$'.includes(text[end + 1]!)) {
        body += text[end + 1]
        end += 2
      } else {
        body += text[end]
        end += 1
      }
    }

    this.nested(body)
    this.add(text.slice(this.at, Math.min(end + 1, text.length)), 'plain')
    this.at = Math.min(end + 1, text.length)
  }

  private nested(body: string): void {
    // A heredoc inside a substitution that a shell or `eval` is handed is a script: `bash -c "$(cat <<EOF … EOF)"`.
    const shellFed = this.shellFed || (body.includes('<<') && runsText(this.words))

    this.items.push('enter')

    for (const item of lexShell(body, this.depth + 1, shellFed)) {
      this.items.push(item)
    }

    this.items.push('leave')
  }

  /** The lines of a heredoc, up to its delimiter (which ends it, and is not part of it). */
  private heredocBody(delimiter: string, strip: boolean): string[] {
    const text = this.text
    const body: string[] = []

    while (this.at < text.length) {
      const newline = text.indexOf('\n', this.at)
      const line = text.slice(this.at, newline < 0 ? text.length : newline).replace(/\r$/, '')

      this.at = newline < 0 ? text.length : newline + 1

      if ((strip ? line.replace(/^\t+/, '') : line) === delimiter) {
        break
      }

      body.push(line)
    }

    return body
  }

  /** For each command of the line just ended: does it, or a command it pipes into, run its standard input as shell text? */
  private shellReaders(): Map<readonly string[], boolean> {
    const readers = new Map<readonly string[], boolean>()
    let downstream = false

    for (let at = this.items.length - 1; at >= this.lineStart; at--) {
      const item = this.items[at]!

      if (typeof item !== 'string') {
        downstream = readsShellFromStdin(item.words) || (item.piped && downstream)
        readers.set(item.words, downstream)
      }
    }

    return readers
  }

  /**
   * Called just after a newline: the bodies of the heredocs started on the line before it. A body is commands only
   * when a shell runs it (see the header); data otherwise, except that an unquoted delimiter's body still runs the
   * `$(…)` and backticks in it, whoever reads the rest.
   */
  private readHeredocs(): void {
    const heredocs = this.heredocs.splice(0)

    if (!heredocs.length) {
      return
    }

    const readers = this.shellReaders()

    for (const { delimiter, strip, quoted, words } of heredocs) {
      const body = this.heredocBody(delimiter, strip)

      if (!body.length) {
        continue
      }

      if (this.shellFed || readers.get(words)) {
        this.items.push('enter')

        for (const line of body) {
          for (const item of lexShell(line, this.depth + 1, this.shellFed)) {
            this.items.push(item)
          }
        }

        this.items.push('leave')
      } else if (!quoted) {
        this.substitutionsIn(body.join('\n'))
      }
    }
  }
}

/** Index of the `)` matching the `(` at `open`, skipping quotes, escapes and nested substitutions; -1 when there is none. */
export function matchParen(text: string, open: number): number {
  let depth = 0

  for (let at = open; at < text.length; at++) {
    const character = text[at]!

    if (character === '\\') {
      at += 1
    } else if (character === "'") {
      at = text.indexOf("'", at + 1)

      if (at < 0) {
        return -1
      }
    } else if (character === '"') {
      at = skipDouble(text, at)

      if (at < 0) {
        return -1
      }
    } else if (character === '`') {
      at = skipBacktick(text, at)

      if (at < 0) {
        return -1
      }
    } else if (character === '(') {
      depth += 1
    } else if (character === ')') {
      depth -= 1

      if (depth === 0) {
        return at
      }
    }
  }

  return -1
}

/** Index of the quote closing the `"` at `start`, or -1. */
function skipDouble(text: string, start: number): number {
  for (let at = start + 1; at < text.length; at++) {
    const character = text[at]!

    if (character === '\\') {
      at += 1
    } else if (character === '"') {
      return at
    } else if (character === '$' && text[at + 1] === '(') {
      at = matchParen(text, at + 1)

      if (at < 0) {
        return -1
      }
    } else if (character === '`') {
      at = skipBacktick(text, at)

      if (at < 0) {
        return -1
      }
    }
  }

  return -1
}

export function skipBacktick(text: string, start: number): number {
  for (let at = start + 1; at < text.length; at++) {
    if (text[at] === '\\') {
      at += 1
    } else if (text[at] === '`') {
      return at
    }
  }

  return -1
}

/**
 * A `${…}` is followed this far. Beyond it the `$` and `{` are ordinary characters and what is inside is read as
 * shell text, so a command in it is still seen; and a text of a hundred thousand unmatched `${` costs a window
 * each, not a scan to its end each.
 */
const MAX_BRACE = 512

/** Index of the `}` matching the `{` at `open` in shell text (quotes and escapes skipped), or -1. */
export function matchBrace(text: string, open: number): number {
  let depth = 0
  const stop = Math.min(text.length, open + MAX_BRACE)

  for (let at = open; at < stop; at++) {
    const character = text[at]!

    if (character === '\\') {
      at += 1
    } else if (character === "'") {
      at = text.indexOf("'", at + 1)

      if (at < 0) {
        return -1
      }
    } else if (character === '"') {
      at = skipDouble(text, at)

      if (at < 0) {
        return -1
      }
    } else if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth -= 1

      if (depth === 0) {
        return at
      }
    }
  }

  return -1
}

// ---------------------------------------------------------------------------------------------
// Brace expansion
// ---------------------------------------------------------------------------------------------

/** A word may expand to this many words; more, and the caller must decide without them. */
export const BRACE_LIMIT = 64

/** A word with a brace in it longer than this is not expanded (see `expandBraces`). */
const MAX_BRACE_WORD = 2048

class BraceOverflow extends Error {}

/**
 * Bash brace expansion of one word (quotes are already gone): `a{b,c}d` → `abd`, `acd`; nested
 * groups; `{1..3}`, `{a..c}`, `{01..10..3}`. A `{` after `$`, an unmatched group and a one-part
 * group are literal, as in bash. `null` when the word would produce more than `limit` words or
 * holds a sequence this cannot read: the caller then fails toward asking.
 */
export function expandBraces(word: string, limit = BRACE_LIMIT): string[] | null {
  // Finding the groups of a word is quadratic in its braces (every unmatched `{` scans to the end), and no
  // group a person wrote is this long: a long word with a brace in it is treated as unreadable, which asks.
  if (word.length > MAX_BRACE_WORD && word.includes('{')) {
    return null
  }

  const out: string[] = []

  try {
    expandInto(word, out, limit)
  } catch (error) {
    if (error instanceof BraceOverflow) {
      return null
    }

    throw error
  }

  return out
}

function expandInto(word: string, out: string[], limit: number): void {
  const group = firstGroup(word, limit)

  if (!group) {
    if (out.length >= limit) {
      throw new BraceOverflow()
    }

    out.push(word)

    return
  }

  for (const alternative of group.alternatives) {
    expandInto(word.slice(0, group.start) + alternative + word.slice(group.end + 1), out, limit)
  }
}

interface Group {
  start: number
  end: number
  alternatives: string[]
}

function firstGroup(word: string, limit: number): Group | null {
  for (let start = 0; start < word.length; start++) {
    if (word[start] === '$' && word[start + 1] === '{') {
      const close = matchPlain(word, start + 1)

      if (close > 0) {
        start = close
      }

      continue
    }

    if (word[start] !== '{') {
      continue
    }

    const end = matchPlain(word, start)

    if (end < 0) {
      continue
    }

    const inner = word.slice(start + 1, end)
    const parts = splitTop(inner)

    if (parts.length > 1) {
      return { start, end, alternatives: parts }
    }

    const sequence = expandSequence(inner, limit)

    if (sequence !== 'literal') {
      return { start, end, alternatives: sequence }
    }
  }

  return null
}

/** Index of the `}` matching the `{` at `open` in an already unquoted word, or -1. */
function matchPlain(word: string, open: number): number {
  let depth = 0

  for (let at = open; at < word.length; at++) {
    if (word[at] === '{') {
      depth += 1
    } else if (word[at] === '}') {
      depth -= 1

      if (depth === 0) {
        return at
      }
    }
  }

  return -1
}

/** The group's alternatives: split at commas that are not inside a nested group or a `${…}`. */
function splitTop(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let from = 0

  for (let at = 0; at < inner.length; at++) {
    const character = inner[at]

    if (character === '$' && inner[at + 1] === '{') {
      const close = matchPlain(inner, at + 1)

      if (close > 0) {
        at = close
      }
    } else if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth -= 1
    } else if (character === ',' && depth === 0) {
      parts.push(inner.slice(from, at))
      from = at + 1
    }
  }

  parts.push(inner.slice(from))

  return parts
}

/** `1..5`, `5..1`, `01..10`, `1..10..3`, `a..e`: the words, `'literal'` if it is no sequence, or an overflow. */
function expandSequence(inner: string, limit: number): string[] | 'literal' {
  if (!inner.includes('..')) {
    return 'literal'
  }

  const numbers = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(inner)
  const letters = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/.exec(inner)

  if (!numbers && !letters) {
    // Looks like a sequence and is not one this reads: do not guess.
    throw new BraceOverflow()
  }

  const [, first, last, stride] = (numbers ?? letters)!
  const from = numbers ? Number(first) : first!.charCodeAt(0)
  const to = numbers ? Number(last) : last!.charCodeAt(0)
  const step = Math.abs(Number(stride ?? 1)) || 1
  const count = Math.floor(Math.abs(to - from) / step) + 1

  if (count > limit) {
    throw new BraceOverflow()
  }

  const width = numbers && (/^-?0\d/.test(first!) || /^-?0\d/.test(last!)) ? Math.max(first!.replace('-', '').length, last!.replace('-', '').length) : 0
  const words: string[] = []

  for (let at = 0; at < count; at++) {
    const value = from <= to ? from + at * step : from - at * step

    if (!numbers) {
      words.push(String.fromCharCode(value))
    } else {
      const digits = String(Math.abs(value)).padStart(width, '0')

      words.push(value < 0 ? `-${digits}` : digits)
    }
  }

  return words
}
