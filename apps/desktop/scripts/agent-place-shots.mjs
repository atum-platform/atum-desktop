// The place icon beside assistant names: the roster and the chat header with a cloud assistant, one
// through a Mac mini, one through a MacBook and one whose only Mac is off (owner 2026-11-28 build).
// Serve apps/desktop with Vite (npx vite --port 5198), then:
// node scripts/agent-place-shots.mjs http://127.0.0.1:5198 <output-directory> [chromium-executable]
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://127.0.0.1:5198'
const out = process.argv[3] ?? 'agent-place-shots'
await mkdir(out, { recursive: true })

const browser = await chromium.launch({ headless: true, executablePath: process.argv[4] || undefined })
const errors = []

try {
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 420 }, deviceScaleFactor: 2, colorScheme })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(`${colorScheme}: ${error.message}`))

    await page.goto(`${base}/agent-place-fixture.html?theme=${colorScheme}`)
    // Every assistant's place has been read: four icons in the roster and four in the headers.
    await page.waitForFunction(() => document.querySelectorAll('[data-agent-place]').length >= 8, null, { timeout: 30_000 })
    await page.waitForTimeout(300)
    const file = path.join(out, `agent-place-${colorScheme}.png`)
    await page.screenshot({ path: file })
    console.log(file)

    // The tooltip on the Mac mini row's icon.
    await page.locator('[data-matrix-agent="rin"] [data-agent-place]').hover()
    await page.getByRole('tooltip').first().waitFor({ timeout: 5_000 })
    const tip = path.join(out, `agent-place-tooltip-${colorScheme}.png`)
    await page.screenshot({ path: tip, clip: { x: 0, y: 0, width: 520, height: 300 } })
    console.log(tip)
    await context.close()
  }
} finally {
  await browser.close()
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
}
