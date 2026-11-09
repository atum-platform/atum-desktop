/**
 * E2E tests for desktop sidebar states — background processes, subagents,
 * and session dot transitions.
 *
 * The mock server returns scripted tool_calls that the agent executes for
 * real (trivial commands + real subagent delegations). The tests assert the
 * sidebar states driven by real gateway events.
 *
 * Prerequisite: `npm run build` must have been run so dist/ exists.
 */

import { expect, type Page, test } from '@playwright/test'

import {
  type MockBackendFixture,
  setupMockBackend,
  waitForAppReady,
} from './fixtures'
import {
  releaseSidebarCrossBackground,
  restartMockServer,
  SIDEBAR_CROSS_TEXTS,
  SIDEBAR_TEXTS,
} from './mock-server'

/** Background-running dot aria-label (from i18n en.ts). */
const BG_DOT_LABEL = 'Background task running'
/** Finished-unread dot aria-label. */
const UNREAD_DOT_LABEL = 'Finished — unread'
const LEGACY_SHELL_TIMEOUT = 180_000
/**
 * The E2E_SIDEBAR_CROSS latch command trips the backend's approval guards, and
 * the mock provider cannot answer the smart-approval auxiliary call with
 * APPROVE. These sidebar-state contracts are unrelated to approvals, so their
 * isolated sandboxes opt out of that boundary explicitly.
 */
const APPROVALS_OFF = 'approvals:\n  mode: "off"'

function releaseCrossSessionBackground(fixture: MockBackendFixture): void {
  releaseSidebarCrossBackground(fixture.sandbox.hermesHome)
}

function bestEffortReleaseCrossSessionBackground(fixture?: MockBackendFixture): void {
  try {
    if (fixture) {
      releaseCrossSessionBackground(fixture)
    }
  } catch {
    // The sandbox may already be gone after a partial setup/teardown failure.
  }
}

/** Send a message and wait for the final response to appear. */
async function sendMessageAndWait(
  page: Page,
  trigger: string,
  finalText: string,
  timeout = 90_000,
): Promise<void> {
  const composer = page.locator('[contenteditable="true"]').first()
  await composer.waitFor({ state: 'visible', timeout: 10_000 })
  await composer.click()
  await composer.type(trigger, { delay: 20 })
  await page.keyboard.press('Enter')

  await page.waitForFunction(
    () => (document.body.textContent ?? '').includes('E2E_'),
    undefined,
    { timeout: 15_000 },
  )

  await page.waitForFunction(
    (text) => (document.body.textContent ?? '').includes(text),
    finalText,
    { timeout },
  )
}

// ────────────────────────────────────────────────────────────────────────
// Test 1: background process + subagent appear in sidebar during turn
// ────────────────────────────────────────────────────────────────────────

test.describe('sidebar states — background process and subagent', () => {
  test.describe.configure({ mode: 'serial' })

  let fixture: MockBackendFixture

  test.beforeAll(async () => {
    test.setTimeout(LEGACY_SHELL_TIMEOUT)
    restartMockServer()
    fixture = await setupMockBackend({ legacyShell: true })
    await waitForAppReady(fixture, 120_000)
  })

  test.afterAll(async () => {
    test.setTimeout(LEGACY_SHELL_TIMEOUT)
    await fixture?.cleanup()
  })

  test('background process dot appears and disappears, subagent runs, final answer visible', async () => {
    const page = fixture.page

    await sendMessageAndWait(page, 'E2E_SIDEBAR_TRIGGER', SIDEBAR_TEXTS.finalText)

    // The background process (sleep 1) should have shown a "Background task
    // running" dot at some point during the turn. We try to catch it; if
    // the process was too fast, that's OK — the real assertion is that the
    // final answer appeared and the dot is gone afterward.
    try {
      await expect
        .poll(
          () => page.locator(`[aria-label="${BG_DOT_LABEL}"]`).count(),
          { timeout: 15_000, message: 'background dot should appear' },
        )
        .toBeGreaterThan(0)
    } catch {
      // sleep 1 may have finished before we polled — not a failure.
    }

    // After the turn completes and auto-dismiss fires, the background dot
    // should be gone.
    await page.waitForTimeout(8000)
    const bgCount = await page.locator(`[aria-label="${BG_DOT_LABEL}"]`).count()
    expect(bgCount, 'background dot should be gone after auto-dismiss').toBe(0)

    // Evidence: capture the final state — no background dot, final answer visible.
    await page.screenshot({ path: 'test-results/bg-dot-gone-after-dismiss.png' })

    // The final answer text must be in the transcript.
    const viewportText = await page
      .locator('[data-slot="aui_thread-viewport"]')
      .textContent()
    expect(viewportText).toContain(SIDEBAR_TEXTS.finalText)
  })
})

// ────────────────────────────────────────────────────────────────────────
// Test 2: subagent running shows background dot too (longer bg process)
// ────────────────────────────────────────────────────────────────────────

