/* global document, window */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { chromium } from 'playwright-core'

const base = process.argv[2] ?? 'http://127.0.0.1:5199'
const output = process.argv[3] ?? '/tmp/first-run-checklist-proof'

mkdirSync(output, { recursive: true })

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true
})

const screenshots = []

async function open({ colorScheme, sourceState = 'fresh', width }) {
  const context = await browser.newContext({
    colorScheme,
    reducedMotion: 'reduce',
    viewport: { width, height: 820 }
  })
  const page = await context.newPage()
  const url = new URL('/matrix-playground.html', base)
  url.searchParams.set('scenario', 'first-run-google')
  url.searchParams.set('lang', 'en')
  url.searchParams.set('evidence', '1')
  url.searchParams.set('firstRunSources', sourceState)
  url.searchParams.set('google', 'connected')
  await page.goto(url.href)
  await page.locator('[data-matrix-first-run-connect-card]').waitFor()

  return { context, page }
}

async function assertRowsFit(page) {
  const result = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-matrix-first-run-connect-card] [data-atum-ask]')]

    return {
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      rows: rows.map(row => {
        const main = row.querySelector('.ak-row-main')?.getBoundingClientRect()
        const detail = row.querySelector('.ak-row-meta')?.getBoundingClientRect()
        const control = row.lastElementChild?.getBoundingClientRect()

        return {
          gate: row.getAttribute('data-atum-ask'),
          detailInsideTextColumn: !detail || !main || detail.right <= main.right + 0.5,
          textBeforeControl: !main || !control || main.right <= control.left + 0.5
        }
      })
    }
  })

  assert.equal(result.horizontalOverflow, false, 'the Matrix playground must not scroll horizontally')

  for (const row of result.rows) {
    assert.equal(row.detailInsideTextColumn, true, `${row.gate}: description stays in its text column`)
    assert.equal(row.textBeforeControl, true, `${row.gate}: text stays before the trailing control`)
  }
}

async function shot(page, name) {
  await assertRowsFit(page)
  const target = path.join(output, `${name}.png`)
  await page.screenshot({ animations: 'disabled', path: target })
  screenshots.push(target)
}

try {
  {
    const { context, page } = await open({ colorScheme: 'light', width: 1100 })
    const checkboxes = page.getByRole('checkbox')
    assert.equal(await checkboxes.count(), 6)

    for (let index = 0; index < 6; index += 1) {
      assert.equal(await checkboxes.nth(index).getAttribute('data-state'), 'checked')
    }

    await shot(page, 'after-fresh-normal-light')
    await context.close()
  }

  {
    const { context, page } = await open({ colorScheme: 'dark', width: 700 })
    await shot(page, 'after-fresh-narrow-dark')
    await context.close()
  }

  {
    const { context, page } = await open({ colorScheme: 'dark', width: 1100 })
    const messages = page.getByRole('checkbox', { name: 'Messages' })
    await messages.click()
    assert.equal(await messages.getAttribute('data-state'), 'unchecked')
    await shot(page, 'after-one-unchecked-normal-dark')
    await context.close()
  }

  {
    const { context, page } = await open({ colorScheme: 'light', width: 700 })
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Open Settings' }).waitFor()
    const messages = page.locator('[data-atum-ask="messages"]')
    assert.equal(await messages.getByRole('button').count(), 1)
    assert.equal(await messages.getByRole('checkbox').count(), 0)
    await shot(page, 'after-finish-in-settings-narrow-light')

    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
    })
    await page.getByRole('button', { name: 'Restart Atum' }).waitFor()
    assert.equal(await messages.getByRole('button').count(), 1)
    await shot(page, 'after-restart-narrow-light')
    await context.close()
  }

  {
    const { context, page } = await open({ colorScheme: 'dark', sourceState: 'google-granted', width: 1100 })
    const google = page.locator('[data-atum-ask="google"]')
    assert.match((await google.textContent()) ?? '', /Done/u)
    assert.equal(await google.getByRole('checkbox').count(), 0)
    await shot(page, 'after-granted-normal-dark')
    await context.close()
  }
} finally {
  await browser.close()
}

console.log(JSON.stringify({ screenshots }, null, 2))
