/** Copy for the primary Matrix UI. The window's session grants no web clipboard permission, so
 * `navigator.clipboard.writeText` is refused there; main writes the text instead. */
export const MATRIX_CLIPBOARD_IPC = {
  write: 'matrix:clipboard:write'
} as const

/** Longer than any message; a bound so a runaway renderer cannot ask for a huge write. */
export const MATRIX_CLIPBOARD_MAX_CHARS = 1_000_000

export interface MatrixClipboardBridge {
  /** Puts plain text on the system clipboard. */
  writeText(text: string): Promise<void>
}
