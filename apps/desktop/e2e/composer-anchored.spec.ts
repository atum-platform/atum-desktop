import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

let fixture: MockBackendFixture | null = null

test.beforeAll(async () => {
  fixture = await setupMockBackend()
  await waitForAppReady(fixture, 120_000)
})

test.afterAll(async () => {
  await fixture?.cleanup()
})

test('Atum composer stays anchored after dragging and restoring a legacy floating preference', async () => {
  const page = fixture!.page
  await page.evaluate(() => localStorage.setItem('hermes.desktop.composerPopout.enabled', 'true'))
  await page.reload()
  await waitForAppReady(fixture!, 120_000)

  const composer = page.locator('[data-slot="composer-root"]')
  await expect(composer).toBeVisible()
  await expect(composer).not.toHaveAttribute('data-popped-out')
  await expect(composer.locator('[data-slot="composer-drag-region"]')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() =>
    parseFloat(document.documentElement.style.getPropertyValue('--composer-measured-height'))
  )).toBeGreaterThan(0)

  const before = (await composer.boundingBox())!
  // Grab the old peel-off margin, then pull well past its 16px threshold.
  await page.mouse.move(before.x + before.width / 2, before.y + 2)
  await page.mouse.down()
  await page.mouse.move(before.x + before.width / 2, before.y - 100, { steps: 10 })
  await page.mouse.up()
  await page.mouse.dblclick(before.x + before.width / 2, before.y + 2)
  await expect(composer).not.toHaveAttribute('data-popped-out')
  const after = (await composer.boundingBox())!
  expect(Math.abs(after.x - before.x)).toBeLessThan(1)
  expect(Math.abs(after.y - before.y)).toBeLessThan(1)

  // Dropping a workspace file still inserts its reference into the draft.
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer()
    data.setData('application/x-hermes-paths', JSON.stringify([{ path: 'README.md' }]))
    return data
  })
  await composer.dispatchEvent('drop', { dataTransfer: transfer })
  await transfer.dispose()
  await expect(composer.locator('[contenteditable="true"]')).toContainText('README.md')
})
