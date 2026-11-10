/**
 * Best-effort classification of a device command into the protected capabilities it touches
 * (S1 build plan §4, WS-4 `device/policy.ts`). This is what makes an approval prompt appear **up
 * front**, before the command runs, instead of after a Seatbelt failure.
 *
 * Classification is advisory, never the enforcement boundary: Seatbelt (`seatbelt.ts`) is. Anything
 * this misses that still touches the protected set simply fails under the sandbox, and the device
 * tells the brain to retry with an explicit `needs`. So this errs toward naming a capability when a
 * command plausibly uses it — a false prompt is cheap; a missed enforcement is not (but enforcement is
 * Seatbelt's job regardless).
 *
 * The program-based classes (`sudo`, `ssh_agent`, `keychain`, `persistence`, `cloud_cli`) read the text
 * the way a shell does (`shell-lex.ts`, `shell-program.ts`): every simple command counts, after `;`, `&`,
 * `&&`, `||`, `|`, a newline, `(`, `{`, `then`/`do`, inside `$(…)`, backticks and `<(…)`, in a heredoc a
 * shell reads (`bash <<EOF`), in `sh -c '…'`, `eval`, `xargs …` and `find -exec …`, or fed to a shell with
 * `echo '…' | sh`. A word in a quote or a comment is text, not a command, and so is a heredoc body that only
 * something like `cat` reads. Text the lexer will not follow (nesting beyond what it reads) is classified by
 * every word in it: it asks.
 */
import type { DeviceCapability, DeviceProtectedCapability, DeviceTool } from './contracts'
import { deletesDriveInBulk, type DriveDeleteContext } from './drive-delete'
import { lexShell, type ShellCommand, ShellDepthError, type ShellItem } from './shell-lex'
import { findParts, programName, RUNNERS, SHELLS, shellScript, unwrapCommand, xargsCommand } from './shell-program'

/** Which base capability a tool needs in the grant's scopes. */
export function toolScope(tool: DeviceTool): DeviceCapability {
  switch (tool) {
    case 'terminal':
      return 'terminal'

    case 'mac_source':

    case 'read_file':

    case 'write_file':

    case 'patch':

    case 'search_files':
      return 'files'

    case 'computer_use':
      return 'computer'

    case 'send_file':
      return 'send_file'
  }
}

const PRIVILEGE_PREFIXES = new Set(['sudo', 'su', 'doas'])

interface CommandWords {
  /** The real program word of each simple command, lower-cased basename. */
  readonly programs: string[]
  /** Whether any simple command runs under a privilege prefix (`sudo ls`, `env FOO=1 sudo -u x id`). */
  privileged: boolean
  /** Whether any simple command is a recursive delete aimed at the disk root, the home folder or a system folder (`broadPath`). */
  broadDelete: boolean
}

const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir'])
/** Programs whose output is plain text a shell can be fed: `echo 'sudo id' | sh`. */
const FEEDERS = new Set(['echo', 'print', 'printf'])

/** Scripts inside scripts (`shell-lex.ts` follows 8 levels), and commands run by commands (`xargs`, `find -exec`), are followed this deep. */
const MAX_NESTING = 8

/** `-r`, `-R`, `-rf`, `-fr`, `--recursive`. */
const RECURSIVE =/^(?:-[a-z]*r[a-z]*|--recursive)$/i

/** The operands of a command's arguments: the words that are not options, and every word after `--`. */
function operandsOf(args: readonly string[]): string[] {
  const operands: string[] = []
  let options = true

  for (const word of args) {
    if (options && word === '--') {
      options = false
    } else if (!options || !word.startsWith('-')) {
      operands.push(word)
    }
  }

  return operands
}

/** The plain words an `echo`/`printf` writes into a pipe to this command (`echo ~ | xargs rm -rf`). */
function fedWords(previous: ShellCommand | null): string[] {
  if (!previous?.piped) {
    return []
  }

  const feeder = unwrapCommand(previous.words)

  return FEEDERS.has(feeder.program) ? feeder.args.filter(word => !word.startsWith('-')) : []
}

