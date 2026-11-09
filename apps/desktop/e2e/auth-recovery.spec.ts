import { setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

for (const [locale, retryLabel, signInLabel, failedCopy] of [
  ['en', 'Retry connection', 'Sign in', 'Still unable to verify your saved sign-in.'],
  ['vi', 'Thử kết nối lại', 'Đăng nhập', 'Vẫn chưa xác minh được phiên đăng nhập đã lưu.']
]) {
  test(`startup connection recovery and labeled editable password (${locale})`, async ({
    browserName: _browserName
  }, testInfo) => {
    const fixture = await setupMockBackend({
      accountId: 'auth-recovery-fixture',
      extraDisplayConfig: `  language: ${locale}`
    })

    try {
      await waitForAppReady(fixture)
      await fixture.app.evaluate(({ ipcMain }) => {
        let recovered = false
        let attempts = 0

        const status = () => ({
          state: recovered ? 'signed_in' : 'error',
          configured: true,
          account: recovered ? { id: 'auth-recovery-fixture' } : null,
          errorCode: recovered ? null : 'hosted_session_unavailable',
          providers: { google: true, password: true }
        })

        ipcMain.removeHandler('atum:account:status')
        ipcMain.handle('atum:account:status', status)
        ipcMain.removeHandler('atum:account:retry-restore')
        ipcMain.handle('atum:account:retry-restore', () => {
          recovered = ++attempts > 1

          return status()
        })
      })
      const page = fixture.page
      await page.reload()
      const gate = page.locator('[data-atum-auth]')
      await expect(gate).toBeVisible()
      await expect(gate.locator('[role="alert"]')).toHaveCount(0)
      const password = gate.locator('#atum-password')
      await expect(gate.locator('label[for="atum-password"]')).toBeVisible()
      await expect(password).toBeEnabled()
      await expect(password).toHaveAttribute('placeholder', /.+/)
      await password.fill('fixture-only-password')
      await expect(password).toHaveAttribute('type', 'password')
      await password.fill('')
      // Both enabled fields have the same solid material even without focus.
      await gate.locator('h1').click()
      expect(await password.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(
        await gate.locator('#atum-identifier').evaluate(el => getComputedStyle(el).backgroundColor)
      )
      await gate.locator('main').evaluate(el => {
        el.scrollTop = 0
      })
      await expect(gate.getByRole('button', { name: signInLabel, exact: true })).toBeInViewport({ ratio: 1 })
      // Electron's transparent native vibrancy is absent from captured pixels.
      await page.addStyleTag({ content: '[data-atum-auth] { background: #f5f5f5 !important; }' })
      await page.screenshot({ path: testInfo.outputPath('auth-recovery.png') })
      const retry = gate.getByRole('button', { name: retryLabel })
      await retry.focus()
      await retry.press('Enter')
      await expect(gate.getByRole('status')).toContainText(failedCopy)
      await expect(retry).toBeFocused()
      await expect(password).toBeEnabled()
      await retry.press('Enter')
      await expect(gate).toHaveCount(0)
      await expect(page.locator('[data-atum-shell]')).toBeVisible()
    } finally {
      await fixture.cleanup()
    }
  })
}
