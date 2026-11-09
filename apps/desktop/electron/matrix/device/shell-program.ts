/**
 * Which program a simple command runs, and which script a shell invocation runs: the part of reading
 * a command that sits between the lexer (`shell-lex.ts`, which turns text into simple commands) and a
 * classifier (`drive-delete.ts`, `policy.ts`). One definition, so every classifier sees through the
 * same things: the words that only open a compound command (`then`, `do`, `{`, `!`), variable
 * assignments, and programs that run the program after them (`sudo`, `env`, `nice -n 5`, `timeout 5`,
 * `setsid`, `arch -arm64`…), with the options of each that take a separate argument. It also says which
 * programs run their standard input as shell text (`readsShellFromStdin`): the lexer reads a heredoc body
 * as commands only for those.
 */
import path from 'node:path'

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

export const isAssignment = (word: string) => ASSIGNMENT.test(word)

/** The program a word names. macOS volumes are case-insensitive, so `RM -rf x` runs `/bin/rm`. */
export const programName = (word: string) => path.posix.basename(word).toLowerCase()

/** Programs that run the program after them; the value lists their options that take a separate argument. */
const WRAPPERS = new Map<string, ReadonlySet<string>>([
  ['arch', new Set(['-e', '-c'])],
  ['builtin', new Set()],
  ['busybox', new Set()],
  ['caffeinate', new Set(['-t', '-w'])],
  ['command', new Set()],
  ['doas', new Set(['-u', '-C'])],
  ['env', new Set(['-u', '-C', '-S', '-P'])],
  ['exec', new Set(['-a'])],
  ['gtimeout', new Set(['-s', '-k'])],
  ['ionice', new Set(['-c', '-n', '-p'])],
  ['nice', new Set(['-n'])],
  ['nohup', new Set()],
  ['setsid', new Set()],
  ['stdbuf', new Set(['-i', '-o', '-e'])],
  ['sudo', new Set(['-u', '-g', '-C', '-h', '-p', '-r', '-t', '-T', '-U', '-D', '-R'])],
  ['time', new Set()],
  ['timeout', new Set(['-s', '-k'])],
  ['unbuffer', new Set()]
])

/** These take a duration before the program. */
const DURATION_WRAPPERS = new Set(['gtimeout', 'timeout'])

/** Words that only open or close a compound command; the command they introduce follows. */
const RESERVED = new Set(['!', '{', '}', 'case', 'coproc', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'function', 'if', 'then', 'until', 'while'])

/** Programs that run a script given as text. */
export const SHELLS = new Set(['ash', 'bash', 'dash', 'fish', 'ksh', 'sh', 'zsh'])

export interface UnwrappedCommand {
  /** The program that really runs, lower-cased basename; empty when the words hold none (`FOO=1`, `sudo -n`). */
  readonly program: string
  readonly args: string[]
  /** The wrapper programs seen through, outermost first (`['env', 'sudo']` for `env A=1 sudo id`). */
  readonly wrappers: string[]
}

/** Where the program word is, and the wrappers on the way to it. */
function locateProgram(words: readonly string[], onAssignment?: (assignment: string) => void): { at: number; wrappers: string[] } {
  const wrappers: string[] = []
  // An index, not `shift()`: a command of a hundred thousand words must not cost a copy per word.
  let at = 0

  while (at < words.length && RESERVED.has(words[at]!)) {
    at += 1
  }

  for (;;) {
    while (at < words.length && ASSIGNMENT.test(words[at]!)) {
      onAssignment?.(words[at]!)
      at += 1
    }

    const name = programName(words[at] ?? '')
    const valued = WRAPPERS.get(name)

    if (!valued) {
      break
    }

    wrappers.push(name)
    at += 1

    // The wrapper's own options (and their arguments), then a duration for `timeout`.
    while (at < words.length && words[at]!.startsWith('-')) {
      const option = words[at]!

      at += 1

      if (option === '--') {
        break
      }

      if (valued.has(option)) {
        at += 1
      }
    }

    if (DURATION_WRAPPERS.has(name) && /^\d/.test(words[at] ?? '')) {
      at += 1
    }
  }

  return { at, wrappers }
}

