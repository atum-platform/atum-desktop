import { UTILITY_IPC, type UtilityStatus } from '../shared/atum-utilities'

import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

let fixture: MockBackendFixture | null = null

test.afterEach(async () => { await fixture?.cleanup(); fixture = null })

test('first-use connections sit above a usable composer and disappear after all three connect', async ({ browserName: _browserName }, testInfo) => {
  fixture = await setupMockBackend({ accountId: 'e2e-utilities-account', extraDisplayConfig: '  language: en' })
  // Test the built renderer and real preload/IPC seam without authorizing a
  // personal account. Provider authorization is covered by the HTTP tests.
  await fixture.app.evaluate(({ ipcMain }, channels) => {
    let status: UtilityStatus = {
      accountId: 'e2e-utilities-account', generation: 1,
      sources: [],
      available: { google: true, 'apple-calendar': true }
    }

    ipcMain.removeHandler(channels.status)
    ipcMain.handle(channels.status, () => ({ status }))
    ipcMain.removeHandler(channels.connect)
    ipcMain.handle(channels.connect, (_event: unknown, raw: unknown) => {
      const input = raw as { provider: string; service: string }

      if (input.provider !== 'google') { return { status, error: 'denied' } }
      const kinds = input.service === 'drive' ? ['drive'] as const : ['email', 'calendar'] as const
      status = { ...status, sources: [...status.sources.filter(source => !kinds.some(kind => source.kind === kind)), ...kinds.map(kind => ({ id: kind, kind, provider: 'google' as const, accountKey: 'test-google', label: 'test@example.com', state: 'connected' as const, enabled: true }))] }

      return { status }
    })
  }, UTILITY_IPC)
  await fixture.page.reload({ waitUntil: 'domcontentloaded' })
  await waitForAppReady(fixture, 120_000)
  const page = fixture.page
  const card = page.locator('[data-slot="utility-connection-card"]')
  await expect(card).toBeVisible()
  await expect(card.getByRole('button', { name: /Skip|Later|Dismiss/i })).toHaveCount(0)
  const composer = page.locator('[contenteditable="true"]').first()
  await composer.fill('Keep this draft while I connect')
  const [cardBox, composerBox] = await Promise.all([card.boundingBox(), composer.boundingBox()])
  expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(composerBox!.y)
  await page.screenshot({ path: testInfo.outputPath('first-use-composer.png') })
  await card.getByRole('button', { name: 'Connect email', exact: true }).click()
  await expect(card.getByText(/all assistant work in this Atum account/)).toBeVisible()
  await card.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(card.getByRole('button', { name: 'Connect Drive', exact: true })).toBeVisible()
  await expect(composer).toContainText('Keep this draft while I connect')
  await card.getByRole('button', { name: 'Connect Drive', exact: true }).click()
  await card.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(card).toHaveCount(0)
  await expect(composer).toContainText('Keep this draft while I connect')
})
