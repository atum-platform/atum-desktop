import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { UTILITY_IPC } from '../../shared/atum-utilities'

import type { AtumUtilities } from './index'

export function registerUtilitiesIpc(ipc: Pick<IpcMain, 'handle'>, utilities: AtumUtilities, assertSender: (event: IpcMainInvokeEvent) => void): void {
  ipc.handle(UTILITY_IPC.status, event => {
    assertSender(event)

    return utilities.status()
  })
  ipc.handle(UTILITY_IPC.connect, (event, input) => {
    assertSender(event)

    return utilities.connect(input)
  })
  ipc.handle(UTILITY_IPC.disconnect, (event, kind) => {
    assertSender(event)

    return utilities.disconnect(kind)
  })
  ipc.handle(UTILITY_IPC.cancel, event => {
    assertSender(event)
    utilities.cancel()
  })
  ipc.handle(UTILITY_IPC.setEnabled, (event, preferences) => {
    assertSender(event)

    return utilities.setEnabled(preferences)
  })
}
