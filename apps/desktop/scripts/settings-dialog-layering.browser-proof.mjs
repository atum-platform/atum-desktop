/* global document, getComputedStyle, requestAnimationFrame, window */

import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP = path.resolve(HERE, '..')
const FALLBACK_CHROMIUM = path.resolve(
  DESKTOP,
  '../../../release-0.20.19/apps/desktop/release-matrix/mac-arm64/Atum Matrix Candidate.app/Contents/Resources/runtime/browser/chromium/chrome-headless-shell-mac-arm64/chrome-headless-shell'
)

const args = new Map(
  process.argv.slice(2).map(argument => {
    const [name, ...value] = argument.replace(/^--/u, '').split('=')

    return [name, value.join('=')]
  })
)
const expectation = args.get('expect') ?? 'pass'
const output = path.resolve(args.get('output') ?? path.join(DESKTOP, 'test-results', 'settings-dialog-layering'))
const prefix = args.get('prefix') ?? expectation
const stylesheet = await readFile(args.get('stylesheet') ? path.resolve(args.get('stylesheet')) : path.join(DESKTOP, 'src', 'styles.css'), 'utf8')

assert.ok(['blocked', 'pass'].includes(expectation), '--expect must be blocked or pass')
await mkdir(output, { recursive: true })

async function browserExecutable() {
  const candidates = [process.env.CHROME, chromium.executablePath(), FALLBACK_CHROMIUM].filter(Boolean)

  for (const candidate of candidates) {
    try {
      await access(candidate)

      return candidate
    } catch {
      // Try the packaged runtime supplied for offline browser proofs.
    }
  }

  throw new Error(`No Chromium executable found. Checked: ${candidates.join(', ')}`)
}

const executablePath = await browserExecutable()
const browser = await chromium.launch({ executablePath, headless: true })
const scenarios = []

