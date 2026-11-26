import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { MATRIX_WORK_IPC, parseMatrixWorkRequest } from '../../../shared/matrix-work'

import type { WorkSurface } from './surface'

/** The Matrix window's Work requests. `requireUi` is main's own check that the sender is the Matrix UI frame. */
export function registerMatrixWorkIpc(
  ipc: Pick<IpcMain, 'handle'>,
  surface: Pick<
    WorkSurface,
    | 'getSurfaceMode'
    | 'getSidebar'
    | 'getAttention'
    | 'runCommand'
    | 'setSurfaceMode'
    | 'readAgentPlans'
    | 'selectRelay'
    | 'hide'
    | 'openPlanConnect'
    | 'read'
    | 'readConnections'
    | 'readPlanConsent'
    | 'retry'
    | 'revokePlanConsent'
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
      case 'getSurfaceMode': return surface.getSurfaceMode()

      case 'getSidebar': return surface.getSidebar()

      case 'getAttention': return surface.getAttention()

      case 'runCommand': return surface.runCommand(request.command)

      case 'setSurfaceMode': return surface.setSurfaceMode(request.projectId, request.mode)

      case 'readAgentPlans': return surface.readAgentPlans(request.principal)

      case 'selectRelay': return surface.selectRelay(request.principal, request.model, request.plan)


      case 'read':
        return surface.read()

      case 'show':
        return surface.show(request.rect)

      case 'hide':
        return surface.hide()

      case 'retry':
        return surface.retry()

      case 'setWork':
        return surface.setWork(request.on)

      case 'openPlanConnect':
        return surface.openPlanConnect(request.plan)

      case 'readConnections':
        return surface.readConnections()

      case 'readPlanConsent':
        return request.plan ? surface.readPlanConsent(request.plan) : surface.readPlanConsent()

      case 'setPlanConsent':
        return request.plan ? surface.setPlanConsent(request.consent, request.plan) : surface.setPlanConsent(request.consent)

      case 'revokePlanConsent':
        return request.plan ? surface.revokePlanConsent(request.plan) : surface.revokePlanConsent()
    }
  })
}
