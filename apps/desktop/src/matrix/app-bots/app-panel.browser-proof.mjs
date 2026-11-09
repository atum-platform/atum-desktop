/* global document, window */
// Real-Chromium screenshots and checks for the app side panel (restored home, 2026-11-07:
// identity, then the pages as one column of Kit capsules centred on the panel; a page opens under
// Atum's bar) and its look pack.
//
//   npm exec vite -- --host 127.0.0.1 --port 5199          (from apps/desktop)
//   node src/matrix/app-bots/app-panel.browser-proof.mjs http://127.0.0.1:5199 <out-dir> [label] [--check]
//
// Cases: Moon with its declared light panel ground (orbit lattice in navy on paper) in light and
// dark; Moon on the v1.1 navy ground production still publishes, in light and dark; a Moon page
// open below a root (Back walks its history), and one that failed; an app this client has never
// heard of with no look pack, in light and dark, and its page offline; an app with one page; an
// app that is not connected. Chromium cannot mount the Electron guest, so the proof drives the
// view bridge's state events the way main does and the content area shows the host's own surface.
// Look-pack art is served from the playground's files in place of the `atum-look:` scheme. Pass
// --check to assert the look, the centred vertical column, titles, Back and states.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { chromium } from 'playwright-core'

const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const check = process.argv.includes('--check')
const base = args[0] ?? 'http://127.0.0.1:5199'
const out = path.resolve(args[1] ?? 'app-panel-shots')
const label = args[2] ?? 'after'
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const desktop = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

// Digest -> playground file (mirrors PLAYGROUND_LOOK_ASSET_FILES in playground/app-look-fixtures.ts).
const MOON_CHAT_ART = '7b6e946ecb9cbbe0dd1fe6ea799150b2394694f608f5350223265509d34c62dc'

const assets = {
  [MOON_CHAT_ART]: 'shared/__fixtures__/look-pack-v1/assets/moon-gravity-well-atum.svg',
  b5a5d14ac4583d4f29237d5db6a780c3d46ab6491c1deecfc39a461bca7f0be7: 'src/matrix/playground/assets/andy-grid.svg',
  '6f2c6c150730f2d87dcf760b29f6ea94dbadf410a9b53987b63207946ccf05d2':
    'src/matrix/playground/assets/moon-orbit-lattice-paper.svg'
}

const moon = { scenario: 'chat-moon-app', pages: 5, look: 'pack' }
const orbit = { scenario: 'chat-orbit-app', pages: 3, look: null }

const cases = [
  ...['light', 'dark'].map(appearance => ({ ...moon, name: `moon-${appearance}`, appearance, tone: 'light' })),
  // Production's v1.1 Moon pack: navy under its web-sidebar art (the chat art stands in here).
  ...['light', 'dark'].map(appearance => ({
    ...moon,
    name: `moon-published-navy-${appearance}`,
    appearance,
    tone: 'dark',
    navy: true
  })),
  {
    ...moon,
    name: 'moon-light-subpage-back',
    appearance: 'light',
    tone: 'light',
    open: 'Library',
    emit: { status: 'ready', canGoBack: true, matchedRouteId: 'library', atRouteRoot: false },
    expect: { title: 'Library' }
  },
  {
    ...moon,
    name: 'moon-dark-error',
    appearance: 'dark',
    tone: 'light',
    open: 'Readings',
    emit: { status: 'error', error: 'load_failed' },
    expect: { title: 'Readings', text: 'Couldn’t open this page.', buttons: ['Try again'] }
  },
  ...['light', 'dark'].map(appearance => ({ ...orbit, name: `unknown-${appearance}`, appearance })),
  {
    ...orbit,
    name: 'unknown-light-offline',
    appearance: 'light',
    open: 'Home',
    offline: true,
    expect: { title: 'Home', text: 'You’re offline. This page will reopen when you’re online.', buttons: [] }
  },
  // Andy's pack declares a chat look but no panel ground: the panel stays Kit.
  { scenario: 'chat-andy-app', name: 'single-page-light', appearance: 'light', pages: 1, look: null, onlyRoutes: ['chat', 'tasks'] },
  { scenario: 'chat-demoza-app', name: 'not-connected-dark', appearance: 'dark', pages: 0, look: null, connect: true }
]

mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: chrome, headless: true })

async function serveArt(page) {
  const served = Object.fromEntries(
    Object.entries(assets).map(([sha, file]) => [sha, `${base}/@fs${path.join(desktop, file)}`])
  )

  await page.evaluate(map => {
    for (const element of document.querySelectorAll('[style*="atum-look://"]')) {
      element.setAttribute(
        'style',
        element.getAttribute('style').replace(/atum-look:\/\/([0-9a-f]{64})/gu, (match, sha) => map[sha] ?? match)
      )
    }
  }, served)
  // Let the art decode before the photograph.
  await page.waitForTimeout(400)
}