/**
 * The program and arguments of one command, seen through reserved words, assignments and wrappers.
 * `onAssignment` is told of each variable assignment on the way (`A=1 sudo B=2 id`), for a caller
 * that tracks variables.
 */
export function unwrapCommand(words: readonly string[], onAssignment?: (assignment: string) => void): UnwrappedCommand {
  const { at, wrappers } = locateProgram(words, onAssignment)

  return { program: programName(words[at] ?? ''), args: words.slice(at + 1), wrappers }
}

/** The program a command runs (as `unwrapCommand`), without copying its arguments: `runsText` is asked of every substitution, so it must stay linear. */
function programOf(words: readonly string[]): string {
  return programName(words[locateProgram(words).at] ?? '')
}

const FIND_OPTIONS = /^-[HLPEXdsx]$/

/** The start paths of a `find` and its expression, from the words after `find`; no start path means `.`. */
export function findParts(args: readonly string[]): { starts: string[]; expression: string[] } {
  let at = 0
  const starts: string[] = []

  // Leading options: `-H -L -P -E -X -d -s -x`, BSD `-f <path>`, `-D <opts>`, `-O <n>`.
  while (at < args.length) {
    const word = args[at]!

    if (FIND_OPTIONS.test(word)) {
      at += 1
    } else if (word === '-f' && args[at + 1] !== undefined) {
      starts.push(args[at + 1]!)
      at += 2
    } else if (word === '-D' || word === '-O') {
      at += 2
    } else {
      break
    }
  }

  // Start paths are the words before the first expression (`-name`, `!`, `(`).
  const first = args.findIndex((word, index) => index >= at && (word.startsWith('-') || word === '!' || word === '(' || word === ')' || word === ','))

  starts.push(...args.slice(at, first < 0 ? args.length : first))

  return { starts, expression: first < 0 ? [] : args.slice(first) }
}

/** The script of a shell invocation (`bash -c '…' $0 $1…`, `sh <<< '…'`) with its positional parameters, or null. */
export function shellScript(args: readonly string[]): { text: string; positional: string[] } | null {
  const flag = args.findIndex(word => /^-[A-Za-z]*c[A-Za-z]*$/.test(word))

  if (flag >= 0 && args[flag + 1] !== undefined) {
    return { text: args[flag + 1]!, positional: args.slice(flag + 2) }
  }

  const here = args.indexOf('<<<')

  return here >= 0 && args[here + 1] !== undefined ? { text: args[here + 1]!, positional: [] } : null
}

/** `xargs` options that take a separate argument; the command it runs follows the last option. */
const XARGS_VALUED = new Set(['-I', '-J', '-L', '-n', '-P', '-R', '-S', '-s', '-E', '-d', '-a'])

/** The command `xargs` runs, from its arguments. */
export function xargsCommand(args: readonly string[]): string[] {
  let at = 0

  while (at < args.length && args[at]!.startsWith('-')) {
    const option = args[at]!

    at += 1

    if (option === '--') {
      break
    }

    if (XARGS_VALUED.has(option)) {
      at += 1
    }
  }

  return args.slice(at)
}

/** Programs that run a command given as ONE string, here or elsewhere: `ssh host "rm -rf ~"`, `tmux new 'rm -rf ~'`. */
export const RUNNERS = new Set(['at', 'chroot', 'colima', 'docker', 'kubectl', 'limactl', 'mosh', 'nsenter', 'parallel', 'podman', 'screen', 'script', 'ssh', 'sshpass', 'tmux', 'watch'])

/** Beyond this many programs running programs (`xargs xargs …`) a command is read as running a shell: it asks. */
const MAX_RUNNING = 8

/** Options of a shell that take a separate argument; the first word after them is the script file. */
const SHELL_VALUED = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file'])

