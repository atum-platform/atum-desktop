/**
 * UI-safe native-window projection for the Matrix shell.
 *
 * These are presentation facts only. They intentionally carry neither a
 * BrowserWindow handle nor a generic native command surface.
 */
export interface MatrixWindowButtonPosition {
  x: number
  y: number
}

export interface MatrixWindowFacts {
  platform: string
  isFullscreen: boolean
  windowButtonPosition: MatrixWindowButtonPosition | null
  overlayWidth: number
}

/** The only renderer-directed native chrome transition. */
export type MatrixWindowMode = 'auth' | 'normal'

/**
 * The shell's appearance choice, as the native window sees it. `system` follows
 * macOS; `light` and `dark` pin it, so the vibrancy material under the shell
 * matches the palette the renderer paints over it.
 */
export type MatrixWindowAppearance = 'system' | 'light' | 'dark'
// Same three values as the human-owned `MatrixAppearanceMode` (matrix-display-preferences.ts), kept
// separate on purpose: this one is what main will apply to the native window, whatever the UI sends.

export function isMatrixWindowAppearance(value: unknown): value is MatrixWindowAppearance {
  return value === 'system' || value === 'light' || value === 'dark'
}

/**
 * Deliberate, narrow IPC channels. `setMode` and `setAppearance` are not general
 * window-control RPCs: main admits them only from the current Matrix UI WebContents,
 * `setAppearance` only with one of the three `MatrixWindowAppearance` values.
 */
export const MATRIX_WINDOW_CHANNELS = {
  facts: 'matrix:window:facts',
  factsChanged: 'matrix:window:facts-changed',
  setMode: 'matrix:window:set-mode',
  setAppearance: 'matrix:window:set-appearance',
  prepareDocumentClose: 'matrix:window:prepare-document-close',
  documentCloseReady: 'matrix:window:document-close-ready'
} as const
