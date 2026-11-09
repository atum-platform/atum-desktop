/* global document */
// Real Chromium geometry proof against the Matrix playground. It opens the
// actual side-panel browser, drags the real bundled Gigi canvas to each named
// surface, and saves the two requested evidence frames.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { chromium } from 'playwright-core'

const base = process.argv[2] ?? 'http://127.0.0.1:5198'
const output = process.argv[3] ?? '/tmp/gigi-surfaces-proof'
mkdirSync(output, { recursive: true })

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true
})
const context = await browser.newContext({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 1 })
const page = await context.newPage()
await page.emulateMedia({ reducedMotion: 'reduce' })

const errors = []
page.on('pageerror', error => errors.push(error.message))

const placement = () =>
  page.evaluate(() => {
    const body = document.querySelector('[data-pet-pose]')
    const stage = document.querySelector('[data-matrix-pet-stroll]')
    const surface = body?.getAttribute('data-pet-surface') ?? ''
    const box = body?.getBoundingClientRect()
    const stageBox = stage?.getBoundingClientRect()

    if (!box || !stageBox) {
      return null
    }

    const footY = (box.height * 195) / 208

    const surfaces = [...document.querySelectorAll('[data-pet-walk-surface], [data-pet-perch]')].map(element => ({
      id: element.getAttribute('data-pet-walk-surface') ?? element.getAttribute('data-pet-perch'),
      rect: element.getBoundingClientRect().toJSON()
    }))

    return { foot: box.top + footY, left: box.left, stage: stageBox.toJSON(), surface, surfaces }
  })

const dragTo = async selector => {
  const hit = page.locator('[data-pet-hit-box]')
  const target = page.locator(selector)
  const [hitBox, bodyBox, targetBox] = await Promise.all([
    hit.boundingBox(),
    page.locator('[data-pet-pose]').boundingBox(),
    target.boundingBox()
  ])

  assert.ok(hitBox && bodyBox && targetBox, `drag geometry exists for ${selector}`)
  const pointer = { x: hitBox.x + hitBox.width / 2, y: hitBox.y + hitBox.height / 2 }
  const offset = { x: pointer.x - bodyBox.x, y: pointer.y - bodyBox.y }
  const footY = (bodyBox.height * 195) / 208
  const desired = { x: targetBox.x + Math.min(36, Math.max(8, targetBox.width / 4)), y: targetBox.y - footY }

  const pointerId = 29

  await page.locator('[data-pet-pose]').evaluate(element => {
    element.setPointerCapture = () => {}
    element.releasePointerCapture = () => {}
  })
  await hit.dispatchEvent('pointerdown', { bubbles: true, button: 0, clientX: pointer.x, clientY: pointer.y, pointerId })
  await hit.dispatchEvent('pointermove', {
    bubbles: true,
    clientX: desired.x + offset.x,
    clientY: desired.y + offset.y,
    pointerId
  })
  await hit.dispatchEvent('pointerup', {
    bubbles: true,
    button: 0,
    clientX: desired.x + offset.x,
    clientY: desired.y + offset.y,
    pointerId
  })
  await page.waitForTimeout(50)

  return { placement: await placement(), target: targetBox }
}

try {
  await page.goto(`${base}/matrix-playground.html?scenario=chat-long&lang=en`)
  await page.locator('[data-pet-hit-box]').waitFor({ state: 'visible', timeout: 60_000 })
  await page.getByRole('button', { name: 'Show side panel' }).click()
  const address = page.locator('[data-matrix-workbench-navigation] input')
  await address.fill('https://example.com/')
  await address.press('Enter')
  await page.locator('[data-atum-browser-page]:visible').waitFor({ state: 'visible' })

  const onBrowser = await dragTo('[data-atum-browser-page]:visible')
  assert.ok(onBrowser.placement?.surface.startsWith('browser:'), `browser kept its drop: ${JSON.stringify(onBrowser)}`)
  assert.ok(Math.abs(onBrowser.placement.foot - onBrowser.target.y) < 0.1, 'Gigi feet rest exactly on browser top')
  const browserShot = path.join(output, 'gigi-browser-top.png')
  await page.screenshot({ animations: 'disabled', path: browserShot })

  const onComposer = await dragTo('[data-pet-perch="composer"]')
  assert.ok(onComposer.placement?.surface.startsWith('composer:'), `composer kept its drop: ${JSON.stringify(onComposer)}`)
  assert.ok(Math.abs(onComposer.placement.foot - onComposer.target.y) < 0.1, 'Gigi feet rest exactly on composer rim')
  const composerShot = path.join(output, 'gigi-composer-rim.png')
  await page.screenshot({ animations: 'disabled', path: composerShot })

  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ browser: onBrowser, composer: onComposer, screenshots: [browserShot, composerShot] }, null, 2))
} finally {
  await browser.close()
}
