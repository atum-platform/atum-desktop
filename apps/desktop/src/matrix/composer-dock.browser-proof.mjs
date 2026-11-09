/* global document, getComputedStyle */
// Real-layout proof of the floating composer, in Chrome against the design playground (dev only).
//
//   npx vite --config <config serving apps/desktop>   # then:
//   node src/matrix/composer-dock.browser-proof.mjs http://127.0.0.1:5198 [output-dir]
//
// Needs `playwright-core` and a system Chrome (CHROME=/path overrides the macOS default). Measures, with real
// layout, what jsdom cannot:
//   - the companion's PAWS (the lowest opaque pixel of her canvas, not her box: the sprite has transparent
//     padding under the feet) stand on her ground: the glass's top edge while she is on the rim, the floor (the
//     stage's foot, in front of the card since d6faf7ae) otherwise. Within +-2 px while she stands, touching it on
//     a footfall while she walks, never more than 6 px into it (a jump frame paints a little below the line);
//     with one line and after the composer grew to four (grown while she is at rest). She reaches the rim;
//   - a composer that grows while she walks its rim re-homes her onto the new rim within about a world re-read
//     (asserted: under 750 ms; before the engine fix this took the whole walk, 13-20 s);
//   - her layer paints above the composer's, so the glass never hides her;
//   - the transcript runs to the column foot and keeps the dock's height clear below the last message;
//   - the dock edge paints nothing (no colour, no blur, no mask) and takes no pointer events: the ledge it once
//     drew over the transcript is composer-ledge.browser-proof.mjs.
// Exits non-zero on a miss.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'

const base = process.argv[2] ?? 'http://127.0.0.1:5198'
const output = process.argv[3] ?? '/tmp/composer-dock-proof'
mkdirSync(output, { recursive: true })

// The engine places her on whole pixels and the rim can be fractional: feet are "on" it within this.
const TOUCH_PX = 2
// The deepest a painted paw may go into the glass (the jump frame paints ~10 atlas px below the idle baseline).
const MAX_DIP_PX = 6
// Poses whose paws are painted on the idle baseline (the one the stage aligns to the floor).
const STANCE = new Set(['idle', 'review', 'look-0', 'look-1'])

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true
})

// Positive gap = her lowest painted pixel is that many px above her ground (the glass's top edge on the rim, the
// stage's foot on the floor); negative = inside it.
const depth = page =>
  page.evaluate(() => {
    const body = document.querySelector('[data-pet-pose]')
    const canvas = body.querySelector('canvas')
    const box = canvas.getBoundingClientRect()
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let lowest = -1

    for (let y = canvas.height - 1; y >= 0 && lowest < 0; y--) {
      for (let x = 0; x < canvas.width; x++) {
        if (pixels[(y * canvas.width + x) * 4 + 3] > 24) {
          lowest = y

          break
        }
      }
    }

    const surface = document.querySelector('[data-slot="composer-surface"]').getBoundingClientRect()
    const stage = document.querySelector('[data-pet-stage-window]').getBoundingClientRect()
    const hit = document.querySelector('[data-pet-hit-box]').getBoundingClientRect()
    const rim = (body.getAttribute('data-pet-surface') ?? 'floor').startsWith('composer')

    return {
      gap: (rim ? surface.top : stage.bottom) - (box.top + ((lowest + 1) * box.height) / canvas.height),
      rim,
      pose: body.dataset.petPose,
      walking: body.dataset.walking === 'true',
      x: Math.round(hit.left)
    }
  })

const rows = []
let rimFrames = 0

