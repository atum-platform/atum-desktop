import { contextBridge, ipcRenderer } from 'electron'

import {
  MATRIX_DESKTOP_SERVICES as channels,
  type MatrixDesktopServicesBridge
} from '../../shared/matrix-desktop-services'

/** No generic event emitter or identity setter is exposed to a renderer. */
export function exposeMatrixDesktopServices(full: boolean) {
  const error: MatrixDesktopServicesBridge['error'] = value =>
    ipcRenderer.send(channels.error, {
      kind: value?.kind,
      stack: typeof value?.stack === 'string' ? value.stack.slice(0, 16_384) : undefined
    })

  if (!full) {
    contextBridge.exposeInMainWorld('atumDiagnostics', { error })

    return
  }

  const bridge: MatrixDesktopServicesBridge = {
    status: () => ipcRenderer.invoke(channels.status),
    setEnabled: enabled => ipcRenderer.invoke(channels.enabled, enabled),
    feedback: message => ipcRenderer.invoke(channels.feedback, message),
    active: () => ipcRenderer.send(channels.active),
    ready: () => ipcRenderer.send(channels.ready),
    error,
    setUpdateChannel: channel => ipcRenderer.invoke(channels.channel, channel),
    checkUpdates: () => ipcRenderer.invoke(channels.check),
    restart: () => ipcRenderer.invoke(channels.restart),
    onChanged: callback => {
      const receive: Parameters<typeof ipcRenderer.on>[1] = (_event, value) => callback(value)

      ipcRenderer.on(channels.changed, receive)

      return () => {
        ipcRenderer.removeListener(channels.changed, receive)
      }
    }
  }

  contextBridge.exposeInMainWorld('atumDesktopServices', bridge)
}