const fixture = `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8">
    <style>
      :root {
        --atum-ink: #202124;
        --atum-ink-muted: #62666d;
        --atum-line: rgb(32 33 36 / 16%);
        --atum-roster-bg: #f2f3f5;
        --atum-main-bg: #ffffff;
      }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      html, body { width: 100%; height: 100%; margin: 0; }
      body {
        overflow: hidden;
        background: #dfe2e7;
        color: var(--atum-ink);
        font: 14px/1.4 -apple-system, BlinkMacSystemFont, sans-serif;
      }
      body.dark {
        --atum-ink: #f3f3f4;
        --atum-ink-muted: #a8abb0;
        --atum-line: rgb(255 255 255 / 16%);
        --atum-roster-bg: #292a2d;
        --atum-main-bg: #18191b;
        background: #101113;
      }
      button { font: inherit; }
      .fixture-app {
        display: grid;
        min-height: 100%;
        place-items: center;
        color: var(--atum-ink-muted);
      }
      .atum-settings-layer { position: fixed; inset: 0; }
      .atum-settings-scrim { position: absolute; inset: 0; }
      .atum-settings {
        position: relative;
        width: min(760px, calc(100vw - 48px));
        height: min(600px, calc(100vh - 48px));
        margin: auto;
        padding: 32px;
        border: 1px solid var(--atum-line);
        border-radius: 20px;
        background: var(--atum-roster-bg);
        box-shadow: 0 24px 80px rgb(0 0 0 / 28%);
      }
      .fixture-settings-page {
        display: grid;
        height: 100%;
        align-content: start;
        gap: 16px;
      }
      .fixture-parent-actions { display: flex; gap: 8px; }
      .fixture-button {
        min-height: 32px;
        padding: 6px 14px;
        border: 1px solid var(--atum-line);
        border-radius: 999px;
        background: var(--atum-main-bg);
        color: var(--atum-ink);
      }
      .fixture-dialog-overlay {
        position: fixed;
        inset: 0;
        z-index: 120;
        pointer-events: auto;
        background: rgb(0 0 0 / 22%);
      }
      .fixture-dialog-content {
        position: fixed;
        left: 50%;
        top: 50%;
        z-index: 130;
        display: grid;
        width: min(360px, calc(100vw - 40px));
        gap: 14px;
        padding: 22px;
        transform: translate(-50%, -50%);
        border: 1px solid var(--atum-line);
        border-radius: 20px;
        background: var(--atum-main-bg);
        box-shadow: 0 24px 80px rgb(0 0 0 / 32%);
      }
      .fixture-dialog-content h2, .fixture-dialog-content p { margin: 0; }
      .fixture-code {
        padding: 12px;
        border: 1px solid var(--atum-line);
        border-radius: 8px;
        text-align: center;
        font: 600 22px/1.2 ui-monospace, monospace;
        letter-spacing: .2em;
      }
      .fixture-child-actions { display: flex; gap: 8px; }
      [data-radix-popper-content-wrapper] {
        position: fixed;
        left: calc(50% + 54px);
        top: calc(50% - 158px);
      }
      .fixture-popup {
        width: 180px;
        padding: 8px;
        border: 1px solid var(--atum-line);
        border-radius: 10px;
        background: var(--atum-main-bg);
        box-shadow: 0 12px 36px rgb(0 0 0 / 24%);
      }
      .fixture-popup button { width: 100%; }
      body[data-compact='true'] .atum-settings-layer { padding: 10px; }
      body[data-compact='true'] .atum-settings { width: 100%; height: 100%; }
    </style>
  </head>
  <body>
    <main class="fixture-app atum-shell">Installed Atum window</main>
    <div class="atum-settings-layer" data-matrix-settings>
      <div class="atum-settings-scrim"></div>
      <section class="atum-settings" data-slot="dialog-content" role="dialog" aria-label="Account Settings">
        <div class="fixture-settings-page">
          <h1>Account Settings</h1>
          <p>The parent sheet must remain open while its subscription flow is active.</p>
          <div class="fixture-parent-actions">
            <button class="fixture-button" data-parent-open type="button">Open ChatGPT</button>
            <button class="fixture-button" data-parent-close type="button">Close settings</button>
          </div>
        </div>
      </section>
    </div>
    <div class="fixture-dialog-overlay" data-slot="dialog-overlay"></div>
    <section class="fixture-dialog-content" data-slot="dialog-content" role="dialog" aria-label="ChatGPT">
      <h2>ChatGPT</h2>
      <p>Mã của bạn</p>
      <p class="fixture-code" data-test-code>TEST-CODE</p>
      <button class="fixture-button" data-test-open-page type="button">Open sign-in page</button>
      <p>Waiting for you to finish in your browser…</p>
      <div class="fixture-child-actions">
        <button class="fixture-button" data-child-cancel type="button">Cancel</button>
      </div>
    </section>
    <div data-radix-popper-content-wrapper>
      <div class="fixture-popup" data-slot="dropdown-menu-content">
        <button class="fixture-button" data-popup-action type="button">Copy TEST-CODE</button>
      </div>
    </div>
    <script>
      const state = { childOpen: true, openClicks: 0, parentOpen: true, popupClicks: 0, popupOpen: true }
      const settings = document.querySelector('[data-matrix-settings]')
      const child = document.querySelector('.fixture-dialog-content')
      const overlay = document.querySelector('.fixture-dialog-overlay')
      const popup = document.querySelector('[data-radix-popper-content-wrapper]')
      const paint = () => {
        settings.hidden = !state.parentOpen
        child.hidden = !state.childOpen
        overlay.hidden = !state.childOpen
        popup.hidden = !state.childOpen || !state.popupOpen
      }
      document.querySelector('[data-test-open-page]').addEventListener('click', () => { state.openClicks += 1 })
      document.querySelector('[data-popup-action]').addEventListener('click', () => {
        state.popupClicks += 1
        state.popupOpen = false
        paint()
      })
      document.querySelector('[data-child-cancel]').addEventListener('click', () => {
        state.childOpen = false
        state.popupOpen = false
        paint()
      })
      document.querySelector('[data-parent-open]').addEventListener('click', () => {
        state.childOpen = true
        state.popupOpen = true
        paint()
        child.focus()
      })
      document.querySelector('[data-parent-close]').addEventListener('click', () => {
        state.parentOpen = false
        paint()
      })
      document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return
        if (state.popupOpen) {
          event.preventDefault()
          state.popupOpen = false
        } else if (state.childOpen) {
          event.preventDefault()
          state.childOpen = false
        } else if (state.parentOpen) {
          event.preventDefault()
          state.parentOpen = false
        }
        paint()
      })
      window.fixtureState = state
      paint()
    </script>
  </body>
</html>`

