// Synthetic renderer proof only. Start the leased playground separately.
// node scripts/prove-awareness-ui.mjs http://127.0.0.1:5188 [output-directory] [chromium-executable]
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { chromium } from 'playwright'

const base = new URL(process.argv[2] || 'http://127.0.0.1:5188')
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Proof is local synthetic data only')
const output = process.argv[3] || (await mkdtemp(path.join(tmpdir(), 'atum-awareness-ui-')))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: process.argv[4] || undefined })
const report = { checks: [], screenshots: [], errors: [] }

try {
  for (const scenario of [
    { name: 'wide-light', width: 1280, height: 900, colorScheme: 'light', lang: 'en' },
    { name: 'narrow-dark', width: 390, height: 844, colorScheme: 'dark', lang: 'vi' }
  ]) {
    const page = await browser.newPage({
      viewport: { width: scenario.width, height: scenario.height },
      colorScheme: scenario.colorScheme,
      reducedMotion: 'reduce'
    })
    page.on('pageerror', error => {
      report.errors.push(error.message)
    })
    const url = (view, lang = scenario.lang) => {
      const value = new URL('/matrix-playground.html', base)
      value.searchParams.set('view', view)
      value.searchParams.set('lang', lang)
      return value.href
    }
    await page.goto(url('awareness'))
    // Attribute selector avoids escaping Tailwind's @ in a class selector.
    const root = page.locator('section[class~="@container"]')
    await root.locator('blockquote').first().waitFor()
    assert.equal(await root.locator('blockquote').count(), 3)
    assert.equal(await root.locator('a, img').count(), 0)
    assert.equal(
      await page.evaluate(() => globalThis.document.activeElement === globalThis.document.body),
      true,
      'No automatic focus'
    )
    const body = await root.innerText()
    assert(!body.includes('!synthetic:example.invalid') && !body.includes('$synthetic-edit-2'))
    assert(!body.includes('synthetic-owner-generation'))
    assert(!body.includes('00000000-0000'), 'No raw agent principal')
    assert.equal(
      await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth),
      true,
      'No horizontal overflow'
    )
    for (const [index, kind] of ['matrix_event', 'drive_file', 'memory'].entries()) {
      await root.getByRole('button').nth(index).click()
      await page.locator(`[data-awareness-citation-kind="${kind}"]`).waitFor()
    }
    await page.evaluate(() => globalThis.document.querySelector('main > div')?.scrollTo(0, 0))
    const screenshot = path.join(output, `${scenario.name}.png`)
    await page.screenshot({ path: screenshot, fullPage: true })
    report.screenshots.push(path.basename(screenshot))
    if (scenario.width < 600) {
      await root.locator('h3').last().scrollIntoViewIfNeeded()
      const evidenceScreenshot = path.join(output, 'narrow-dark-evidence.png')
      await page.screenshot({ path: evidenceScreenshot, fullPage: true })
      report.screenshots.push(path.basename(evidenceScreenshot))
    }
    report.checks.push(
      `${scenario.name}: 8 coverage states, 3 explicit exact citation handoffs, no raw ids/focus/overflow`
    )

    await page.goto(url('awareness-stale'))
    await root.locator('blockquote').first().waitFor()
    assert.equal(await root.getByRole('button').count(), 0, 'Stale citations are unavailable')
    await page.goto(url('awareness-unavailable'))
    await root.locator('h3').first().waitFor()
    assert.equal(await root.locator('blockquote').count(), 0, 'Unavailable hides evidence, not coverage')
    assert.equal(await root.locator('ul > li').count(), 8)
    await page.goto(url('awareness-empty'))
    await root.locator('h3').first().waitFor()
    assert.equal(await root.locator('li, blockquote').count(), 0)
    await page.goto(url('awareness-loading'))
    await root.locator('[role="status"]').waitFor()
    assert.equal(await root.locator('li, blockquote, button').count(), 0)
    report.checks.push(`${scenario.name}: stale / unavailable / empty / loading remain distinct`)
    await page.close()
  }
  const page = await browser.newPage()
  page.on('pageerror', error => {
    report.errors.push(error.message)
  })
  for (const lang of ['en', 'vi', 'ja', 'zh', 'zh-hant']) {
    await page.goto(`${base.origin}/matrix-playground.html?view=awareness&lang=${lang}`)
    const root = page.locator('section[class~="@container"]')
    await root.locator('blockquote').first().waitFor()
    assert.equal(await page.locator('html').getAttribute('lang'), lang)
    assert.equal(await root.getByRole('button').count(), 3)
    assert.equal(await root.getByRole('heading', { level: 2 }).count(), 1)
  }
  report.checks.push('All five locales mount the same component and citation path')
  await page.close()
  assert.deepEqual(report.errors, [])
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ result: 'pass', output, ...report }, null, 2))
} finally {
  await browser.close()
}
