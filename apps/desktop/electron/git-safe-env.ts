// Git config-injection hardening for the desktop's own git calls
// (GHSA-7x36-8jrh-v4pw, "GitSpawn"). TypeScript mirror of
// `hermes_cli/_subprocess_compat.py` (noninteractive_git_env / harden_git_argv /
// hardened_git_env / user_git_env), backported from NousResearch/hermes-agent
// f6234d00c5 plus the Atum additions documented there.
//
// The coding rail and the review pane run `git status` / `git diff` / `git log`
// against the session folder as soon as it is opened. A folder delivered with its
// `.git` directory intact (zip, sync folder, USB stick) can name a program in an
// execution-sink setting — core.fsmonitor, hooks, pager, log.showSignature +
// gpg.program, or an attribute-scoped diff/filter driver — and run it as the
// user. Automatic reads therefore run under `hardenedGitEnv` with `hardenGitArgv`
// applied; operations the user explicitly clicks (stage, commit, push, new lane)
// run under `userGitEnv`, which keeps the user's identity, credential helpers and
// hooks exactly like a terminal would.

import { execFile } from 'node:child_process'
import os from 'node:os'

export const NO_DRIVER_DIFF_FLAGS = ['--no-ext-diff', '--no-textconv'] as const
export const NO_SUBMODULE_RECURSION_FLAG = '--ignore-submodules=dirty'

const DIFF_RENDERING_SUBCOMMANDS = new Set(['diff', 'show', 'log', 'blame'])
const SUBMODULE_RECURSING_SUBCOMMANDS = new Set(['status', 'diff'])

const GIT_VALUE_OPTS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
  '--attr-source',
  '--super-prefix'
])

// Subcommands the desktop only runs because the user clicked something. They keep
// the user's own git (see userGitEnv). Everything else is an automatic read.
const USER_OP_SUBCOMMANDS = new Set([
  'add',
  'checkout',
  'clean',
  'commit',
  'fetch',
  'init',
  'pull',
  'push',
  'reset',
  'switch'
])

const USER_OP_WORKTREE_VERBS = new Set(['add', 'remove', 'move', 'prune'])

export function gitSubcommandIndex(args: readonly string[]): number {
  let i = 0

  while (i < args.length) {
    const tok = String(args[i])

    if (GIT_VALUE_OPTS.has(tok)) {
      i += 2

      continue
    }

    if (tok.startsWith('-')) {
      i += 1

      continue
    }

    return i
  }

  return -1
}

export function gitSubcommand(args: readonly string[]): string {
  const i = gitSubcommandIndex(args)

  return i >= 0 ? String(args[i]) : ''
}

// A caller-supplied base ref (the review pane's `baseRef`) is interpolated into
// a git argv as a positional — a diff range `<base>...HEAD` or a `<base> -- <p>`
// endpoint. A value beginning `-` is parsed as an option (`--ext-diff` would
// re-enable the external diff driver `--no-ext-diff` just turned off, since a
// later positional-looking option still wins), so it must never reach the argv.
// Conservative on purpose: every base this code produces is a 40-char SHA or an
// `origin/<branch>` ref name, both of which pass.
// First char excludes `-` (no option injection); subsequent chars allow it.
const SAFE_GIT_REF = /^[0-9A-Za-z._/@^~{}:=][0-9A-Za-z._/@^~{}:=+-]*$/

export function isSafeGitRef(ref: string | null | undefined): ref is string {
  if (!ref || typeof ref !== 'string') {
    return false
  }

  if (ref.includes('..')) {
    return false
  }

  return SAFE_GIT_REF.test(ref)
}

// Insert hardening flags right after the subcommand: diff-driver flags for
// diff/show/log/blame, `--ignore-submodules=dirty` for status/diff (a populated
// submodule would otherwise get a child `git status` under its own config).
export function hardenGitArgv(args: readonly string[]): string[] {
  const out = args.map(String)
  const i = gitSubcommandIndex(out)

  if (i < 0) {
    return out
  }

  const sub = out[i]
  const rest = out.slice(i + 1)
  const extra: string[] = []

  if (DIFF_RENDERING_SUBCOMMANDS.has(sub)) {
    extra.push(...NO_DRIVER_DIFF_FLAGS)
  }

  if (
    SUBMODULE_RECURSING_SUBCOMMANDS.has(sub) &&
    !rest.some(a => a.startsWith('--ignore-submodules')) &&
    !(sub === 'diff' && rest.includes('--no-index'))
  ) {
    extra.push(NO_SUBMODULE_RECURSION_FLAG)
  }

  return extra.length ? [...out.slice(0, i + 1), ...extra, ...rest] : out
}

