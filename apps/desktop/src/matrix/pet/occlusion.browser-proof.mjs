/* global document, getComputedStyle, Node */
// Real Chromium proof that nothing ever paints over the strolling companion, and that the ground in
// front of the composer is hers to walk. Runs the real Matrix playground (the real MatrixApp from
// app.tsx with styles.css, real pet engine, real bundled Gigi pixels) on a virtual clock. Dev only:
//
//   npx vite --host 127.0.0.1 --port 5198      # from apps/desktop, then:
//   node src/matrix/pet/occlusion.browser-proof.mjs http://127.0.0.1:5198 [output-dir]
//
// Needs `playwright-core` and a system Chrome (CHROME=/path overrides the macOS default).
//
// For every scenario (window size x composer state x light/dark) she roams for a stretch of
// virtual time and is also dropped across the window at floor and rim height. At every sampled
// frame, each opaque pixel of her canvas (5 px grid) is hit-tested with document.elementsFromPoint
// (pointer-events forced on): every element above her pet layer at that point must paint nothing
// there. Standing on a rim (not mid-leap), no opaque pixel may lie inside the composer card beyond a
// paw's 6 px dip; no opaque pixel may ever lie inside an open menu.
//
// The ground : wherever the composer shows,
// she must stand on the floor in front of the card, uncovered. A drop on the floor at the card's
// middle must stay there, and her roaming and drops must put her there at least once. (The 35/35
// run of 0.20.27 passed while she could not set foot in front of the card: this check was missing.)
// Exits non-zero on any miss and writes the first offending frame of each scenario, plus a
// bottom-ground frame per theme, to the output directory.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { chromium } from 'playwright-core'

const base = process.argv[2] ?? 'http://127.0.0.1:5198'
const output = process.argv[3] ?? '/tmp/gigi-occlusion-proof'
mkdirSync(output, { recursive: true })

const ROAM_MS = Number(process.env.ROAM_MS ?? 60_000)
const STEP_MS = 150
// A walking footfall and the jump frame paint a little under the idle foot line.
const PAW_DIP_PX = 6

// The owner's maximised windows on a 13.6" display (1470 x 920 and 1280 x 800 points) among them.
const SIZES = [
  { width: 1600, height: 1000 },
  { width: 1470, height: 920 },
  { width: 1280, height: 800 },
  { width: 1200, height: 760 },
  { width: 900, height: 700 },
  { width: 760, height: 680 }
]

// side-panel is the split (a full-frame panel where the window is too narrow); full-frame expands it.
const STATES = ['one-line', 'four-lines', 'plus-menu', 'model-menu', 'side-panel', 'full-frame']

const scenarios = [
  ...SIZES.flatMap(size => STATES.map(state => ({ ...size, state, theme: 'light' }))),
  ...SIZES.filter(size => [1600, 1280, 760].includes(size.width)).flatMap(size =>
    STATES.map(state => ({ ...size, state, theme: 'dark' }))
  )
]

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true
})

