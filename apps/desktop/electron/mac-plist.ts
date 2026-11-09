import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type MacPlist = Record<string, unknown>
export type SyncPlistRunner = (file: string, args: string[]) => string

function parsedPlist(output: string): MacPlist | null {
  try {
    const value = JSON.parse(output) as unknown

    return value && typeof value === 'object' && !Array.isArray(value) ? (value as MacPlist) : null
  } catch {
    return null
  }
}

/**
 * One plist boundary for updater state and bundle metadata. The production
 * path asks macOS plutil to normalize XML or binary plists to JSON; `readPlistSync`
 * keeps launch probing injectable without duplicating parsing.
 */
export function readPlist(file: string, options: { throwOnError?: boolean } = {}): Promise<MacPlist | null> {
  return execFileAsync('/usr/bin/plutil', plistArgs(file), { encoding: 'utf8', maxBuffer: 1024 * 1024 })
    .then(result => parsedPlist(result.stdout))
    .catch(error => {
      // Destructive callers must distinguish a failed read from absent/invalid data.
      if (options.throwOnError) {throw error}

      return null
    })
}

/** The same boundary through an injected synchronous runner, for launch probing. */
export function readPlistSync(file: string, run: SyncPlistRunner): MacPlist | null {
  try {
    return parsedPlist(run('/usr/bin/plutil', plistArgs(file)))
  } catch {
    return null
  }
}

function plistArgs(file: string): string[] {
  return ['-convert', 'json', '-o', '-', '--', file]
}
