// The agent model picker open on a Mac plan: one icon per Mac that serves the model (one off, dimmed)
// and the plan's thinking column. Light and dark playground screenshots (owner 2026-11-28 build).
// Serve apps/desktop with Vite (npx vite --port 5197), then:
// node scripts/agent-picker-macs-shots.mjs http://127.0.0.1:5197 <output-directory> [chromium-executable]
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://127.0.0.1:5197'
const out = process.argv[3] ?? 'agent-picker-macs-shots'
await mkdir(out, { recursive: true })

const browser = await chromium.launch({ headless: true, executablePath: process.argv[4] || undefined })
const errors = []

try {
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 640 }, deviceScaleFactor: 2, colorScheme })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(`${colorScheme}: ${error.message}`))

    await page.goto(`${base}/picker-relay-fixture.html?relay=picker-macs&theme=${colorScheme}`)
    const card = page.locator('[data-matrix-model-panel]').first()
    await card.waitFor({ timeout: 30_000 })
    // The Mac plan's own list, as the picker opens on the model that answers.
    const rail = page.locator('[data-matrix-model-rail-item="openai-codex"]').first()

    if ((await rail.getAttribute('aria-pressed')) !== 'true') {await rail.click()}

    await page.locator('[data-matrix-model-machines]').first().waitFor({ timeout: 10_000 })
    await page.waitForTimeout(400)
    const file = path.join(out, `agent-picker-macs-${colorScheme}.png`)
    const box = await card.boundingBox()

    await page.screenshot({
      path: file,
      clip: box ? { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 24), width: box.width + 48, height: box.height + 72 } : undefined
    })
    console.log(file)
    await context.close()
  }
} finally {
  await browser.close()
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
}