/** One sampled frame: where she is, and every pixel of her that something covers or that covers UI. */
const sample = page =>
  page.evaluate(
    ({ dip }) => {
      const layer = document.querySelector('[data-pet-stage-window]')
      const body = layer?.querySelector('[data-pet-pose]')
      const canvas = body?.querySelector('canvas')

      if (!body || !canvas || body.style.opacity === '0' || getComputedStyle(body).visibility === 'hidden') {
        return { visible: false }
      }

      const box = canvas.getBoundingClientRect()
      // Her own stage clips at the window's edge (a jump frame's paws dip below the bottom line);
      // what her layer clips is not something covering her.
      const clip = layer.getBoundingClientRect()
      const mirrored = (canvas.parentElement?.style.transform ?? '').includes('scaleX(-1)')
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      const surface = document.querySelector('[data-slot="composer-surface"]')?.getBoundingClientRect()

      const menus = [...document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]')]
        .filter(element => !element.closest('[data-pet-own]') && !element.querySelector('[data-pet-own]'))
        .map(element => element.getBoundingClientRect())
        .filter(rect => rect.width > 0 && rect.height > 0)

      const pose = body.getAttribute('data-pet-pose')
      const leaping = pose === 'jump'
      const perched = (body.getAttribute('data-pet-surface') ?? 'floor') !== 'floor'

      // What would actually show at (x, y) from `element`: a background, a border, a shadow, a
      // backdrop filter, replaced content, or its own text there.
      const paints = (element, x, y) => {
        for (let up = element; up && up !== document.documentElement; up = up.parentElement) {
          const style = getComputedStyle(up)

          if (Number(style.opacity) === 0 || style.visibility === 'hidden') {
            return false
          }
        }

        if (['CANVAS', 'IMG', 'svg', 'VIDEO', 'IFRAME', 'INPUT', 'TEXTAREA'].includes(element.tagName)) {
          return true
        }

        const style = getComputedStyle(element)
        const alpha = colour => {
          const match = /rgba?\(([^)]+)\)/.exec(colour)

          return match ? Number(match[1].split(',')[3] ?? 1) : 0
        }

        const bordered = ['Top', 'Right', 'Bottom', 'Left'].some(
          side => parseFloat(style[`border${side}Width`]) > 0 && alpha(style[`border${side}Color`]) > 0
        )

        if (
          alpha(style.backgroundColor) > 0 ||
          style.backgroundImage !== 'none' ||
          style.boxShadow !== 'none' ||
          (style.backdropFilter && style.backdropFilter !== 'none') ||
          bordered
        ) {
          return true
        }

        return [...element.childNodes].some(node => {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) {
            return false
          }

          const range = document.createRange()
          range.selectNodeContents(node)

          return [...range.getClientRects()].some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
        })
      }

      const describe = element =>
        `${element.tagName.toLowerCase()}${element.getAttribute('data-slot') ? `[data-slot=${element.getAttribute('data-slot')}]` : ''}${element.getAttribute('role') ? `[role=${element.getAttribute('role')}]` : ''}.${(element.getAttribute('class') ?? '').split(' ').slice(0, 3).join('.')}`

      const covered = []
      const intrudes = []
      let opaque = 0

      {
        for (let y = box.top + 2; y < box.bottom; y += 5) {
          for (let x = box.left + 2; x < box.right; x += 5) {
            const column = Math.floor(((x - box.left) / box.width) * canvas.width)
            const col = mirrored ? canvas.width - 1 - column : column
            const row = Math.floor(((y - box.top) / box.height) * canvas.height)

            if (
              pixels[(row * canvas.width + col) * 4 + 3] <= 24 ||
              x < clip.left ||
              x >= clip.right ||
              y < clip.top ||
              y >= clip.bottom
            ) {
              continue
            }

            opaque += 1

            for (const element of document.elementsFromPoint(x, y)) {
              if (layer.contains(element)) {
                break
              }

              if (paints(element, x, y)) {
                covered.push({ x: Math.round(x), y: Math.round(y), by: describe(element) })

                break
              }
            }

            if (!leaping) {
              // On the floor she stands in front of the card (her layer is above it); on a rim she
              // must not sink into it.
              const inCard =
                perched && surface && x > surface.left && x < surface.right && y > surface.top + dip && y < surface.bottom
              const inMenu = menus.some(rect => x > rect.left && x < rect.right && y > rect.top && y < rect.bottom)

              if (inCard || inMenu) {
                intrudes.push({ x: Math.round(x), y: Math.round(y), into: inCard ? 'composer' : 'menu' })
              }
            }
          }
        }
      }

      const centre = (box.left + box.right) / 2
      // In front of the card: on the floor, standing, her middle over the card's width.
      const inFront = Boolean(
        !perched && !leaping && surface && centre > surface.left && centre < surface.right && covered.length === 0
      )

      return {
        visible: true,
        pose,
        inFront,
        surface: body.getAttribute('data-pet-surface'),
        box: { left: Math.round(box.left), top: Math.round(box.top), right: Math.round(box.right), bottom: Math.round(box.bottom) },
        opaque,
        covered: covered.slice(0, 4),
        coveredCount: covered.length,
        intrudes: intrudes.slice(0, 4),
        intrudesCount: intrudes.length
      }
    },
    { dip: PAW_DIP_PX }
  )

