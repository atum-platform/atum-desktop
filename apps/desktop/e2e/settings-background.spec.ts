import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

let fixture: MockBackendFixture | null = null

test.beforeAll(async () => {
  fixture = await setupMockBackend()
  await waitForAppReady(fixture, 120_000, { preserveWorkspace: true })
})

test.afterAll(async () => {
  await fixture?.cleanup()
})

test('Settings covers the retained chat and workspace in both themes', async ({}, testInfo) => {
  const page = fixture!.page
  const main = page.locator('[data-atum-main]')
  await page.locator('[data-atum-account-trigger]').click()
  await page.locator('[data-atum-account-menu] [data-atum-nav-settings]').click()
  const overlay = page.locator('[data-atum-overlay="true"]')
  await expect(overlay).toBeVisible()

  for (const [theme, label] of [['light', /^(Light|Sáng)$/u], ['dark', /^(Dark|Tối)$/u]] as const) {
    await page.getByRole('radio', { name: label }).click()
    await expect.poll(() => overlay.evaluate(element => getComputedStyle(element).backgroundImage)).toContain('radial-gradient(')

    // A transparent page can look correct over a similarly colored chat.
    // Paint two contrasting surfaces behind it and compare actual pixels in
    // an empty part of Settings, outside its opaque cards and navigation.
    const bounds = (await overlay.boundingBox())!
    const clip = { x: bounds.x + bounds.width - 80, y: bounds.y + 70, width: 40, height: 40 }
    await main.evaluate(element => element.style.background = '#ff00ff')
    const overPink = await page.screenshot({ animations: 'disabled', caret: 'hide', clip })
    await main.evaluate(element => element.style.background = '#00ff00')
    const overGreen = await page.screenshot({ animations: 'disabled', caret: 'hide', clip })
    expect(overGreen.equals(overPink)).toBe(true)
    await main.evaluate(element => element.style.removeProperty('background'))
    await page.screenshot({ animations: 'disabled', caret: 'hide', path: testInfo.outputPath(`settings-${theme}.png`) })
  }

  await page.locator('[data-atum-settings-back]').click()
  await expect(overlay).toHaveCount(0)
  await expect(page.locator('[data-atum-workspace]')).toBeVisible()
})
