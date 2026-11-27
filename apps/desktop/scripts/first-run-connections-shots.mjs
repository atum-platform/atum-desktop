// First-run Connections block: light and dark playground screenshots (owner 2026-11-27 build).
// node scripts/first-run-connections-shots.mjs http://127.0.0.1:5197 <output-directory> [chromium-executable]
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://127.0.0.1:5197'
const out = process.argv[3] ?? 'first-run-shots'
await mkdir(out, { recursive: true })

const shots = [
  { name: 'r2-02-one-plan', query: 'scenario=first-run-chat&work=ready&page=chat&firstRun=one' },
  { name: 'r2-03-several-plans', query: 'scenario=first-run-chat&work=ready&page=chat&firstRun=several' },
  { name: 'r2-04-none', query: 'scenario=first-run-chat&work=ready&page=chat&firstRun=none' },
  { name: 'r2-05-signing-in', query: 'scenario=first-run-chat&work=ready&page=chat&firstRun=none&signing=codex' },
  { name: 'r2-08-free-only', query: 'scenario=first-run-chat&work=ready&page=chat&firstRun=free' },
  { name: 'r2-02-one-plan-vi', query: 'scenario=first-run-chat&work=ready&page=chat&firstRun=one&lang=vi' }
]

const browser = await chromium.launch({ headless: true, executablePath: process.argv[4] || undefined })
const errors = []

try {
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(`${colorScheme}: ${error.message}`))

    for (const shot of shots) {
      await page.goto(`${base}/matrix-playground.html?${shot.query}&theme=${colorScheme}&evidence=1`)
      const block = page.locator('[data-atum-first-run-connections]').first()
      await block.waitFor({ timeout: 20_000 })
      // The greeting and the block, as the first chat opens on them.
      await page.waitForTimeout(800)
      await page.evaluate(() => globalThis.document.querySelectorAll('[data-slot="aui_thread-viewport"]').forEach(node => { node.scrollTop = 0 }))
      await page.waitForTimeout(150)
      const file = path.join(out, `${shot.name}-${colorScheme}.png`)
      await page.screenshot({ path: file })
      await block.screenshot({ path: path.join(out, `${shot.name}-${colorScheme}-block.png`) })
      console.log(file)
    }

    await context.close()
  }
} finally {
  await browser.close()
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
}