/** Pick her up and drop her at (x, y) in viewport pixels (her paws), like a person would. */
async function drop(page, x, y) {
  const hit = page.locator('[data-pet-hit-box]')
  const [hitBox, bodyBox] = await Promise.all([hit.boundingBox(), page.locator('[data-pet-pose]').boundingBox()])

  if (!hitBox || !bodyBox) {
    return false
  }

  const pointer = { x: hitBox.x + hitBox.width / 2, y: hitBox.y + hitBox.height / 2 }
  const offset = { x: pointer.x - bodyBox.x, y: pointer.y - bodyBox.y }
  const footY = (bodyBox.height * 195) / 208
  const to = { x: x - bodyBox.width / 2 + offset.x, y: y - footY + offset.y }
  const pointerId = 31

  await page.locator('[data-pet-pose]').evaluate(element => {
    element.setPointerCapture = () => {}
    element.releasePointerCapture = () => {}
  })
  await hit.dispatchEvent('pointerdown', { bubbles: true, button: 0, clientX: pointer.x, clientY: pointer.y, pointerId })
  await hit.dispatchEvent('pointermove', { bubbles: true, clientX: to.x, clientY: to.y, pointerId })
  await hit.dispatchEvent('pointerup', { bubbles: true, button: 0, clientX: to.x, clientY: to.y, pointerId })

  return true
}

async function enter(page, state) {
  if (state === 'four-lines') {
    const input = page.locator('[data-slot="composer-rich-input"]').first()
    await input.click()
    await input.fill(['Line 1', 'Line 2', 'Line 3', 'Line 4'].join('\n'))
  } else if (state === 'plus-menu') {
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await page.waitForSelector('[role="menu"]', { timeout: 5_000 })
  } else if (state === 'model-menu') {
    await page.getByRole('button', { name: /^Model:/ }).first().click()
    await page.waitForSelector('[data-radix-popper-content-wrapper]', { timeout: 5_000 })
  } else if (state === 'side-panel' || state === 'full-frame') {
    await page.getByRole('button', { name: 'Show side panel' }).click()
    await page.waitForSelector('[data-atum-workspace]:not([hidden])', { timeout: 5_000 })

    // A narrow window's panel already owns the frame (and offers no Expand).
    if (state === 'full-frame' && (await page.locator('[data-atum-workspace]:not([data-overlay-surface])').count()) > 0) {
      await page.locator('[data-atum-workspace-expand]').click()
      await page.waitForSelector('[data-atum-workspace][data-atum-full-frame="true"]', { timeout: 5_000 })
    }
  }
}

const report = { base, roamMs: ROAM_MS, scenarios: [] }
let failed = false

// ONLY=<regex> narrows the run to matching scenario labels while iterating.
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : undefined