for (const width of [1200, 700]) {
  for (const lines of [1, 4]) {
    const context = await browser.newContext({ viewport: { width, height: 760 }, deviceScaleFactor: 1 })
    const page = await context.newPage()
    await page.goto(`${base}/matrix-playground.html?scenario=chat-long&lang=en`)
    await page.waitForSelector('[data-matrix-composer-dock] [data-matrix-pet]', { timeout: 60_000 })
    await page.waitForSelector('[data-pet-hit-box]', { timeout: 20_000 })

    if (lines > 1) {
      const input = page.locator('[data-slot="composer-rich-input"]').first()
      await input.click()

      // Grow it while she is at rest: she re-homes onto the new rim within her world re-read (~250 ms).
      for (let waited = 0; waited < 60_000 && (await depth(page)).walking; waited += 250) {
        await page.waitForTimeout(250)
      }

      await input.fill(Array.from({ length: lines }, (_, line) => `Line ${line + 1}`).join('\n'))
      await page.waitForTimeout(1200)
    }

    const worst = { deepest: Infinity, touched: false, stance: [], samples: 0, xs: new Set() }

    const look = async () => {
      const m = await depth(page)
      worst.samples += 1
      worst.xs.add(m.x)
      worst.deepest = Math.min(worst.deepest, m.gap)
      worst.touched ||= Math.abs(m.gap) <= TOUCH_PX
      rimFrames += m.rim ? 1 : 0

      if (STANCE.has(m.pose) && !m.walking) {
        worst.stance.push(Number(m.gap.toFixed(1)))
      }
    }

    for (let sample = 0; sample < 40; sample++) {
      await page.waitForTimeout(250)
      await look()
    }

    // She stands only now and then: keep looking (up to 90 s) until she has stood a few times in this setup.
    for (let more = 0; more < 360 && worst.stance.length < 3; more++) {
      await page.waitForTimeout(250)
      await look()
    }

    const layout = await page.evaluate(() => {
      const rect = element => element?.getBoundingClientRect()
      const dock = document.querySelector('[data-matrix-composer-dock]')
      const viewport = document.querySelector('[data-slot="aui_thread-viewport"]')
      const clearance = document.querySelector('[data-slot="aui_dock-clearance"]')
      const edge = getComputedStyle(document.querySelector('[data-matrix-dock-edge]'))
      viewport.scrollTop = viewport.scrollHeight

      return {
        dockVar: dock.parentElement.style.getPropertyValue('--atum-dock-height'),
        dock: rect(dock).height,
        clearance: rect(clearance).height,
        viewportBottom: rect(viewport).bottom,
        // The dock's parent can be a `display: contents` wrapper; the positioned ancestor has the box.
        columnBottom: rect(dock.offsetParent).bottom,
        lastMessageBottom: rect(document.querySelector('[data-slot="aui_thread-content"]')).bottom - rect(clearance).height,
        composerTop: rect(document.querySelector('[data-slot="composer-surface"]')).top,
        edgeBackground: edge.backgroundColor,
        edgeBackdrop: edge.backdropFilter,
        edgeMask: edge.maskImage,
        edgePointerEvents: edge.pointerEvents,
        edgeHeight: rect(document.querySelector('[data-matrix-dock-edge]')).height,
        edgeZ: Number(edge.zIndex),
        petZ: Number(getComputedStyle(document.querySelector('[data-pet-stage-window]')).zIndex),
        dockZ: Number(getComputedStyle(dock).zIndex)
      }
    })

    await page.screenshot({ path: `${output}/proof-${width}-${lines}line.png` })
    await context.close()
    rows.push({ width, lines, worst: { ...worst, xs: worst.xs.size }, layout })

    const label = `${width}px, ${lines} line(s)`
    assert.ok(worst.xs.size >= 2 || width === 700, `${label}: she moved`)
    // Her paws are on her ground (rim or floor), and never more than a jump frame's worth inside it.
    assert.ok(worst.deepest >= -MAX_DIP_PX, `${label}: her paws went ${-worst.deepest}px into her ground`)
    assert.ok(worst.touched, `${label}: her feet never reached her ground`)
    assert.ok(worst.stance.length >= 3, `${label}: she never stood (${worst.stance.length} samples)`)
    assert.ok(worst.stance.every(gap => Math.abs(gap) <= TOUCH_PX), `${label}: standing, her feet were off her ground: ${worst.stance}`)
    assert.ok(Math.abs(layout.viewportBottom - layout.columnBottom) <= 1, `${label}: transcript runs to the foot`)
    assert.equal(layout.dockVar, `${Math.ceil(layout.dock)}px`)
    assert.ok(layout.lastMessageBottom <= layout.composerTop, `${label}: last message clears the composer`)
    assert.equal(layout.edgeBackground, 'rgba(0, 0, 0, 0)', 'the dock edge paints no colour')
    assert.equal(layout.edgeBackdrop, 'none', 'the dock edge blurs nothing')
    assert.equal(layout.edgeMask, 'none', 'the dock edge has nothing to mask')
    assert.equal(layout.edgePointerEvents, 'none')
    assert.ok(Math.abs(layout.edgeHeight - layout.dock) <= 1, `${label}: the dock edge is the dock's height`)
    assert.ok(layout.edgeZ < layout.dockZ && layout.dockZ < layout.petZ, `${label}: edge ${layout.edgeZ} < dock ${layout.dockZ} < her layer ${layout.petZ}`)
    assert.ok(layout.petZ > layout.dockZ, `${label}: her layer (${layout.petZ}) is above the dock (${layout.dockZ})`)
  }
}

assert.ok(rimFrames > 0, 'she never stood on the composer rim')

// The composer grows while she walks its rim: she re-homes onto the new rim, not at the end of the walk.
const context = await browser.newContext({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 1 })
const page = await context.newPage()
await page.goto(`${base}/matrix-playground.html?scenario=chat-long&lang=en`)
await page.waitForSelector('[data-pet-hit-box]', { timeout: 60_000 })
const input = page.locator('[data-slot="composer-rich-input"]').first()
await input.click()

for (let waited = 0; waited < 120_000; waited += 100) {
  const m = await depth(page)

  if (m.walking && m.rim) {
    break
  }

  await page.waitForTimeout(100)
}

const atGrowth = await depth(page)
const walkingAtGrowth = atGrowth.walking && atGrowth.rim
await input.fill('a\nb\nc\nd')
const grewAt = Date.now()
let rehomedMs = null

for (let waited = 0; waited < 20_000; waited += 50) {
  const m = await depth(page)

  if (m.gap >= -MAX_DIP_PX) {
    rehomedMs = Date.now() - grewAt

    break
  }

  await page.waitForTimeout(50)
}

await page.screenshot({ path: `${output}/proof-grown-mid-walk.png` })
assert.ok(walkingAtGrowth, 'she was walking the rim when the composer grew')
assert.ok(rehomedMs !== null && rehomedMs <= 750, `re-homed after ${rehomedMs} ms (the world re-read is ~250 ms)`)

await context.close()
await browser.close()
console.log(JSON.stringify({ rows, rimFrames, grownMidWalk: { walkingAtGrowth, rehomedMs } }, null, 1))
