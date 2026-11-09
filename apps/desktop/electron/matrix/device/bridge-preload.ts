import { contextBridge, ipcRenderer } from 'electron'

import { MATRIX_DEVICE_IPC, type MatrixDeviceBridge } from './bridge'

/**
 * Expose `window.atumDevice` to the Matrix UI (Settings › Device). Nothing here decides anything: main
 * checks the caller and parses every request (`bootstrap.ts`). Called from `ui-preload.ts` (A-2 adds
 * the one call).
 */
export function exposeMatrixDeviceBridge(): void {
  const bridge: MatrixDeviceBridge = {
    status: () => ipcRenderer.invoke(MATRIX_DEVICE_IPC, { action: 'status' }),
    addGrant: (capability, agentUserId) =>
      ipcRenderer.invoke(MATRIX_DEVICE_IPC, { action: 'addGrant', capability: String(capability), agentUserId: String(agentUserId) }),
    revokeGrant: id => ipcRenderer.invoke(MATRIX_DEVICE_IPC, { action: 'revokeGrant', id: String(id) }),
    stop: () => ipcRenderer.invoke(MATRIX_DEVICE_IPC, { action: 'stop' })
  }

  contextBridge.exposeInMainWorld('atumDevice', bridge)
}
