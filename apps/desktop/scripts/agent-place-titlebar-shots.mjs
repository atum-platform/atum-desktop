// The place icon beside the open assistant's name in the real window title bar (owner 2026-11-28):
// the full Matrix playground window with a cloud assistant, one on a Claude plan through the Mac mini
// and one on a ChatGPT plan through a MacBook Pro (`?agentPlace=`), light and dark.
// Serve apps/desktop with Vite (npx vite --port 5199), then:
// node scripts/agent-place-titlebar-shots.mjs http://127.0.0.1:5199 <output-directory> [chromium-executable]
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://127.0.0.1:5199'
const out = process.argv[3] ?? 'agent-place-titlebar-shots'
await mkdir(out, { recursive: true })

const shots = [
  { name: 'cloud', mode: 'cloud', place: '[data-agent-place="cloud"]' },
  { name: 'mac-mini', mode: 'mini', place: '[data-agent-place-machine="mac-mini"]' },
  { name: 'macbook', mode: 'laptop', place: '[data-agent-place-machine="laptop"]' }
]

const browser = await chromium.launch({ headless: true, executablePath: process.argv[4] || undefined })
const errors = []

try {
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2, colorScheme })
    // The whole window imports the in-app browser's address policy (shared/browser/policy.ts), which
    // reaches Node's `net`; Vite's dev stub throws on it in a plain browser. Dev shots only: answer it
    // with an empty `net` (the release build bundles its own externalized stub).
    await context.route('**/@id/__vite-browser-external:node:net', route =>
      route.fulfill({ contentType: 'text/javascript', body: 'export default { isIP: () => 0 }' })
    )
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(`${colorScheme}: ${error.message}`))

    for (const shot of shots) {
      await page.goto(`${base}/matrix-playground.html?scenario=chat&agentPlace=${shot.mode}&theme=${colorScheme}&evidence=1`)
      // The playground's own switcher sits over the title bar; the product screenshots must not.
      await page.addStyleTag({ content: '[data-matrix-playground]{display:none!important}' })
      const header = page.locator('[data-atum-chat] [data-atum-main-header]').first()
      await header.locator(`[data-matrix-title-place] ${shot.place}`).waitFor({ timeout: 30_000 })
      await page.waitForTimeout(400)

      // The whole window, so the title bar is seen where it lives.
      const window = path.join(out, `titlebar-${shot.name}-${colorScheme}-window.png`)
      await page.screenshot({ path: window })
      console.log(window)

      // The title bar itself, with the icon's tooltip open.
      await header.locator('[data-matrix-title-place] [data-agent-place]').hover()
      await page.getByRole('tooltip').first().waitFor({ timeout: 5_000 })
      await page.waitForTimeout(250)
      const box = await header.boundingBox()
      const file = path.join(out, `titlebar-${shot.name}-${colorScheme}.png`)
      await page.screenshot({ path: file, clip: { x: box.x, y: box.y, width: Math.min(box.width, 760), height: box.height + 44 } })
      console.log(file)
      await page.mouse.move(0, 400)
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
