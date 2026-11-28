import { contextBridge, ipcRenderer } from 'electron'
import { WORK_LEARNING_CHANNEL } from '../../../shared/work-question'

import { WORK_DELIVERABLE_OPEN_CHANNEL, WORK_DELIVERABLE_STATUS_CHANNEL } from './deliverable-contract'

contextBridge.exposeInMainWorld('atumWork', {
  getConnectAssertion: () => ipcRenderer.invoke('atum:work:connect-assertion'),
  reportStartupPhase: (phase: unknown) => ipcRenderer.invoke('atum:work:startup-phase', phase),
  reportSurfaceMode: (snapshot: unknown) => ipcRenderer.invoke('matrix:work:surface-mode-changed', snapshot),
  reportSidebar: (snapshot: unknown) => ipcRenderer.invoke('matrix:work:sidebar-changed', snapshot),
  reportAttention: (snapshot: unknown) => ipcRenderer.invoke('matrix:work:attention-changed', snapshot),
  readModelAccess: () => ipcRenderer.invoke('atum:work:read-model-access'),
  openProtons: () => ipcRenderer.invoke('atum:work:open-protons'),
  submitLearning: (input: unknown) => ipcRenderer.invoke(WORK_LEARNING_CHANNEL, input),
  getDeliverable: (identity: unknown) => ipcRenderer.invoke(WORK_DELIVERABLE_STATUS_CHANNEL, identity),
  openDeliverable: (identity: unknown) => ipcRenderer.invoke(WORK_DELIVERABLE_OPEN_CHANNEL, identity)
})
