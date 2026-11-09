import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { MATRIX_CLIPBOARD_IPC, MATRIX_CLIPBOARD_MAX_CHARS } from '../../shared/matrix-clipboard'

export interface MatrixClipboardDependencies {
  assertTrusted(event: IpcMainInvokeEvent): void
  writeText(text: string): Promise<void>
}

/** The one clipboard seam of the Matrix UI window: plain text in, text on the clipboard. */
export function registerMatrixClipboard(ipc: Pick<IpcMain, 'handle'>, deps: MatrixClipboardDependencies): void {
  ipc.handle(MATRIX_CLIPBOARD_IPC.write, async (event, text: unknown, ...args: unknown[]) => {
    deps.assertTrusted(event)

    if (args.length !== 0 || typeof text !== 'string' || !text || text.length > MATRIX_CLIPBOARD_MAX_CHARS) {
      throw new Error('matrix_clipboard_invalid_request')
    }

    await deps.writeText(text)
  })
}