try {
  for (const each of cases) {
    const context = await browser.newContext({
      colorScheme: each.appearance,
      deviceScaleFactor: 2,
      viewport: { width: 1440, height: 900 }
    })

    const page = await context.newPage()
    await page.goto(`${base}/matrix-playground.html?scenario=${each.scenario}&lang=en`)
    await page.locator('[data-atum-chat]').first().waitFor()

    // Stand in for main: capture the view's state listener and, for a case, trim the menu or
    // swap Moon's panel ground for the one production publishes today.
    await page.evaluate(
      async ({ navy, only, chatArt }) => {
        const apps = window.atumMatrix.apps
        const listeners = []
        const menu = apps.menu.bind(apps)

        apps.view.onState = fn => {
          listeners.push(fn)

          return () => listeners.splice(listeners.indexOf(fn), 1)
        }

        apps.menu = async id => {
          const value = await menu(id)

          return only ? { ...value, routes: value.routes.filter(route => only.includes(route.id)) } : value
        }

        if (navy) {
          const snapshot = await window.atumMatrix.snapshot()
          const app = snapshot.apps.apps.find(app => app.look?.chat?.background?.light.layers[0]?.asset.sha256 === chatArt)
          const ground = app.look.chat.background.light

          app.look = {
            ...app.look,
            panel: {
              background: { light: { ...ground, layers: [{ ...ground.layers[0], opacity: 0.3 }] }, dark: null },
              derived: { light: app.look.derived.light }
            }
          }
        }

        window.__appPanelEmit = state => listeners.forEach(fn => fn({ viewId: 'playground-app', ...state }))
        // The playground's own scenario bar floats over the window; it is not part of this proof.
        document.querySelector('[data-matrix-playground]')?.remove()
      },
      { navy: Boolean(each.navy), only: each.onlyRoutes ?? null, chatArt: MOON_CHAT_ART }
    )

    await page.locator('[data-matrix-app-functions]').click()
    const panel = page.locator('[data-app-bot-panel]')
    await panel.locator('[data-app-panel-pages]').waitFor()
    await panel.evaluate(node => {
      Object.assign(node.style, { position: 'fixed', inset: '24px auto auto 24px', width: '460px', height: '760px', zIndex: '100' })
    })

    if (each.pages) {
      await panel.locator('[data-app-bot-functions] button').first().waitFor()
    }

    if (check && !each.open) {
      const home = await panel.evaluate(node => {
        const box = node.getBoundingClientRect()

        const buttons = [...node.querySelectorAll('[data-app-bot-functions] button')].map(button =>
          button.getBoundingClientRect()
        )

        return {
          look: node.getAttribute('data-atum-look'),
          tone: node.getAttribute('data-atum-look-tone'),
          base: window.getComputedStyle(node).getPropertyValue('--look-base').trim(),
          buttons: buttons.map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })),
          capsules: [...node.querySelectorAll('[data-app-bot-functions] button')].every(button =>
            button.classList.contains('ak-btn')
          ),
          center: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
          connect: Boolean(node.querySelector('[data-app-panel-connect]')),
          navigation: node.querySelectorAll('nav').length,
          slugInMarkup: node.outerHTML.includes(`data-app-${node.getAttribute('data-app-bot-panel')}`)
        }
      })

      assert.equal(home.look, each.look, `${each.name}: look`)
      assert.equal(home.tone, each.tone ?? null, `${each.name}: tone`)
      assert.equal(home.buttons.length, each.pages, `${each.name}: pages`)
      assert.equal(home.capsules, true, `${each.name}: Kit capsules`)
      assert.equal(home.navigation, 0, `${each.name}: no persistent navigation`)
      assert.equal(home.connect, Boolean(each.connect), `${each.name}: Connect`)
      assert.equal(home.slugInMarkup, false, `${each.name}: no app-specific hooks`)

      if (each.navy) {
        assert.equal(home.base, '#0E1D60', `${each.name}: published navy ground`)
      } else if (each.look) {
        assert.equal(home.base, '#F7F6F2', `${each.name}: declared paper ground in either appearance`)
      }

      if (home.buttons.length) {
        const first = home.buttons[0]
        const last = home.buttons.at(-1)

        for (const [index, rect] of home.buttons.entries()) {
          assert.equal(Math.round(rect.x), Math.round(first.x), `${each.name}: one column`)
          assert.equal(Math.round(rect.width), Math.round(first.width), `${each.name}: one width`)

          if (index) {
            assert.ok(rect.y > home.buttons[index - 1].y, `${each.name}: stacked top to bottom`)
          }
        }

        assert.ok(Math.abs(first.x + first.width / 2 - home.center.x) <= 1, `${each.name}: centred across`)
        // The column centres on the panel; the identity above it may pull it a little low.
        assert.ok(Math.abs((first.y + last.y + last.height) / 2 - home.center.y) <= 24, `${each.name}: centred down`)
      }
    }

    if (each.open) {
      await panel.getByRole('button', { name: each.open }).click()
      await page.waitForFunction(() => document.querySelector('[data-atum-app-view]'))
    }

    if (each.emit) {
      await page.evaluate(state => window.__appPanelEmit(state), each.emit)
    }

    if (each.offline) {
      await page.evaluate(() => window.dispatchEvent(new Event('offline')))
    }

    if (check && each.expect) {
      const state = await panel.evaluate(node => ({
        title: node.querySelector('[data-app-panel-page]')?.textContent ?? null,
        back: Boolean(node.querySelector('[data-app-panel-bar] button[aria-label="Back"]')),
        stateText: node.querySelector('[data-app-panel-state] p')?.textContent ?? null,
        stateButtons: [...node.querySelectorAll('[data-app-panel-state] button')].map(button => button.textContent)
      }))

      assert.equal(state.title, each.expect.title, `${each.name}: page title`)
      assert.equal(state.back, true, `${each.name}: Back on every page`)

      if (each.expect.text) {
        assert.equal(state.stateText, each.expect.text, `${each.name}: state line`)
        assert.deepEqual(state.stateButtons, each.expect.buttons, `${each.name}: at most one action`)
      }
    }

    await serveArt(page)
    // Photograph the panel alone; neighbouring window chrome is not part of this proof.
    await page.addStyleTag({
      content: 'body * { visibility: hidden !important; } .app-panel, .app-panel * { visibility: visible !important; }'
    })
    const file = path.join(out, `${label}-${each.name}.png`)
    await panel.screenshot({ path: file })
    console.log(file)
    await context.close()
  }
} finally {
  await browser.close()
}
