import { setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

test('one group picker preserves identities and sends shared audience intent through preload', async ({
  browserName: _browserName
}, testInfo) => {
  const fixture = await setupMockBackend({ accountId: 'group-picker-owner', extraDisplayConfig: '  language: en' })

  try {
    await waitForAppReady(fixture)
    await fixture.app.evaluate(({ ipcMain }) => {
      const replace = (channel: string, handler: (...args: any[]) => unknown) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, handler)
      }
      const status = { accountId: 'group-picker-owner', connectivity: 'online', synchronized: true,
        cursor: null, lastSuccessfulSyncAt: null, nextRetryAt: null, errorCode: null }
      const people = [{ availability: 'available', state: 'connected', canMessage: true, directThreadId: 'group-picker-direct',
        profile: { profileId: 'group-picker-sam-profile', displayName: 'Sam', handle: 'sam' } }]
      replace('atum:messaging:status', () => status)
      replace('atum:messaging:sync', () => status)
      replace('atum:messaging:roster', () => [{
        id: 'group-picker-direct', kind: 'direct', title: null,
        participantIds: ['group-picker-owner', 'group-picker-sam-account'],
        updatedAt: '2026-09-09T00:00:00Z', lastMessageAt: null, unreadCount: 0, payload: {}
      }])
      replace('atum:social:relationships', () => people)
      replace('atum:social:sync', () => people)
      replace('atum:messaging:group:operations', () => [])
      replace('atum:messaging:group:capabilities', () => ({
        available: true, creationEnabled: true, createDefaults: true, humanMemberLimit: 32,
        addressing: { enabled: true, mentionCardinality: 4, quoteLimit: 1, specialistMemberLimit: 4,
          specialistCatalog: [
            { specialist: 'atlas', displayName: 'Legacy Atlas', avatar: '', roomSupported: true },
            { specialist: 'collective', displayName: 'Legacy Collective', avatar: '', roomSupported: true }
          ] },
        advisory: { enabled: true, advisorLimit: 4, advisorCatalog: [
          { target: { type: 'specialist', id: 'atlas' }, displayName: 'Legacy Atlas', avatar: '', availability: 'available' },
          { target: { type: 'assistant', id: 'marketing' }, displayName: 'Marketing', avatar: '', availability: 'available' }
        ] },
        sharedAgents: { enabled: true, assistantMemberLimit: 4, ownAssistantOnly: true,
          assistantCatalog: [{ assistantId: 'marketing', displayName: 'Marketing', ownerUserId: 'group-picker-owner',
            membershipEpoch: 1, availability: 'available' }] }
      }))
      replace('atum:messaging:group:operate', (_event, input) => {
        ;(globalThis as any).__groupPickerInput = input
        return { operationId: input.clientOperationId, state: 'queued', conversationId: null, errorCode: null }
      })
      replace('atum:app:catalog', () => ({ apps: [
        {
          app: 'atlas', app_id: '00000000-0000-0000-0000-000000000001', app_version_id: '00000000-0000-0000-0000-000000000002',
          name: { en: 'Atlas Planner', vi: 'Atlas Planner' }, subtitle: { en: 'Shared planning', vi: 'Shared planning' },
          icon: { url: 'https://assets.example.test/atlas.png', sha256: 'a'.repeat(64) }, verified: false,
          availability: 'available', supported_modes: ['direct', 'private_group', 'shared_group'], link: { mode: 'none', state: 'never_linked' }
        },
        {
          app: 'collective', app_id: '00000000-0000-0000-0000-000000000003', app_version_id: '00000000-0000-0000-0000-000000000004',
          name: { en: 'Collective Notes', vi: 'Collective Notes' }, subtitle: { en: 'Shared rooms only', vi: 'Shared rooms only' },
          icon: { url: 'https://assets.example.test/collective.png', sha256: 'b'.repeat(64) }, verified: false,
          availability: 'available', supported_modes: ['shared_group'], link: { mode: 'none', state: 'never_linked' }
        }
      ] }))
    })
    const page = fixture.page
    await page.route('https://assets.example.test/**', route => route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="20" fill="#2463a5"/><path d="M48 16 76 48 48 80 20 48Z" fill="#c8e6ff"/></svg>'
    }))
    await page.reload({ waitUntil: 'domcontentloaded' })
    const roster = page.locator('[data-atum-roster]')
    await expect(roster.getByText('Atlas Planner', { exact: true })).toBeVisible()
    await expect(roster.getByText('Collective Notes', { exact: true })).toHaveCount(0)
    await page.locator('[data-atum-nav-discover]').click()
    // Discover is one storefront now, one shelf at a time; the app catalog is
    // the Apps shelf, not part of the Featured mix the rail opens on.
    await page.locator('[data-atum-shelf="apps"]').click()
    await expect(page.locator('[data-discover-app="atlas"]')).toBeVisible()
    await expect(page.locator('[data-discover-app="atlas"]')).toBeEnabled()
    await expect(page.locator('[data-discover-app="collective"]')).toBeVisible()
    await expect(page.locator('[data-discover-app="collective"]')).toBeDisabled()
    await expect(page.locator('[data-discover-app="atlas"]')).toContainText('Atlas Planner')
    await expect(page.locator('[data-discover-app="atlas"]')).toContainText('Shared planning')
    await expect(page.locator('[data-discover-app="atlas"] img')).toHaveAttribute('src', 'https://assets.example.test/atlas.png')
    await page.locator('[data-discover-app="atlas"]').screenshot({ path: testInfo.outputPath('generic-app-catalog.png') })
    await page.locator('[data-atum-nav-home]').click()
    await page.locator('[data-atum-create-menu]').click()
    await page.getByTestId('atum-start-chat-group').click()
    const dialog = page.getByRole('dialog', { name: 'New group', exact: true })
    await expect(dialog.getByRole('group', { name: 'People', exact: true })).toBeVisible()
    await expect(dialog.getByRole('group', { name: 'Apps', exact: true })).toBeVisible()
    await expect(dialog.getByRole('group', { name: 'Agents', exact: true })).toBeVisible()
    await expect(dialog.getByRole('tablist')).toHaveCount(0)
    await expect(dialog.getByLabel('Group name (optional)', { exact: true })).toHaveValue('')
    await dialog.getByLabel(/Atlas Planner/).check()
    await dialog.getByLabel(/Marketing/).check()
    await expect(dialog.getByText('Shared planning', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Your apps and agents use private context only in this owner-only meeting.')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('group-picker-private.png') })
    await dialog.getByLabel(/Sam/).check()
    await expect(dialog.getByText('Collective Notes', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Shared rooms only', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Everyone uses group context and approved shared identities. Apps and agents do not use private tools.')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('group-picker-shared.png') })
    await dialog.getByRole('button', { name: 'Create group', exact: true }).click()
    await expect.poll(() => fixture.app.evaluate(() => (globalThis as any).__groupPickerInput)).toMatchObject({
      action: 'create', contextMode: 'shared_group', title: '', reuseExisting: true,
      memberUserIds: ['group-picker-sam-account'], specialistIds: ['atlas'], assistantIds: ['marketing']
    })
  } finally {
    await fixture.cleanup()
  }
})
