import { randomBytes } from 'node:crypto'

import { BrowserWindow, dialog, Menu, nativeImage, Notification, Tray } from 'electron'

import { DEVICE_APPROVAL_WAIT_MS } from './device-key'
import type { DeviceRuntimeEnvironment } from './runtime'

const WORDS = {
  en: ['Administrator password', 'Run', 'Cancel'],
  vi: ['Mật khẩu quản trị', 'Chạy', 'Hủy'],
  ja: ['管理者パスワード', '実行', 'キャンセル'],
  zh: ['管理员密码', '运行', '取消'],
  'zh-hant': ['管理員密碼', '執行', '取消']
} as const

function words(locale?: string) {
  const value = (locale ?? '').toLowerCase()

  return value.startsWith('zh')
    ? WORDS[/hant|tw|hk|mo/.test(value) ? 'zh-hant' : 'zh']
    : value.startsWith('en')
      ? WORDS.en
      : value.startsWith('ja')
        ? WORDS.ja
        : WORDS.vi
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!
  )
}

/** The local password sheet has no preload, Node, network, renderer IPC or storage. */
export function devicePasswordHtml(command: string, locale?: string): string {
  const copy = words(locale)
  const nonce = randomBytes(16).toString('base64')

  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><style>body{font:14px system-ui;padding:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:150px;overflow:auto}input{width:95%;padding:8px}button{margin:16px 8px 0 0;padding:6px 16px}</style></head><body><h2>${escapeHtml(copy[0])}</h2><pre>${escapeHtml(command)}</pre><form><input type="password" autocomplete="off" maxlength="1024" autofocus aria-label="${escapeHtml(copy[0])}"><br><button type="submit">${escapeHtml(copy[1])}</button><button type="button" id="cancel">${escapeHtml(copy[2])}</button></form><script nonce="${nonce}">document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();window.answer={password:document.querySelector('input').value};document.querySelector('input').value='';});document.querySelector('#cancel').addEventListener('click',()=>{document.querySelector('input').value='';window.answer={cancel:true};});</script></body></html>`
}

export function createDeviceNativeUi(options: { locale(): string | undefined; parent(): BrowserWindow | undefined }) {
  const cancellations = new Set<() => void>()

  const promptPassword: DeviceRuntimeEnvironment['promptPassword'] = command =>
    new Promise(resolve => {
      const parent = options.parent()

      const window = new BrowserWindow({
        width: 520,
        height: 380,
        show: false,
        resizable: false,
        minimizable: false,
        ...(parent && !parent.isDestroyed() ? { parent, modal: true } : {}),
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          devTools: false,
          partition: `device-password-${randomBytes(16).toString('hex')}`
        }
      })

      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const finish = (password: Buffer | null) => {
        if (finished) {
          password?.fill(0)

          return
        }

        finished = true
        clearTimeout(timer)
        clearTimeout(deadline)
        cancellations.delete(cancel)

        if (!window.isDestroyed()) {window.destroy()}
        resolve(password)
      }

      const cancel = () => finish(null)
      const deadline = setTimeout(cancel, DEVICE_APPROVAL_WAIT_MS)
      cancellations.add(cancel)
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      window.webContents.session.setPermissionCheckHandler(() => false)
      window.webContents.session.webRequest.onBeforeRequest((request, callback) =>
        callback({ cancel: !request.url.startsWith('data:text/html,') })
      )
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', event => event.preventDefault())
      window.on('closed', cancel)

      const poll = async () => {
        if (finished || window.isDestroyed()) {return}

        try {
          const answer: unknown = await window.webContents.executeJavaScript(
            '(()=>{const value=window.answer;delete window.answer;return value})()'
          )

          if (answer && typeof answer === 'object') {
            const value = answer as { password?: unknown; cancel?: unknown }

            if (value.cancel === true) {
              cancel()

              return
            }

            if (typeof value.password === 'string' && value.password.length <= 1024 && !value.password.includes('\0')) {
              finish(Buffer.from(value.password))

              return
            }
          }

          if (!finished) {timer = setTimeout(() => void poll(), 100)}
        } catch {
          cancel()
        }
      }

      void window
        .loadURL(`data:text/html,${encodeURIComponent(devicePasswordHtml(command, options.locale()))}`)
        .then(() => {
          if (!finished) {
            window.show()
            void poll()
          }
        })
        .catch(cancel)
    })

  /**
   * The one-tap choice before a Touch ID: allow once, always allow this assistant, or don't. Waits as
   * long as the Touch ID would (a closed or timed-out box is a refusal), and is cancelled by a Stop.
   */
  const chooseApproval: NonNullable<DeviceRuntimeEnvironment['chooseApproval']> = async ({ message, words: choices }) => {
    const parent = options.parent()
    const abort = new AbortController()
    const cancel = () => abort.abort()
    const deadline = setTimeout(cancel, DEVICE_APPROVAL_WAIT_MS)
    cancellations.add(cancel)

    try {
      const box = {
        type: 'question' as const,
        message,
        buttons: [choices.always, choices.once, choices.deny],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
        signal: abort.signal
      }

      const answer = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, box) : await dialog.showMessageBox(box)

      return answer.response === 0 ? 'always' : answer.response === 1 ? 'once' : 'deny'
    } finally {
      clearTimeout(deadline)
      cancellations.delete(cancel)
    }
  }

  const tray: DeviceRuntimeEnvironment['tray'] = {
    createTray: () => {
      const native = new Tray(nativeImage.createEmpty())

      return {
        setToolTip: text => native.setToolTip(text),
        setTitle: text => native.setTitle(text),
        setContextMenu: menu => native.setContextMenu(menu as Menu),
        destroy: () => native.destroy()
      }
    },
    buildStopMenu: (status, stopLabel, onStop) =>
      Menu.buildFromTemplate([
        { label: status, enabled: false },
        { label: stopLabel, click: onStop }
      ]),
    notify: (title, body) => {
      if (Notification.isSupported()) {new Notification({ title, body }).show()}
    }
  }

  return {
    tray,
    promptPassword,
    chooseApproval,
    cancelAll: () => {
      for (const cancel of [...cancellations]) {cancel()}
    }
  }
}