/**
 * A recursive `rm` among `words` aimed at a broad target: the command's own (`rm -rf ~`, `sudo rm -rf /`),
 * one it runs (`ssh host rm -rf ~`), or the one `xargs` runs on what is piped into it. A word is a word:
 * `echo "rm -rf ~"` holds one, and the commands around this one are other commands.
 */
function removesBroadly(words: readonly string[], fed: readonly string[]): boolean {
  // The first `rm` is the command and every word after it is its argument (`rm -rf rm ~` removes `~` too), which
  // also keeps this linear in the words of a command, however many `rm` words an input repeats.
  const at = words.findIndex(word => programName(word) === 'rm')

  if (at < 0) {
    return false
  }

  const args = words.slice(at + 1)
  const dashes = args.indexOf('--')
  const operands = operandsOf(args)

  if (words.slice(0, at).some(before => programName(before) === 'xargs')) {
    operands.push(...fed)
  }

  return (dashes < 0 ? args : args.slice(0, dashes)).some(arg => RECURSIVE.test(arg)) && operands.some(broadPath)
}

/** A `find` among `words` that deletes (`-delete`, `-exec rm`, or `xargs rm` on its output) from a broad start path. */
function findsBroadly(words: readonly string[], viaXargs: boolean): boolean {
  const at = words.findIndex(word => programName(word) === 'find')

  if (at < 0) {
    return false
  }

  const { starts, expression } = findParts(words.slice(at + 1))
  const removes = viaXargs || expression.includes('-delete') || findCommands(expression).some(command => unwrapCommand(command).program === 'rm')

  return removes && starts.some(broadPath)
}

/** The commands `find` runs on what it lists (`-exec sudo chown root {} \;`), each up to its `;` or `+`. */
function findCommands(args: readonly string[]): string[][] {
  const commands: string[][] = []

  for (let at = 0; at < args.length; at++) {
    if (FIND_EXEC.has(args[at]!)) {
      let end = at + 1

      while (end < args.length && args[end] !== ';' && args[end] !== '+') {
        end += 1
      }

      commands.push(args.slice(at + 1, end))
      at = end
    }
  }

  return commands
}

/**
 * The simple commands that are really `case` patterns (`ssh|scp)`): the words before a `)` that closes
 * no `(`, and the alternatives chained to them with `|`. They name no program that runs.
 */
function casePatterns(items: readonly ShellItem[]): Set<number> {
  const patterns = new Set<number>()
  let open = 0

  items.forEach((item, at) => {
    if (item === 'enter') {
      open += 1
    } else if (item === 'leave') {
      if (open > 0) {
        open -= 1

        return
      }

      let back = at - 1

      while (back >= 0 && typeof items[back] !== 'string') {
        patterns.add(back)
        const earlier = items[back - 1]
        back = earlier !== undefined && typeof earlier !== 'string' && earlier.piped ? back - 1 : -1
      }
    }
  })

  return patterns
}

/** Every simple command of `text`, read the way a shell reads it (`shell-lex.ts`): separators, subshells, substitutions, heredocs, quotes. */
function collect(text: string, depth: number, found: CommandWords): void {
  const items = lexShell(text, depth)
  const patterns = casePatterns(items)
  let previous: ShellCommand | null = null

  items.forEach((item, at) => {
    if (typeof item === 'string') {
      previous = null

      return
    }

    if (!patterns.has(at)) {
      visit(item.words, previous, depth, found)
    }

    previous = item
  })
}

