import { wrapCommandWithSandboxMacOS } from '@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js'
import metadata from '@anthropic-ai/sandbox-runtime/package.json'

/** Decode only the argv grammar emitted by srt's quote(); never evaluate shell text. */
export function decodeSrtArgv(command: string): string[] {
  const words: string[] = []
  let at = 0

  while (at < command.length) {
    if (command[at] === ' ') {
      at++

      continue
    }

    let word = ''

    while (at < command.length && command[at] !== ' ') {
      if (command.startsWith('"\'"', at)) {
        word += "'"
        at += 3
      } else if (command[at] === "'") {
        const end = command.indexOf("'", at + 1)

        if (end < 0) {
          throw new Error('guard_srt_unclosed_quote')
        }

        word += command.slice(at + 1, end)
        at = end + 1
      } else {
        const bare = /^[A-Za-z0-9_./:=@+,-]+/.exec(command.slice(at))?.[0]

        if (!bare) {
          throw new Error('guard_srt_unexpected_shell_syntax')
        }

        word += bare
        at += bare.length
      }
    }

    words.push(word)
  }

  return words
}

/**
 * srt owns the deny-default Chrome-derived process/IPC foundation. Atum owns
 * the literal filesystem policy: srt's config path strings interpret brackets
 * as globs (#576), and its mandatory write list is anchored at process.cwd().
 * Replace only the pinned write section, fail closed on any format/version drift.
 */
export function srtMacFoundation(proxyPort: number): string {
  if (metadata.version !== '0.0.78') {
    throw new Error('guard_srt_version_mismatch')
  }

  const wrapped = wrapCommandWithSandboxMacOS({
    command: 'true',
    commandId: 'atum-device-guard',
    binShell: '/bin/bash',
    needsNetworkRestriction: true,
    httpProxyPort: proxyPort,
    allowLocalBinding: true,
    readConfig: { denyOnly: [] },
    writeConfig: { allowOnly: [], denyWithinAllow: [] }
  })

  const argv = decodeSrtArgv(wrapped)
  const exec = argv.indexOf('/usr/bin/sandbox-exec')

  if (
    exec < 0 ||
    argv[exec + 1] !== '-p' ||
    argv[exec + 3] !== '/bin/bash' ||
    argv[exec + 4] !== '-c' ||
    argv[exec + 5] !== 'true' ||
    argv.length !== exec + 6
  ) {
    throw new Error('guard_srt_wrapper_mismatch')
  }

  return extractSrtFoundation(argv[exec + 2])
}

/** Pinned empty write config emits exactly two write-deny forms, never other operations. */
export function extractSrtFoundation(profile: string): string {
  const marker = '\n; File write\n'
  const index = profile.indexOf(marker)

  if (!profile.startsWith('(version 1)\n(deny default ') || index < 0 || profile.indexOf(marker, index + 1) >= 0) {
    throw new Error('guard_srt_profile_mismatch')
  }

  const suffix = profile.slice(index + marker.length)
  const heads: string[] = []
  let depth = 0
  let quoted = false
  let start = 0

  for (let at = 0; at < suffix.length; at++) {
    const char = suffix[at]

    if (quoted) {
      if (char === '\\') {
        at++
      } else if (char === '"') {
        quoted = false
      }

      continue
    }

    if (char === '"' && depth > 0) {
      quoted = true
    } else if (char === '(') {
      if (depth++ === 0) {
        start = at
      }
    } else if (char === ')' && depth > 0) {
      if (--depth === 0) {
        const form = suffix.slice(start, at + 1)
        heads.push(form.slice(1, form.indexOf('(', 1)).trim().replace(/\s+/g, ' '))
      }
    } else if (char === ';' || (depth === 0 && !/\s/.test(char))) {
      throw new Error('guard_srt_profile_mismatch')
    }
  }

  if (
    depth ||
    quoted ||
    heads.length !== 2 ||
    heads[0] !== 'deny file-write*' ||
    heads[1] !== 'deny file-write-unlink file-write-create'
  ) {
    throw new Error('guard_srt_profile_mismatch')
  }

  return profile.slice(0, index)
}
