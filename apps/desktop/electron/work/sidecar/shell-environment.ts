// Adapted from T3 Code packages/shared/src/shell.ts at 69a0515771 (MIT).
// Keep the native shell marker protocol and shell-specific capture syntax.
import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import * as path from 'node:path'

const SHELL_ENV_NAME_PATTERN = /^[A-Z0-9_]+$/
const POSIX_PATH_DELIMITER = ':'

function envCaptureStart(name: string): string {
  return `__T3CODE_ENV_${name}_START__`
}

function envCaptureEnd(name: string): string {
  return `__T3CODE_ENV_${name}_END__`
}

const DEBUG_TRAP_SHELLS = new Set(['bash', 'zsh', 'sh', 'ksh', 'ksh93'])
const POSIX_CAPTURE_SYNTAX = { assignment: '__T3CODE_PRINTENV=$(', orElse: ' || ' }

const PRINTENV_CAPTURE_SYNTAX = new Map(
  [...DEBUG_TRAP_SHELLS, 'dash', 'ash'].map(shell => [shell, POSIX_CAPTURE_SYNTAX] as const)
).set('fish', { assignment: 'set -l __T3CODE_PRINTENV (', orElse: '; or ' })

// Network PATH entries must be probed inside the shell's deadline, away from the desktop thread.
const PRINTENV_LOOKUP_COMMAND = `/bin/sh -c 'command -v printenv || { [ -n "$1" ] && PATH="$1" command -v printenv; } || printf %s /usr/bin/printenv' t3`

export function buildEnvironmentCaptureCommand(shell: string, names: ReadonlyArray<string>): string {
  const executableName = path.basename(shell).toLowerCase()
  const isNushell = executableName.startsWith('nu')
  const syntax = PRINTENV_CAPTURE_SYNTAX.get(executableName)
  const supportsFallback = syntax !== undefined

  const inheritedPath = (process.env.PATH ?? '')
    .split(POSIX_PATH_DELIMITER)
    .filter(Boolean)
    .map(entry => path.posix.resolve(entry))
    .join(POSIX_PATH_DELIMITER)

  const lookupPrintenv = `${PRINTENV_LOOKUP_COMMAND} '${inheritedPath.replaceAll("'", "'\\''")}'`
  const { assignment, orElse } = syntax ?? POSIX_CAPTURE_SYNTAX
  const resolvePrintenv = `${assignment}${lookupPrintenv}); `

  const capture = names
    .map(name => {
      if (!SHELL_ENV_NAME_PATTERN.test(name)) {
        throw new Error(`Unsupported environment variable name: ${name}`)
      }

      if (isNushell) {
        // Without a configured conversion, Nu expands home paths only in a list PATH.
        const defaultValue =
          name === 'PATH'
            ? "if ($env.PATH? | describe | str starts-with 'list') { " +
              "$env.PATH | each {|p| if ($p | str starts-with '~') { " +
              '$p | path expand --no-symlink } else { $p } } | str join (char esep) ' +
              "} else { $env.PATH? | default '' }"
            : `$env.${name}? | default ''`

        const value =
          `if $env.${name}? == null { '' } else if ` +
          `$env.ENV_CONVERSIONS?.${name}?.to_string? != null { ` +
          `$env.${name} | do $env.ENV_CONVERSIONS.${name}.to_string $env.${name} ` +
          `} else { ${defaultValue} }`

        return [`print '${envCaptureStart(name)}'`, `print (${value})`, `print '${envCaptureEnd(name)}'`].join('; ')
      }

      return [
        `printf '%s\\n' '${envCaptureStart(name)}'`,
        supportsFallback
          ? `printenv ${name}${orElse}"$__T3CODE_PRINTENV" ${name}${orElse}true`
          : `printenv ${name} || true`,
        `printf '%s\\n' '${envCaptureEnd(name)}'`
      ].join('; ')
    })
    .join('; ')

  // A DEBUG trap that echoes each command (e.g. into the terminal title) would print the markers.
  // OpenBSD ksh (also its /bin/sh) exits on `trap - DEBUG`, so try it in a subshell first.
  const command = supportsFallback ? resolvePrintenv + capture : capture

  return DEBUG_TRAP_SHELLS.has(executableName) ? `(trap - DEBUG) 2>/dev/null && trap - DEBUG; ${command}` : command
}

let cachedPath: Promise<string> | undefined

/** One capture per app run, shared by concurrent starts and account switches. */
export function loginShellPath(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env !== process.env) {return captureLoginShellPath(env)}

  return cachedPath ??= captureLoginShellPath(env)
}

async function captureLoginShellPath(env: NodeJS.ProcessEnv): Promise<string> {
  let userShell: string | undefined

  try {
    userShell = userInfo().shell
  } catch {
    /* Account lookup unavailable. */
  }

  const shells = [
    ...new Set([env.SHELL, userShell, process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'].filter(Boolean))
  ] as string[]

  for (const shell of shells) {
    const output = await new Promise<string>(resolve => {
      execFile(
        shell,
        ['-ilc', buildEnvironmentCaptureCommand(shell, ['PATH'])],
        {
          env,
          timeout: 6000,
          killSignal: 'SIGKILL',
          maxBuffer: 1024 * 1024
        },
        (error, stdout) => resolve(error ? '' : stdout)
      )
    })

    const start = output.lastIndexOf('__T3CODE_ENV_PATH_START__\n')
    const end = output.indexOf('__T3CODE_ENV_PATH_END__', start)

    const captured =
      start >= 0 && end > start ? output.slice(start + '__T3CODE_ENV_PATH_START__\n'.length, end).trim() : ''

    if (captured) {
      return [captured, env.PATH].filter(Boolean).join(':')
    }
  }

  return env.PATH ?? ''
}
