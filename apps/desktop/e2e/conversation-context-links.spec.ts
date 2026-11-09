import { UTILITY_IPC } from '../shared/atum-utilities'
import { NATIVE_APPS_CHANNELS } from '../shared/skills-launcher'
import { WORD_COMPANION_CHANNELS } from '../shared/word-companion'

import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

// Portable contracts live in Vitest. This opt-in renders the real macOS shell
// and uses the real gateway; only Office IPC is scripted to avoid user files.
test.skip(
  process.platform !== 'darwin' || process.env.ATUM_CONTEXT_LINKS_SMOKE !== '1',
  'opt-in macOS rendered context-link acceptance'
)
let fixture: MockBackendFixture
let automaticRead = ''

test.beforeAll(async () => {
  let automaticStep = 0
  fixture = await setupMockBackend({ productionFlags: true, accountId: 'e2e-context-link-account', mockServer: {
    completionScript: messages => {
      const lastUser = messages.filter(message => message.role === 'user').at(-1)
      if (!JSON.stringify(lastUser).includes('E2E_LINK_AUTOMATIC') || String(messages[0]?.content).startsWith('Generate a short, descriptive title')) {return null}
      automaticRead = messages.filter(message => message.role === 'tool').map(message => String(message.content)).join('\n')
      if (automaticStep++ === 0) {return { text: 'Opening the requested Word document.', toolCalls: [{ name: 'open_preview', args: { url: '/tmp/Atum-link-A.docx' } }] }}
      if (automaticStep <= 4 && !automaticRead.includes('AUTOMATIC_WORD_READ')) {return { text: 'Confirming live access to the opened document.', toolCalls: [{ name: 'word_document', args: { action: 'read' } }] }}
      return { text: 'E2E_AUTOMATIC_COMPLETE' }
    }
  } })
  await fixture.app.evaluate(({ ipcMain }, channels) => {
    const documents = [
      { id: 'candidate-a', path: '/tmp/Atum-link-A.docx', name: 'Atum-link-A.docx' },
      { id: 'candidate-b', path: '/tmp/Atum-link-B.docx', name: 'Atum-link-B.docx' }
    ]
    const bindings = new Map<string, (typeof documents)[number]>()
    const handle = (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event: unknown, ...args: unknown[]) => fn(...args))
    }
    handle(channels.listDocuments, () => ({ documents }))
    handle(channels.open, (path, requestId) => {
      const doc = documents.find(value => value.path === path)
      if (!doc) {throw new Error('WORD_DOCUMENT_UNAVAILABLE')}
      bindings.set(String(requestId), doc)
      return { ...doc, id: requestId }
    })
    handle(channels.execute, (id, ref) => {
      if (!bindings.has(String(id)) || !(ref as { turn_id?: string }).turn_id) {throw new Error('WORD_DOCUMENT_UNAVAILABLE')}
      return { text: 'AUTOMATIC_WORD_READ', saved: false, revision: 'automatic-live-revision' }
    })
    handle(channels.bind, raw => {
      const request = raw as { requestId: string; candidateId?: string; path?: string }
      const doc = documents.find(value => value.id === request.candidateId || value.path === request.path)
      if (!doc) {
        throw new Error('WORD_DOCUMENT_UNAVAILABLE')
      }
      bindings.clear()
      bindings.set(request.requestId, doc)
      return { ...doc, id: request.requestId }
    })
    handle(channels.unbind, id => bindings.delete(String(id)))
    handle(channels.showBeside, id => {
      const doc = bindings.get(String(id))
      if (!doc) {
        throw new Error('WORD_DOCUMENT_UNAVAILABLE')
      }
      return { ...doc, id: `layout-${String(id)}` }
    })
    handle(channels.end, () => undefined)
    handle(channels.capture, id => {
      const doc = bindings.get(String(id))
      if (!doc) {
        throw new Error('WORD_DOCUMENT_UNAVAILABLE')
      }
      return {
        text: doc.name.includes('-A') ? 'UNSAVED_LINK_A' : 'UNSAVED_LINK_B',
        revision: 'test-live-revision',
        saved: false
      }
    })
    handle(channels.listOpenDocumentWindows, () => ({ windows: [] }))
    handle(channels.utilitiesStatus, () => ({ status: { accountId: 'e2e-context-link-account', generation: 1, sources: [], available: { google: false, 'apple-calendar': false } } }))
  }, { ...WORD_COMPANION_CHANNELS, listOpenDocumentWindows: NATIVE_APPS_CHANNELS.listOpenDocumentWindows, utilitiesStatus: UTILITY_IPC.status })
  await fixture.page.reload({ waitUntil: 'domcontentloaded' })
  await waitForAppReady(fixture, 120_000)
})
test.afterAll(async () => {
  await fixture?.cleanup()
})