/** One simple command: its program (seen through wrappers, `shell-program.ts`), and the commands that program runs. */
function visit(words: readonly string[], previous: ShellCommand | null, depth: number, found: CommandWords): void {
  // `xargs xargs xargs …` is followed as far as scripts are (`shell-lex.ts` MAX_DEPTH): beyond that the caller asks.
  if (depth > MAX_NESTING) {
    throw new ShellDepthError('commands nested too deep')
  }

  // A broad delete, in this command's own words (`rm -rf ~`) or in a command it runs (`ssh host rm -rf ~`).
  if (removesBroadly(words, fedWords(previous)) || findsBroadly(words, false)) {
    found.broadDelete = true
  }

  // `find ~ -type f | xargs rm`: what `xargs` removes is what the `find` before it lists.
  if (previous?.piped && words.some(word => programName(word) === 'xargs') && words.some(word => programName(word) === 'rm') && findsBroadly(previous.words, true)) {
    found.broadDelete = true
  }

  const { program, args, wrappers } = unwrapCommand(words)

  if (wrappers.some(wrapper => PRIVILEGE_PREFIXES.has(wrapper))) {
    found.privileged = true
  }

  if (!program) {
    return
  }

  // `su` has no program to see through to: whatever it runs runs as someone else.
  if (PRIVILEGE_PREFIXES.has(program)) {
    found.privileged = true

    return
  }

  found.programs.push(program)

  if (RUNNERS.has(program)) {
    // The command runs elsewhere or later, so its programs are not asked about (`ssh host "sudo reboot"` is
    // not this Mac's sudo), but a mass delete in it is as irreversible as a local one.
    for (const arg of args.filter(word => /\s/.test(word))) {
      const there: CommandWords = { programs: [], privileged: false, broadDelete: false }

      collect(arg, depth + 1, there)
      found.broadDelete ||= there.broadDelete
    }
  }

  if (SHELLS.has(program)) {
    const script = shellScript(args)

    if (script) {
      collect(script.text, depth + 1, found)
    } else if (previous?.piped) {
      // `echo 'sudo id' | sh`, `printf '%s\n' 'sudo id' | bash`: the text a shell is fed.
      const feeder = unwrapCommand(previous.words)

      if (FEEDERS.has(feeder.program)) {
        for (const text of feeder.args.filter(word => !word.startsWith('-'))) {
          collect(text.replaceAll('\\n', '\n'), depth + 1, found)
        }
      }
    }
  } else if (program === 'eval') {
    collect(args.join(' '), depth + 1, found)
  } else if (program === 'xargs') {
    visit(xargsCommand(args), null, depth + 1, found)
  } else if (program === 'find') {
    for (const command of findCommands(args)) {
      visit(command, null, depth + 1, found)
    }
  }
}

/**
 * Text the lexer will not follow (nesting beyond what it reads, a parser surprise) cannot be split into
 * commands, so every word may be the program of one and the command asks whenever its words could be a protected
 * program or a mass delete. One pass over the words and no pattern that can backtrack: this runs on the
 * worst text a command can hold.
 */