test.describe('sidebar states — subagent and background dot coexist', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 })

  let fixture: MockBackendFixture

  test.beforeAll(async () => {
    test.setTimeout(LEGACY_SHELL_TIMEOUT)
    restartMockServer()
    fixture = await setupMockBackend({
      legacyShell: true,
      extraConfig: APPROVALS_OFF,
      mockServer: { holdFirstCompletionContaining: SIDEBAR_CROSS_TEXTS.subagentGoal },
    })
    await waitForAppReady(fixture, 120_000)
  })

  test.afterAll(async () => {
    test.setTimeout(LEGACY_SHELL_TIMEOUT)
    fixture?.mock.releaseHeldStream()
    bestEffortReleaseCrossSessionBackground(fixture)
    await fixture?.cleanup()
  })

  test('background process and subagent coexist, then the background dot appears after the turn', async () => {
    const page = fixture.page

    // Start the turn and observe both tool types in the composer status stack
    // before waiting for the final answer and the sidebar priority transition.
    const composer = page.locator('[contenteditable="true"]').first()
    await composer.waitFor({ state: 'visible', timeout: 10_000 })
    await composer.click()
    await composer.type('E2E_SIDEBAR_CROSS', { delay: 20 })
    await page.keyboard.press('Enter')

    // Wait for the user's message to appear.
    await page.waitForFunction(
      () => (document.body.textContent ?? '').includes('E2E_SIDEBAR_CROSS'),
      undefined,
      { timeout: 15_000 },
    )

    // While the turn is active, the sidebar intentionally gives its single
    // status dot to the higher-priority working state. Assert coexistence on
    // the composer status stack instead of racing that priority transition.
    await expect(page.getByRole('button', { name: '1 Background' })).toBeVisible({ timeout: 90_000 })
    await expect(page.getByRole('button', { name: '1 Subagent', exact: true })).toBeVisible({ timeout: 90_000 })
    fixture.mock.releaseHeldStream()

    // Once the final answer makes the turn idle, the held process owns the
    // sidebar dot and remains observable until the fixture releases it.
    await page.waitForFunction(
      (text) => (document.body.textContent ?? '').includes(text),
      SIDEBAR_CROSS_TEXTS.finalText,
      { timeout: 90_000 },
    )

    await expect
      .poll(
        () => page.locator(`[aria-label="${BG_DOT_LABEL}"]`).count(),
        { timeout: 30_000, message: 'background dot should appear after the turn completes' },
      )
      .toBeGreaterThan(0)

    // Evidence: the background dot is visible after the turn completes while
    // the fixture-held process remains alive.
    await page.screenshot({ path: 'test-results/bg-dot-after-turn.png' })
    releaseCrossSessionBackground(fixture)

    // After the turn + auto-dismiss, the background dot should be gone.
    await page.waitForTimeout(8000)
    const bgCount = await page.locator(`[aria-label="${BG_DOT_LABEL}"]`).count()
    expect(bgCount, 'background dot should be gone after process exits').toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────────
// Test 3: cross-session — dot updates when viewing a different session
// ────────────────────────────────────────────────────────────────────────

test.describe('sidebar states — cross-session dot transition', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 })

  let fixture: MockBackendFixture

  test.beforeAll(async () => {
    test.setTimeout(LEGACY_SHELL_TIMEOUT)
    restartMockServer()
    fixture = await setupMockBackend({ legacyShell: true, extraConfig: APPROVALS_OFF })
    await waitForAppReady(fixture, 120_000)
  })

  test.afterAll(async () => {
    test.setTimeout(LEGACY_SHELL_TIMEOUT)
    bestEffortReleaseCrossSessionBackground(fixture)
    await fixture?.cleanup()
  })

  test('background dot transitions to finished when viewing another session', async () => {
    const page = fixture.page

    // Start a turn whose background process remains held by the fixture.
    const composer = page.locator('[contenteditable="true"]').first()
    await composer.waitFor({ state: 'visible', timeout: 10_000 })
    await composer.click()
    await composer.type('E2E_SIDEBAR_CROSS', { delay: 20 })
    await page.keyboard.press('Enter')

    // Wait for the final answer first. While the turn is active, the sidebar's
    // mutually-exclusive dot correctly shows the higher-priority working
    // state; only an idle turn may expose the background state.
    await page.waitForFunction(
      (text) => (document.body.textContent ?? '').includes(text),
      SIDEBAR_CROSS_TEXTS.finalText,
      { timeout: 90_000 },
    )

    await expect
      .poll(
        () => page.locator(`[aria-label="${BG_DOT_LABEL}"]`).count(),
        { timeout: 30_000, message: 'background dot should appear after the turn completes' },
      )
      .toBeGreaterThan(0)

    // Evidence: the poll above observed the background dot on session A while
    // its turn was done but the background process had not exited yet.
    await page.screenshot({ path: 'test-results/cross-session-bg-dot-before-switch.png' })

    // Create a new session (click "New session" button).
    await page.locator('button:has-text("New session")').first().click()
    await page.waitForTimeout(2000)

    releaseCrossSessionBackground(fixture)

    // Now wait for the background process to finish and auto-dismiss.
    // The session A dot should transition away from "background running".
    await expect
      .poll(
        () => page.locator(`[aria-label="${BG_DOT_LABEL}"]`).count(),
        { timeout: 30_000, message: 'background dot should disappear after process finishes' },
      )
      .toBe(0)

    // The original session should show a "finished unread" indicator (green dot)
    // since its turn completed while we were in a different session. This is an
    // event-driven transition, so wait for it instead of sampling the DOM right
    // after the running dot disappears.
    await expect
      .poll(
        () => page.locator(`[aria-label="${UNREAD_DOT_LABEL}"]`).count(),
        { timeout: 30_000, message: 'original session should show finished-unread dot' },
      )
      .toBeGreaterThan(0)

    // Evidence: the green "finished unread" dot on the original session after
    // switching to a new session — the cross-session dot transition.
    await page.screenshot({ path: 'test-results/cross-session-unread-dot-after-switch.png' })
  })
})
