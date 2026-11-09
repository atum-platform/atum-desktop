import { contextBridge, ipcRenderer } from 'electron'

import { MATRIX_LOGIN_STARTUP as channels, type MatrixLoginStartupBridge } from '../../shared/matrix-login-startup'

/** UI preload only: no SDK host or partner app receives this machine capability. */
export function exposeMatrixLoginStartup(): void {
  const bridge: MatrixLoginStartupBridge = {
    status: () => ipcRenderer.invoke(channels.status),
    setEnabled: enabled => ipcRenderer.invoke(channels.enabled, enabled),
    openSettings: () => ipcRenderer.invoke(channels.openSettings),
    acknowledge: () => ipcRenderer.invoke(channels.acknowledge)
  }

  contextBridge.exposeInMainWorld('atumLoginStartup', bridge)
}
