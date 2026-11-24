import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('atumWork', {
  reportStartupPhase: (phase: unknown) => ipcRenderer.invoke('atum:work:startup-phase', phase),
  reportSurfaceMode: (snapshot: unknown) => ipcRenderer.invoke('matrix:work:surface-mode-changed', snapshot),
  reportSidebar: (snapshot: unknown) => ipcRenderer.invoke('matrix:work:sidebar-changed', snapshot),
  reportAttention: (snapshot: unknown) => ipcRenderer.invoke('matrix:work:attention-changed', snapshot),
  readModelAccess: () => ipcRenderer.invoke('atum:work:read-model-access'),
  openProtons: () => ipcRenderer.invoke('atum:work:open-protons')
})
