import { UTILITY_IPC } from '../shared/atum-utilities'
import { NATIVE_APPS_CHANNELS } from '../shared/skills-launcher'

import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

let fixture: MockBackendFixture

test.skip(process.platform !== 'darwin', 'requires the macOS native-apps preload bridge')

test.beforeAll(async () => {
  fixture = await setupMockBackend({ accountId: 'e2e-launcher-recency' })
  // Exercise the real renderer, preload and persisted state without launching
  // or rearranging the person's desktop apps in a UI-ordering test.
  await fixture.app.evaluate(({ ipcMain }, channels) => {
    const apps = [
      { id: 'zulu', name: 'Zulu', bundleId: 'test.zulu' },
      { id: 'alpha', name: 'Alpha', bundleId: 'test.alpha' },
      { id: 'beta', name: 'Beta', bundleId: 'test.beta' }
    ]

    ipcMain.removeHandler(channels.list)
    ipcMain.handle(channels.list, () => apps)
    ipcMain.removeHandler(channels.launch)
    ipcMain.handle(channels.launch, (_event: unknown, input: unknown) => {
      const request = input as { appId: string; requestId: string }

      return { id: request.requestId, app: apps.find(app => app.id === request.appId), status: 'opened' }
    })
    ipcMain.removeHandler(channels.end)
    ipcMain.handle(channels.end, () => undefined)
  }, NATIVE_APPS_CHANNELS)
  // This backend fixture has no native account connection. Keep unrelated
  // connection UI neutral, as in the existing native Skills fixture.
  await fixture.app.evaluate(({ ipcMain }, channels) => {
    ipcMain.removeHandler(channels.status)
    ipcMain.handle(channels.status, () => ({
      status: {
        accountId: 'e2e-launcher-recency', generation: 1, sources: [],
        available: { google: false, 'apple-calendar': false }
      }
    }))
  }, UTILITY_IPC)
  await fixture.page.reload({ waitUntil: 'domcontentloaded' })
  await waitForAppReady(fixture, 120_000, { preserveWorkspace: true })
})

test.afterAll(async () => {await fixture?.cleanup()})

// eslint-disable-next-line no-empty-pattern
test('keeps the open grid stable and applies successful launch order after reload', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const page = fixture.page

  // An installed skill with no corresponding app must not become a tile.
  const added = await page.evaluate(async () => {
    const desktop = (window as unknown as {
      hermesDesktop: { api: (request: Record<string, unknown>) => Promise<unknown> }
    }).hermesDesktop

    return desktop.api({ path: '/api/skills/bundled/add', method: 'POST', body: { name: 'docx' } })
  })

  expect(added).toMatchObject({ ok: true })

  const openLauncher = async () => {
    if (!await page.locator('[data-atum-skills-launcher]').isVisible()) {
      await page.locator('[data-atum-workspace-add]').click()
      await page.getByRole('button', { name: /^(Skills|Kỹ năng)$/u }).click()
    }

    await expect(page.locator('[data-launcher-tile]')).toHaveCount(3)
    await expect(page.locator('[data-launcher-status="checking"]')).toHaveCount(0, { timeout: 30_000 })
  }

  await openLauncher()
  const tiles = page.locator('[data-launcher-tile]')
  await expect(tiles).toHaveText(['Alpha', 'Beta', 'Zulu'])
  await expect(page.locator('[data-launcher-tile^="skill:"]')).toHaveCount(0)

  const zulu = page.locator('[data-launcher-tile="app:zulu"]')
  await zulu.focus()
  await zulu.press('Alt+Enter')
  await expect.poll(() => page.evaluate(() => {
    const history = JSON.parse(localStorage.getItem('hermes.desktop.atum.nativeApps.lastUsedByAccount.v1') ?? '{}')

    return history['e2e-launcher-recency']?.['test.zulu'] ?? 0
  })).toBeGreaterThan(0)
  await expect(tiles).toHaveText(['Alpha', 'Beta', 'Zulu'])
  await expect(zulu).toBeFocused()

  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForAppReady(fixture, 120_000, { preserveWorkspace: true })
  await openLauncher()
  await expect(tiles).toHaveText(['Zulu', 'Alpha', 'Beta'])
  await page.screenshot({ path: testInfo.outputPath('apps-only-recency.png') })
})
