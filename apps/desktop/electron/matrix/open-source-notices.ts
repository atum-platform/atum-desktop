import { existsSync } from 'node:fs'
import path from 'node:path'

import type { BrowserWindowConstructorOptions } from 'electron'

/**
 * Settings › General › Legal › Open-source licences: the notice that ships in the app
 * (Contents/Resources/licenses/THIRD-PARTY-NOTICES.txt, written at packaging by
 * scripts/third-party-notices.mjs) opens in a window of the app. The window shows that one local
 * text file and nothing else: no preload, no script, no navigation, no new windows.
 */
export const MATRIX_NOTICES_DIRECTORY = 'licenses'
export const MATRIX_NOTICE_FILE = 'THIRD-PARTY-NOTICES.txt'

/** The window's title is the row's own words in the person's language; anything else is refused. */
export function parseMatrixNoticesTitle(value: unknown): string {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('matrix_command_invalid')
  }

  return value.trim()
}

export function matrixNoticesWindowOptions(title: string): BrowserWindowConstructorOptions {
  return {
    title,
    width: 760,
    height: 760,
    minWidth: 420,
    minHeight: 320,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      webSecurity: true,
      spellcheck: false,
      // In memory only: the notice keeps nothing between launches.
      partition: 'matrix-open-source-notices'
    }
  }
}

interface NoticesEvent {
  preventDefault(): void
}

/** The BrowserWindow subset this module uses; real Electron satisfies it. */
export interface MatrixNoticesWindow {
  isDestroyed(): boolean
  show(): void
  focus(): void
  close(): void
  setTitle(title: string): void
  once(event: 'ready-to-show', listener: () => void): unknown
  once(event: 'closed', listener: () => void): unknown
  on(event: 'page-title-updated', listener: (event: NoticesEvent) => void): unknown
  loadFile(file: string): Promise<void>
  webContents: {
    setWindowOpenHandler(handler: () => { action: 'deny' }): void
    on(event: 'will-navigate', listener: (event: NoticesEvent) => void): unknown
    on(event: 'will-attach-webview', listener: (event: NoticesEvent) => void): unknown
  }
}

export interface MatrixOpenSourceNoticesOptions {
  /** Resources/licenses in a packaged app; undefined in development, where there is no notice. */
  directory: string | undefined
  create: (options: BrowserWindowConstructorOptions) => MatrixNoticesWindow
  exists?: (file: string) => boolean
}

export interface MatrixOpenSourceNotices {
  open(title: unknown): Promise<void>
  close(): void
}

export function createMatrixOpenSourceNotices({
  directory,
  create,
  exists = existsSync
}: MatrixOpenSourceNoticesOptions): MatrixOpenSourceNotices {
  let current: MatrixNoticesWindow | undefined

  return {
    async open(value) {
      const title = parseMatrixNoticesTitle(value)
      const file = directory ? path.join(directory, MATRIX_NOTICE_FILE) : undefined

      if (!file || !exists(file)) {
        throw new Error('matrix_notices_unavailable')
      }

      if (current && !current.isDestroyed()) {
        current.setTitle(title)
        current.show()
        current.focus()

        return
      }

      const window = create(matrixNoticesWindowOptions(title))
      current = window
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', event => event.preventDefault())
      window.webContents.on('will-attach-webview', event => event.preventDefault())
      // A text file has no title of its own; keep the row's words, not the file name.
      window.on('page-title-updated', event => event.preventDefault())
      window.once('ready-to-show', () => {
        if (!window.isDestroyed()) {
          window.show()
          window.focus()
        }
      })
      window.once('closed', () => {
        if (current === window) {
          current = undefined
        }
      })

      try {
        await window.loadFile(file)
      } catch (error) {
        if (!window.isDestroyed()) {
          window.close()
        }

        throw error
      }
    },
    close() {
      if (current && !current.isDestroyed()) {
        current.close()
      }

      current = undefined
    }
  }
}
