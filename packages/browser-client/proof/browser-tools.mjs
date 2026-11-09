// Use an already installed browser/runtime. Never download packages or browsers here.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'

export function browserTools(argv = process.argv.slice(2)) {
  const [modulePath, executablePath] = argv
  if (argv.length !== 2 || !modulePath || !executablePath || !isAbsolute(modulePath) || !isAbsolute(executablePath) ||
      !existsSync(modulePath) || !existsSync(executablePath)) {
    throw new Error('Supply absolute paths to the installed Playwright module and Chromium executable.')
  }
  const { chromium } = createRequire(import.meta.url)(modulePath)
  return { chromium, executablePath }
}
