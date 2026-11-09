/**
 * Owner-run check of the browser import's Chrome reader against this Mac's REAL Chrome profile. It prints counts
 * and closed verdicts only (no host, site, cookie name, value, key or password) and writes and sends nothing.
 * macOS shows its Keychain dialog for "Chrome Safe Storage" once: the one thing the unit tests cannot do, because
 * they decrypt fixtures, not Chrome's own files.
 *
 *   cd apps/desktop && npx tsx scripts/browser-import-check.ts
 *
 * The logic and its tests are in `electron/matrix/browser-import/check.ts`.
 */
import { homedir } from 'node:os'

import { chromeCheck } from '../electron/matrix/browser-import/check'
import { defaultChromeEnv } from '../electron/matrix/browser-import/chrome-cookies'

const result = await chromeCheck(defaultChromeEnv(homedir()))

for (const line of result.lines) {
  console.log(line)
}

process.exit(result.ok ? 0 : 1)
