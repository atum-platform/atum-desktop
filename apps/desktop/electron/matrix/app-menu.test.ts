import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import { DESKTOP_LOCALES, type DesktopLocale } from '../../shared/desktop-locale'
import type { MatrixSnapshot } from '../../shared/matrix'

import { MATRIX_APP_NAME } from './app-identity'
import {
  closeMatrixDevToolsInShippedBuild,
  createMatrixAppMenu,
  type MatrixAppMenuActions,
  matrixAppMenuLocale,
  matrixAppMenuTemplate,
  matrixRemoteControlSwitches,
  matrixUpdateCheckMessage
} from './app-menu'
import { matrixAppMenuCopy, matrixUpdateCheckCopy } from './app-menu-copy'

type Item = MenuItemConstructorOptions

function items(template: Item[]): Item[] {
  return template.flatMap(item => [item, ...(Array.isArray(item.submenu) ? items(item.submenu) : [])])
}

function byRole(template: Item[], role: string): Item | undefined {
  return items(template).find(item => item.role === role)
}

const click = (item: Item | undefined) => (item?.click as unknown as (() => void) | undefined)?.()

function actions(overrides: Partial<MatrixAppMenuActions> = {}): MatrixAppMenuActions {
  return { packaged: true, updates: true, checkForUpdates: vi.fn(), website: vi.fn(), ...overrides }
}

function signedIn(language?: DesktopLocale): Pick<MatrixSnapshot, 'identity' | 'displayPreferences'> {
  return {
    identity: { userId: '@person:atum.test', deviceId: 'DEVICE' },
    displayPreferences: language
      ? {
          appearance: { value: 'system', writable: true },
          textSize: { value: 100, writable: true },
          language: { value: language, writable: true }
        }
      : undefined
  }
}

const signedOut: Pick<MatrixSnapshot, 'identity' | 'displayPreferences'> = { identity: null }

