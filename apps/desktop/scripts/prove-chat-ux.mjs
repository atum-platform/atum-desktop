// Real-browser proof against the actual Matrix renderer on synthetic data.
// Start the leased playground server, then:
// node scripts/prove-chat-ux.mjs http://127.0.0.1:5189
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5189')
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Use the local fixture server, never a real account')
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === 'darwin' ? { channel: 'chrome' } : {})
})

try {
  for (const width of [1280, 760]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))

    // Wrap only the playground bridge before React subscribes. Synthetic
    // snapshots use the same subscription path as native stream updates.
    // No product source, private conversations, or native service is touched.
    await page.addInitScript(() => {
      let bridge
      let current
      const listeners = new Set()
      window.__chatUX = {
        emit(snapshot) {
          current = snapshot
          listeners.forEach(listener => listener(snapshot))
        }
      }
      Object.defineProperty(window, 'atumMatrix', {
        configurable: true,
        get: () => bridge,
        set(value) {
          bridge = value
          const subscribe = value.subscribe.bind(value)
          const snapshot = value.snapshot.bind(value)
          value.snapshot = async () => current ?? snapshot()
          value.subscribe = listener => {
            listeners.add(listener)
            const stop = subscribe(listener)
            return () => {
              listeners.delete(listener)
              stop()
            }
          }
        }
      })
    })

    await page.goto(new URL('/matrix-playground.html?scenario=chat-live&lang=en', base).href)
    const viewport = page.locator('[data-slot="aui_thread-viewport"]')
    await page.locator('[data-matrix-hermes-activity]').waitFor()
    const metrics = () =>
      viewport.evaluate(node => ({
        height: node.clientHeight,
        top: node.scrollTop,
        distance: node.scrollHeight - node.clientHeight - node.scrollTop,
        following: node.dataset.following,
        liveInside: node.contains(document.querySelector('[data-matrix-hermes-activity]'))
      }))
    const publish = changes =>
      page.evaluate(async changes => {
        const snapshot = await window.atumMatrix.snapshot()
        window.__chatUX.emit({ ...snapshot, ...changes })
      }, changes)
    const grow = () =>
      page.evaluate(async () => {
        const snapshot = await window.atumMatrix.snapshot()
        const text = Array.from(
          { length: 40 },
          (_, i) => `Stream paragraph ${i + 1}. ` + 'Synthetic answer content for checking scrolling. '.repeat(5)
        ).join('\n\n')
        window.__chatUX.emit({
          ...snapshot,
          hermesActivity: {
            ...snapshot.hermesActivity,
            text: snapshot.hermesActivity.text + '\n\n' + text
          }
        })
      })
    const atBottom = () =>
      page.waitForFunction(() => {
        const node = document.querySelector('[data-slot="aui_thread-viewport"]')
        return node.dataset.following === 'true' && node.scrollHeight - node.clientHeight - node.scrollTop < 8
      })

    await atBottom()
    const initial = await metrics()
    assert.ok(initial.height > 300)
    assert.equal(initial.liveInside, true)
    await page.evaluate(async () => {
      const snapshot = await window.atumMatrix.snapshot()
      const [human, assistant] = snapshot.messages
      window.__chatUX.emit({
        ...snapshot,
        messages: Array.from({ length: 80 }, (_, i) => ({
          ...(i % 2 === 0 ? human : assistant),
          id: `$history-${i}`,
          replyTo: undefined,
          body:
            i % 2 === 0
              ? `Synthetic question ${i}.`
              : `Synthetic answer ${i}.\n\n**Context**\n\nA retained paragraph with enough text to exercise a long transcript.`,
          timestamp: Date.now() - (80 - i) * 60_000
        }))
      })
    })
    await page.waitForFunction(() => document.querySelectorAll('[data-slot="aui_user-message-root"]').length === 40)
    await atBottom()
    await grow()
    await atBottom()
    assert.equal((await metrics()).height, initial.height)

    // Keyboard scroll follows the focused transcript control, not the composer.
    await page
      .locator('[data-slot="aui_thinking-disclosure"] button')
      .evaluate(node => node.focus({ preventScroll: true }))
    await page.keyboard.press('PageUp')
    await page.waitForFunction(
      () => document.querySelector('[data-slot="aui_thread-viewport"]').dataset.following === 'false'
    )
    await page.locator('.thread-jump-button[aria-hidden="false"]').click()
    await atBottom()

    const rect = await viewport.boundingBox()
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
    await page.mouse.wheel(0, -800)
    await page.waitForFunction(
      () => document.querySelector('[data-slot="aui_thread-viewport"]').dataset.following === 'false'
    )
    // Wait for the wheel gesture's final scroll, not an intermediate frame.
    await page.waitForTimeout(200)
    const reading = await metrics()
    assert.ok(reading.distance > 100)
    await grow()
    await page.waitForTimeout(300)
    assert.ok(Math.abs((await metrics()).top - reading.top) < 3, 'Streaming must not pull the reader down')
    await page.locator('.thread-jump-button[aria-hidden="false"]').click()
    await atBottom()
    await grow()
    await atBottom()
    assert.equal((await metrics()).height, initial.height)

    // Thinking-only first turn before any history has reached the renderer.
    await page.evaluate(async () => {
      const snapshot = await window.atumMatrix.snapshot()
      window.__chatUX.emit({
        ...snapshot,
        messages: [],
        localTurns: [],
        hermesActivity: {
          ...snapshot.hermesActivity,
          invocationId: 'thinking-first',
          text: '',
          tools: [],
          reasoning: Array.from({ length: 50 }, (_, i) => `Synthetic thought ${i + 1}.`).join('\n\n')
        }
      })
    })
    const thinking = page.locator('[data-slot="aui_thinking-disclosure"]')
    const toggle = thinking.getByRole('button')
    await page.locator('[data-slot="aui_reasoning-text"]').waitFor()
    assert.ok(await thinking.locator('.thinking-preview').evaluate(node => node.clientHeight <= 160))
    assert.equal((await metrics()).liveInside, true)
    assert.equal((await metrics()).height, initial.height)
    await toggle.click() // explicitly closed
    await page.evaluate(async () => {
      const snapshot = await window.atumMatrix.snapshot()
      window.__chatUX.emit({
        ...snapshot,
        hermesActivity: { ...snapshot.hermesActivity, reasoning: 'Still this turn' }
      })
    })
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
    await page.evaluate(async () => {
      const snapshot = await window.atumMatrix.snapshot()
      window.__chatUX.emit({
        ...snapshot,
        hermesActivity: { ...snapshot.hermesActivity, invocationId: 'thinking-next' }
      })
    })
    await page.waitForFunction(
      () =>
        document.querySelector('[data-slot="aui_thinking-disclosure"] button').getAttribute('aria-expanded') === 'true'
    )
    await page.evaluate(async () => {
      const snapshot = await window.atumMatrix.snapshot()
      window.__chatUX.emit({ ...snapshot, hermesActivity: { ...snapshot.hermesActivity, text: 'The answer starts' } })
    })
    await page.waitForFunction(
      () =>
        document.querySelector('[data-slot="aui_thinking-disclosure"] button').getAttribute('aria-expanded') === 'false'
    )
    await toggle.click() // explicitly expanded after answering
    await page.evaluate(async () => {
      const snapshot = await window.atumMatrix.snapshot()
      window.__chatUX.emit({
        ...snapshot,
        hermesActivity: { ...snapshot.hermesActivity, text: 'The answer continues' }
      })
    })
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true')

    // A completed reply hands over without duplicate live output; stopping
    // leaves the normal empty greeting, not an invisible live placeholder.
    await page.evaluate(async () => {
      const snapshot = await window.atumMatrix.snapshot()
      window.__chatUX.emit({ ...snapshot, hermesActivity: { ...snapshot.hermesActivity, state: 'complete' } })
    })
    assert.equal(await page.locator('[data-matrix-hermes-activity]').count(), 1)
    await page.evaluate(async () => {
      const snapshot = await window.atumMatrix.snapshot()
      window.__chatUX.emit({
        ...snapshot,
        messages: [
          {
            id: '$synthetic-result',
            sender: snapshot.assistant.userId,
            body: 'The answer continues',
            timestamp: Date.now(),
            own: false,
            encrypted: true,
            decryptionFailed: false,
            pending: false,
            failed: false,
            attachment: false,
            turn: snapshot.hermesActivity.turnId
          }
        ]
      })
    })
    await page.locator('[data-matrix-hermes-activity]').waitFor({ state: 'detached' })
    await publish({
      messages: [],
      localTurns: [],
      hermesActivity: { invocationId: 'stopped', state: 'stopped', text: '', tools: [] }
    })
    await page.waitForFunction(() => !document.querySelector('[data-matrix-hermes-activity]'))
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        width,
        viewportHeight: initial.height,
        follow: true,
        wheelEscape: true,
        readingDuringStream: true,
        jumpResumesFollow: true,
        thinkingFirstTurn: true,
        thinkingChoiceReset: true,
        finalHandoff: true,
        errors
      })
    )
    await page.close()
  }
} finally {
  await browser.close()
}
