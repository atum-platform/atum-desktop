import { contextBridge, ipcRenderer } from 'electron'

import { MATRIX_KEEP_AWAKE as channels, type MatrixKeepAwakeBridge } from '../../shared/matrix-keep-awake'

/** UI preload only: no SDK host or partner app receives this machine power preference. */
export function exposeMatrixKeepAwake(): void {
  const bridge: MatrixKeepAwakeBridge = {
    status: () => ipcRenderer.invoke(channels.status),
    setEnabled: enabled => ipcRenderer.invoke(channels.enabled, enabled)
  }

  contextBridge.exposeInMainWorld('atumKeepAwake', bridge)
}