describe('the macOS menu bar', () => {
  it.each(DESKTOP_LOCALES)('names the app Atum in About, Hide and Quit, and never the old name (%s)', locale => {
    for (const packaged of [true, false]) {
      const template = matrixAppMenuTemplate(matrixAppMenuCopy(locale), actions({ packaged }))

      for (const role of ['about', 'hide', 'quit']) {
        expect(byRole(template, role)?.label).toContain(MATRIX_APP_NAME)
      }

      for (const item of items(template)) {
        if (item.type === 'separator') {
          continue
        }

        // A role without a label would fall back to Electron's English default ("Quit <identity name>").
        expect(item.label?.trim()).toBeTruthy()
        expect(item.label).not.toMatch(/candidate|matrix|hermes|electron/i)
      }
    }
  })

  it('has no Reload or developer tools in a shipped build, and keeps both in development', () => {
    const developer = ['reload', 'forceReload', 'toggleDevTools']
    const shipped = items(matrixAppMenuTemplate(matrixAppMenuCopy('vi'), actions()))
    const development = items(matrixAppMenuTemplate(matrixAppMenuCopy('vi'), actions({ packaged: false })))

    // Nor the View menu role, whose default submenu is exactly those items.
    expect(shipped.filter(item => [...developer, 'viewMenu'].includes(String(item.role)))).toEqual([])
    expect(developer.every(role => development.some(item => item.role === role))).toBe(true)
  })

  it('keeps the native menu the app had, with Check for Updates… and Help › Atum Website', () => {
    const copy = matrixAppMenuCopy('en')
    const template = matrixAppMenuTemplate(copy, actions({ packaged: false }))

    const entries = (item: Item) =>
      Array.isArray(item.submenu) ? item.submenu.map(each => each.role ?? each.type ?? each.label) : []

    expect(template.map(item => item.label)).toEqual(['Atum', 'File', 'Edit', 'View', 'Window', 'Help'])
    expect(template.map(item => item.role)).toEqual(['appMenu', 'fileMenu', 'editMenu', undefined, 'windowMenu', 'help'])
    expect(entries(template[0]!)).toEqual([
      'about',
      'Check for Updates…',
      'separator',
      'services',
      'separator',
      'hide',
      'hideOthers',
      'unhide',
      'separator',
      'quit'
    ])
    expect(entries(template[1]!)).toEqual(['close'])
    expect(entries(template[2]!).slice(0, 9)).toEqual([
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'pasteAndMatchStyle',
      'delete',
      'selectAll'
    ])
    // No zoom: the account's text size is re-applied with every snapshot.
    expect(entries(template[3]!)).toEqual(['reload', 'forceReload', 'toggleDevTools', 'separator', 'togglefullscreen'])
    expect(entries(template[4]!)).toEqual(['minimize', 'zoom', 'separator', 'front'])
    expect(entries(template[5]!)).toEqual(['Atum Website'])
    // No accelerator is spelled out: each role keeps Electron's (⌘Q, ⌘H, ⌘C, ⌘V, ⌘A, ⌘Z…).
    expect(items(template).some(item => item.accelerator)).toBe(false)
  })

  it('checks for updates and opens the website from the menu, and offers updates only where they can be checked', () => {
    const copy = matrixAppMenuCopy('en')
    const menu = actions()
    const all = items(matrixAppMenuTemplate(copy, menu))

    click(all.find(item => item.label === copy.checkForUpdates))
    click(all.find(item => item.label === copy.website))
    expect(menu.checkForUpdates).toHaveBeenCalledOnce()
    expect(menu.website).toHaveBeenCalledOnce()

    const labels = items(matrixAppMenuTemplate(copy, actions({ updates: false }))).map(item => item.label)
    expect(labels).not.toContain(copy.checkForUpdates)
  })

  it('has every word in every Atum language', () => {
    const keys = Object.keys(matrixAppMenuCopy('en')).sort()
    const answers = Object.keys(matrixUpdateCheckCopy('en')).sort()

    for (const locale of DESKTOP_LOCALES) {
      const copy = matrixAppMenuCopy(locale)
      expect(Object.keys(copy).sort()).toEqual(keys)
      expect(Object.values(copy).every(label => label.trim().length > 0)).toBe(true)
      expect(Object.keys(matrixUpdateCheckCopy(locale)).sort()).toEqual(answers)
    }
  })

  it('speaks the account’s language once signed in, and the system’s (where Atum speaks it) before', () => {
    expect(matrixAppMenuLocale(signedIn('ja'), ['en-US'])).toBe('ja')
    // Preferences not projected yet: the system's, as the window shows an account that never chose.
    expect(matrixAppMenuLocale(signedIn(), ['en-US'])).toBe('en')
    expect(matrixAppMenuLocale(signedIn(), ['fr-FR'])).toBe('vi')
    expect(
      matrixAppMenuLocale({ identity: null, displayPreferences: signedIn('ja').displayPreferences }, ['en-US'])
    ).toBe('en')
    expect(matrixAppMenuLocale(signedOut, ['en-US', 'vi-VN'])).toBe('en')
    expect(matrixAppMenuLocale(signedOut, ['zh-Hant-TW'])).toBe('zh-hant')
    expect(matrixAppMenuLocale(signedOut, ['fr-FR'])).toBe('vi')
    expect(matrixAppMenuLocale(signedOut, [])).toBe('vi')
  })
})

