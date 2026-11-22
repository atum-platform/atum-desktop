import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { MATRIX_WORK_IPC, parseMatrixWorkRequest } from '../../../shared/matrix-work'

import type { WorkSurface } from './surface'

/** The Matrix window's Work requests. `requireUi` is main's own check that the sender is the Matrix UI frame. */
export function registerMatrixWorkIpc(
  ipc: Pick<IpcMain, 'handle'>,
  surface: Pick<
    WorkSurface,
    | 'allowAssistants'
    | 'readRelay'
    | 'selectRelay'
    | 'stopRelay'
    | 'hide'
    | 'openPlanConnect'
    | 'read'
    | 'readPlanConsent'
    | 'reconnectAssistants'
    | 'retry'
    | 'revokePlanConsent'
    | 'setAssistants'
    | 'setPlan'
    | 'setPlanConsent'
    | 'setWork'
    | 'show'
  >,
  requireUi: (event: IpcMainInvokeEvent) => void
): void {
  ipc.handle(MATRIX_WORK_IPC.request, async (event, value: unknown) => {
    requireUi(event)
    const request = parseMatrixWorkRequest(value)

    if (!request) {
      throw new Error('matrix_work_request_invalid')
    }

    switch (request.kind) {
      case 'readRelay': return surface.readRelay(request.principal, request.roomId)

      case 'selectRelay': return surface.selectRelay(request.principal, request.expectedRevision, request.model)

      case 'stopRelay': return surface.stopRelay(request.roomId, request.eventId)

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

      case 'setPlan':
        return surface.setPlan(request.on)

      case 'setWork':
        return surface.setWork(request.on)

      case 'reconnectAssistants':
        return surface.reconnectAssistants()

      case 'openPlanConnect':
        return surface.openPlanConnect()

      case 'readPlanConsent':
        return surface.readPlanConsent()

      case 'setPlanConsent':
        return surface.setPlanConsent(request.consent)

      case 'revokePlanConsent':
        return surface.revokePlanConsent()
    }
  })
}
