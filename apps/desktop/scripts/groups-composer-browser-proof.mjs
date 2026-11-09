import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '@playwright/test'

const output = path.resolve(process.argv[2] ?? '.artifacts/groups-composer')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: process.argv[3] ?? chromium.executablePath() })
try {
  for (const lang of ['vi', 'en']) {
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ colorScheme, viewport: { width: 1280, height: 900 } })
      const page = await context.newPage()
      await page.goto(`http://127.0.0.1:5177/matrix-playground.html?scenario=chat-group-assistant&lang=${lang}`)
      const title = lang === 'vi' ? 'Trợ lý trong nhóm' : 'Group assistants'
      const everyone = lang === 'vi' ? 'Cả nhóm' : 'Everyone'
      await page.getByRole('button', { name: everyone, exact: true }).waitFor({ state: 'visible' })
      const button = page.getByRole('button', { name: title, exact: true })
      await button.click()
      const panel = page.getByRole('dialog', { name: title })
      await panel.waitFor({ state: 'visible' })
      assert.ok((await panel.innerText()).includes(lang === 'vi' ? 'Hôm nay: 12/30' : 'Today: 12/30'))
      await page.locator('[data-matrix-playground]').evaluate(element => {
        element.style.display = 'none'
      })
      await page.screenshot({ path: path.join(output, `${lang}-${colorScheme}.png`), animations: 'disabled' })
      await page.keyboard.press('Escape')
      await panel.waitFor({ state: 'hidden' })
      assert.equal(await button.evaluate(element => document.activeElement === element), true)
      await context.close()
    }
  }
  console.log(
    JSON.stringify({ screenshots: 4, languages: ['vi', 'en'], themes: ['light', 'dark'], escapeReturnsFocus: true })
  )
} finally {
  await browser.close()
}
/* global document */