type Env = Record<string, string | undefined>

function stripConfigInjection(env: Env): void {
  for (const key of Object.keys(env)) {
    if (key === 'GIT_CONFIG_PARAMETERS' || key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) {
      delete env[key]
    }
  }

  delete env.GIT_CONFIG_COUNT
}

function writeConfigBlock(env: Env, overrides: Record<string, string>): void {
  const start = Number.parseInt(env.GIT_CONFIG_COUNT || '0', 10) || 0
  const entries = Object.entries(overrides)

  entries.forEach(([key, value], offset) => {
    env[`GIT_CONFIG_KEY_${start + offset}`] = key
    env[`GIT_CONFIG_VALUE_${start + offset}`] = value
  })
  env.GIT_CONFIG_COUNT = String(start + entries.length)
}

// Env for automatic git reads against an untrusted folder: no prompts, no
// global/system config, and every execution sink pinned to an inert value in the
// command-line config scope (which outranks the repo's .git/config).
export function nonInteractiveGitEnv(base: Env = process.env): Env {
  const env: Env = { ...base }
  const devnull = os.devNull

  env.GIT_TERMINAL_PROMPT = '0'
  env.GCM_INTERACTIVE = 'Never'
  stripConfigInjection(env)
  env.GIT_CONFIG_GLOBAL = devnull
  env.GIT_CONFIG_SYSTEM = devnull
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_PAGER = 'cat'
  env.PAGER = 'cat'
  env.GIT_EDITOR = 'true'
  delete env.GIT_EXTERNAL_DIFF
  writeConfigBlock(env, {
    'credential.helper': '',
    'core.askPass': '',
    'core.fsmonitor': 'false',
    'core.untrackedCache': 'false',
    'core.hooksPath': devnull,
    'core.pager': 'cat',
    'core.editor': 'true',
    'sequence.editor': 'true',
    'diff.external': '',
    'log.showSignature': 'false',
    'gpg.program': 'gpg',
    'gpg.ssh.program': 'ssh-keygen',
    'gpg.x509.program': 'gpgsm',
    'status.submoduleSummary': 'false',
    // diff.submodule=diff recurses a child `git diff` into a submodule whose
    // recorded commit changed (under that submodule's own config); `short`
    // renders the two SHAs with no child spawn (GHSA-7x36-8jrh-v4pw).
    'diff.submodule': 'short',
    'protocol.ext.allow': 'never'
  })

  return env
}

// Env for operations the user explicitly triggered: keeps global/system config
// (identity, credential helpers, LFS) and repo hooks; never prompts; pins the
// sinks that serve no purpose in a UI-driven call.
export function userGitEnv(base: Env = process.env): Env {
  const env: Env = { ...base }

  env.GIT_TERMINAL_PROMPT = '0'
  env.GCM_INTERACTIVE = 'Never'
  env.GIT_PAGER = 'cat'
  env.PAGER = 'cat'
  env.GIT_EDITOR = 'true'
  stripConfigInjection(env)
  writeConfigBlock(env, {
    'core.fsmonitor': 'false',
    'core.pager': 'cat',
    'log.showSignature': 'false',
    'protocol.ext.allow': 'never'
  })

  return env
}

export class GitEnvProbeError extends Error {}

const FILTER_KEY = /^filter\.(.+)\.(clean|smudge|process|required)$/
// Config-defined hooks (git 2.54 `[hook "<name>"] event=/command=`). A hook
// keyed on an event that fires during an automatic probe (post-index-change on
// `git status`, post-checkout on `worktree add`) runs its command, and pinning
// `core.hooksPath` does NOT disable it. Attacker-named like a filter driver, so
// it is enumerated and blanked too.
const HOOK_KEY = /^hook\.(.+)\.(command|event|enabled)$/

