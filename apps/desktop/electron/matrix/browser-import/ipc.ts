import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { MATRIX_BROWSER_IMPORT as channels } from '../../../shared/matrix-browser-import'

import type { BrowserImportService } from './service'

/**
 * The two fixed calls of the import bridge. Neither reads its arguments: the renderer cannot name a browser, a
 * profile, a site or an agent, so a compromised page can start an import (which still needs the person's Touch ID)
 * and nothing else. `requireCaller` is the UI-frame fence every native capability here sits behind.
 */
export function registerBrowserImportIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  service: BrowserImportService,
  requireCaller: (event: IpcMainInvokeEvent) => void
): () => void {
  ipc.handle(channels.status, event => {
    requireCaller(event)

    return service.status()
  })

  ipc.handle(channels.run, event => {
    requireCaller(event)

    return service.run()
  })

  return () => {
    ipc.removeHandler(channels.status)
    ipc.removeHandler(channels.run)
  }
}
