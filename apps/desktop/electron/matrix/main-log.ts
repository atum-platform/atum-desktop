import fs from 'node:fs'
import path from 'node:path'

/** Rotate once past this size; the previous file is kept as main.old.log. */
export const MAIN_LOG_LIMIT = 2 * 1024 * 1024

/**
 * Mirrors the main process's own tagged warnings and errors (`[Matrix] …`) into
 * `<logs>/main.log`, so a setup that failed on someone's Mac can be diagnosed
 * afterwards. Only tagged lines are written: library output can carry room or
 * device detail, and callers pass error codes, never tokens or message text.
 * Logging failures are swallowed; they must never affect the app.
 */
export function mirrorTaggedConsole(
  directory: string,
  target: Pick<Console, 'warn' | 'error'> = console,
  now: () => Date = () => new Date()
): void {
  const file = path.join(directory, 'main.log')

  const write = (level: 'warn' | 'error', args: unknown[]) => {
    if (typeof args[0] !== 'string' || !args[0].startsWith('[')) {
      return
    }

    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })

      if (fs.existsSync(file) && fs.statSync(file).size > MAIN_LOG_LIMIT) {
        fs.renameSync(file, path.join(directory, 'main.old.log'))
      }

      fs.appendFileSync(file, `${now().toISOString()} ${level} ${args.map(describe).join(' ')}\n`, { mode: 0o600 })
    } catch {
      /* Diagnostics only. */
    }
  }

  for (const level of ['warn', 'error'] as const) {
    const original = target[level].bind(target)

    target[level] = (...args: unknown[]) => {
      original(...args)
      write(level, args)
    }
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`
  }

  if (typeof value === 'string') {
    return value
  }

  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
