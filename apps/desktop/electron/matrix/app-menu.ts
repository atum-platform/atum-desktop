import type { Menu, MenuItemConstructorOptions } from 'electron'

import type { AtumUpdateState } from '../../shared/atum-update-flow'
import { DEFAULT_DESKTOP_LOCALE, type DesktopLocale, desktopLocaleFor } from '../../shared/desktop-locale'
import type { MatrixSnapshot } from '../../shared/matrix'

import { type MatrixAppMenuCopy, matrixAppMenuCopy, matrixUpdateCheckCopy } from './app-menu-copy'

/** Atum's public home, the Help menu's one destination (a fixed public page). */
export const MATRIX_MENU_WEBSITE = 'https://atumplatform.com/'

type MenuSnapshot = Pick<MatrixSnapshot, 'identity' | 'displayPreferences'>

/**
 * The menu speaks the window's language: the account's once someone is signed in, and
 * otherwise the system's where Atum speaks it (the window's first screen, and an account
 * that never chose a language, do the same), else Vietnamese.
 */
export function matrixAppMenuLocale(snapshot: MenuSnapshot, systemLanguages: readonly string[]): DesktopLocale {
  const chosen = snapshot.identity ? snapshot.displayPreferences?.language?.value : undefined

  return chosen ?? desktopLocaleFor(systemLanguages) ?? DEFAULT_DESKTOP_LOCALE
}

/** What the menu does beyond Electron's roles. */
export interface MatrixAppMenuActions {
  /** A packaged (shipped) build: no Reload and no developer tools. */
  packaged: boolean
  /** Check for Updates… appears only where this copy can update itself. */
  updates: boolean
  checkForUpdates: () => void
  website: () => void
}

/**
 * Electron's default macOS menu (same roles, so the same shortcuts and native behaviour),
 * named Atum and in the person's language — the app runs under its identity name
 * (app-identity.ts), which the default menu would print in About, Hide and Quit — with
 * Atum's own items: Check for Updates… under About, and Help › Atum Website instead of
 * electronjs.org.
 *
 * A shipped build has neither Reload (which drops a running turn) nor developer tools; a
 * development build keeps both. The View menu carries no `viewMenu` role, whose default
 * submenu is exactly those items. No zoom items: text size is the account's setting
 * (Display settings), which main re-applies with every snapshot, so a page zoom would
 * only snap back.
 */
export function matrixAppMenuTemplate(copy: MatrixAppMenuCopy, actions: MatrixAppMenuActions): MenuItemConstructorOptions[] {
  const updates: MenuItemConstructorOptions[] = actions.updates
    ? [{ label: copy.checkForUpdates, click: () => actions.checkForUpdates() }]
    : []

  const developer: MenuItemConstructorOptions[] = actions.packaged
    ? []
    : [
        { role: 'reload', label: copy.reload },
        { role: 'forceReload', label: copy.forceReload },
        { role: 'toggleDevTools', label: copy.toggleDevTools },
        { type: 'separator' }
      ]

  return [
    {
      // macOS titles this menu with the bundle's name (CFBundleName, "Atum") whatever the label.
      label: copy.app,
      role: 'appMenu',
      submenu: [
        { role: 'about', label: copy.about },
        ...updates,
        { type: 'separator' },
        { role: 'services', label: copy.services },
        { type: 'separator' },
        { role: 'hide', label: copy.hide },
        { role: 'hideOthers', label: copy.hideOthers },
        { role: 'unhide', label: copy.unhide },
        { type: 'separator' },
        { role: 'quit', label: copy.quit }
      ]
    },
    { label: copy.file, role: 'fileMenu', submenu: [{ role: 'close', label: copy.close }] },
    {
      label: copy.edit,
      role: 'editMenu',
      submenu: [
        { role: 'undo', label: copy.undo },
        { role: 'redo', label: copy.redo },
        { type: 'separator' },
        { role: 'cut', label: copy.cut },
        { role: 'copy', label: copy.copy },
        { role: 'paste', label: copy.paste },
        { role: 'pasteAndMatchStyle', label: copy.pasteAndMatchStyle },
        { role: 'delete', label: copy.delete },
        { role: 'selectAll', label: copy.selectAll },
        { type: 'separator' },
        {
          label: copy.substitutions,
          submenu: [
            { role: 'showSubstitutions', label: copy.showSubstitutions },
            { type: 'separator' },
            { role: 'toggleSmartQuotes', label: copy.smartQuotes },
            { role: 'toggleSmartDashes', label: copy.smartDashes },
            { role: 'toggleTextReplacement', label: copy.textReplacement }
          ]
        },
        {
          label: copy.speech,
          submenu: [
            { role: 'startSpeaking', label: copy.startSpeaking },
            { role: 'stopSpeaking', label: copy.stopSpeaking }
          ]
        }
      ]
    },
    {
      label: copy.view,
      submenu: [...developer, { role: 'togglefullscreen', label: copy.toggleFullScreen }]
    },
    {
      label: copy.window,
      role: 'windowMenu',
      submenu: [
        { role: 'minimize', label: copy.minimize },
        { role: 'zoom', label: copy.zoom },
        { type: 'separator' },
        { role: 'front', label: copy.front }
      ]
    },
    { label: copy.help, role: 'help', submenu: [{ label: copy.website, click: () => actions.website() }] }
  ]
}

/**
 * Sets the menu once the app is ready, then again only when its language changes:
 * replacing the menu closes one that is open, and the snapshot changes constantly.
 * Elsewhere than macOS Electron's own menu has no app menu to rename (and Atum ships
 * only for macOS).
 */