describe('setting the menu', () => {
  function fixture(options: { platform?: NodeJS.Platform; ready?: boolean; languages?: string[] } = {}) {
    let ready = options.ready ?? true
    const built: Item[][] = []

    const menu = {
      buildFromTemplate: vi.fn((template: Item[]) => {
        built.push(template)

        return { template } as unknown as Electron.Menu
      }),
      setApplicationMenu: vi.fn()
    }

    const log = vi.fn()
    const checkForUpdates = vi.fn()

    const appMenu = createMatrixAppMenu({
      menu,
      platform: options.platform ?? 'darwin',
      ready: () => ready,
      systemLanguages: () => options.languages ?? ['vi-VN'],
      log,
      packaged: true,
      updates: true,
      checkForUpdates,
      website: vi.fn()
    })

    return { appMenu, menu, built, log, checkForUpdates, setReady: (value: boolean) => void (ready = value) }
  }

  it('replaces the menu only when its language changes, and checks for updates in that language', () => {
    const f = fixture()

    f.appMenu.apply(signedOut)
    f.appMenu.apply(signedOut)
    f.appMenu.apply(signedIn('vi'))
    expect(f.menu.setApplicationMenu).toHaveBeenCalledOnce()
    expect(byRole(f.built[0]!, 'quit')?.label).toBe('Thoát Atum')

    f.appMenu.apply(signedIn('en'))
    expect(f.menu.setApplicationMenu).toHaveBeenCalledTimes(2)
    expect(byRole(f.built[1]!, 'quit')?.label).toBe('Quit Atum')

    click(items(f.built[1]!).find(item => item.label === 'Check for Updates…'))
    expect(f.checkForUpdates).toHaveBeenCalledWith('en')
    // A shipped build's menu, as set: no developer tools.
    expect(byRole(f.built[1]!, 'toggleDevTools')).toBeUndefined()
  })

  it('waits for the app to be ready, and leaves other platforms’ menus alone', () => {
    const early = fixture({ ready: false })

    early.appMenu.apply(signedOut)
    expect(early.menu.setApplicationMenu).not.toHaveBeenCalled()
    early.setReady(true)
    early.appMenu.apply(signedOut)
    expect(early.menu.setApplicationMenu).toHaveBeenCalledOnce()

    const linux = fixture({ platform: 'linux' })

    linux.appMenu.apply(signedIn('en'))
    expect(linux.menu.buildFromTemplate).not.toHaveBeenCalled()
  })

  it('never lets a menu failure stop a snapshot, and does not retry it on every snapshot', () => {
    const f = fixture()

    f.menu.buildFromTemplate.mockImplementation(() => {
      throw new Error('menu')
    })
    expect(() => f.appMenu.apply(signedOut)).not.toThrow()
    f.appMenu.apply(signedOut)
    expect(f.menu.buildFromTemplate).toHaveBeenCalledOnce()
    expect(f.log).toHaveBeenCalledWith('[Matrix] app menu not set')
  })
})

describe('Check for Updates…', () => {
  const base = { locale: 'en' as const, current: '0.18.1', next: null }

  it('waits while checking, then says what it found', () => {
    expect(matrixUpdateCheckMessage({ ...base, state: 'checking' })).toBeNull()
    expect(matrixUpdateCheckMessage({ ...base, state: 'restarting' })).toBeNull()
    expect(matrixUpdateCheckMessage({ ...base, state: 'idle' })?.message).toContain('0.18.1')
    expect(matrixUpdateCheckMessage({ ...base, state: 'downloading', next: '0.18.2' })?.message).toContain('0.18.2')
    expect(matrixUpdateCheckMessage({ ...base, state: 'error' })?.restart).toBe(false)
    expect(matrixUpdateCheckMessage({ ...base, state: 'unavailable' })?.message).toContain('atumplatform.com')
  })

  it('describes the selected channel instead of calling a newer installed build globally latest', () => {
    const answer = matrixUpdateCheckMessage({ locale: 'vi', current: '0.20.5', next: null, state: 'idle' })

    expect(answer?.message).toBe('Không có phiên bản mới hơn trên kênh cập nhật này. Bạn đang dùng Atum 0.20.5.')
    expect(answer?.message).not.toContain('phiên bản mới nhất')
  })

  it('offers to restart a downloaded update, unless work in progress has to finish first', () => {
    const ready = matrixUpdateCheckMessage({ ...base, state: 'downloaded', next: '0.18.2' })
    expect(ready).toMatchObject({ restart: true, buttons: ['Restart', 'Later'] })
    const busy = matrixUpdateCheckMessage({ ...base, state: 'downloaded', next: '0.18.2', busy: true })
    expect(busy).toMatchObject({ restart: false, buttons: ['OK'] })
  })

  it('answers in every Atum language', () => {
    for (const locale of DESKTOP_LOCALES) {
      for (const state of ['idle', 'downloading', 'downloaded', 'error', 'unavailable'] as const) {
        const answer = matrixUpdateCheckMessage({ ...base, locale, state })
        expect(answer?.message.length).toBeGreaterThan(0)
        expect(answer?.message).not.toMatch(/candidate|matrix|hermes|electron/i)
      }
    }
  })
})

