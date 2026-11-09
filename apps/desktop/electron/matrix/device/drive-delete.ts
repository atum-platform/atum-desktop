/**
 * Drive-aware mass-delete detection (review P1, 2026-10-24).
 *
 * Seatbelt can pin a Drive root in place but cannot tell `rm file` from `rm -rf <Drive>`: both are
 * ordinary unlinks below a writable root, and the real kernel lets `rm -rf <Drive>` delete every
 * ordinary file before it fails on the root itself. So the approval classifier, which already
 * gates deletes aimed at the disk root and the home folder (`policy.ts` `broadPath`), must
 * know where the Drive is. A command is `bulk_destructive` here when it deletes recursively, or
 * with a wildcard, the Drive root, EVERYTHING at its top level (`<Drive>/*`), or a parent of it
 * (`~/Atum`, `~`, `/Users`), or moves such a thing out (`mv <Drive>/* elsewhere`), or syncs it
 * away (`rsync --delete`), or runs an unfiltered `find <Drive> -delete`. Ordinary edits stay
 * silent: `rm <Drive>/Q3/old.md`, `rm -rf <Drive>/Q3`, `mv a b`, `find <Drive> -name '*.tmp' -delete`.
 *
 * This is a classifier over the command text, like the rest of `policy.ts`; it is not a sandbox.
 * The text is read the way a shell reads it (`shell-lex.ts`): every command after `;`, `&`, `&&`,
 * `||`, `|`, a newline, `(`, `{`, `then`/`do`, inside `$(…)`/backticks, in a heredoc a shell reads or
 * after `bash -c`/`eval` is judged, and braces are expanded first (`rm -rf <Drive>/{*,.*}`), bounded:
 * a brace group that is too large to expand makes any recursive delete under a Drive root count as
 * bulk, so the answer errs toward asking.
 *
 * Words are read as the shell expands them, and only where it does. `~`, a glob and a brace are the
 * shell's in unquoted text; double quotes keep `$VAR` and `${…}` and nothing else; single quotes,
 * backslashes and `$'…'` keep nothing (`shell-lex.ts` marks the rest as literal). So `rm -rf '~/Atum/Drive'`
 * names a folder called `~` below the working directory, and `rm -rf "<Drive>/{*,.*}"` a file called
 * `{*,.*}`: neither is the Drive. `${NAME}`, `${NAME:?…}`, `${NAME:-w}`, `${NAME:=w}` and `${NAME:+w}` are
 * resolved (see `parameters`); any other `${…}` (`${X%/}`, `${#X}`, `${X/a/b}`, `${!X}`, `${A[@]}`) cannot be
 * read, so a recursive delete of a path built on one counts as bulk: it may be the Drive.
 *
 * What it does NOT see: a delete done by an interpreter (`python -c 'shutil.rmtree(...)'`,
 * `node -e`), a path built by command substitution or an unresolved variable, `git clean` run from
 * inside the Drive, and a deep path reached through a symlink created earlier. Those remain the
 * agent's own judgement, recorded in the session log as the residual risk.
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'

import { expandBraces, lexShell, markLiteral, matchBrace, matchParen, type ShellCommand, type ShellItem, skipBacktick, unmark } from './shell-lex'
import { findParts, isAssignment, programName, SHELLS, shellScript, unwrapCommand } from './shell-program'

export interface DriveDeleteContext {
  readonly home: string
  /** Every Drive root this Mac has learned (current and past): a delete of any is mass. */
  readonly roots: readonly string[]
  /** The directory commands start in. Defaults to a working copy's depth under `~/Atum Tasks`. */
  readonly cwd?: string
  /** Test seam; production realpaths what exists. */
  readonly realpath?: (value: string) => string
}

const ASSIGNERS = new Set(['declare', 'export', 'local', 'readonly', 'typeset'])
const DELETERS = new Set(['rm', 'shred', 'trash', 'unlink'])

