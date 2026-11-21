import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { MATRIX_WORK_IPC, parseMatrixWorkRequest } from '../../../shared/matrix-work'

import type { WorkSurface } from './surface'

/** The Matrix window's Work requests. `requireUi` is main's own check that the sender is the Matrix UI frame. */
export function registerMatrixWorkIpc(
  ipc: Pick<IpcMain, 'handle'>,
  surface: Pick<WorkSurface, 'allowAssistants' | 'hide' | 'read' | 'reconnectAssistants' | 'retry' | 'setAssistants' | 'show'>,
  requireUi: (event: IpcMainInvokeEvent) => void
): void {
  ipc.handle(MATRIX_WORK_IPC.request, async (event, value: unknown) => {
    requireUi(event)
    const request = parseMatrixWorkRequest(value)

    if (!request) {
      throw new Error('matrix_work_request_invalid')
    }

    switch (request.kind) {
      case 'read':
        return surface.read()

      case 'show':
        return surface.show(request.rect)

      case 'hide':
        return surface.hide()

      case 'retry':
        return surface.retry()

      case 'allowAssistants':
        return surface.allowAssistants()

      case 'setAssistants':
        return surface.setAssistants(request.on)

      case 'reconnectAssistants':
        return surface.reconnectAssistants()
    }
  })
}
