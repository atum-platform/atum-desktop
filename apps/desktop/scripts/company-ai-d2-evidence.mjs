import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { chromium } from '@playwright/test'

const output = process.env.ATUM_D2_EVIDENCE ?? '/home/example/Projects/_atum-ops-scratch-1019/launch/company-ai-d2-evidence'
const url = 'http://127.0.0.1:5174/matrix-playground.html?scenario=team-space-threads&company=team&lang=en'

await mkdir(output, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })

async function shot(name) {
  await page.screenshot({ path: join(output, `${name}-r2.png`), animations: 'disabled' })
}

async function hidePlayground() {
  // The playground's own switcher sits over the title bar; the product screenshots must not.
  await page.addStyleTag({ content: '[data-matrix-playground]{display:none!important}' })
}

async function openWallet() {
  await page.locator('[data-matrix-company-menu-trigger]').click()
  await page.getByRole('menuitem', { name: 'Company wallet' }).click()
  await page.locator('[data-company-wallet]').waitFor()
  await page.getByText('Choose a pack').waitFor()
}

async function capture(colorScheme) {
  await page.emulateMedia({ colorScheme })
  await page.goto(url, { waitUntil: 'networkidle' })
  await hidePlayground()
  await page.getByRole('tab', { name: 'Board' }).click()
  await page.getByText('Review supplier terms', { exact: true }).waitFor()
  await shot(`board-${colorScheme}`)

  await page.getByText('Confirm support rota', { exact: true }).click()
  await page.getByRole('complementary', { name: 'Task details' }).waitFor()
  await page.getByRole('button', { name: /#launch · Quân/ }).waitFor()
  await shot(`card-detail-${colorScheme}`)
  await page.getByRole('complementary', { name: 'Task details' }).getByRole('button', { name: 'Close' }).click()

  await openWallet()
  await shot(`wallet-${colorScheme}`)
  await page.locator('[data-company-wallet]').getByRole('button', { name: 'Close' }).click()

  await page.getByRole('tab', { name: 'Chat' }).click()
  await page
    .getByText('Release B includes the company board, cited project brief, and shared Chief of Staff.', {
      exact: true
    })
    .waitFor()
  await shot(`cos-answer-${colorScheme}`)
}

async function captureNarrow(colorScheme) {
  await page.setViewportSize({ width: 760, height: 820 })
  await page.emulateMedia({ colorScheme })
  await page.goto(url, { waitUntil: 'networkidle' })
  await hidePlayground()
  await page.getByRole('combobox', { name: 'Open company page' }).selectOption('board')
  await page.getByText('Review supplier terms', { exact: true }).waitFor()
  await shot(`board-narrow-${colorScheme}`)
}

try {
  await capture('light')
  await capture('dark')
  await captureNarrow('light')
  await captureNarrow('dark')
} finally {
  await browser.close()
}
