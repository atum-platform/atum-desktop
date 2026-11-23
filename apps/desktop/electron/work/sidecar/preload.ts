import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('atumWork', {
  readModelAccess: () => ipcRenderer.invoke('atum:work:read-model-access'),
  openProtons: () => ipcRenderer.invoke('atum:work:open-protons')
})