describe('developer tools in a shipped build', () => {
  it('close again whenever any window or view opens them; development keeps them', () => {
    const listeners: Array<() => void> = []
    const contents = { on: vi.fn((_event: string, listener: () => void) => listeners.push(listener)), closeDevTools: vi.fn() }

    closeMatrixDevToolsInShippedBuild(true, contents)
    listeners.forEach(listener => listener())
    expect(contents.closeDevTools).toHaveBeenCalledOnce()

    const development = { on: vi.fn(), closeDevTools: vi.fn() }
    closeMatrixDevToolsInShippedBuild(false, development)
    expect(development.on).not.toHaveBeenCalled()
  })
})

describe('a shipped build started under remote control', () => {
  it('finds remote debugging and the Node inspector in every spelling, and nothing else', () => {
    expect(
      matrixRemoteControlSwitches([
        '--remote-debugging-port=9222',
        '-remote-debugging-pipe',
        '--inspect',
        '--inspect-brk=0.0.0.0:9229',
        '--inspect_port=9229',
        '--INSPECT-WAIT'
      ])
    ).toEqual([
      'remote-debugging-port',
      'remote-debugging-pipe',
      'inspect',
      'inspect-brk',
      'inspect-port',
      'inspect-wait'
    ])

    // An ordinary launch, a deep link and the app's own options pass.
    expect(
      matrixRemoteControlSwitches([
        '--matrix-profile=candidate',
        '--matrix-config=/home/example/public-config.json',
        'atum://open?x=--inspect',
        '--lang=vi',
        '-psn_0_123456'
      ])
    ).toEqual([])
  })

  it('takes only its own switches in a shipped build: nothing may run in place of its child processes', () => {
    // Another program in place of the renderer or a helper would receive the person's key.
    expect(
      matrixRemoteControlSwitches([
        '--browser-subprocess-path=/tmp/helper',
        '--renderer-cmd-prefix=/tmp/wrap',
        '-utility_cmd_prefix=/tmp/wrap',
        '--GPU-LAUNCHER=/tmp/wrap'
      ])
    ).toEqual(['browser-subprocess-path', 'renderer-cmd-prefix', 'utility-cmd-prefix', 'gpu-launcher'])

    // Whatever else Chromium or Node would honour is refused too, by name only, never its value.
    expect(
      matrixRemoteControlSwitches([
        '--no-sandbox',
        '--log-net-log=/tmp/net.json',
        '--net-log-capture-mode=Everything',
        '--js-flags=--allow-natives-syntax',
        '--proxy-server=127.0.0.1:8080',
        '--ignore-certificate-errors',
        '--',
        '--/home/example/secret path'
      ])
    ).toEqual([
      'no-sandbox',
      'log-net-log',
      'net-log-capture-mode',
      'js-flags',
      'proxy-server',
      'ignore-certificate-errors',
      'unnamed'
    ])

    // Chromium's own parse of the ones that matter most.
    const parsed = new Set(['browser-subprocess-path', 'gpu-launcher'])
    expect(matrixRemoteControlSwitches([], name => parsed.has(name))).toEqual([
      'browser-subprocess-path',
      'gpu-launcher'
    ])
  })

  it('also trusts Chromium’s own parse of the command line', () => {
    const hasSwitch = vi.fn((name: string) => name === 'remote-debugging-port')

    expect(matrixRemoteControlSwitches([], hasSwitch)).toEqual(['remote-debugging-port'])
    expect(hasSwitch).toHaveBeenCalledWith('inspect')
  })
})
