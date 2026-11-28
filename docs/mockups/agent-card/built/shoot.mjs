// Agent card revamp evidence (2026-11-28). Run from apps/desktop with the playground served:
//   npx vite --host 127.0.0.1 --port 5174
//   node ../../docs/mockups/agent-card/built/shoot.mjs http://127.0.0.1:5174 ../../docs/mockups/agent-card/built after
// Each shot is the agent's side panel beside its chat, tall enough to show the whole card.
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(path.resolve(process.cwd(), '../../package.json'))
const { chromium } = require('playwright')
const [base, out, prefix, only] = process.argv.slice(2)

const states = {
  normal: 'desk=free',
  working: 'desk=working',
  primary: 'desk=free&card=primary',
  menu: 'desk=free',
  editor: 'desk=free',
  routines: 'desk=free'
}

const browser = await chromium.launch({ channel: 'chrome' })

for (const [state, query] of Object.entries(states)) {
  if (only && !only.split(',').includes(state)) {
    continue
  }

  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1900 }, deviceScaleFactor: 2, colorScheme: scheme })
    const card = query.includes('card=') ? '' : '&card=other'
    await page.goto(`${base}/matrix-playground.html?scenario=chat&evidence=1&${query}${card}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(2500)
    const panel = page.locator('[data-matrix-assistant-info]').first()

    if (!(await panel.count())) {
      console.log(state, scheme, 'no panel')
      await page.close()
      continue
    }

    if (state === 'menu') {
      await page.locator('[data-assistant-card-more]').first().click()
      await page.waitForTimeout(400)
    } else if (state === 'editor') {
      await page.locator('[data-assistant-card-about-edit]').first().click()
      await page.waitForTimeout(500)
    } else if (state === 'routines') {
      await page.locator('[data-assistant-card-routines]').first().click()
      await page.waitForTimeout(800)
    }

    const target = state === 'editor' ? page.locator('[data-assistant-card-about-editor]') : panel.locator('xpath=..')
    await target.screenshot({ path: `${out}/${prefix}-${state}-${scheme}.png` })
    console.log('shot', `${prefix}-${state}-${scheme}.png`)
    await page.close()
  }
}

await browser.close()