function numericZ(value) {
  const parsed = Number.parseInt(value, 10)

  return Number.isFinite(parsed) ? parsed : 0
}

try {
  for (const theme of ['light', 'dark']) {
    for (const viewport of [
      { height: 720, name: 'wide', width: 980 },
      { height: 640, name: 'compact', width: 520 }
    ]) {
      const context = await browser.newContext({
        colorScheme: theme,
        reducedMotion: 'reduce',
        viewport: { height: viewport.height, width: viewport.width }
      })
      await context.route('**/*', route => route.abort())
      const page = await context.newPage()
      await page.setContent(fixture)
      await page.addStyleTag({ content: stylesheet })
      await page.evaluate(
        ({ compact, theme }) => {
          document.documentElement.classList.toggle('dark', theme === 'dark')
          document.body.classList.toggle('dark', theme === 'dark')
          document.body.dataset.compact = String(compact)
        },
        { compact: viewport.name === 'compact', theme }
      )
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

      // Screenshot stabilization finishes finite production transitions before
      // geometry is measured, so the report describes the rendered frame.
      const image = path.join(output, `${prefix}-${theme}-${viewport.name}.png`)
      await page.screenshot({ animations: 'disabled', caret: 'hide', path: image })

      const initial = await page.evaluate(() => {
        const settings = document.querySelector('[data-matrix-settings]')
        const parent = settings.querySelector('[data-slot="dialog-content"]')
        const overlay = document.body.querySelector(':scope > [data-slot="dialog-overlay"]')
        const child = document.body.querySelector(':scope > [data-slot="dialog-content"]')
        const popup = document.querySelector('[data-radix-popper-content-wrapper]')
        const code = document.querySelector('[data-test-code]')
        const codeRect = code.getBoundingClientRect()
        const hit = document.elementFromPoint(codeRect.left + codeRect.width / 2, codeRect.top + codeRect.height / 2)

        return {
          childHit: child.contains(hit),
          codeHit: hit?.getAttribute('data-test-code') === '' || code.contains(hit),
          childMatchesLayerRule: child.matches(
            "body:has([data-matrix-settings]:not([hidden])) [data-slot='dialog-content']:not(.atum-settings)"
          ),
          hit: {
            className: typeof hit?.className === 'string' ? hit.className : '',
            slot: hit?.getAttribute('data-slot'),
            tag: hit?.tagName,
            text: hit?.textContent?.trim().slice(0, 80)
          },
          codeText: code.textContent,
          codeVisibility: getComputedStyle(code).visibility,
          layers: {
            child: getComputedStyle(child).zIndex,
            overlay: getComputedStyle(overlay).zIndex,
            parent: getComputedStyle(settings).zIndex,
            parentContent: getComputedStyle(parent).zIndex,
            popup: getComputedStyle(popup).zIndex
          },
          parsedLayerRules: Array.from(document.styleSheets)
            .flatMap(sheet => Array.from(sheet.cssRules))
            .filter(rule => rule.cssText.includes('data-matrix-settings') && rule.cssText.includes('z-index'))
            .map(rule => rule.cssText),
          matchingChildZRules: Array.from(document.styleSheets)
            .flatMap(sheet => Array.from(sheet.cssRules))
            .filter(
              rule =>
                'selectorText' in rule &&
                rule.selectorText &&
                child.matches(rule.selectorText) &&
                rule.style?.getPropertyValue('z-index')
            )
            .map(rule => rule.cssText)
        }
      })

      const buttonBox = await page.locator('[data-test-open-page]').boundingBox()
      assert.ok(buttonBox, 'the synthetic Open page action must have geometry')
      await page.mouse.click(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2)
      const openClicks = await page.evaluate(() => window.fixtureState.openClicks)

      const row = {
        image,
        initial,
        openClicks,
        theme,
        viewport: viewport.name
      }

      if (expectation === 'blocked') {
        assert.equal(initial.childHit, false, `${theme}/${viewport.name}: legacy code must be covered by Settings`)
        assert.equal(openClicks, 0, `${theme}/${viewport.name}: legacy child action must be blocked`)
      } else {
        const layers = Object.fromEntries(Object.entries(initial.layers).map(([key, value]) => [key, numericZ(value)]))
        assert.equal(initial.codeText, 'TEST-CODE')
        assert.equal(initial.codeVisibility, 'visible')
        assert.equal(
          initial.childHit,
          true,
          `${theme}/${viewport.name}: the child dialog must win code hit testing (${JSON.stringify(initial)})`
        )
        assert.ok(
          layers.parent < layers.overlay,
          `${theme}/${viewport.name}: parent ${layers.parent} < overlay ${layers.overlay}`
        )
        assert.ok(
          layers.overlay < layers.child,
          `${theme}/${viewport.name}: overlay ${layers.overlay} < child ${layers.child}`
        )
        assert.ok(
          layers.child < layers.popup,
          `${theme}/${viewport.name}: child ${layers.child} < popup ${layers.popup}`
        )
        assert.equal(openClicks, 1, `${theme}/${viewport.name}: child action must receive the pointer`)

        await page.locator('[data-popup-action]').click()
        assert.deepEqual(
          await page.evaluate(() => ({
            childOpen: window.fixtureState.childOpen,
            parentOpen: window.fixtureState.parentOpen,
            popupClicks: window.fixtureState.popupClicks
          })),
          { childOpen: true, parentOpen: true, popupClicks: 1 },
          `${theme}/${viewport.name}: popup action must leave both dialog layers open`
        )

        await page.locator('[data-child-cancel]').click()
        assert.deepEqual(
          await page.evaluate(() => ({
            childOpen: window.fixtureState.childOpen,
            parentOpen: window.fixtureState.parentOpen
          })),
          { childOpen: false, parentOpen: true },
          `${theme}/${viewport.name}: Cancel must close only the child`
        )

        await page.locator('[data-parent-open]').click()
        await page.keyboard.press('Escape')
        assert.deepEqual(
          await page.evaluate(() => ({
            childOpen: window.fixtureState.childOpen,
            parentOpen: window.fixtureState.parentOpen,
            popupOpen: window.fixtureState.popupOpen
          })),
          { childOpen: true, parentOpen: true, popupOpen: false },
          `${theme}/${viewport.name}: first Escape must close only the top popup`
        )
        await page.keyboard.press('Escape')
        assert.deepEqual(
          await page.evaluate(() => ({
            childOpen: window.fixtureState.childOpen,
            parentOpen: window.fixtureState.parentOpen
          })),
          { childOpen: false, parentOpen: true },
          `${theme}/${viewport.name}: second Escape must close only the child dialog`
        )
        await page.locator('[data-parent-close]').click()
        assert.equal(
          await page.evaluate(() => window.fixtureState.parentOpen),
          false,
          `${theme}/${viewport.name}: the parent remains independently dismissable`
        )

        const outsideSettings = await page.evaluate(
          () =>
            new Promise(resolve => {
              document.querySelector('.fixture-dialog-content').hidden = false
              document.querySelector('.fixture-dialog-overlay').hidden = false
              document.querySelector('[data-radix-popper-content-wrapper]').hidden = false
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  resolve({
                    child: getComputedStyle(document.querySelector('.fixture-dialog-content')).zIndex,
                    overlay: getComputedStyle(document.querySelector('.fixture-dialog-overlay')).zIndex,
                    popup: getComputedStyle(document.querySelector('[data-radix-popper-content-wrapper]')).zIndex
                  })
                })
              )
            })
        )
        const outsideLayers = Object.fromEntries(
          Object.entries(outsideSettings).map(([key, value]) => [key, numericZ(value)])
        )
        assert.ok(
          outsideLayers.overlay < layers.overlay &&
            outsideLayers.child < layers.child &&
            outsideLayers.popup < layers.popup,
          `${theme}/${viewport.name}: closing Settings must restore ordinary dialog layers`
        )
        row.outsideSettings = outsideSettings
      }

      scenarios.push(row)
      await context.close()
    }
  }
} finally {
  await browser.close()
}

const report = {
  chromium: executablePath,
  expectation,
  network: 'blocked',
  scenarios
}
await writeFile(path.join(output, `${prefix}-report.json`), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