function unreadable(command: string): CommandWords {
  const programs = command.split(/[^A-Za-z0-9_.@+/-]+/).filter(Boolean).map(programName)
  const names = new Set(programs)
  const paths = command.split(/[\s;&|()`'"<>]+/).filter(Boolean)
  const recursive = names.has('rm') && paths.some(word => RECURSIVE.test(word))
  const finds = names.has('find') && (names.has('rm') || paths.includes('-delete'))

  return {
    programs,
    privileged: programs.some(word => PRIVILEGE_PREFIXES.has(word)),
    broadDelete: (recursive || finds) && paths.some(broadPath)
  }
}

/** The program of every simple command in `command`, whether any of them runs as an administrator, and whether any is a broad delete. */
function commandWords(command: string): CommandWords {
  const found: CommandWords = { programs: [], privileged: false, broadDelete: false }

  try {
    collect(command, 0, found)
  } catch {
    return unreadable(command)
  }

  return found
}

const CLOUD_CLIS = new Set(['aws', 'gcloud', 'gsutil', 'kubectl', 'az', 'doctl', 'heroku', 'vercel', 'flyctl', 'fly', 'wrangler'])

/**
 * Protected capabilities the Mac lets through WITHOUT asking (owner decision 2026-10-20: agents must
 * never prompt for routine work — "asking for 15 consecutive Touch ID prompts" during one package
 * install). This OVERRIDES the G0 "reuse window 0 / every protected action asks" design. These commands
 * are still classified and lifted in the sandbox only when named, still audited, and still end on Stop;
 * only the Touch ID is gone. Package-registry credentials are not a capability at all any more (see
 * `REGISTRY_CREDENTIALS`).
 */
export const SILENT_CAPABILITIES: ReadonlySet<DeviceProtectedCapability> = new Set<DeviceProtectedCapability>([
  'network_new_host',
  'exec_downloaded',
  'persistence',
  'ssh_agent',
  'other_agent_write',
  'gui_upload'
])

/** The capabilities that still take the owner's Touch ID, once per agent per task window
 * (`ApprovalWindow`): administrator commands, mass deletes, the Keychain, saved browser passwords and
 * sessions, and cloud credentials that can spend money. */
export const ASKING_CAPABILITIES: ReadonlySet<DeviceProtectedCapability> = new Set<DeviceProtectedCapability>([
  'sudo',
  'bulk_destructive',
  'keychain',
  'browser_store',
  'cloud_cli'
])

/** Top-level folders whose recursive deletion is catastrophic (macOS). */
const SYSTEM_ROOTS = new Set(['users', 'system', 'applications', 'library', 'private', 'etc', 'var', 'usr', 'bin', 'sbin', 'opt', 'volumes'])

const KEY_HOME_FOLDERS = new Set(['library', 'documents', 'desktop', 'pictures', 'downloads', 'movies', 'music', 'applications'])

/**
 * One path argument of a delete: broad when it names the disk root, the home folder itself, a top-level
 * system folder, a user's home under /Users, or a wildcard directly at one of those levels (or the folder a
 * trailing wildcard empties). Deeper paths are ordinary.
 */
function broadPath(input: string): boolean {
  // `X/*`, `X/.*` and `X/` all wipe X's contents: judge X itself. By index, not by pattern: a pattern for
  // trailing slashes backtracks quadratically on a long run of them, and `/*/*/*…` would re-slice per step.
  let end = input.length

  for (;;) {
    while (end > 0 && input[end - 1] === '/') {
      end -= 1
    }

    if (end >= 3 && input.startsWith('/.*', end - 3)) {
      end -= 3
    } else if (end >= 2 && input.startsWith('/*', end - 2)) {
      end -= 2
    } else {
      break
    }
  }

  const word = input.slice(0, end) || '/'

  if (word === '/' || word === '*' || word === '.*') {
    return true
  }

  const home = word.match(/^(?:~|\$HOME|\$\{HOME\})(?:\/(.*))?$/)

  if (home) {
    const rest = (home[1] ?? '').split('/').filter(Boolean)

    // The home folder itself, or one of its key top-level folders (Documents, Desktop, Library, …).
    return rest.length === 0 || (rest.length === 1 && (rest[0] === '*' || KEY_HOME_FOLDERS.has(rest[0]!.toLowerCase())))
  }

  const parts = word.startsWith('/') ? word.slice(1).split('/').filter(Boolean) : []

  if (parts.length === 0) {
    return false
  }

  const top = parts[0]!.toLowerCase()

  if (parts.length === 1) {
    return SYSTEM_ROOTS.has(top) || parts[0] === '*'
  }

  // Anything directly inside a system root (/Library/Preferences, /System/Library, /usr/bin…), and a user's home under /Users.
  if (parts.length === 2) {
    return SYSTEM_ROOTS.has(top)
  }

  // A key folder of a home under /Users (/home/example/Documents).
  return parts.length === 3 && top === 'users' && KEY_HOME_FOLDERS.has(parts[2]!.toLowerCase())
}

/**
 * Classify a raw shell command into the protected capabilities it plausibly uses. Returns an empty set
 * for ordinary work (file edits in the workspace, builds, searches, git over the proxy).
 */
export function classifyCommand(command: string, drive?: DriveDeleteContext | null): Set<DeviceProtectedCapability> {
  const caps = new Set<DeviceProtectedCapability>()
  const { programs, privileged, broadDelete } = commandWords(command)
  const lower = command.toLowerCase()

  if (privileged) {
    caps.add('sudo')
  }

  for (const program of programs) {
    if (program === 'ssh' || program === 'scp' || program === 'sftp' || program === 'ssh-add') {
      caps.add('ssh_agent')
    }

    if (program === 'security') {
      caps.add('keychain')
    }

    if (program === 'crontab' || program === 'launchctl' || program === 'at') {
      caps.add('persistence')
    }

    if (program === 'defaults' && /loginitems|launchagents/.test(lower)) {
      caps.add('persistence')
    }

    if (CLOUD_CLIS.has(program)) {
      caps.add('cloud_cli')
    }
  }

  // git pushing/pulling over ssh rides the agent too.
  // Clone/init create .git/config, a trust handoff surface denied without approval.
  // The windows are bounded (a subcommand and a URL sit within a few hundred characters of `git`): an
  // unbounded scan per `git` word is quadratic on a long text.
  if (programs.includes('git') && /\bgit\b[^\n;&|]{0,200}\b(clone|init)\b/.test(lower)) {
    caps.add('persistence')
  }

  if (programs.includes('git') && /\bgit(@|\+ssh|\s+(push|pull|fetch|clone)\b.{0,500}\bgit@)/.test(lower)) {
    caps.add('ssh_agent')
  }

  // Writing to a shell startup file or a LaunchAgent is persistence regardless of the program used.
  if (/>>?\s*~?\/?\.(zshrc|zprofile|zshenv|bashrc|bash_profile|profile)\b/.test(command)) {
    caps.add('persistence')
  }

  if (/library\/launchagents/.test(lower) && /(>|cp|mv|tee|install|ln)\b/.test(lower)) {
    caps.add('persistence')
  }

  // Reading a browser credential store.
  if (/(library\/cookies|application support\/(google\/chrome|chromium|firefox|arc|bravesoftware)|library\/safari)/.test(lower)) {
    caps.add('browser_store')
  }

  // Broad destructive deletes: only a recursive delete or `find -delete` aimed at the disk root, the home
  // folder itself, a top-level system folder, or a wildcard at those levels. Clearing a project's build
  // folder (`rm -rf /home/example/app/dist`, `rm -rf node_modules`) is ordinary work and never asks
  // Preserve the documented device access and approval boundaries.
  // Any recursive rm (`-r`, `-R`, `--recursive`, with or without -f) aimed at a broad target, and
  // `find <broad> … -delete` or `find <broad> … -exec rm …` (also via xargs rm): each command of the
  // line is read on its own, so `rm -rf ~;`, `(rm -rf ~)` and `$(rm -rf ~)` count and `rm -rf build && ls /` does not.
  if (broadDelete) {
    caps.add('bulk_destructive')
  }

  // The owner's Drive sits below a writable root, so the kernel cannot tell a mass delete of it from
  // an ordinary one: the classifier does (see drive-delete.ts). Same class, same Touch ID, same window.
  if (drive && deletesDriveInBulk(command, drive)) {
    caps.add('bulk_destructive')
  }

  return caps
}

/** Structured computer_use actions that count as a GUI upload needing approval are decided in the GUI
 * broker (it sees the target window); this classifier only covers terminal/file tools. */
export interface ExecuteClassificationInput {
  readonly tool: DeviceTool
  readonly args: Record<string, unknown>
  readonly needs?: readonly DeviceProtectedCapability[]
  readonly proposedEffect?: 'ordinary' | DeviceProtectedCapability
}

/**
 * The device's own view of which protected capabilities an Execute touches: its declared `needs`, its
 * `proposedEffect` when protected, and — for terminal commands — whatever `classifyCommand` finds.
 * Admission prompts for any of these not covered by a standing grant or a fresh approval.
 */
export function classifyExecute(input: ExecuteClassificationInput, drive?: DriveDeleteContext | null): Set<DeviceProtectedCapability> {
  const caps = new Set<DeviceProtectedCapability>(input.needs ?? [])

  if (input.proposedEffect && input.proposedEffect !== 'ordinary') {
    caps.add(input.proposedEffect)
  }

  if (input.tool === 'terminal') {
    const command = typeof input.args.command === 'string' ? input.args.command : ''

    for (const cap of classifyCommand(command, drive)) {
      caps.add(cap)
    }
  }

  return caps
}
