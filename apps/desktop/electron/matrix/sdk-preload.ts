import { contextBridge, ipcRenderer } from 'electron'

import { exposeMatrixDesktopServices } from './desktop-services-preload'

exposeMatrixDesktopServices(false)

import {
  MATRIX_CHANNELS as channel,
  type MatrixInvocationHint,
  type MatrixNotificationHint,
  type MatrixSnapshot
} from '../../shared/matrix'
import type { MatrixGoogleFenceObservation } from '../../shared/matrix-google-fence'
import type { MatrixUndecryptableObservation } from '../../shared/matrix-undecryptable'
import type { MatrixSdkHostCommand, MatrixSdkHostPort } from '../../src/matrix/sdk-host-port'

// The desktop's side of the SDK seam (src/matrix/sdk-host-port.ts): the port, over IPC to
// the main process, which keeps this window's command queue.
contextBridge.exposeInMainWorld('matrixSdkHost', {
  configuration: () => ipcRenderer.invoke(channel.sdkConfig),
  refresh: (handle: string) => ipcRenderer.invoke(channel.sdkRefresh, handle),
  snapshot: (value: MatrixSnapshot) => ipcRenderer.send(channel.sdkSnapshot, value),
  invocation: (value: MatrixInvocationHint) => ipcRenderer.send(channel.sdkInvocation, value),
  notification: (value: MatrixNotificationHint) => ipcRenderer.send(channel.sdkNotification, value),
  googleFence: (value: MatrixGoogleFenceObservation) => ipcRenderer.send(channel.sdkGoogleFence, value),
  undecryptable: (value: MatrixUndecryptableObservation) => ipcRenderer.send(channel.sdkUndecryptable, value),
  commands: (listener: (id: string, command: MatrixSdkHostCommand) => void) => {
    ipcRenderer.on(channel.sdkCommand, (_event, id: string, command: MatrixSdkHostCommand) => listener(id, command))
  },
  result: (id: string, ok: boolean, value: unknown) => ipcRenderer.send(channel.sdkResult, id, ok, value)
} satisfies MatrixSdkHostPort)
