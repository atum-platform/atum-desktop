import type { BrowserWindowConstructorOptions, WebPreferences } from 'electron'

import {
  isMatrixWindowAppearance,
  MATRIX_WINDOW_CHANNELS,
  type MatrixWindowAppearance,
  type MatrixWindowButtonPosition,
  type MatrixWindowFacts
} from '../../shared/matrix-window'
import {
  ATUM_PRODUCT_MIN_HEIGHT,
  ATUM_PRODUCT_MIN_WIDTH,
  ATUM_SHELL_WINDOW_BUTTON_POSITION,
  type AtumModeWindow,
  type Bounds,
  createAtumWindowModeController,
  type WorkArea
} from '../atum-window-mode'

export {
  MATRIX_WINDOW_CHANNELS,
  type MatrixWindowButtonPosition,
  type MatrixWindowFacts,
  type MatrixWindowMode
} from '../../shared/matrix-window'

/** Current Atum product geometry, shared by the Matrix shell rather than its proof UI. */
export const MATRIX_WINDOW_DEFAULT_WIDTH = 1220
export const MATRIX_WINDOW_DEFAULT_HEIGHT = 800
export const MATRIX_WINDOW_DEFAULT_MIN_WIDTH = ATUM_PRODUCT_MIN_WIDTH
export const MATRIX_WINDOW_DEFAULT_MIN_HEIGHT = ATUM_PRODUCT_MIN_HEIGHT

/** The product's native material; renderer panels decide where it shows through. */
export const MATRIX_WINDOW_VIBRANCY = 'sidebar'
export const MATRIX_WINDOW_TRANSPARENT_BACKGROUND = '#00000000'
export const MATRIX_WINDOW_GROUND_LIGHT = '#F4F5F7'

/**
 * Electron's BrowserWindowConstructorOptions without importing Electron in
 * unit tests. Callers supply the runtime-dependent overlay/theme/preload
 * values, while this helper fixes the product's chrome/material contract.
 */
export interface MatrixWindowProductOptions {
  backgroundColor?: string
  icon?: string
  opacity?: number
  platform?: string
  title: string
  titleBarOverlay?: BrowserWindowConstructorOptions['titleBarOverlay']
  webPreferences: WebPreferences
  height?: number
  minHeight?: number
  minWidth?: number
  width?: number
}

export type MatrixWindowConstructorOptions = BrowserWindowConstructorOptions

/**
 * Build the Matrix product window's native chrome. This retains the production
 * Atum shell's hidden titlebar, macOS sidebar material and traffic-light
 * alignment, without importing the legacy Electron composition root.
 */
export function matrixWindowOptions(input: MatrixWindowProductOptions): BrowserWindowConstructorOptions {
  const platform = input.platform ?? process.platform
  const isMac = platform === 'darwin'

  return {
    show: false,
    width: input.width ?? MATRIX_WINDOW_DEFAULT_WIDTH,
    height: input.height ?? MATRIX_WINDOW_DEFAULT_HEIGHT,
    minWidth: input.minWidth ?? MATRIX_WINDOW_DEFAULT_MIN_WIDTH,
    minHeight: input.minHeight ?? MATRIX_WINDOW_DEFAULT_MIN_HEIGHT,
    title: input.title,
    titleBarStyle: 'hidden',
    titleBarOverlay: input.titleBarOverlay,
    trafficLightPosition: isMac ? ATUM_SHELL_WINDOW_BUTTON_POSITION : undefined,
    transparent: false,
    vibrancy: isMac ? MATRIX_WINDOW_VIBRANCY : undefined,
    opacity: input.opacity ?? 1,
    icon: input.icon,
    backgroundColor: isMac
      ? MATRIX_WINDOW_TRANSPARENT_BACKGROUND
      : (input.backgroundColor ?? MATRIX_WINDOW_GROUND_LIGHT),
    webPreferences: input.webPreferences
  }
}

/** The BrowserWindow subset used by this module; real Electron satisfies it. */
export interface MatrixWindow extends AtumModeWindow {
  getWindowButtonPosition?: () => MatrixWindowButtonPosition
  on?: (event: string, listener: () => void) => unknown
  removeListener?: (event: string, listener: () => void) => unknown
}

interface IpcMainLike {
  handle: (channel: string, listener: (event: { sender: unknown }, ...args: unknown[]) => unknown) => void
  removeHandler?: (channel: string) => void
}

