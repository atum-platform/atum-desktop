import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('atumWork', {
  reportSurfaceMode: (snapshot: unknown) => ipcRenderer.invoke('matrix:work:surface-mode-changed', snapshot),
  readModelAccess: () => ipcRenderer.invoke('atum:work:read-model-access'),
  openProtons: () => ipcRenderer.invoke('atum:work:open-protons')
})
