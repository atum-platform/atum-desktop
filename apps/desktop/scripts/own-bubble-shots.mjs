// Your own chat bubble (owner 2026-11-28): a 1:1 chat, a group chat and a Team Space thread, light and dark, plus
// the measured contrast of everything drawn on or beside your bubble (WCAG 2.x ratios, alpha composited).
// node scripts/own-bubble-shots.mjs http://127.0.0.1:5197 <output-directory> [chromium-executable] [label]
// Writes <label>-<scenario>-<scheme>.png and <label>-contrast.json into the output directory.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://127.0.0.1:5197'
const out = process.argv[3] ?? 'own-bubble-shots'
const label = process.argv[5] ?? 'shot'
await mkdir(out, { recursive: true })

const SCENARIOS = ['chat-people', 'chat-group-runs', 'team-space-threads']
const browser = await chromium.launch({ headless: true, executablePath: process.argv[4] || undefined })
const errors = []
const report = {}

try {
  for (const colorScheme of ['dark', 'light']) {
    for (const scenario of SCENARIOS) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 860 },
        deviceScaleFactor: 2,
        colorScheme
      })
      // shared/browser/policy.ts (reached from workbench.tsx since #149) reads node:net's isIP at import, which the
      // dev server's browser stub refuses, so the playground renders nothing. Hand the page a small isIP instead.
      await context.route(/__vite-browser-external:node:net/, route =>
        route.fulfill({
          contentType: 'text/javascript',
          body: "const isIP = value => /^\\d{1,3}(\\.\\d{1,3}){3}$/.test(value) ? 4 : /^[\\da-f:]+$/i.test(value) && value.includes(':') ? 6 : 0\nexport default { isIP }\nexport { isIP }\n"
        })
      )
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(`${scenario} ${colorScheme}: ${error.message}`))

      await page.goto(`${base}/matrix-playground.html?scenario=${scenario}&theme=${colorScheme}&evidence=1`, {
        timeout: 300_000
      })
      await page
        .locator('.composer-human-message:visible, .matrix-flat-message:visible')
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(() => errors.push(`${scenario} ${colorScheme}: no message rendered`))
      await page.waitForTimeout(800)
      await page.screenshot({ path: path.join(out, `${label}-${scenario}-${colorScheme}.png`) })
      report[`${scenario}/${colorScheme}`] = await page.evaluate(measure)
      console.log(scenario, colorScheme, 'done')
      await context.close()
    }
  }
} finally {
  await browser.close()
}

await writeFile(path.join(out, `${label}-contrast.json`), `${JSON.stringify(report, null, 2)}\n`)

if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
}

/* global document, getComputedStyle -- measure() runs in the page, not in Node. */
/** Runs in the page: the composited colours and ratios of your bubble, the quiet bubble and what sits on yours. */
function measure() {
  const parse = value => {
    const nums = (value.match(/-?[\d.]+(e-?\d+)?/g) ?? []).map(Number)

    if (value.startsWith('color(srgb')) {
      return { r: nums[0] * 255, g: nums[1] * 255, b: nums[2] * 255, a: nums.length > 3 ? nums[3] : 1 }
    }

    if (value.startsWith('rgb')) {
      return { r: nums[0], g: nums[1], b: nums[2], a: nums.length > 3 ? nums[3] : 1 }
    }

    return null
  }

  const over = (top, under) => {
    const a = top.a

    return {
      r: top.r * a + under.r * (1 - a),
      g: top.g * a + under.g * (1 - a),
      b: top.b * a + under.b * (1 - a),
      a: 1
    }
  }

  const ground = el => {
    const chain = []

    for (let node = el; node && node.nodeType === 1; node = node.parentElement) chain.unshift(node)
    // The window's panels are see-through over the frame; start from the main panel's own shade.
    let fill = resolve(el, 'var(--atum-main-bg, var(--atum-bg, #ffffff))') ?? { r: 255, g: 255, b: 255, a: 1 }

    for (const node of chain) {
      const bg = parse(getComputedStyle(node).backgroundColor)

      if (bg && bg.a > 0) fill = over(bg, fill)
    }

    return fill
  }

  const resolve = (host, value) => {
    const probe = document.createElement('span')
    probe.style.color = value
    host.append(probe)
    const colour = parse(getComputedStyle(probe).color)
    probe.remove()

    return colour
  }

  const ink = el => {
    let colour = parse(getComputedStyle(el).color)
    let opacity = 1

    for (let node = el; node && node.nodeType === 1; node = node.parentElement)
      opacity *= Number(getComputedStyle(node).opacity)

    return { ...colour, a: colour.a * opacity }
  }

  const lum = c => {
    const ch = v => {
      const s = v / 255

      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }

    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b)
  }

  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)

    return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100
  }

  const hex = c => `#${[c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`
  const visible = selector => [...document.querySelectorAll(selector)].find(el => el.getClientRects().length > 0)
  const own = visible('.composer-human-message')
  const theirs = visible('.matrix-chat-bubble')
  const result = {}

  if (own) {
    const ownBg = ground(own)
    result.ownBubble = hex(ownBg)
    result.ownText = { ink: hex(over(ink(own), ownBg)), ratio: ratio(over(ink(own), ownBg), ownBg) }

    if (theirs) {
      const theirBg = ground(theirs)
      result.theirBubble = hex(theirBg)
      result.ownVsTheirs = ratio(ownBg, theirBg)
    }

    const parts = {
      time: '.matrix-bubble-meta',
      quote: '[data-matrix-reply-quote]',
      quoteThread: '[data-matrix-reply-quote] [data-matrix-thread]',
      link: 'a',
      inlineCode: 'code',
      chip: '[data-slot="aui_directive-chip"]'
    }

    for (const [name, selector] of Object.entries(parts)) {
      const el = [...document.querySelectorAll(`.composer-human-message ${selector}`)].find(
        node => node.getClientRects().length > 0
      )

      if (el) {
        const bg = ground(el)
        const fg = over(ink(el), bg)
        result[name] = { ink: hex(fg), ground: hex(bg), ratio: ratio(fg, bg) }
      }
    }

    // Your bubble under the pointer: its text and its quietened time on the hover shade.
    const hover = resolve(own, 'var(--ak-bubble-own-hover)')

    if (hover && hover.a > 0) {
      const hoverBg = over(hover, ownBg)
      const text = over(ink(own), hoverBg)
      result.hoverText = { ink: hex(text), ground: hex(hoverBg), ratio: ratio(text, hoverBg) }
      const meta = [...own.querySelectorAll('.matrix-bubble-meta')][0]

      if (meta) result.hoverTime = { ratio: ratio(over(ink(meta), hoverBg), hoverBg) }
    }

    // Selected text inside your bubble: the selection fill over the bubble, the text keeps its ink.
    const probe = document.createElement('span')
    probe.style.color = 'var(--ui-selection-background)'
    own.append(probe)
    const selection = parse(getComputedStyle(probe).color)
    probe.remove()

    if (selection) {
      const fill = over(selection, ownBg)
      const text = over(ink(own), fill)
      result.selection = { ink: hex(text), ground: hex(fill), ratio: ratio(text, fill) }
    }
  }

  return result
}
