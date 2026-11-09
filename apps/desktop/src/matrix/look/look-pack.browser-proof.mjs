/* global document, getComputedStyle, HTMLElement */
// Real-Chromium regression proof for the look-pack renderer against the design playground.
//
//   dev-server run --name moon-look-proof -- npm exec vite -- --host 127.0.0.1 --port 5198
//   node src/matrix/look/look-pack.browser-proof.mjs http://127.0.0.1:5198
//
// It exercises Moon's declared look pack without app-specific renderer knowledge. The assertions
// cover the ordinary chat, split side panel, expanded/full-frame panel, the full-width card after
// closing a previously mounted panel, system light/dark modes, and the supported wide-window
// widths. They use Chromium's computed pseudo-element paint, which jsdom cannot provide.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const base = process.argv[2] ?? 'http://127.0.0.1:5198'
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await chromium.launch({ executablePath: chrome, headless: true })
const widths = [1280, 1470, 1600, 1920]

function assertNear(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= 0.02, `${label}: expected ${expected}, received ${actual}`)
}

function assertCover(state, label) {
  assert.equal(state.look, 'pack', `${label}: chat keeps its declared look pack`)
  assert.equal(state.lookTone, 'dark', `${label}: Moon's declared dark ground remains authoritative`)
  assert.equal(state.layerSize, 'cover', `${label}: renderer preserves the contract's cover fit`)
  assert.equal(state.layerPosition, 'center', `${label}: renderer preserves the contract's centered position`)
  assert.match(state.layerImage, /^url\("atum-look:\/\//u, `${label}: art still comes from the look-pack asset`)
  assert.match(state.backgroundImage, /atum-look:\/\//u, `${label}: art is painted on the chat card`)
  assert.match(state.backgroundSize, /(?:^|,\s*)cover(?:$|,)/u, `${label}: painted art uses cover scaling`)
  assert.ok(state.coveredWidth + 0.01 >= state.paintWidth, `${label}: art covers the chat width`)
  assert.ok(state.coveredHeight + 0.01 >= state.paintHeight, `${label}: art covers the chat height`)
  assert.ok(state.centered, `${label}: art stays centered`)
  assertNear(state.artBox.left, state.cardBox.left, `${label}: art starts at the chat card's left edge`)
  assertNear(state.artBox.top, state.cardBox.top, `${label}: art starts at the chat card's top edge`)
  assertNear(state.artBox.right, state.cardBox.right, `${label}: art reaches the chat card's right edge`)
  assertNear(state.artBox.bottom, state.cardBox.bottom, `${label}: art reaches the chat card's bottom edge`)
  assert.ok(state.identityColors, `${label}: app bubble/composer identity colors remain scoped`)
  assert.ok(state.lookTokens, `${label}: look-pack chat tokens remain scoped`)
}

async function lookState(page) {
  return page.locator('[data-atum-chat]').evaluate(chat => {
    const style = getComputedStyle(chat)
    const before = getComputedStyle(chat, '::before')
    const rect = chat.getBoundingClientRect()
    const workspace = document.querySelector('[data-atum-workspace][data-atum-drawer="false"]')
    const workspaceVisible = workspace instanceof HTMLElement && !workspace.hidden
    const inset = {
      top: Number.parseFloat(before.top) || 0,
      right: Number.parseFloat(before.right) || 0,
      bottom: Number.parseFloat(before.bottom) || 0,
      left: Number.parseFloat(before.left) || 0
    }
    const paintWidth = rect.width - inset.left - inset.right
    const paintHeight = rect.height - inset.top - inset.bottom
    // The playground's contract asset is square (600×600). CSS cover scales by the larger
    // dimension ratio; these dimensions prove there can be no aspect-ratio letterbox.
    const scale = Math.max(paintWidth / 600, paintHeight / 600)
    const coveredWidth = 600 * scale
    const coveredHeight = 600 * scale
    const position = before.backgroundPosition.split(',').at(-1)?.trim() ?? ''
    const artBox = {
      bottom: rect.bottom - inset.bottom,
      left: rect.left + inset.left,
      right: rect.right - inset.right,
      top: rect.top + inset.top
    }
    const cardBox = {
      bottom: rect.bottom,
      left: rect.left,
      // Only a visible split panel owns half of the inter-card gap. A mounted-but-hidden panel
      // must not leave its split inset on the full-width chat card.
      right:
        rect.right -
        (workspaceVisible ? Number.parseFloat(getComputedStyle(chat).getPropertyValue('--atum-panel-gap')) / 2 : 0),
      top: rect.top + Number.parseFloat(getComputedStyle(chat).getPropertyValue('--atum-l-header'))
    }

    return {
      artBox,
      backgroundImage: before.backgroundImage,
      backgroundPosition: before.backgroundPosition,
      backgroundSize: before.backgroundSize,
      cardBox,
      centered: position === '50% 50%' || position === 'center center' || position === 'center',
      coveredHeight,
      coveredWidth,
      identityColors: chat.hasAttribute('data-atum-look-colors'),
      layerImage: style.getPropertyValue('--look-l1-image').trim(),
      layerPosition: style.getPropertyValue('--look-l1-position').trim(),
      layerSize: style.getPropertyValue('--look-l1-size').trim(),
      look: chat.getAttribute('data-atum-look'),
      lookTokens: chat.hasAttribute('data-atum-look-tokens'),
      lookTone: chat.getAttribute('data-atum-look-tone'),
      paintHeight,
      paintWidth
    }
  })
}

try {
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ colorScheme, viewport: { width: widths[0], height: 900 } })

    for (const width of widths) {
      const page = await context.newPage()
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`${base}/matrix-playground.html?scenario=chat-moon-app&lang=en&evidence=1`)
      await page.waitForSelector('[data-atum-chat][data-atum-look="pack"]')

      assertCover(await lookState(page), `${colorScheme} ${width}px full chat`)

      await page.getByRole('button', { name: 'Show side panel' }).click()
      await page.waitForSelector('[data-atum-workspace]:not([hidden])')
      assertCover(await lookState(page), `${colorScheme} ${width}px split side panel`)

      await page.locator('[data-atum-workspace-expand]').click()
      await page.waitForSelector('[data-atum-workspace][data-atum-full-frame="true"]')
      assertCover(await lookState(page), `${colorScheme} ${width}px full-frame side panel`)

      await page.locator('[data-atum-workspace-expand]').click()
      await page.waitForSelector('[data-atum-workspace][data-atum-full-frame="false"]')
      await page.getByRole('button', { name: 'Close workspace', exact: true }).click()
      await page.waitForSelector('[data-atum-workspace][hidden]', { state: 'attached' })
      assertCover(await lookState(page), `${colorScheme} ${width}px full chat after closing side panel`)

      await page.close()
    }

    await context.close()
  }
} finally {
  await browser.close()
}

console.log('look-pack Chromium proof passed')