export interface InstallMatrixWindowOptions {
  /** Main's current Matrix UI window, never a renderer-provided handle. */
  getWindow: () => MatrixWindow | null | undefined
  /** Exact current UI WebContents identity; no route/payload can substitute for it. */
  isUiSender: (sender: unknown) => boolean
  /** Work area of the display containing the current product bounds. */
  getWorkArea: (bounds: Bounds) => WorkArea | null
  ipc: IpcMainLike
  /** Product fallback reservation for native right-side controls. */
  overlayWidth: () => number
  /** Called when fullscreen facts change; normally sends factsChanged to the UI preload. */
  publishFacts?: (facts: MatrixWindowFacts) => void
  /** Best-effort cleanup before the compact auth frame captures product geometry. */
  beforeAuth?: () => void
  /**
   * Pins the app's native appearance (Electron's `nativeTheme.themeSource`) to the
   * shell's choice. The vibrancy material follows it, so a dark palette never sits
   * over the light material of a light-mode Mac, or the reverse.
   */
  setNativeAppearance?: (appearance: MatrixWindowAppearance) => void
  /** The UI asked for its window size (main shows the window after the first request). */
  onModeChosen?: () => void
  log?: (message: string) => void
  platform?: string
}

export interface InstalledMatrixWindow {
  dispose: () => void
  facts: () => MatrixWindowFacts
  isAuthMode: () => boolean
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function buttonPosition(window: MatrixWindow | null | undefined, platform: string): MatrixWindowButtonPosition | null {
  if (platform !== 'darwin') {
    return null
  }

  const candidate = window?.getWindowButtonPosition?.() ?? ATUM_SHELL_WINDOW_BUTTON_POSITION

  return finite(candidate?.x) && finite(candidate?.y) ? { x: candidate.x, y: candidate.y } : null
}

/**
 * Install the explicit Matrix window endpoints (facts, mode, appearance) and keep fullscreen facts
 * current. Chrome failures are contained by AtumWindowModeController, so a
 * failed resize cannot block browser SSO or normal-mode recovery.
 */
export function installMatrixWindow(options: InstallMatrixWindowOptions): InstalledMatrixWindow {
  const platform = options.platform ?? process.platform

  const facts = (): MatrixWindowFacts => {
    const window = options.getWindow()
    const overlayWidth = options.overlayWidth()

    return {
      platform,
      isFullscreen: Boolean(window && !window.isDestroyed() && window.isFullScreen()),
      windowButtonPosition: buttonPosition(window, platform),
      overlayWidth: finite(overlayWidth) && overlayWidth >= 0 ? overlayWidth : 0
    }
  }

  const controller = createAtumWindowModeController({
    getWindow: options.getWindow,
    getWorkArea: options.getWorkArea,
    isOwnerSender: options.isUiSender,
    log: options.log,
    beforeAuth: options.beforeAuth
  })

  const publishFacts = () => options.publishFacts?.(facts())
  const onFullscreenChanged = () => publishFacts()
  const current = options.getWindow()

  options.ipc.handle(MATRIX_WINDOW_CHANNELS.facts, event => {
    if (!options.isUiSender(event.sender)) {
      throw new Error('matrix_window_not_authorized')
    }

    return facts()
  })
  options.ipc.handle(MATRIX_WINDOW_CHANNELS.setMode, (event, mode: unknown) => {
    const result = controller.handleSetMode(event, mode)

    if (result.ok) {
      publishFacts()
    } else {
      // A window left at the wrong size must be explainable from the log.
      options.log?.(`[window-mode] ${typeof mode === 'string' ? mode : 'invalid'} request refused: ${result.error}`)
    }

    // The UI has drawn its first screen and chosen for it; a size that could not be applied
    // still leaves a usable window, so it is shown either way.
    if (result.ok || result.error === 'transition-failed') {
      options.onModeChosen?.()
    }

    return result
  })

  options.ipc.handle(MATRIX_WINDOW_CHANNELS.setAppearance, (event, appearance: unknown) => {
    if (!options.isUiSender(event.sender)) {
      throw new Error('matrix_window_not_authorized')
    }

    if (!isMatrixWindowAppearance(appearance)) {
      throw new Error('matrix_window_appearance_invalid')
    }

    options.setNativeAppearance?.(appearance)
  })

  current?.on?.('enter-full-screen', onFullscreenChanged)
  current?.on?.('leave-full-screen', onFullscreenChanged)
  publishFacts()

  return {
    facts,
    isAuthMode: controller.isAuthMode,
    dispose: () => {
      current?.removeListener?.('enter-full-screen', onFullscreenChanged)
      current?.removeListener?.('leave-full-screen', onFullscreenChanged)
      options.ipc.removeHandler?.(MATRIX_WINDOW_CHANNELS.facts)
      options.ipc.removeHandler?.(MATRIX_WINDOW_CHANNELS.setMode)
      options.ipc.removeHandler?.(MATRIX_WINDOW_CHANNELS.setAppearance)
      controller.reset()
    }
  }
}
