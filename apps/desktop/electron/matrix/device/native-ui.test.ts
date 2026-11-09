import { EventEmitter } from 'node:events'

import { JSDOM } from 'jsdom'
import { afterEach, expect, it, vi } from 'vitest'
const windows = vi.hoisted(() => [] as Array<any>)
vi.mock('electron', () => ({
  BrowserWindow: class extends EventEmitter {
    destroyed = false
    webContents = {
      session: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        webRequest: { onBeforeRequest: vi.fn() }
      },
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      executeJavaScript: vi.fn(async () => undefined)
    }
    constructor(readonly options: unknown) {
      super()
      windows.push(this)
    }
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      this.destroyed = true
      this.emit('closed')
    }
    async loadURL() {}
    show() {}
  },
  dialog: { showMessageBox: vi.fn() },
  Menu: {},
  nativeImage: {},
  Notification: {},
  Tray: class {}
}))
import { dialog } from 'electron'

import { createDeviceNativeUi, devicePasswordHtml } from './native-ui'
afterEach(() => {
  windows.length = 0
  vi.useRealTimers()
})

it('renders the exact command as inert text and clears the password field at submission', () => {
  const command = 'sudo echo "</pre><script>window.stolen=true</script>"'
  const page = new JSDOM(devicePasswordHtml(command, 'en'), { runScripts: 'dangerously' })
  expect(page.window.document.querySelector('pre')!.textContent).toBe(command)
  expect((page.window as any).stolen).toBeUndefined()
  const password = page.window.document.querySelector('input')!
  password.value = 'only-local-test-value'
  page.window.document.querySelector('form')!.dispatchEvent(new page.window.Event('submit', { cancelable: true }))
  expect(password.value).toBe('')
  expect((page.window as any).answer).toEqual({ password: 'only-local-test-value' })

  const policy = page.window.document
    .querySelector('meta[http-equiv="Content-Security-Policy"]')!
    .getAttribute('content')!

  expect(policy).toContain("default-src 'none'")
  expect(policy).toContain("form-action 'none'")
  page.window.close()
})
it('keeps the password sheet isolated and cancellation closes it without returning a password', async () => {
  const ui = createDeviceNativeUi({ locale: () => 'vi', parent: () => undefined })
  const password = ui.promptPassword('sudo id')
  const window = windows[0]
  expect(window.options.webPreferences).toMatchObject({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    devTools: false
  })
  expect(window.options.webPreferences.preload).toBeUndefined()
  const permission = window.webContents.session.setPermissionRequestHandler.mock.calls[0][0]
  const allowed = vi.fn()
  permission(null, 'media', allowed)
  expect(allowed).toHaveBeenCalledWith(false)
  const request = window.webContents.session.webRequest.onBeforeRequest.mock.calls[0][0]
  request({ url: 'https://example.invalid/password' }, allowed)
  expect(allowed).toHaveBeenLastCalledWith({ cancel: true })
  ui.cancelAll()
  await expect(password).resolves.toBeNull()
  expect(window.isDestroyed()).toBe(true)
})
it('returns one bounded local buffer and destroys the sheet', async () => {
  const ui = createDeviceNativeUi({ locale: () => 'en', parent: () => undefined })
  const password = ui.promptPassword('sudo id')
  windows[0].webContents.executeJavaScript.mockResolvedValueOnce({ password: 'local-fixture' })
  const bytes = await password
  expect(bytes?.toString()).toBe('local-fixture')
  expect(windows[0].isDestroyed()).toBe(true)
  bytes?.fill(0)
})

it('the approval choice shows three buttons with "always" first, and maps the answer', async () => {
  const ui = createDeviceNativeUi({ locale: () => 'vi', parent: () => undefined })
  const show = vi.mocked(dialog.showMessageBox)
  const words = { once: 'Cho phép lần này', always: 'Luôn cho phép trợ lý này', deny: 'Không cho phép' }

  for (const [response, choice] of [[0, 'always'], [1, 'once'], [2, 'deny']] as const) {
    show.mockResolvedValueOnce({ response, checkboxChecked: false })
    await expect(ui.chooseApproval({ message: 'T muốn dùng Chuỗi khóa', words })).resolves.toBe(choice)
  }

  const box = show.mock.calls[0][0] as unknown as { buttons: string[]; cancelId: number; message: string }
  expect(box.buttons).toEqual([words.always, words.once, words.deny])
  // Closing the box (Esc) is the last button: a refusal.
  expect(box.cancelId).toBe(2)
  expect(box.message).toBe('T muốn dùng Chuỗi khóa')
})

it('a Stop closes an approval choice that is up, as a refusal', async () => {
  const ui = createDeviceNativeUi({ locale: () => 'en', parent: () => undefined })
  const show = vi.mocked(dialog.showMessageBox)

  show.mockImplementationOnce(
    ((box: { signal: AbortSignal }) =>
      new Promise(resolve => box.signal.addEventListener('abort', () => resolve({ response: 2, checkboxChecked: false })))) as never
  )

  const choice = ui.chooseApproval({ message: 'm', words: { once: 'a', always: 'b', deny: 'c' } })
  ui.cancelAll()
  await expect(choice).resolves.toBe('deny')
})
