// The agent's Screen in the side panel (plan 2026-11-28 S4): watching, in control, handing back,
// light and dark, on the playground's mock transport (`?screen=slow`).
// node scripts/agent-screen-shots.mjs http://127.0.0.1:5197 <output-directory> [chromium-executable]
//
// The mock streams no frames, so the script draws a stand-in sign-in page into the stage. It is a
// generic placeholder (no real site), for layout review only.
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://127.0.0.1:5197'
const out = process.argv[3] ?? 'agent-screen-shots'
await mkdir(out, { recursive: true })

const STAND_IN = `
  <div style="position:absolute;inset:0;background:#fff;color:#1d1d1f;font:14px/1.4 -apple-system,system-ui,sans-serif;display:flex;flex-direction:column">
    <div style="height:34px;border-bottom:1px solid #e5e5ea;display:flex;align-items:center;padding:0 12px;gap:8px;color:#6e6e73;font-size:12px">
      <span style="width:10px;height:10px;border-radius:50%;background:#d1d1d6"></span>
      <span style="flex:1;background:#f2f2f7;border-radius:6px;padding:4px 10px">shop.example/sign-in</span>
    </div>
    <div style="flex:1;display:grid;place-items:center">
      <div style="width:240px;display:flex;flex-direction:column;gap:10px">
        <div style="font-size:18px;font-weight:600">Sign in</div>
        <div style="border:1px solid #d1d1d6;border-radius:8px;padding:8px 10px;color:#8e8e93">Email</div>
        <div style="border:1px solid #d1d1d6;border-radius:8px;padding:8px 10px;color:#8e8e93">Password</div>
        <div style="background:#1d1d1f;color:#fff;border-radius:8px;padding:8px 10px;text-align:center">Continue</div>
      </div>
    </div>
  </div>`

const browser = await chromium.launch({ headless: true, executablePath: process.argv[4] || undefined })
const errors = []

try {
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(`${colorScheme}: ${error.message}`))

    await page.goto(`${base}/matrix-playground.html?scenario=chat&desk=working&screen=slow&lang=en&theme=${colorScheme}&evidence=1`)
    const watch = page.locator('[data-matrix-agent-watch]:visible').first()
    await watch.waitFor({ timeout: 30_000 })
    await watch.click()

    const tab = page.locator('[data-matrix-agent-screen-tab]')
    const takeOver = tab.locator('[data-agent-screen-take-over]')
    await takeOver.waitFor({ timeout: 20_000 })
    await page.waitForFunction(() => !globalThis.document.querySelector('[data-agent-screen-take-over]')?.disabled)
    await page.evaluate(html => {
      globalThis.document.querySelector('[data-agent-screen-canvas]')?.insertAdjacentHTML('beforeend', html)
    }, STAND_IN)
    await page.waitForTimeout(400)
    const panel = async () => (await page.locator('[data-matrix-workbench]').first().boundingBox()) ?? undefined
    // The tab strip sits above the workbench body: include it.
    const clip = async () => {
      const box = await panel()

      return box ? { x: box.x, y: Math.max(0, box.y - 48), width: box.width, height: box.height + 48 } : undefined
    }

    await page.screenshot({ path: path.join(out, `watch-${colorScheme}.png`), clip: await clip() })

    await takeOver.click()
    await tab.locator('[data-agent-screen-hand-back]').waitFor()
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(out, `control-${colorScheme}.png`), clip: await clip() })

    await tab.locator('[data-agent-screen-hand-back]').click()
    await page.locator('[data-agent-screen="handing_back"]').waitFor()
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(out, `handing-back-${colorScheme}.png`), clip: await clip() })

    // The release lands: back to watching, and the carry-on goes to the chat.
    await page.locator('[data-agent-screen="watch"]').waitFor({ timeout: 10_000 })
    await page.waitForTimeout(600)
    await page.screenshot({ path: path.join(out, `after-hand-back-${colorScheme}.png`), fullPage: false })
    console.log(colorScheme, 'done')
    await context.close()
  }
} finally {
  await browser.close()
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
}