export function createMatrixAppMenu(
  deps: {
    menu: Pick<typeof Menu, 'buildFromTemplate' | 'setApplicationMenu'>
    platform: NodeJS.Platform
    ready: () => boolean
    systemLanguages: () => readonly string[]
    log: (message: string) => void
    /** Check for Updates…, in the language the menu speaks. */
    checkForUpdates: (locale: DesktopLocale) => void
  } & Omit<MatrixAppMenuActions, 'checkForUpdates'>
) {
  let shown: DesktopLocale | undefined

  return {
    apply(snapshot: MenuSnapshot): void {
      if (deps.platform !== 'darwin' || !deps.ready()) {
        return
      }

      try {
        const locale = matrixAppMenuLocale(snapshot, deps.systemLanguages())

        if (locale === shown) {
          return
        }

        shown = locale
        deps.menu.setApplicationMenu(
          deps.menu.buildFromTemplate(
            matrixAppMenuTemplate(matrixAppMenuCopy(locale), {
              packaged: deps.packaged,
              updates: deps.updates,
              checkForUpdates: () => deps.checkForUpdates(locale),
              website: deps.website
            })
          )
        )
      } catch {
        // The menu is presentation; a failure here never stops a snapshot.
        deps.log('[Matrix] app menu not set')
      }
    }
  }
}

/** The only switches a shipped Atum takes: its own profile and configuration (main.ts `option`), and
 * Chromium's language. `psn-…` is the process serial number older macOS passes when Finder opens an
 * app. */
const MATRIX_SHIPPED_SWITCHES = new Set(['matrix-profile', 'matrix-config', 'lang'])

/** Switches that let another program drive Atum, or run instead of Atum's own child processes,
 * looked up in Chromium's own parse too (`hasSwitch`). Only ones Electron never adds by itself:
 * the parse also holds what Electron appended at startup, and a shipped build must still start. */
const MATRIX_TAKEOVER_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'inspect',
  'inspect-brk',
  'inspect-port',
  'browser-subprocess-path',
  'renderer-cmd-prefix',
  'utility-cmd-prefix',
  'gpu-launcher'
]

/**
 * The switches a shipped build refuses to start with (main.ts, before anything of the person's
 * opens): every switch but its own few (`MATRIX_SHIPPED_SWITCHES`). Chromium and Node honour many
 * that hand Atum to another program: remote debugging (a port or a pipe) and Node's inspector let
 * it read and drive Atum's windows, and with them the key form; `--browser-subprocess-path`,
 * `--renderer-cmd-prefix`, `--utility-cmd-prefix` and `--gpu-launcher` run another program in
 * place of Atum's own renderer and helpers, which the person's SDK and its key pass through; others
 * log the network with its credentials or weaken the sandbox. A list of those would always miss
 * one, so only Atum's own are let through. Chromium takes `-` or `--` and Node takes `_` for `-`,
 * so both are matched; `hasSwitch` is Chromium's own parse of the command line, for the ones that
 * matter most. The inspector is also off by fuse in a release that carries Atum Keys
 * (scripts/matrix-after-sign.mjs); the others have no fuse. Returns the switch names found, never
 * their values (a name that is not one is `unnamed`).
 */
export function matrixRemoteControlSwitches(
  argv: readonly string[],
  hasSwitch: (name: string) => boolean = () => false
): string[] {
  const found = new Set<string>()

  for (const arg of argv) {
    const name = /^--?([^=]+)/
      .exec(typeof arg === 'string' ? arg : '')?.[1]
      ?.toLowerCase()
      .replace(/_/g, '-')

    if (name === undefined || MATRIX_SHIPPED_SWITCHES.has(name) || /^psn-[0-9-]+$/.test(name)) {
      continue
    }

    found.add(/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ? name : 'unnamed')
  }

  for (const name of MATRIX_TAKEOVER_SWITCHES) {
    if (hasSwitch(name)) {
      found.add(name)
    }
  }

  return [...found]
}

/** Developer tools never open in a shipped build, whichever window or view asks. */
export function closeMatrixDevToolsInShippedBuild(
  packaged: boolean,
  contents: { on(event: 'devtools-opened', listener: () => void): unknown; closeDevTools(): void }
) {
  if (packaged) {
    contents.on('devtools-opened', () => contents.closeDevTools())
  }
}

export type MatrixUpdateCheckState = AtumUpdateState

/**
 * What "Check for Updates…" says once the check settles, or null while it is still
 * checking. `restart` offers to restart now (only when an update is downloaded).
 */
export function matrixUpdateCheckMessage(input: {
  locale: DesktopLocale
  state: MatrixUpdateCheckState
  current: string
  next: string | null
  /** Work in progress: main refuses a restart until it finishes. */
  busy?: boolean
}): { message: string; buttons: string[]; restart: boolean } | null {
  const copy = matrixUpdateCheckCopy(input.locale)

  switch (input.state) {
    case 'checking':
    case 'restarting':
      return null

    case 'idle':
      return { message: copy.noNewerRelease(input.current), buttons: [copy.ok], restart: false }

    case 'downloading':
      return { message: copy.downloading(input.next ?? input.current), buttons: [copy.ok], restart: false }

    case 'downloaded':
      return input.busy
        ? { message: `${copy.ready(input.next ?? input.current)} ${copy.busy}`, buttons: [copy.ok], restart: false }
        : { message: copy.ready(input.next ?? input.current), buttons: [copy.restart, copy.later], restart: true }

    case 'error':
      return { message: copy.failed, buttons: [copy.ok], restart: false }

    default:
      return { message: copy.unavailable, buttons: [copy.ok], restart: false }
  }
}
