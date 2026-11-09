/* global document, getComputedStyle, Image */
// Real Chromium proof that nothing around the floating composer paints a band over the transcript (the
// Preserve user-visible identity, state and recovery behavior across connection changes.
//
//   npx vite --host 127.0.0.1 --port 5198      # from apps/desktop, then:
//   node src/matrix/composer-ledge.browser-proof.mjs http://127.0.0.1:5198 [output-dir]
//
// Needs `playwright-core` and a system Chrome (CHROME=/path overrides the macOS default).
//
// For each scenario (light and dark; full width and split beside the side panel) the transcript is scrolled
// so its text passes under the dock, the companion's layer is hidden (she moves; she is not the band), and the
// strip from just above the dock to the column's foot is captured three times:
//   real    - the app as it ships;
//   control - the same with the old full-width scroll-edge blur put back (proves the check sees a ledge);
//   bare    - the dock and its edge hidden: the transcript alone.
// Outside the card and its own shadow, real must equal bare pixel for pixel (within anti-aliasing), and
// control must not. Exits non-zero on a miss and writes the three captures per scenario.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { chromium } from 'playwright-core'

const base = process.argv[2] ?? 'http://127.0.0.1:5198'
const output = process.argv[3] ?? '/tmp/composer-ledge-proof'
mkdirSync(output, { recursive: true })

// A channel differing by more than this is a painted difference, not anti-aliasing.
const CHANNEL_TOLERANCE = 6
// The card's own shadow (Atum Kit --ak-shadow-2: 0 14px 36px -10px) reaches 12 px above it, 26 px beside and
// 40 px below; the excluded box is a little wider.
const SHADOW = { top: 14, side: 28, bottom: 44 }
// Captured from this far above the dock's top, so a band starting at the dock shows its edge.
const ABOVE_DOCK = 24

// The scroll edge as it shipped through 0.20.28 (styles.css), for the negative control.
const OLD_EDGE = `[data-matrix-dock-edge] {
  -webkit-backdrop-filter: blur(0.75rem); backdrop-filter: blur(0.75rem);
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 2.5rem);
  mask-image: linear-gradient(to bottom, transparent, #000 2.5rem);
}`

const scenarios = ['light', 'dark'].flatMap(theme => [
  { theme, width: 1470, height: 920, split: false },
  { theme, width: 1280, height: 800, split: false },
  { theme, width: 1600, height: 1000, split: true },
  { theme, width: 1470, height: 920, split: true }
])

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true
})

// Decodes PNGs in a blank page (no image library needed) and counts differing pixels outside the card box.
const decoder = await (await browser.newContext()).newPage()

