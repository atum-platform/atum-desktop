import { contextBridge, ipcRenderer } from 'electron'

import {
  MATRIX_PET_OVERLAY_IPC as IPC,
  type MatrixPetOverlayBridge,
  type MatrixPetOverlaySnapshot
} from '../../shared/matrix-pet-overlay'

// Receive before the page mounts; its first listener gets the latest snapshot.
let latest: MatrixPetOverlaySnapshot | undefined
const listeners = new Set<Parameters<MatrixPetOverlayBridge['onSnapshot']>[0]>()
ipcRenderer.on(IPC.snapshot, (_event, snapshot) => {
  latest = snapshot

  for (const callback of listeners) {
    callback(snapshot)
  }
})

/** This preload deliberately exposes no desktop services, SDK or generic RPC. */
const bridge: MatrixPetOverlayBridge = {
  onSnapshot(callback) {
    listeners.add(callback)

    if (latest) {
      callback(latest)
    }

    return () => {
      listeners.delete(callback)
    }
  },
  drag: phase => ipcRenderer.invoke(IPC.drag, phase),
  click: () => ipcRenderer.invoke(IPC.click),
  menu: action => ipcRenderer.invoke(IPC.menu, action),
  popIn: () => ipcRenderer.invoke(IPC.popIn),
  setInteractive: value => ipcRenderer.invoke(IPC.setInteractive, value),
  submit: text => ipcRenderer.invoke(IPC.submit, text)
}

contextBridge.exposeInMainWorld('atumMatrixPetOverlay', bridge)
