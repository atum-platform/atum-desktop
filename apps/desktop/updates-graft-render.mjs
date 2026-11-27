import { chromium } from '@playwright/test'
import { build } from 'vite'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const outDir = process.argv[2]
const destination = process.argv[3]
await build({ root, build: { outDir, emptyOutDir: true, rolldownOptions: { input: path.join(root, 'updates-graft-fixture.html') } } })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 520, height: 545 }, deviceScaleFactor: 2 })
  page.on('pageerror', error => process.stderr.write(`${error.message}\n`))
  await page.route('https://example.test/**', async route => {
    const file = new URL(route.request().url()).pathname.slice(1)
    const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml' }
    const body = await readFile(path.join(outDir, file)).catch(() => null)
    await route.fulfill({ status: body ? 200 : 404, body: body ?? '', contentType: types[path.extname(file)] ?? 'application/octet-stream' })
  })
  for (const theme of ['light', 'dark']) {
    await page.goto(`https://example.test/updates-graft-fixture.html?theme=${theme}`)
    await page.locator('[data-atum-update-pill]').last().waitFor({ timeout: 8_000 })
    if (await page.locator('[data-atum-update-pill]').count() !== 8) {throw new Error('Incomplete state fixture')}
    await page.locator('main').screenshot({ path: path.join(destination, `pill-${theme}.png`), animations: 'disabled' })
  }
  for (const rail of ['expanded', 'collapsed']) {
    await page.goto(`https://example.test/updates-graft-fixture.html?rail=${rail}`)
    const foot = page.locator('[data-matrix-rail-foot]')
    const capsule = foot.locator('[data-atum-update-pill]')
    const avatar = foot.locator('[data-matrix-rail-account]')
    await avatar.waitFor({ timeout: 8_000 })
    const updateBounds = await capsule.boundingBox()
    const footBounds = await foot.boundingBox()
    const avatarBounds = await avatar.boundingBox()
    const actions = await capsule.getByRole('button').all()
    for (const action of actions) {
      const bounds = await action.boundingBox()
      if (!bounds || !footBounds || bounds.x < footBounds.x || bounds.x + bounds.width > footBounds.x + footBounds.width) {
        throw new Error('An update action overflows the rail')
      }
    }
    if (!updateBounds || !avatarBounds || updateBounds.y + updateBounds.height > avatarBounds.y) {
      throw new Error('The update capsule must sit above the account avatar')
    }
    await foot.screenshot({ path: path.join(destination, `atum-rail-${rail}.png`), animations: 'disabled' })
  }
} finally {
  await browser.close()
}