for (const scenario of scenarios) {
  const label = `${scenario.theme}-${scenario.width}x${scenario.height}-${scenario.state}`

  if (only && !only.test(label)) {
    continue
  }
  const context = await browser.newContext({
    viewport: { width: scenario.width, height: scenario.height },
    deviceScaleFactor: 1,
    colorScheme: scenario.theme
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))

  await page.clock.install()
  await page.goto(`${base}/matrix-playground.html?scenario=chat-long&lang=en`)
  await page.waitForSelector('[data-pet-hit-box]', { timeout: 60_000 })
  await page.addStyleTag({ content: '[data-matrix-playground]{display:none!important}' })
  await page.clock.runFor(1_500)
  await enter(page, scenario.state)
  await page.clock.runFor(1_000)
  // Hit-test what is painted, not what takes the pointer: the stage, the dock and an open modal menu
  // all opt out of pointer events. Installed once (it restyles the page); nothing below clicks.
  await page.addStyleTag({ content: '*, *::before, *::after { pointer-events: auto !important; }' })

  const result = {
    label,
    frames: 0,
    hidden: 0,
    covered: 0,
    intrudes: 0,
    inFront: 0,
    groundDrop: undefined,
    surfaces: {},
    first: undefined,
    errors
  }
  let grounded = false

  const look = async origin => {
    const frame = await sample(page)
    result.frames += 1

    if (!frame.visible) {
      result.hidden += 1

      return frame
    }

    result.surfaces[frame.surface] = (result.surfaces[frame.surface] ?? 0) + 1
    result.inFront += frame.inFront ? 1 : 0

    if (frame.coveredCount || frame.intrudesCount) {
      result.covered += frame.coveredCount ? 1 : 0
      result.intrudes += frame.intrudesCount ? 1 : 0

      if (!result.first) {
        result.first = { origin, ...frame }
        await page.screenshot({ path: path.join(output, `${label}-violation.png`) })
      }
    }

    if (!grounded && scenario.state === 'one-line' && frame.inFront) {
      grounded = true
      await page.screenshot({ path: path.join(output, `ground-${scenario.theme}-${scenario.width}.png`) })
    }

    return frame
  }

  for (let elapsed = 0; elapsed < ROAM_MS; elapsed += STEP_MS) {
    await page.clock.runFor(STEP_MS)
    await look('roam')
  }

  // Drops across the window at floor height and at the composer's rim height.
  const geometry = await page.evaluate(() => ({
    stage: document.querySelector('[data-pet-stage-window]')?.getBoundingClientRect().toJSON(),
    composer: document.querySelector('[data-slot="composer-surface"]')?.getBoundingClientRect().toJSON()
  }))

  if (geometry.stage) {
    const levels = [geometry.stage.bottom - 1, ...(geometry.composer ? [geometry.composer.top] : [])]

    for (const y of levels) {
      for (let step = 0; step <= 10; step++) {
        const x = geometry.stage.left + 30 + ((geometry.stage.width - 60) * step) / 10

        if (await drop(page, x, y)) {
          await page.clock.runFor(200)
          await look(`drop ${Math.round(x)},${Math.round(y)}`)
          await page.clock.runFor(1_200)
          await look(`after drop ${Math.round(x)},${Math.round(y)}`)
        }
      }
    }
  }

  // A side panel that owns the frame covers the chat and its composer: out of sight is then right.
  const overFrame = await page.evaluate(() => Boolean(document.querySelector('[data-overlay-surface]')))

  // The ground in front of the card: dropped on the floor under the card's middle, she stays there.
  if (geometry.stage && geometry.composer && !overFrame) {
    const middle = (geometry.composer.left + geometry.composer.right) / 2

    if (await drop(page, middle, geometry.stage.bottom - 1)) {
      await page.clock.runFor(200)
      const landed = await look(`ground drop ${Math.round(middle)}`)
      result.groundDrop = {
        inFront: Boolean(landed?.inFront),
        surface: landed?.surface,
        box: landed?.box,
        card: [Math.round(geometry.composer.left), Math.round(geometry.composer.right)]
      }
    }
  }

  const visible = result.frames - result.hidden
  const ground = overFrame || !geometry.composer || (result.groundDrop?.inFront === true && result.inFront > 0)
  const ok =
    result.covered === 0 && result.intrudes === 0 && (visible > 0 || overFrame) && ground && errors.length === 0
  failed ||= !ok
  report.scenarios.push({ ...result, ok })
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${label}: ${result.frames} frames (${result.hidden} hidden), covered ${result.covered}, intrudes ${result.intrudes}, in front ${result.inFront}, ground drop ${JSON.stringify(result.groundDrop ?? null)}, surfaces ${JSON.stringify(result.surfaces)}${result.first ? `, first ${JSON.stringify(result.first)}` : ''}${errors.length ? `, errors ${errors.join('; ')}` : ''}`
  )
  await context.close()
}

await browser.close()
assert.ok(report.scenarios.length > 0, `no scenario matched ONLY=${process.env.ONLY ?? ''}`)
writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
console.log(`${failed ? 'FAIL' : 'PASS'}: ${report.scenarios.filter(s => s.ok).length}/${report.scenarios.length} scenarios; report ${path.join(output, 'report.json')}`)
assert.ok(!failed, 'something painted over the companion, she sank into the rim or a menu, or the ground in front of the composer was not hers')