const compare = (a, b, size, exclude) =>
  decoder.evaluate(
    async ({ a, b, size, exclude, tolerance }) => {
      const pixels = async data => {
        const image = new Image()
        image.src = `data:image/png;base64,${data}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = size.width
        canvas.height = size.height
        const context = canvas.getContext('2d')
        context.drawImage(image, 0, 0)

        return context.getImageData(0, 0, size.width, size.height).data
      }

      const [left, right] = [await pixels(a), await pixels(b)]
      let differing = 0
      let above = 0
      let worst = 0
      const rows = new Set()

      for (let y = 0; y < size.height; y++) {
        for (let x = 0; x < size.width; x++) {
          if (x >= exclude.left && x < exclude.right && y >= exclude.top && y < exclude.bottom) {
            continue
          }

          const at = (y * size.width + x) * 4
          const delta = Math.max(
            Math.abs(left[at] - right[at]),
            Math.abs(left[at + 1] - right[at + 1]),
            Math.abs(left[at + 2] - right[at + 2])
          )
          worst = Math.max(worst, delta)

          if (delta > tolerance) {
            differing += 1
            rows.add(y)
            above += y < exclude.top ? 1 : 0
          }
        }
      }

      return { differing, above, worst, rows: rows.size }
    },
    { a, b, size, exclude, tolerance: CHANNEL_TOLERANCE }
  )

const report = []
let failed = false

for (const scenario of scenarios) {
  const label = `${scenario.theme}-${scenario.width}x${scenario.height}-${scenario.split ? 'split' : 'full'}`
  const context = await browser.newContext({
    viewport: { width: scenario.width, height: scenario.height },
    deviceScaleFactor: 1,
    colorScheme: scenario.theme
  })
  const page = await context.newPage()
  await page.goto(`${base}/matrix-playground.html?scenario=chat-long&lang=en`)
  await page.waitForSelector('[data-pet-hit-box]', { timeout: 90_000 })
  // The playground's own controls float over the window; her layer moves between captures.
  await page.addStyleTag({
    content: '[data-matrix-playground]{display:none!important} [data-pet-stage-window]{visibility:hidden!important}'
  })

  if (scenario.split) {
    await page.getByRole('button', { name: 'Show side panel' }).click()
    await page.waitForSelector('[data-atum-workspace]:not([hidden])', { timeout: 5_000 })
    assert.equal(
      await page.locator('[data-overlay-surface]').count(),
      0,
      `${label}: the side panel stands beside the chat`
    )
  }

  await page.waitForTimeout(800)
  // Text under the dock: the last lines scroll up behind the composer, as when reading back a little.
  await page.evaluate(() => {
    const viewport = document.querySelector('[data-slot="aui_thread-viewport"]')
    viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight - 120
  })
  await page.waitForTimeout(800)

  const geometry = await page.evaluate(() => {
    const dock = document.querySelector('[data-matrix-composer-dock]')
    const column = dock.offsetParent.getBoundingClientRect()
    const card = document.querySelector('[data-slot="composer-surface"]').getBoundingClientRect()
    const edge = getComputedStyle(document.querySelector('[data-matrix-dock-edge]'))

    return {
      column: column.toJSON(),
      dock: dock.getBoundingClientRect().toJSON(),
      card: card.toJSON(),
      edge: { background: edge.backgroundColor, backdrop: edge.backdropFilter, mask: edge.maskImage }
    }
  })

  const clip = {
    x: Math.ceil(geometry.column.left),
    y: Math.max(0, Math.floor(geometry.dock.top - ABOVE_DOCK)),
    width: Math.floor(geometry.column.right) - Math.ceil(geometry.column.left),
    height: Math.floor(geometry.column.bottom) - Math.max(0, Math.floor(geometry.dock.top - ABOVE_DOCK))
  }
  const exclude = {
    left: Math.floor(geometry.card.left - clip.x - SHADOW.side),
    right: Math.ceil(geometry.card.right - clip.x + SHADOW.side),
    top: Math.floor(geometry.card.top - clip.y - SHADOW.top),
    bottom: Math.ceil(geometry.card.bottom - clip.y + SHADOW.bottom)
  }

  const shot = async name => {
    const buffer = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' })
    writeFileSync(path.join(output, `${label}-${name}.png`), buffer)

    return buffer.toString('base64')
  }

  const real = await shot('real')
  const control = await page.addStyleTag({ content: OLD_EDGE })
  await page.waitForTimeout(200)
  const old = await shot('control')
  await control.evaluate(element => element.remove())
  await page.addStyleTag({
    content: '[data-matrix-composer-dock],[data-matrix-dock-edge]{visibility:hidden!important}'
  })
  await page.waitForTimeout(200)
  const bare = await shot('bare')

  const size = { width: clip.width, height: clip.height }
  const shipped = await compare(real, bare, size, exclude)
  const negative = await compare(old, bare, size, exclude)
  const edgePaintsNothing =
    geometry.edge.background === 'rgba(0, 0, 0, 0)' &&
    geometry.edge.backdrop === 'none' &&
    geometry.edge.mask === 'none'

  // The old blur must show (the check can see a ledge); the shipped app must match the bare transcript.
  const ok = shipped.differing === 0 && negative.differing > 200 && negative.above > 0 && edgePaintsNothing
  failed ||= !ok
  report.push({ label, ok, clip, exclude, edge: geometry.edge, shipped, negative })
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${label}: shipped vs bare ${JSON.stringify(shipped)}; old edge vs bare ${JSON.stringify(negative)}; edge ${JSON.stringify(geometry.edge)}`
  )
  await context.close()
}

await browser.close()
writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
console.log(
  `${failed ? 'FAIL' : 'PASS'}: ${report.filter(row => row.ok).length}/${report.length} scenarios; report ${path.join(output, 'report.json')}`
)
assert.ok(!failed, 'something around the composer paints a band over the transcript, or the control did not see one')