/** Programs whose arguments `xargs` hands to a deleter when piped from them. */
const FEEDERS = new Set(['echo', 'print', 'printf'])

/** A wildcard or brace the shell would expand. One it did not (quoted, escaped) is a stand-in character (`shell-lex.ts` `markLiteral`), which this does not match. */
const GLOB = /[*?[{]/

/** Stands in a value for text that cannot be read (`${X%/}`, `${!X}`, `${A[@]}`): it may be the Drive, so a recursive delete of it asks. */
const OPAQUE = String.fromCharCode(0xe0ff)

/** `{}` as xargs sees it: the braces as written, or with the `{` the shell left literal because it was quoted. */
const PLACEHOLDER = new RegExp(`[{${markLiteral('{')}]\\}`, 'g')

/** A `${…}` nested in a default is followed this deep; deeper is not read. */
const MAX_EXPANSION = 8

/** A variable name after a `$`; sticky, so a long text is read once. */
const NAME = /[A-Za-z_][A-Za-z0-9_]*|\d/y

/** The inside of a `${…}` this reads: a name, and optionally one of `:-` `-` `:=` `=` `:?` `?` `:+` `+` with its word. */
const FORM = /^([A-Za-z_][A-Za-z0-9_]*|\d+)(?:(:?)([-=?+])([\s\S]*))?$/

/** A `${NAME:=…}` or `${NAME=…}` somewhere in a word: expanding the word assigns NAME. */
const ASSIGNING = /\$\{[A-Za-z_][A-Za-z0-9_]*:?=/

/** One glob segment as a case-insensitive regex (APFS is case-insensitive by default). */
function segmentPattern(segment: string): RegExp {
  let source = ''

  for (let at = 0; at < segment.length; at++) {
    const character = segment[at]!

    if (character === '*') {
      source += '[^/]*'
    } else if (character === '?') {
      source += '[^/]'
    } else if (character === '[') {
      const end = segment.indexOf(']', at + 2)

      if (end < 0) {
        source += '\\['
      } else {
        const body = unmark(segment.slice(at + 1, end)).replace(/^[!^]/, '^').replace(/\\/g, '\\\\')
        source += `[${body}]`
        at = end
      }
    } else if (character === '{') {
      const end = segment.indexOf('}', at + 1)

      if (end < 0) {
        source += '\\{'
      } else {
        const choices = unmark(segment.slice(at + 1, end)).split(',').map(choice => choice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        source += `(?:${choices.join('|')})`
        at = end
      }
    } else {
      source += unmark(character).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }

  return new RegExp(`^${source}$`, 'iu')
}

/** True when a glob's last segment can empty a folder: only wildcards and dots (`*`, `.*`, `[!.]*`, `*.*`). */
function emptiesFolder(segment: string): boolean {
  const bare = segment.replace(/\[[^\]]*\]/g, '')

  return /[*?]/.test(bare) && /^[*?.]+$/.test(bare)
}

function split(value: string): string[] {
  return value.split('/').filter(Boolean)
}

const isRecursive = (flag: string) => /^-[a-zA-Z]*[rR]/.test(flag) || flag === '--recursive'

/** `find` tests that match every file whatever their argument (it is `*`), and the actions that need no test to be an ordinary edit. */
const FIND_PATTERN_TESTS = new Set(['-iname', '-ipath', '-iregex', '-iwholename', '-lname', '-name', '-path', '-regex', '-wholename'])
const FIND_NARROWING_TESTS = /^-(?:newer|anewer|cnewer|newer[A-Za-z]{2}|[acm]time|[acm]min|size|user|group|uid|gid|perm|links|inum|samefile|xtype|fstype|flags|context)$/
const FIND_NARROWING_FLAGS = new Set(['-empty', '-executable', '-nogroup', '-nouser', '-readable', '-writable'])
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir'])

/** A name pattern that matches every file: only `*` (and `?` beside one). */
const matchesEverything = (pattern: string, regex: boolean) => (regex ? /^\^?(?:\.[*+])+\$?$/.test(pattern) : /^[*?]+$/.test(pattern) && pattern.includes('*'))

/** `-exec rm …`, `-exec sh -c '… rm …'`, `-exec mv …`: the command a `find` runs on what it lists removes or moves it. */
function execRemoves(command: string[]): boolean {
  const program = programName(command[0] ?? '')

  if (DELETERS.has(program) || program === 'mv') {
    return true
  }

  return SHELLS.has(program) && command.slice(1).some(word => /(?:^|[\s;&|(`])(?:rm|unlink|shred|trash|mv)\b/i.test(word))
}

/**
 * Whether a `find` expression removes files without narrowing which: no test at all, or only
 * `-type`, depth limits, `-name '*'` and the like. A test narrows only when it comes BEFORE the
 * action that deletes (`-delete -name x` deletes everything; find acts as it walks), is not negated,
 * and is not itself a match-all. Alternatives (`-o`) each need one.
 */
function removesUnfiltered(expression: string[], viaXargs: boolean): boolean {
  const branches = [{ narrowed: false, removes: false }]
  let negated = false

  for (let at = 0; at < expression.length; at++) {
    const word = expression[at]!
    const branch = branches[branches.length - 1]!

    if (word === '-o' || word === '-or' || word === ',') {
      branches.push({ narrowed: false, removes: false })
      negated = false
    } else if (word === '!' || word === '-not') {
      negated = !negated
    } else if (word === '-delete') {
      branch.removes = true
    } else if (FIND_EXEC.has(word)) {
      let end = at + 1

      while (end < expression.length && expression[end] !== ';' && expression[end] !== '+') {
        end += 1
      }

      if (execRemoves(expression.slice(at + 1, end))) {
        branch.removes = true
      }

      at = end
    } else if (FIND_PATTERN_TESTS.has(word)) {
      at += 1

      // The pattern is `find`'s own to read, not the shell's: `-name '*'` is `*` however it was quoted.
      if (!branch.removes && !negated && !matchesEverything(unmark(expression[at] ?? ''), word.endsWith('regex'))) {
        branch.narrowed = true
      }

      negated = false
    } else if (FIND_NARROWING_TESTS.test(word)) {
      at += 1

      if (!branch.removes && !negated) {
        branch.narrowed = true
      }

      negated = false
    } else if (FIND_NARROWING_FLAGS.has(word)) {
      if (!branch.removes && !negated) {
        branch.narrowed = true
      }

      negated = false
    } else if (word.startsWith('-')) {
      // `-type`, `-maxdepth`, `-print`…: they filter nothing here, and a `!` only reaches the next primary.
      negated = false
    }
  }

  // The branches that remove; when find only lists (its output goes to `xargs rm`), all of them.
  const relevant = branches.some(branch => branch.removes) ? branches.filter(branch => branch.removes) : viaXargs ? branches : []

  return relevant.some(branch => !branch.narrowed)
}

interface Scope {
  cwd: string
  vars: Map<string, string>
}

/**
 * The classifier. `root` hits are tested on resolved absolute paths split into segments; a pattern
 * matches when each of its leading segments matches the root's (globs allowed), so `~/At*`, `/home/example`
 * and `~/Atum/Dr*` count as the parent, the grandparent and the root itself.
 */
class Detector {
  private readonly roots: string[][]
  private vars = new Map<string, string>()
  private cwd: string
  /** `cd -` goes back to it; `pushd` keeps the directories `popd` returns to. */
  private oldCwd: string | null = null
  private readonly dirs: string[] = []
  private readonly scopes: Scope[] = []

  constructor(private readonly context: DriveDeleteContext) {
    const realpath = context.realpath ?? ((value: string) => realpathSync.native(value))
    const forms = new Set<string>()

    for (const root of context.roots) {
      forms.add(path.posix.normalize(root))

      try {
        forms.add(realpath(root))
      } catch {
        // A missing root is still its spelled path.
      }
    }

    this.roots = [...forms].map(split).filter(parts => parts.length > 0)
    this.cwd = context.cwd ?? path.posix.join(context.home, 'Atum Tasks', 'agent', 'task')
  }

  /** The value of a variable the text has set, or of one the shell sets (`HOME`, `PWD`, `OLDPWD`, `USER`, `LOGNAME`); null when it is not known. */
  private lookup(name: string): string | null {
    if (name === 'HOME') {
      return this.context.home
    }

    if (name === 'PWD') {
      return this.cwd
    }

    return this.vars.get(name) ?? (name === 'OLDPWD' ? this.oldCwd : name === 'USER' || name === 'LOGNAME' ? path.posix.basename(this.context.home) : null)
  }

  /**
   * The word with its leading tilde expanded: `~` is the home folder, `~+` and `~-` the working directories, `~name` the
   * home of that user, which is this one's only when it is this one's own name. A tilde the shell does not expand (quoted)
   * is a stand-in by now (`shell-lex.ts`); another user's home is left as it is, a path that is not the Drive.
   */
  private tildes(text: string): string {
    const match = /^~([+-]|[A-Za-z0-9._-]*)(?=\/|$)/.exec(text)

    if (!match) {
      return text
    }

    const name = match[1]!
    const home = name === '' ? this.context.home : name === '+' ? this.cwd : name === '-' ? (this.oldCwd ?? '\0') : name === path.posix.basename(this.context.home) ? this.context.home : null

    return home === null ? text : home + text.slice(match[0].length)
  }

  /** A word's value, or null when it cannot be judged. It may hold stand-ins for literal characters, and OPAQUE. */
  private expand(word: string): string | null {
    // `$(pwd)` is the one substitution that can be read.
    const value = this.parameters(this.tildes(word).replace(/\$\(pwd\)|`pwd`/g, () => this.cwd), 0)

    // Text that cannot be read may be the Drive; an unresolved variable or a command substitution cannot be judged.
    return value.includes(OPAQUE) || !(value.includes('\0') || /\$\(|`|[<>]\(/.test(value)) ? value : null
  }

  /**
   * `$NAME` and `${NAME…}` as a shell reads them, from the variables the text set and the ones the shell sets (`lookup`):
   * `${NAME}`, `${NAME:?msg}` and `${NAME?}` are NAME; `${NAME:-w}`, `${NAME-w}` and `${NAME:=w}` are NAME when it is
   * known and not empty and `w` when not (`:=` keeps `w` as NAME's value too); `${NAME:+w}` is `w` when NAME is set.
   * An unset NAME is unresolved (`\0`). Any other `${…}` (length, trimming, replacing, slicing, indirection, arrays,
   * `${@}`, one that is never closed or too long to follow) is not read, and stands for OPAQUE, as do `$@` and `$*`.
   * A command substitution is a scope of its own: it is kept as written.
   */
  private parameters(value: string, depth: number): string {
    // Its own regex: a default is read by this same method, in the middle of a scan.
    const special = /[$`]/g
    let out = ''
    let from = 0

    for (;;) {
      const found = special.exec(value)

      if (!found) {
        return out + value.slice(from)
      }

      const at = found.index
      const next = value[at + 1]

      out += value.slice(from, at)
      from = at + 1

      if (found[0] === '`' || next === '(') {
        // A command substitution runs in a scope of its own and cannot be read here: kept as written, not expanded.
        const close = found[0] === '`' ? skipBacktick(value, at) : matchParen(value, at + 1)

        from = close < 0 ? value.length : close + 1
        out += value.slice(at, from)
      } else {
        const close = next === '{' ? matchBrace(value, at + 1) : -1

        if (close > 0) {
          out += this.braced(value.slice(at + 2, close), depth)
          from = close + 1
        } else if (next === '{') {
          // Never closed, or longer than the lexer follows a `${…}`: not read, whatever padding it was given.
          out += OPAQUE
          from = at + 2
        } else if (next === '@' || next === '*') {
          // The positional parameters: any number of words, which are not followed.
          out += OPAQUE
          from = at + 2
        } else {
          NAME.lastIndex = at + 1

          const name = NAME.exec(value)?.[0]

          out += name === undefined ? '$' : (this.lookup(name) ?? '\0')
          from = at + 1 + (name?.length ?? 0)
        }
      }

      special.lastIndex = from
    }
  }

  /** The inside of one `${…}`. */
  private braced(inner: string, depth: number): string {
    const form = FORM.exec(inner)

    if (!form || depth >= MAX_EXPANSION) {
      return OPAQUE
    }

    const name = form[1]!
    const operator = form[3]
    const own = this.lookup(name)

    if (operator === undefined || operator === '?') {
      return own ?? '\0'
    }

    const word = () => this.alternative(form[4]!, depth + 1)

    if (operator === '+') {
      return own === null ? '' : word()
    }

    // `-` and `=`: NAME when it is set and not empty, otherwise the word.
    if (own !== null && own !== '') {
      return own
    }

    const value = word()

    if (operator === '=' && !value.includes('\0')) {
      this.vars.set(name, unmark(value))
    }

    return value
  }

  /** The word of `${NAME:-word}`: quotes removed, a leading tilde and the expansions inside it resolved. */
  private alternative(word: string, depth: number): string {
    const text = this.tildes(word.replace(/\\([\s\S])|["']/g, (_all, escaped: string | undefined) => escaped ?? ''))

    return this.parameters(text.replace(/\$\(pwd\)|`pwd`/g, () => this.cwd), depth)
  }

  /** A word as an absolute path, null when it cannot be judged, OPAQUE when it cannot be read. */
  private absolute(word: string): string | null {
    const value = this.expand(word)

    if (value === null) {
      return null
    }

    if (value.includes(OPAQUE) || (!value.startsWith('/') && this.cwd.includes(OPAQUE))) {
      return OPAQUE
    }

    return path.posix.normalize(value.startsWith('/') ? value : path.posix.join(this.cwd, value))
  }

  /** The candidate spellings of one path: as written, and the real path when it exists and has no glob. */
  private spellings(absolute: string): string[] {
    const out = [absolute]

    if (!GLOB.test(absolute)) {
      try {
        // A real path is all literal: a `[` or `*` in a folder's name is part of the name.
        out.push(markLiteral((this.context.realpath ?? ((value: string) => realpathSync.native(value)))(unmark(absolute))))
      } catch {
        // Does not exist (yet).
      }
    }

    return out
  }

  private matches(parts: string[], root: string[], count: number): boolean {
    return count <= root.length && parts.slice(0, count).every((part, at) => (GLOB.test(part) ? segmentPattern(part).test(root[at]!) : unmark(part).toLowerCase() === root[at]!.toLowerCase()))
  }

  /** The root itself, or a parent of it: removing it removes the Drive. */
  private reachesRoot(parts: string[]): boolean {
    return this.roots.some(root => parts.length > 0 && this.matches(parts, root, parts.length))
  }

  /** `<Drive>/*`: the root's own top level, emptied by a wildcard. */
  private emptiesRoot(parts: string[]): boolean {
    const last = parts[parts.length - 1]

    return parts.length > 1 && !!last && GLOB.test(last) && emptiesFolder(last)
      && this.roots.some(root => parts.length === root.length + 1 && this.matches(parts, root, root.length))
  }

  /** The folder part of a path (up to its last `/`) lies on the way to a root or inside one. */
  private overlapsRoot(parts: string[]): boolean {
    return this.roots.some(root => this.matches(parts, root, Math.min(parts.length, root.length)))
  }

  /**
   * One resolved path with no braces left. `opaque`: a recursive delete, which asks when the path cannot be read
   * (OPAQUE) because it may be the Drive.
   */
  private judgeAbsolute(absolute: string | null, recursive: boolean, opaque: boolean): boolean {
    if (absolute === null) {
      return false
    }

    if (absolute === OPAQUE) {
      return opaque
    }

    return this.spellings(absolute).some(candidate => {
      const parts = split(candidate)

      // `/` itself is already `policy.ts`'s (`broadPath`); a bare parent is a parent of every Drive.
      return (recursive && this.reachesRoot(parts)) || this.emptiesRoot(parts)
    })
  }

  /** One path word with no braces left. */
  private judge(word: string, recursive: boolean, opaque: boolean): boolean {
    return this.judgeAbsolute(this.absolute(word), recursive, opaque)
  }

  /** A path argument of a delete: braces expanded first (`<Drive>/{*,.*}`), and asked about when they cannot be. */
  private target(word: string, recursive: boolean, opaque = false): boolean {
    const alternatives = expandBraces(word)

    if (alternatives) {
      return alternatives.some(alternative => this.judge(alternative, recursive, opaque))
    }

    // Too many alternatives, or a sequence this cannot read: any recursive delete under a Drive root
    // (judged on the folder before the first brace) counts, and so does a group at the Drive's top level.
    const absolute = this.absolute(word)

    if (absolute === null) {
      return false
    }

    if (absolute === OPAQUE) {
      return opaque
    }

    const brace = absolute.indexOf('{')
    const before = brace < 0 ? absolute : absolute.slice(0, brace)
    const folder = split(before.slice(0, before.lastIndexOf('/') + 1))
    const wildcard = absolute.replace(/\{[^{}]*\}/g, '*').replace(/\{[^{}]*\}/g, '*')

    return (recursive && this.overlapsRoot(folder)) || this.judgeAbsolute(wildcard, recursive, opaque)
  }

  /** True when this command text mass-deletes the Drive. */
  detect(command: string): boolean {
    if (!this.roots.length) {
      return false
    }

    return this.run(lexShell(command), 0)
  }

  private enter(): void {
    this.scopes.push({ cwd: this.cwd, vars: new Map(this.vars) })
  }

  private leave(): void {
    const scope = this.scopes.pop()

    if (scope) {
      this.cwd = scope.cwd
      this.vars = scope.vars
    }
  }

  private run(items: ShellItem[], depth: number): boolean {
    // `find <Drive> … | xargs rm` removes what find lists, wherever in the text the xargs sits.
    const viaXargs = items.some(item => typeof item !== 'string' && this.xargsRemoves(item.words) !== null)
    let previous: ShellCommand | null = null
    const base = this.scopes.length

    try {
      for (const [at, item] of items.entries()) {
        if (item === 'enter') {
          this.enter()
          previous = null
        } else if (item === 'leave') {
          if (this.scopes.length > base) {
            this.leave()
          }

          previous = null
        } else {
          if (this.simple(item, previous, viaXargs, depth)) {
            return true
          }

          // `arr=(~/Atum/Drive)`: `$arr` is the array's first word, and its words are not followed.
          if (items[at + 1] === 'enter') {
            this.arrayAssigned(item)
          }

          previous = item
        }
      }

      return false
    } finally {
      // Unclosed `(` at the end of a text must not leak its directory into the caller.
      while (this.scopes.length > base) {
        this.leave()
      }
    }
  }

  /** A command that ends in `NAME=` and is followed by a group assigned an array: its value cannot be read. */
  private arrayAssigned(command: ShellCommand): void {
    const name = /^([A-Za-z_][A-Za-z0-9_]*)\+?=$/.exec(command.words[command.words.length - 1] ?? '')?.[1]

    if (name) {
      this.vars.set(name, OPAQUE)
    }
  }

  /** The program and arguments of one command, seen through reserved words, assignments and wrappers (`shell-program.ts`). */
  private unwrap(words: readonly string[], assign: boolean): { program: string; args: string[] } {
    return unwrapCommand(words, assign ? assignment => this.assign(assignment) : undefined)
  }

  private assign(assignment: string): void {
    const at = assignment.indexOf('=')
    const value = this.expand(assignment.slice(at + 1))

    // A variable holds characters: whether a `*` in it is a wildcard is for the place it is used (unquoted) to say.
    if (value !== null) {
      this.vars.set(assignment.slice(0, at), unmark(value))
    }
  }

  /** `xargs … rm`: the deleter's arguments, or null when this is not an xargs that removes. */
  private xargsRemoves(words: readonly string[]): { recursive: boolean; operands: string[] } | null {
    const { program, args } = this.unwrap(words, false)

    if (program !== 'xargs') {
      return null
    }

    const at = args.findIndex(word => DELETERS.has(programName(word)))

    if (at < 0) {
      return null
    }

    const rest = args.slice(at + 1)

    return {
      recursive: programName(args[at]!) === 'trash' || rest.some(word => word.startsWith('-') && isRecursive(word)),
      operands: rest.filter(word => !word.startsWith('-'))
    }
  }

  /** Another text run as commands: a script, an `eval`. It starts in this directory and cannot change it. */
  private runText(text: string, depth: number, positional: string[] = []): boolean {
    this.enter()

    try {
      positional.forEach((word, index) => {
        const value = this.expand(word)

        if (value !== null) {
          this.vars.set(String(index), unmark(value))
        }
      })

      return this.run(lexShell(text, depth + 1), depth + 1)
    } finally {
      this.leave()
    }
  }

  private bindLoop(args: string[]): void {
    const [name, keyword, ...items] = args

    if (keyword !== 'in' || !name || !/^[A-Za-z_]\w*$/.test(name) || !items.length) {
      return
    }

    // The body runs once per item; judge it against the one that reaches the Drive, if any does. The variable
    // holds each name the list expands to, so a wildcard in it stays one wherever it is quoted: `for f in *; do rm -rf "$f"; done`.
    const chosen = items.find(item => this.target(item, true)) ?? items[0]!
    const value = this.expand(chosen)

    if (value !== null) {
      this.vars.set(name, unmark(value))
    }
  }

  private simple(command: ShellCommand, previous: ShellCommand | null, viaXargs: boolean, depth: number): boolean {
    // `${NAME:=…}` assigns wherever it is written, even as the argument of `:`: `: "${D:=~/Atum/Drive}"; rm -rf "$D"`.
    for (const word of command.marked) {
      if (ASSIGNING.test(word)) {
        this.parameters(word, 0)
      }
    }

    // The marked words: what the shell expands is as it was written, what it did not is a stand-in (`shell-lex.ts`).
    const { program, args } = this.unwrap(command.marked, true)

    if (!program) {
      return false
    }

    if (program === 'for' || program === 'select') {
      this.bindLoop(args)

      return false
    }

    if (program === 'cd' || program === 'pushd' || program === 'popd') {
      const to = args.find(word => word === '-' || !word.startsWith('-'))
      const next = program === 'popd' ? (this.dirs.pop() ?? null) : to === undefined ? this.context.home : to === '-' ? this.oldCwd : this.absolute(to)

      if (next) {
        if (program === 'pushd') {
          this.dirs.push(this.cwd)
        }

        this.oldCwd = this.cwd
        this.cwd = next
      }

      return false
    }

    if (ASSIGNERS.has(program)) {
      for (const word of args) {
        if (isAssignment(word)) {
          this.assign(word)
        }
      }

      return false
    }

    // A script is text the shell reads again from the start, so what quoting protected from this shell is not protected from that one.
    if (SHELLS.has(program)) {
      const script = shellScript(args)

      return script !== null && this.runText(unmark(script.text), depth, script.positional)
    }

    if (program === 'eval') {
      return this.runText(unmark(args.join(' ')), depth)
    }

    const flags = args.filter(word => word.startsWith('-'))
    const dashes = args.indexOf('--')
    const operands = args.filter((word, at) => (dashes >= 0 ? at > dashes : !word.startsWith('-')))
    const recursive = flags.some(isRecursive)

    if (program === 'rm' || program === 'unlink' || program === 'shred' || program === 'trash') {
      // A recursive delete of a path that cannot be read (`"${X%/}"`) may be the Drive, so it asks.
      const deep = recursive || program === 'trash'

      return operands.some(operand => this.target(operand, deep, deep))
    }

    if (program === 'find') {
      return this.find(args, viaXargs)
    }

    if (program === 'xargs') {
      const removal = this.xargsRemoves(command.marked)

      if (!removal) {
        return false
      }

      // `echo ~/Atum/Drive | xargs rm -rf`: the feeder's words are the paths. And a path built on the
      // placeholder (`xargs -I{} rm -rf <Drive>/{}`) stands for whatever the list holds there, however
      // the placeholder was quoted (xargs, not the shell, replaces it): a wildcard.
      const feeder = previous?.piped ? this.unwrap(previous.marked, false) : null
      const fed = feeder && FEEDERS.has(feeder.program) ? feeder.args.filter(word => !word.startsWith('-')) : []
      const named = removal.operands.map(operand => (operand.includes('/') ? operand.replace(PLACEHOLDER, '*') : operand))

      return [...named, ...fed].some(operand => this.target(operand, removal.recursive, removal.recursive))
    }

    if (program === 'mv') {
      // Moving the Drive's contents out empties it as surely as deleting them.
      return operands.slice(0, -1).some(source => this.target(source, true))
    }

    if (program === 'rsync') {
      // `--delete` removes at the destination; `--remove-source-files` at the sources. Either is a recursive delete
      // of a path that, when it cannot be read, may be the Drive.
      let hit = false

      // rsync takes any unambiguous prefix of a long option: `--del` is `--delete-during`.
      if (flags.some(flag => flag.startsWith('--del'))) {
        hit ||= operands.slice(-1).some(operand => this.target(operand, true, true))
      }

      if (flags.some(flag => flag.startsWith('--remove-s'))) {
        hit ||= operands.slice(0, -1).some(operand => this.target(operand, true, true))
      }

      return hit
    }

    return false
  }

  /** `find <start…> <expression>`: bulk when it removes from a Drive root, its top level or a parent, and nothing narrows what it removes. */
  private find(args: string[], viaXargs: boolean): boolean {
    const { starts, expression } = findParts(args)

    // With no path find starts at `.`. A start that cannot be read may be the Drive: removing from it unfiltered asks.
    return (starts.length ? starts : ['.']).some(start => this.target(start, true, true)) && removesUnfiltered(expression, viaXargs)
  }
}

/** The conservative answer when the text could not be read: ask when it names a delete and a Drive root. */
function mentionsDelete(command: string, context: DriveDeleteContext): boolean {
  const lower = command.toLowerCase()

  return /\b(?:rm|find|mv|rsync|unlink|shred|trash)\b/.test(lower)
    && context.roots.some(root => {
      const name = path.posix.basename(root).toLowerCase()

      return lower.includes(root.toLowerCase()) || (name.length > 0 && lower.includes(name))
    })
}

/** True when `command` removes or empties a Drive root, everything at its top level, or a parent of it. */
export function deletesDriveInBulk(command: string, context: DriveDeleteContext): boolean {
  try {
    return new Detector(context).detect(command)
  } catch {
    // A parser surprise (or nesting beyond what is followed) must not become a silent pass on a delete aimed at the Drive: ask.
    return mentionsDelete(command, context)
  }
}