// List the filter drivers AND config-defined hooks the repo declares in its own
// config (local, worktree, includes) and neutralise them. `git config
// --get-regexp` only reads config; it never refreshes the index, runs a driver,
// or fires a hook. Blank filter commands are skipped by git; a hook with
// enabled=false and an empty event list never runs.
export function repoFilterDriverOverrides(
  gitBin: string,
  cwd: string,
  globalOpts: readonly string[] = [],
  timeoutMs = 10_000
): Promise<Record<string, string>> {
  const args = [
    ...globalOpts,
    'config',
    '-z',
    '--name-only',
    '--get-regexp',
    String.raw`^(filter\..*\.(clean|smudge|process|required)|hook\..*\.(command|event|enabled))$`
  ]

  return new Promise((resolve, reject) => {
    execFile(
      gitBin || 'git',
      args,
      {
        cwd,
        env: nonInteractiveGitEnv() as NodeJS.ProcessEnv,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024
      },
      (err, stdout, stderr) => {
        // A non-zero exit puts the numeric exit code on err.code; 1 is git's
        // "no matching key". Spawn errors carry a string code (ENOENT …).
        const code: unknown = err ? (err as { code?: unknown }).code : 0

        if (err && code !== 1) {
          reject(new GitEnvProbeError(String(stderr || err.message || 'git config enumeration failed').trim()))

          return
        }

        const overrides: Record<string, string> = {}

        for (const raw of String(stdout || '').split('\0')) {
          const key = raw.replace(/\n$/, '')
          const filterMatch = FILTER_KEY.exec(key)

          if (filterMatch) {
            const name = filterMatch[1]
            overrides[`filter.${name}.clean`] = ''
            overrides[`filter.${name}.smudge`] = ''
            overrides[`filter.${name}.process`] = ''
            overrides[`filter.${name}.required`] = 'false'

            continue
          }

          const hookMatch = HOOK_KEY.exec(key)

          if (hookMatch) {
            const name = hookMatch[1]
            overrides[`hook.${name}.enabled`] = 'false'
            overrides[`hook.${name}.event`] = ''
          }
        }

        resolve(overrides)
      }
    )
  })
}

// nonInteractiveGitEnv plus the repo's filter drivers and config hooks blanked.
// The enumeration runs for EVERY subcommand, not only content-touching ones: a
// config hook fires on its named event (post-index-change reaches `git status`),
// so no automatic path may skip the hook blanking. `args` supplies only the
// leading global options (-C <dir> …) so enumeration resolves the same repo;
// null enumerates with none. Rejects with GitEnvProbeError when enumeration
// fails: callers fail closed.
export async function hardenedGitEnv(gitBin: string, cwd: string, args: readonly string[] | null = null): Promise<Env> {
  const env = nonInteractiveGitEnv()
  let globalOpts: string[] = []

  if (args) {
    const i = gitSubcommandIndex(args)

    globalOpts = (i < 0 ? args : args.slice(0, i)).map(String)
  }

  const overrides = await repoFilterDriverOverrides(gitBin, cwd, globalOpts)

  if (Object.keys(overrides).length) {
    writeConfigBlock(env, overrides)
  }

  return env
}

export function isUserGitOp(args: readonly string[]): boolean {
  const i = gitSubcommandIndex(args)

  if (i < 0) {
    return false
  }

  const sub = String(args[i])

  if (sub === 'worktree') {
    return USER_OP_WORKTREE_VERBS.has(String(args[i + 1] || ''))
  }

  return USER_OP_SUBCOMMANDS.has(sub)
}

// Env for one desktop git call: user ops keep the user's git, reads are hardened.
export async function gitEnvFor(gitBin: string, cwd: string, args: readonly string[]): Promise<Env> {
  return isUserGitOp(args) ? userGitEnv() : hardenedGitEnv(gitBin, cwd, args)
}

// simple-git refuses env vars / config keys it considers dangerous unless opted
// in. Here the env is built by us (above) to pin those very keys to inert values,
// and it may also carry the user's own PATH-level vars (EDITOR, GIT_ASKPASS,
// GIT_SSH_COMMAND …) exactly as a terminal git would see them. The repo's own
// config — the actual attack surface — is never inspected by simple-git, so these
// opt-ins relax nothing an attacker controls.
export const SIMPLE_GIT_ENV_OPT_INS = {
  allowUnsafeAskPass: true,
  allowUnsafeConfigEnvCount: true,
  allowUnsafeConfigPaths: true,
  allowUnsafeCredentialHelper: true,
  allowUnsafeDiffExternal: true,
  allowUnsafeEditor: true,
  allowUnsafeFilter: true,
  allowUnsafeFsMonitor: true,
  allowUnsafeGitProxy: true,
  allowUnsafeGpgProgram: true,
  allowUnsafeHooksPath: true,
  allowUnsafePager: true,
  allowUnsafeProtocolOverride: true,
  allowUnsafeSshCommand: true,
  allowUnsafeTemplateDir: true
} as const