// eslint-disable-next-line no-empty-pattern
test('picker, hidden layout, immutable send and explicit no-document remain one conversation flow', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const page = fixture.page
  const input = page.locator('[data-slot="composer-rich-input"][contenteditable="true"]').first()
  await input.fill('E2E_LINK_AUTOMATIC: open the Word document and read it')
  await input.press('Enter')
  await expect.poll(() => automaticRead, { timeout: 60_000 }).toContain('AUTOMATIC_WORD_READ')
  await expect(page.getByText('E2E_AUTOMATIC_COMPLETE', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Exit side by side', exact: true }).last().click()
  await input.fill('Draft preserved while linking')
  await page.getByRole('button', { name: 'Work with…', exact: true }).click()
  const picker = page.locator('[data-slot="popover-content"]').filter({ hasText: 'Choose a document or app' })
  await expect(picker).toBeVisible()
  const candidate = picker.getByRole('button', { name: /Atum-link-A.docx/ }).first()
  await expect(candidate).toBeVisible()
  await testInfo.attach('Context picker wide light', { body: await page.screenshot({ path: testInfo.outputPath('picker-wide-light.png') }), contentType: 'image/png' })
  // Secondary action links without presenting a layout bar.
  await candidate.locator('..').getByRole('button', { name: 'Link only', exact: true }).click()
  await expect(picker).not.toBeVisible()
  await expect(input).toHaveText('Draft preserved while linking')
  await expect(page.getByRole('button', { name: /Atum-link-A.docx.*Linked/ }).first()).toBeVisible()
  await input.fill('E2E_LINK_CAPTURE_A: acknowledge this document')
  await input.press('Enter')
  await expect
    .poll(
      () =>
        fixture.mock.receivedPrompts.some(
          text => text.includes('E2E_LINK_CAPTURE_A') && text.includes('UNSAVED_LINK_A')
        ),
      { timeout: 60_000 }
    )
    .toBe(true)

  await page.getByRole('button', { name: 'Work with…', exact: true }).click()
  await expect(picker).toBeVisible()
  await picker
    .getByRole('button', { name: /Atum-link-B.docx/ })
    .first()
    .click()
  await expect(picker).not.toBeVisible()
  await expect(page.getByRole('button', { name: /Atum-link-B.docx.*Linked/ }).first()).toBeVisible()
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.getByRole('button', { name: 'Work with…', exact: true }).click()
  await expect(picker).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('picker-wide-dark.png') })
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 760, height: 760 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(760)
  await expect(page.locator('html')).toHaveClass(/dark/)
  await testInfo.attach('Linked document narrow dark', { body: await page.screenshot({ path: testInfo.outputPath('linked-narrow-dark.png') }), contentType: 'image/png' })
  await page.getByRole('button', { name: /Atum-link-B.docx.*Linked/ }).first().click()
  await expect(picker).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('picker-narrow-dark.png') })
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await page.screenshot({ path: testInfo.outputPath('picker-narrow-light.png') })
  await page.keyboard.press('Escape')
  await input.fill('E2E_LINK_WITHOUT: answer without a document')
  // The overflow exposes the deliberate bypass without removing the link.
  await page
    .getByRole('button', { name: /Change…|Document actions/ })
    .last()
    .click()
  await page.getByRole('menuitem', { name: 'Send without document', exact: true }).click()
  await expect
    .poll(() => fixture.mock.receivedPrompts.some(text => text.includes('E2E_LINK_WITHOUT')), { timeout: 60_000 })
    .toBe(true)
  const without = fixture.mock.receivedPrompts.find(text => text.includes('E2E_LINK_WITHOUT'))!
  expect(without).not.toContain('UNSAVED_LINK_B')
  await page.getByRole('button', { name: 'Exit side by side', exact: true }).last().click()
  await expect(page.getByRole('button', { name: /Atum-link-B.docx.*Linked/ }).first()).toBeVisible()
  await input.fill('Draft retained through Other apps')
  await page.getByRole('button', { name: /Atum-link-B.docx.*Linked/ }).first().click()
  await expect(picker).toBeVisible()
  await picker.locator('[data-context-link-other-apps]').click()
  await expect(page.locator('[data-atum-skills-launcher]')).toBeVisible()
  await expect(input).toHaveText('Draft retained through Other apps')
  expect(fixture.mock.receivedPrompts.some(text => text.includes('Draft retained through Other apps'))).toBe(false)

})
