// Chat roster filter (owner 2026-11-27): the search row and the open filter menu, light and dark.
// node scripts/chat-filter-shots.mjs http://127.0.0.1:5197 <output-directory> [chromium-executable]
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://127.0.0.1:5197'
const out = process.argv[3] ?? 'chat-filter-shots'
await mkdir(out, { recursive: true })

const browser = await chromium.launch({ headless: true, executablePath: process.argv[4] || undefined })
const errors = []

try {
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(`${colorScheme}: ${error.message}`))

    await page.goto(`${base}/matrix-playground.html?scenario=roster&theme=${colorScheme}&evidence=1`)
    const roster = page.locator('[data-atum-roster]:visible').first()
    const filter = roster.locator('[data-atum-roster-filter]')
    await filter.waitFor({ timeout: 20_000 })

    await filter.click()
    await page.locator('[data-atum-roster-filter-content]').waitFor()
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(out, `menu-open-${colorScheme}.png`), clip: await clipAround(roster, 120) })

    await page.getByRole('menuitemradio', { name: 'Unread' }).click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(out, `roster-unread-${colorScheme}.png`), clip: await roster.boundingBox() })

    // Back to All (leaves the stored choice clean), then the resting row with no menu or focus.
    await filter.click()
    await page.getByRole('menuitemradio', { name: 'All' }).click()
    await page.locator('[data-atum-roster-filter-content]').waitFor({ state: 'detached' })
    await page.evaluate(() => globalThis.document.activeElement?.blur())
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(out, `row-${colorScheme}.png`), clip: await rowClip(roster, filter) })
    console.log(colorScheme, 'done')
    await context.close()
  }
} finally {
  await browser.close()
}

async function clipAround(locator, extra) {
  const box = await locator.boundingBox()

  return { x: box.x, y: box.y, width: box.width + extra, height: Math.min(box.height, 520) }
}

async function rowClip(roster, button) {
  const panel = await roster.boundingBox()
  const box = await button.boundingBox()

  return { x: panel.x, y: Math.max(0, box.y - 12), width: panel.width, height: box.height + 24 }
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
}