/** Options of `ssh` that take a separate argument; the host follows them, then the command. */
const SSH_VALUED = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w'])

/** What `source` and `.` read when they are given the standard input. */
const STDIN_FILE = /^(?:\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/

/** A shell invocation that reads its script from the standard input: `-s`, or no `-c` text and no script file (`bash`, `sh -x`, `bash -o errexit`). */
function takesScriptFromStdin(args: readonly string[]): boolean {
  for (let at = 0; at < args.length; at++) {
    const word = args[at]!

    if (word === '--') {
      return at + 1 >= args.length
    }

    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word)) {
      return false
    }

    if (/^-[A-Za-z]*s[A-Za-z]*$/.test(word)) {
      return true
    }

    if (SHELL_VALUED.has(word)) {
      at += 1
    } else if (!/^[-+]/.test(word)) {
      return false
    }
  }

  return true
}

/** Whether a word, or a piece of one that holds a command (`'bash -s'`), names a shell. */
const namesShell = (words: readonly string[]) => words.some(word => word.split(/[\s;&|()`'"]+/).some(piece => SHELLS.has(programName(piece))))

/** What `ssh` runs: the words after its host. Nothing means a login shell on the other side. */
function sshCommand(args: readonly string[]): string[] {
  let at = 0

  const skipOptions = () => {
    while (at < args.length && args[at]!.startsWith('-')) {
      const option = args[at]!

      at += 1

      if (option === '--') {
        return
      }

      if (SSH_VALUED.has(option)) {
        at += 1
      }
    }
  }

  skipOptions()
  // The host, and then OpenSSH reads options again: `ssh host -tt`.
  at += 1
  skipOptions()

  return args.slice(at)
}

/**
 * Whether a command whose standard input is a heredoc (or a pipe) runs that input as shell text: a shell
 * (`bash`, `sh -s`, `sudo zsh`), `eval`, `source`/`.` of the standard input, `at`, or a program that runs one
 * (`ssh host bash`, `ssh host`, `xargs sh`, `docker exec -i c sh`). Anything else (`cat`, `tee`, `python3 -`, `psql`)
 * only reads it as data, whatever the text says.
 */
export function readsShellFromStdin(words: readonly string[], depth = 0): boolean {
  const { program, args, wrappers } = unwrapCommand(words)

  // `sudo -s`, `sudo -i`, `doas -s`: no command to run, and an administrator's shell instead (`sudo -v` and `sudo -l` run none).
  if (!program) {
    return wrappers.some(wrapper => wrapper === 'sudo' || wrapper === 'doas') && words.some(word => word === '--shell' || word === '--login' || /^-[A-Za-z]*[si][A-Za-z]*$/.test(word))
  }

  if (SHELLS.has(program)) {
    return takesScriptFromStdin(args)
  }

  // `su`, `su - root`: the login shell, unless it is given a command with `-c`.
  if (program === 'su') {
    return !args.some(word => /^(?:--command(?:=|$)|-[A-Za-z]*c$)/.test(word))
  }

  if (program === 'eval' || program === 'at') {
    return true
  }

  if (program === 'source' || program === '.') {
    return args.some(word => STDIN_FILE.test(word))
  }

  if (depth >= MAX_RUNNING) {
    return true
  }

  if (program === 'xargs') {
    return readsShellFromStdin(xargsCommand(args), depth + 1)
  }

  if (program === 'ssh') {
    const remote = sshCommand(args)

    return remote.length === 0 || namesShell(remote)
  }

  return RUNNERS.has(program) && namesShell(args)
}

/** Whether a command runs text it is handed as shell commands (`bash -c "$(…)"`, `eval "$(…)"`, `source <(…)`, `ssh host "$(…)"`). */
export function runsText(words: readonly string[]): boolean {
  const program = programOf(words)

  return SHELLS.has(program) || program === 'eval' || program === 'source' || program === '.' || RUNNERS.has(program)
}
