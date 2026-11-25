// Evidence for "Add contacts" (owner 2026-11-25): the real Matrix window on playground fixtures.
// Run the renderer (`npx vite --host 127.0.0.1 --port 5184`), then:
//   ATUM_ADD_CONTACTS_EVIDENCE=<dir> node scripts/add-contacts-evidence.mjs
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { chromium } from '@playwright/test'

const output = process.env.ATUM_ADD_CONTACTS_EVIDENCE ?? 'add-contacts-evidence'
const origin = process.env.ATUM_PLAYGROUND_ORIGIN ?? 'http://127.0.0.1:5184'

await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 })

const dialog = () => page.getByRole('dialog', { name: 'Add contacts' })
const shot = name => page.screenshot({ path: join(output, `${name}.png`), animations: 'disabled' })

async function open(colorScheme) {
  await page.emulateMedia({ colorScheme })
  await page.goto(`${origin}/matrix-playground.html?lang=en`, { waitUntil: 'networkidle' })
  await page.addStyleTag({ content: '[data-matrix-playground]{display:none!important}' })
  await page.locator('[data-atum-roster-foot]').getByRole('button', { name: 'Add contacts' }).click()
  await dialog().waitFor()
}

async function search(value) {
  const box = dialog().getByRole('textbox', { name: '@name or email' })
  await box.fill(value)
  await dialog().getByRole('button', { name: 'Find' }).click()
}

for (const scheme of ['light', 'dark']) {
  await open(scheme)
  await shot(`01-entry-dialog-${scheme}`)

  await search('@lan')
  await dialog().getByRole('button', { name: 'Message' }).first().waitFor()
  await shot(`02-found-by-handle-${scheme}`)

  await search('hello@example.com')
  await dialog().getByRole('button', { name: 'Invite to Atum' }).first().waitFor()
  await shot(`03-email-not-on-atum-${scheme}`)

  await dialog().getByRole('button', { name: 'Invite to Atum' }).click()
  await dialog().getByText('We emailed them a link to join.').waitFor()
  await shot(`04-invited-${scheme}`)

  await search('help@example.com')
  await dialog().getByRole('button', { name: 'Invite to Atum' }).click()
  await dialog().getByText('Invited recently. Try again later.').waitFor()
  await shot(`05-invite-limited-${scheme}`)
}

// The left panel's foot, where the entry lives.
await page.keyboard.press('Escape')
await page.locator('[data-atum-roster-foot]').screenshot({ path: join(output, '00-panel-foot-dark.png') })

await browser.close()
console.log(`ADD_CONTACTS_EVIDENCE_OK ${output}`)
