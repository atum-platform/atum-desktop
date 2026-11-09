import { contextBridge, ipcRenderer } from 'electron'

import { MATRIX_BROWSER_IMPORT as channels, type MatrixBrowserImportBridge } from '../../shared/matrix-browser-import'

/** UI preload only: no SDK host or partner app receives this machine capability. Both calls take nothing. */
export function exposeMatrixBrowserImport(): void {
  const bridge: MatrixBrowserImportBridge = {
    status: () => ipcRenderer.invoke(channels.status),
    run: () => ipcRenderer.invoke(channels.run)
  }

  contextBridge.exposeInMainWorld('atumBrowserImport', bridge)
}
